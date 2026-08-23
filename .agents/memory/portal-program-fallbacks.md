---
name: Portal program-fallback rules (Phase 4)
description: CRUD + UI for portal_program_fallbacks (supersession rules); soft-delete vs unique-index gotcha, supersession board wiring.
---

# Portal program-fallback (supersession) rules

Panel-managed rules that map a full source CRM program to an ordered fallback list,
consumed by the Phase-3 orchestrator. Admin-only CRUD + a global `fallbackEnabled`
kill-switch on portal automation settings.

## Soft-delete needs a PARTIAL unique index
The active-row uniqueness `(university_key, source_program_id)` must be a **partial**
unique index `WHERE deleted_at IS NULL`.
**Why:** the CRUD pre-check only looks at active rows, but a plain (non-partial)
unique index also counts soft-deleted rows — so recreating a rule for a previously
soft-deleted source throws a DB unique violation (500) even though the app check
passes. Partial index lets the same source be recreated after soft-delete.
**How to apply:** keep the Drizzle `.where(sql\`... IS NULL\`)` and the api-server
boot DDL in lockstep (boot DDL must `DROP INDEX IF EXISTS` the legacy non-partial
one, then recreate partial), since prod migrates via boot DDL only.

## Supersession board wiring
The supersede links live on `applications` (supersededBy/FromApplicationId), NOT on
portal_submissions. The submissions list endpoint must LEFT JOIN applications to
surface them; the board renders a `program_full` status badge + links to/from the
superseding application.

## Frontend program picker
The fallback/source pickers need the university's full CRM program list, but
`GET /api/programs` caps `limit` at 100 — paginate via `page` to load all (bounded
helper, acceptable for typical catalog sizes; switch to a server-side searchable
picker if catalogs grow very large).
