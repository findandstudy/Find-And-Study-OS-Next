---
name: GCS upload on sign hot path → OOM 403
description: Storing signature PNG via GCS uploadBuffer during the sign POST OOM-kills autoscale and causes opaque proxy 403.
---

## Rule
Never put a GCS (object storage) upload on the sign-contract request path. Store the signature as a base64 TEXT column in `signed_contracts` at sign time; upload to GCS lazily inside `ensureSignedContractPdf` on the first PDF download request.

**Why:** `uploadBuffer` can take up to 30 s on the autoscale instance. During that window the process RSS climbs and/or a concurrent worker runs, pushing it over the memory limit. The kernel kills the process silently (no log), and the edge proxy returns its own opaque HTML `403 Forbidden` page. The DB transaction never commits, so there is no `signed_contracts` row and no evidence of the attempt.

**How to apply:**
- `finalizeSign`: strip the GCS upload entirely; store `signatureImageBase64 = rawBase64` in the insert.
- `ensureSignedContractPdf` (lazy PDF download): check `row.signatureImageBase64` first; fall back to `row.signatureImageObjectKey` (GCS) for rows signed before this change. After reading from the DB column, upload to GCS as a best-effort background step and update `signatureImageObjectKey` for future renders.
- Schema: `ALTER TABLE signed_contracts ADD COLUMN IF NOT EXISTS signature_image_base64 TEXT` (idempotent migration in `index.ts`).
- Also: remove any synchronous Chromium endpoint on the request path (e.g. `GET /public/sign/:token/preview-pdf`) for the same OOM reason — use the HTML `/preview` endpoint instead.

**Diagnosis hint:** If OOM was the cause, `signed_contracts` will have zero rows for the failed attempts (transaction never committed), and `fetch_deployment_logs` will show no `[contracts/sign] start` log for the failed request window (process died, no log).
