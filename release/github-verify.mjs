#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { git, verify } from './os-release.mjs'

export function prContext(pr) {
	if (!pr || !/^[a-f0-9]{40}$/.test(pr.headRefOid) || !/^[a-f0-9]{40}$/.test(pr.baseRefOid))
		throw new Error('Cannot determine exact PR head and base')
	const labels = new Set()
	const collect = connection => {
		if (!connection || connection.pageInfo?.hasNextPage)
			throw new Error('Incomplete label listing; cannot determine release bump')
		for (const node of connection.nodes) labels.add(node.name)
	}
	collect(pr.labels)
	if (!pr.closingIssuesReferences || pr.closingIssuesReferences.pageInfo.hasNextPage)
		throw new Error('Incomplete linked-issue listing; cannot determine release bump')
	for (const issue of pr.closingIssuesReferences.nodes) collect(issue.labels)
	return { pr: pr.number, base: pr.baseRefOid, head: pr.headRefOid, labels: [...labels] }
}

export function main(root = process.cwd()) {
	const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
	const number = event.pull_request?.number
	const [owner, name] = (process.env.GITHUB_REPOSITORY ?? '').split('/')
	if (!Number.isInteger(number) || number < 1 || !owner || !name)
		throw new Error('PR event and GITHUB_REPOSITORY are required')
	const query =
		'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number headRefOid baseRefOid labels(first:100){nodes{name} pageInfo{hasNextPage}} closingIssuesReferences(first:100){nodes{labels(first:100){nodes{name} pageInfo{hasNextPage}}} pageInfo{hasNextPage}}}}}'
	const result = JSON.parse(
		execFileSync(
			'gh',
			[
				'api',
				'graphql',
				'-f',
				`query=${query}`,
				'-f',
				`owner=${owner}`,
				'-f',
				`name=${name}`,
				'-F',
				`number=${number}`,
			],
			{ cwd: root, encoding: 'utf8' },
		),
	)
	if (result.errors) throw new Error('GitHub could not read PR and linked-issue labels')
	const context = prContext(result.data?.repository?.pullRequest)
	if (git(root, 'rev-parse', 'HEAD') !== context.head)
		throw new Error('PR head changed; rerun this check on the latest head')
	console.info(JSON.stringify(verify(root, context), null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		main()
	} catch (error) {
		console.error(error.message)
		process.exitCode = Number.isInteger(error.code) ? error.code : 1
	}
}
