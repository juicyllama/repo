# os-deps

The three repo commands a Zero Human dependency-refresh task calls: what is out of date, how a bump is applied, and
whether anything resolved lower than before. It reads `pnpm-lock.yaml` or `package-lock.json` (lockfile version 2 or 3)
and the registry, so it never depends on what happens to be in `node_modules`.

## Wire it up

Add three tasks to the repository's `mise.toml`. The same lines work for pnpm and npm, and for any package manager's
install layout, because they name the file and not a binary on `PATH`:

```toml
[tasks."os:deps"]
description = "Report which direct dependencies are out of date, as markdown to copy into an issue."
run = "node node_modules/@juicyllama/repo/deps/os-deps.mjs report"

[tasks."os:deps:apply"]
description = "Move dependencies to exact versions and update the lockfile: os:deps:apply [--major] <name@version>..."
run = "node node_modules/@juicyllama/repo/deps/os-deps.mjs apply"

[tasks."os:deps:verify"]
description = "Check that no direct dependency resolves lower than on the commit this branch forked from the default branch."
run = "node node_modules/@juicyllama/repo/deps/os-deps.mjs verify"
```

The contract these tasks answer, and the form of the report, is on the Zero Human docs page for
[workspaces](https://zerohuman.com/docs/tools/workspaces).

## Commands

| Command | What it does | Exit |
| --- | --- | --- |
| `report` | Prints markdown: a counts line, the patch and minor updates with the `apply` line for each group, one heading per major upgrade, and anything it could not decide. | 0 when the report is complete, with or without updates. 2 when the scan could not be completed (no lockfile, an unreadable one, the registry not answering): never an empty report for a scan that failed. |
| `apply [--major] <name@version>...` | Moves each named dependency to exactly that version wherever it is declared lower, keeping its range operator, and updates the lockfile. Without `--major`, only a declaration already on the target's major moves. A dependency already at its version is skipped. It lands whole or not at all: on any failure every file is put back as it was. | 0 on success. 1 when it failed, with the files restored. |
| `verify` | Fails when a direct dependency resolves lower than on the commit the branch forked from (`origin/HEAD`, else `origin/main`, or `OS_BASE_REF`). | 0 when nothing went down. 1 naming each one that did. |

## What it offers

- Patch and minor moves inside a dependency's current major go on one list. A major upgrade is listed apart, grouped
  by package family, and is never applied without `--major`.
- A version is offered only once it has been published for `OS_DEPS_MIN_AGE_DAYS` days (default 3). A dependency an
  audit names is exempt inside its current major, so a security fix does not wait. A major always waits.
- Never a prerelease, a deprecated release or anything above the registry's `latest`.
- Two apps holding one dependency at different majors are two rows, not one.

## Limits

- npm workspaces are refused by name. pnpm workspaces are read.
- Yarn is not supported.
- The registry is read without credentials, so a private package that needs a token is reported as held back, with
  the reason, rather than guessed at.
- npm installs run with `--ignore-scripts`.

## Environment

| Variable | Default | |
| --- | --- | --- |
| `OS_DEPS_MIN_AGE_DAYS` | `3` | How old a version must be before it is offered. |
| `OS_DEPS_ROOT` | the working directory | The repository to read. `mise run` starts in the project root. |
| `OS_BASE_REF` | `origin/HEAD`, else `origin/main` | What `verify` compares with. |

## Tests

```bash
npm test
```
