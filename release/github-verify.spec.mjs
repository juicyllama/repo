import assert from 'node:assert/strict'
import { it } from 'node:test'
import { prContext } from './github-verify.mjs'

const labels = names => ({ nodes: names.map(name => ({ name })), pageInfo: { hasNextPage: false } })
const pr = () => ({
	number: 12,
	headRefOid: 'a'.repeat(40),
	baseRefOid: 'b'.repeat(40),
	labels: labels(['fix']),
	closingIssuesReferences: { nodes: [{ labels: labels(['major']) }], pageInfo: { hasNextPage: false } },
})
it('uses live PR and linked issue labels for version verification', () => {
	assert.deepEqual(prContext(pr()).labels, ['fix', 'major'])
})
it('refuses truncated labels or linked issues rather than defaulting to patch', () => {
	for (const path of ['labels', 'closingIssuesReferences']) {
		const input = pr()
		input[path].pageInfo.hasNextPage = true
		assert.throws(() => prContext(input), /Incomplete/)
	}
	const input = pr()
	input.closingIssuesReferences.nodes[0].labels.pageInfo.hasNextPage = true
	assert.throws(() => prContext(input), /Incomplete/)
})
