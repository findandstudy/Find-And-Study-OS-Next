---
name: Topkapı Step 5 upload gate + uploadedSlots evidence
description: Mandatory-doc gate before final submit, positive upload verification, and signed-URL redaction in download errors.
---

**Rule:** Topkapı Step 5 uploads are per-slot logged and POSITIVELY verified (`$eval` on `input.files.length`); all four slots (photo/passport/transcript/diploma) must verify or the final "Başvuruyu Tamamla" is never clicked — return `submitted:false` + `missingDocuments` + Turkish `detail`. The gate sits AFTER the dry-run return (DRY branch untouched).

**Evidence field:** `SubmitResult.uploadedSlots?: string[]` flows into `portal_submissions.result_json.result.uploadedSlots` via the existing writeback spread. Reconcile script `artifacts/api-server/scripts/report-topkapi-missing-docs.ts` (read-only, list-only) flags rows with no evidence as "ŞÜPHELİ".

**Why:** Uploads were in a silent `try{}catch{}` — zero-document submissions were marked submitted and advanced the CRM stage to awaiting_offer while the university saw "Missing".

**Signed-URL redaction:** downloadFile error messages must strip the query string (`redactedUrl`) in BOTH duplicated builders (portal-runner + worker profile.ts) — doc fetch URLs carry `?exp=&sig=` and downloadErrors persist into result_json. Never embed a raw doc URL in a thrown message.

**Dedup:** `extractStudentDocumentRefs` keeps one doc per type (first wins; callers order created_at DESC → newest). Signed-route 404s now distinguish row-missing / empty-stub / storage-object-missing (fileKey in message).
