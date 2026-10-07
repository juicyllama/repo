#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseDocument, stringify } from 'yaml'

export const EXIT = { missing: 2, invalid: 3, brand: 4, context: 5 }
const LEVELS = ['patch', 'minor', 'major']
const PENDING = '.release/pending'
const META_KEYS = ['bump', 'title', 'description', 'tags']

export class ReleaseError extends Error {
	constructor(message, options = {}) {
		super(message, options)
		this.code = options.code ?? EXIT.invalid
	}
}

export function git(root, ...args) {
	return execFileSync('git', args, {
		cwd: root,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		maxBuffer: 32 * 1024 * 1024,
	}).trimEnd()
}

function file(root, relative) {
	if (
		typeof relative !== 'string' ||
		!relative ||
		relative.includes('\\') ||
		relative.split('/').includes('..') ||
		relative.startsWith('/')
	) {
		throw new ReleaseError(`Unsafe repository path: ${relative}`)
	}
	const target = resolve(root, relative)
	if (!target.startsWith(`${resolve(root)}${sep}`)) throw new ReleaseError(`Unsafe repository path: ${relative}`)
	let current = resolve(root)
	for (const part of relative.split('/')) {
		current = join(current, part)
		if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
			throw new ReleaseError(`Symlink is not allowed: ${relative}`)
	}
	return target
}

export function loadConfig(root) {
	const config = JSON.parse(readFileSync(file(root, '.release/config.json'), 'utf8'))
	if (config.schemaVersion !== 1) throw new ReleaseError('Release config schemaVersion must be 1')
	if (
		!Array.isArray(config.bumpCommand) ||
		config.bumpCommand.length === 0 ||
		config.bumpCommand.some(x => typeof x !== 'string' || !x)
	) {
		throw new ReleaseError('bumpCommand must be a non-empty argv array; the bump level is appended')
	}
	file(root, config.versionFile)
	if (!Array.isArray(config.nonShipping) || config.nonShipping.some(x => typeof x !== 'string' || !x))
		throw new ReleaseError('nonShipping must be an array of path globs')
	if (typeof config.notes?.enabled !== 'boolean') throw new ReleaseError('notes.enabled must be boolean')
	if (config.notes.enabled) {
		if (config.notes.format !== 'openchangelog') throw new ReleaseError('Supported notes format: openchangelog')
		file(root, config.notes.path)
	}
	if (
		config.brand &&
		(typeof config.brand.name !== 'string' ||
			!Array.isArray(config.brand.avoid) ||
			config.brand.avoid.some(x => typeof x !== 'string' || !x))
	) {
		throw new ReleaseError('brand requires a name and an avoid array')
	}
	return config
}

function frontmatter(text, name) {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/)
	if (!match) throw new ReleaseError(`${name}: expected YAML frontmatter enclosed in ---`)
	const doc = parseDocument(match[1], { uniqueKeys: true, schema: 'core' })
	if (doc.errors.length > 0) throw new ReleaseError(`${name}: ${doc.errors.map(x => x.message).join('; ')}`)
	let meta
	try {
		meta = doc.toJS({ maxAliasCount: 0 })
	} catch (cause) {
		throw new ReleaseError(`${name}: YAML aliases are not allowed`, { cause, code: EXIT.invalid })
	}
	return { meta, body: match[2].trim() }
}

function validateMeta(meta, name) {
	if (
		!meta ||
		typeof meta !== 'object' ||
		Array.isArray(meta) ||
		Object.keys(meta).some(key => !META_KEYS.includes(key))
	) {
		throw new ReleaseError(`${name}: only bump, title, description and tags are allowed; no version or date`)
	}
	if (!LEVELS.includes(meta.bump)) throw new ReleaseError(`${name}: bump must be patch, minor or major`)
	for (const key of ['title', 'description']) {
		if (typeof meta[key] !== 'string' || !meta[key].trim() || [...meta[key]].some(char => char.charCodeAt(0) < 32))
			throw new ReleaseError(`${name}: ${key} must be a non-empty single line`)
	}
	if (!Array.isArray(meta.tags) || meta.tags.some(x => typeof x !== 'string' || !x.trim() || /[\r\n]/.test(x)))
		throw new ReleaseError(`${name}: tags must be an array of non-empty strings`)
	if (/\bv?\d+\.\d+\.\d+\b/.test(meta.title))
		throw new ReleaseError(`${name}: title must not include a release version`)
	return meta
}

