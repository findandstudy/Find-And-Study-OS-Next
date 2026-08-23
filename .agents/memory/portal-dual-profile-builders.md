---
name: Dual portal profile builders + Step-3 field normalization
description: Two SubmitProfile builders must stay in sync; GPA ranges and graduation year need normalization, not Number()
---

There are TWO independent code paths that build a portal `SubmitProfile` from a
CRM student+application, and they drift:

- `lib/portal-runner/src/profile.ts` `buildSubmitProfileFromRecords` — api-server
  "Run Now" / poller path (and the dry-test CLI via `buildProfileFromApplication`).
- `artifacts/portal-automation-worker/src/profile.ts` `buildStudentProfile` — the
  production worker.

**Rule:** any new Step-3 / education field (schoolName, gpa, graduationYear, …)
must be mapped in BOTH builders, or one path silently fills "-"/undefined and the
adapter's fail-visible verify/retry gate reports "empty after retry" despite real
DB data. This drift has recurred multiple times (fix landed only in the
`artifacts/portal-automation-worker` copy while the CANLI worker actually runs
`lib/portal-runner/src/profile.ts`, so the fix "went to the wrong copy"). When a
"data not filled" bug has real DB data, diff the TWO `buildProfile({...})` objects
field-by-field first.

**Field-name traps (DB column ≠ profile key):** `passportExpiryDate` (profile) ←
`student.passportExpiry` (NOT `student.passportExpiryDate`, which doesn't exist);
`passportIssueDate` ← `student.passportIssueDate`; `languageScore` ←
`student.languageScore` (Number()-coerced, safe because `buildProfile`'s
`firstFiniteNumber` degrades NaN→undefined). SIT create/add-student webhook sends
these; empty passport dates/lang score = "bilgiler tam girilmemiş" on SIT.

**GPA:** never `Number(data.gpa)` — CRM GPA is free-form ("2.8-3.0", "2,8 – 3,0",
"3 to 3.5") → `Number()` yields NaN → "NaN"/"-" → portal rejects. Use the shared
`normalizeGpaRange` (exported from `@workspace/portal-adapters`): range→upper
bound, comma→dot, empty→undefined, unparseable→throw. Pass RAW `student.gpa`
through to `buildProfile`, which normalizes internally.

**Graduation:** CRM stores a year-only int; a native `<input type=date|month|week>`
silently clears a bare "2025". Detect the REAL DOM widget type at runtime and
expand via `formatGraduationForInput` / `formatGraduationForDatepicker`
(`lib/portal-adapters/src/universities/topkapi/format.ts`). Topkapı's
`twopulse-datepicker` is `type=text` so it needs the datepicker variant
(data-date-format driven, default dd.mm.yyyy), not the bare year.

**Why:** Step 3 failed "empty after retry" because the runner builder never mapped
schoolName/graduationYear and both builders NaN-coerced GPA ranges. Keep the
fail-visible gate; fix the data flow + normalization underneath it.

**Photo/documents for URL-fetching create webhooks (e.g. SIT):** these adapters
POST document URLs, not local files, so the URLs must ride on the profile:
`SubmitProfile.photoUrl` + `SubmitProfile.studentDocuments` (`StudentDocumentRef[]`).
Both builders must set them from the CRM `documents` rows via the shared
`extractStudentDocumentRefs` (in `@workspace/portal-adapters`): first content-bearing
photo/photograph row = photoUrl (excluded from documents); rows with no
`fileUrl`/`fileKey` skipped. Select rows with `sizeBytes`/`mimeType` and
`orderBy(desc(createdAt))`. There are THREE builder entry points to keep in sync:
runner `buildSubmitProfileFromRecords` + `buildProfileFromApplication`, and worker
`buildStudentProfile`. Prefer `fileUrl` (public, fetchable) over `fileKey` (object
storage, may need auth); adapter logs each URL with query string stripped (token
safety) and never throws on missing data.
