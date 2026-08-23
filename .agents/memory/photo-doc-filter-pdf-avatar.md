---
name: Photo doc filter & PDF avatar
description: How student photos are detected/displayed as avatars, why the denormalized has_photo flag is the consistency risk, and how it is kept in sync.
---

## Rule
`photoDoc` frontend filter must be `(d.fileKey || d.fileUrl)` — NOT `(d.fileKey || d.fileData)`.

**Why:** `fileData` is a legacy internal column not present in the Document API spec; it is always `undefined` on the client. `fileUrl` is a valid storage path used by some older documents. Both missing → filter silently discards valid photo docs → initials shown.

## ⚠️ The denormalized students.has_photo flag is the real consistency risk
Every avatar surface EXCEPT the shared `StudentPhotoAvatar` (Lead/Application Detail) gates on the denormalized `students.has_photo` flag: Student Detail, Students/Leads/Applications list + kanban avatars. `StudentPhotoAvatar` instead probes `GET /api/students/:id/photo` directly, which is why a photo could show on Lead/App Detail but be MISSING everywhere else (classic symptom — e.g. one student visible on Lead Detail, blank initials on Student Detail/lists).

**Do NOT assume `has_photo` is accurate.** It used to drift false whenever a photo doc was written through a path that did not also update the flag (legacy fileData-only uploads, public-apply, embed widget, lead→student convert). The flag is denormalized state and must be RECOMPUTED on every write, and HEALED on boot.

### Single source of truth
`GET /api/students/:id/photo` (`students.ts`) defines what "has a photo" means: it takes the LATEST non-deleted `photo`/`photograph` doc and serves it only when that doc has a `file_key`, `file_data`, OR an **http(s)** `file_url` (302 redirect; a `data:`/`file:` url is rejected **422** by the SSRF guard). `has_photo`/`photo_url` must mirror exactly this — same latest-doc selection, same servability rule. Counting "any photo doc with any non-empty fileUrl" is WRONG: a data:-only fileUrl would set has_photo=true but the endpoint 422s → broken image.

### How it's kept in sync (self-healing, permanent)
- **`artifacts/api-server/src/lib/studentPhoto.ts` → `recomputeStudentPhoto(studentId)`**: mirrors the endpoint (latest doc + same servability rule, JS-falsy so `""` counts as absent), sets `has_photo` + `photo_url` (= `/api/students/:id/photo` or `null`). Idempotent, error-safe (logs, never throws). **Call it after ANY photo/photograph doc insert or soft-delete.** Already wired into: `documents.ts` (upload, bulk-delete, single-delete), `public-apply.ts` (both photo spots), `embed.ts` (after doc insert), `leads.ts` convert (after docs moved to student).
- **`backfillStudentPhotoFlags()` in `index.ts`** runs on EVERY boot, OUTSIDE the bootstrap_done lock (so it heals existing/prod data, not just fresh seeds). WHERE-guarded raw SQL UPDATE — same latest-doc servability rule (`file_url ~* '^https?://'`); only writes drifted rows. This is the prod migration path (deploy runs no migrations — see prod-schema-bootstrap-ddl).

### Frontend defense-in-depth (StudentDetail)
`StudentDetail.tsx` no longer trusts `has_photo` alone. It runs an endpoint-first mime probe (`useQuery` key `["student-photo-mime", id]`, fetch + `res.body.cancel()`) → `hasPhotoResolved`. `photoDoc` activates on `hasPhotoResolved || student?.hasPhoto`, and the synthetic sentinel uses the probed mime so PDF-vs-image still works for fileData-only photos. So the avatar renders correctly even if the flag ever drifts again.

## How to apply
- `GET /api/documents` returns `fileKey` and `fileUrl` (but not `fileData`).
- Backend `/students/:id/photo` 302-redirects when only `fileUrl` is present (SSRF guard: http/https only, reject data:/file: → 422).
- For `mimeType === "application/pdf"`, use `React.lazy(() => import("@/components/PdfPhotoAvatar"))` in `<Suspense>` — `pdfjs-dist` renders page 1 to a canvas. Never use `<img>` for PDF content. Worker: `new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)` (Vite-native). `page.render(...)` type cast via `(page.render as (p: {...}) => {...})`.
- **SharedStudentPhotoAvatar** (`src/components/StudentPhotoAvatar.tsx`): fetches mime via GET + body cancel, renders img or PdfPhotoAvatar. Used where `student.hasPhoto` isn't available (Lead/App Detail). StudentDetail keeps its own upload-overlay logic.
- Test suite: `pnpm --filter @workspace/api-server run test:student-photo` (SP-1..5 endpoint 404/302/422/soft-delete/photograph-alias; SP-6..9 recomputeStudentPhoto flag sync incl. fileData-only and latest-doc-only data:-URI semantics).
- Easy-to-miss write path: `leads.ts` convert has TWO branches — new-student AND existing-student MERGE; both reassign lead docs and BOTH must call recompute (the merge branch was the gap caught in review).
