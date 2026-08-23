---
name: SIT create = graphql-derive + dedup + n8n webhook (not UI)
description: SIT student AND application create are n8n webhook POSTs, not the panel's dropdown modal/wizard; how ids are derived and why dedup must fail closed.
---

# BOTH SIT creates are webhook replays, not UI automation

There are THREE distinct SIT n8n webhooks — do not confuse them. The concrete
webhook URLs/UUIDs are secrets: resolve them ONLY from env, never hardcode/log:
- **student** — env `SIT_CREATE_STUDENT_WEBHOOK_URL`
- **application** — env `SIT_CREATE_WEBHOOK_URL`
- **users/invite** — a separate invite webhook, NOT used by the create flows

Both `createStudent` and `createApplication` bypass the automation-hostile UI
(the 6-step "Add Student" wizard / the "Add Application" dropdown modal) and POST
JSON to their dedicated webhook → `{status:true,id}`; the Zoho id is backend-assigned.

## createStudent specifics
- Keeps `ensureLoggedIn` + `findStudent` email/passport precheck + DRY stop, then
  `resolveSitIdentity` (fail-closed if `!agencyId || !crmId`), builds payload, POSTs.
- `findStudent` is TRI-STATE (`found`/`not_found`/`unknown`); `unknown` (GraphQL
  outage / shape drift) → caller aborts create (no POST) to avoid duplicate students.
  The webhook has no client idempotency guard, so the precheck is the only defense.
- Previous-education fields keyed by APPLIED level via `mapEducationLevel`:
  Master→`bachelor_*`, PhD→`master_*`, else `high_school_*`. Dates via `isoDateOnly`
  (YYYY-MM-DD). `*_country` + `country_of_residence` + `nationality` are all
  zoho_countries ROW IDs (resolveCountryId); prior-school country + residence fall
  back to nationality since apply has no explicit value.
- `education_level` is the zoho_degrees ROW ID of the APPLIED-FOR degree (resolve
  via `resolveDegreeId`); a plain label → `INVALID_DATA: Student_will_apply_for`.