export function parseIntent(text, config, name) {
	const { meta, body } = frontmatter(text, name)
	validateMeta(meta, name)
	if (config.notes.enabled && !body) throw new ReleaseError(`${name}: published notes require a body`)
	if (!config.notes.enabled && body) throw new ReleaseError(`${name}: notes are disabled; leave the body empty`)
	for (const spelling of config.brand?.avoid ?? []) {
		if ([meta.title, meta.description, ...meta.tags, body].some(value => value.includes(spelling)))
			throw new ReleaseError(`${name}: use ${config.brand.name}, not ${spelling}`, { code: EXIT.brand })
	}
	return { ...meta, body }
}

function globRegex(pattern) {
	let source = '^'
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i]
		if (char === '*' && pattern[i + 1] === '*') {
			i++
			if (pattern[i + 1] === '/') {
				i++
				source += '(?:.*/)?'
			} else source += '.*'
		} else if (char === '*') source += '[^/]*'
		else if (char === '?') source += '[^/]'
		else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	}
	return new RegExp(`${source}$`)
}

export function isNonShipping(paths, config) {
	const globs = config.nonShipping.map(globRegex)
	return paths.filter(path => !path.startsWith(`${PENDING}/`)).every(path => globs.some(glob => glob.test(path)))
}

export function labelBump(labels = []) {
	if (!Array.isArray(labels) || labels.some(x => typeof x !== 'string'))
		throw new ReleaseError('labels must be a JSON array of label names', { code: EXIT.context })
	if (labels.includes('major')) return 'major'
	return labels.includes('minor') ? 'minor' : 'patch'
}

function branchContext(root, options) {
	if (!/^[1-9]\d*$/.test(String(options.pr ?? '')))
		throw new ReleaseError('Pass --pr <number> (or RELEASE_PR)', { code: EXIT.context })
	const base = options.base ?? process.env.OS_BASE_REF ?? 'origin/main'
	if (base.startsWith('-')) throw new ReleaseError('Invalid base ref', { code: EXIT.context })
	let mergeBase
	try {
		mergeBase = git(root, 'merge-base', base, 'HEAD')
	} catch (cause) {
		throw new ReleaseError(`Cannot resolve merge base ${base}; fetch the base branch`, {
			cause,
			code: EXIT.context,
		})
	}
	// --no-renames includes both paths: moving shipping code into a tooling directory still ships.
	const paths = new Set(
		git(root, 'diff', '--no-renames', '--name-only', '-z', mergeBase, '--').split('\0').filter(Boolean),
	)
	for (const path of git(root, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean))
		paths.add(path)
	return { pr: Number(options.pr), base, mergeBase, paths: [...paths], bump: labelBump(options.labels) }
}

export function report(root, options = {}) {
	const config = loadConfig(root)
	const context = branchContext(root, options)
	return {
		schemaVersion: 1,
		...context,
		nonShipping: isNonShipping(context.paths, config),
		pendingPath: `${PENDING}/pr-${context.pr}.md`,
		notes: config.notes,
		brand: config.brand ?? null,
	}
}

export function verify(root, options = {}) {
	const config = loadConfig(root)
	const context = report(root, options)
	const intents = context.paths.filter(path => path.startsWith(`${PENDING}/`))
	if (context.nonShipping) {
		if (intents.length > 0)
			throw new ReleaseError('Non-shipping changes must not add, edit or delete release intents')
		return context
	}
	if (!intents.includes(context.pendingPath) || !existsSync(file(root, context.pendingPath))) {
		throw new ReleaseError(
			`Shipping PR requires ${context.pendingPath}; run mise run os:release --pr ${context.pr}, write the intent, then verify it`,
			{ code: EXIT.missing },
		)
	}
	if (intents.length !== 1) throw new ReleaseError(`Only this PR intent may change: ${context.pendingPath}`)
	const before = execFileSync('git', ['ls-tree', context.mergeBase, '--', context.pendingPath], {
		cwd: root,
		encoding: 'utf8',
	})
	if (before.trim())
		throw new ReleaseError('This PR intent already exists on the base branch; do not overwrite another release')
	const intent = parseIntent(readFileSync(file(root, context.pendingPath), 'utf8'), config, context.pendingPath)
	if (intent.bump !== context.bump)
		throw new ReleaseError(`Labels require bump: ${context.bump}; the model does not choose the bump`)
	return { ...context, intent }
}

