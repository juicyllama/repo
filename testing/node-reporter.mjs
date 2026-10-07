import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { spec } from 'node:test/reporters'

export default async function* reporter(source) {
	const failures = []
	async function* observe() {
		for await (const event of source) {
			if (event.type === 'test:fail' && event.data.details?.error?.failureType !== 'subtestsFailed') {
				failures.push({ name: event.data.name, file: event.data.file ?? null })
			}
			if (event.type === 'test:summary' && !event.data.file && process.env.OS_TEST_REPORT_DIR) {
				writeFileSync(
					join(process.env.OS_TEST_REPORT_DIR, `node-${process.pid}.json`),
					JSON.stringify({ runner: 'node', ...event.data, failures }),
				)
			}
			yield event
		}
	}
	yield* Readable.from(observe()).pipe(spec())
}
