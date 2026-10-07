import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('npm bin symlinks execute every CLI rather than silently doing nothing', () => {
	const root = mkdtempSync(join(tmpdir(), 'release-bin-'))
	try {
		for (const [name, expected] of [
			['os-release', /Usage: os-release/],
			['ci-release', /only runs on main/],
			['github-verify', /GITHUB_EVENT_PATH|path.*argument/],
			['npm-publish', /Pass package directories/],
		]) {
			const bin = join(root, name)
			symlinkSync(fileURLToPath(new URL(`./${name}.mjs`, import.meta.url)), bin)
			const result = spawnSync(process.execPath, [bin], { cwd: root, encoding: 'utf8', env: {} })
			assert.notEqual(result.status, 0, `${name} must execute its argument/context validation`)
			assert.match(result.stderr, expected)
		}
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
