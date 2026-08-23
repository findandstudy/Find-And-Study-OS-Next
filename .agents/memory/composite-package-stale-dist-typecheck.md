---
name: Composite workspace packages need dist rebuild after adding exports
description: Why a brand-new type/schema import fails "no exported member" in a consuming package's typecheck even though the source file clearly has the export.
---

Several `lib/*` packages (e.g. `@workspace/db`, `@workspace/api-client-react`) have `"composite": true` + `"emitDeclarationOnly": true` in their own tsconfig, building a `dist/*.d.ts` tree. Even though their `package.json` `exports` field points at `./src/index.ts`, a *consumer* package that lists them under tsconfig `"references"` gets its declarations resolved through the stale `dist/` output (and a stale `tsconfig.tsbuildinfo`), not the live `src` on disk.

Symptom: you add a new export (schema/type/table) to a referenced package, the source clearly has `export interface Foo`, but `pnpm --filter <consumer> run typecheck` fails with `Module has no exported member 'Foo'` — while other, older exports from the same file resolve fine.

**Why:** the referenced project's `dist/` declarations were built before the new export was added, and TS project-reference resolution reads those stale `.d.ts` files instead of re-parsing `src`.

**How to apply:** when a typecheck error says "no exported member" for something you just added to a `lib/*` package, first check if that package's tsconfig has `"composite": true`. If so: delete its `tsconfig.tsbuildinfo`, run `pnpm --filter <pkg> exec tsc -b` to rebuild `dist/`, then delete the consumer's stale `tsconfig.tsbuildinfo` too and retypecheck. Don't assume it's an import bug in your new code.
