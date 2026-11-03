import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { it } from 'node:test'

// Biome rejects a configuration that names a rule it does not know, and a rule that leaves `nursery` is unknown
// there from that release on. Every consumer extends these files, so check them against the pinned Biome here
// rather than in each repository after the next upgrade.
const biome = createRequire(import.meta.url).resolve('@biomejs/biome/bin/biome')
const pinned = JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).devDependencies['@biomejs/biome']

for (const config of ['biome.json', 'biome-nestjs.json']) {
	it(`${config} loads in Biome ${pinned}`, () => {
		const { status, stdout, stderr } = spawnSync(
			process.execPath,
			[biome, 'lint', `--config-path=${config}`, '--max-diagnostics=0', 'package.json'],
			{ cwd: import.meta.dirname, encoding: 'utf8' },
		)
		assert.equal(status, 0, stdout + stderr)
	})

	it(`${config} declares the pinned Biome schema`, () => {
		const { $schema } = JSON.parse(readFileSync(new URL(`./${config}`, import.meta.url)))
		assert.equal($schema, `https://biomejs.dev/schemas/${pinned}/schema.json`)
	})
}
