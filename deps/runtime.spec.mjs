import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { fetchJson, mergeReports, renderReport, ScanError } from './os-deps.mjs'
import {
	buildRuntimeReport,
	corepackHash,
	FLOAT_SECURITY_DAYS,
	findRuntimeDeclarations,
	findRuntimeDowngrades,
	isRuntimeFile,
	parseDeclared,
	parseEnginesRange,
	parseNodeIndex,
	parseNodeSchedule,
	planRuntimeEdits,
	satisfiesRange,
} from './runtime.mjs'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-26T00:00:00Z')

function day(daysAgo) {
	return new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10)
}

/** nodejs.org's index, newest first: `[version, daysAgo, { lts, security }]`. */
function nodeIndex(rows) {
	return parseNodeIndex(
		rows.map(([version, age, flags = {}]) => ({
			version: `v${version}`,
			date: day(age),
			lts: flags.lts ? 'Codename' : false,
			security: Boolean(flags.security),
		})),
	)
}

function sources(extra = {}) {
	return { nodeReleases: [], nodeEnds: new Map(), packuments: new Map(), advisories: new Map(), ...extra }
}

function report(files, src, minAgeDays = 3) {
	return buildRuntimeReport(findRuntimeDeclarations(files), src, { now: NOW, minAgeDays })
}

/** A registry document for pnpm or npm, slimmed the way fetchPackument gives it. */
function managerPackument(latest, versions) {
	const doc = { latest, versions: {}, repository: null, homepage: null }
	for (const [version, age] of Object.entries(versions)) {
		doc.versions[version] = { deprecated: false, time: new Date(NOW - age * DAY).toISOString() }
	}
	return doc
}

describe('isRuntimeFile', () => {
	it('reads the files a runtime is declared in, and never node_modules', () => {
		for (const path of [
			'mise.toml',
			'.mise.toml',
			'apps/web/.nvmrc',
			'.node-version',
			'.tool-versions',
			'apps/api/package.json',
			'Dockerfile',
			'apps/api/Dockerfile.production',
			'build/web.Dockerfile',
			'docker-compose.yaml',
			'infra/compose.yml',
			'.github/workflows/ci.yml',
			'.gitea/workflows/release.yaml',
			'infra/main.tf',
			'infra/prod.tfvars',
		]) {
			assert.equal(isRuntimeFile(path), true, path)
		}
		for (const path of [
			'node_modules/x/package.json',
			'README.md',
			'src/workflows/ci.yml',
			'Dockerfile.md.txt.js',
		]) {
			assert.equal(isRuntimeFile(path), false, path)
		}
	})
})

describe('parseDeclared and parseEnginesRange', () => {
	it('tells an exact version from one that floats inside its major', () => {
		assert.deepEqual(parseDeclared('26.7.0'), { major: 26, version: '26.7.0', floating: false, suffix: '', v: '' })
		assert.deepEqual(parseDeclared('v26'), { major: 26, version: null, floating: true, suffix: '', v: 'v' })
		assert.equal(parseDeclared('26.7').floating, true)
		assert.equal(parseDeclared('26-alpine'), null)
		assert.deepEqual(parseDeclared('26.12.1-bookworm-slim', { suffix: true }).suffix, '-bookworm-slim')
		assert.equal(parseDeclared('lts/*'), null)
	})

	it('reads one major engines range, and holds a support range or an open floor', () => {
		assert.deepEqual(parseEnginesRange('>=26.7.0 <27'), {
			floor: '26.7.0',
			version: '26.7.0',
			op: '>=',
			upper: { text: '<27', major: 27 },
		})
		assert.equal(parseEnginesRange('^26.7.0').op, '^')
		assert.equal(parseEnginesRange('26.7.0').version, '26.7.0')
		assert.match(parseEnginesRange('^20.19.0 || ^22.13.0 || >=24.0.0').held, /spans several majors/)
		assert.match(parseEnginesRange('>=22').held, /open floor/)
	})
})

