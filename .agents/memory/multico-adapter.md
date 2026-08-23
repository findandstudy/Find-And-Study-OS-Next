---
name: Multico adapter ()
description: HTTP-first aggregator adapter for Topkapı Central Asian/Mongolian exclusive channel; key implementation decisions and known gotchas.
---

# Multico adapter

## Key facts
- **File**: `lib/portal-adapters/src/universities/multico/adapter.ts`
- **Family**: `"multico"` in `EXPERIMENTAL_FAMILIES` — auto-process gates until 3 confirmed submissions
- **Transport**: HTTP-first via `page.request.get/post()` after a single Playwright browser login

## isMulticoNationality — bidirectional substring
```ts
return MULTICO_NATIONALITIES.some((n) => lower.includes(n) || n.includes(lower));
```
**Why:** One-directional check fails for demonym/adjective forms.
`"turkmen".includes("turkmenistan")` = false (broken); `"turkmenistan".includes("turkmen")` = true ✓

## parseSelectOptions regex — must use double backslash
```ts
// CORRECT in template literal passed to new RegExp():
`...(([\\s\\S]*?))<\\/select>`
// WRONG — [\s\S] in a template string de-escapes to [sS]:
`...([\\s\\S]*?)<\\/select>`  // ← reads as [sS] ← only matches s or S
```
**Why:** JS consumes `\s` → `s` in template literals. Always double-escape in `new RegExp(template)`.

## externalRef format: "studentId:applicationId"
Stored as `"123:456"`. `checkStatus()` splits on the last `:` to get both IDs for `pollStatus()`.

## Dry-run behavior for duplicate students
`wouldApply: !alreadyExists` — when the student already exists, `wouldApply=false` (operator must verify before re-applying). Same for `wouldCreateStudent`.

## checkStatus — periodic status-sync with writeback
- `UniversityAdapter.checkStatus?()` method (in types.ts) implemented by multico
- `mapMulticoPortalStatus(raw)` maps portal strings → `"accepted"` / `"rejected"` / `null` (non-terminal)
- `startPortalStatusSync()` in portalAutomation.ts: 10-min interval, picks `status=submitted & adapter_key=multico`
- Terminal transitions: updates `portal_submissions.status` to `accepted`/`rejected` AND writes `result_json.portalStatus`; emits `dispatchNotification` (`portal.application_accepted` / `portal.application_rejected`)
- Non-terminal transitions: updates `result_json.portalStatus` only, status stays `submitted`
- `resolveAdapterByKey()` is async — must be `await`ed or `checkStatus`/`login` accesses silently fail
- Wired in `index.ts` alongside `startPortalStuckReset`/`startPortalAutoDrain`

## portal_submission_status enum additions
- Added `"accepted"` and `"rejected"` to `portalSubmissionStatusEnum` in `lib/db/src/schema/portalSubmissions.ts`
- Boot DDL: two `ALTER TYPE portal_submission_status ADD VALUE IF NOT EXISTS` statements in `api-server/src/index.ts`

## portal_credentials placeholder
Boot DDL Step 2b12c inserts `portal_key='multico', username_enc='', password_enc='', is_active=false`. This is an unconfigured placeholder — `resolvePortalCreds` requires `is_active=true` so it won't be used until an admin sets real credentials via the management UI.

## Nationality-redirect hook (portalAutoTrigger.ts)
After Gate 2 in `enqueueIfEligible` (~line 305): Topkapı + Central Asian student → reassigns `portalUni` to multico row; `submissionUniversityName` keeps "Topkapı University" display name.

## Boot DDL (api-server/src/index.ts, Step 2b12c)
- `portal_universities` row (`university_key='multico'`, `auto_process=false`)
- 7 `portal_university_exclusions` rows (topkapi × each nationality)
- `portal_credentials` placeholder row (is_active=false)
- Confirmed: `[migrate] Multico portal_universities + topkapi exclusions seeded`
