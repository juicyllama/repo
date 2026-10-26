#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noConsole: a command line tool: its report and its errors are what it prints
// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: read at run time in a repository this package does not build
/**
 * The `os:deps`, `os:deps:apply` and `os:deps:verify` repo commands (Zero Human OS, docs/tools/workspaces): what is
 * out of date, how a bump is applied, and whether anything resolved lower than before. A repository wires them up in
 * its `mise.toml` (see deps/README.md); the tasks that call them name no package manager.
 *
 *   os-deps report                    markdown: updates to apply, majors, and what could not be decided
 *   os-deps apply [--major] <name@version>...   node@, pnpm@ and npm@ move every declaration of that runtime
 *   os-deps verify                    nothing resolves lower than on the commit the branch forked from
 *
 * Everything that decides a version is here, in code a test holds, and not in a task's skill: a model copies the
 * report into an issue and runs the apply lines as printed. The scan reads the lockfile and the registry, never
 * `node_modules`, so it sees the same thing on any machine, and it reads them per workspace package, because two
 * apps can hold one dependency at different majors. pnpm (`pnpm-lock.yaml`) and npm (`package-lock.json`, lockfile
 * version 2 or 3, no workspaces) are supported; a repository has exactly one of them.
 *
 * Node.js and the package manager are dependencies too (deps/runtime.mjs): every place the repository declares them,
 * read from its tracked files, with Node's releases from nodejs.org and pnpm's and npm's from the registry.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
	buildRuntimeReport,
	corepackHash,
	findRuntimeDeclarations,
	findRuntimeDowngrades,
	isRuntimeFile,
	NODE_INDEX_URL,
	NODE_SCHEDULE_URL,
	parseNodeIndex,
	parseNodeSchedule,
	planRuntimeEdits,
	RUNTIME_FAMILIES,
} from './runtime.mjs'

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies']
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'
const DAY_MS = 24 * 60 * 60 * 1000

/** A target younger than this is not offered yet: a bad release is usually pulled or patched within days. */
export const DEFAULT_MIN_AGE_DAYS = 3

/** Under the 32,000 characters a run is shown of one tool result, with room for the command's own framing. */
export const REPORT_LIMIT = 28000

const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical']

/** The scan could not be completed. Never the same as "nothing to update": the command exits 2. */
export class ScanError extends Error {}

/** `1.2.3`, `v1.2.3` or `1.2.3-beta.1` as numbers, or null when it is not a version that can be compared. */
export function parseVersion(value) {
	const match = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.exec(String(value).trim())
	if (!match) {
		return null
	}
	return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: Boolean(match[4]) }
}

/** -1, 0 or 1, or null when either side cannot be compared. A prerelease sorts below its own release. */
export function compareVersions(left, right) {
	const a = parseVersion(left)
	const b = parseVersion(right)
	if (!a || !b) {
		return null
	}
	for (let at = 0; at < 3; at += 1) {
		if (a.parts[at] !== b.parts[at]) {
			return a.parts[at] < b.parts[at] ? -1 : 1
		}
	}
	if (a.prerelease === b.prerelease) {
		return 0
	}
	return a.prerelease ? -1 : 1
}

function majorOf(version) {
	return parseVersion(version)?.parts[0] ?? null
}

/** What moving `current` to `target` is: `patch`, `minor`, `major`, `none`, `downgrade` or `unknown`. */
export function bumpLevel(current, target) {
	const order = compareVersions(current, target)
	if (order === null) {
		return 'unknown'
	}
	if (order === 0) {
		return 'none'
	}
	if (order > 0) {
		return 'downgrade'
	}
	const from = parseVersion(current).parts
	const to = parseVersion(target).parts
	if (from[0] !== to[0]) {
		return 'major'
	}
	return from[1] === to[1] ? 'patch' : 'minor'
}

