---
name: monorepo typecheck command
description: How to typecheck an artifact/package in this pnpm monorepo without hitting the project-references emit error.
---

Do NOT run `tsc -b --noEmit` against a package that is a referenced project (e.g. edcons depends on lib/api-client-react). It fails with `TS6310: Referenced project '...' may not disable emit`.

**Why:** `tsc -b` (build mode) walks project references and `--noEmit` is incompatible with referenced projects that emit.

**How to apply:** Use the package's own `typecheck` script instead — for edcons that is `tsc -p tsconfig.json --noEmit` (run `pnpm --filter @workspace/edcons run typecheck`). The repo-wide script is `pnpm run typecheck` (root), which does `typecheck:libs` (`tsc --build`) then per-artifact `typecheck`.

Known pre-existing edcons typecheck errors (NOT yours, ignore): `src/components/ui/searchable-select.tsx` (TS7030 not all paths return), `src/pages/staff/Applications.tsx` (TS7006 implicit any on `u`).
