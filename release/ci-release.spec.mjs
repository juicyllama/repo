import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, it } from 'node:test'
import { ensureTag, release } from './ci-release.mjs'
import { apply, git } from './os-release.mjs'

let dir
let root
let remote
let writer
let source
function commit(where, message) {
	git(where, 'add', '.')
	git(where, 'commit', '-qm', message)
}
function intent(where, pr) {
	mkdirSync(join(where, '.release/pending'), { recursive: true })
	writeFileSync(
		join(where, `.release/pending/pr-${pr}.md`),
		`---\nbump: patch\ntitle: Fix checkout ${pr}\ndescription: Payment succeeds.\ntags: [Fix]\n---\n`,
	)
}
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'release-git-'))
	root = join(dir, 'ci')
	remote = join(dir, 'remote.git')
	writer = join(dir, 'writer')
	mkdirSync(root)
	git(root, 'init', '-q', '-b', 'main')
	git(root, 'config', 'user.name', 'Test')
	git(root, 'config', 'user.email', 'test@example.com')
	git(root, 'config', 'core.hooksPath', '/dev/null')
	mkdirSync(join(root, '.release'))
	writeFileSync(
		join(root, '.release/config.json'),
		JSON.stringify({
			schemaVersion: 1,
			versionFile: 'package.json',
			bumpCommand: ['node', 'bump.cjs'],
			nonShipping: [],
			notes: { enabled: false },
		}),
	)
	writeFileSync(join(root, 'package.json'), '{"version":"1.0.0"}\n')
	writeFileSync(
		join(root, 'bump.cjs'),
		`const fs=require('node:fs');const p=JSON.parse(fs.readFileSync('package.json'));p.version='1.0.'+(Number(p.version.split('.')[2])+1);fs.writeFileSync('package.json',JSON.stringify(p)+'\\n')`,
	)
	intent(root, 1)
	commit(root, 'Shipping merge')
	source = git(root, 'rev-parse', 'HEAD')
	git(dir, 'clone', '--bare', root, remote)
	git(root, 'remote', 'add', 'origin', remote)
	git(dir, 'clone', remote, writer)
	git(writer, 'config', 'user.name', 'Other')
	git(writer, 'config', 'user.email', 'other@example.com')
	git(writer, 'config', 'core.hooksPath', '/dev/null')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))
function options(extra = {}) {
	return {
		triggerSha: source,
		setup: () => {},
		checkCi: async () => {},
		applyRelease: () => apply(root, { triggerSha: source }),
		publishTag: (version, sha) => ensureTag(root, version, sha, async () => {}),
		...extra,
	}
}

it('pushes the release commit before the tag and recovers a repeated run without bumping', async () => {
	const result = await release(root, options())
	assert.equal(result.version, '1.0.1')
	assert.equal(git(remote, 'rev-parse', 'main'), result.sha)
	assert.equal(git(remote, 'rev-parse', 'v1.0.1'), result.sha)
	const repeated = await release(root, options())
	assert.equal(repeated.sha, result.sha)
	assert.equal(git(remote, 'rev-list', '--count', 'main'), '2')
})

it('does not bump or tag a source commit whose CI failed', async () => {
	await assert.rejects(
		release(
			root,
			options({
				checkCi: async () => {
					throw new Error('CI failed')
				},
			}),
		),
		/CI failed/,
	)
	assert.equal(git(remote, 'rev-parse', 'main'), source)
	assert.equal(git(remote, 'tag'), '')
})

it('rechecks CI when a merge arrives while waiting, and includes both intents once', async () => {
	const checked = []
	const result = await release(
		root,
		options({
			checkCi: async sha => {
				checked.push(sha)
				if (checked.length === 1) {
					intent(writer, 2)
					commit(writer, 'Second merge')
					git(writer, 'push', 'origin', 'main')
				}
			},
		}),
	)
	assert.equal(checked.length, 2)
	assert.notEqual(checked[0], checked[1])
	assert.equal(result.version, '1.0.1')
	assert.deepEqual(JSON.parse(readFileSync(join(root, '.release/latest.json'))).prs, [1, 2])
})

it('retries a branch push race without publishing a tag for the rejected commit', async () => {
	let applied = 0
	const result = await release(
		root,
		options({
			applyRelease: () => {
				apply(root, { triggerSha: source })
				if (++applied === 1) {
					intent(writer, 2)
					commit(writer, 'Concurrent merge')
					git(writer, 'push', 'origin', 'main')
				}
			},
		}),
	)
	assert.equal(applied, 2)
	assert.equal(result.version, '1.0.1')
	assert.equal(git(remote, 'tag'), 'v1.0.1')
	assert.deepEqual(JSON.parse(readFileSync(join(root, '.release/latest.json'))).prs, [1, 2])
})

it('recovers a tag failure after the branch was accepted without a second bump', async () => {
	await assert.rejects(
		release(
			root,
			options({
				publishTag: async () => {
					throw new Error('network failure')
				},
			}),
		),
		/network failure/,
	)
	const accepted = git(remote, 'rev-parse', 'main')
	assert.equal(git(remote, 'tag'), '')
	const result = await release(root, options())
	assert.equal(result.sha, accepted)
	assert.equal(result.version, '1.0.1')
	assert.equal(git(remote, 'rev-parse', 'v1.0.1'), accepted)
})

it('does not redispatch the previous release on a later non-shipping merge', async () => {
	await release(root, options())
	writeFileSync(join(root, 'test.spec.js'), 'test')
	commit(root, 'Tests only')
	git(root, 'push', 'origin', 'main')
	const triggerSha = git(root, 'rev-parse', 'HEAD')
	assert.equal((await release(root, options({ triggerSha }))).released, false)
})

it('never moves an existing tag that belongs to main', async () => {
	git(root, 'push', 'origin', `${source}:refs/tags/v1.0.1`)
	await assert.rejects(release(root, options()), /Refusing to replace existing tag/)
	assert.equal(git(remote, 'rev-parse', 'v1.0.1'), source)
})
