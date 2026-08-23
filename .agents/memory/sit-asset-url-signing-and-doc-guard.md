---
name: SIT asset URL signing, zero-doc guard, already_exists doc gap
description: Why SIT create webhook silently produced students with no photo/documents, and the real limit on recovering docs for an existing Zoho student.
---

`fileKey` (object-storage key) is NOT a URL and must never be handed to an
external URL-fetching webhook as one; only a genuine absolute http(s) `fileUrl`
that is not one of our own session-gated routes (`/api/documents/:id/file`,
`/api/students/:id/photo`) is safe to send directly. Everything else — fileKey,
base64 fileData, or a self-referential fileUrl — must go through the signed
endpoint (`buildSignedDocumentPath`/`buildSignedStudentPhotoPath`). This was
the root cause of SIT creating students with zero photo/documents: the
create-webhook's server-side fetch got a 401/403 on an unsigned session route,
but the create itself still "succeeded" with empty attachments.

**Why:** an external n8n webhook has no session/cookies, so any URL it fetches
must be either truly public or explicitly signed; there is no way to tell from
inside the webhook that the fetch silently failed.

**How to apply:** shared signing-secret precedence lives in
`lib/portal-adapters/src/assetSigningSecret.ts` (`ASSET_URL_SIGNING_SECRET` →
`SESSION_SECRET` → `EMBED_TOKEN_SECRET`), consumed by both
`documentSigning.ts` and `studentPhotoSigning.ts`. `profile.ts`'s
`publicDocUrl`/`docFetchUrl` gate on `isSelfReferentialAssetPath` before
trusting any `fileUrl`. Adapters that build create payloads from URLs (SIT)
should also guard: never POST a create with zero fetchable assets (log +
skip) rather than create an empty record.

**Signing is ALREADY wired end-to-end — a "docs/photo don't land" report is
almost always ENV, not code.** `lib/portal-runner/src/profile.ts` signs docs
(`docFetchUrl`→`buildSignedDocumentPath`) AND photo
(`buildSignedStudentPhotoPath` when the photo row is session-gated), producing
`/api/documents/:id/file?exp=&sig=` and `/api/students/:id/photo?exp=&sig=`. The
SIT adapter's `prepareAssetUrl` sends the FULL url (query intact) — only the
`redactUrl` LOGGING helper strips the query, so logs hide the `sig=`. api-server
verifies both auth-free (documents.ts `/documents/:id/file`; students.ts
`photoAccessGuard`). `activityNormalize.ts` is activity-module NAMING, not auth —
its `EXCLUDE_SEGMENT_RE` is irrelevant to authorization; there is no global
`requireAuth`. So an anonymous curl of the BARE path returning 401/403 is
EXPECTED and proves nothing — you must test the signed url.
**Why:** the two processes (portal worker vs api-server) each resolve
`getAssetSigningSecret()` = `ASSET_URL_SIGNING_SECRET → SESSION_SECRET →
EMBED_TOKEN_SECRET`; if they hold different subsets/values the worker signs with
secret A and api-server verifies with secret B → 403/401 → assets silently don't
land. This is deploy/env parity, not a code bug; do NOT add a redundant public
asset endpoint to "fix" it.
**How to diagnose (built-in):** the SIT CREATE payload log prints
`imza-secret=var/YOK` (worker secret present?) and each asset logs
`[imzalı=evet/hayır]` + a loud warning when a session-gated route is UNSIGNED. If
`imza-secret=YOK` → worker has no secret (docs dropped, photo unsigned). If
`imza-secret=var` but SIT still shows 0 → worker/api-server secrets DIFFER; align
`ASSET_URL_SIGNING_SECRET` (or `SESSION_SECRET`) across both processes.

**Known gap:** SIT exposes only `createStudentViaWebhook` (create) and
`createApplicationViaWebhook` — no "update student" / "attach document"
webhook exists. When a student already exists in Zoho (dedup match) with
missing photo/documents, there is currently NO safe way to backfill them
without risking a duplicate create; this is a real limitation, not a bug to
silently paper over. Application creation for an existing student still
proceeds normally (separate, already-idempotent path).
