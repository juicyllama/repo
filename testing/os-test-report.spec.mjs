import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('./os-test-report.mjs', import.meta.url))
function fixture(source) {
	const cwd = mkdtempSync(join(tmpdir(), 'os-test-report-'))
	writeFileSync(join(cwd, 'example.test.mjs'), source)
	return cwd
}
function run(cwd, phase = 'check', args = ['node', '--test', 'example.test.mjs'], overrides = {}) {
	const env = { ...process.env, ...overrides }
	delete env.NODE_TEST_CONTEXT
	delete env.OS_TEST_REPORT_DIR
	return spawnSync(
		process.execPath,
		[cli, 'run', '--phase', phase, '--label', `mise run os:${phase}`, '--', ...args],
		{ cwd, env, encoding: 'utf8' },
	)
}
function report(cwd) {
	const root = join(cwd, '.os/test-results')
	const folder = readdirSync(root).find(name => name !== 'latest.md')
	return JSON.parse(readFileSync(join(root, folder, 'report.json'), 'utf8'))
}

function summary(cwd) {
	const result = spawnSync(process.execPath, [cli, 'summary'], { cwd, encoding: 'utf8' })
	assert.equal(result.status, 0, result.stderr)
	return result.stdout
}

test('a missing executable reports command failure with shell-compatible status 127', () => {
	const cwd = fixture('')
	const result = run(cwd, 'check', ['missing-test-executable-23d13'])
	assert.equal(result.status, 127)
	assert.equal(report(cwd).exitCode, 127)
	assert.equal(report(cwd).outcome, 'command_failed')
	assert.equal(report(cwd).reportComplete, false)
})

test('an unavailable reporting directory does not replace the command exit status', () => {
	const cwd = fixture('')
	const result = run(cwd, 'check', [
		'node',
		'-e',
		"require('node:fs').rmSync(process.env.OS_TEST_REPORT_DIR,{recursive:true,force:true});process.exit(6)",
	])
	assert.equal(result.status, 6)
	assert.match(result.stdout + result.stderr, /Test reporting unavailable/)
})

test('termination reaches the test command and leaves an interrupted report', async () => {
	const cwd = fixture('')
	const env = { ...process.env }
	delete env.NODE_TEST_CONTEXT
	const child = spawn(
		process.execPath,
		[
			cli,
			'run',
			'--phase',
			'check',
			'--label',
			'interrupt',
			'--',
			process.execPath,
			'-e',
			"process.on('SIGTERM',()=>{require('node:fs').writeFileSync('terminated','yes');process.exit(0)}); console.log('ready'); setTimeout(()=>process.exit(0),1000)",
		],
		{ cwd, env },
	)
	await once(child.stdout, 'data')
	child.kill('SIGTERM')
	const [code] = await once(child, 'close')
	assert.equal(code, 143)
	assert.equal(readFileSync(join(cwd, 'terminated'), 'utf8'), 'yes')
	assert.equal(report(cwd).outcome, 'interrupted')
	assert.equal(report(cwd).reportComplete, false)
})

test('a real Node test execution produces counts, a compact summary and its full log', () => {
	const cwd = fixture("import { test } from 'node:test'; test('passes', () => {}); test.skip('later', () => {});\n")
	const result = run(cwd)
	assert.equal(result.status, 0, result.stderr)
	const actual = report(cwd)
	assert.deepEqual(actual.counts, { passed: 1, failed: 0, skipped: 1, todo: 0 })
	assert.equal(actual.phase, 'check')
	assert.equal(actual.exitCode, 0)
	assert.equal(actual.command, 'mise run os:check')
	assert.ok(actual.durationMs >= 0)
	assert.match(summary(cwd), /1 passed/)
	assert.match(readFileSync(join(cwd, actual.logPath), 'utf8'), /passes/)
})

test('a failing RED execution retains its exit code and names the failed test', () => {
	const cwd = fixture(
		"import { test } from 'node:test'; test('rejects an invalid charge', () => { throw new Error('bad charge'); });\n",
	)
	const result = run(cwd, 'red')
	assert.equal(result.status, 1)
	const actual = report(cwd)
	assert.equal(actual.counts.failed, 1)
	assert.equal(actual.outcome, 'tests_failed')
	assert.ok(actual.failures.some(failure => failure.name === 'rejects an invalid charge'))
})

