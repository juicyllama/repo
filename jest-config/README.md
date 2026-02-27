# @juicyllama/repo/jest-config

Shared Jest configuration presets for JuicyLlama projects.

## Install

```bash
npm install -D @juicyllama/repo
```

## Usage

Base config:

```js
const { config } = require('@juicyllama/repo/jest-config')

module.exports = config
```

NestJS config (requires `ts-jest`):

```js
const { nestConfig } = require('@juicyllama/repo/jest-config/nest')

module.exports = nestConfig
```

Next.js config (requires `next`):

```js
const nextConfig = require('@juicyllama/repo/jest-config/next').default

module.exports = nextConfig
```

ESM usage:

