#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { git, loadConfig, planRelease } from './os-release.mjs'

const SHA = /^[a-f0-9]{40}$/
const VERSION = /^\d+\.\d+\.\d+$/
function run(root, command, args) {
	return execFileSync(command, args, {
		cwd: root,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		maxBuffer: 16 * 1024 * 1024,
	}).trim()
}
function remoteTag(root, tag) {
	return (
		git(root, 'ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`)
			.split('\n')
			.filter(Boolean)
			.sort((a, b) => Number(b.includes('^{}')) - Number(a.includes('^{}')))[0]
			?.split(/\s/)[0] ?? null
	)
}

function removeOrphanTag(root, tag, existing, version) {
	// Recover only a demonstrably orphaned release created by this protocol, never an arbitrary tag.
	git(root, 'fetch', 'origin', `refs/tags/${tag}`)
	let orphan = false
	try {
		git(root, 'merge-base', '--is-ancestor', existing, 'origin/main')
	} catch {
		orphan = true
	}
	let manifest
	try {
		manifest = JSON.parse(git(root, 'show', `${existing}:.release/latest.json`))
	} catch {
		/* Not our tag. */
	}
	if (
		!orphan ||
		manifest?.version !== version ||
		git(root, 'log', '-1', '--format=%s', existing) !== `chore(release): v${version}`
	)
		throw new Error(`Refusing to replace existing tag ${tag}`)
	git(root, 'push', 'origin', `:refs/tags/${tag}`)
}

export async function ensureTag(root, version, sha, pause = sleep) {
	if (!VERSION.test(version) || !SHA.test(sha)) throw new Error('Invalid release version or SHA')
	const tag = `v${version}`
	const existing = remoteTag(root, tag)
	if (existing === sha) return
	if (existing) removeOrphanTag(root, tag, existing, version)
	// Push the already accepted commit directly to the tag ref. No local tag collision is possible.
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			git(root, 'push', 'origin', `${sha}:refs/tags/${tag}`)
			return
		} catch (error) {
			if (remoteTag(root, tag) === sha) return
			if (attempt === 2) throw error
			await pause(2000)
		}
	}
}

export async function waitForCi(
	root,
	sha,
	{ workflow = process.env.RELEASE_CI_WORKFLOW ?? 'ci.yml', timeoutMs = 1_200_000, pause = sleep } = {},
) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const runs = JSON.parse(
			run(root, 'gh', [
				'run',
				'list',
				'--workflow',
				workflow,
				'--commit',
				sha,
				'--event',
				'push',
				'--limit',
				'100',
				'--json',
				'headSha,status,conclusion,databaseId',
			]),
		)
		const current = runs.filter(item => item.headSha === sha).sort((a, b) => b.databaseId - a.databaseId)[0]
		if (current?.status === 'completed') {
			if (current.conclusion !== 'success')
				throw new Error(`CI ${workflow} for ${sha} ended ${current.conclusion}`)
			return
		}
		await pause(10_000)
	}
	throw new Error(`Timed out waiting for CI ${workflow} on ${sha}; no release was cut`)
}

export function recovery(root, { triggerSha, manual = false } = {}) {
	const path = '.release/latest.json'
	if (!existsSync(join(root, path))) return null
	const manifest = JSON.parse(readFileSync(join(root, path), 'utf8'))
	if (!VERSION.test(manifest.version) || !SHA.test(manifest.sourceSha)) throw new Error('Invalid release manifest')
	const sha = git(root, 'log', '-1', '--format=%H', '--', path)
	if (
		git(root, 'log', '-1', '--format=%s', sha) !== `chore(release): v${manifest.version}` ||
		git(root, 'rev-parse', `${sha}^`) !== manifest.sourceSha
	)
		throw new Error('Release manifest is not on its release commit')
	const config = loadConfig(root)
	if (JSON.parse(readFileSync(join(root, config.versionFile), 'utf8')).version !== manifest.version)
		throw new Error('Version changed outside the release protocol')
	if (!manual && manifest.triggerSha !== triggerSha && manifest.sourceSha !== triggerSha && sha !== triggerSha)
		return null
	return { released: true, version: manifest.version, sha, sourceSha: manifest.sourceSha }
}

