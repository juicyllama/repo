import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
	applyPairs,
	buildReport,
	bumpLevel,
	compareVersions,
	fetchPackument,
	findDowngrades,
	lockfileImporters,
	mergeBase,
	notesUrl,
	npmImporters,
	offTarget,
	parseAudit,
	parsePairs,
	pickTargets,
	renderReport,
	slimPackument,
} from './os-deps.mjs'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-04T00:00:00Z')

function daysAgo(days) {
	return new Date(NOW - days * DAY).toISOString()
}

/** A registry document with each version released `ageDays` ago; `{ deprecated: true }` marks one withdrawn. */
function packument(latest, versions, extra = {}) {
	const doc = { 'dist-tags': { latest }, versions: {}, time: {}, ...extra }
	for (const [version, age] of Object.entries(versions)) {
		const meta = typeof age === 'number' ? { ageDays: age } : age
		doc.versions[version] = meta.deprecated ? { deprecated: 'withdrawn' } : {}
		doc.time[version] = daysAgo(meta.ageDays)
	}
	return slimPackument(doc)
}

function pick(current, doc, options = {}) {
	return pickTargets({ current, packument: doc, now: NOW, minAgeMs: 3 * DAY, ...options })
}

const LOCKFILE = `lockfileVersion: '6.0'

settings:
  autoInstallPeers: true

importers:

  .:
    devDependencies:
      '@biomejs/biome':
        specifier: 2.5.10
        version: 2.5.10
      typescript:
        specifier: ^7.0.2
        version: 7.0.2

  apps/api:
    dependencies:
      '@nestjs/common':
        specifier: ^12.0.1
        version: 12.0.1(reflect-metadata@0.2.2)(rxjs@7.8.2)
      '@zerohuman/shared':
        specifier: workspace:*
        version: link:../../packages/shared
    devDependencies:
      typescript:
        specifier: ~6.0.2
        version: 6.0.3
    dependenciesMeta:
      fsevents:
        built: false

packages:

  /typescript@7.0.2:
    resolution: {integrity: sha512-x}
`

describe('compareVersions and bumpLevel', () => {
	it('orders versions by their numbers and puts a prerelease below its release', () => {
		assert.equal(compareVersions('1.2.3', '1.10.0'), -1)
		assert.equal(compareVersions('2.0.0', '2.0.0'), 0)
		assert.equal(compareVersions('2.0.0-beta.1', '2.0.0'), -1)
		assert.equal(compareVersions('latest', '2.0.0'), null)
	})

	it('names the size of a move', () => {
		assert.equal(bumpLevel('1.2.3', '1.2.4'), 'patch')
		assert.equal(bumpLevel('1.2.3', '1.3.0'), 'minor')
		assert.equal(bumpLevel('1.2.3', '2.0.0'), 'major')
		assert.equal(bumpLevel('1.2.3', '1.2.3'), 'none')
		assert.equal(bumpLevel('1.2.3', '1.2.2'), 'downgrade')
		assert.equal(bumpLevel('1.2.3', 'next'), 'unknown')
	})
})

describe('lockfileImporters', () => {
	const rows = lockfileImporters(LOCKFILE)

	it('reads each direct dependency per workspace package, without its peer suffix', () => {
		assert.deepEqual(
			rows.find(row => row.name === '@nestjs/common'),
			{ importer: 'apps/api', name: '@nestjs/common', specifier: '^12.0.1', version: '12.0.1' },
		)
	})

	it('keeps one dependency held at two versions as two rows', () => {
		assert.deepEqual(
			rows.filter(row => row.name === 'typescript').map(row => [row.importer, row.version]),
			[
				['.', '7.0.2'],
				['apps/api', '6.0.3'],
			],
		)
	})

	it('leaves out workspace links, other blocks and everything after importers', () => {
		assert.deepEqual(rows.map(row => row.name).sort(), [
			'@biomejs/biome',
			'@nestjs/common',
			'typescript',
			'typescript',
		])
	})
})

