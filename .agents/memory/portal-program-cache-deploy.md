---
name: portal_program_cache table is boot-DDL-only
description: New portal tables created via api-server boot DDL are absent from dev/test DB until the api-server workflow restarts.
---
New portal/edcons tables added via the api-server boot DDL (idempotent CREATE TABLE in src/index.ts) do NOT exist in the dev/test database until the api-server workflow is restarted — deploy runs no drizzle migration, and dev never auto-applies one either.

**Why:** A node:test script that hits a brand-new table (e.g. portal_program_cache) fails with PostgreSQL 42P01 undefined_table on first run even though the schema + DDL are correct, simply because the running api-server hadn't booted the DDL yet.

**How to apply:** After adding a new boot-DDL table, restart the `artifacts/api-server: API Server` workflow before running any test/script that touches it. The boot DDL is the single create path for both prod and dev.
