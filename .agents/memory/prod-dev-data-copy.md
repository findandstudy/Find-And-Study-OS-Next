---
name: Prod→Dev data copy
description: How to copy production Postgres data into the dev DB using the code_execution executeSql sandbox, including pitfalls (read-size limits, inline blobs, triggers, sequences, email safety).
---

# Copying production data into the dev database

There is **no direct pg / DATABASE_URL access** in the code_execution sandbox. The only
channel is the `executeSql({ sqlQuery, params?, environment })` callback:
`environment:"production"` for reads, `environment:"development"` for writes. `params`
only works with a single statement; multi-statement SQL must be param-free. `DROP`/`TRUNCATE`
are blocked — use `DELETE`.

**Why this file exists:** a full prod→dev copy was done once and several non-obvious limits
bit us. These are environment quirks, not visible in the codebase.

## Read-size limit is the main trap
The prod read path (json_agg → base64) **crashes with `EXECUTE_SQL_COMMAND_ERROR` once the
result is more than a few MB**. This is a hard, silent wall:
- Wide tables crash around ~1000 rows; page with `LIMIT/OFFSET` at ~250 rows for big tables.
- A *single* large value (multi-MB blob) crashes too — never `SELECT *` a blob table.
- Even a 80-row `UNION ALL` of `count(*)` can crash; batch such probes (~15 tables/read).

**How to apply:** read in pages; for blob/large-text columns read with an explicit column
list that omits them; reconcile counts in small batches.

## Inline file blobs (documents stored in the DB)
If files are stored inline (e.g. `documents.file_data`, no `file_url`), transfer the bytes in
**resumable, time-boxed chunks** driven entirely by DB state (never rely on sandbox globals —
notebook resets wipe them):
- Per row, `nextOffset = length(dev.file_data) ?? 0`. Read prod chunk with
  `substr(file_data, nextOffset+1, CHUNK)` (Postgres substr is **1-indexed**).
- offset 0 → `UPDATE SET file_data=$1 WHERE id=$2`; else `... SET file_data=file_data||$1 ...`.
- CHUNK ~2 MB works for single-value reads; fall back to ~500 KB on a read crash.
- Time-box each code_execution call (~7 min) and return progress; re-invoke to resume. State
  lives in the dev DB, so restarts are safe.
- Verify with `md5(file_data)` prod vs dev per row at the end.
~257 MB across ~259 rows took ~13 passes this way.

## Bulk-import mechanics
- Disable constraints/triggers before bulk load: `ALTER TABLE ... DISABLE TRIGGER ALL` on every
  public table (lets you DELETE+INSERT ignoring FK order). **Re-enable with ENABLE TRIGGER ALL
  at the end** — easy to forget; verify `pg_trigger.tgenabled='D'` count is 0 afterward.
- Serialize values by column udt: jsonb/json → `JSON.stringify` + `$n::jsonb`; int arrays
  (`_int4`) → pass JS array + `::int4[]`; plain objects → JSON.stringify.
- After load, reset every sequence: loop `pg_depend`-owned sequences and
  `setval(seq, COALESCE(max(col),1), (count(*)>0))`.

## Production is LIVE — expect drift
While a long copy runs, prod keeps gaining/updating rows (applications, audit_logs, notes,
documents…). Reconcile counts at the end and re-sync the drifted tables. For blob tables,
re-sync via **delta insert of missing ids only** (never re-run a DELETE+metadata import — it
nulls the file_data you already streamed). Accept tiny residual drift; a frozen snapshot is
impossible without locking prod.

## Email / side-effect safety (critical)
Dev ends up holding **real production PII and email addresses**. Before/while importing, hard-disable
outbound mail so app background workers can't message real users:
`UPDATE integrations SET is_enabled=false WHERE key='smtp'` (the SMTP sender is gated on this
row) and `DELETE FROM email_queue`. The running API server's workers/checkers will keep enqueuing
mail onto the imported data — leave SMTP disabled and clear the queue again at the end. The
`[EMAIL] Worker` log line is fine as long as `smtp.is_enabled=false`.
**Why:** the user's hard requirement was that copying prod data must never send mail to real users.
