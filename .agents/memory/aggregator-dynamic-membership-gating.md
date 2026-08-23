---
name: Aggregator dynamic membership + auto-drain gating
description: How United/SIT-style aggregator adapters combine static allowlists with live DB membership, and why auto-drain doesn't need a separate experimental-family blanket exclusion once enqueue already scopes by membership.
---

## Dynamic membership: UNION, not replace

Aggregator adapters (United, SIT, ...) originally gated on a hardcoded
allowlist of member universities. When a panel-managed DB list
(`portal_account_universities` JOIN `universities`) became available, the
membership check was extended to accept an optional dynamic list, matched
with the same token-set logic as the static list, and **unioned** with it
rather than replacing it.

**Why:** a transient DB read failure (dynamic list load throws/returns `[]`)
must never revoke a member the static list already grants — the static list
is a resilience floor, not dead code. It also means a spec asking to make
the hardcoded list "unused" needs an explicit product-policy conversation:
UNION satisfies "the DB list works" and "routing is DB-driven" but does not
satisfy a literal "static list must never be consulted" reading.

**How to apply:** when adding a new DB-membership source to an existing
allowlist gate, union rather than replace unless the requester explicitly
confirms the static list should be deleted. Flag the distinction in the
completion summary — don't let "should reference the DB" silently become
"static list still matters."

## Auto-drain gating doesn't need per-family blanket exclusion

Aggregator families were blanket-excluded from `worker.ts`/`drain-once.ts`
auto-drain via `isExperimentalAdapterKey`. That exclusion turned out to be
redundant once the enqueue path (`enqueueIfEligible` /
`resolvePortalRouting`) already writes `portal_submissions.university_key =
<aggregator's own key>` ONLY when DB routing found an actual member — so a
non-member application never gets a queued row under the aggregator's key
in the first place.

**Why:** once membership is enforced at write-time (enqueue), a read-time
blanket exclusion is enforcing the same constraint twice, and instead just
blocks the aggregator's OWN `autoProcess` toggle from ever taking effect —
even when an operator explicitly wants it on.

**How to apply:** before adding (or before removing) a defense-in-depth
exclusion like this, trace where the invariant is *actually* established
(usually the write path/enqueue), not just where it's *checked again*. If
the invariant already holds upstream, a downstream blanket exclusion is
often just blocking legitimate opt-in, not adding safety. `registry.ts`'s
`isExperimentalAdapterKey`/`EXPERIMENTAL_FAMILIES` stay in place for
API/display purposes (e.g. an `experimental: true` badge) — only the
auto-drain gate itself was redundant.
