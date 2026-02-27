import { access, copyFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')
const initCwd = process.env.INIT_CWD
const targetRoot = initCwd ? resolve(initCwd) : process.cwd()

// Don't execute in own repo as it would overwrite the base DEVELOPMENT.md file
if (targetRoot === packageRoot) {
	console.warn('Skipping DEVELOPMENT.md sync in self')
	process.exit(0)
}

const sourcePath = resolve(packageRoot, 'agentic', 'DEVELOPMENT.md')
const outputPath = resolve(targetRoot, 'DEVELOPMENT.md')

const exists = async path => {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

if (!(await exists(sourcePath))) {
	console.warn(`Skipping DEVELOPMENT.md sync: missing ${sourcePath}.`)
	process.exit(0)
}

await copyFile(sourcePath, outputPath)
console.log(`Copied DEVELOPMENT.md to ${outputPath}.`)
