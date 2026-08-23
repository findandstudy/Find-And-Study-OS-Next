---
name: SIT GraphQL auth = Supabase Bearer access_token
description: SIT /api/graphql authenticates with the Supabase access_token as Bearer; the token lives in a dynamic localStorage sb-*-auth-token key. Session cookie + XSRF alone are not enough.
---

SIT (partners.sitconnect.net) uses **Supabase Auth**. Its GraphQL endpoint
`POST /api/graphql` returns **HTTP 200 with `data: null`** (never a real auth
error) unless the request carries `Authorization: Bearer <access_token>`.

**Where the token is:** localStorage, under a key shaped
`sb-<project-ref>-auth-token` (project ref changes per deployment — discover it
dynamically: `startsWith("sb-") && endsWith("-auth-token")`). The value is the
Supabase session; read the top-level `access_token`. Handle these value shapes:
plain JSON, `@supabase/ssr` `base64-`-prefixed JSON (strip prefix, `atob`),
legacy `currentSession.access_token`, and array form (`[0].access_token`).

**Why the earlier generic storage-scan failed in prod:** a heuristic JWT/token
scan logged `bearer=false`. The Supabase-specific key read is authoritative and
should be tried FIRST, with the heuristic kept only as a resilience fallback.

**DEFINITIVE (what actually works): MINT the token via Supabase password grant —
do NOT rely on the SPA login at all.** The adapter's headless SPA login never
establishes a real Supabase session (it reaches the app but the heavy SPA login
page never authenticates), so NOTHING is ever written to storage AND no
authenticated `/api/graphql` request is fired to intercept. THREE approaches
failed in prod for this reason: (1) storage read, (2) poll+base64 cookie,
(3) passive SPA `Authorization` header capture. The reliable path is to bypass
SPA login and mint an access_token directly from Supabase Auth:
1. Capture the PUBLIC anon `apikey` from the SPA's own `*.supabase.co` requests
   (`req.headers()["apikey"]` in the same `page.on("request")` listener).
2. `POST https://knqtjanxjwfjfrwoater.supabase.co/auth/v1/token?grant_type=password`
   with headers `{ apikey, content-type }` and body `{ email, password }` (the
   SIT `portal_credentials`). The response `access_token` is the Bearer.
3. Send `Authorization: Bearer <access_token>` (+ `apikey: <anonKey>`) on every
   `/api/graphql` call.
**Why:** the gotrue session is never persisted in the adapter's headless
context, but the credentials are the same email/password used for the UI login,
so a direct password grant is deterministic and SPA-independent. Fails only if
Supabase enforces MFA/captcha on the account (no MFA ⇒ works).

**How to apply (lib/portal-adapters/src/universities/sit/):**
- `mintSupabaseBearer(page,{user,password})` (graphql.ts) — idempotent (skips if
  a bearer is already held), non-fatal. Called in adapter `login()` after
  performLogin (resolveCreds) AND at end of `ensureLoggedIn` (portalCreds).
  Stores the token in the SAME `capturedBearerByPage` WeakMap that `collectAuth`
  reads FIRST, so the minted token is the primary Bearer.
- `resolveAnonKey(page)` — read WeakMap, else ONE bounded
  `page.waitForRequest(*.supabase.co + apikey, 12s)`.
- Passive SPA-header capture (`installSpaAuthCapture`) + storage poll are kept
  ONLY as fallbacks. Both transports send `apikey` (from `auth.apiKey`) too.
- Diagnostics on failure: `logSitLoginDiagnostics` logs `page.url()` + storage/
  cookie KEY NAMES + a `/tmp/sit-login-state.png` screenshot — NEVER values.
- NEVER log the token / password / anon key — only `bearer=true/false` + HTTP
  status.
- Diagnostics: symptom is `data:null` with no `errors`. Log `bearer=true/false`
  AND `apikey=true/false` (booleans only) and, on success, "data received".
  **Never log the token/apikey value** (PII/secret) — response logging must
  redact JWT-like strings.
