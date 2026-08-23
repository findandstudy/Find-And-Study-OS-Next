---
name: Test fragment uniqueness vs leaked rows
description: Search test fixtures must use per-run-unique fragments (not fixed prefixes) or leaked rows from crashed runs fill the LIMIT page.
---

## Rule
Any test that seeds a row and searches for it by a text fragment must include `RUN_ID` in the search query, not just a fixed prefix.

## Why
When a test run crashes before the `after()` cleanup hook fires, seeded rows are never deleted. Fixed-prefix fragments (e.g. `SearchStudentAlpha`) accumulate in the DB across failed runs. A `LIMIT 10` query with no `ORDER BY` (heap scan) may return 10 old leaked rows, pushing the current run's seeded row off the page → assertion failure.

**Concrete case:** `test-finance-faz3.ts` F3-2b + F3-5 searched for `SearchStudentAlpha` / `SearchStudentDelta` (no RUN_ID). F3-2c worked because it already used `srchstud_Beta_${RUN_ID}` (email, per-run unique).

## How to apply
- Fragment: use `${fixedLabel} ${RUN_ID}` which matches the `concat(firstName, ' ', lastName) ilike` branch, guaranteeing per-run uniqueness.
- Endpoint: always add `ORDER BY id DESC` before `LIMIT` on any search/list endpoint so even if stale data exists, newest rows come first.
- Email fragments are naturally unique (include RUN_ID in the email value itself).
