#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { constants } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

function normalize(result) {
	if (result.runner === 'node')
		return {
			counts: {
				passed: result.counts.passed,
				failed: result.counts.failed + result.counts.cancelled,
				skipped: result.counts.skipped,
				todo: result.counts.todo,
			},
			failures: result.failures ?? [],
		}
	if (result.stats && Array.isArray(result.suites)) {
		const failures = []
		const visit = suite => {
			for (const entry of suite.specs ?? []) {
				if (entry.tests.some(test => test.status === 'unexpected'))
					failures.push({ name: entry.title, file: entry.file })
			}
			for (const nested of suite.suites ?? []) visit(nested)
		}
		for (const suite of result.suites) visit(suite)
		return {
			counts: {
				passed: result.stats.expected + result.stats.flaky,
				failed: result.stats.unexpected,
				skipped: result.stats.skipped,
				todo: 0,
			},
			failures,
		}
	}
	return {
		counts: {
			passed: result.numPassedTests,
			failed: result.numFailedTests,
			skipped: result.numPendingTests,
			todo: result.numTodoTests ?? 0,
		},
		failures: result.testResults.flatMap(suite =>
			(suite.assertionResults ?? [])
				.filter(test => test.status === 'failed')
				.map(test => ({ name: test.fullName ?? test.title, file: suite.name })),
		),
	}
}

function escaped(value) {
	return String(value)
		.slice(0, 240)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('|', '&#124;')
		.replaceAll('`', '&#96;')
		.replaceAll('@', '@\u200b')
		.replace(/[\r\n]+/g, ' ')
		.replace(/[[\]*_\\]/g, '\\$&')
}

