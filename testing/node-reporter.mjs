import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { spec } from 'node:test/reporters'

/** Retain native Node test evidence while preserving the standard console reporter. */
export default async function* reporter(source) {
	const failures = []
	/** Observe runner events without changing their ordering or test outcome. */
	async function* observe() {
		for await (const event of source) {
			if (
				event.type === 'test:fail' &&
				event.data.todo === undefined &&
				event.data.details?.error?.failureType !== 'subtestsFailed'
			) {
				failures.push({ name: event.data.name, file: event.data.file ?? null })
			}
			if (event.type === 'test:summary' && !event.data.file && process.env.OS_TEST_REPORT_DIR) {
				try {
					writeFileSync(
						join(process.env.OS_TEST_REPORT_DIR, `node-${process.pid}.json`),
						JSON.stringify({ runner: 'node', ...event.data, failures }),
					)
				} catch (error) {
					process.stderr.write(`Test reporting unavailable: ${error.message}\n`)
				}
			}
			yield event
		}
	}
	yield* Readable.from(observe()).pipe(spec())
}
