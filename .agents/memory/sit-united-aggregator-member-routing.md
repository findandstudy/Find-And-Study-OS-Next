---
name: SIT/United aggregator member routing
description: How member universities of an aggregator portal (SIT/United) are made submittable and routed to the aggregator adapter without a schema migration.
---

# Aggregator member routing (SIT / United)

An aggregator portal (e.g. `study_in_turkey`→adapter `sit`, `united_education`→adapter `united`) submits on behalf of many member catalog universities. Members are declared in `portal_account_universities` (`portal_key` = aggregator `university_key`, `catalog_university_id` = `universities.id`, `enabled`). A member usually has NO own `portal_universities` row; some have a standalone row that points at the WRONG adapter and lacks the aggregator's credentials.

## Rule
`resolvePortalRouting({universityId,universityName})` (in `portalAutoTrigger.ts`) resolves membership FIRST (member→aggregator WINS over any standalone row), else falls back to `findActivePortalUniversity`. Use it in EVERY submittability/enqueue surface: auto-enqueue gate, manual submit, resolve preview, and the eligible-applications list (added a `university_key IN (enabled memberships for a.university_id)` branch to the join OR + a `CASE WHEN membership THEN 0 ELSE 1` tiebreak so `DISTINCT ON (id)` prefers the aggregator).

**Why:** members were getting NO_PORTAL/NOT_FOUND (no standalone row) or routing to a credential-less wrong adapter (standalone row wins by default).

## Submission encoding (no migration)
- `universityKey` = aggregator key (drives dedup, advisory lock, creds, adapter).
- `universityName` = MEMBER name (display + the runner's name-based adapter fallback).
- `meta` (existing `portal_submissions.meta jsonb`) = `{targetCatalogUniversityId, targetUniversityName, routedViaAggregator}`.

## Runtime adapter resolution (adapter_key mapping)
The shared runner (`lib/portal-runner/src/runner.ts` `runSubmission`) resolves the adapter in priority order: `opts.adapterKey` → `resolveAdapterKey(submission.universityKey).adapterKey` → raw `universityKey` → `adapterForUniversity(name)`. Consulting `resolveAdapterKey` (which reads `portal_universities.adapter_key`) is what maps an aggregator key to its registered adapter (`study_in_turkey`→`sit`, `united_education`→`united`).

**Why:** the aggregator's OWN row returns `routedVia=null` (its `crm_university_id=NULL`), and every caller only forwarded `adapterKey` to the runner when `routedVia` was truthy — so the runner fell to `adapterByKey(rawKey)=null` then name fallback → `NO_ADAPTER` (or wrong standalone `salesforce:atlas` for a member that also has a standalone row). Do NOT rely on the name fallback for aggregators; it silently drifts.

**How to apply:** any NEW adapter-resolution path must go through `resolveAdapterKey(universityKey).adapterKey` FIRST (the dry CLI `portal-dry.ts` mirrors this so it accepts an aggregator key + loads creds under the real adapter key). Standalone portals where `universityKey===adapter_key` (topkapi etc.) are byte-identical because `resolveAdapterKey` returns the same key. `adapterByKey` keys are literal: sit adapter `PORTAL_KEY="sit"`, united `key:"united"`. The worker's own legacy `portal-automation-worker/src/runner.ts` is dead code (run-once.ts + worker.ts import `runSubmission` from `@workspace/portal-runner`, not it).

**Credentials for routed submissions:** the worker resolver `credResolver.resolvePortalCreds(portalKey, adapterKey?)` is DB-first, so a member (e.g. `aydin`) that has its OWN portal_credentials row will shadow the aggregator's creds if you pass the member key as BOTH args (the adapterKey fallback only fires when adapterKey !== portalKey → SIT Supabase login 400). EVERY cred-resolution call site must first `resolveAdapterKey(sub.universityKey)` then `resolvePortalCreds(routedVia ?? universityKey, adapterKey)` (mirrors api-server `portalAutomation.ts`). Fixed in `worker.ts` (auto loop) + `scripts/run-once.ts` (manual CLI); `drain-once.ts` deliberately out of scope. Direct portals: routedVia null + adapterKey===universityKey → byte-identical to old (member,member) call.

**Member→aggregator precedence at adapter level:** a member submission is encoded with `universityKey=study_in_turkey` (routing layer, `resolvePortalRouting`), so resolving `sit` before the name fallback guarantees the aggregator adapter wins over the member's standalone adapter.

**Validation:** no aggregator/membership/creds rows exist in dev or prod yet — validate by temporarily seeding then cleaning up.
