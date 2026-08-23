---
name: multi-portal membership routing (Phase 3)
description: How portal submissions route through multi-portal accounts via the catalog-keyed junction, and the invariants that keep Topkapı 1:1 from regressing.
---

# Multi-portal membership routing (Phase 3)

A multi-portal account (portal_universities.is_multi_portal=true, e.g. SIT/United) submits
applications for MANY catalog universities through one panel. Membership is a junction
`portal_account_universities { portalKey, catalogUniversityId (FK universities.id, UNIQUE), enabled }`.
A catalog university belongs to AT MOST ONE account (UNIQUE on catalog_university_id).

## Routing — resolveAdapterKey(universityKey) is self-contained (no caller signature change)
Priority order, returns `{ adapterKey, routedVia, memberUniversityId }`:
1. **Junction (Phase 3)**: own row's `crm_university_id` → if an ENABLED junction row exists in a
   DIFFERENT portalKey → use that account's adapter, `routedVia=portalKey`, `memberUniversityId=catalogId`.
2. **routes_via (Phase 2 fallback)**: own row's `routes_via` set → company adapter, `routedVia=routes_via`,
   `memberUniversityId=null`.
3. **Own adapter**: neither → own adapter, both null (legacy NULL path byte-for-byte).

**Why:** callers preserve legacy behaviour by only overriding the adapter when `routedVia` is non-null;
`memberUniversityId` is non-null ONLY on a junction match (rule 1), so the routes_via fallback keeps
Phase-2 program-mapping behaviour unchanged.

## No-regression invariants (Topkapı 1:1 must NOT change)
- `portal_program_mapping.member_university_id` is nullable with TWO partial uniques:
  `WHERE member_university_id IS NULL` (the 1:1 Topkapı row) + `WHERE member_university_id IS NOT NULL`
  (per-member rows). `loadProgramMapping(key, memberId=null)` uses `IS NULL` for 1:1, equality for members.
  A member row must NEVER leak into the 1:1 slot and vice-versa.
- `enabled=false` junction rows are IGNORED by the resolver (query filters `enabled=true`) — submission
  falls back to own/routes_via exactly like before.
- A routes_via member with NO catalog id can never enter the junction → always the pure Phase-2 path,
  `memberUniversityId` stays null.

## Migration / deploy
- prod migration path is the idempotent boot DDL in api-server `src/index.ts` (Step 2b2b3), NOT Drizzle
  migrate (deploy runs no migration). It also backfills Phase-2 routes_via members → junction with
  `INSERT … SELECT routes_via, crm_university_id … ON CONFLICT (catalog_university_id) DO NOTHING`.
- **Restart api-server after schema work** so the boot DDL runs in dev too (the junction table won't
  exist otherwise and inserts 500).
- lib/db exports ./src but emits .d.ts dist that api-server tsc reads → rebuild db dist (`tsc -b`) after
  any schema change. portal-runner exports ./src directly (no dist build needed).

## Membership endpoints use customFetch (not OpenAPI/orval)
GET /portal-automation/catalog-universities (own paginated search — /api/universities silently caps
limit at 100), GET+PUT /portal-automation/accounts/:key/members (PUT replaces the set; cross-account
catalog id → 409 ALREADY_ASSIGNED unless force=true moves it), GET /portal-automation/resolve.
Matches confirmed Phase-2 multi-portal endpoints (absent from openapi.yaml).
