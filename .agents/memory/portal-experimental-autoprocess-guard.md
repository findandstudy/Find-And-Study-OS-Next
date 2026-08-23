---
name: Portal experimental auto-process guard (two paths)
description: Experimental portal adapters must never auto-submit; the guard must be enforced in EVERY auto-process loop, not just one.
---

There are TWO independent auto-process loops that claim queued `portal_submissions`:
1. `artifacts/api-server/scripts/drain-once.ts` — scheduled one-shot drain.
2. `artifacts/portal-automation-worker/src/worker.ts` — continuous polling worker.

Both call `claimNext(workerId, allowlistKeys)`. `claimNext`'s second arg is an
ALLOWLIST of `university_key`s (empty/undefined ⇒ claims ANY queued row).

**Rule:** the experimental guard (`isExperimentalAdapterKey` from
`@workspace/portal-adapters`, families salesforce/sit/united/emu) must be applied
in BOTH loops by building the allowlist from `portal_universities` where
autoProcess=true AND isActive=true AND deletedAt IS NULL, then filtering OUT
experimental adapter keys. Manual single-submission via the API (processSingle /
process-queued) is the operator path and intentionally bypasses this guard.

**Why:** a reviewer caught that worker.ts called `claimNext(WORKER_ID)` with no
allowlist, so it could auto-submit experimental adapters even though drain-once
excluded them — the invariant "worker never auto-submits experimental" was only
half-enforced. Fixing one path is not enough; grep for every `claimNext(` call.

**How to apply:** when adding/auditing any auto-processing entry point, confirm it
restricts the claim allowlist to non-experimental auto-process universities.
`isExperimentalAdapterKey` resolves by adapter KEY (e.g. "uskudar"), not family
name ("salesforce") — pass real keys (test TR10 in test-registry.ts).
