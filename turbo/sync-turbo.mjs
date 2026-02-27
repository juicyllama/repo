import { access, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')
const initCwd = process.env.INIT_CWD
const targetRoot = initCwd ? resolve(initCwd) : process.cwd()

// Don't execute in own repo as it would overwrite the base turbo.json file
if (targetRoot === packageRoot) {
	console.warn('Skipping turbo.json generation in self')
	process.exit(0)
}

const root = targetRoot
const sharedPath = resolve(root, 'turbo.shared.json')
const basePath = resolve(packageRoot, 'turbo.json')
const outputPath = resolve(root, 'turbo.json')

const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const exists = async path => {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

if (!(await exists(sharedPath))) {
	console.warn(
		`Skipping turbo.json generation: missing ${sharedPath}. ` + 'Create turbo.shared.json in your project root.',
	)
	process.exit(0)
}

let shared
try {
	shared = await readJson(sharedPath)
} catch (error) {
	console.error(`Failed to read ${sharedPath}. Ensure it contains valid JSON.`)
	console.error(error instanceof Error ? error.message : error)
	process.exit(1)
}

const extendsList = Array.isArray(shared.extends)
	? shared.extends
	: typeof shared.extends === 'string'
		? [shared.extends]
		: []
const shouldLoadBase = extendsList.includes('@juicyllama/repo/turbo')

let base = {}
let baseStatus = 'not-requested'
if (shouldLoadBase) {
	if (!(await exists(basePath))) {
		baseStatus = 'missing'
		console.warn(`Base turbo.json not found at ${basePath}. ` + 'Continuing with turbo.shared.json only.')
	} else {
		try {
			base = await readJson(basePath)
			baseStatus = 'merged'
		} catch (error) {
			baseStatus = 'invalid'
			console.error(`Failed to read base turbo.json at ${basePath}. ` + 'Continuing with turbo.shared.json only.')
			console.error(error instanceof Error ? error.message : error)
		}
	}
}

const mergedGlobalEnv = Array.from(new Set([...(base.globalEnv ?? []), ...(shared.globalEnv ?? [])]))

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
console.log(`Generated turbo.json at ${outputPath}. Base merge: ${baseStatus}.`)
