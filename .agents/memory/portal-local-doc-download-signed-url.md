---
name: Browser-portal local document download must use signed URLs
description: Raw fileKey/fileUrl download for browser-upload adapters silently succeeded on SPA HTML; fix pattern and guard.
---

Browser-upload portal adapters (Topkapı/United/emu/okan/salesforce — everything
except "sit") download CRM documents to local temp files before handing them
to the browser upload widget. The api-server does NOT serve raw
`/objects/uploads/<fileKey>` paths as files — unmatched routes fall through to
the SPA `index.html` (200, text/html). A naive `fetch(url); if (res.ok) …`
treats that 200 as success, producing an HTML blob "document" and silently
empty/corrupt upload slots.

**Why:** SIT's create-webhook path was already fixed to resolve document URLs
through `docFetchUrl()` (own public URL, else the signed
`/api/documents/:id/file` path) and was proven working. The browser-adapter
download path (`doc.fileUrl ?? doc.fileKey` raw) was never migrated to the
same primitive, so it inherited the SPA-fallback bug.

**How to apply:**
- Never trust a bare fileUrl/fileKey string for local download — always
  resolve through `docFetchUrl()` (exported from `@workspace/portal-adapters`)
  first, base64 fileData only as the true last resort.
- `downloadFile()` must reject on content-type `text/html` AND body-sniff the
  first ~512 bytes for `<!doctype html>`/`<html`/SPA-shell markers — a
  mislabeled 200 is not proof of a real file.
- There are TWO duplicate download implementations that must be kept in sync:
  `lib/portal-runner/src/profile.ts` (`downloadStudentDocuments`, real
  production `buildStudentProfile` used by `worker.ts`) and
  `artifacts/portal-automation-worker/src/profile.ts` (used by the
  `validate-profile`/`run-once` manual scripts only). See
  `portal-dual-profile-builders.md` for the general pattern.
- Guard: before calling a browser adapter, block submission when the student
  has ≥1 content-bearing CRM document row but 0 filled upload slots (broken
  pipeline) — but do NOT block a student with genuinely zero CRM documents
  (pre-existing behavior, and SIT's own separate zero-doc guard, must stay
  untouched). Distinguish adapters by family via `isSitFamilyKey(adapterKey)`
  from `@workspace/portal-adapters` (only "sit" submits via webhook/URL, not
  local upload).
- Diagnostic missing-slot log should distinguish `(no-content)` (row had no
  fileUrl/fileKey/fileData at all), `(docKey-null)` (had content but
  docFetchUrl/signing couldn't resolve a URL), and `(err: ...)` (download
  attempted and threw) instead of one generic `(no-record)`.
