---
name: Portal claim stage-gating
description: How trigger_stages gates which queued submissions the auto/drain paths may claim, and which callers apply it vs skip it.
---

# Portal claim stage-gating

`claimNext(workerId, universityKeys?, triggerStages?)` in `lib/portal-runner/src/queue.ts`
gates claims by the application's CURRENT stage via a correlated
`EXISTS (SELECT 1 FROM applications a WHERE a.id = portal_submissions.application_id
AND a.deleted_at IS NULL AND a.stage = ANY($n::text[]))`.

**Semantics (the key contract):**
- `triggerStages === undefined` → stage filter is skipped entirely.
- `triggerStages` = an array (even `[]`) → filter applies; `[]` matches NOTHING
  (mirrors the enqueue-time candidate scan, which selects apps whose stage ∈ trigger_stages).

**Why:** Run Now / scheduled drain / the always-on worker were processing ANY queued
submission regardless of the app's stage — so an app that left a trigger stage (or was
manually queued) still got auto-submitted. The enqueue scan was already stage-filtered;
only the CLAIM side leaked.

**How to apply — which caller passes what:**
- Run Now (`portalAutomation.ts` run-now) → `drainQueue(workerId, settings.triggerStages ?? [])` (gated).
- Scheduled `drain-once.ts` → reads `settings.triggerStages`, passes to `claimNext(...)` (gated).
- Always-on `worker.ts` → loads `triggerStages` per tick, passes to `claimNext(...)` (gated).
- Manual `POST /portal-submissions/process-queued` → `drainQueue(workerId)` with NO stage arg
  (intentionally UNFILTERED — the "process everything" admin escape hatch).
- Manual single `POST /:id/process` uses `claimById` (by id, no stage gate) — unaffected.

`FOR UPDATE SKIP LOCKED` stays safe: only `portal_submissions` is locked; `applications`
is referenced only inside the EXISTS subquery so FOR UPDATE never tries to lock it.
portal-runner exports `./src/index.ts` (source, no dist) — no rebuild needed after editing queue.ts.
