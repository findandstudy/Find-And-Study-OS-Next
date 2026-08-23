---
name: edcons stage-document upload surfaces parity
description: Multiple separate UI components upload application stage documents; stage-behavior features must be mirrored across all of them.
---

# Application stage-document upload surfaces must stay in parity

There are (at least) THREE independent UI surfaces that POST to
`/api/applications/:id/stage-documents`:

- `StageDocUploadDialog.tsx` — the pipeline/kanban "Document Required" dialog.
- `StageDocumentsPanel.tsx` — a detail-page panel (full-featured).
- `ApplicationDocumentsPanel.tsx` — the other detail-page "Application Documents" panel (drop-zone style).

**Rule:** any backend stage-behavior requirement (from `pipeline_stages`, e.g.
`requiresValidUntil`, `tracksOfferExpiry`) that the upload endpoint enforces must
be honored in EVERY one of these surfaces, or one path silently 400s while the
others work.

**Why:** the Offer Letter (`offer_received`, `requiresValidUntil=true`) upload
worked from the pipeline dialog and `StageDocumentsPanel` but failed from
`ApplicationDocumentsPanel` with `HTTP 400: validUntil is required for this stage`
because that panel never collected/sent `validUntil`.

**How to apply:** when adding a stage-behavior flag enforced by
`applicationStageDocuments.ts`, grep all three components and add the same
gate + field. Reuse the existing `stageDocs.*` i18n keys (validUntilFieldLabel /
toastValidUntilRequired / toastValidUntilRequiredDesc) — already in all 10 locales.

## Auto stage-advance on upload is per-surface too

The kanban dialog auto-advances the application stage after upload via a
FRONTEND `PATCH /api/applications/:id { stage }` (NOT a backend hook — the only
backend auto-advance is the narrow `missingDocsFulfillment` for missing_docs
waiting stages). The two detail-page panels originally did NOT advance, so
uploading e.g. an Offer Letter there left the card in the old stage.

**Rule:** forward-only auto-advance (uploaded stage `sortOrder` > current stage
`sortOrder`) must be mirrored in every upload surface. Detail-panel document
categories ARE pipeline stage keys, so the advance target = the uploaded
category/stage itself. It is naturally staff-gated because non-staff can't see
future-stage upload zones (`restrictFuture`/`hideUpload`), and the PATCH also
enforces permission server-side. Reuse `stageDocUpload.toastUploadedAndMoved`.
