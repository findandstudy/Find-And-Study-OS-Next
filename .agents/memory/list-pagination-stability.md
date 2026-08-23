---
name: List endpoints need ORDER BY with LIMIT (rows vanish after update)
description: Why a row disappears from a paginated list after being edited, and the pattern to avoid it
---

# Paginated list queries must have a deterministic ORDER BY

A list endpoint that applies `LIMIT`/`OFFSET` without an `ORDER BY` returns rows
in Postgres heap order, which is arbitrary. After an `UPDATE`, MVCC writes a new
tuple (effectively at the end of the heap), so the updated row's position in an
unordered scan changes — it can move outside the `LIMIT` window and "disappear"
from the returned page.

**Symptom seen here:** editing a staff user's Permission Overrides made the user
vanish from the admin Users table. `GET /users` had LIMIT 50, no ORDER BY, and the
table had ~69 non-deleted users (most students, filtered client-side).

**How to apply:**
- Every list query with LIMIT/OFFSET must have a stable `.orderBy(...)` (include a
  unique tiebreaker like `id` so ties don't reshuffle).
- When a page does client-side filtering + client-side pagination, the server must
  return the full relevant set (raise the limit) — otherwise client filters operate
  on a truncated, unstable window.

# Edit dialogs that preload from a list row need that field in the list select

The Users list select omitted `permissionOverrides`, so the edit dialog initialized
overrides from an absent field (→ `{}`) and saving wiped them. If an edit form
preloads a field from the list row, that field must be in the list query's select
(or fetch the full record by id on open).
