/**
 * Node.js and the package manager as dependencies of `os:deps`: where a repository declares them, what each
 * declaration may move to, and how a move is written back in the form it was declared in.
 *
 * A runtime is declared in many files that are not a lockfile (mise, `.nvmrc`, engines, Dockerfiles, compose files,
 * workflows, Terraform), so it is read from the files themselves, line by line, and each declaration keeps its
 * `file:line`. Node's releases come from nodejs.org (`dist/index.json`, which marks security releases, and the
 * release schedule, which dates each major's end of life). pnpm and npm come from the registry like any package.
 *
 * Everything here that decides a version is a pure function over texts and documents, so a test holds it; the
 * fetching and the reading of files is done by the caller.
 */
import { compareVersions, parseVersion } from './os-deps.mjs'

export const RUNTIME_FAMILIES = ['node', 'pnpm', 'npm']

export const NODE_INDEX_URL = 'https://nodejs.org/dist/index.json'
export const NODE_SCHEDULE_URL = 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * A floating declaration resolves to the newest release when an image is built, but a cached build keeps whatever
 * it resolved before. So a float is marked as a security fix while its major's latest security release is this
 * recent: long enough for a weekly refresh to see it, short enough that a float is not urgent forever.
 */
export const FLOAT_SECURITY_DAYS = 30

const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical']

/** `Dockerfile`, `Dockerfile.production`, `web.Dockerfile`: not a script or a document named after one. */
function isDockerfile(base) {
	return (
		(/^Dockerfile(\.[\w.-]+)?$/i.test(base) || /\.Dockerfile$/i.test(base)) &&
		!/\.(c?js|mjs|ts|mts|cts|json|md|txt|sh|py|ya?ml)$/i.test(base)
	)
}

/** Whether a repository path can declare a runtime, by its name. node_modules is never read. */
export function isRuntimeFile(path) {
	if (/(^|\/)node_modules\//.test(path)) {
		return false
	}
	const base = path.split('/').pop()
	return (
		/^\.?mise(\.[\w-]+)?\.toml$/.test(base) ||
		['.nvmrc', '.node-version', '.tool-versions', 'package.json'].includes(base) ||
		isDockerfile(base) ||
		/^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(base) ||
		/^\.(github|gitea)\/workflows\/[^/]+\.ya?ml$/.test(path) ||
		/\.(tf|tfvars)$/.test(base)
	)
}

/**
 * A version as a declaration writes it: `26`, `26.7`, `v26.7.0`, or an image tag such as `26.7.0-bookworm-slim`
 * when `suffix` is allowed. `{ major, version, floating, suffix, v }`, or null when it names no major (`lts/*`,
 * `latest`, `alpine`). `version` is set only for an exact `x.y.z`; anything shorter floats inside its major.
 */
export function parseDeclared(text, { suffix = false } = {}) {
	const match = /^(v?)(\d+)(?:\.(\d+))?(?:\.(\d+))?((?:-[0-9A-Za-z._]+)*)$/.exec(String(text).trim())
	if (!match || (match[5] && !suffix)) {
		return null
	}
	const exact = match[3] !== undefined && match[4] !== undefined
	return {
		major: Number(match[2]),
		version: exact ? `${match[2]}.${match[3]}.${match[4]}` : null,
		floating: !exact,
		suffix: match[5] ?? '',
		v: match[1],
	}
}

