#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { git } from './os-release.mjs'

const registry = 'https://registry.npmjs.org/'
const command = (cmd, args, cwd) =>
	execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const details = error => `${error.message}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`

export function isPublished(name, version, run = command) {
	try {
		const found = JSON.parse(
			run('npm', ['view', `${name}@${version}`, 'version', '--json', `--registry=${registry}`]),
		)
		if (found !== version) throw new Error(`Unexpected registry version for ${name}@${version}`)
		return true
	} catch (error) {
		if (/\bE404\b/.test(details(error))) return false
		throw error // Authentication and network failures are never evidence of absence.
	}
}

export async function publishTarball({ name, version, tarball }, { run = command, pause = sleep } = {}) {
	if (isPublished(name, version, run)) return false
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			run('npm', ['publish', tarball, '--access=public', `--registry=${registry}`], tmpdir())
			return true
		} catch (error) {
			// A lost response or concurrent publisher is successful only when this exact version is visible.
			if (isPublished(name, version, run)) return false
			if (!/\bE409\b|Failed to save packument/.test(details(error)) || attempt === 2) throw error
			await pause(30_000 * (attempt + 1))
		}
	}
	return false
}

async function packAndPublish(root, pkg, version, run, pause) {
	const dir = mkdtempSync(join(tmpdir(), 'os-publish-'))
	try {
		run('pnpm', ['pack', '--pack-destination', dir], join(root, pkg.dir))
		const tarballs = readdirSync(dir).filter(file => file.endsWith('.tgz'))
		if (tarballs.length !== 1) throw new Error(`Expected exactly one tarball for ${pkg.name}`)
		return await publishTarball({ name: pkg.name, version, tarball: join(dir, tarballs[0]) }, { run, pause })
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

export async function publish(root, dirs, { run = command, pause = sleep, ref = process.env.GITHUB_REF } = {}) {
	if (dirs.length === 0) throw new Error('Pass package directories in dependency order')
	const packages = dirs.map(dir => ({ ...JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')), dir }))
	const version = packages[0].version
	if (!/^\d+\.\d+\.\d+$/.test(version) || ref !== `refs/tags/v${version}`)
		throw new Error('Publish must be dispatched at the release version tag')
	if (git(root, 'rev-parse', `refs/tags/v${version}^{}`) !== git(root, 'rev-parse', 'HEAD'))
		throw new Error('Checkout does not match the release tag')
	for (const pkg of packages) {
		if (pkg.private || pkg.publishConfig?.access !== 'public' || pkg.version !== version)
			throw new Error(`Invalid publish configuration or mismatched version: ${pkg.name}`)
	}
	let published = false
	for (const pkg of packages) {
		if (isPublished(pkg.name, version, run)) continue
		published = (await packAndPublish(root, pkg, version, run, pause)) || published
	}
	for (let attempt = 0; attempt < 60; attempt++) {
		if (packages.every(pkg => isPublished(pkg.name, version, run))) return { version, published }
		await pause(15_000)
	}
	throw new Error(`Not all packages are visible at ${version}; rerun this release`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	publish(process.cwd(), process.argv.slice(2))
		.then(result => {
			for (const [key, value] of Object.entries(result)) {
				if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
			}
			console.info(JSON.stringify(result))
		})
		.catch(error => {
			console.error(details(error))
			process.exitCode = 1
		})
}
