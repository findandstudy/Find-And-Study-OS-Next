---
name: Portal automation Run Now + event-driven enqueue
description: How portal-automation enqueue is triggered and why dedup needs an advisory lock
---

# Portal automation enqueue: triggers + dedup

The eligibility gate is single-sourced in `enqueueIfEligible(params, settings)`
(api-server `src/lib/portalAutoTrigger.ts`): trigger-stage → active portal
university → scope → credentials → dedup → insert. Callers:

- **Event-driven**: `maybeEnqueuePortalSubmission` (reads settings + isEnabled
  kill-switch, then delegates) is fire-and-forget from BOTH `POST /applications`
  (create at trigger stage) and `PATCH /applications/:id` (stage change). Always
  `.catch()` — must never block the HTTP response.
- **Batch / Run Now**: `scanAndEnqueueTriggerStageApplications` iterates
  trigger-stage non-deleted apps; used by `POST /portal-automation/run-now`
  (ADMIN_ROLES only; 409 `AUTOMATION_DISABLED` when off), which then drains
  in-process via the shared `drainQueue(workerId)` helper guarded by the
  module-level `_processMutex` (skips draining if a run is already in flight).

## Dedup must be atomic (advisory lock, NOT a unique index)

**Rule:** the dedup check+insert in `enqueueIfEligible` is wrapped in a
`db.transaction` with `pg_advisory_xact_lock(applicationId, hashtext(universityKey))`.

**Why:** plain SELECT-then-INSERT is racy — with 3 concurrent callers (create
hook + PATCH hook + Run Now scan) or multiple instances, all can pass the read
and insert duplicate queued rows → duplicate real portal submissions. There is
no partial unique index on `(application_id, university_key)` for active rows,
and adding one is a schema change (out of scope for this surface).

**How to apply:** any new enqueue path must go through `enqueueIfEligible` (do
not re-implement the SELECT-then-INSERT). The advisory lock releases on
commit/rollback. A parallel-race regression test lives in
`scripts/test-portal-trigger.ts` (RN7b).

## Apply-to-all is a new enqueue surface (extra application-level race)

`POST /portal-automation/apply-to-all` (ADMIN_ROLES) fans one application out to
ALL active adapter+credentialed portal universities. It does NOT reuse
`enqueueIfEligible` (it deliberately bypasses the trigger-stage/scope gates), but
it MUST replicate the atomic dedup. Unlike other surfaces it also reuses/creates
an `applications` row per uni, so it takes TWO transaction-scoped advisory locks
in one tx: `pg_advisory_xact_lock(studentId, crmUniversityId)` around the app
reuse/create, then `pg_advisory_xact_lock(applicationId, hashtext(universityKey))`
around the submission dedup/insert. Without the first lock, concurrent calls
create duplicate applications; without the second, duplicate submissions.

## Gotchas
- `portalAutomation.ts` route file did NOT import `portalAutomationSettingsTable`
  even though the run-now route reads it → runtime 500 (`ReferenceError`), not a
  typecheck error, because the table was referenced only at runtime. HTTP-level
  tests (not lib tests) are what catch this — always test the route, not just the lib.
- Run Now UI uses `customFetch` (not Orval/OpenAPI), so no codegen step.