function unquote(value) {
	return value.trim().replace(/^['"]|['"]$/g, '')
}

/** A dependency the registry does not serve: another workspace package, a path, a git remote or an alias. */
function isLocalSpecifier(specifier) {
	return /^(workspace:|link:|file:|npm:|git|github:|https?:)/.test(specifier)
}

/**
 * Every direct dependency in the lockfile's `importers`, one row per workspace package that declares it:
 * `{ importer, name, specifier, version }`, with the peer suffix dropped from the version. Read as lines, not as
 * YAML, so the script needs no install to run; the block is regular in lockfile versions 6 and 9.
 */
export function lockfileImporters(text) {
	const rows = []
	const at = { importer: null, section: null, name: null, specifier: null }
	for (const line of importersBlock(text)) {
		const key = /^( {2}| {4}| {6})(\S.*):$/.exec(line)
		if (key) {
			openKey(at, key[1].length, key[2])
			continue
		}
		const field = /^ {8}(specifier|version): (.+)$/.exec(line)
		if (!field || !at.section || !at.name) {
			continue
		}
		if (field[1] === 'specifier') {
			at.specifier = unquote(field[2])
			continue
		}
		const version = unquote(field[2]).replace(/\(.*$/, '')
		if (at.specifier !== null && !isLocalSpecifier(at.specifier) && parseVersion(version)) {
			rows.push({ importer: at.importer, name: at.name, specifier: at.specifier, version })
		}
	}
	return rows
}

/** The lines of the lockfile's `importers:` block, which runs to the next top-level key. */
function importersBlock(text) {
	const lines = text.split(/\r?\n/)
	const start = lines.findIndex(line => line.startsWith('importers:'))
	if (start === -1) {
		return []
	}
	const rest = lines.slice(start + 1)
	const end = rest.findIndex(line => /^\S/.test(line))
	return end === -1 ? rest : rest.slice(0, end)
}

/** Moves the cursor to the key a line opens: a workspace package, one of its blocks, or a dependency in a block. */
function openKey(at, depth, key) {
	if (depth === 2) {
		at.importer = unquote(key)
		at.section = null
	} else if (depth === 4) {
		at.section = DEP_SECTIONS.includes(key) ? key : null
	} else {
		at.name = unquote(key)
		at.specifier = null
	}
}

/** The parts of a registry document the scan uses. The whole thing runs to tens of megabytes for some packages. */
export function slimPackument(doc) {
	const versions = {}
	for (const [version, meta] of Object.entries(doc.versions ?? {})) {
		versions[version] = { deprecated: Boolean(meta?.deprecated), time: doc.time?.[version] ?? null }
	}
	const repository = typeof doc.repository === 'string' ? doc.repository : doc.repository?.url
	return {
		latest: doc['dist-tags']?.latest ?? null,
		versions,
		repository: repository ?? null,
		homepage: doc.homepage ?? null,
	}
}

/** Where a person reads what changed: the repository's releases when it is on GitHub, else whatever it names. */
export function notesUrl(name, packument) {
	const raw = packument.repository
	if (raw) {
		const url = raw
			.replace(/^git\+/, '')
			.replace(/^git:\/\//, 'https://')
			.replace(/^ssh:\/\/git@/, 'https://')
			.replace(/^git@([^:]+):/, 'https://$1/')
			.replace(/\.git$/, '')
		if (/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(url)) {
			return `${url}/releases`
		}
		if (url.startsWith('https://')) {
			return url
		}
	}
	return packument.homepage ?? `https://www.npmjs.com/package/${name}?activeTab=versions`
}

function highest(versions) {
	return versions.reduce(
		(best, version) => (best === null || compareVersions(version, best) > 0 ? version : best),
		null,
	)
}

/**
 * What one dependency may move to: `{ inMajor, major }`, each a version or null, or `{ held }` with the reason
 * nothing can be decided. Only stable, undeprecated releases at or below the registry's `latest` are considered,
 * and only once they are `minAgeMs` old. `waiveAge` drops that wait inside the current major, for a package an
 * audit names: a fix should not sit out a cooldown. A major always waits.
 */
export function pickTargets({ current, packument, now, minAgeMs, waiveAge = false }) {
	if (!parseVersion(current)) {
		return { held: 'the current version is not comparable' }
	}
	const latest = packument.latest
	if (!latest || !parseVersion(latest)) {
		return { held: 'the registry names no comparable latest version' }
	}
	if (compareVersions(latest, current) < 0) {
		return { held: `latest (${latest}) is lower than the current version` }
	}
	const oldEnough = version => {
		const released = Date.parse(packument.versions[version]?.time ?? '')
		return Number.isFinite(released) && now - released >= minAgeMs
	}
	const stable = Object.keys(packument.versions).filter(version => {
		const parsed = parseVersion(version)
		return (
			parsed &&
			!parsed.prerelease &&
			!packument.versions[version].deprecated &&
			compareVersions(version, latest) <= 0
		)
	})
	const currentMajor = majorOf(current)
	const latestMajor = majorOf(latest)
	const inMajor = highest(
		stable.filter(
			version =>
				majorOf(version) === currentMajor &&
				compareVersions(version, current) > 0 &&
				(waiveAge || oldEnough(version)),
		),
	)
	const major =
		latestMajor > currentMajor
			? highest(stable.filter(version => majorOf(version) === latestMajor && oldEnough(version)))
			: null
	return { inMajor, major }
}

/** Package name to its worst advisory severity, from either shape `audit --json` comes in. Unreadable gives none. */
export function parseAudit(raw) {
	const worst = new Map()
	const note = (name, severity) => {
		if (typeof name !== 'string' || !SEVERITIES.includes(severity)) {
			return
		}
		if (SEVERITIES.indexOf(severity) > SEVERITIES.indexOf(worst.get(name) ?? 'info') || !worst.has(name)) {
			worst.set(name, severity)
		}
	}
	let data
	try {
		data = JSON.parse(raw)
	} catch {
		return worst
	}
	for (const advisory of Object.values(data?.advisories ?? {})) {
		note(advisory?.module_name, advisory?.severity)
	}
	for (const [name, value] of Object.entries(data?.vulnerabilities ?? {})) {
		note(name, value?.severity)
	}
	return worst
}

/** Lockfile rows that share a package and a resolved version are one decision, whoever declares them. */
function groupByVersion(rows) {
	const groups = new Map()
	for (const row of rows) {
		const key = `${row.name}@${row.version}`
		const group = groups.get(key) ?? { name: row.name, current: row.version, importers: [] }
		group.importers.push(row.importer)
		groups.set(key, group)
	}
	return [...groups.values()]
}

/**
 * Majors that move together are one piece of work: packages under one scope going from the same major to the
 * same major (a framework's own packages). `@types/*` is a scope of unrelated packages, so each stands alone.
 */
function majorFamilies(members) {
	const byKey = new Map()
	for (const member of members) {
		const scope =
			member.name.startsWith('@') && !member.name.startsWith('@types/') ? member.name.split('/')[0] : null
		const from = majorOf(member.current)
		const to = majorOf(member.target)
		const key = `${scope ?? member.name}|${from}|${to}`
		const family = byKey.get(key) ?? { scope, from, to, packages: [] }
		family.packages.push(member)
		byKey.set(key, family)
	}
	return [...byKey.values()]
		.map(family => {
			const names = [...new Set(family.packages.map(member => member.name))]
			const label = family.scope && names.length > 1 ? `${family.scope}/*` : names[0]
			const released =
				family.packages
					.map(member => member.released)
					.filter(Boolean)
					.sort()[0] ?? null
			return {
				title: `Major upgrade: ${label} ${family.from} to ${family.to}`,
				released,
				packages: family.packages,
			}
		})
		.sort((a, b) => String(a.released).localeCompare(String(b.released)) || a.title.localeCompare(b.title))
}

/** An advisory's severity, or `high` for a security fix named another way (a Node security release). */
function severityRank(severity) {
	if (!severity) {
		return -1
	}
	return SEVERITIES.includes(severity) ? SEVERITIES.indexOf(severity) : SEVERITIES.indexOf('high')
}

/**
 * The whole decision, from lockfile rows and registry documents: `updates` (patch and minor inside the current
 * major, worst advisory first), `majors` (families, oldest release first) and `held` (what could not be decided,
 * each with its reason). `packuments` maps a name to its slim document, or to null when the registry has none.
 */
export function buildReport(rows, packuments, audit, { now, minAgeDays = DEFAULT_MIN_AGE_DAYS }) {
	const updates = []
	const members = []
	const held = []
	for (const group of groupByVersion(rows)) {
		const packument = packuments.get(group.name)
		if (!packument) {
			held.push({ name: group.name, current: group.current, reason: 'the registry does not have this package' })
			continue
		}
		if (packument.held) {
			held.push({ name: group.name, current: group.current, reason: packument.held })
			continue
		}
		const security = audit.get(group.name) ?? null
		const picked = pickTargets({
			current: group.current,
			packument,
			now,
			minAgeMs: minAgeDays * DAY_MS,
			waiveAge: Boolean(security),
		})
		if (picked.held) {
			held.push({ name: group.name, current: group.current, reason: picked.held })
			continue
		}
		if (picked.inMajor) {
			const level = bumpLevel(group.current, picked.inMajor)
			updates.push({
				name: group.name,
				current: group.current,
				target: picked.inMajor,
				level,
				security,
				zeroMinor: level === 'minor' && majorOf(group.current) === 0,
			})
		}
		if (picked.major) {
			members.push({
				name: group.name,
				current: group.current,
				target: picked.major,
				released: packument.versions[picked.major]?.time?.slice(0, 10) ?? null,
				notes: notesUrl(group.name, packument),
				importers: group.importers,
			})
		}
	}
	updates.sort(
		(a, b) =>
			severityRank(b.security) - severityRank(a.security) ||
			a.name.localeCompare(b.name) ||
			compareVersions(a.current, b.current),
	)
	held.sort((a, b) => a.name.localeCompare(b.name))
	return { updates, majors: majorFamilies(members), held }
}

/** The package report and the runtime report as one, in the same orders buildReport gives. */
export function mergeReports(packages, runtime) {
	const updates = [...runtime.updates, ...packages.updates].sort(
		(a, b) =>
			severityRank(b.security) - severityRank(a.security) ||
			a.name.localeCompare(b.name) ||
			String(a.current).localeCompare(String(b.current)),
	)
	const majors = [...packages.majors, ...runtime.majors].sort(
		(a, b) => String(a.released).localeCompare(String(b.released)) || a.title.localeCompare(b.title),
	)
	const held = [...packages.held, ...runtime.held].sort((a, b) => a.name.localeCompare(b.name))
	return { updates, majors, held }
}

function pairsOf(rows) {
	return [...new Set(rows.map(row => `${row.name}@${row.target}`))].join(' ')
}

/**
 * The apply lines, in the order a bump is made: advisories, then patches, then minors, then floating runtime
 * declarations pinned to an exact release, each its own command.
 */
function applySteps(updates) {
	const groups = [
		['Security', updates.filter(row => row.security)],
		['Patch', updates.filter(row => !row.security && row.level === 'patch')],
		['Minor', updates.filter(row => !row.security && row.level === 'minor')],
		['Pin', updates.filter(row => !row.security && row.level === 'pin')],
	]
	// A pair an earlier group already moves is left out of a later one: one apply of `node@26.12.1` moves every
	// declaration on that major, the exact ones and the floating ones.
	const taken = new Set()
	return groups
		.map(([label, rows]) => [label, rows.filter(row => !taken.has(`${row.name}@${row.target}`))])
		.filter(([, rows]) => rows.length > 0)
		.map(([label, rows]) => {
			for (const row of rows) {
				taken.add(`${row.name}@${row.target}`)
			}
			return `${label}: \`mise run os:deps:apply ${pairsOf(rows)}\``
		})
}

function noteOf(row) {
	return [row.zeroMinor ? '0.x minor: may break' : '', row.note ?? ''].filter(Boolean).join('; ')
}

function updatesSection(updates, leftOut) {
	if (updates.length === 0) {
		const none =
			leftOut > 0 ? `${leftOut} update(s) did not fit this report and are left for the next refresh.` : 'None.'
		return ['## Updates to apply', '', none]
	}
	const lines = [
		'## Updates to apply',
		'',
		'| Package | Current | Target | Level | Security | Note |',
		'| --- | --- | --- | --- | --- | --- |',
		...updates.map(
			row =>
				`| \`${row.name}\` | ${row.current} | ${row.target} | ${row.level} | ${row.security ?? ''} | ${noteOf(row)} |`,
		),
		'',
		'Apply in this order, running the checks after each group:',
		'',
		...applySteps(updates).map((step, at) => `${at + 1}. ${step}`),
	]
	if (leftOut > 0) {
		lines.push('', `${leftOut} more update(s) did not fit this report and are left for the next refresh.`)
	}
	return lines
}

function majorsSection(majors, leftOut) {
	if (majors.length === 0 && leftOut === 0) {
		return ['## Majors', '', 'None.']
	}
	const lines = ['## Majors']
	for (const family of majors) {
		lines.push('', `### ${family.title}`, '')
		if (family.security) {
			lines.push(family.security)
		}
		for (const member of family.packages) {
			const where = [...new Set(member.importers)].join(', ')
			lines.push(
				`- \`${member.name}\` ${member.current} to ${member.target} (released ${member.released ?? 'unknown'}), declared in ${where}`,
			)
		}
		for (const notes of new Set(family.packages.map(member => member.notes))) {
			lines.push(`- Release notes: ${notes}`)
		}
		lines.push(`- Apply: \`mise run os:deps:apply --major ${pairsOf(family.packages)}\``)
	}
	if (leftOut > 0) {
		lines.push('', `${leftOut} more major(s) did not fit this report.`)
	}
	return lines
}

function heldSection(held) {
	if (held.length === 0) {
		return []
	}
	return ['', '## Held back', '', ...held.map(row => `- \`${row.name}\` ${row.current}: ${row.reason}`)]
}

/**
 * The report as the markdown a refresh task copies into its issues. The first line is the count a task reads to
 * decide whether there is anything to do. When the text would pass `limit`, whole rows are dropped and counted:
 * updates first, from the least urgent, because a dropped update only waits a week, while a major that is never
 * printed can sit unseen behind ones already decided.
 */
export function renderReport(
	report,
	{ audit = 'ok', minAgeDays = DEFAULT_MIN_AGE_DAYS, limit = REPORT_LIMIT, manager = 'pnpm' } = {},
) {
	const security =
		report.updates.filter(row => row.security).length + report.majors.filter(family => family.security).length
	const head = [
		`updates: ${report.updates.length} security: ${security} majors: ${report.majors.length} held: ${report.held.length}`,
		`package manager: ${manager}, cooldown: ${minAgeDays} day(s), audit: ${audit}`,
		'',
	]
	const render = (shownUpdates, shownMajors) =>
		[
			...head,
			...updatesSection(report.updates.slice(0, shownUpdates), report.updates.length - shownUpdates),
			'',
			...majorsSection(report.majors.slice(0, shownMajors), report.majors.length - shownMajors),
			...heldSection(report.held),
		].join('\n')
	let updates = report.updates.length
	let majors = report.majors.length
	let text = render(updates, majors)
	while (text.length > limit && updates + majors > 0) {
		if (updates > 0) {
			updates -= 1
		} else {
			majors -= 1
		}
		text = render(updates, majors)
	}
	return `${text}\n`
}

/** `name@version` arguments as pairs. Anything else is a typo the command refuses before touching a file. */
export function parsePairs(args) {
	return args.map(arg => {
		const match = /^(@?[^@\s]+)@(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)$/.exec(arg)
		if (!match) {
			throw new Error(`not a name@version pair: ${arg}`)
		}
		return { name: match[1], version: match[2] }
	})
}

/** The lowest version a declared range allows, and the operator in front of it: `^1.2`, `~1.2.3`, `1.2.3`. */
function declaredRange(spec) {
	const match = /^(\^|~)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(spec.trim())
	if (!match) {
		return null
	}
	return { operator: match[1] ?? '', floor: `${match[2]}.${match[3] ?? 0}.${match[4] ?? 0}` }
}

/**
 * One manifest with the pairs applied: `{ text, changed }`. A declaration moves only when its range starts below
 * the target and, unless `major` is set, in the target's own major: so a patch for the apps on one major leaves
 * an app on an older major where it is. The range operator is kept, and so is the file's indentation.
 */
export function applyPairs(text, pairs, { major = false, exact = false } = {}) {
	const data = JSON.parse(text)
	const changed = []
	for (const section of DEP_SECTIONS) {
		for (const pair of pairs) {
			const from = data[section]?.[pair.name]
			const to = movedRange(from, pair.version, major, exact)
			if (to !== null) {
				data[section][pair.name] = to
				changed.push({ name: pair.name, section, from, to, version: pair.version })
			}
		}
	}
	const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '  '
	return { text: `${JSON.stringify(data, null, indent)}${text.endsWith('\n') ? '\n' : ''}`, changed }
}

/** What a declared range becomes for a target, or null when it stays as it is. */
function movedRange(spec, version, major, exact) {
	const range = typeof spec === 'string' ? declaredRange(spec) : null
	if (!range || compareVersions(range.floor, version) >= 0) {
		return null
	}
	if (!major && majorOf(range.floor) !== majorOf(version)) {
		return null
	}
	return exact ? version : `${range.operator}${version}`
}

/**
 * The declarations an apply moved whose lockfile row did not land on the version it was moved to, as lines to print.
 * Each change carries its own target: one package can be in a single apply twice, once for each major it is held at
 * (`@types/node` at 22 and at 24), so a target looked up by name would blame the first for the second's version.
 */
export function offTarget(edits, lockRows) {
	const resolved = new Map(lockRows.map(row => [`${row.importer}\n${row.name}`, row.version]))
	return edits.flatMap(edit =>
		edit.changed
			.filter(change => resolved.get(`${edit.importer}\n${change.name}`) !== change.version)
			.map(
				change =>
					`${edit.importer}: ${change.name} resolved ${resolved.get(`${edit.importer}\n${change.name}`)}, not ${change.version}`,
			),
	)
}

/** Direct dependencies that resolve lower in `after` than in `before`, per workspace package that declares them. */
export function findDowngrades(before, after) {
	const resolved = new Map(after.map(row => [`${row.importer}\n${row.name}`, row.version]))
	const downgrades = []
	for (const row of before) {
		const now = resolved.get(`${row.importer}\n${row.name}`)
		if (now && compareVersions(now, row.version) < 0) {
			downgrades.push({ importer: row.importer, name: row.name, before: row.version, after: now })
		}
	}
	return downgrades
}

/**
 * Direct dependencies of an npm project, from its package.json and its package-lock.json (lockfile version 2 or 3):
 * the same rows `lockfileImporters` gives for pnpm, with the one importer `.`. A dependency the lockfile does not
 * resolve (an optional one this platform skipped) has no row. Workspaces are refused by name: each would be its own
 * importer, and nothing here has been tried against one.
 */
export function npmImporters({ packageJson, lock }) {
	const manifest = JSON.parse(packageJson)
	if (manifest.workspaces) {
		throw new ScanError('package.json declares npm workspaces, which this scan does not read yet')
	}
	const data = JSON.parse(lock)
	if (!data.packages) {
		throw new ScanError(
			'package-lock.json is lockfile version 1, which names no resolved version per package: npm 7 or later writes version 2 or 3',
		)
	}
	const rows = []
	for (const section of DEP_SECTIONS) {
		for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
			const version = data.packages[`node_modules/${name}`]?.version ?? ''
			if (!isLocalSpecifier(specifier) && parseVersion(version)) {
				rows.push({ importer: '.', name, specifier, version })
			}
		}
	}
	return rows
}

/** `<pm> config get <key>` in `root`, or '' when it is unset or the command is not there. */
function configValue(pm, root, key) {
	const asked = spawnSync(pm, ['config', 'get', key], { cwd: root, encoding: 'utf8' })
	const value = asked.status === 0 ? asked.stdout.trim() : ''
	return /^https?:\/\//.test(value) ? value.replace(/\/?$/, '/') : ''
}

/** Runs `command` in `root`, with its output on ours. A non-zero exit is an error saying what was left changed. */
function runInstall(command, args, root, env, left) {
	const run = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } })
	if (run.status !== 0) {
		throw new Error(`${command} ${args.join(' ')} failed (exit ${run.status}): ${left}`)
	}
}

