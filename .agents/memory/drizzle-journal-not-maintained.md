---
name: Drizzle meta/_journal stops at 0017 — hand-written SQL after
description: Portal-era migrations (0018+) are hand-written idempotent SQL, NOT journaled; don't add _journal entries
---

`lib/db/drizzle/meta/_journal.json` only tracks migrations through idx 11
(`0017_portal_automation_settings`). Every migration from `0018_*` onward exists
ONLY as a hand-written idempotent `.sql` file with NO `_journal.json` entry and no
snapshot.

**Rule:** when adding a new migration (e.g. `0026_*`), follow the 0018–0025
convention: hand-write idempotent raw SQL (`CREATE TABLE IF NOT EXISTS`,
`ADD COLUMN IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS`, FK adds wrapped in
`DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL`). Do NOT regenerate via
drizzle-kit and do NOT add a `_journal.json` entry — the journal is dead for the
portal era.

**Why:** these migrations are applied through the api-server boot DDL path (see
`prod-schema-bootstrap-ddl`), not drizzle-kit migrate, so the journal is unused.
Updating it would diverge from the existing files and imply a workflow that isn't
run. **How to apply:** new schema → ALTER/CREATE in the schema file, `tsc -b`
rebuild of lib/db dist, hand-written idempotent SQL migration, and (for prod) the
matching boot DDL.

**Self-FK note:** Drizzle self-references (e.g. applications.superseded_by_*) need
the callback typed `(): AnyPgColumn => fooTable.id` to avoid circular type
inference; plain `() => fooTable.id` will error.
