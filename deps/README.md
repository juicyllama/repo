# os-deps

The three repo commands a Zero Human dependency-refresh task calls: what is out of date, how a bump is applied, and
whether anything resolved lower than before. It reads `pnpm-lock.yaml` or `package-lock.json` (lockfile version 2 or 3)
and the registry, so it never depends on what happens to be in `node_modules`.

Node.js and the package manager are dependencies too: `node`, `pnpm` and `npm` are read from every tracked file that
declares them (see [Runtimes](#runtimes)), and reported, applied and verified the same way as packages.

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
| `apply [--major] <name@version>...` | Moves each named dependency to exactly that version wherever it is declared lower, keeping its range operator, and updates the lockfile. `node@…`, `pnpm@…` and `npm@…` move every declaration of that runtime instead (see [Runtimes](#runtimes)). Without `--major`, only a declaration already on the target's major moves. A dependency already at its version is skipped. It lands whole or not at all: on any failure every file is put back as it was. | 0 on success. 1 when it failed, with the files restored. |
| `verify` | Fails when a direct dependency, or an exact runtime declaration, resolves lower than on the commit the branch forked from (`origin/HEAD`, else `origin/main`, or `OS_BASE_REF`). | 0 when nothing went down. 1 naming each one that did. |

## What it offers

- Patch and minor moves inside a dependency's current major go on one list. A major upgrade is listed apart, grouped
  by package family, and is never applied without `--major`.
- A version is offered only once it has been published for `OS_DEPS_MIN_AGE_DAYS` days (default 3). A dependency an
  audit names is exempt inside its current major, so a security fix does not wait. A major always waits.
- Never a prerelease, a deprecated release or anything above the registry's `latest`.
- Two apps holding one dependency at different majors are two rows, not one.

## Runtimes

| Runtime | Where it is read |
| --- | --- |
| `node` | `mise.toml` `[tools] node`; `.nvmrc`; `.node-version`; `.tool-versions`; `package.json` `engines.node` and `volta.node`; `FROM node:<tag>` and `ARG NODE_*_VERSION=` in any `Dockerfile*` / `*.Dockerfile`; `node:<tag>` images in compose files, workflows and Terraform; `node-version:` in `.github/workflows` and `.gitea/workflows` |
| `pnpm` / `npm` | `package.json` `packageManager`, `engines` and `volta`; `mise.toml` `[tools]`; `.tool-versions` |

- Every row and major names the `file:line` of each declaration it covers, in the Note column or the major's
  bullet.
- Node's releases come from `https://nodejs.org/dist/index.json`, which marks security releases, and end-of-life dates
  from Node's release schedule. If either does not answer, the scan fails (exit 2). pnpm and npm come from the registry,
  with their advisories from its bulk advisory endpoint.
- A Node security release, or a pnpm/npm release that fixes an advisory on the current version, is offered at once:
  the cooldown does not hold it.
- A floating declaration (`node:26-alpine`, `.nvmrc` `26`, setup-node `'26'`) is a `pin` row: applying it writes the
  exact release, because an image built from a cached floating tag keeps the old runtime. It is marked as a security
  fix while its major's latest security release is under 30 days old.
- A Node major targets its newest LTS major, never an odd one. A major past its end of life, or a pnpm/npm major with
  an advisory that has no fix left in it, prints a `Security:` line directly under its heading, and counts in
  `security:`.
- Held back, each with its `file:line`: an engines range that spans majors (`^20 || ^22`) or is an open floor
  (`>=22`), a declaration that names no major (`lts/*`), an image pinned by digest, and one family declared on
  different majors (`declarations disagree`).
- `apply` keeps each declaration's form: `node:26-alpine` becomes `node:26.12.1-alpine`, `>=26.7.0 <27` becomes
  `>=26.12.1 <27` (with `--major`, the upper bound moves too), and a `packageManager` corepack hash is rewritten from
  the registry's integrity for the new version.
- A runtime move edits files only. It runs no install, and regenerates nothing: a file generated from another one is
  for the repository's own `os:deps:apply` task to regenerate after this command.

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
| `OS_DEPS_NODE_INDEX_URL` | `https://nodejs.org/dist/index.json` | A mirror of Node's release index. |
| `OS_DEPS_NODE_SCHEDULE_URL` | Node's `schedule.json` on GitHub | A mirror of Node's release schedule. |

## Tests

```bash
npm test
```
