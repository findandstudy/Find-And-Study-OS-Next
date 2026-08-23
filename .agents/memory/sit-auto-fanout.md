---
name: SIT auto multi-university fan-out
description: How a SIT-routed application auto-fans-out to all permitted member universities, and the invariants that keep it idempotent and non-regressing.
---

# SIT automatic multi-university fan-out

When a student's application resolves to the SIT aggregator, it is auto-fanned to
ALL permitted SIT member universities by REUSING the shared apply-to-all core —
there is deliberately NO parallel matcher/engine.

## Design invariants (why, not what)
- **Reuse `fanOutApplicationToUniversities`, don't fork it.** It already does
  exclusion → same-level `matchProgram` (X1/Y1) → advisory-locked application
  dedup/create (sets `mainApplicationId` so the runner's reactive X2/X3·Y2/Y3
  chain works) → submission dedup/enqueue. The X/Y fallback is applied REACTIVELY
  by the worker (`lib/portal-runner/src/fallback.ts`); do not add matching here.
- **Aggregator routing is expressed by one optional `routeVia:{universityKey}`
  param.** With it set, the per-candidate `submissionKey = routeVia.universityKey`
  (the aggregator) is used for the exclusion check, the submission-dedup `.where`,
  the advisory-lock key, AND the insert's `universityKey`; the insert also writes
  `meta {targetCatalogUniversityId, targetUniversityName, routedViaAggregator}`
  mirroring `enqueueIfEligible`. Each member still gets its OWN application row
  (keyed by member `crmUniversityId`), so `(applicationId, submissionKey)` stays
  unique per member. **Why:** credentials/adapter/dedup all live on the aggregator
  ('sit'), but each member is a distinct application the runner selects by name.
- **Legacy manual apply-to-all must stay byte-for-byte identical.** It calls the
  core WITHOUT `routeVia`, so `submissionKey === uni.universityKey` and every
  generalized branch collapses to the original behavior. Manual apply-to-all
  treats 'sit' as ONE standalone portal (no member fan-out) — that is unchanged.
- **Idempotency is `routeVia`-scoped.** Auto path dedup blocks on
  queued/running/**submitted** (re-triggers only fill gaps, never double-submit a
  member); manual path keeps queued/running only (button retry after completion).
  Failed rows stay retryable in both. **Why:** auto fires on EVERY stage change
  into a trigger stage, so a completed member must not be re-enqueued.

## Trigger + gates (`maybeFanOutSitStudentForApplication`)
Fire-and-forget from `applications.ts` after create and after stage-change patch;
it NEVER throws. Gate order: `SIT_AUTO_FANOUT` env (default OFF; true/1/yes/on) →
`settings.isEnabled` kill switch → trigger-stage membership (so auto agrees with
the per-app enqueue) → `resolvePortalRouting` must resolve `portalUni.universityKey
=== 'sit'` → `checkHasPortalCredentials('sit', adapterKey)` once → fan out in
`settings.mode` (dry/real) → `triggerBackgroundDrain` if queued>0 → `logAudit
("portal.sitAutoFanOut","student",studentId,{mode,members,...counts,total})`.

## Safety facts
- **No recursion:** fan-out inserts member applications DIRECTLY via the core, not
  through the `/applications` route, so it never re-triggers itself.
- **No circular import:** `applications.ts` → `portalAutomation.ts` is one-way
  (`portalAutomation.ts` never imports `applications.ts`).
- **Membership is authoritative via `isSitMember`** (`@workspace/portal-adapters`),
  applied on top of the enabled `portal_account_universities` rows under the active
  'sit' aggregator, so a stray junction row can't push a non-member into SIT.
- No migration: nothing schema-level was added; the feature is pure app logic.
