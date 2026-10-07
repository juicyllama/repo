import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isPublished, publishTarball } from './npm-publish.mjs'

const pkg = { name: '@test/pkg', version: '1.2.3', tarball: '/tmp/test.tgz' }
const failure = code => {
	throw new Error(code)
}
test('registry checks distinguish missing versions from denied or unavailable registry access', () => {
	assert.equal(
		isPublished(pkg.name, pkg.version, () => '"1.2.3"'),
		true,
	)
	assert.equal(
		isPublished(pkg.name, pkg.version, () => failure('E404')),
		false,
	)
	for (const code of ['E403', 'ETIMEDOUT', 'E500'])
		assert.throws(() => isPublished(pkg.name, pkg.version, () => failure(code)), new RegExp(code))
})
test('an already published version needs no publish attempt', async () => {
	assert.equal(
		await publishTarball(pkg, {
			run: (_cmd, args) => {
				assert.equal(args[0], 'view')
				return '"1.2.3"'
			},
		}),
		false,
	)
})
test('permission errors do not masquerade as already published versions', async () => {
	await assert.rejects(
		publishTarball(pkg, { run: (_cmd, args) => failure(args[0] === 'view' ? 'E404' : 'E403') }),
		/E403/,
	)
})
test('a partial publish whose response was lost is recovered by the exact registry version', async () => {
	let pushed = false
	assert.equal(
		await publishTarball(pkg, {
			run: (_cmd, args) => {
				if (args[0] === 'publish') {
					pushed = true
					return failure('ECONNRESET')
				}
				if (!pushed) return failure('E404')
				return '"1.2.3"'
			},
		}),
		false,
	)
})
test('transient packument conflicts retry, with a bounded failure', async () => {
	let attempts = 0
	await assert.rejects(
		publishTarball(pkg, {
			pause: async () => {},
			run: (_cmd, args) => {
				if (args[0] === 'publish') {
					attempts++
					return failure('E409')
				}
				return failure('E404')
			},
		}),
		/E409/,
	)
	assert.equal(attempts, 3)
})
