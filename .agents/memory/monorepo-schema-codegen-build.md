---
name: Schema/OpenAPI changes need lib dist rebuild + safe DB migration
description: How to apply DB schema + OpenAPI field additions so consuming artifacts type-check, and how to migrate the DB without dropping unrelated tables
---

# Adding a field across the stack (DB column + OpenAPI)

After editing `lib/db/src/schema/*` or `lib/api-spec/openapi.yaml`, the consuming
artifacts (edcons, api-server) type-check against the **built `dist/*.d.ts`** of the
lib packages (TypeScript project references), NOT the `src`. So new fields appear as
"Property does not exist" until you rebuild the libs.

**How to apply:**
- After OpenAPI edit: `pnpm --filter @workspace/api-spec run codegen` (orval → lib/api-zod + lib/api-client-react src), then `npx tsc -b lib/api-zod lib/api-client-react`.
- After lib/db schema edit: `npx tsc -b lib/db`.
- Then `tsc --noEmit` in the artifact will see the new field.

# DB migration: avoid `pnpm --filter @workspace/db run push`

`drizzle-kit push` is interactive and detects tables present in the DB but absent
from the drizzle schema (e.g. `rate_limits`, `pipeline_migrations`) and offers to
DROP them — accepting causes data loss.

**Why:** those tables are managed outside the drizzle schema, so push always wants to remove them.

**How to apply:** for an additive column change, apply it directly with SQL instead:
`ALTER TABLE <t> ADD COLUMN IF NOT EXISTS <col> <type>;` (via executeSql in code_execution). Do not run the interactive push.

# When adding a lead field, surfaces that also need it

Beyond schema/dedup/create+patch routes/openapi/frontend display+forms, also update:
- `artifacts/api-server/src/routes/inbox.ts` conversation-detail lead `.select({...})` projection (sidebar + InboxLeadSummary expect it).
- `artifacts/api-server/src/routes/export.ts` lead CSV/XLSX column mapping.