/**
 * One driver per package manager: where its lockfile is, how its direct dependencies are read from the texts of the
 * lockfile and package.json (`texts`, so the same function reads a past commit's), which registry it is set to, the
 * advisory audit, and how a changed manifest becomes a lockfile and an install.
 */
const DRIVERS = [
	{
		name: 'pnpm',
		lockfile: 'pnpm-lock.yaml',
		rows(texts) {
			const rows = lockfileImporters(texts.lock)
			if (rows.length === 0) {
				throw new ScanError(
					'pnpm-lock.yaml lists no direct dependency under importers: its format is not one this scan reads',
				)
			}
			return rows
		},
		registry: (root, scope) => configValue('pnpm', root, scope ? `${scope}:registry` : 'registry'),
		auditCommand: ['pnpm', ['audit', '--json']],
		install(root, write) {
			write('text')
			// `lowest-direct` resolves a changed range to the version it names, not to whatever was published since.
			runInstall(
				'pnpm',
				['install', '--no-frozen-lockfile'],
				root,
				{ npm_config_resolution_mode: 'lowest-direct' },
				'the install did not complete',
			)
		},
	},
	{
		name: 'npm',
		lockfile: 'package-lock.json',
		rows: texts => npmImporters(texts),
		registry: (root, scope) => configValue('npm', root, scope ? `${scope}:registry` : 'registry'),
		auditCommand: ['npm', ['audit', '--json']],
		install(root, write) {
			// npm has no way to resolve a range to its lowest version. So the manifests are written with the exact
			// targets first, which installs exactly those; then with the ranges they keep (`^1.2.3`), where the
			// lockfile's rows still satisfy them, so a second, lockfile-only install changes no version.
			const flags = ['--ignore-scripts', '--no-audit', '--no-fund']
			write('pinned')
			runInstall('npm', ['install', ...flags], root, {}, 'the install did not complete')
			write('text')
			runInstall(
				'npm',
				['install', '--package-lock-only', ...flags],
				root,
				{},
				'the lockfile-only install did not complete',
			)
		},
	},
]

