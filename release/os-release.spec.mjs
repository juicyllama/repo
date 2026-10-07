import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
	apply,
	EXIT,
	git,
	isNonShipping,
	labelBump,
	loadConfig,
	parseIntent,
	planRelease,
	report,
	verify,
} from './os-release.mjs'

const script = fileURLToPath(new URL('./os-release.mjs', import.meta.url))
let root
const intent = (bump = 'patch', title = 'Wallet focus survives navigation') =>
	`---\nbump: ${bump}\ntitle: ${title}\ndescription: Buyers can return to checkout.\ntags: [Fix, React SDK]\n---\n\n### What changed\n\nWallet sheets stay open when focus changes.\n\n### Why it matters\n\nBuyers can finish paying.\n\n### Developer notes\n\nNo integration changes are required.\n`
function write(path, content) {
	mkdirSync(dirname(join(root, path)), { recursive: true })
	writeFileSync(join(root, path), content)
}
function commit() {
	git(root, 'add', '.')
	git(root, 'commit', '-qm', 'fixture')
}
function addIntent(pr = 12, bump = 'patch') {
	write(`.release/pending/pr-${pr}.md`, intent(bump))
}
function shipping() {
	write('src/index.js', 'export const fixed = true\n')
}
const options = { pr: 12, base: 'main' }

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'os-release-test-'))
	git(root, 'init', '-q', '-b', 'main')
	git(root, 'config', 'user.name', 'Test')
	git(root, 'config', 'user.email', 'test@example.com')
	git(root, 'config', 'core.hooksPath', '/dev/null')
	write('package.json', '{"version":"1.2.3"}\n')
	write(
		'.release/config.json',
		JSON.stringify({
			schemaVersion: 1,
			versionFile: 'package.json',
			bumpCommand: ['node', 'bump.cjs'],
			nonShipping: ['tests/**', '**/*.spec.js'],
			notes: {
				enabled: true,
				format: 'openchangelog',
				path: 'release-notes',
				audience: 'Developers',
				style: ['Explain what changed and why it matters.'],
			},
			brand: { name: 'Flopay', avoid: ['FloPay'] },
		}),
	)
	write(
		'bump.cjs',
		`const fs=require('node:fs');const p=JSON.parse(fs.readFileSync('package.json'));const v=p.version.split('.').map(Number);const i={major:0,minor:1,patch:2}[process.argv[2]];v[i]++;for(let j=i+1;j<3;j++)v[j]=0;p.version=v.join('.');fs.writeFileSync('package.json',JSON.stringify(p)+'\\n')`,
	)
	write('src/index.js', 'export const fixed = false\n')
	commit()
	git(root, 'switch', '-qc', 'feature')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('PR release contract', () => {
	it('reports a non-shipping diff without demanding an intent', () => {
		write('tests/wallet.spec.js', 'test\n')
		assert.equal(report(root, options).nonShipping, true)
		assert.equal(verify(root, options).nonShipping, true)
	})
	it('reports the contract and verifies an uncommitted shipping intent', () => {
		shipping()
		addIntent()
		assert.equal(report(root, options).pendingPath, '.release/pending/pr-12.md')
		assert.equal(verify(root, options).intent.bump, 'patch')
	})
	it('fails missing intent with an actionable distinct exit code', () => {
		shipping()
		const result = spawnSync(process.execPath, [script, 'verify', '--pr', '12', '--base', 'main'], {
			cwd: root,
			encoding: 'utf8',
		})
		assert.equal(result.status, EXIT.missing)
		assert.match(result.stderr, /\.release\/pending\/pr-12.md/)
	})
	it('never treats an unreadable base as a non-shipping diff', () => {
		assert.throws(
			() => report(root, { ...options, base: 'missing' }),
			error => error.code === EXIT.context,
		)
	})
	it('detects deletion and renaming shipping code into a test path', () => {
		mkdirSync(join(root, 'tests'))
		git(root, 'mv', 'src/index.js', 'tests/index.spec.js')
		assert.equal(report(root, options).nonShipping, false)
	})
	it('ignores inherited intents but refuses edits to another PR intent', () => {
		git(root, 'switch', '-q', 'main')
		addIntent(11)
		commit()
		git(root, 'switch', '-q', 'feature')
		git(root, 'merge', '--ff-only', 'main')
		shipping()
		addIntent()
		assert.equal(verify(root, options).intent.bump, 'patch')
		write('.release/pending/pr-11.md', intent('minor'))
		assert.throws(() => verify(root, options), /Only this PR intent/)
	})
	it('rejects extra intents and an intent on a non-shipping PR', () => {
		addIntent()
		assert.throws(() => verify(root, options), /Non-shipping/)
		shipping()
		addIntent(13)
		assert.throws(() => verify(root, options), /Only this PR intent/)
	})
	it('takes the highest explicit label, and refuses a model-selected bump', () => {
		assert.equal(labelBump(['minor', 'major']), 'major')
		assert.equal(labelBump(['feature']), 'patch')
		shipping()
		addIntent(12, 'minor')
		assert.throws(() => verify(root, options), /Labels require bump: patch/)
		assert.equal(verify(root, { ...options, labels: ['minor'] }).intent.bump, 'minor')
	})
	it('rejects malformed YAML, duplicate keys, versions, dates, unsafe aliases and brand misspellings', () => {
		const config = loadConfig(root)
		for (const text of [
			intent().replace('bump: patch', 'bump: patch\nbump: minor'),
			intent().replace('bump: patch', 'bump: patch\nversion: 1.2.4'),
			intent().replace('bump: patch', 'bump: patch\npublishedAt: 2026-10-01'),
			intent().replace('title: Wallet focus survives navigation', 'title: Wrong: colon'),
			intent().replace('tags: [Fix, React SDK]', 'tags: &a [*a]'),
		]) {
			assert.throws(
				() => parseIntent(text, config, 'fixture'),
				error => error.code === EXIT.invalid,
			)
		}
		assert.throws(
			() => parseIntent(intent('patch', 'FloPay fix'), config, 'fixture'),
			error => error.code === EXIT.brand,
		)
	})
	it('does not follow an intent symlink outside the checkout', () => {
		shipping()
		mkdirSync(join(root, '.release/pending'), { recursive: true })
		symlinkSync('/etc/hosts', join(root, '.release/pending/pr-12.md'))
		assert.throws(() => verify(root, options), /Symlink/)
	})
	it('matches non-shipping paths without making similar directory names exempt', () => {
		const config = loadConfig(root)
		assert.equal(isNonShipping(['tests/unit/x.js', 'unit.spec.js'], config), true)
		assert.equal(isNonShipping(['tests-other/index.js'], config), false)
	})
})

describe('CI-owned release apply', () => {
	it('does not bump with no pending intents', () => {
		assert.equal(apply(root).released, false)
		assert.equal(git(root, 'status', '--porcelain'), '')
	})
	it('bumps once at the highest level and stamps every note without timestamp collisions', () => {
		addIntent(12, 'patch')
		addIntent(13, 'major')
		addIntent(14, 'minor')
		commit()
		const result = apply(root, { now: new Date('2026-10-07T08:00:00Z') })
		assert.equal(result.version, '2.0.0')
		assert.equal(JSON.parse(readFileSync(join(root, 'package.json'))).version, '2.0.0')
		assert.equal(result.notes.length, 3)
		assert.equal(new Set(result.notes.map(n => n.content.match(/publishedAt: (.+)/)[1])).size, 3)
		for (const note of result.notes) {
			assert.match(note.path, /^release-notes\/2026-10-07-0800.v2.0.0\..+-pr-\d+\.md$/)
			assert.match(readFileSync(join(root, note.path), 'utf8'), /v2.0.0 - Wallet/)
		}
		assert.equal(existsSync(join(root, '.release/pending/pr-12.md')), false)
		commit()
		assert.equal(apply(root).released, false)
	})
	it('reserves timestamps already used by existing notes', () => {
		write(
			'release-notes/2026-10-07-0800.v1.2.3.previous.md',
			'---\ntitle: Previous\npublishedAt: 2026-10-07T08:00:00Z\n---\nOld note\n',
		)
		addIntent()
		commit()
		assert.match(planRelease(root, new Date('2026-10-07T08:00:00Z')).notes[0].content, /08:00:01Z/)
	})
	it('orders reverse-title batches by filename before allocating publication seconds', () => {
		write('.release/pending/pr-12.md', intent('patch', 'Zebra fixes'))
		write('.release/pending/pr-13.md', intent('patch', 'Alpha fixes'))
		const plan = planRelease(root, new Date('2026-10-07T08:00:00Z'))
		assert.deepEqual(
			plan.intents.map(item => item.pr),
			[12, 13],
		)
		assert.deepEqual(
			plan.notes.map(note => note.path),
			[
				'release-notes/2026-10-07-0800.v1.2.4.alpha-fixes-pr-13.md',
				'release-notes/2026-10-07-0800.v1.2.4.zebra-fixes-pr-12.md',
			],
		)
		assert.match(plan.notes[0].content, /08:00:00Z/)
		assert.match(plan.notes[1].content, /08:00:01Z/)
	})
	it('preserves chronological filename order across a batch minute rollover', () => {
		write('.release/pending/pr-12.md', intent('patch', 'Zebra fixes'))
		write('.release/pending/pr-13.md', intent('patch', 'Alpha fixes'))
		const notes = planRelease(root, new Date('2026-10-07T08:00:59Z')).notes
		assert.match(notes[0].path, /0800\.v1\.2\.4\.alpha/)
		assert.match(notes[0].content, /08:00:59Z/)
		assert.match(notes[1].path, /0801\.v1\.2\.4\.zebra/)
		assert.match(notes[1].content, /08:01:00Z/)
	})
	it('places new notes after the latest existing second even when the clock is behind', () => {
		const oldPath = 'release-notes/2026-10-07-0805.v1.2.3.previous.md'
		const oldContent = '---\ntitle: Previous\npublishedAt: 2026-10-07T08:05:40Z\n---\nOld note\n'
		write(oldPath, oldContent)
		addIntent()
		const note = planRelease(root, new Date('2026-10-07T08:00:00Z')).notes[0]
		assert.match(note.content, /08:05:41Z/)
		assert.ok(note.path > oldPath)
		assert.equal(readFileSync(join(root, oldPath), 'utf8'), oldContent)
	})
	it('advances one minute when a new version would sort before the previous filename', () => {
		write('package.json', '{"version":"1.2.9"}\n')
		const oldPath = 'release-notes/2026-10-07-0800.v1.2.9.previous.md'
		write(oldPath, '---\ntitle: Previous\npublishedAt: 2026-10-07T08:00:30Z\n---\nOld note\n')
		addIntent()
		const note = planRelease(root, new Date('2026-10-07T08:00:30Z')).notes[0]
		assert.match(note.path, /0801\.v1\.2\.10\./)
		assert.match(note.content, /08:01:00Z/)
		assert.ok(note.path > oldPath)
	})
	it('does not fill an earlier timestamp gap behind an existing later note', () => {
		for (const second of ['00', '02']) {
			write(
				`release-notes/2026-10-07-0800.v1.2.3.previous-${second}.md`,
				`---\ntitle: Previous\npublishedAt: 2026-10-07T08:00:${second}Z\n---\nOld note\n`,
			)
		}
		addIntent()
		assert.match(planRelease(root, new Date('2026-10-07T08:00:00Z')).notes[0].content, /08:00:03Z/)
	})
	it('validates all intents before bumping or consuming any', () => {
		addIntent()
		write('.release/pending/pr-13.md', 'invalid')
		commit()
		assert.throws(() => apply(root), /frontmatter/)
		assert.equal(git(root, 'status', '--porcelain'), '')
		assert.equal(JSON.parse(readFileSync(join(root, 'package.json'))).version, '1.2.3')
	})
	it('refuses dirty work and restores an initially clean checkout after a failed bump', () => {
		addIntent()
		commit()
		write('unrelated.txt', 'user work')
		assert.throws(() => apply(root), /clean checkout/)
		assert.equal(readFileSync(join(root, 'unrelated.txt'), 'utf8'), 'user work')
		rmSync(join(root, 'unrelated.txt'))
		write('bump.cjs', `require('node:fs').writeFileSync('package.json','broken');process.exit(1)`)
		commit()
		assert.throws(() => apply(root))
		assert.equal(git(root, 'status', '--porcelain'), '')
		assert.equal(JSON.parse(readFileSync(join(root, 'package.json'))).version, '1.2.3')
		assert.equal(existsSync(join(root, '.release/pending/pr-12.md')), true)
	})
	it('refuses a bump command that produces the wrong version', () => {
		write('bump.cjs', '')
		addIntent()
		commit()
		assert.throws(() => apply(root), /expected 1.2.4/)
		assert.equal(git(root, 'status', '--porcelain'), '')
	})
	it('supports repositories that bump but publish no notes', () => {
		const config = loadConfig(root)
		config.notes = { enabled: false }
		write('.release/config.json', JSON.stringify(config))
		write('.release/pending/pr-12.md', `${intent().split('---\n\n')[0]}---\n`)
		commit()
		const result = apply(root)
		assert.equal(result.version, '1.2.4')
		assert.deepEqual(result.notes, [])
	})
})
