---
name: Drizzle/node:test DB transaction & error testing
description: How to test transaction rollback and assert on DB errors when using drizzle + node:test
---

Testing techniques for DB-level behavior with drizzle + tsx node:test.

- **Asserting on a DB error**: drizzle re-wraps the underlying PG error as
  `Error("Failed query: ...")` and puts the real server message (e.g. a
  `RAISE EXCEPTION` text) on `err.cause.message`, NOT on `err.message`.
  An `assert.rejects` matcher that only inspects `err.message` will get a
  false negative — walk `err.message` AND `err.cause?.message`.

- **Forcing a mid-transaction rollback deterministically**: install a
  scenario-scoped `BEFORE INSERT` trigger on the target table that `RAISE`s
  only when a column matches the test's unique scenario key, then call the
  code-under-test and assert the whole unit-of-work rolled back (origin row
  unchanged, no orphan child rows/audit). Drop trigger + function in a
  `finally` so the suite stays isolated.

- **DDL can't bind params**: a `CREATE FUNCTION ... $$ body $$` cannot carry
  a `${value}` bound parameter. Inline the value with `sql.raw(...)` — only
  ever with locally-generated constrained identifiers/keys, never user input.

**Why:** these cost real debugging time on the program-fallback supersession
rollback test (FB-I10) — the rejection assertion silently passed-then-failed
until the cause chain was walked, and the trigger DDL failed on a bound param.

**How to apply:** any portal-runner / api-server test that needs to prove a
multi-step DB mutation is atomic, or that a specific DB error is raised.