function detectDriver(root) {
	const found = DRIVERS.filter(driver => existsSync(join(root, driver.lockfile)))
	if (found.length === 0) {
		throw new ScanError(
			'no supported lockfile: expected pnpm-lock.yaml or package-lock.json at the repository root',
		)
	}
	if (found.length > 1) {
		throw new ScanError(
			`${found.map(driver => driver.lockfile).join(' and ')} both exist: one package manager per repository`,
		)
	}
	return found[0]
}

function readText(path) {
	return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/** The direct dependencies on disk now. */
function readRows(driver, root) {
	return driver.rows({
		lock: readText(join(root, driver.lockfile)),
		packageJson: readText(join(root, 'package.json')),
	})
}

/** The registry a package comes from: its scope's own when one is set, else the default, else the public one. */
function registryResolver(driver, root) {
	const fallback = driver.registry(root) || DEFAULT_REGISTRY
	const scoped = new Map()
	return name => {
		const scope = name.startsWith('@') ? name.split('/')[0] : ''
		if (!scope) {
			return fallback
		}
		if (!scoped.has(scope)) {
			scoped.set(scope, driver.registry(root, scope) || fallback)
		}
		return scoped.get(scope)
	}
}

const sleep = ms => new Promise(done => setTimeout(done, ms))

/**
 * One registry document, slimmed, or null when the registry has no such package, or `{ held }` when it wants
 * credentials this scan does not have. Anything else fails the scan, after a few tries a little apart: a rate limit
 * or a registry that is down does not recover in a millisecond.
 */
export async function fetchPackument(registry, name, attempts = 3, { fetchFn = fetch, wait = sleep } = {}) {
	const url = `${registry}${name.replace('/', '%2f')}`
	let last = ''
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (attempt > 0) {
			await wait(500 * 2 ** attempt)
		}
		try {
			const response = await fetchFn(url, { headers: { accept: 'application/json' } })
			if (response.status === 404) {
				return null
			}
			// The registry is read without credentials. A package that needs one is held back with that reason, not
			// guessed at, and does not stop the scan of every other dependency.
			if (response.status === 401 || response.status === 403) {
				return { held: `the registry needs credentials for this package (HTTP ${response.status})` }
			}
			if (response.ok) {
				return slimPackument(await response.json())
			}
			last = `HTTP ${response.status}`
		} catch (error) {
			last = error instanceof Error ? error.message : String(error)
		}
	}
	throw new ScanError(`the registry did not answer for ${name} (${last})`)
}