- **Webhook mutation types are ALL String** — `have_tc`/`transfer_student`/`blue_card`
  must be lowercase `"no"`/`"yes"` strings (NOT JSON booleans — a boolean makes the
  panel read them as truthy "Yes"), and `documents` must be `JSON.stringify(array)`
  (NOT a raw array — the String var can't parse an array → panel shows Documents(0)).
  **Why:** confirmed from the wizard's own localStorage `student_form_draft`.
- `photo_url` + each `documents[].url` must be ABSOLUTE public URLs (absolutize via
  SIT_PUBLIC_ASSET_BASE→PUBLIC_APP_BASE→OBJECT_BASE_URL) so the external n8n fetcher
  can retrieve them; localhost/relative → not fetchable. Need ≥1 Passport + ≥1 Transcript.
- Body carries `first_name`/`last_name`/`email` — NEVER log the body; log only the
  masked response (`rawForLog`) + HTTP status.
- **No language field in the student payload.** `SitStudentWebhookPayload`
  (graphql.ts) has NO `language_score`/language column, so adding `languageScore`
  to the profile builder does NOT reach SIT — passport dates DO (payload maps
  `passport_issue_date`/`passport_expiry_date`). Don't invent a webhook language
  field without the confirmed n8n contract (unknown key could be ignored or reject
  the create). A pre-send one-line summary log (`[sit] CREATE payload → …`) sits
  right before `createStudentViaWebhook`; it logs `profile.languageScore` for
  diagnostics only, and passport number as presence (var/YOK), never the raw value.
- **#67 documentless guard:** the ONLY hard block is zero-asset
  (`!photoUrl && documents.length===0` → skip). Missing Passport/Transcript are
  WARN-only by deliberate design (doc types are often mislabeled); do NOT convert
  these warnings into blocks without evidence — it regresses working submissions.
- **Create is ASYNC — id often absent in the webhook response.** The n8n create
  webhook persists the student in Zoho asynchronously; its synchronous body
  frequently returns without `id` (or a non-`{status:true,id}` shape →
  `createStudentViaWebhook` returns null). A single post-create lookup finds
  nothing, so `createStudent` used to report `created:false`/`studentId:null` and
  `createApplication` aborted with "öğrenci id çözümlenemedi" — student left
  half-created (exists in SIT, NO application). Fix: `resolveCreatedStudentId()`
  polls `findStudent` (email-keyed then passport-keyed) with increasing backoff
  (~18s over 6 tries) to resolve the async id, then continues as created. It
  reuses the read-only `findStudent` (never a 2nd create) so no duplicate risk;
  pre-create `findStudent` still gates the create for idempotency on re-process.
- **The URL-based `documents`/`photo_url` webhook delivery is UNCONFIRMED and
  likely a NO-OP on the n8n side.** git history is decisive: the ONLY mechanism
  that ever actually delivered files was the OLD 6-step "Add Student" wizard's
  browser file-chooser upload (`uploadViaChooser` + `SIT_UPLOAD`, Step 6 —
  Documents). That wizard was fully removed when create became a webhook POST; the
  replacement commit's OWN deviation note says: *"documents:[] + photo_url:"" — the
  storage-upload path is not part of the captured student webhook contract."* The
  `documents`(JSON string)/`photo_url` URL fields were added SPECULATIVELY days
  later, assuming n8n would fetch the URLs — that fetch node was never confirmed to
  exist. **Live proof it doesn't work:** the worker-generated signed URLs are
  independently fetchable (`buildSignedDocumentPath`/`buildSignedStudentPhotoPath`
  → curl 200, correct bytes) yet SIT still shows Documents(0)+no photo while ALL
  inline scalar fields (passport dates, education, etc.) land → the webhook simply
  does not ingest `documents`/`photo_url`. Only TWO n8n webhooks were ever captured
  (student-create, application-create) — NO document/attachment webhook exists.
  **Why:** the field shape was inferred from the wizard's localStorage draft, not
  from a live create that actually attached files.
  **Fix paths (all need SIT-side input the repo can't provide):** (a) live-capture
  the SIT panel's real "add document to student" network request → mirror it as a
  3rd webhook (cleanest, matches architecture); (b) re-implement UI file-chooser
  upload after create (needs live selectors for an EXISTING student's upload UI —
  the old `SIT_UPLOAD` were create-wizard selectors, may not apply); (c) SIT/n8n
  team adds a URL-fetch node to the existing create webhook for the fields we
  already send. An ALREADY-created student can't be backfilled; do NOT resend
  create (duplicates the student). 302-vs-200 redirect is a red herring here —
  the field isn't ingested at all, so response shape is moot.

# SIT createApplication is a webhook replay, not UI automation

The SIT panel's "Add Application" modal dropdowns are automation-hostile (Student
async popover perpetually 0/0). The panel's REAL create (live-captured) is two
HTTP calls, so the adapter bypasses the UI entirely:

1. **Dedup precheck** — pg_graphql `GetApplicationsByFilter` on
   `zoho_applicationsCollection`.
2. **Create** — JSON POST to an OPEN n8n webhook
   (`SIT_CREATE_WEBHOOK_URL`, hardcoded fallback) → `{status:true,message,id}`;
   the Zoho application id is assigned by the backend and returned as `id`.

`createApplication` keeps login + student search + program catalog match + DRY
stop, then derives every id from GraphQL and POSTs.

## Id derivation (all dynamic, never hardcoded)
- **program fields**: `zoho_programsCollection{id name university_id degree_id
  country_id}` → university/degree/country/program_name.
- **academic_year / semester**: resolved by NAME from
  `zoho_academic_yearsCollection` / `zoho_semestersCollection` (year compared
  digit-only so "2026-2027" matches "2026/2027"; semester folded fall/spring/summer).
- **identity**: `user_id` = the `sub` claim of the Supabase access_token (decode
  the JWT payload, base64url); `agency_id` + `crm_id` from `user_profileCollection`
  filtered by that uid (typed `user_profileFilter`).

## Non-obvious constraints
- **Dedup key = student + university + degree + acdamic_year + semester**
  (program and country are intentionally EXCLUDED). The column is literally
  spelled `acdamic_year` (panel typo) — use verbatim in filter AND webhook body.
- **Dedup must FAIL CLOSED.** `dedupApplication` returns a tri-state
  (found/not_found/unknown); on `unknown` (GraphQL outage / response-shape drift)
  the caller aborts create — treating unknown as "no duplicate" would silently
  create duplicates during transient instability.
  **Why:** the webhook has no client-visible idempotency guard; the precheck is
  the only duplicate defense.
- **Secrets/PII:** the webhook body carries `student_name` — NEVER log the body;
  log only the response (masked via `rawForLog`) + HTTP status. Identity is
  logged presence-only.
- Failure on any missing required id (program ids / AY / semester / agency_id /
  crm_id / studentId) → abort with a field-specific detail, never a partial POST.

## Document/photo delivery = restored file-chooser UPLOAD (not webhook)
- The create webhook does NOT ingest `documents`/`photo_url` URL fields. The ONLY
  mechanism that ever delivered files to the SIT student card is the browser
  file-chooser upload from the removed 6-step wizard (Step 6).
  **Why:** git-proven — files were dropped when create became a webhook; the URL
  fields were added speculatively and are never processed by n8n.
- **Fix:** after student create + id resolution, navigate to the student detail
  page and re-run the file-chooser upload (uploadViaChooser: click role=button by
  SIT_UPLOAD trigger → filechooser event → setFiles, fallback input[type=file]).
  Runs in submit() BEFORE createApplication (webhook-driven, page-URL-independent).
- **Identity verification is MANDATORY before any upload.** openStudentDetail
  tries direct URL `/students/<id>` then falls back to list-search + row-info
  click, but only returns true when the detail page's email/passport is present
  on the page. Uploading to the wrong row cross-associates one student's PII docs
  with another's — worse than a missing doc. Never upload to an unverified page.
- **Fresh-create only** (`student.created`): a just-created student has no docs so
  no duplicate risk; alreadyExists is skipped (no update webhook; manual backfill).
  Upload is best-effort/non-fatal — logs `[sit] wizard upload: N/M belge ok,
  foto=…`; create+application still succeed if upload fails.
- **UNVERIFIED live:** detail-page upload-UI selectors reuse the wizard's
  SIT_UPLOAD triggers but were never tested against the existing-student detail
  page (no SIT creds in dev). If uploads fail live, the detail-page upload
  affordance/tab selectors are the first suspect.