export function nextVersion(version, level) {
	if (!/^\d+\.\d+\.\d+$/.test(version)) throw new ReleaseError(`Expected stable semver version, got ${version}`)
	const values = version.split('.').map(Number)
	const index = { major: 0, minor: 1, patch: 2 }[level]
	if (index === undefined) throw new ReleaseError('Invalid bump level')
	values[index]++
	for (let i = index + 1; i < 3; i++) values[i] = 0
	return values.join('.')
}

function pending(root, config) {
	const dir = file(root, PENDING)
	if (!existsSync(dir)) return []
	return readdirSync(dir)
		.sort()
		.map(name => {
			if (!/^pr-[1-9]\d*\.md$/.test(name)) throw new ReleaseError(`Unexpected pending entry: ${name}`)
			const path = `${PENDING}/${name}`
			if (!lstatSync(file(root, path)).isFile()) throw new ReleaseError(`Not a regular intent: ${path}`)
			return {
				path,
				pr: Number(name.slice(3, -3)),
				...parseIntent(readFileSync(file(root, path), 'utf8'), config, path),
			}
		})
}

function existingNotes(root, config) {
	const notes = []
	if (config.notes.enabled && existsSync(file(root, config.notes.path))) {
		for (const name of readdirSync(file(root, config.notes.path)).filter(x => x.endsWith('.md'))) {
			const text = readFileSync(file(root, `${config.notes.path}/${name}`), 'utf8')
			const raw = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
			if (!raw) throw new ReleaseError(`Existing note has no frontmatter: ${name}`)
			const doc = parseDocument(raw[1])
			if (doc.errors.length > 0) throw new ReleaseError(`Invalid existing note: ${name}`)
			const date = Date.parse(String(doc.toJS().publishedAt))
			if (!Number.isFinite(date)) throw new ReleaseError(`Invalid existing publishedAt: ${name}`)
			notes.push({ path: `${config.notes.path}/${name}`, second: Math.floor(date / 1000) })
		}
	}
	return notes
}

function noteSuffix(intent) {
	const slug =
		intent.title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '')
			.slice(0, 90) || 'release'
	return `${slug}-pr-${intent.pr}.md`
}

function notePath(config, version, suffix, second) {
	const stamp = new Date(second * 1000).toISOString().slice(0, 16).replace('T', '-').replace(':', '')
	return `${config.notes.path}/${stamp}.v${version}.${suffix}`
}

export function planRelease(root, now = new Date()) {
	const config = loadConfig(root)
	const intents = pending(root, config)
	const current = JSON.parse(readFileSync(file(root, config.versionFile), 'utf8')).version
	if (intents.length === 0) return { released: false, version: current, intents: [], notes: [] }
	const bump = LEVELS[Math.max(...intents.map(intent => LEVELS.indexOf(intent.bump)))]
	const version = nextVersion(current, bump)
	let second = Math.floor(now.getTime() / 1000)
	if (!Number.isFinite(second)) throw new ReleaseError('Invalid release time')
	let previousPath = ''
	for (const note of existingNotes(root, config)) {
		second = Math.max(second, note.second + 1)
		if (note.path > previousPath) previousPath = note.path
	}
	const ordered = (config.notes.enabled ? intents : [])
		.map(intent => ({ intent, suffix: noteSuffix(intent) }))
		.sort((a, b) => {
			if (a.suffix < b.suffix) return -1
			return a.suffix > b.suffix ? 1 : 0
		})
	const notes = config.notes.enabled
		? ordered.map(({ intent, suffix }) => {
				let path = notePath(config, version, suffix, second)
				// Same-minute version strings can sort backwards (for example 1.2.9 -> 1.2.10).
				// Leave historical files intact and move only the new note to the next minute.
				if (path <= previousPath) {
					second = (Math.floor(second / 60) + 1) * 60
					path = notePath(config, version, suffix, second)
				}
				if (path <= previousPath) {
					throw new ReleaseError(
						`Inconsistent historical note chronology: ${previousPath}; check its filename and publishedAt`,
					)
				}
				const publishedAt = new Date(second++ * 1000).toISOString().replace('.000Z', 'Z')
				if (existsSync(file(root, path))) throw new ReleaseError(`Refusing to overwrite ${path}`)
				previousPath = path
				const meta = {
					title: `v${version} - ${intent.title}`,
					description: intent.description,
					publishedAt,
					tags: intent.tags,
				}
				return { path, content: `---\n${stringify(meta)}---\n\n${intent.body}\n` }
			})
		: []
	return { released: true, previousVersion: current, version, bump, intents, notes }
}