describe('pickTargets', () => {
	it('offers the newest release in the current major that is past the cooldown', () => {
		const doc = packument('1.4.0', { '1.2.0': 90, '1.3.0': 10, '1.4.0': 1 })

		assert.deepEqual(pick('1.2.0', doc), { inMajor: '1.3.0', major: null })
	})

	it('waives the cooldown inside the major for a package an audit names', () => {
		const doc = packument('1.4.0', { '1.2.0': 90, '1.3.0': 10, '1.4.0': 1 })

		assert.equal(pick('1.2.0', doc, { waiveAge: true }).inMajor, '1.4.0')
	})

	it('offers a major apart from the newest release left in the current one', () => {
		const doc = packument('2.1.0', { '1.2.0': 90, '1.9.0': 30, '2.0.0': 20, '2.1.0': 8 })

		assert.deepEqual(pick('1.2.0', doc), { inMajor: '1.9.0', major: '2.1.0' })
	})

	it('makes a major wait out the cooldown even when an audit names the package', () => {
		const doc = packument('2.0.0', { '1.2.0': 90, '2.0.0': 1 })

		assert.deepEqual(pick('1.2.0', doc, { waiveAge: true }), { inMajor: null, major: null })
	})

	it('never offers a prerelease, a deprecated release or anything above latest', () => {
		const doc = packument('1.3.0', {
			'1.2.0': 90,
			'1.3.0': 30,
			'1.4.0-beta.1': 20,
			'1.5.0': { ageDays: 20, deprecated: true },
			'1.6.0': 20,
		})

		assert.equal(pick('1.2.0', doc).inMajor, '1.3.0')
	})

	it('holds a package whose latest is lower than what is installed, or is not a version', () => {
		assert.match(pick('2.0.0', packument('1.9.0', { '1.9.0': 30 })).held, /lower than the current/)
		assert.match(pick('2.0.0', packument('stable', {})).held, /no comparable latest/)
	})
})

describe('parseAudit', () => {
	it('reads the advisory shape and keeps the worst severity per package', () => {
		const raw = JSON.stringify({
			advisories: {
				1: { module_name: 'multer', severity: 'moderate' },
				2: { module_name: 'multer', severity: 'high' },
				3: { module_name: 'esbuild', severity: 'low' },
			},
		})

		assert.deepEqual(
			[...parseAudit(raw)],
			[
				['multer', 'high'],
				['esbuild', 'low'],
			],
		)
	})

	it('reads the vulnerabilities shape, and gives nothing for output that is not a report', () => {
		assert.deepEqual(
			[...parseAudit(JSON.stringify({ vulnerabilities: { lodash: { severity: 'critical' } } }))],
			[['lodash', 'critical']],
		)
		assert.equal(parseAudit('ERR_PNPM_AUDIT_BAD_RESPONSE').size, 0)
	})
})