describe('findRuntimeDeclarations', () => {
	it('finds node, pnpm and npm wherever they are declared, each with its file and line', () => {
		const found = findRuntimeDeclarations([
			{ path: 'mise.toml', text: '[env]\nnode = "x"\n\n[tools]\nnode = "26.7.0"\npnpm = "11.17.0"\n' },
			{ path: '.nvmrc', text: 'v26\n' },
			{ path: '.tool-versions', text: 'nodejs 26.7.0\n' },
			{
				path: 'package.json',
				text: '{\n  "packageManager": "pnpm@11.17.0",\n  "engines": {\n    "node": ">=26.7.0 <27"\n  }\n}\n',
			},
			{
				path: 'Dockerfile',
				text: 'ARG NODE_VERSION=26\nFROM node:26-alpine AS build\nCOPY --chown=node:node . .\nFROM node:26@sha256:abc123 AS run\n',
			},
			{ path: 'compose.yml', text: 'services:\n  app:\n    image: "node:26.7.0-bookworm-slim"\n' },
			{
				path: '.gitea/workflows/ci.yml',
				// biome-ignore lint/suspicious/noTemplateCurlyInString: a workflow expression, as a workflow writes it
				text: "steps:\n  - uses: actions/setup-node@v4\n    with:\n      node-version: '26'\n      other: 1\n  - with:\n      node-version: ${{ inputs.node }}\n",
			},
			{ path: 'infra/main.tf', text: 'source_image = "node:26-bookworm-slim"\nimage = "bitnami/node:20"\n' },
		])
		const brief = found.map(
			entry => `${entry.file}:${entry.line} ${entry.family} ${entry.raw}${entry.held ? ' held' : ''}`,
		)
		assert.deepEqual(brief, [
			'mise.toml:5 node 26.7.0',
			'mise.toml:6 pnpm 11.17.0',
			'.nvmrc:1 node v26',
			'.tool-versions:1 node 26.7.0',
			'package.json:4 node >=26.7.0 <27',
			'package.json:2 pnpm pnpm@11.17.0',
			'Dockerfile:2 node 26-alpine',
			'Dockerfile:4 node 26 held',
			'Dockerfile:1 node 26',
			'compose.yml:3 node 26.7.0-bookworm-slim',
			'.gitea/workflows/ci.yml:4 node 26',
			'infra/main.tf:1 node 26-bookworm-slim',
		])
		assert.match(found.find(entry => entry.held).held, /pinned by digest/)
	})

	it('holds a declaration that names no major, so it is never skipped unseen', () => {
		const [entry] = findRuntimeDeclarations([{ path: '.nvmrc', text: 'lts/*\n' }])
		assert.match(entry.held, /names no major/)
	})
})

describe('satisfiesRange', () => {
	it('reads comparator sets and alternatives, prerelease bounds included', () => {
		assert.equal(satisfiesRange('8.9.0', '<9.15.0'), true)
		assert.equal(satisfiesRange('9.15.0', '<9.15.0'), false)
		assert.equal(satisfiesRange('11.2.0', '>=11.0.0 <11.5.3'), true)
		assert.equal(satisfiesRange('11.17.0', '>=12.0.0-alpha.0 <12.0.0-alpha.5'), false)
		assert.equal(satisfiesRange('12.15.0', '>=12.0.0-alpha.0 <12.0.0-alpha.5'), false)
		assert.equal(satisfiesRange('1.0.0', '<0.5.0 || >=1.0.0 <1.1.0'), true)
		assert.equal(satisfiesRange('1.0.0', 'something unreadable'), true)
	})
})