function validateNotes(root, config) {
	if (config.notes.enabled && config.notes.validateCommand) {
		const [command, ...args] = config.notes.validateCommand
		execFileSync(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
	}
}

export function apply(root, options = {}) {
	const config = loadConfig(root)
	const plan = planRelease(root, options.now)
	if (!plan.released) return plan
	if (git(root, 'status', '--porcelain', '--untracked-files=all'))
		throw new ReleaseError('Release apply requires a clean checkout with committed intents')
	const head = git(root, 'rev-parse', 'HEAD')
	const tags = git(root, 'show-ref', '--tags', '--head')
	const manifestPath = '.release/latest.json'
	file(root, manifestPath)
	try {
		execFileSync(config.bumpCommand[0], [...config.bumpCommand.slice(1), plan.bump], {
			cwd: root,
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		if (git(root, 'rev-parse', 'HEAD') !== head || git(root, 'show-ref', '--tags', '--head') !== tags)
			throw new ReleaseError('bumpCommand must only update files; it must not commit or tag')
		const actual = JSON.parse(readFileSync(file(root, config.versionFile), 'utf8')).version
		if (actual !== plan.version) throw new ReleaseError(`bumpCommand produced ${actual}, expected ${plan.version}`)
		for (const note of plan.notes) {
			mkdirSync(dirname(file(root, note.path)), { recursive: true })
			writeFileSync(file(root, note.path), note.content, { flag: 'wx' })
		}
		validateNotes(root, config)
		const manifest = {
			schemaVersion: 1,
			version: plan.version,
			sourceSha: head,
			triggerSha: options.triggerSha ?? process.env.GITHUB_SHA ?? head,
			prs: plan.intents.map(intent => intent.pr),
		}
		writeFileSync(file(root, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`)
		for (const intent of plan.intents) rmSync(file(root, intent.path))
		return plan
	} catch (error) {
		// Only our initially clean checkout is restored. A command that committed violates the contract:
		// do not rewrite that history; CI discards its checkout and fails for operator inspection.
		if (git(root, 'rev-parse', 'HEAD') === head) {
			const untracked = git(root, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)
			git(root, 'restore', '--staged', '--worktree', '--', '.')
			for (const path of untracked) rmSync(file(root, path), { force: true })
		}
		throw error
	}
}

export function cli(argv = process.argv.slice(2), root = process.cwd()) {
	const [command, ...args] = argv
	const options = {
		pr: process.env.RELEASE_PR,
		base: process.env.OS_BASE_REF,
		labels: JSON.parse(process.env.RELEASE_LABELS ?? '[]'),
	}
	for (let i = 0; i < args.length; i += 2) {
		const key = { '--pr': 'pr', '--base': 'base', '--labels': 'labels' }[args[i]]
		if (!key || args[i + 1] === undefined)
			throw new ReleaseError(`Unknown or incomplete option: ${args[i]}`, { code: EXIT.context })
		options[key] = key === 'labels' ? JSON.parse(args[i + 1]) : args[i + 1]
	}
	if (command === 'report') console.info(JSON.stringify(report(root, options), null, 2))
	else if (command === 'verify') console.info(JSON.stringify(verify(root, options), null, 2))
	else if (command === 'apply') console.info(apply(root).version)
	else
		throw new ReleaseError('Usage: os-release report|verify|apply [--pr N] [--base ref] [--labels JSON]', {
			code: EXIT.context,
		})
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	try {
		cli()
	} catch (error) {
		console.error(error.message)
		process.exitCode = error.code && Number.isInteger(error.code) ? error.code : 1
	}
}
