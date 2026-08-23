---
name: Auto education-extract trigger on document upload
description: Contract of the automatic transcript/diploma/degree upload trigger and the shared extraction core.
---

The extract-education core lives in a shared lib (`educationAutoExtract.runEducationExtraction`) used by BOTH the manual staff endpoint and the automatic document-upload trigger — never duplicate the flow back into the route.

**Rules:**
- Trigger doc types (`isEducationTriggerDocType`: transcript/diploma/degree, regex, case-insensitive) MUST all be present in `EDUCATION_SOURCE_DOC_TYPES` (the AI input doc query). If not, a degree-only upload triggers a run that finds 0 docs → useless NO_EDUCATION_DOCUMENTS. Guarded by test AT-6.
- Auto path is fire-and-forget: `maybeTriggerAutoEducationExtract` (setImmediate + try/catch/finally, per-student in-flight Set, `skipIfFilled: true`). Upload response never waits on or fails due to it.
- `skipIfFilled` checks data-bearing records via `educationRecordHasData` — empty placeholder rows do NOT block; filled rows mean NO AI call and NO overwrite (idempotent).
- Audit action for the auto path: `auto_education_extract`; manual endpoint keeps `ai_extract_education`.
- Only routes/documents.ts POST /documents fires the trigger (other document insert paths intentionally out of scope).

**Why:** the shared prompt was extracted to `lib/extractPrompt.ts` to avoid a lib→route circular import; the route imports it, not the other way around.
