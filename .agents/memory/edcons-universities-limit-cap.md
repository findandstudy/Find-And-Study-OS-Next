---
name: universities endpoint limit cap
description: GET /api/universities silently caps page size; selectors needing the full catalog must paginate
---

The `GET /api/universities` handler caps `limit` at 100 server-side (`Math.min(100, ...)`). A single request with a large `limit` (e.g. `?limit=500`) silently returns only the first 100 rows ordered by name — extra universities just vanish with no error.

**Why:** the catalog exceeds 100 rows; any admin selector that loaded the list in one shot dropped the tail (e.g. universities sorted late by name), making them look "missing" / unselectable.

**How to apply:** when a UI needs the complete university list (dropdowns, selectors), page through `?limit=100&page=N` until `data.length >= meta.total` rather than requesting one oversized page. The same cap pattern may exist on other list endpoints — don't assume a high `limit` returns everything.

Related: `university_contracts.destinationId` is an optional FK to the `destinations` table. The contract dialog's "Destination" dropdown must list ONLY real destination rows (from `/api/public/destinations`), value = `String(d.id)`. Do NOT inject synthetic `c:<country>` options — the save path only persists a numeric id and drops everything else to NULL, so synthetic country picks silently save as null and the options "don't match the system". Auto-fill resolves to the destination whose country matches the selected university, or empty when none exists. `university_contracts.country` is notNull and derived server-side from the university.
