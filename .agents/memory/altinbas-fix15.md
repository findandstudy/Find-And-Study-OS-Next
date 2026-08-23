---
name: Altınbaş FIX-15 adapter improvements
description: LWS success detection, resume flow, form hardening, education_records table+API+profile builders
---

# Altınbaş FIX-15

## Part A — LWS EduhubNavigateToURL success detection
At the FINISH step, BEFORE `!auraActionSucceeded(raw)`, match:
```
/EduhubNavigateToURL[\s\S]{0,600}?Cannot open:\s*https?:\/\/apply\.altinbas\.edu\.tr\/partner\/s\/my-applications\?id=([^"'\s\\&]+)/i
```
This nav-block IS a success signal — Salesforce LWS blocked the redirect but the Application__c was created. Extract externalRef from the URL token.

**Why:** LWS cross-origin restriction fires AFTER the SF record is written. Treating it as failure causes false negatives.

## Part B — isDuplicatePassport → resume flow
`guard()` sets `_duplicateSignal = true` (not `result.alreadyExists` directly). At the commit loop and Personal guard call sites:
1. Call `tryResumeFromMyApplications(page, profile, rt, result)`
2. If `true`: set `resumeMode = true`, update `curRank`, continue
3. If `false`: set `result.alreadyExists = true` (FIX-14 fallback)

`tryResumeFromMyApplications()` navigates to `/partner/s/my-applications`, finds first "Signed Up" row, clicks "Complete Application", waits for `rt.lastRaw` to update.

**Why:** "Signed Up" = incomplete SF application from a prior partial run. Resuming it avoids creating duplicate SF records.

## Part C — Form contract hardening (flow-fields.ts)
- `formatDateDmy(iso)`: converts ISO to "d MMM yyyy" (Altınbaş expects "15 Jan 2000")
- Phone: local digits only — NO dial prefix (e.g. "05321234567" not "+905321234567")
- `buildEducationalFields(ids, edu?)`: accepts optional EduRecord to pre-fill edu fields
- `buildQuestionnaireFields(visaSupport?)`: passes visa support answer

## Part D — education_records
- **Schema**: `lib/db/src/schema/educationRecords.ts` — UNIQUE index on (studentId, level); level CHECK ('high_school','bachelor','master'); source CHECK ('manual','ai_extracted','migrated')
- **Boot DDL**: step 2b22 in `artifacts/api-server/src/index.ts` — CREATE TABLE + named unique index + migration from flat students columns
- **API**: `artifacts/api-server/src/routes/education-records.ts` — GET/PUT at `/api/students/:id/education-records[/:level]`
- **AI upsert**: `artifacts/api-server/src/routes/ai-extract.ts` — auto-upserts when `studentId` + `documentType` matches diploma/transcript; returns `eduUpserted` field
- **Profile builder**: `artifacts/portal-automation-worker/src/profile.ts` — queries educationRecordsTable, sets `profile.educationRecords` AFTER `buildProfile()` call (buildProfile ignores unknown fields)
- **SubmitProfile type**: `lib/portal-adapters/src/types.ts` — `educationRecords?: Array<{level, schoolName, country, fieldOfStudy, startYear, endYear, gpa, gpaType}>`

## Part T008 — Staff sidebar Education tab
`EducationRecordsTab` component added BEFORE the `export default function StudentDetail` in `artifacts/edcons/src/pages/staff/StudentDetail.tsx`. Uses `useQuery` to fetch `/api/students/:id/education-records`. 21 i18n keys added to all 10 locale files (en/tr/ar/fr/ru/fa/zh/hi/es/id) under `studentDetailPage.*` namespace.

**Why:** This is kept as an inline component (not a separate file) to avoid Fast Refresh mixed-export issues.
