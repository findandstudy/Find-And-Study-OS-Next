---
name: Background delivery worker claim vs delivered state
description: Why a background delivery/dispatch worker must separate its claim lease from its delivered flag, not reuse one timestamp for both.
---

A setInterval/background worker that picks up DB rows to deliver (emails, renders, webhooks) must NOT reuse a single "done" timestamp as both the claim token and the delivered marker.

**Why:** If you claim a row by setting the same column you later treat as "delivered" (e.g. `emailed_at = now()` up front, then "skip rows where emailed_at IS NOT NULL"), a crash/restart between claim and actual delivery leaves the row marked done forever — delivery is permanently lost with no retry. Conversely, if you only set the flag on success with no claim, two instances can double-process the same row.

**How to apply:** Use two distinct columns/states:
- a lease column (e.g. `delivery_claimed_at`) set atomically at claim time;
- a delivered column (e.g. `emailed_at`) set ONLY after all required steps succeed.
Candidate rows = `delivered IS NULL AND (claim IS NULL OR claim < now()-leaseTimeout)`. Claim with the same predicate via conditional UPDATE ... RETURNING (atomic, cross-instance safe). On success set delivered; on failure clear the lease (or let it expire) so it retries. Add a module-level re-entrancy guard so a sweep that outlasts the interval (slow Chromium render) never overlaps itself. Order delivery so the only throwing step before the irreversible side effect (e.g. signer email) is last, to avoid duplicate sends on retry. Bound retries with a recent-signed window so a permanently-broken row is eventually abandoned instead of hammering the renderer.