test('expected Node todo failures are not listed as failed tests', () => {
	const cwd = fixture(
		"import {test} from 'node:test'; test('passes',()=>{}); test.todo('future',()=>{throw Error('expected')});",
	)
	assert.equal(run(cwd).status, 0)
	const actual = report(cwd)
	assert.equal(actual.counts.failed, 0)
	assert.equal(actual.counts.todo, 1)
	assert.deepEqual(actual.failures, [])
	assert.doesNotMatch(summary(cwd), /Failed tests:/)
})

test('a native report write failure cannot turn a passing Node test into a command failure', () => {
	const cwd = fixture(
		"import {test} from 'node:test'; import{rmSync}from'node:fs'; test('passes',()=>rmSync(process.env.OS_TEST_REPORT_DIR,{recursive:true,force:true}));",
	)
	const result = run(cwd)
	assert.equal(result.status, 0, result.stderr)
	assert.equal(report(cwd).counts, null)
	assert.equal(report(cwd).reportComplete, false)
})

test('preflight, baseline and environment failures keep their distinct status without fabricated test counts', () => {
	for (const [phase, code, outcome] of [
		['red', 3, 'red_suite_missing'],
		['red', 4, 'red_suite_typecheck'],
		['red', 5, 'red_suite_skips'],
		['check', 6, 'pre_existing_failure'],
		['check', 7, 'environment_failure'],
		['check', 0, 'no_test_results'],
	]) {
		const cwd = fixture('')
		const result = run(cwd, phase, ['node', '-e', `process.exit(${code})`])
		assert.equal(result.status, code)
		assert.equal(report(cwd).outcome, outcome)
		assert.equal(report(cwd).counts, null)
	}
})

test('native Jest JSON is reported accurately without changing its failure exit', () => {
	const cwd = fixture('')
	writeFileSync(
		join(cwd, 'sample.test.cjs'),
		"test('one pass', () => {}); test.skip('one skip', () => {}); test('one fail', () => { throw new Error('expected'); });\n",
	)
	const jest = fileURLToPath(new URL('../node_modules/jest/bin/jest.js', import.meta.url))
	const script = `require('node:child_process').spawnSync(process.execPath, [${JSON.stringify(jest)}, '--runInBand', '--config', JSON.stringify({rootDir:process.cwd(),testMatch:['**/*.test.cjs']}), '--json', '--outputFile='+process.env.OS_TEST_REPORT_DIR+'/jest.json'], {stdio:'inherit'}); process.exit(1);`
	const result = run(cwd, 'check', ['node', '-e', script])
	assert.equal(result.status, 1)
	const actual = report(cwd)
	assert.deepEqual(actual.counts, { passed: 1, failed: 1, skipped: 1, todo: 0 })
	assert.ok(actual.failures.some(failure => failure.name === 'one fail'))
})

test('malformed reports do not replace the tested command status or claim success', () => {
	const cwd = fixture('')
	const result = run(cwd, 'check', [
		'node',
		'-e',
		"require('node:fs').writeFileSync(process.env.OS_TEST_REPORT_DIR+'/broken.json', '{'); process.exit(6)",
	])
	assert.equal(result.status, 6, result.stderr)
	assert.equal(report(cwd).outcome, 'pre_existing_failure')
	assert.equal(report(cwd).reportComplete, false)
	assert.match(report(cwd).warnings.join(' '), /broken.json/)
})

test('valid JSON in an unknown format is named as unrecognized and never counts as a pass', () => {
	const cwd = fixture('')
	const result = run(cwd, 'check', [
		'node',
		'-e',
		"require('node:fs').writeFileSync(process.env.OS_TEST_REPORT_DIR+'/coverage.json', JSON.stringify({coverage:{}}))",
	])
	assert.equal(result.status, 0, result.stderr)
	const actual = report(cwd)
	assert.equal(actual.outcome, 'report_incomplete')
	assert.equal(actual.reportComplete, false)
	assert.equal(actual.counts, null)
	assert.deepEqual(actual.warnings, ['Unrecognized native test report format: coverage.json'])
})