async function fetchPackuments(registryFor, names, concurrency = 8) {
	const packuments = new Map()
	const queue = [...names]
	const worker = async () => {
		while (queue.length > 0) {
			const name = queue.shift()
			packuments.set(name, await fetchPackument(registryFor(name), name))
		}
	}
	await Promise.all(Array.from({ length: concurrency }, worker))
	return packuments
}

/** A JSON document from `url`, after a few tries a little apart, or a ScanError naming what it was for. */
export async function fetchJson(url, what, { attempts = 3, fetchFn = fetch, wait = sleep, init = {} } = {}) {
	let last = ''
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (attempt > 0) {
			await wait(500 * 2 ** attempt)
		}
		try {
			const response = await fetchFn(url, { headers: { accept: 'application/json' }, ...init })
			if (response.ok) {
				return await response.json()
			}
			last = `HTTP ${response.status}`
		} catch (error) {
			last = error instanceof Error ? error.message : String(error)
		}
	}
	throw new ScanError(`${what} did not answer (${url}: ${last})`)
}

/** The tracked files that can declare a runtime, with their texts: `git ls-files`, else a walk without node_modules. */
function readRuntimeFiles(root) {
	const listed = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
	const paths =
		listed.status === 0
			? listed.stdout.split('\0').filter(Boolean)
			: walk(root, '').filter(path => !path.startsWith('.git/'))
	return paths
		.filter(isRuntimeFile)
		.filter(path => existsSync(join(root, path)))
		.map(path => ({ path, text: readFileSync(join(root, path), 'utf8') }))
}

