---
name: System-wide document size policy
description: processUpload() chokepoint compresses uploads >2MB (sharp/ghostscript); where it is and isn't wired.
---

Single chokepoint `processUpload()` (api-server `src/lib/uploads/processUpload.ts`) compresses any buffer over `TARGET_MAX_BYTES` (default 2MB, env-overridable) down to portal-ready size — sharp ladder for images (resize→JPEG quality 85→60, PNG falls back to JPEG), ghostscript `/ebook`→`/screen` for PDFs (picks smallest). Hard-rejects (`UploadTooLargeError`) anything still over `MAX_UPLOAD_BYTES` (default 15MB). Non-compressible types (docx etc.) pass through as-is under the hard cap.

Two wiring patterns depending on whether the server sees raw bytes at upload time:
- **Server sees bytes directly** (local-driver PUT in `storage.ts`, base64 `fileData` bodies in `applicationStageDocuments.ts` / `embed.ts` widget intake): call `processUpload()` inline before writing/storing.
- **Server never sees bytes** (GCS-driver signed-PUT flow, or object-storage `fileKey`/`objectPath` registration in `documents.ts` / `staffCards.ts`): use `recompressStoredObjectIfNeeded(fileKey, mimeType)` in `documentBytes.ts` — fetches the just-uploaded object, compresses, overwrites the SAME key via `ObjectStorageService.overwriteObjectBuffer()`. No-op fast path when already ≤ target.

**Known gap:** WhatsApp/Meta inbound media (`recordInboundDocuments` in `lib/inbox/leadCapture.ts`) only stores a `fileKey = wa:<mediaId>` placeholder row — it never actually downloads/stores the media bytes anywhere in this codebase (no object-storage write, no fileData). Serving these rows 404s today; this predates the size-policy work and is out of scope for it. If WA media byte storage is ever implemented, wire `processUpload`/`recompressStoredObjectIfNeeded` into that new ingestion point.

Backfill script `artifacts/api-server/scripts/backfill-compress-documents.ts` covers all three places docs live today: `documents.fileKey` (object storage), `documents.fileData`/`application_stage_documents.fileData` (legacy base64), `staff_documents.objectPath` (object storage). Idempotent, `--dry-run` supported, never deletes, keeps original bytes on hard-cap rejection or compression failure.

**Why:** Turkish university portals reject documents over ~2MB; agents/students were uploading unscanned/oversized phone photos and PDFs that silently failed portal submission far downstream. Centralizing at one chokepoint (rather than per-route ad hoc limits) means every future intake point just needs one of the two call patterns above.