async function prepareCommit(root, sourceSha, plan, setup, applyRelease) {
	await setup()
	if (git(root, 'status', '--porcelain', '--untracked-files=all'))
		throw new Error('Dependency setup changed tracked or untracked files; release refused')
	await applyRelease()
	if (git(root, 'rev-parse', 'HEAD') !== sourceSha)
		throw new Error('release must not commit; the reusable workflow owns the commit and tag')
	const manifest = JSON.parse(readFileSync(join(root, '.release/latest.json'), 'utf8'))
	if (manifest.version !== plan.version || manifest.sourceSha !== sourceSha)
		throw new Error('Release output does not match the validated plan')
	git(root, 'add', '--all')
	git(root, 'commit', '-m', `chore(release): v${plan.version}`)
	return git(root, 'rev-parse', 'HEAD')
}

function pushMain(root, sha, sourceSha, attempt) {
	try {
		git(root, 'push', 'origin', 'HEAD:refs/heads/main')
		return true
	} catch (error) {
		git(root, 'fetch', 'origin', 'main')
		const remote = git(root, 'rev-parse', 'origin/main')
		if (remote === sha) return true // Accepted, but the response was lost.
		if (remote === sourceSha || attempt === 2) throw error
		return false // A concurrent merge won. Re-plan against that commit after its CI passes.
	}
}

async function recoverOrSkip(root, plan, sourceSha, options, checkCi, publishTag) {
	const previous = recovery(root, options)
	if (!previous) return { released: false, version: plan.version, sha: sourceSha }
	await checkCi(previous.sourceSha)
	await publishTag(previous.version, previous.sha)
	return previous
}

export async function release(root, options = {}) {
	const checkCi = options.checkCi ?? (sha => waitForCi(root, sha))
	const setup =
		options.setup ??
		(() => {
			const command = process.env.RELEASE_INSTALL_COMMAND
			if (!command) throw new Error('RELEASE_INSTALL_COMMAND is required')
			run(root, 'bash', ['-e', '-o', 'pipefail', '-c', command])
		})
	const applyRelease = options.applyRelease ?? (() => run(root, 'mise', ['run', 'release']))
	const publishTag = options.publishTag ?? ((version, sha) => ensureTag(root, version, sha))
	if (git(root, 'status', '--porcelain', '--untracked-files=all'))
		throw new Error('CI release requires an initially clean checkout')
	for (let attempt = 0; attempt < 3; attempt++) {
		git(root, 'fetch', 'origin', 'main')
		// This function runs only in a disposable CI checkout; a rejected release is never pushed by force.
		git(root, 'checkout', '-B', 'main', 'origin/main')
		const sourceSha = git(root, 'rev-parse', 'HEAD')
		const plan = planRelease(root)
		if (!plan.released) {
			return recoverOrSkip(root, plan, sourceSha, options, checkCi, publishTag)
		}
		await checkCi(sourceSha)
		git(root, 'fetch', 'origin', 'main')
		if (git(root, 'rev-parse', 'origin/main') !== sourceSha) continue
		const sha = await prepareCommit(root, sourceSha, plan, setup, applyRelease)
		if (!pushMain(root, sha, sourceSha, attempt)) continue
		await publishTag(plan.version, sha)
		return { released: true, version: plan.version, sha, sourceSha }
	}
	throw new Error('main kept moving; no release was pushed. Retry after CI settles.')
}

export async function main() {
	if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main')
		throw new Error('CI release only runs on main in GitHub Actions')
	const root = process.cwd()
	git(root, 'config', 'user.name', 'github-actions[bot]')
	git(root, 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
	const result = await release(root, {
		triggerSha: process.env.GITHUB_SHA,
		manual: process.env.GITHUB_EVENT_NAME === 'workflow_dispatch',
	})
	for (const [name, value] of Object.entries(result)) {
		if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
	}
	console.info(JSON.stringify(result))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch(error => {
		console.error(error.message)
		process.exitCode = 1
	})
}