describe('buildReport', () => {
	const rows = [
		{ importer: 'apps/api', name: 'left', specifier: '^1.0.0', version: '1.0.0' },
		{ importer: 'apps/inbox', name: 'left', specifier: '^1.0.0', version: '1.0.0' },
		{ importer: 'apps/api', name: 'zero', specifier: '^0.4.0', version: '0.4.0' },
		{ importer: 'apps/api', name: '@frame/core', specifier: '^3.0.0', version: '3.0.0' },
		{ importer: 'apps/api', name: '@frame/http', specifier: '^3.0.0', version: '3.0.0' },
		{ importer: 'apps/api', name: '@types/one', specifier: '^3.0.0', version: '3.0.0' },
		{ importer: 'apps/api', name: '@types/two', specifier: '^3.0.0', version: '3.0.0' },
		{ importer: 'apps/api', name: 'gone', specifier: '^1.0.0', version: '1.0.0' },
		{ importer: 'apps/api', name: 'risky', specifier: '^1.0.0', version: '1.0.0' },
	]
	const packuments = new Map([
		['left', packument('1.0.1', { '1.0.0': 90, '1.0.1': 30 })],
		['zero', packument('0.5.0', { '0.4.0': 90, '0.5.0': 30 })],
		[
			'@frame/core',
			packument(
				'4.1.0',
				{ '3.0.0': 90, '4.1.0': 40 },
				{ repository: { url: 'git+https://github.com/frame/frame.git' } },
			),
		],
		['@frame/http', packument('4.1.0', { '3.0.0': 90, '4.1.0': 60 })],
		['@types/one', packument('4.0.0', { '3.0.0': 90, '4.0.0': 20 })],
		['@types/two', packument('4.0.0', { '3.0.0': 90, '4.0.0': 10 })],
		['gone', null],
		['risky', packument('1.2.0', { '1.0.0': 90, '1.2.0': 1 })],
	])
	const report = buildReport(rows, packuments, new Map([['risky', 'high']]), { now: NOW })

	it('lists an update once however many packages declare it, worst advisory first', () => {
		assert.deepEqual(
			report.updates.map(row => [row.name, row.current, row.target, row.level, row.security]),
			[
				['risky', '1.0.0', '1.2.0', 'minor', 'high'],
				['left', '1.0.0', '1.0.1', 'patch', null],
				['zero', '0.4.0', '0.5.0', 'minor', null],
			],
		)
	})

	it('marks a 0.x minor as one that may break', () => {
		assert.equal(report.updates.find(row => row.name === 'zero').zeroMinor, true)
		assert.equal(report.updates.find(row => row.name === 'risky').zeroMinor, false)
	})

	it('files one scope moving between the same majors as one family, oldest release first', () => {
		assert.deepEqual(
			report.majors.map(family => [family.title, family.packages.map(member => member.name)]),
			[
				['Major upgrade: @frame/* 3 to 4', ['@frame/core', '@frame/http']],
				['Major upgrade: @types/one 3 to 4', ['@types/one']],
				['Major upgrade: @types/two 3 to 4', ['@types/two']],
			],
		)
	})

	it('holds a package the registry does not have, with the reason', () => {
		assert.deepEqual(report.held, [
			{ name: 'gone', current: '1.0.0', reason: 'the registry does not have this package' },
		])
	})

	it('prints the counts first, the apply lines in order, and each major with its own apply line', () => {
		const text = renderReport(report)

		assert.equal(text.split('\n')[0], 'updates: 3 security: 1 majors: 3 held: 1')
		assert.ok(text.indexOf('1. Security: `mise run os:deps:apply risky@1.2.0`') > 0)
		assert.ok(text.indexOf('2. Patch: `mise run os:deps:apply left@1.0.1`') > text.indexOf('1. Security'))
		assert.ok(text.indexOf('3. Minor: `mise run os:deps:apply zero@0.5.0`') > text.indexOf('2. Patch'))
		assert.match(text, /### Major upgrade: @frame\/\* 3 to 4/)
		assert.match(text, /- Apply: `mise run os:deps:apply --major @frame\/core@4\.1\.0 @frame\/http@4\.1\.0`/)
		assert.match(text, /- Release notes: https:\/\/github\.com\/frame\/frame\/releases/)
		assert.match(text, /- `gone` 1\.0\.0: the registry does not have this package/)
	})

	it('drops whole updates, least urgent first, to stay under the limit, and says how many', () => {
		const limit = renderReport(report).length - 20
		const text = renderReport(report, { limit })

		assert.ok(text.length <= limit + 1)
		assert.match(text, /\| `risky` \|/)
		assert.doesNotMatch(text, /\| `zero` \|/)
		assert.match(text, /1 more update\(s\) did not fit this report/)
		assert.match(text, /### Major upgrade: @types\/two 3 to 4/)
	})

	it('drops majors only once no update is left to drop', () => {
		const text = renderReport(report, { limit: 900 })

		assert.match(text, /3 update\(s\) did not fit this report/)
		assert.match(text, /### Major upgrade: @frame\/\* 3 to 4/)
		assert.match(text, /2 more major\(s\) did not fit this report/)
	})

	it('says so when there is nothing to do', () => {
		const text = renderReport(buildReport([], new Map(), new Map(), { now: NOW }))

		assert.equal(text.split('\n')[0], 'updates: 0 security: 0 majors: 0 held: 0')
	})
})

describe('notesUrl', () => {
	it('falls back to the homepage, then to the package page', () => {
		assert.equal(notesUrl('x', { repository: null, homepage: 'https://x.dev' }), 'https://x.dev')
		assert.equal(
			notesUrl('x', { repository: null, homepage: null }),
			'https://www.npmjs.com/package/x?activeTab=versions',
		)
		assert.equal(
			notesUrl('x', { repository: 'git@github.com:acme/x.git', homepage: null }),
			'https://github.com/acme/x/releases',
		)
	})
})

describe('parsePairs', () => {
	it('reads scoped and plain pairs and refuses anything else', () => {
		assert.deepEqual(parsePairs(['@nestjs/core@12.1.2', 'vue@3.5.43']), [
			{ name: '@nestjs/core', version: '12.1.2' },
			{ name: 'vue', version: '3.5.43' },
		])
		assert.throws(() => parsePairs(['vue']), /not a name@version pair: vue/)
		assert.throws(() => parsePairs(['vue@latest']), /not a name@version pair/)
	})
})

describe('applyPairs', () => {
	const manifest = `{
    "name": "app",
    "dependencies": {
        "left": "^1.0.0",
        "pinned": "2.5.10",
        "linked": "workspace:*"
    },
    "devDependencies": {
        "typescript": "~6.0.2",
        "short": "^22"
    }
}
`

	it('moves a range to the target and keeps its operator and the file layout', () => {
		const { text, changed } = applyPairs(manifest, parsePairs(['left@1.0.1', 'pinned@2.5.15', 'short@22.20.4']))

		assert.deepEqual(
			changed.map(change => [change.name, change.from, change.to]),
			[
				['left', '^1.0.0', '^1.0.1'],
				['pinned', '2.5.10', '2.5.15'],
				['short', '^22', '^22.20.4'],
			],
		)
		assert.equal(
			text,
			manifest.replace('^1.0.0', '^1.0.1').replace('2.5.10', '2.5.15').replace('"^22"', '"^22.20.4"'),
		)
	})

	it('leaves a declaration on another major alone unless the move is a major', () => {
		const pairs = parsePairs(['typescript@7.0.2'])

		assert.deepEqual(applyPairs(manifest, pairs).changed, [])
		assert.deepEqual(applyPairs(manifest, pairs, { major: true }).changed, [
			{ name: 'typescript', section: 'devDependencies', from: '~6.0.2', to: '~7.0.2', version: '7.0.2' },
		])
	})

	it('never moves a declaration down, or one that is not a plain range', () => {
		assert.deepEqual(applyPairs(manifest, parsePairs(['left@0.9.0', 'linked@1.0.0']), { major: true }).changed, [])
	})

	it('moves a package held at two majors to the target of its own major, in one apply', () => {
		const two = `{
    "devDependencies": { "@types/node": "^22.20.2" }
}
`
		const other = `{
    "devDependencies": { "@types/node": "^24.19.0" }
}
`
		const pairs = parsePairs(['@types/node@22.20.5', '@types/node@24.19.1'])

		assert.deepEqual(
			applyPairs(two, pairs).changed.map(change => [change.to, change.version]),
			[['^22.20.5', '22.20.5']],
		)
		assert.deepEqual(
			applyPairs(other, pairs).changed.map(change => [change.to, change.version]),
			[['^24.19.1', '24.19.1']],
		)
	})
})

describe('offTarget', () => {
	const lock = [
		{ importer: 'packages/db', name: '@types/node', version: '22.20.5' },
		{ importer: 'apps/portal', name: '@types/node', version: '24.19.1' },
	]
	const edits = [
		{
			importer: 'packages/db',
			changed: [{ name: '@types/node', from: '^22.20.2', to: '^22.20.5', version: '22.20.5' }],
		},
		{
			importer: 'apps/portal',
			changed: [{ name: '@types/node', from: '^24.19.0', to: '^24.19.1', version: '24.19.1' }],
		},
	]

	it('passes a package held at two majors when each declaration landed on its own major’s target', () => {
		// The first real scheduled run's apply line carried both targets, and blamed packages/db for 24.19.1.
		assert.deepEqual(offTarget(edits, lock), [])
	})

	it('names a declaration whose lockfile row is not the version it was moved to', () => {
		const behind = lock.map(row => (row.importer === 'apps/portal' ? { ...row, version: '24.19.0' } : row))

		assert.deepEqual(offTarget(edits, behind), ['apps/portal: @types/node resolved 24.19.0, not 24.19.1'])
	})
})

describe('findDowngrades', () => {
	const before = [
		{ importer: 'apps/api', name: 'left', version: '1.2.0' },
		{ importer: 'apps/portal', name: 'left', version: '1.0.0' },
		{ importer: 'apps/api', name: 'removed', version: '1.0.0' },
	]

	it('names a direct dependency that resolves lower in the package that declares it', () => {
		const after = [
			{ importer: 'apps/api', name: 'left', version: '1.1.0' },
			{ importer: 'apps/portal', name: 'left', version: '1.2.0' },
		]

		assert.deepEqual(findDowngrades(before, after), [
			{ importer: 'apps/api', name: 'left', before: '1.2.0', after: '1.1.0' },
		])
	})

	it('passes a bump, an unchanged version and a dependency that was removed', () => {
		const after = [
			{ importer: 'apps/api', name: 'left', version: '1.2.0' },
			{ importer: 'apps/portal', name: 'left', version: '1.0.1' },
		]

		assert.deepEqual(findDowngrades(before, after), [])
	})
})

describe('npmImporters', () => {
	const lock = JSON.stringify({
		lockfileVersion: 3,
		packages: {
			'': {},
			'node_modules/left': { version: '1.0.0' },
			'node_modules/dev': { version: '2.1.0' },
			'node_modules/opt': { version: '3.0.1' },
			'node_modules/linked': { version: '0.0.0' },
		},
	})

	it('reads dependencies, dev and optional dependencies with the version the lockfile resolved', () => {
		const packageJson = JSON.stringify({
			dependencies: { left: '^1.0.0' },
			devDependencies: { dev: '~2.1.0' },
			optionalDependencies: { opt: '3.0.1' },
		})

		assert.deepEqual(npmImporters({ packageJson, lock }), [
			{ importer: '.', name: 'left', specifier: '^1.0.0', version: '1.0.0' },
			{ importer: '.', name: 'dev', specifier: '~2.1.0', version: '2.1.0' },
			{ importer: '.', name: 'opt', specifier: '3.0.1', version: '3.0.1' },
		])
	})

	it('leaves out local, git and alias specifiers, and anything the lockfile does not resolve', () => {
		const packageJson = JSON.stringify({
			dependencies: {
				left: '^1.0.0',
				linked: 'file:../linked',
				remote: 'github:acme/remote',
				aliased: 'npm:left@^1.0.0',
				skipped: '^4.0.0',
			},
		})

		assert.deepEqual(
			npmImporters({ packageJson, lock }).map(row => row.name),
			['left'],
		)
	})

	it('refuses npm workspaces and a version 1 lockfile, by name', () => {
		assert.throws(
			() => npmImporters({ packageJson: JSON.stringify({ workspaces: ['apps/*'] }), lock }),
			/npm workspaces/,
		)
		assert.throws(
			() => npmImporters({ packageJson: '{}', lock: JSON.stringify({ lockfileVersion: 1, dependencies: {} }) }),
			/lockfile version 1/,
		)
	})
})

describe('the commands, run in a repository', () => {
	const script = join(dirname(fileURLToPath(import.meta.url)), 'os-deps.mjs')
	const manifest = { name: 'app', dependencies: { left: '^1.0.0', right: '2.0.0' } }
	const lock = {
		lockfileVersion: 3,
		packages: {
			'': { name: 'app', dependencies: manifest.dependencies },
			'node_modules/left': { version: '1.0.0' },
			'node_modules/right': { version: '2.0.0' },
		},
	}
	// A stand-in for npm: logs what it was asked and what package.json said then, and resolves each dependency to the
	// version its range names, which is what installing an exact version does.
	const NPM = `#!/usr/bin/env node
const fs = require('node:fs')
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
fs.appendFileSync(process.env.NPM_LOG, JSON.stringify({ args: process.argv.slice(2), deps: pkg.dependencies }) + '\\n')
if (process.env.FAKE_NPM_FAIL) process.exit(1)
if (process.env.FAKE_NPM_STAY) process.exit(0)
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'))
for (const [name, spec] of Object.entries(pkg.dependencies)) {
    lock.packages['node_modules/' + name].version = spec.replace(/^[\\^~]/, '')
}
fs.writeFileSync('package-lock.json', JSON.stringify(lock, null, 2))
`
	let dir = ''
	let bin = ''

	const read = file => readFileSync(join(dir, file), 'utf8')
	const run = (args, env = {}) =>
		spawnSync(process.execPath, [script, ...args], {
			cwd: dir,
			encoding: 'utf8',
			env: {
				...process.env,
				PATH: `${bin}${delimiter}${process.env.PATH}`,
				NPM_LOG: join(dir, 'npm.log'),
				...env,
			},
		})

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'os-deps-'))
		bin = join(dir, 'bin')
		mkdirSync(bin)
		writeFileSync(join(bin, 'npm'), NPM)
		chmodSync(join(bin, 'npm'), 0o755)
		writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
		writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock, null, 2))
	})

	afterEach(() => rmSync(dir, { recursive: true, force: true }))

	it('applies in two installs: the exact target first, then the range the declaration keeps', () => {
		const done = run(['apply', 'left@1.0.1'])

		assert.equal(done.status, 0, done.stderr)
		assert.equal(JSON.parse(read('package.json')).dependencies.left, '^1.0.1')
		assert.equal(JSON.parse(read('package-lock.json')).packages['node_modules/left'].version, '1.0.1')
		const calls = read('npm.log')
			.trim()
			.split('\n')
			.map(line => JSON.parse(line))
		assert.equal(calls.length, 2)
		assert.equal(calls[0].deps.left, '1.0.1')
		assert.ok(!calls[0].args.includes('--package-lock-only'))
		assert.equal(calls[1].deps.left, '^1.0.1')
		assert.ok(calls[1].args.includes('--package-lock-only'))
		assert.ok(calls.every(call => call.args.includes('--ignore-scripts')))
	})

	it('puts every file back as it was when the install fails', () => {
		const before = { manifest: read('package.json'), lock: read('package-lock.json') }

		const done = run(['apply', 'left@1.0.1'], { FAKE_NPM_FAIL: '1' })

		assert.equal(done.status, 1)
		assert.match(done.stderr, /back as they were/)
		assert.equal(read('package.json'), before.manifest)
		assert.equal(read('package-lock.json'), before.lock)
	})

	it('puts every file back as it was when the lockfile does not land on the target', () => {
		const before = { manifest: read('package.json'), lock: read('package-lock.json') }

		const done = run(['apply', 'left@1.0.1'], { FAKE_NPM_STAY: '1' })

		assert.equal(done.status, 1)
		assert.match(done.stderr, /did not land on the targets/)
		assert.equal(read('package.json'), before.manifest)
		assert.equal(read('package-lock.json'), before.lock)
	})

	it('refuses a pair nothing declares lower, changing no file', () => {
		const done = run(['apply', 'nobody@1.0.0'])

		assert.equal(done.status, 1)
		assert.match(done.stderr, /nothing declares a lower version/)
		assert.equal(read('package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
	})

	it('exits 2 and says the scan failed when there is no lockfile, or two', () => {
		rmSync(join(dir, 'package-lock.json'))
		const none = run(['report'])
		assert.equal(none.status, 2)
		assert.match(none.stderr, /scan_failed: no supported lockfile/)

		writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock))
		writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
		const both = run(['report'])
		assert.equal(both.status, 2)
		assert.match(both.stderr, /both exist/)
	})

	describe('in a git repository', () => {
		const git = (...args) =>
			execFileSync('git', ['-c', 'user.email=os@example.com', '-c', 'user.name=OS', ...args], {
				cwd: dir,
				encoding: 'utf8',
			}).trim()

		beforeEach(() => {
			git('init', '-q', '-b', 'main')
			git('add', '-A')
			git('commit', '-q', '-m', 'base')
		})

		it('finds the commit a branch forked from the default branch', () => {
			const base = git('rev-parse', 'HEAD')
			git('checkout', '-q', '-b', 'feature')
			writeFileSync(join(dir, 'note.txt'), 'x')
			git('add', '-A')
			git('commit', '-q', '-m', 'work')

			assert.equal(mergeBase(dir, { OS_BASE_REF: 'main' }), base)
		})

		it('verifies a lockfile that moved up, and names a package that went down', () => {
			const resolve = version => {
				const moved = JSON.parse(JSON.stringify(lock))
				moved.packages['node_modules/left'].version = version
				writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(moved, null, 2))
				return run(['verify'], { OS_BASE_REF: 'main' })
			}

			assert.equal(resolve('1.2.0').status, 0)
			const down = resolve('0.9.0')
			assert.equal(down.status, 1)
			assert.match(down.stderr, /downgrade: \.: left 1\.0\.0 -> 0\.9\.0/)
		})
	})
})

