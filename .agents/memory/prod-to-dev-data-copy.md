---
name: Prod→Dev data copy (faithful mirror)
description: Reliable read-only-prod → writable-dev row copy technique, and the silent-skip gotcha that makes per-table count verification mandatory.
---

# Copying production rows into the dev database

**Why this exists:** A "full" prod→dev copy once reported success while silently
skipping the entire inbox/messaging cluster (conversations, external_contacts,
messages, notifications). The app looked nearly empty in dev even though the copy
"succeeded". Never trust a bulk copy's success flag.

## Hard rule
After any prod→dev copy, verify **per-table `count(*)`** prod vs dev for every
table you intended to copy, and re-copy any shortfall. A single aggregate total
hides per-table gaps.

## Constraints in this environment
- Prod is reachable ONLY read-only via `executeSql({environment:"production"})`.
  There are no prod credentials in the dev container, so node/pg cannot connect to
  prod directly. Dev is writable via `executeSql({environment:"development"})`.
- Prod `pg_stat_user_tables.n_live_tup` is all 0 (prod never ANALYZEd) — use exact
  `count(*)` for prod, not n_live_tup. Dev n_live_tup is fine after ANALYZE.

## Reliable transfer method (preserves jsonb/timestamps/arrays exactly)
1. Read on prod as base64'd JSON (strip the newlines pg's base64 inserts):
   `SELECT replace(replace(encode(convert_to(json_agg(x)::text,'UTF8'),'base64'),E'\n',''),E'\r','') FROM (SELECT * FROM "T" ORDER BY id LIMIT n OFFSET m) x`
   Decode + `JSON.parse` in code_execution. base64 avoids CSV/quote/newline corruption.
2. Write on dev with `json_populate_recordset` so the table's own rowtype coerces
   every column (jsonb, timestamptz, arrays) by key name — column order/extra keys
   don't matter:
   `INSERT INTO "T" SELECT * FROM json_populate_recordset(NULL::"T", '<json>'::json)`
3. To bypass FK + triggers during load, wrap in a single multi-statement call:
   `BEGIN; SET LOCAL session_replication_role=replica; <insert>; COMMIT;`
   `params` cannot be used with multi-statement, so embed the JSON as a literal and
   escape `'`→`''` (standard_conforming_strings is on, so backslashes are literal —
   no other escaping needed). The dev role HAS permission to set replica role.
4. After inserting explicit serial ids, reset each sequence:
   `SELECT setval(pg_get_serial_sequence('public."T"','id'), GREATEST(max(id),1))`.
5. `ANALYZE` the copied tables (replica-role bulk load does not update planner stats).

## executeSql arg-size limit — the real bottleneck (writes AND reads)
`executeSql` passes the whole SQL string as a process **argv**, so big payloads
fail hard: a multi-row INSERT literal or even a single wide row trips
`SPAWN_ERROR spawn E2BIG`, and a `json_agg` read whose output is multi-MB gets the
helper **killed by signal** (`EXECUTE_SQL_COMMAND_ERROR ... exitReason=signal`).
Halving the page size only helps until one *single row* exceeds the limit.
- **Write path fix:** don't write to dev through `executeSql`. Connect to dev
  directly with node-postgres `Client({connectionString: DATABASE_URL})` and
  `INSERT ... json_populate_recordset(NULL::"T", $1::json)` with the JSON as a
  **bound param** (sent over the wire protocol, no argv limit; large batches fine).
  Still `SET session_replication_role=replica` on that connection to skip FK/triggers.
- **Gotchas:** `process.env` is **undefined inside the code_execution sandbox**, so
  the pg write must run from a Node script via **bash** (bash has the env). `pg` is
  often NOT a direct dep of the api artifact — require it by full pnpm-store path
  (`node_modules/.pnpm/pg@<v>/node_modules/pg`). Prod stays read-only via
  `executeSql({environment:"production"})`; only the dev write switches to pg.
- **Read path:** prod→sandbox still goes through `executeSql` base64 (the value
  returned to JS is NOT truncated at 30k — only the displayed observation is), but
  it cannot return a multi-MB single row.

## Huge inline blob columns — exclude them
`documents.file_data` and `application_stage_documents.file_data` are nullable TEXT
holding base64 file bytes (rows up to ~11.7MB, `documents` ~300MB total). They are
impossible to ferry through `executeSql` and impractical to mirror. Copy those
tables with an explicit column list **omitting file_data** (json_populate_recordset
leaves the missing key NULL); records/metadata/`file_key`/`file_url` come over,
blobs don't. Tell the user dev downloads of those files won't work.

**Targeted recovery (a few specific docs):** when the user needs preview/download
to actually work in dev for specific document rows, ferry just those `file_data`
blobs back: read from prod in fixed-size chunks via `substr(file_data, start, len)`
(1-indexed) — ~100k chars/chunk reads back losslessly through `executeSql.output` —
concat in JS, verify the assembled string's md5 == prod `md5(file_data)`, then write
to dev with a parameterized `UPDATE documents SET file_data=$1 WHERE id=$2` (bound
param has no argv-size limit). Apply to every row sharing that content (app-level +
profile-mirror copies). Symptom that triggers this: dev lead/student Documents tab
shows rows but no Preview/Download buttons because `canPreview` keys off file_data.

## Live-drift residual
Prod is live: after a copy, append/activity tables (`audit_logs`, `notes`, etc.)
can be off by ±1–few vs prod simply because prod kept changing during the copy.
Don't chase these — they are not copy defects.

## Faithful-mirror caveat
The dev copy mirrors prod warts and all: prod itself had dangling FKs (conversations
194/831 → channel_accounts 1170/1770 that don't exist in prod) and lots of e2e
"Playwright Inbox" / `inbox_*@e2e.test` residue. Those reappear in dev and are NOT
copy defects — don't chase them. The e2e teardown only deletes rows matching
`inbox\_%@e2e.test`, so it never wipes real prod data.
