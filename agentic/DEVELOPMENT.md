# Development

We follow a strict development lifecycle.

1. Always follow [Trunk development](#trunk-development)
2. We follow [TDD](#test-driven-development) and [DRY](#dont-repeat-yourself-dry) principles
3. Before pushing code we always run [Let's Go!](#lets-go) to ensure all formatting, linting, building and testing works. Any issues should be fixed.

## Truck Development

All development should happen on a new git branch.

Once you are finished and you have passed the [Let's Go!](#lets-go) checks, you should create a PR request on github.

## Test Driven Development (TDD)

We want 100% test code coverage on our application to prevent bugs making their way into our production environments. You should always build tests for any new features or to validate bug fixes.

## Don't Repeat Yourself (DRY)

We follow DRY development methodology to avoid code duplication and bloat. Try where possible to abstract repeatable code.

## Let's Go!

ALWAYS Run `npm run go` before any commit/push to make sure all changes pass the linting, building and testing checks.

Fix any errors found.