test('native Playwright results count tests without counting retry attempts twice', () => {
	const cwd = fixture('')
	const playwright = fileURLToPath(new URL('../node_modules/@playwright/test/index.js', import.meta.url))
	const runner = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url))
	writeFileSync(
		join(cwd, 'contract.spec.cjs'),
		`const { test } = require(${JSON.stringify(playwright)}); test('passes',()=>{}); test.skip('skips',()=>{}); test('fails',()=>{throw Error('expected')});\n`,
	)
	writeFileSync(
		join(cwd, 'playwright.config.cjs'),
		"module.exports={testMatch:'**/*.spec.cjs',workers:1,retries:1};\n",
	)
	const script = `const r=require('node:child_process').spawnSync(process.execPath,[${JSON.stringify(runner)},'test','--reporter=json'],{stdio:'inherit',env:{...process.env,PLAYWRIGHT_JSON_OUTPUT_FILE:process.env.OS_TEST_REPORT_DIR+'/playwright.json'}});process.exit(r.status);`
	const result = run(cwd, 'check', ['node', '-e', script])
	assert.equal(result.status, 1)
	assert.deepEqual(report(cwd).counts, { passed: 1, failed: 1, skipped: 1, todo: 0 })
	assert.ok(report(cwd).failures.some(failure => failure.name.includes('fails')))
})

test('sequential phases keep separate rows, and rerunning a phase updates its row', () => {
	const cwd = fixture("import {test} from 'node:test'; test('ok',()=>{});\n")
	run(cwd, 'red')
	run(cwd, 'check')
	run(cwd, 'check')
	const text = summary(cwd)
	assert.match(text, /\| red \|/)
	assert.equal(text.split('| check |').length - 1, 1)
})

test('identical command labels retain distinct RED and check evidence', () => {
	const cwd = fixture("import{test}from'node:test';test('passes',()=>{});")
	for (const phase of ['red', 'check']) {
		const env = { ...process.env }
		delete env.NODE_TEST_CONTEXT
		assert.equal(
			spawnSync(
				process.execPath,
				[cli, 'run', '--phase', phase, '--label', 'same command', '--', 'node', '--test', 'example.test.mjs'],
				{ cwd, env },
			).status,
			0,
		)
	}
	const text = summary(cwd)
	assert.match(text, /\| red \|/)
	assert.match(text, /\| check \|/)
})

test('retained report files do not make clean tested source dirty', () => {
	const cwd = fixture("import{test}from'node:test';test('passes',()=>{});")
	for (const args of [
		['init'],
		['add', '.'],
		['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture'],
	]) {
		assert.equal(spawnSync('git', args, { cwd }).status, 0)
	}
	assert.equal(run(cwd).status, 0)
	assert.equal(run(cwd).status, 0)
	const directory = join(cwd, '.os/test-results')
	const latest = readdirSync(directory, { withFileTypes: true })
		.filter(entry => entry.isDirectory())
		.map(entry => entry.name)
		.sort()
		.at(-1)
	assert.equal(JSON.parse(readFileSync(join(directory, latest, 'report.json'), 'utf8')).dirty, false)
})

test('concurrent completed commands retain both rows in the aggregate', async () => {
	const cwd = fixture('')
	const children = ['first', 'second'].map(label =>
		once(
			spawn(
				process.execPath,
				[cli, 'run', '--phase', 'check', '--label', label, '--', process.execPath, '-e', 'process.exit(0)'],
				{ cwd, stdio: 'ignore' },
			),
			'close',
		),
	)
	for (const result of await Promise.all(children)) assert.equal(result[0], 0)
	const actual = summary(cwd)
	assert.match(actual, /\| first \|/)
	assert.match(actual, /\| second \|/)
})

test('child arguments cannot disable the wrapper reporter', () => {
	const cwd = fixture("import{test}from'node:test';test('passes',()=>{});")
	const result = run(cwd, 'check', ['bash', '-c', 'node --test example.test.mjs', '--no-node-reporter'])
	assert.equal(result.status, 0, result.stderr)
	assert.equal(report(cwd).counts?.passed, 1)
})

test('an abandoned aggregate lock cannot block new test evidence', () => {
	const cwd = fixture('')
	mkdirSync(join(cwd, '.os/test-results/.summary-lock'), { recursive: true })
	const result = spawnSync(
		process.execPath,
		[
			cli,
			'run',
			'--phase',
			'check',
			'--label',
			'after interruption',
			'--',
			process.execPath,
			'-e',
			'process.exit(0)',
		],
		{ cwd, encoding: 'utf8', timeout: 4000 },
	)
	assert.equal(result.status, 0, result.stderr)
	assert.match(summary(cwd), /after interruption/)
})

