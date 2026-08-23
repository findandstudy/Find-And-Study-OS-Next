---
name: Native dep pulled in via a workspace package crashes the prod bundle
description: Why a native module (sharp) used only through a @workspace/* lib must be a DIRECT dep of the bundled artifact.
---

# Native dep via workspace package → prod boot crash

api-server's `build.ts` (esbuild) marks a dependency `external` ONLY if it appears
in api-server's own `package.json`; everything else — including all `@workspace/*`
packages — is BUNDLED. So esbuild follows into a workspace lib's source and tries
to bundle that lib's transitive deps too.

**Problem:** a NATIVE module (e.g. `sharp`) reached only transitively through a
workspace package (`@workspace/portal-runner`) is not in api-server's deps, so
esbuild BUNDLES it. sharp's ESM entry does `createRequire(import.meta.url)`; when
inlined into the CJS output, `import.meta.url` evaluates to `undefined`, so at
boot the bundle throws `TypeError [ERR_INVALID_ARG_VALUE]: The argument
'filename' must be a file URL ... Received undefined` at
`createRequire (node:internal/modules/cjs/loader:1967)` — NOT a `.node`
MODULE_NOT_FOUND. The process never opens its port, every `/api` healthcheck
returns 500 → "built successfully but failed to start" / fails to promote. Dev
(tsx, no bundling) hides this entirely.

**Don't be fooled by the loader frame:** the top stack line is
`node:internal/modules/cjs/loader:1967` for BOTH `createRequire(undefined)` and a
genuine missing-module — always read down to the actual `Error:` / `TypeError:`
line before concluding it's MODULE_NOT_FOUND.

**Don't be fooled by a healthy live URL:** autoscale keeps the previous good
build serving while a new build fails to promote, so `/api/healthz` can return
200 (old build) while the new publish is crashing. Distinguish by deployment id
in the logs, and reproduce the bundle locally (`node dist/index.cjs` → reaching
the "PORT required" check means module-load succeeded).

**Rule:** any native / non-bundleable module used anywhere in the api-server
dependency graph (even transitively via a workspace lib) MUST be added as a
DIRECT dependency of `artifacts/api-server/package.json`. That single change both
puts it in the esbuild `external` list (so it's left as a runtime `require`) AND
makes pnpm install it where Node can resolve it from `dist/index.cjs`. Same
pattern as the existing `playwright-core` / `pdf-lib` deps.

**How to verify after the fix:** prod build succeeds; `rg 'require("sharp")'
dist/index.cjs` shows the external require; `require.resolve('sharp', {paths:
['artifacts/api-server/dist']})` resolves; and a quick `require('sharp')(...)
.jpeg().toBuffer()` confirms the native binary loads.
