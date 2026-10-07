# Release intents

The optional workspace contract keeps release copy in a pull request and serializes versioning in CI.
No task or agent may run `release`, bump a version, or push main. Repositories without `os:release` opt out.

Configure `.release/config.json`:

```json
{
  "schemaVersion": 1,
  "versionFile": "package.json",
  "bumpCommand": ["node", "scripts/bump-version.cjs"],
  "nonShipping": ["tests/**", "**/*.spec.*", ".github/**"],
  "notes": {
    "enabled": true,
    "format": "openchangelog",
    "path": "release-notes",
    "audience": "Customers and public API integrators",
    "style": ["Explain the customer outcome and any integration action."]
  },
  "brand": {"name": "Example", "avoid": ["EXample"]}
}
```

The bump command receives `patch`, `minor` or `major` as its final argument. It must update files only,
including any version mirrors and lockfiles. It must not commit, tag, install, publish or deploy.
`notes.validateCommand` can name an argv array for an existing validator, run after stamping and before
consuming intents. A failed command restores the initially clean checkout. No historical notes are rewritten.

Expose `os-release report`, `os-release verify`, and `os-release apply` as `mise run os:release`,
`mise run os:release:verify`, and `mise run release`. They read configuration from the working directory.
Pass `--pr N --base origin/main --labels '["minor"]'` or `RELEASE_PR`, `OS_BASE_REF`, `RELEASE_LABELS`.
Labels include the PR and its linked issues; `major` wins over `minor`, otherwise `patch`.
Never infer a bump from prose. The verifier workflow reads current labels through GitHub and rejects
truncated responses rather than silently guessing patch.

`report` prints JSON with the contract, paths, shipping classification, bump and pending path.
`verify` requires exactly the current PR's intent for a shipping diff. A diff containing only explicitly
non-shipping paths needs no intent. Renames/deletions count; inherited unchanged intents do not.
Exit codes: 0 valid, 2 missing intent, 3 invalid intent, 4 incorrect brand spelling, 5 unavailable context.

```markdown
---
bump: patch
title: Wallet sheets survive focus changes
description: Buyers can return to their checkout without restarting payment.
tags: [Fix]
---

Wallet sheets stay open when focus changes. No integration changes are required.
```

Save as `.release/pending/pr-N.md`. No version or date. With `notes.enabled: false`, metadata is still
required and the body must be empty. Only pending files cause a release; no intents means no bump.
Several pending files produce one bump at the highest level and one stamped note per intent. Timestamps
are distinct even when several notes land together. `.release/latest.json` records recovery evidence.

## GitHub Actions

Call `.github/workflows/os-release.yml` on push to main and manual dispatch. Set `install-command` to
the repository's frozen dependency install, `ci-workflow` to an unconditional push-to-main CI workflow,
and grant `contents: write`, `actions: read`. Pin the reusable workflow to a reviewed commit.
The shared package version referenced by the workflow must be published before adoption.
Do not use `os-release-main` as a caller concurrency group: that is the called workflow's serial lock.
CI must not cancel older main runs; the release runner checks the newest main SHA and waits for that SHA.

The runner re-plans after a concurrent merge, pushes main first, then retries tagging the accepted commit.
It refuses to replace a tag belonging to main. Orphan cleanup is restricted to commits demonstrably
created by this release protocol. Rerunning a failed workflow recovers the release without another bump.
Outputs are `released`, `version`, `sha`. Chain delivery only when `released == 'true'`, dispatching
at `v<version>` with `actions: write`: a `GITHUB_TOKEN` branch/tag push does not start other workflows.

Call `os-release-verify.yml` on PR opened, synchronize, reopened, edited, labeled and unlabeled events.
Grant `contents: read`, `pull-requests: read`, `issues: read`. The checkout is the live PR head and has no
persisted write token. Linked issue label changes require rerunning the check. Install the note-writing
task before making this check mandatory.

`os-release-publish <package-dir>...` publishes built npm packages in dependency order at their exact
release tag. It uses `pnpm pack` to resolve workspace ranges, registry visibility for idempotency,
and bounded retries for transient packument conflicts. An E403 is never silently treated as success.
A rerun after partial publication fills missing packages and can retry downstream dispatches.

## Checks

`npm test` includes disposable Git remotes exercising CI failures, simultaneous merges, rejected main
pushes, tag recovery, intent validation, timestamp collisions, rollback and npm publication recovery.
Run `npx biome check release package.json` and `npm run build` before publishing.
