import { access, copyFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')
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

const copyDir = async (src, dest) => {
	await mkdir(dest, { recursive: true })
	const entries = await readdir(src, { withFileTypes: true })
	await Promise.all(
		entries.map(async entry => {
			if (entry.name === 'sync.mjs') return
			const srcPath = resolve(src, entry.name)
			const destPath = resolve(dest, entry.name)
			if (entry.isDirectory()) {
				await copyDir(srcPath, destPath)
			} else if (entry.isFile()) {
				await copyFile(srcPath, destPath)
			}
		}),
	)
}

await copyDir(sourcePath, outputPath)
console.log(`Copied .husky to ${outputPath} (excluding sync.mjs).`)
