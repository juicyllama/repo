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


## IDE

### VS Code

A suggested vs code settings file which complements this set up can be found in `./.vs-code/settings.json`