function walk(root, at) {
	const found = []
	for (const entry of readdirSync(join(root, at), { withFileTypes: true })) {
		const path = at ? `${at}/${entry.name}` : entry.name
		if (entry.isDirectory()) {
			if (entry.name !== 'node_modules' && entry.name !== '.git') {
				found.push(...walk(root, path))
			}
		} else {
			found.push(path)
		}
	}
	return found
}

/**
 * Advisories for pnpm and npm, which no lockfile lists, from the registry's bulk advisory endpoint: name to
 * `[{ title, url, severity, vulnerable_versions }]`, or null when the registry did not answer (said in the report,
 * never passed off as clean).
 */
async function fetchRuntimeAdvisories(registry, versionsByName, fetchFn = fetch) {
	if (versionsByName.size === 0) {
		return new Map()
	}
	try {
		const body = JSON.stringify(Object.fromEntries(versionsByName))
		const data = await fetchJson(`${registry}-/npm/v1/security/advisories/bulk`, 'the advisory endpoint', {
			fetchFn,
			init: { method: 'POST', body, headers: { accept: 'application/json', 'content-type': 'application/json' } },
		})
		return new Map(Object.entries(data ?? {}).map(([name, list]) => [name, Array.isArray(list) ? list : []]))
	} catch {
		return null
	}
}

/**
 * What the runtime half of the report reads, fetched only for the families the repository declares: node's
 * releases and end-of-life dates, and the registry documents and advisories for pnpm and npm.
 */
async function runtimeSources(declarations, registryFor) {
	const families = new Set(declarations.filter(entry => !entry.held).map(entry => entry.family))
	const sources = { nodeReleases: null, nodeEnds: new Map(), packuments: new Map(), advisories: new Map(), note: '' }
	if (families.has('node')) {
		// A mirror can stand in for either document, for a network that cannot reach them.
		const indexUrl = process.env.OS_DEPS_NODE_INDEX_URL || NODE_INDEX_URL
		const scheduleUrl = process.env.OS_DEPS_NODE_SCHEDULE_URL || NODE_SCHEDULE_URL
		const index = parseNodeIndex(await fetchJson(indexUrl, "nodejs.org's release index"))
		if (!index) {
			throw new ScanError(`nodejs.org's release index is not the list it should be (${indexUrl})`)
		}
		sources.nodeReleases = index
		sources.nodeEnds = parseNodeSchedule(await fetchJson(scheduleUrl, "Node's release schedule"))
	}
	const managers = RUNTIME_FAMILIES.filter(family => family !== 'node' && families.has(family))
	for (const name of managers) {
		sources.packuments.set(name, await fetchPackument(registryFor(name), name))
	}
	const versions = new Map(
		managers
			.filter(name => sources.packuments.get(name) && !sources.packuments.get(name).held)
			.map(name => [name, Object.keys(sources.packuments.get(name).versions)]),
	)
	const advisories = await fetchRuntimeAdvisories(registryFor(''), versions)
	sources.advisories = advisories ?? new Map()
	if (managers.length > 0) {
		sources.note = advisories ? ', runtime advisories: ok' : ', runtime advisories: unavailable'
	}
	return sources
}

