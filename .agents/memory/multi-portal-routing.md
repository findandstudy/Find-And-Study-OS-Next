---
name: Multi-portal routing
description: portal_universities.is_multi_portal + routes_via — how member universities route their portal submissions through a company's adapter.
---

A `portal_universities` row can be `is_multi_portal=true` (a company that submits
applications for several member universities through one panel, e.g. SIT/United).
A member university's `routes_via` = the company's `universityKey`; NULL means the
member uses its own adapter.

**Routing rule (single source of truth):** `resolveAdapterKey(universityKey)` in
`lib/portal-runner/src/resolveAdapter.ts` returns `{ adapterKey, routedVia }`.
Callers MUST only override the adapter when `routedVia` is non-null — that keeps
the NULL path byte-for-byte identical to legacy behavior (Topkapı regression-free).

**Why:** the runner previously looked up adapters directly by universityKey;
routing had to be additive so that un-routed unis (the vast majority) behave
exactly as before.

**Hard constraints (do not regress):**
- Routing assignment must NEVER touch `auto_process`. drain-once/worker
  auto-process still keys off `autoProcess=true` only, and the experimental-adapter
  exclusion stays intact. Assigning a member sets only `routesVia`/`updatedAt`.
- Double-assign guard: assigning a member already routed to a *different* company
  → 409 `ALREADY_ASSIGNED` (re-assigning to the same company is idempotent).

**Referential integrity on the company row (`PATCH /portal-universities/:id`):**
the update is transactional and must cascade `routes_via` of dependent members:
- `isMultiPortal` set false → members' `routesVia` set NULL (detach).
- `universityKey` renamed → propagate the new key to every member whose
  `routesVia` pointed at the old key, or they silently orphan back to their own
  adapter (resolveAdapterKey company lookup fails → fallback). Easy to miss.

**Endpoints:** `GET /portal-automation/multi-portals`,
`PUT /portal-automation/multi-portals/:key/members` live in `portalAutomation.ts`
(404 PORTAL_NOT_FOUND, 400 NOT_MULTI_PORTAL/INVALID_MEMBER, 404 MEMBER_NOT_FOUND,
409 ALREADY_ASSIGNED; `logAudit("portal.routing.update")`). `is_multi_portal`
acceptance is on the existing `PATCH /portal-universities/:id` (portalMgmt.ts) —
there is no key-based PATCH. Tests: `scripts/test-portal-routing.ts` (MPR1–MPR11b).
