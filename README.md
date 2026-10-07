<div align="center">
  <a href="https://juicyllama.com/" target="_blank">
    <img src="https://juicyllama.com/assets/images/icon.png" width="100" alt="JuicyLlama Logo" />
  </a>

  Visit the [JuicyLlama](https://juicyllama.com) to learn more.
</div>

# @juicyllama/repo

A package for repo configuration helpers

## Install

```bash
npm install @juicyllama/repo
```

## Turbo

We use [TurboRepo](https://turborepo.dev/) for handling full projects within a single monorepo. 

On installation of @juicyllama/repo it will sync your shared turbo file and generate the turbo.json, this is due to limitations with TurboRepos extends functionality. 

If you need to make changes or extend this, simply update `turbo.shared.json` and run `node ./node_modules/@juicyllama/repo/dist/turbo/sync-turbo.mjs`

### Root file

```ts
//turbo.shared.json
{
  "extends": ["@juicyllama/repo/turbo"],
  "globalEnv": [
    ...
  ]
}
```


## Linting

Were using biomejs for linting and formatting.


```ts
//biome.json
{
  "extends": ["@juicyllama/repo/biome"]
}
```

[Read More](https://biomejs.dev/guides/getting-started/)


## TypeScript

You can extend the pre-build typescript configurations here:

### NestJs

```ts
//tsconfig.json
{
	"extends": "@juicyllama/repo/typescript/nestjs.json"
}
```

### Next.Js

```ts
//tsconfig.json
{
	"extends": "@juicyllama/repo/typescript/nextjs.json"
}
```

### Nuxt

```ts
//tsconfig.json
{
	"extends": "@juicyllama/repo/typescript/nuxt.json"
}
```

### React

```ts
//tsconfig.json
{
	"extends": "@juicyllama/repo/typescript/react-library.json"
}
```

### Base

```ts
//tsconfig.json
{
	"extends": "@juicyllama/repo/typescript/base.json"
}
```

## Jest

Shared Jest configs are available:

```ts
//jest.config.ts
import { Config } from '@juicyllama/repo/jest/base'

export default Config
```

NestJS config:

```ts
//jest.config.ts
import { nestConfig } from '@juicyllama/repo/jest/nest'

export default nestConfig
```

Next.js config:

```ts
//jest.config.ts
import { nextConfig } from '@juicyllama/repo/jest/next'

export default nextConfig
```

## Dependency refresh

`os-deps` is the set of repo commands a Zero Human dependency-refresh task calls: what is out of date, how a bump is applied, and whether anything resolved lower. It reads a pnpm or an npm lockfile. See [deps/README.md](./deps/README.md) for the `mise.toml` tasks to add.

## Release intents

`os-release` lets an opted-in repository keep release copy on the pull request while CI owns versioning,
tags and delivery. The optional `os:release` and `os:release:verify` workspace tasks report and validate
the contract; the CI-only `release` task consumes pending intents after merge. See
[release/README.md](./release/README.md) for configuration, reusable workflows and recovery behavior.

Installing this package does not opt a repository in. A repository without the `os:release` task keeps
its existing release process, and the release-note task leaves its pull request unchanged.

## Husky

The package will copy over .husky folder if it does not already exist with a recommended default setup.

## IDE

### VS Code

A suggested vs code settings file which complements this set up can be found in `./.vs-code/settings.json`