describe('fetchPackument', () => {
	const answer =
		(status, body = {}) =>
		async () => ({ status, ok: status >= 200 && status < 300, json: async () => body })
	const noWait = async () => undefined

	it('reads a package, and says null when the registry has none', async () => {
		const found = await fetchPackument('https://r/', 'left', 3, {
			fetchFn: answer(200, { 'dist-tags': { latest: '1.0.0' }, versions: {}, time: {} }),
			wait: noWait,
		})
		assert.equal(found.latest, '1.0.0')
		assert.equal(await fetchPackument('https://r/', 'gone', 3, { fetchFn: answer(404), wait: noWait }), null)
	})

	it('holds back a package that wants credentials, with the reason, instead of failing the scan', async () => {
		for (const status of [401, 403]) {
			const held = await fetchPackument('https://r/', '@acme/private', 3, {
				fetchFn: answer(status),
				wait: noWait,
			})
			assert.deepEqual(held, { held: `the registry needs credentials for this package (HTTP ${status})` })
		}
	})

	it('tries again a little later when the registry fails, and fails the scan when it keeps failing', async () => {
		const waits = []
		let calls = 0
		const down = async () => {
			calls += 1
			return { status: 503, ok: false }
		}

		await assert.rejects(
			fetchPackument('https://r/', 'left', 3, { fetchFn: down, wait: async ms => waits.push(ms) }),
			/did not answer for left \(HTTP 503\)/,
		)
		assert.equal(calls, 3)
		assert.deepEqual(waits, [1000, 2000])
	})
})

describe('buildReport with a package the registry held back', () => {
	it('lists it under held back with the registry’s reason, and reports the rest', () => {
		const rows = [
			{ importer: '.', name: 'private', specifier: '^1.0.0', version: '1.0.0' },
			{ importer: '.', name: 'left', specifier: '^1.0.0', version: '1.0.0' },
		]
		const packuments = new Map([
			['private', { held: 'the registry needs credentials for this package (HTTP 401)' }],
			[
				'left',
				slimPackument({
					'dist-tags': { latest: '1.0.1' },
					versions: { '1.0.0': {}, '1.0.1': {} },
					time: { '1.0.0': '2026-01-01T00:00:00Z', '1.0.1': '2026-02-01T00:00:00Z' },
				}),
			],
		])

		const report = buildReport(rows, packuments, new Map(), { now: Date.parse('2026-10-04T00:00:00Z') })

		assert.deepEqual(report.held, [
			{ name: 'private', current: '1.0.0', reason: 'the registry needs credentials for this package (HTTP 401)' },
		])
		assert.deepEqual(
			report.updates.map(row => row.name),
			['left'],
		)
	})
})
