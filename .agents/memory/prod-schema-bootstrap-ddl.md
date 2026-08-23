---
name: Prod schema migrations live in api-server boot DDL
description: How production schema changes actually get applied in this repo — deploy runs NO migration; idempotent raw SQL DDL in api-server src/index.ts on boot is the mechanism.
---

# Production schema changes are applied by idempotent raw SQL in api-server boot

The deploy pipeline runs **no** migration step (`.replit` `[deployment.postBuild]`
is just `pnpm store prune`). Drizzle `push` is dev-only and dangerous in this repo
(drops unrelated tables). The Drizzle schema in `lib/db/src/schema/*` is the type
source of truth but does **not** alter the production database by itself.

**The actual prod migration mechanism:** `artifacts/api-server/src/index.ts` runs a
block of idempotent raw `pool.query` DDL on every boot — `CREATE TABLE IF NOT
EXISTS`, `CREATE INDEX IF NOT EXISTS`, and `ALTER TABLE ... ` statements — wrapped
in try/catch that logs `[migrate] ...` on failure. This runs in prod when the new
deploy boots.

**Why:** a Drizzle schema edit alone (e.g. dropping `.notNull()`) won't touch an
existing prod table — `CREATE TABLE IF NOT EXISTS` is a no-op once the table
exists. So a code change that inserts NULL into a column that is still `NOT NULL`
in prod will fail at insert time after deploy.

**How to apply:** when a schema change must reach production, add a matching
idempotent statement to the boot DDL block in `index.ts` (e.g. `ALTER TABLE x
ALTER COLUMN y DROP NOT NULL` — safe to run repeatedly). Also update the Drizzle
schema for types and rebuild `lib/db` dist (`tsc -b lib/db/tsconfig.json`) so
api-server's project-reference `.d.ts` reflects the new nullability. Apply the same
ALTER to the dev DB via `executeSql` (never `push`). Prod DB is read-only from dev,
so prod gets the change only via this boot DDL on the next deploy.