function render(reports) {
	const rows = reports.map(r => {
		const counts = r.counts
			? `${r.counts.passed} passed, ${r.counts.failed} failed, ${r.counts.skipped} skipped, ${r.counts.todo} todo`
			: 'No native test report available'
		return `| ${r.phase} | ${escaped(r.command)} | ${r.outcome}: ${counts}; exit ${r.exitCode} | ${(r.durationMs / 1000).toFixed(1)}s | ${r.commit ?? 'unavailable'}${r.dirty ? ' + uncommitted changes' : ''} |`
	})
	const failures = reports.flatMap(r =>
		r.failures.map(
			failure => `- ${r.phase}: ${escaped(failure.name)} (${escaped(failure.file ?? 'file unavailable')})`,
		),
	)
	const details =
		failures.length > 0
			? `\nFailed tests:\n\n${failures.slice(0, 10).join('\n')}\n${failures.length > 10 ? `\n${failures.length - 10} more failures in the report.\n` : ''}`
			: ''
	const warnings = reports.flatMap(r => r.warnings ?? []).map(escaped)
	return `### Test results\n\n| Phase | Command | Result | Duration | Commit |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}\n${details}\n${reports.map(r => `Full log (${r.phase}, workspace file): \`${r.logPath}\``).join('\n')}\n${warnings.length > 0 ? `\nReporting warnings: ${warnings.slice(0, 5).join('; ')}\n` : ''}`
}

function reportFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
		if (entry.name === 'baseline') return []
		const path = join(directory, entry.name)
		if (entry.isDirectory()) return reportFiles(path)
		return entry.isFile() && entry.name.endsWith('.json') ? [path] : []
	})
}

function classify(taskPhase, code, signal, reportCount, counts, warnings) {
	if (signal) return 'interrupted'
	const special = {
		2: 'usage_error',
		6: 'pre_existing_failure',
		7: 'environment_failure',
		...(taskPhase === 'red' ? { 3: 'red_suite_missing', 4: 'red_suite_typecheck', 5: 'red_suite_skips' } : {}),
	}
	if (special[code]) return special[code]
	if (counts.failed > 0) return 'tests_failed'
	if (code !== 0) return 'command_failed'
	if (warnings.length > 0) return 'report_incomplete'
	return reportCount > 0 ? 'passed' : 'no_test_results'
}

function readNativeReports(directory) {
	const native = []
	const warnings = []
	let paths
	try {
		paths = reportFiles(directory)
	} catch {
		return { native, warnings: ['Test reporting unavailable: cannot read native report directory'] }
	}
	for (const path of paths) {
		try {
			const value = normalize(JSON.parse(readFileSync(path, 'utf8')))
			if (Object.values(value.counts).some(count => !Number.isSafeInteger(count) || count < 0))
				throw new Error('invalid counts')
			native.push(value)
		} catch {
			warnings.push(`Cannot read native test report: ${relative(directory, path)}`)
		}
	}
	return { native, warnings }
}

function writeLatest(cwd) {
	const latest = new Map()
	for (const folder of readdirSync(join(cwd, '.os/test-results'), { withFileTypes: true })
		.filter(entry => entry.isDirectory())
		.sort((a, b) => a.name.localeCompare(b.name))) {
		try {
			const previous = JSON.parse(readFileSync(join(cwd, '.os/test-results', folder.name, 'report.json'), 'utf8'))
			latest.set(JSON.stringify([previous.phase, previous.command]), previous)
		} catch {
			/* A concurrent or interrupted run has no final report yet. */
		}
	}
	writeFileSync(join(cwd, '.os/test-results/latest.md'), render([...latest.values()]))
}

const argv = process.argv.slice(2)
const separator = argv.indexOf('--')
const options = argv.slice(0, separator)
const phase = options.includes('--phase') ? options[options.indexOf('--phase') + 1] : null
const label = options.includes('--label') ? options[options.indexOf('--label') + 1] : null
if (argv[0] === 'summary') {
	try {
		process.stdout.write(readFileSync(join(process.cwd(), '.os/test-results/latest.md'), 'utf8'))
	} catch {
		process.stdout.write('No test summary has been recorded in this workspace.\n')
	}
} else if (
	argv[0] !== 'run' ||
	separator < 0 ||
	!label ||
	label.startsWith('--') ||
	!['red', 'check', 'coverage', 'diagnose'].includes(phase) ||
	!argv[separator + 1]
) {
	console.error(
		'Usage: os-test-report run --phase red|check|coverage|diagnose --label <command> -- <executable> [arguments]',
	)
	process.exitCode = 2
} else {
	const cwd = process.cwd()
	const started = Date.now()
	const git = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
	const status = spawnSync('git', ['status', '--porcelain', '--', '.', ':(exclude).os/test-results'], {
		encoding: 'utf8',
	})
	const directory = join(cwd, '.os/test-results', `${started}-${phase}-${randomUUID().slice(0, 8)}`)
	const reports = join(directory, 'native')
	mkdirSync(reports, { recursive: true })
	const log = createWriteStream(join(directory, 'output.log'))
	const reporter = fileURLToPath(new URL('./node-reporter.mjs', import.meta.url))
	const nodeOptions = process.env.NODE_OPTIONS || ''
	const customReporter =
		argv.includes('--no-node-reporter') ||
		nodeOptions.includes('--test-reporter') ||
		argv.slice(separator + 1).some(arg => arg.startsWith('--test-reporter'))
	const child = spawn(argv[separator + 1], argv.slice(separator + 2), {
		cwd,
		detached: process.platform !== 'win32',
		env: {
			...process.env,
			OS_TEST_REPORT_RUN: directory,
			OS_TEST_REPORT_DIR: reports,
			NODE_OPTIONS: customReporter ? nodeOptions : `${nodeOptions} --test-reporter=${JSON.stringify(reporter)}`,
		},
		stdio: ['inherit', 'pipe', 'pipe'],
	})
	let interrupted
	const forwardSignal = signal => {
		interrupted = signal
		if (!child.pid) return
		try {
			if (process.platform === 'win32') child.kill(signal)
			else process.kill(-child.pid, signal)
		} catch (error) {
			if (error.code !== 'ESRCH') console.error(`Could not forward ${signal}: ${error.message}`)
		}
	}
	const terminate = () => forwardSignal('SIGTERM')
	const interrupt = () => forwardSignal('SIGINT')
	process.on('SIGTERM', terminate)
	process.on('SIGINT', interrupt)
	for (const [stream, destination] of [
		[child.stdout, process.stdout],
		[child.stderr, process.stderr],
	]) {
		stream.on('data', chunk => {
			log.write(chunk)
			destination.write(chunk)
		})
	}
	let spawnFailure
	child.on('error', error => {
		spawnFailure = error.code === 'ENOENT' ? 127 : 126
		log.write(`${error.message}\n`)
		console.error(error.message)
	})
	child.on('close', (childCode, childSignal) => {
		process.off('SIGTERM', terminate)
		process.off('SIGINT', interrupt)
		const signal = interrupted ?? childSignal
		const code = signal ? 128 + (constants.signals[signal] ?? 1) : (spawnFailure ?? childCode)
		log.end()
		process.exitCode = code ?? 1
		try {
			const { native, warnings } = readNativeReports(reports)
			const counts = { passed: 0, failed: 0, skipped: 0, todo: 0 }
			for (const result of native) {
				counts.passed += result.counts.passed
				counts.failed += result.counts.failed
				counts.skipped += result.counts.skipped
				counts.todo += result.counts.todo
			}
			const outcome = classify(phase, code, signal, native.length, counts, warnings)
			const report = {
				schemaVersion: 1,
				phase,
				command: label,
				commit: git.status === 0 ? git.stdout.trim() : null,
				dirty: status.status === 0 ? status.stdout.trim().length > 0 : null,
				startedAt: new Date(started).toISOString(),
				durationMs: Date.now() - started,
				exitCode: code ?? 128 + (constants.signals[signal] ?? 1),
				signal,
				outcome,
				reportComplete: native.length > 0 && warnings.length === 0 && !signal && !spawnFailure,
				warnings,
				counts: native.length > 0 ? counts : null,
				failures: native.flatMap(result => result.failures ?? []),
				logPath: relative(cwd, join(directory, 'output.log')),
			}
			const summary = render([report])
			writeFileSync(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
			writeFileSync(join(directory, 'summary.md'), summary)
			writeLatest(cwd)
			process.stdout.write(summary)
		} catch (error) {
			console.error(`Test reporting unavailable: ${error.message}`)
		}
	})
}