- No bearer found ⇒ log ONE clear warning ("Supabase token bulunamadı — login
  akışı değişti mi?") and short-circuit (return null → UI-scan fallback); do
  NOT hammer both transports, they'd only return data:null.
- **`apikey` header is required in addition to the Bearer:** the Supabase-backed
  gateway silently returns `data:null` if `apikey: <anonKey>` is missing. Send
  BOTH `Authorization: Bearer <access_token>` and `apikey: <anonKey>` on every
  /api/graphql call (auth.apiKey, set in collectAuth from the captured anon key).
- **Distinguish top-level `{"data":null}` from field-level null.** Top-level
  data:null = empty result OR gateway-refused (do NOT assert "auth failed" —
  read bearer/apikey flags + the raw body). A field-level null connection
  (`{"data":{"students":null}}`) is a VALID empty result; connection() normalizes
  it to `{nodes:[]}` → findStudent/listStudentApplications return null →
  create-new-student flow. Never a fatal error, never a retry storm.
- **Always log the RAW body (PII-masked, ≤500 chars)** on any non-OK attempt via
  rawForLog() (redactedStringify for JSON so student email/name/passport are
  key-stripped; JWT-masked slice for non-JSON). This is what disambiguates
  empty-vs-refused-vs-graphql-error in prod.
- **AUTH solved but route still `{"data":null}` (no errors) = WRONG QUERY SHAPE,
  not auth.** partners.sitconnect.net/api/graphql is a Zoho-CRM-backed custom
  route (photos are `*_Contacts_photo.jpeg`); the adapter's guessed
  query/operationName/variables aren't recognized. There is NO direct GraphQL to
  *.supabase.co (only /auth/v1 + /storage/v1) — data comes only from this route.
- **To learn the real query, PREFER passively capturing the SPA's own requests.**
  installSpaAuthCapture already sees the SPA's /api/graphql requests (that's the
  Bearer fallback source), so also retain their request BODY (postData) keyed by
  op in capturedRealGqlByPage — this is the true query shape verbatim, no
  injection needed. captureRealGraphqlOnce logs these first (`capture(passive)`).
- **Fallback if the SPA fired nothing passively (headless login often fails to
  establish a session): inject the minted session into a THROWAWAY probe page.**
  Keep the FULL password-grant session (not just access_token) in
  capturedSessionByPage; open page.context().newPage(), addInitScript localStorage
  `sb-<projectRef>-auth-token` = JSON.stringify(session), goto studentsPath,
  capture /api/graphql POST bodies (`capture(probe)`). One-shot per page,
  triggered from gqlRequest on the data:null path; separate page so it never
  disturbs the main flow. Also log OUR outgoing op+variables to compare. All
  bodies PII-masked via rawForLog (query text preserved).
- **DEFINITIVE query shape: `/api/graphql` is a Supabase pg_graphql proxy over
  Zoho-synced tables `zoho_students` / `zoho_programs` / `zoho_applications`.** The
  earlier bespoke `students(search:)` / `student(id).applications` /
  `programs(universityName:)` fields DO NOT EXIST in this schema → that is the real
  cause of `{"data":null}` (not auth). Use pg_graphql conventions:
  `<table>Collection`, `edges { node }` (connection() already normalizes edges),
  `filter`, `first`, `offset` (offset pagination — NOT Relay cursors/`after`),
  `orderBy: [{ col: AscNullsLast }]`, filter ops `eq`/`ilike`/`or`.
  - Student search: `zoho_studentsCollection(filter:{or:[{email:{ilike:$s}},{passport_number:{ilike:$s}}]}, first:25)`; wrap term as `%q%`; node fields snake_case (`first_name last_name email passport_number`).
  - Applications: `zoho_applicationsCollection(filter:{student:{eq:$id}}, first:100)`; node `{id stage university program}` — `university`/`program` are denormalized NAME strings (not nested refs), `stage` is the status.
  - Programs: `zoho_programsCollection(filter:{university:{ilike:$uni}}, first:$limit, offset:$offset, orderBy:[{name:AscNullsLast}])`; scope by university only, do degree/language/name matching in code (over-filtering on degree/language empties the page).
  - **Insert mutations use pg_graphql joined names verbatim:** `insertIntozoho_studentsCollection` / `...programsCollection` / `...applicationsCollection` with `objects:[<Table>InsertInput!]!` → `{ records { id } }`. Application insert fields: `student program acdamic_year semester country university stage degree` — note the field is **`acdamic_year`** (a REAL schema typo, NOT `academic_year`; use exactly).
- **Confirm insert/filter field names with pg_graphql introspection before wiring
  mutations:** `logPgGraphqlIntrospectionOnce(page)` (graphql.ts, one-shot, called
  from findStudent) queries `__type(name:"zoho_studentsInsertInput"){inputFields{name}}`
  etc. and logs the field-name lists (schema metadata, not PII). Skip the SPA-capture
  fallback for label `"introspect"` so a null introspection doesn't waste a ~32s probe.
- Same Supabase-Bearer + apikey pattern likely applies to the United adapter too.
