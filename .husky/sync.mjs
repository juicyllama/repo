import { access, cp } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir)
const initCwd = process.env.INIT_CWD
const targetRoot = initCwd ? resolve(initCwd) : process.cwd()

// Don't execute in own repo as it would overwrite local husky hooks
if (targetRoot === packageRoot) {
	console.warn('Skipping .husky sync in self')
	process.exit(0)
}

const sourcePath = resolve(packageRoot, '.husky')
const outputPath = resolve(targetRoot, '.husky')

const exists = async path => {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

if (!(await exists(sourcePath))) {
	console.warn(`Skipping .husky sync: missing ${sourcePath}.`)
	process.exit(0)
}

if (await exists(outputPath)) {
	console.log(`Skipping .husky sync: ${outputPath} already exists.`)
	process.exit(0)
}

await cp(sourcePath, outputPath, { recursive: true })
console.log(`Copied .husky to ${outputPath}.`)