/** Advisories by package, and how the report describes the audit. A failed audit is said, never passed off as clean. */
function runAudit(driver, root) {
	const [command, args] = driver.auditCommand
	const child = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
	try {
		const data = JSON.parse(child.stdout)
		if (data && typeof data === 'object' && (data.advisories || data.vulnerabilities)) {
			return { audit: parseAudit(child.stdout), note: 'ok' }
		}
	} catch {
		// fall through: the audit did not print a report
	}
	return { audit: new Map(), note: 'unavailable, so no update is marked as a security fix' }
}

function cooldownDays() {
	const raw = process.env.OS_DEPS_MIN_AGE_DAYS
	const days = raw === undefined || raw === '' ? DEFAULT_MIN_AGE_DAYS : Number(raw)
	if (!Number.isFinite(days) || days < 0) {
		throw new ScanError(`OS_DEPS_MIN_AGE_DAYS must be a number of days, not ${raw}`)
	}
	return days
}

async function printReport(root) {
	const driver = detectDriver(root)
	const rows = readRows(driver, root)
	const days = cooldownDays()
	const registryFor = registryResolver(driver, root)
	const packuments = await fetchPackuments(registryFor, new Set(rows.map(row => row.name)))
	const { audit, note } = runAudit(driver, root)
	const now = Date.now()
	const packages = buildReport(rows, packuments, audit, { now, minAgeDays: days })
	const declarations = findRuntimeDeclarations(readRuntimeFiles(root))
	const sources = await runtimeSources(declarations, registryFor)
	const runtime = buildRuntimeReport(declarations, sources, { now, minAgeDays: days })
	process.stdout.write(
		renderReport(mergeReports(packages, runtime), {
			audit: `${note}${sources.note}`,
			minAgeDays: days,
			manager: driver.name,
		}),
	)
}

/**
 * The corepack integrity suffix for each packageManager move that had one, from the registry's document for that
 * version. One it cannot fetch is left off: corepack accepts packageManager without one.
 */
async function packageManagerHashes(driver, root, pairs, declarations) {
	const hashes = new Map()
	let registryFor = null
	for (const pair of pairs) {
		const hashed = declarations.some(
			entry => entry.kind === 'packageManager' && entry.family === pair.name && entry.hash,
		)
		if (!hashed || pair.name === 'node') {
			continue
		}
		registryFor ??= registryResolver(driver, root)
		try {
			const doc = await fetchJson(
				`${registryFor(pair.name)}${pair.name}/${pair.version}`,
				`the registry for ${pair.name}`,
			)
			const hash = corepackHash(doc?.dist?.integrity)
			if (hash) {
				hashes.set(`${pair.name}@${pair.version}`, hash)
			}
		} catch {
			console.log(`no integrity for ${pair.name}@${pair.version}: packageManager is written without one`)
		}
	}
	return hashes
}

/**
 * The manifest edits that move package `pairs`, and the pairs that did not move: `unmoved` holds those the lockfile
 * already resolves (a rerun of a group that landed, not a mistake), `lost` those nothing declares lower.
 */
function planPackageApply(driver, root, pairs, major) {
	const locked = pairs.length > 0 ? readRows(driver, root) : []
	const edits = [...new Set(locked.map(row => row.importer))].map(importer => {
		const path = join(root, importer, 'package.json')
		const text = readFileSync(path, 'utf8')
		const pinned = applyPairs(text, pairs, { major, exact: true }).text
		return { importer, path, original: text, ...applyPairs(text, pairs, { major }), pinned }
	})
	const moved = new Set(edits.flatMap(edit => edit.changed.map(change => change.name)))
	const landed = pair => locked.some(row => row.name === pair.name && row.version === pair.version)
	const unmoved = pairs.filter(pair => !moved.has(pair.name))
	return { edits, moved, unmoved: unmoved.filter(landed), lost: unmoved.filter(pair => !landed(pair)) }
}

/** The runtime file edits that move `pairs` (node, pnpm, npm), as files to write with what they held before. */
async function planRuntimeApply(driver, root, pairs, major) {
	const files = pairs.length > 0 ? readRuntimeFiles(root) : []
	const declarations = findRuntimeDeclarations(files)
	const hashes = await packageManagerHashes(driver, root, pairs, declarations)
	const plan = planRuntimeEdits(files, declarations, pairs, { major, hashes })
	const writes = plan.edits.map(edit => ({ path: join(root, edit.path), text: edit.text, original: edit.original }))
	return { ...plan, writes }
}

function printMoves(runtime, changing) {
	for (const edit of runtime.edits) {
		for (const change of edit.changed) {
			console.log(`${edit.path}:${change.line}: ${change.family} ${change.from} -> ${change.to}`)
		}
	}
	for (const edit of changing) {
		for (const change of edit.changed) {
			console.log(`${edit.importer}: ${change.name} ${change.from} -> ${change.to}`)
		}
	}
}

/**
 * Writes the runtime files and installs the changed manifests. It lands whole or not at all: whatever goes wrong,
 * every file it touched goes back as it was, so a retry starts from the same place and a model is never left to
 * read a half-made change.
 */
function landApply(driver, root, edits, changing, runtimeWrites) {
	const lockPath = join(root, driver.lockfile)
	const before = [
		{ path: lockPath, text: readFileSync(lockPath, 'utf8') },
		...changing.map(edit => ({ path: edit.path, text: edit.original })),
		...runtimeWrites.map(file => ({ path: file.path, text: file.original })),
	]
	try {
		for (const file of runtimeWrites) {
			writeFileSync(file.path, file.text)
		}
		// `text` keeps each declaration's range operator; `pinned` names the exact target (see the npm driver).
		driver.install(root, which => {
			for (const edit of changing) {
				writeFileSync(edit.path, edit[which])
			}
		})
		const off = offTarget(edits, readRows(driver, root))
		if (off.length > 0) {
			throw new Error(`the lockfile did not land on the targets:\n${off.join('\n')}`)
		}
	} catch (error) {
		for (const file of before) {
			writeFileSync(file.path, file.text)
		}
		throw new Error(
			`${error instanceof Error ? error.message : error}\nthe manifests and the lockfile are back as they were`,
			{ cause: error },
		)
	}
}

