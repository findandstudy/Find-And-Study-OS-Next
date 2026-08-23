---
name: Dashboard FAZ 1 entity_view_events
description: How entity view tracking was implemented; idempotent DDL path, dedup logic, isolation rules for summary.
---

## Rule
New tables added to lib/db schema must be:
1. Exported via `lib/db/src/schema/index.ts` (usually auto via `export * from "./activity"` etc.)
2. Rebuilt with `pnpm tsc -b lib/db` so api-server picks up new `.d.ts` declarations
3. Registered in api-server boot DDL (`src/index.ts`) as idempotent `CREATE TABLE IF NOT EXISTS` — this is the ONLY migration path for prod

**Why:** lib/db uses `composite: true` / `emitDeclarationOnly` — tsc doesn't auto-rebuild on schema edit; api-server tsconfig references the built dist. Boot DDL is the prod migration (no drizzle push in prod).

## Activity summary isolation
- `requireRole(...STAFF_ROLES, "agent_staff")` — agent_staff not in STAFF_ROLES so must be added explicitly
- `requireAgentStaffPermission("leads")` — no-op for non-agent_staff, blocks agent_staff without leads perm
- In handler: isAdmin → staffId respected; agent_staff → getAgentVisibleIds; staff → self only

## 5-min dedup pattern (POST /v1/activity/view)
Query `entityViewEventsTable` WHERE userId+entityType+entityId+deletedAt IS NULL + viewedAt >= (now - 5 min). If row exists → 200 {deduplicated:true}; else insert → 201 {deduplicated:false}.

## Kommo reply time SQL
Uses raw `db.execute(sql\`...\`)` with PERCENTILE_CONT window function. Result rows come back as `(result as any).rows?.[0]` — not via array indexing on the QueryResult type.
