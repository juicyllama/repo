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

```turbo.shared.json
{
  "extends": ["@juicyllama/repo/turbo"],
  "globalEnv": [
    ...
  ]
}
```


## Linting

Were using biomejs for linting and formatting.


```biome.json
{
  "extends": ["@juicyllama/repo/biome"]
}
```

[Read More](https://biomejs.dev/guides/getting-started/)


## TypeScript

You can extend the pre-build typescript configurations here:

### NestJs

```tsconfig.json
{
	"extends": "@juicyllama/repo/ts-nest"
}
```

### Next.Js

```tsconfig.json
{
	"extends": "@juicyllama/repo/ts-next"
}
```

### Nuxt

```tsconfig.json
{
	"extends": "@juicyllama/repo/ts-nuxt"
}
```

### React

```tsconfig.json
{
	"extends": "@juicyllama/repo/ts-react"
}
```

### Base

```tsconfig.json
{
	"extends": "@juicyllama/repo/ts-base"
}
```

## Jest

Shared Jest configs are available:

```jest.config.mjs
import { config } from '@juicyllama/repo/jest-base'
export default config
```

NestJS config:

```jest.config.mjs
import { nestConfig } from '@juicyllama/repo/jest-nest'
export default nestConfig
```

Next.js config:

```jest.config.mjs
import { nextConfig } from '@juicyllama/repo/jest-next'
export default nextConfig
```


## IDE

### VS Code

A suggested vs code settings file which complements this set up can be found in `./.vs-code/settings.json`

## Testing

### Jest


