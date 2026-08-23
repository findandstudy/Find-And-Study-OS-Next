---
name: Admin-contract deadline suspension
description: How agent-panel admin-sent contracts enforce a signing deadline by suspending the user account, and the two traps that cause false suspensions.
---

Admin-sent (non-onboarding) contracts surface in the agent panel as a non-blocking
dashboard card; if unsigned past the 14-day deadline the agent's `users.isActive` is
set false (requireAuth then 403-blocks until an admin reactivates). Enforcement runs
as a side effect on every panel navigation (the onboarding-status route + the
pending-contracts list), not via a cron only.

**Rule 1 — filter by `mode = "admin_driven"`.** Non-onboarding sessions also include
`self_fill` mode. Selecting only `isPrimaryOnboarding = false` is too broad and would
suspend agents over self-fill links. Always also require `mode = "admin_driven"`.

**Rule 2 — only suspend when the conditional expire actually applied.** Expire with a
status predicate (`WHERE id = ? AND status = <pending status>`) and use `.returning()`;
only count a missed deadline when a row comes back. A row read as past-due in memory may
have been signed concurrently between the SELECT and the UPDATE — without the rowcount
check you suspend an account whose contract was signed in time.

**Why:** both traps produce false suspensions (locking out paying agents). The race is
silent because the update "succeeds" (0 rows) without throwing.

**How to apply:** any deadline-driven account-suspension side effect must (a) scope to
the exact session class it owns, and (b) gate the destructive action on the affected
row count of the same predicate, never on the in-memory snapshot.