test('native Vitest distinguishes passed, failed, skipped and todo tests', () => {
	const cwd = fixture('')
	const vitest = fileURLToPath(new URL('../node_modules/vitest/dist/index.js', import.meta.url))
	const runner = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
	writeFileSync(
		join(cwd, 'native.test.mjs'),
		`import { test } from ${JSON.stringify(vitest)}; test('passes',()=>{}); test.skip('skips',()=>{}); test.todo('later'); test('fails',()=>{throw Error('expected')});\n`,
	)
	writeFileSync(join(cwd, 'vitest.config.mjs'), "export default {test:{include:['native.test.mjs'],maxWorkers:1}};\n")
	const script = `const r=require('node:child_process').spawnSync(process.execPath,[${JSON.stringify(runner)},'run','--reporter=json','--outputFile='+process.env.OS_TEST_REPORT_DIR+'/vitest.json'],{stdio:'inherit'});process.exit(r.status);`
	const result = run(cwd, 'check', ['node', '-e', script])
	assert.equal(result.status, 1)
	assert.deepEqual(report(cwd).counts, { passed: 1, failed: 1, skipped: 1, todo: 1 })
})

test('reports name the starting commit and flag uncommitted tested source', () => {
	const cwd = fixture("import {test} from 'node:test'; test('ok',()=>{});\n")
	writeFileSync(join(cwd, '.gitignore'), '.os/test-results/\n')
	for (const args of [
		['init', '-q'],
		['add', '.'],
		['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'],
	]) {
		assert.equal(spawnSync('git', args, { cwd }).status, 0)
	}
	const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim()
	writeFileSync(join(cwd, 'example.test.mjs'), "import {test} from 'node:test'; test('changed source',()=>{});\n")
	assert.equal(run(cwd).status, 0)
	assert.equal(report(cwd).commit, head)
	assert.equal(report(cwd).dirty, true)
	assert.match(summary(cwd), /uncommitted changes/)
})

test('collects package reports recursively while keeping baseline comparisons out of branch totals', () => {
	const cwd = fixture('')
	const script = `const fs=require('node:fs');const p=process.env.OS_TEST_REPORT_DIR;for(const [dir,passed] of [['package',2],['baseline',50]]){fs.mkdirSync(p+'/'+dir);fs.writeFileSync(p+'/'+dir+'/tests.json',JSON.stringify({numPassedTests:passed,numFailedTests:0,numPendingTests:0,testResults:[]}));}`
	assert.equal(run(cwd, 'check', ['node', '-e', script]).status, 0)
	assert.equal(report(cwd).counts.passed, 2)
})

test('a terminated command is recorded as interrupted with the conventional signal exit code', () => {
	const cwd = fixture('')
	const result = run(cwd, 'check', ['node', '-e', "process.kill(process.pid, 'SIGTERM')"])
	assert.equal(result.status, 143)
	assert.equal(report(cwd).signal, 'SIGTERM')
	assert.equal(report(cwd).outcome, 'interrupted')
})

test('the portable summary action prints retained results without running tests again', () => {
	const cwd = fixture("import {test} from 'node:test'; test('once',()=>{});\n")
	run(cwd)
	rmSync(join(cwd, '.os/test-results/latest.md'), { force: true })
	const result = spawnSync(process.execPath, [cli, 'summary'], { cwd, encoding: 'utf8' })
	assert.equal(result.status, 0)
	assert.match(result.stdout, /1 passed/)
	assert.equal(readdirSync(join(cwd, '.os/test-results')).filter(name => name.startsWith('1')).length, 1)
})

test('Markdown contains a bounded escaped list of failed tests', () => {
	const cwd = fixture(
		"import {test} from 'node:test'; for(let i=0;i<12;i++)test('bad|<img> @everyone '+i,()=>{throw Error('expected')});\n",
	)
	run(cwd)
	const text = summary(cwd)
	assert.match(text, /bad&#124;&lt;img&gt;/)
	assert.doesNotMatch(text, /<img>|@everyone/)
	assert.match(text, /2 more failures/)
	assert.ok(text.length < 6000)
})

test('an existing Node reporter is preserved rather than broken by adding another reporter', () => {
	const cwd = fixture("import {test} from 'node:test'; test('kept',()=>{});\n")
	const result = run(cwd, 'check', ['node', '--test', 'example.test.mjs'], { NODE_OPTIONS: '--test-reporter=tap' })
	assert.equal(result.status, 0, result.stderr)
	assert.match(result.stdout, /TAP version/)
	assert.equal(report(cwd).counts, null)
})