async function apply(root, args) {
	const major = args.includes('--major')
	const all = parsePairs(args.filter(arg => arg !== '--major'))
	if (all.length === 0) {
		throw new Error('name at least one name@version pair')
	}
	const driver = detectDriver(root)
	// Node, pnpm and npm move in the files that declare them; every other pair moves in the manifests.
	const runtime = await planRuntimeApply(
		driver,
		root,
		all.filter(pair => RUNTIME_FAMILIES.includes(pair.name)),
		major,
	)
	const packages = planPackageApply(
		driver,
		root,
		all.filter(pair => !RUNTIME_FAMILIES.includes(pair.name)),
		major,
	)
	const lost = [...packages.lost, ...runtime.lost].map(pair => `${pair.name}@${pair.version}`)
	if (lost.length > 0) {
		throw new Error(
			`nothing declares a lower version to move for: ${lost.join(' ')}. Each is not declared, or is on another major (a major needs --major). No file was changed.`,
		)
	}
	for (const pair of [...packages.unmoved, ...runtime.already]) {
		console.log(`already at ${pair.name}@${pair.version}`)
	}
	const changing = packages.edits.filter(row => row.changed.length > 0)
	printMoves(runtime, changing)
	if (packages.moved.size === 0) {
		for (const file of runtime.writes) {
			writeFileSync(file.path, file.text)
		}
		return
	}
	landApply(driver, root, packages.edits, changing, runtime.writes)
}

/** What `git` printed for `args` in `root`, or the failure as an Error. */
function git(root, args) {
	const run = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
	if (run.status !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${(run.stderr || run.stdout).trim()}`)
	}
	return run.stdout.trim()
}

/**
 * The commit this branch forked from the default branch: `origin/HEAD`, else `origin/main`, or the ref in
 * OS_BASE_REF. A shallow workspace clone is deepened once when the fork point is beyond what it fetched.
 */
export function mergeBase(root, env = process.env) {
	const attempt = args => {
		try {
			return git(root, args)
		} catch {
			return ''
		}
	}
	const baseRef =
		env.OS_BASE_REF || attempt(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']) || 'origin/main'
	if (!attempt(['rev-parse', '--verify', '--quiet', baseRef])) {
		attempt(['fetch', '--quiet', 'origin', `${baseRef.replace(/^origin\//, '')}:refs/remotes/${baseRef}`])
	}
	const found = attempt(['merge-base', baseRef, 'HEAD'])
	if (found) {
		return found
	}
	if (!attempt(['fetch', '--quiet', '--unshallow', 'origin'])) {
		attempt(['fetch', '--quiet', '--deepen=1000', 'origin'])
	}
	return git(root, ['merge-base', baseRef, 'HEAD'])
}

/** The runtime declarations as they were on commit `sha`. */
function runtimeDeclarationsAt(root, sha) {
	const paths = git(root, ['ls-tree', '-r', '-z', '--name-only', sha])
		.split('\0')
		.filter(Boolean)
		.filter(isRuntimeFile)
	return findRuntimeDeclarations(paths.map(path => ({ path, text: git(root, ['show', `${sha}:${path}`]) })))
}

function verify(root) {
	const driver = detectDriver(root)
	const sha = mergeBase(root)
	const was = driver.rows({
		lock: git(root, ['show', `${sha}:${driver.lockfile}`]),
		packageJson: driver.name === 'npm' ? git(root, ['show', `${sha}:package.json`]) : '',
	})
	const downgrades = findDowngrades(was, readRows(driver, root))
	const runtimeWas = runtimeDeclarationsAt(root, sha)
	const runtimeDown = findRuntimeDowngrades(runtimeWas, findRuntimeDeclarations(readRuntimeFiles(root)))
	for (const row of downgrades) {
		console.error(`downgrade: ${row.importer}: ${row.name} ${row.before} -> ${row.after}`)
	}
	for (const row of runtimeDown) {
		console.error(`downgrade: ${row.file}: ${row.family} ${row.before} -> ${row.after}`)
	}
	const total = downgrades.length + runtimeDown.length
	if (total > 0) {
		throw new Error(`${total} direct dependency(ies) resolve lower than on ${sha.slice(0, 9)}`)
	}
	const pinned = runtimeWas.filter(entry => entry.parsed?.version).length
	console.log(
		`no downgrades: ${was.length} direct dependencies and ${pinned} runtime declarations compared with ${sha.slice(0, 9)}`,
	)
}

async function main() {
	const [command = 'report', ...args] = process.argv.slice(2)
	// The repository the command is run in. `mise run` starts a task in the project root.
	const root = process.env.OS_DEPS_ROOT || process.cwd()
	try {
		if (command === 'report') {
			await printReport(root)
		} else if (command === 'apply') {
			await apply(root, args)
		} else if (command === 'verify') {
			verify(root)
		} else {
			throw new Error(`unknown command ${command}: use report, apply or verify`)
		}
	} catch (error) {
		const failed = error instanceof ScanError ? 'scan_failed' : command
		console.error(`os:deps: ${failed}: ${error instanceof Error ? error.message : error}`)
		process.exit(error instanceof ScanError ? 2 : 1)
	}
}

// Run from the command line, whether by its path or through the `.bin` link a package manager makes for it.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
	await main()
}
