---
name: Portal cross-row max-failures gate
description: Why failed submissions must be capped at enqueue side, never at claimNext
---
Rule: automatic portal re-enqueue is capped cross-row — if ≥3 non-deleted `failed` submissions exist for an application×universityKey pair, auto paths (stage trigger enqueueIfEligible AND aggregator routeVia fan-out) skip; manual single-submit endpoint bypasses intentionally.

**Why:** `failed` is not in ACTIVE_STATUSES dedup, so every scan/trigger created a fresh queued row forever (prod infinite loop). Gating `claimNext` on `attempts < max_attempts` is WRONG: attempts increments at claim, failed rows never auto-requeue per-row, and the manual Retry button re-queues without resetting attempts — an attempts gate silently dead-locks retried rows (TAP4 protects this).

**How to apply:** any new auto-enqueue path must count failed rows inside the same `pg_advisory_xact_lock(appId, hashtext(uniKey))` tx as the dedup check. Constant `MAX_AUTO_FAILED_SUBMISSIONS` exported from portalAutoTrigger.