describe('buildRuntimeReport', () => {
	const index = nodeIndex([
		['27.1.0', 5],
		['26.12.1', 1, { security: true }],
		['26.11.0', 20],
		['26.7.0', 60],
		['24.22.1', 1, { lts: true, security: true }],
		['24.22.0', 30, { lts: true }],
		['20.20.2', 200, { lts: true }],
	])

	it('offers a node security release at once, cooldown or not, on one row naming every declaration', () => {
		const result = report(
			[
				{ path: 'mise.toml', text: '[tools]\nnode = "26.7.0"\n' },
				{ path: 'package.json', text: '{\n  "engines": {\n    "node": ">=26.7.0 <27"\n  }\n}\n' },
			],
			sources({ nodeReleases: index }),
		)
		assert.deepEqual(result.updates, [
			{
				name: 'node',
				current: '26.7.0',
				target: '26.12.1',
				level: 'minor',
				security: `node security release ${day(1)}`,
				note: 'declared in mise.toml:2, package.json:3',
			},
		])
	})

	it('waits out the cooldown for a release that is not a security release', () => {
		const quiet = nodeIndex([
			['26.12.1', 1],
			['26.11.0', 20],
			['26.7.0', 60],
		])
		const result = report([{ path: '.nvmrc', text: '26.7.0\n' }], sources({ nodeReleases: quiet }))
		assert.equal(result.updates[0].target, '26.11.0')
		assert.equal(result.updates[0].security, null)
	})

	it('pins a floating declaration, as a security fix while the major has a recent one', () => {
		const result = report([{ path: 'Dockerfile', text: 'FROM node:26-alpine\n' }], sources({ nodeReleases: index }))
		assert.equal(result.updates.length, 1)
		assert.equal(result.updates[0].current, '26-alpine (floats)')
		assert.equal(result.updates[0].level, 'pin')
		assert.equal(result.updates[0].target, '26.12.1')
		assert.match(result.updates[0].security, /node security release/)

		const later = buildRuntimeReport(
			findRuntimeDeclarations([{ path: 'Dockerfile', text: 'FROM node:26-alpine\n' }]),
			sources({ nodeReleases: index }),
			{ now: NOW + (FLOAT_SECURITY_DAYS + 2) * DAY, minAgeDays: 3 },
		)
		assert.equal(later.updates[0].security, null)
	})

	it('says when declarations of one family disagree on the major', () => {
		const result = report(
			[
				{ path: 'mise.toml', text: '[tools]\nnode = "24.22.0"\n' },
				{ path: 'Dockerfile', text: 'FROM node:26.7.0-alpine\n' },
			],
			sources({ nodeReleases: index }),
		)
		assert.match(
			result.held.find(row => /disagree/.test(row.reason)).reason,
			/24 in mise\.toml:2; 26 in Dockerfile:1/,
		)
		assert.deepEqual(
			result.updates.map(row => `${row.current}->${row.target}`),
			['24.22.0->24.22.1', '26.7.0->26.12.1'],
		)
	})

	it('moves node to its newest LTS major, never to an odd one', () => {
		const lts = nodeIndex([
			['27.1.0', 30],
			['26.12.1', 30, { lts: true }],
			['24.22.1', 30, { lts: true }],
		])
		const result = report([{ path: '.nvmrc', text: '24.22.1\n' }], sources({ nodeReleases: lts }))
		assert.deepEqual(
			result.majors.map(family => family.title),
			['Major upgrade: node 24 to 26'],
		)
		assert.equal(result.majors[0].security, null)
		assert.deepEqual(result.majors[0].packages[0].importers, ['.nvmrc:1'])
	})

	it('marks a major past its end of life as a security major, even when the LTS is young', () => {
		const result = report(
			[{ path: '.nvmrc', text: '20.20.2\n' }],
			sources({
				nodeReleases: index,
				nodeEnds: parseNodeSchedule({ v20: { end: '2026-04-30' }, v24: { end: '2028-04-30' } }),
			}),
		)
		assert.equal(result.majors[0].title, 'Major upgrade: node 20 to 24')
		assert.equal(result.majors[0].packages[0].target, '24.22.1')
		assert.equal(
			result.majors[0].security,
			'Security: node 20 is past end of life (2026-04-30) and gets no security fixes.',
		)
	})

	it('moves an odd major past its end of life to the next major up when no LTS is above it', () => {
		const odd = nodeIndex([
			['26.12.1', 30],
			['25.9.0', 200],
			['24.22.1', 30, { lts: true }],
		])
		const result = report(
			[{ path: '.nvmrc', text: '25.9.0\n' }],
			sources({ nodeReleases: odd, nodeEnds: parseNodeSchedule({ v25: { end: '2026-06-01' } }) }),
		)
		assert.equal(result.majors[0].title, 'Major upgrade: node 25 to 26')
	})

	it('reads pnpm from the registry, with an advisory that has no fix in its major as a security major', () => {
		const pnpm = managerPackument('12.15.0', { '8.9.0': 900, '8.15.9': 500, '11.28.8': 20, '12.15.0': 30 })
		const advisories = new Map([
			[
				'pnpm',
				[
					{
						title: 'cache poisoning',
						url: 'https://github.com/advisories/GHSA-vm32-9rqf-rh3r',
						severity: 'moderate',
						vulnerable_versions: '<9.15.0',
					},
				],
			],
		])
		const result = report(
			[{ path: 'package.json', text: '{\n  "packageManager": "pnpm@8.9.0"\n}\n' }],
			sources({ packuments: new Map([['pnpm', pnpm]]), advisories }),
		)
		assert.deepEqual(result.updates, [])
		assert.equal(result.majors[0].title, 'Major upgrade: pnpm 8 to 12')
		assert.equal(
			result.majors[0].security,
			'Security: pnpm 8 has GHSA-vm32-9rqf-rh3r (cache poisoning) with no fix in 8.x.',
		)
		assert.equal(result.majors[0].packages[0].target, '12.15.0')
	})

	it('marks a pnpm move inside its major with the worst advisory it fixes, without waiting', () => {
		const pnpm = managerPackument('11.28.8', { '11.2.0': 300, '11.28.8': 1 })
		const advisories = new Map([
			['pnpm', [{ title: 'x', severity: 'high', vulnerable_versions: '>=11.0.0 <11.5.3' }]],
		])
		const result = report(
			[{ path: 'mise.toml', text: '[tools]\npnpm = "11.2.0"\n' }],
			sources({ packuments: new Map([['pnpm', pnpm]]), advisories }),
		)
		assert.deepEqual(
			result.updates.map(row => [row.current, row.target, row.security]),
			[['11.2.0', '11.28.8', 'high']],
		)
	})
})

