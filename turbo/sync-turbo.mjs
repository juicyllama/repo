import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { name } = require('../package.json')

//Dont execute in own repo as would overwrite the base turbo.json file
if (name === '@juicyllama/repo') {
	console.warn('Skipping turbo.json generation in self');
	process.exit(0);
}

const root = process.cwd()
const sharedPath = resolve(root, 'turbo.shared.json')
const basePath = resolve(root, 'node_modules/@juicyllama/repo/turbo.json')
const outputPath = resolve(root, 'turbo.json')

const readJson = async path => JSON.parse(await readFile(path, 'utf8'))

const shared = await readJson(sharedPath)

const extendsList = Array.isArray(shared.extends) ? shared.extends : []
const shouldLoadBase = extendsList.includes('@juicyllama/repo/turbo')

const base = shouldLoadBase ? await readJson(basePath) : {}

const mergedGlobalEnv = Array.from(
	new Set([...(base.globalEnv ?? []), ...(shared.globalEnv ?? [])]),
)

const mergedTasks = {
	...(base.tasks ?? {}),
	...(shared.tasks ?? {}),
}

const merged = {
	...base,
	...shared,
	globalEnv: mergedGlobalEnv.length ? mergedGlobalEnv : undefined,
	tasks: Object.keys(mergedTasks).length ? mergedTasks : undefined,
}

delete merged.extends

const output = `${JSON.stringify(merged, null, 2)}\n`
await writeFile(outputPath, output)