/** `node:<tag>` images on a line, as Dockerfiles, compose files, workflows and Terraform write them. */
const NODE_IMAGE = /(^|[\s"'=[,(])((?:docker\.io\/)?(?:library\/)?node):([0-9A-Za-z][\w.-]*)(@sha256:[0-9a-f]+)?/g

/** A tag of the official image that names no version (`lts-alpine`): not `node:node`, a user and group. */
const NODE_WORD_TAG =
	/^(lts|current|latest|alpine|slim|bookworm|bullseye|buster|trixie|argon|boron|carbon|dubnium|erbium|fermium|gallium|hydrogen|iron|jod|krypton)([\w.-]*)$/

function lineCol(text, offset) {
	const before = text.slice(0, offset)
	const line = before.split('\n').length
	return { line, col: offset - before.lastIndexOf('\n') - 1 }
}

/** One declaration of a version-like value. `held` says why it cannot be moved, with the declaration kept in view. */
function declaration(file, line, col, kind, family, raw, parsed, extra = {}) {
	const held = parsed ? null : `\`${raw}\` names no major: pin a version so the scan can track it`
	return { file, line, col, kind, family, raw, parsed, held, ...extra }
}

function imageDeclarations(file, text, kind) {
	const found = []
	const lines = text.split('\n')
	lines.forEach((content, at) => {
		for (const match of content.matchAll(NODE_IMAGE)) {
			const tag = match[3]
			if (!/^\d/.test(tag) && !NODE_WORD_TAG.test(tag)) {
				continue
			}
			const col = match.index + match[1].length + match[2].length + 1
			const parsed = parseDeclared(tag, { suffix: true })
			const entry = declaration(file, at + 1, col, kind, 'node', tag, parsed)
			if (match[4]) {
				entry.held = `\`node:${tag}${match[4]}\` is pinned by digest: rebuild the image and write the new digest`
			}
			found.push(entry)
		}
	})
	return found
}

function miseDeclarations(file, text) {
	const found = []
	let section = null
	text.split('\n').forEach((content, at) => {
		const header = /^\s*\[([^\]]+)\]/.exec(content)
		if (header) {
			section = header[1].trim()
			return
		}
		if (section !== 'tools') {
			return
		}
		const tool = /^(\s*["']?(node|pnpm|npm)["']?\s*=\s*)(["'])([^"']*)\3/.exec(content)
		if (tool) {
			const col = tool[1].length + 1
			found.push(declaration(file, at + 1, col, 'mise', tool[2], tool[4], parseDeclared(tool[4])))
		} else if (/^\s*["']?(node|pnpm|npm)["']?\s*=/.test(content)) {
			const family = /^\s*["']?(node|pnpm|npm)/.exec(content)[1]
			found.push({
				...declaration(file, at + 1, 0, 'mise', family, content.trim(), null),
				held: `\`${content.trim()}\` is not a version string this scan can move`,
			})
		}
	})
	return found
}

function versionFileDeclarations(file, text, kind) {
	const lines = text.split('\n')
	const at = lines.findIndex(line => line.trim() !== '' && !line.trim().startsWith('#'))
	if (at === -1) {
		return []
	}
	const raw = lines[at].trim()
	const col = lines[at].indexOf(raw)
	return [declaration(file, at + 1, col, kind, 'node', raw, parseDeclared(raw))]
}

function toolVersionsDeclarations(file, text) {
	const found = []
	text.split('\n').forEach((content, at) => {
		const match = /^(\s*(nodejs|node|pnpm|npm)\s+)(\S+)/.exec(content)
		if (match) {
			const family = match[2] === 'nodejs' ? 'node' : match[2]
			found.push(
				declaration(file, at + 1, match[1].length, 'tool-versions', family, match[3], parseDeclared(match[3])),
			)
		}
	})
	return found
}

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Where `"key": "value"` sits in a package.json text, after its parent key when there is one. */
function locateJsonValue(text, parent, key, value) {
	const from = parent ? text.search(new RegExp(`"${escapeRegExp(parent)}"\\s*:`)) : 0
	const pattern = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"`, 'g')
	pattern.lastIndex = Math.max(from, 0)
	for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
		const start = match.index + match[0].length
		if (text.startsWith(value, start)) {
			return lineCol(text, start)
		}
	}
	return null
}

/**
 * An engines range as one major's floor: `{ floor, op, upper }` for `26.7.0`, `^26.7.0`, `~26.7.0`, `>=26.7.0 <27`,
 * or `{ held }` for one this scan does not move: several majors (`||`), an open floor (`>=22`), or a form it
 * cannot read.
 */
export function parseEnginesRange(range) {
	const text = String(range).trim()
	if (text.includes('||')) {
		return { held: `\`${text}\` spans several majors: it is a support range, and is not moved` }
	}
	const parts = text.split(/\s+/)
	const floor = /^(>=|\^|~|=)?v?(\d+(?:\.\d+){0,2})$/.exec(parts[0] ?? '')
	if (!floor) {
		return { held: `\`${text}\` is not an engines range this scan can move` }
	}
	const upper = parts[1] ? /^<v?(\d+)(?:\.0){0,2}$/.exec(parts[1]) : null
	if (parts.length > 2 || (parts[1] && !upper)) {
		return { held: `\`${text}\` is not an engines range this scan can move` }
	}
	const op = floor[1] ?? ''
	if (op === '>=' && !upper) {
		return { held: `\`${text}\` is an open floor that admits majors this repository may not run: not moved` }
	}
	const pieces = floor[2].split('.')
	const version = [pieces[0], pieces[1] ?? '0', pieces[2] ?? '0'].join('.')
	return { floor: floor[2], version, op, upper: upper ? { text: parts[1], major: Number(upper[1]) } : null }
}

/** engines.node, volta.pnpm and the like: one declaration for each runtime a package.json section names. */
function sectionDeclarations(file, text, data, parent) {
	const found = []
	for (const family of RUNTIME_FAMILIES) {
		const value = data?.[parent]?.[family]
		if (typeof value !== 'string') {
			continue
		}
		const at = locateJsonValue(text, parent, family, value) ?? { line: 1, col: 0 }
		if (parent === 'volta') {
			found.push(declaration(file, at.line, at.col, 'volta', family, value, parseDeclared(value)))
			continue
		}
		const range = parseEnginesRange(value)
		const parsed = range.held ? null : { ...parseDeclared(range.version), floating: false }
		found.push({
			...declaration(file, at.line, at.col, 'engines', family, value, parsed, { range }),
			held: range.held ?? null,
		})
	}
	return found
}

/** `packageManager: pnpm@11.17.0+sha512.…`, keeping whether it carried corepack's integrity suffix. */
function managerDeclaration(file, text, data) {
	const value = data?.packageManager
	const manager = typeof value === 'string' ? /^(pnpm|npm)@([^+]+)(\+.+)?$/.exec(value) : null
	if (!manager) {
		return []
	}
	const at = locateJsonValue(text, null, 'packageManager', value) ?? { line: 1, col: 0 }
	const parsed = parseDeclared(manager[2])
	return [declaration(file, at.line, at.col, 'packageManager', manager[1], value, parsed, { hash: manager[3] ?? '' })]
}

function packageJsonDeclarations(file, text) {
	let data
	try {
		data = JSON.parse(text)
	} catch {
		return []
	}
	return [
		...sectionDeclarations(file, text, data, 'engines'),
		...sectionDeclarations(file, text, data, 'volta'),
		...managerDeclaration(file, text, data),
	]
}

function dockerfileDeclarations(file, text) {
	const found = imageDeclarations(file, text, 'image')
	text.split('\n').forEach((content, at) => {
		const arg = /^(\s*ARG\s+NODE(?:_[A-Z]+)*_VERSION=["']?)([^"'\s]+)/.exec(content)
		if (arg) {
			found.push(declaration(file, at + 1, arg[1].length, 'docker-arg', 'node', arg[2], parseDeclared(arg[2])))
		}
	})
	return found
}

function workflowDeclarations(file, text) {
	const found = imageDeclarations(file, text, 'image')
	text.split('\n').forEach((content, at) => {
		const setup = /^(\s*node-version:\s*["']?)([^"'\s#]+)/.exec(content)
		if (setup && !setup[2].includes('${{')) {
			found.push(
				declaration(file, at + 1, setup[1].length, 'setup-node', 'node', setup[2], parseDeclared(setup[2])),
			)
		}
	})
	return found
}

/**
 * Every runtime declaration in `files` (`[{ path, text }]`), each `{ file, line, col, kind, family, raw, parsed,
 * held }`: `raw` is the text at `line:col` that a move rewrites, `parsed` what it names (see parseDeclared), and
 * `held` the reason it cannot be moved, when there is one.
 */
export function findRuntimeDeclarations(files) {
	const found = []
	for (const { path, text } of files) {
		const base = path.split('/').pop()
		if (/^\.?mise(\.[\w-]+)?\.toml$/.test(base)) {
			found.push(...miseDeclarations(path, text))
		} else if (base === '.nvmrc' || base === '.node-version') {
			found.push(...versionFileDeclarations(path, text, base.slice(1)))
		} else if (base === '.tool-versions') {
			found.push(...toolVersionsDeclarations(path, text))
		} else if (base === 'package.json') {
			found.push(...packageJsonDeclarations(path, text))
		} else if (isDockerfile(base)) {
			found.push(...dockerfileDeclarations(path, text))
		} else if (/^\.(github|gitea)\/workflows\//.test(path)) {
			found.push(...workflowDeclarations(path, text))
		} else {
			found.push(...imageDeclarations(path, text, 'image'))
		}
	}
	return found
}

/** Node's releases from `dist/index.json`: `[{ version, date, lts, security }]`, newest first as published. */
export function parseNodeIndex(doc) {
	if (!Array.isArray(doc)) {
		return null
	}
	return doc
		.map(row => ({
			version: String(row?.version ?? '').replace(/^v/, ''),
			date: row?.date ?? null,
			lts: Boolean(row?.lts),
			security: Boolean(row?.security),
		}))
		.filter(row => parseVersion(row.version) && !parseVersion(row.version).prerelease)
}

/** Each major's end of life from the release schedule: major number to an ISO date. */
export function parseNodeSchedule(doc) {
	const ends = new Map()
	for (const [key, value] of Object.entries(doc ?? {})) {
		const major = /^v(\d+)$/.exec(key)
		if (major && typeof value?.end === 'string') {
			ends.set(Number(major[1]), value.end)
		}
	}
	return ends
}

function highestOf(versions) {
	return versions.reduce(
		(best, version) => (best === null || compareVersions(version, best) > 0 ? version : best),
		null,
	)
}

function majorOfVersion(version) {
	return parseVersion(version)?.parts[0] ?? null
}

/**
 * Whether `version` is inside an advisory's `vulnerable_versions`: comparator sets (`>=1.2.0 <1.4.3`) joined by
 * `||`. A range this cannot read counts as affected, so an unread advisory is never passed off as clean.
 */
export function satisfiesRange(version, range) {
	if (!range || range.trim() === '*') {
		return true
	}
	return range.split('||').some(set => {
		const comparators = set.trim().split(/\s+/).filter(Boolean)
		return comparators.every(comparator => {
			const match = /^(<=|>=|<|>|=)?v?(\d+(?:\.\d+){0,2})(-[0-9A-Za-z.-]+)?$/.exec(comparator)
			if (!match) {
				return true
			}
			const pieces = match[2].split('.')
			const bound = `${[pieces[0], pieces[1] ?? '0', pieces[2] ?? '0'].join('.')}${match[3] ?? ''}`
			const order = compareVersions(version, bound)
			switch (match[1] ?? '=') {
				case '<':
					return order < 0
				case '<=':
					return order <= 0
				case '>':
					return order > 0
				case '>=':
					return order >= 0
				default:
					return order === 0
			}
		})
	})
}

function affecting(advisories, version) {
	return (advisories ?? []).filter(advisory => satisfiesRange(version, advisory.vulnerable_versions))
}

function worstSeverity(list) {
	return list.reduce(
		(worst, advisory) =>
			SEVERITIES.indexOf(advisory.severity) > SEVERITIES.indexOf(worst ?? '') ? advisory.severity : worst,
		null,
	)
}

function where(declarations) {
	return [...new Set(declarations.map(entry => `${entry.file}:${entry.line}`))]
}

/** The versions one family can move to: node from its index, pnpm and npm from the registry document. */
function familyVersions(family, sources) {
	if (family === 'node') {
		return (sources.nodeReleases ?? []).map(row => ({
			version: row.version,
			time: row.date,
			lts: row.lts,
			security: row.security,
		}))
	}
	const packument = sources.packuments?.get(family)
	if (!packument || packument.held) {
		return null
	}
	return Object.entries(packument.versions)
		.filter(([version, meta]) => {
			const parsed = parseVersion(version)
			return (
				parsed &&
				!parsed.prerelease &&
				!meta.deprecated &&
				(!packument.latest || compareVersions(version, packument.latest) <= 0)
			)
		})
		.map(([version, meta]) => ({ version, time: meta.time, lts: false, security: false }))
}

function byMajorOf(entries) {
	const byMajor = new Map()
	for (const entry of entries) {
		const group = byMajor.get(entry.parsed.major) ?? []
		group.push(entry)
		byMajor.set(entry.parsed.major, group)
	}
	return [...byMajor.entries()].sort(([a], [b]) => a - b)
}

/** A held row naming each major a family is declared on, and where, when there is more than one. */
function disagreement(family, groups) {
	if (groups.length < 2) {
		return []
	}
	const listing = groups.map(([major, group]) => `${major} in ${where(group).join(', ')}`).join('; ')
	return [
		{
			name: family,
			current: groups.map(([major]) => major).join(', '),
			reason: `declarations disagree: ${listing}`,
		},
	]
}

function lowestOf(versions) {
	return versions.reduce((low, version) => (low === null || compareVersions(version, low) < 0 ? version : low), null)
}

/** The declarations of one major, one row for each distinct current version (or floating form). */
function rowsOf(group) {
	const rows = new Map()
	for (const entry of group) {
		const label = entry.parsed.version ?? `${entry.raw} (floats)`
		const row = rows.get(label) ?? { label, entries: [], version: entry.parsed.version }
		row.entries.push(entry)
		rows.set(label, row)
	}
	return [...rows.values()]
}

/**
 * The newest release one major may move to. It waits out the cooldown, unless the move carries a security fix: a
 * node security release after the lowest exact declaration, an advisory on it, or (for a float) a recent node
 * security release, which is what a fresh build of it would get. A release an advisory names is never a target.
 */
function targetInMajor(family, group, inMajor, ctx) {
	const lowest = lowestOf(group.filter(entry => entry.parsed.version).map(entry => entry.parsed.version))
	const fixes = lowest ? inMajor.filter(row => row.security && compareVersions(row.version, lowest) > 0) : []
	const advised = lowest ? affecting(ctx.advisories, lowest) : []
	const floats = group.some(entry => !entry.parsed.version)
	const recentFix = floats && floatSecurity(family, inMajor, null, ctx.now) !== null
	const waive = fixes.length > 0 || advised.length > 0 || recentFix
	const target = highestOf(
		inMajor
			.filter(row => waive || ctx.oldEnough(row.time))
			.filter(row => affecting(ctx.advisories, row.version).length === 0)
			.map(row => row.version),
	)
	return { target, fixes, lowest }
}

/** The update rows for one major of one family. */
function majorRows(family, group, inMajor, ctx) {
	const { target, fixes } = targetInMajor(family, group, inMajor, ctx)
	if (!target) {
		return []
	}
	return rowsOf(group)
		.filter(row => !row.version || compareVersions(row.version, target) < 0)
		.map(row => {
			const floats = !row.version
			return {
				name: family,
				current: row.label,
				target,
				level: floats ? 'pin' : bumpLevelOf(row.version, target),
				security: floats
					? floatSecurity(family, inMajor, target, ctx.now)
					: securityOf(family, row.version, target, fixes, ctx.advisories),
				note: `declared in ${where(row.entries).join(', ')}${floats ? '; floats, so a build can keep an older release' : ''}`,
			}
		})
}

/**
 * The runtime half of the report, from the declarations and what the sources say: `{ updates, majors, held }` in
 * the shapes buildReport gives, so the two are rendered as one. `sources` is `{ nodeReleases, nodeEnds,
 * packuments, advisories }`: node's releases and end-of-life dates, and the registry documents and advisories for
 * pnpm and npm.
 */
export function buildRuntimeReport(declarations, sources, { now, minAgeDays }) {
	const updates = []
	const majors = []
	const held = declarations
		.filter(entry => entry.held)
		.map(entry => ({
			name: entry.family,
			current: entry.raw,
			reason: `${entry.file}:${entry.line}: ${entry.held}`,
		}))
	const oldEnough = time => {
		const released = Date.parse(time ?? '')
		return Number.isFinite(released) && now - released >= minAgeDays * DAY_MS
	}
	for (const family of RUNTIME_FAMILIES) {
		const usable = declarations.filter(entry => entry.family === family && !entry.held)
		const versions = usable.length > 0 ? familyVersions(family, sources) : []
		if (!versions) {
			const reason = `the registry has no document for ${family}, declared in ${where(usable).join(', ')}`
			held.push({ name: family, current: usable[0].raw, reason })
			continue
		}
		const groups = byMajorOf(usable)
		held.push(...disagreement(family, groups))
		const ctx = { now, oldEnough, advisories: sources.advisories?.get(family) ?? [], nodeEnds: sources.nodeEnds }
		for (const [major, group] of groups) {
			const inMajor = versions.filter(row => majorOfVersion(row.version) === major)
			updates.push(...majorRows(family, group, inMajor, ctx))
			const lowest = lowestOf(group.filter(entry => entry.parsed.version).map(entry => entry.parsed.version))
			const upgrade = majorUpgrade(family, major, group, versions, { ...ctx, lowest })
			if (upgrade) {
				majors.push(upgrade)
			}
		}
	}
	return { updates, majors, held }
}

/** A float's Security column: the major's latest node security release, while it is recent (FLOAT_SECURITY_DAYS). */
function floatSecurity(family, inMajor, target, now) {
	if (family !== 'node') {
		return null
	}
	const recent = inMajor
		.filter(row => row.security && (target === null || compareVersions(row.version, target) <= 0))
		.filter(row => now - Date.parse(row.time ?? '') <= FLOAT_SECURITY_DAYS * DAY_MS)
		.sort((a, b) => compareVersions(b.version, a.version))
	return recent.length > 0 ? `node security release ${recent[0].time}` : null
}

function bumpLevelOf(current, target) {
	const from = parseVersion(current).parts
	const to = parseVersion(target).parts
	return from[1] === to[1] ? 'patch' : 'minor'
}

/** What a row's Security column says: the first node security release it takes, or the worst advisory it fixes. */
function securityOf(family, current, target, fixes, advisories) {
	if (family === 'node') {
		const taken = fixes
			.filter(row => compareVersions(row.version, target) <= 0)
			.sort((a, b) => compareVersions(a.version, b.version))
		return taken.length > 0 ? `node security release ${taken[0].time}` : null
	}
	return worstSeverity(affecting(advisories, current))
}

/**
 * Node's major target: its newest LTS major (an even major with `lts` set), never an odd one. A major past its end
 * of life moves even when that LTS is not old enough yet, or to the next major up when no LTS is above it.
 */
function nodeMajorTarget(major, versions, ctx) {
	const end = ctx.nodeEnds?.get(major)
	const ended = Boolean(end) && Date.parse(end) <= ctx.now
	const security = ended ? `Security: node ${major} is past end of life (${end}) and gets no security fixes.` : null
	const above = versions.filter(row => majorOfVersion(row.version) > major)
	const ltsMajors = above.filter(row => row.lts).map(row => majorOfVersion(row.version))
	let toMajor = ltsMajors.length > 0 ? Math.max(...ltsMajors) : null
	if (toMajor === null && ended && above.length > 0) {
		toMajor = Math.min(...above.map(row => majorOfVersion(row.version)))
	}
	if (toMajor === null) {
		return { target: null, security }
	}
	const candidates = above.filter(
		row => majorOfVersion(row.version) === toMajor && (ended || ctx.oldEnough(row.time)),
	)
	return { target: highestOf(candidates.map(row => row.version)), security }
}

/**
 * pnpm's or npm's major target: its newest major. An advisory on the current version with no fixed release left
 * in its major makes it a security major, which moves without waiting out the cooldown.
 */
function managerMajorTarget(family, major, versions, ctx) {
	const advised = ctx.lowest ? affecting(ctx.advisories, ctx.lowest) : []
	const fixedInMajor = versions.some(
		row =>
			majorOfVersion(row.version) === major &&
			compareVersions(row.version, ctx.lowest ?? '0.0.0') > 0 &&
			affecting(ctx.advisories, row.version).length === 0,
	)
	let security = null
	if (advised.length > 0 && !fixedInMajor) {
		const advisory = advised[0]
		const id = /GHSA-[\w-]+/.exec(advisory.url ?? '')?.[0]
		const named = id ? `${id} (${advisory.title})` : (advisory.title ?? 'an advisory')
		security = `Security: ${family} ${major} has ${named} with no fix in ${major}.x.`
	}
	const newest = Math.max(...versions.map(row => majorOfVersion(row.version)))
	if (newest <= major) {
		return { target: null, security }
	}
	const candidates = versions.filter(row => majorOfVersion(row.version) === newest)
	const aged = highestOf(candidates.filter(row => ctx.oldEnough(row.time)).map(row => row.version))
	return { target: aged ?? (security ? highestOf(candidates.map(row => row.version)) : null), security }
}

/**
 * A major upgrade for one family on one major, or null, in the shape majorFamilies gives. One the current major
 * can no longer be fixed from carries `security`, the line the report prints under its heading.
 */
function majorUpgrade(family, major, group, versions, ctx) {
	const { target, security } =
		family === 'node' ? nodeMajorTarget(major, versions, ctx) : managerMajorTarget(family, major, versions, ctx)
	if (!target) {
		return null
	}
	const released = versions.find(row => row.version === target)?.time?.slice(0, 10) ?? null
	const notes =
		family === 'node'
			? `https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V${majorOfVersion(target)}.md`
			: `https://github.com/${family}/${family === 'npm' ? 'cli' : family}/releases`
	const current = ctx.lowest ?? `${major} (floats)`
	return {
		title: `Major upgrade: ${family} ${major} to ${majorOfVersion(target)}`,
		released,
		security,
		packages: [{ name: family, current, target, released, notes, importers: where(group) }],
	}
}

/** `sha512-<base64>` (the registry's integrity) as the `+sha512.<hex>` suffix corepack writes on packageManager. */
export function corepackHash(integrity) {
	const match = /^sha512-(.+)$/.exec(String(integrity ?? ''))
	return match ? `+sha512.${Buffer.from(match[1], 'base64').toString('hex')}` : ''
}

/** What one declaration's raw text becomes for `version`, in the form it was written in. */
function movedRaw(entry, version, hashes) {
	const target = parseVersion(version).parts.join('.')
	switch (entry.kind) {
		case 'image':
			return `${target}${entry.parsed.suffix}`
		case 'engines': {
			const { range } = entry
			const floor = `${range.op}${target}`
			if (!range.upper) {
				return floor
			}
			const upperMajor =
				range.upper.major === entry.parsed.major + 1 ? majorOfVersion(target) + 1 : range.upper.major
			const upper = range.upper.text.replace(/\d+/, String(upperMajor))
			return `${floor} ${upper}`
		}
		case 'packageManager':
			return `${entry.family}@${target}${entry.hash ? (hashes?.get(`${entry.family}@${target}`) ?? '') : ''}`
		default:
			return `${entry.parsed.v}${target}`
	}
}

/**
 * The file edits that move `pairs` (`[{ name, version }]`, names from RUNTIME_FAMILIES), as `{ edits, moved,
 * already, lost }`. A declaration moves when it is on the pair's major (or, with `major`, below it) and is lower
 * than the pair or floats. `edits` is `[{ path, original, text, changed }]`; `hashes` maps `name@version` to the
 * packageManager integrity suffix to write, when one was declared.
 */
export function planRuntimeEdits(files, declarations, pairs, { major = false, hashes = new Map() } = {}) {
	const byPath = new Map(
		files.map(file => [
			file.path,
			{ path: file.path, original: file.text, lines: file.text.split('\n'), changed: [] },
		]),
	)
	const moved = new Set()
	const already = []
	const lost = []
	for (const pair of pairs) {
		const targetMajor = majorOfVersion(pair.version)
		const candidates = declarations.filter(
			entry =>
				entry.family === pair.name &&
				!entry.held &&
				(entry.parsed.major === targetMajor || (major && entry.parsed.major < targetMajor)),
		)
		const moving = candidates.filter(
			entry => entry.parsed.floating || compareVersions(entry.parsed.version, pair.version) < 0,
		)
		if (moving.length === 0) {
			if (candidates.length > 0) {
				already.push(pair)
			} else {
				lost.push(pair)
			}
			continue
		}
		// Edits on one line go right to left, so an earlier column is still where it was read.
		for (const entry of [...moving].sort((a, b) => b.col - a.col)) {
			const file = byPath.get(entry.file)
			const content = file.lines[entry.line - 1]
			if (content.slice(entry.col, entry.col + entry.raw.length) !== entry.raw) {
				throw new Error(`${entry.file}:${entry.line} no longer reads ${entry.raw}: nothing was changed`)
			}
			const to = movedRaw(entry, pair.version, hashes)
			file.lines[entry.line - 1] =
				`${content.slice(0, entry.col)}${to}${content.slice(entry.col + entry.raw.length)}`
			file.changed.push({ family: entry.family, line: entry.line, from: entry.raw, to })
		}
		moved.add(pair.name)
	}
	const edits = [...byPath.values()]
		.filter(file => file.changed.length > 0)
		.map(file => ({
			path: file.path,
			original: file.original,
			text: file.lines.join('\n'),
			changed: file.changed.sort((a, b) => a.line - b.line),
		}))
	return { edits, moved, already, lost }
}

/**
 * Exact runtime declarations that are lower in `after` than in `before`. Declarations are matched by file, kind,
 * family and order in their file, so a line moved by an unrelated edit still compares with itself.
 */
export function findRuntimeDowngrades(before, after) {
	const keyed = list => {
		const counts = new Map()
		const map = new Map()
		for (const entry of list) {
			if (entry.held || !entry.parsed?.version) {
				continue
			}
			const base = `${entry.file}|${entry.kind}|${entry.family}`
			const n = counts.get(base) ?? 0
			counts.set(base, n + 1)
			map.set(`${base}|${n}`, entry)
		}
		return map
	}
	const was = keyed(before)
	const now = keyed(after)
	const downgrades = []
	for (const [key, entry] of was) {
		const later = now.get(key)
		if (later && compareVersions(later.parsed.version, entry.parsed.version) < 0) {
			downgrades.push({
				file: entry.file,
				family: entry.family,
				before: entry.parsed.version,
				after: later.parsed.version,
			})
		}
	}
	return downgrades
}
