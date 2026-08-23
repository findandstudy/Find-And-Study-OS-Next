---
name: Exclusive-region nationality exclusion + dual status-derivation sites
description: How university nationality exclusions skip the portal, and the two places a new portal_submission_status must be wired.
---

# Exclusive region (university nationality exclusion)

A university can exclude specific nationalities ("Exclusive bölge"). When a
student's nationality is on the list the worker must SKIP the portal entirely
(no login/submit) and mark `status='exclusive_region'` with
`Exclusive bölge — <agency> üzerinden başvurulmalı`.

- **Preventive** check (`resolveNationalityExclusion` in portal-runner
  `exclusions.ts`) runs at the START of `runSubmission`, BEFORE adapter
  resolve/login, for BOTH dry and real modes. Match is case-insensitive +
  trimmed, must be enabled and not soft-deleted.
- **Reactive** safety net (`detectExclusiveRegion` in portal-adapters) is wired
  into the Topkapı submit **not-saved** branch only, so it never overrides a
  successful submit.
- `exclusive_region` is **permanent / no-retry**: `claimNext` only picks
  `status='queued'`, so any non-queued terminal status is naturally never
  requeued. Do NOT add it to any requeue path.

## Rule: a new portal_submission_status has TWO status-derivation sites

**Why:** the DB status is written by `resolveTarget()` in portal-runner
`stageWriteback.ts`, but the api-server ALSO derives an *inline* status in
`runWithTimeout` (`artifacts/api-server/src/routes/portalAutomation.ts`) for the
immediate manual/process API response. They drift silently — a status added only
to writeback still returns `"failed"` to API callers (program_full had this bug
too).

**How to apply:** when adding a portal submission status, update ALL of:
1. `portal_submission_status` pgEnum (lib/db schema) + boot DDL `ADD VALUE` +
   migration.
2. `resolveTarget()` precedence in `stageWriteback.ts` (structural statuses like
   exclusive_region / program_full come BEFORE program_missing/alreadyExists and
   BEFORE dryRun).
3. `ProcessSingleResult` union + the inline `status` ternary in
   `runWithTimeout` (portalAutomation.ts) — mirror the resolveTarget precedence
   (structural before dryRun) so the API response matches the DB.
   (The list-filter `listQuerySchema` enum is a separate input filter and is
   intentionally NOT exhaustive.)
