import { access, copyFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')
// biome-ignore lint/suspicious/noUndeclaredEnvVars: INIT_CWD is set by npm/pnpm during postinstall, not a turbo task input
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

// Scaffold once, never clobber — the same contract .husky/sync.mjs already honours.
// Consumers edit DEVELOPMENT.md to document their own repo, and this runs on every
// `npm install`, so overwriting it silently discarded that work: the change reappeared
// as an unexplained diff, got committed, and took any repo-specific guidance with it.
//
// Branching rather than exiting early: npm gives postinstall a pipe for stdout, where
// writes are async, and process.exit would drop this line before it flushed.
if (await exists(outputPath)) {
	console.info(`Skipping DEVELOPMENT.md sync: ${outputPath} already exists.`)
} else {
	await copyFile(sourcePath, outputPath)
	console.info(`Copied DEVELOPMENT.md to ${outputPath}.`)
}
