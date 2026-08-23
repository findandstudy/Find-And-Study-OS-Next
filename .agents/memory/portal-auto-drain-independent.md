---
name: Portal auto-drain independent of fan-out
description: How auto-drain (immediate + scheduled) is gated and why Run Now's bulk scan does not fire the immediate drain hook.
---

# Portal auto-drain (immediate + scheduled)

Rules:
- Draining queued portal submissions is owned by exactly one of two modes, both gated on `isEnabled` (kill-switch stays the single gate):
  - Scheduled OFF (`auto_process_enabled=false`): every successful `enqueueIfEligible` → `status:"queued"` fires the shared non-blocking `triggerBackgroundDrain` (via a dynamic import from the auto-trigger lib — same circular-dep pattern as `maybeFanOutStudentForApplication`). Passes `settings.triggerStages` so the drain is stage-gated like Run Now.
  - Scheduled ON: a ~60s tick scheduler (`startPortalAutoDrain` / `runPortalAutoDrainTick`) drains when `auto_process_interval_minutes` elapsed since `last_auto_drain_at`; updates `last_auto_drain_at` only after a COMPLETED drain (failed drain retries next tick).
- The Run Now bulk scan (`scanAndEnqueueTriggerStageApplications`) deliberately does NOT fire the immediate-drain hook.

**Why:** Run Now drains inline right after the scan, gated on `!_processMutex`; a background fire racing for the mutex would make Run Now report `drained=false/processed=0` nondeterministically even though rows get processed. The four fan-out `triggerBackgroundDrain` call sites drain ALL stages (no stage filter) by design — leave them argument-less.

**How to apply:** Any new enqueue path should call the `maybeTriggerImmediateDrain(settings, label)` helper in `portalAutoTrigger.ts` after a queued outcome (uses the already-loaded settings row — no extra query). For tests, inject a spy via `__setDrainTriggerForTests` and drive scheduler ticks via `runPortalAutoDrainTick()` directly — never real timers.
