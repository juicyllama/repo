# Development

We follow a strict development lifecycle.

1. Always follow [Trunk development](#trunk-development)
2. We follow [TDD](#test-driven-development-tdd) and [DRY](#dont-repeat-yourself-dry) principles
3. Before pushing code we always run [Let's Go!](#lets-go) to ensure all formatting, linting, building and testing works. Any issues should be fixed.

## Trunk Development

All development should happen on a new git branch.

Once you are finished and you have passed the [Let's Go!](#lets-go) checks, you should create a PR request on github.

## Test-Driven Development (TDD)

We want 100% test code coverage on our application to prevent bugs making their way into our production environments. You should always build tests for any new features or to validate bug fixes.

## Don't Repeat Yourself (DRY)

We follow DRY development methodology to avoid code duplication and bloat. Try where possible to abstract repeatable code.

## Code Style

Biome is the single source of truth for formatting and lint (`@juicyllama/repo/biome`, or `@juicyllama/repo/biome-nestjs` for NestJS services). Every rule it enables is an error: code that does not pass `biome check` is not finished. Never suppress a rule with `biome-ignore` without a one-line reason on the same comment.

Beyond what Biome can check for you:

- **Prefer one flat expression over a chain of early returns when the result stays readable.** `if (!x) return null; if (x === true) return A; return x;` reads better as `return x === true ? A : x || null;`. Keep it flat: no nested ternaries (Biome rejects them), no chains longer than one `?:`. When a ternary would need nesting or a comment to follow, keep the guard clauses instead.
- Guard clauses over `if/else` blocks: return or throw early, then write the main path unindented.
- Invert negated conditions (`if (!ready) { a } else { b }` becomes `if (ready) { b } else { a }`); Biome enforces this too.
- Rethrow with the original error attached: `throw new Error('...', { cause: error })`.

## Let's Go!

ALWAYS run the repo's `go` script (`npm run go`, or `pnpm go` in pnpm repos) before you push.

`go` is the fix-then-check command: it applies knip's safe fixes (`knip:fix` removes dead `export` keywords and unused exported types) and Biome's safe fixes (`lint:fix`), then runs the typecheck, the tests and the build. Review what it changed before you commit it.

The pre-commit hook and CI run `verify` instead: the same knip, Biome and typecheck with no writes, so a commit that would need fixing is rejected rather than silently rewritten.

Fix any errors found.