describe('the report, with runtime rows', () => {
	it('counts security majors, prints their Security line under the heading, and applies a pair once', () => {
		const index = nodeIndex([
			['26.12.1', 1, { security: true }],
			['26.7.0', 60],
			['24.22.1', 30, { lts: true }],
			['20.20.2', 200, { lts: true }],
		])
		const runtime = report(
			[
				{ path: 'mise.toml', text: '[tools]\nnode = "26.7.0"\n' },
				{ path: 'Dockerfile', text: 'FROM node:26-alpine\n' },
				{ path: 'tools/.nvmrc', text: '20.20.2\n' },
			],
			sources({ nodeReleases: index, nodeEnds: parseNodeSchedule({ v20: { end: '2026-04-30' } }) }),
		)
		const text = renderReport(mergeReports({ updates: [], majors: [], held: [] }, runtime), { minAgeDays: 3 })
		assert.match(text, /^updates: 2 security: 3 majors: 1 held: 1\n/)
		assert.match(text, /### Major upgrade: node 20 to 24\n\nSecurity: node 20 is past end of life/)
		assert.equal(text.match(/os:deps:apply node@26\.12\.1/g).length, 1)
		assert.match(text, /declarations disagree/)
	})
})

describe('planRuntimeEdits', () => {
	const files = [
		{ path: 'mise.toml', text: '[tools]\nnode = "26.7.0"\n' },
		{ path: '.nvmrc', text: 'v26\n' },
		{
			path: 'Dockerfile',
			text: 'ARG NODE_EXACT_VERSION=26.9.0\nFROM node:26-bookworm-slim AS a\nFROM node:24-alpine AS b\n',
		},
		{
			path: 'package.json',
			text: '{\n  "packageManager": "pnpm@11.17.0+sha512.00",\n  "engines": {\n    "node": ">=26.7.0 <27"\n  }\n}\n',
		},
	]
	const declarations = findRuntimeDeclarations(files)
	const edited = plan => Object.fromEntries(plan.edits.map(edit => [edit.path, edit.text]))

	it('moves every declaration on the major, in the form each was written in', () => {
		const plan = planRuntimeEdits(files, declarations, [{ name: 'node', version: '26.12.1' }])
		const text = edited(plan)
		assert.equal(text['mise.toml'], '[tools]\nnode = "26.12.1"\n')
		assert.equal(text['.nvmrc'], 'v26.12.1\n')
		assert.equal(
			text.Dockerfile,
			'ARG NODE_EXACT_VERSION=26.12.1\nFROM node:26.12.1-bookworm-slim AS a\nFROM node:24-alpine AS b\n',
		)
		assert.match(text['package.json'], /"node": ">=26\.12\.1 <27"/)
		assert.deepEqual(plan.lost, [])
	})

	it('moves the engines upper bound with a major, and writes the packageManager integrity it was given', () => {
		const node = planRuntimeEdits(files, declarations, [{ name: 'node', version: '28.1.0' }], { major: true })
		assert.match(edited(node)['package.json'], /"node": ">=28\.1\.0 <29"/)
		assert.match(edited(node).Dockerfile, /FROM node:28\.1\.0-alpine AS b/)

		const hashes = new Map([['pnpm@11.28.8', '+sha512.ff']])
		const pnpm = planRuntimeEdits(files, declarations, [{ name: 'pnpm', version: '11.28.8' }], { hashes })
		assert.match(edited(pnpm)['package.json'], /"packageManager": "pnpm@11\.28\.8\+sha512\.ff"/)
		const bare = planRuntimeEdits(files, declarations, [{ name: 'pnpm', version: '11.28.8' }])
		assert.match(edited(bare)['package.json'], /"packageManager": "pnpm@11\.28\.8"/)
	})

	it('leaves another major alone without --major, and tells already-there from not declared', () => {
		const at = planRuntimeEdits(
			[{ path: 'mise.toml', text: '[tools]\nnode = "26.12.1"\n' }],
			findRuntimeDeclarations([{ path: 'mise.toml', text: '[tools]\nnode = "26.12.1"\n' }]),
			[
				{ name: 'node', version: '26.12.1' },
				{ name: 'npm', version: '11.0.0' },
				{ name: 'node', version: '28.1.0' },
			],
		)
		assert.deepEqual(at.edits, [])
		assert.deepEqual(at.already, [{ name: 'node', version: '26.12.1' }])
		assert.deepEqual(at.lost, [
			{ name: 'npm', version: '11.0.0' },
			{ name: 'node', version: '28.1.0' },
		])
	})
})

describe('corepackHash and findRuntimeDowngrades', () => {
	it('writes the registry integrity as the hex corepack expects', () => {
		assert.equal(corepackHash(`sha512-${Buffer.from([0xab, 0xcd]).toString('base64')}`), '+sha512.abcd')
		assert.equal(corepackHash(undefined), '')
	})

	it('names an exact declaration that went down, matched by file and order', () => {
		const before = findRuntimeDeclarations([{ path: 'mise.toml', text: '[tools]\nnode = "26.12.1"\n' }])
		const up = findRuntimeDeclarations([{ path: 'mise.toml', text: '# moved\n[tools]\nnode = "26.13.0"\n' }])
		const down = findRuntimeDeclarations([{ path: 'mise.toml', text: '[tools]\nnode = "26.7.0"\n' }])
		assert.deepEqual(findRuntimeDowngrades(before, up), [])
		assert.deepEqual(findRuntimeDowngrades(before, down), [
			{ file: 'mise.toml', family: 'node', before: '26.12.1', after: '26.7.0' },
		])
	})
})

describe('fetchJson', () => {
	it('fails the scan, never reports nothing, when a source does not answer', async () => {
		const down = async () => {
			throw new Error('ECONNREFUSED')
		}
		await assert.rejects(
			fetchJson('https://nodejs.org/dist/index.json', "nodejs.org's release index", {
				fetchFn: down,
				wait: async () => undefined,
			}),
			error => error instanceof ScanError && /release index did not answer/.test(error.message),
		)
	})
})

describe('the runtime commands, run in a repository', () => {
	const script = join(dirname(fileURLToPath(import.meta.url)), 'os-deps.mjs')
	let dir = ''
	const git = (...args) =>
		execFileSync('git', ['-c', 'user.email=os@example.com', '-c', 'user.name=OS', ...args], {
			cwd: dir,
			encoding: 'utf8',
		}).trim()
	const run = (args, env = {}) =>
		spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } })

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'os-deps-runtime-'))
		writeFileSync(join(dir, 'package.json'), '{\n  "name": "app"\n}\n')
		writeFileSync(
			join(dir, 'package-lock.json'),
			JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'app' } } }),
		)
		writeFileSync(join(dir, 'mise.toml'), '[tools]\nnode = "26.7.0"\n')
		writeFileSync(join(dir, 'Dockerfile'), 'FROM node:26-alpine\n')
		git('init', '-q', '-b', 'main')
		git('add', '-A')
		git('commit', '-q', '-m', 'base')
	})

	afterEach(() => rmSync(dir, { recursive: true, force: true }))

	it('exits 2 as scan_failed when nodejs.org does not answer', () => {
		const done = run(['report'], {
			OS_DEPS_NODE_INDEX_URL: 'http://127.0.0.1:9/index.json',
			npm_config_registry: 'http://127.0.0.1:9/',
		})
		assert.equal(done.status, 2, done.stdout)
		assert.match(done.stderr, /scan_failed: nodejs\.org's release index did not answer/)
	})

	it('applies a node move to every declaration with no install, and verify names a runtime downgrade', () => {
		const applied = run(['apply', 'node@26.12.1'])
		assert.equal(applied.status, 0, applied.stderr)
		assert.equal(readFileSync(join(dir, 'mise.toml'), 'utf8'), '[tools]\nnode = "26.12.1"\n')
		assert.equal(readFileSync(join(dir, 'Dockerfile'), 'utf8'), 'FROM node:26.12.1-alpine\n')
		assert.equal(run(['verify'], { OS_BASE_REF: 'main' }).status, 0)

		writeFileSync(join(dir, 'mise.toml'), '[tools]\nnode = "26.1.0"\n')
		const down = run(['verify'], { OS_BASE_REF: 'main' })
		assert.equal(down.status, 1)
		assert.match(down.stderr, /downgrade: mise\.toml: node 26\.7\.0 -> 26\.1\.0/)
	})

	it('refuses a runtime nothing declares, changing no file', () => {
		const done = run(['apply', 'pnpm@11.28.8'])
		assert.equal(done.status, 1)
		assert.match(done.stderr, /nothing declares a lower version to move for: pnpm@11\.28\.8/)
		assert.equal(readFileSync(join(dir, 'mise.toml'), 'utf8'), '[tools]\nnode = "26.7.0"\n')
	})
})
