---
name: Portal process cred key + dropdown registry fallback
description: processSingle/process-queued credential key bug fix + /university-portals registry fallback for fresh PROD deploys
---

## Rule
`processSingle` and `process-queued` must call `lookupAdapterKey(universityKey)` first, then pass the result as the second arg to `resolvePortalCreds(universityKey, adapterKey)`. Never pass the same string for both args.

`/university-portals` must include a Step 2 that iterates `adapterMetadata()` and appends any registry adapter with DB or env credentials that isn't already in the portal_universities result.

**Why:**
- `portal_universities.adapter_key` may differ from `university_key` (e.g. `'topkapi_university'` vs `'topkapi'`).
- `portal_credentials` stores rows keyed on `adapter_key` (e.g. `portal_key='topkapi'`).
- `resolvePortalCreds(k, k)` collapses to a single-key lookup; since the two keys differ, the DB row is never found → "No credentials configured" → `status: failed`.
- `portal_universities` may be empty on a fresh PROD deploy even though `portal_credentials` has the adapter key — registry fallback ensures the dropdown always shows credential-ready adapters.

**How to apply:**
- Any new process endpoint that takes a submission and needs credentials: fetch `adapterKey` from DB first.
- Any endpoint returning credential-ready universities: merge DB list with `adapterMetadata()` fallback.
