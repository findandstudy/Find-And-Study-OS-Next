---
name: Portal document stub-vs-content mismatch fix
description: Why portal submissions show "missing slots" even when docs appear uploaded in CRM.
---

## The pattern (2026-06-02 data corruption)

When a student document was "replaced" via POST /documents:
1. Old record (with `file_data` base64 content) got soft-deleted
2. New stub record inserted with no file content (fileKey=NULL, fileUrl=NULL, fileData=NULL)
3. GCS upload step abandoned → stub stays empty forever

Worker queried only non-deleted records → found empty stubs → all 4 slots "missing".

## Root cause in code

`POST /documents` replace guard was: `if (resolvedStudentId && type)` — fired even when new upload had no fileKey/fileUrl. **Fixed to: `if (resolvedStudentId && type && (fileKey || fileUrl))`**.

## Worker fix

`lib/portal-runner/src/profile.ts` (used by worker.ts via @workspace/portal-runner):
- Added `fileData` to SELECT
- Content-sort (content-bearing rows before stubs)
- Empty stub skip
- Base64 fallback when URL absent/fails
- `filledSlots`, `missingSlots`, `downloadErrors` in return type

Same fix applied to `artifacts/portal-automation-worker/src/profile.ts` (used by run-once.ts).

## Validation tool

`pnpm --filter @workspace/portal-automation-worker validate-profile -- --id <sub_id>`

## Who was affected (prod)

- Student 1981 KAMILA TABISHCHEVA: stubs 3856-3859 fixed (file_data copied from 3852-3855)
- Student 1982 SANA TARIQ: fixed in prior session (undeleted 3860-3863)

**Why:** don't let POST /documents soft-delete old content unless new upload has verified content.
