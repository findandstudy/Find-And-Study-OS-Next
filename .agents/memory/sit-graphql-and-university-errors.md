---
name: SIT adapter GraphQL shape + university-error classification
description: How the SIT read-only GraphQL connection parsing tolerates empty/edges shapes, and why a not-permitted / unselectable university must NOT be reported as programMissing.
---

# SIT GraphQL authenticated session

SIT's read-only GraphQL (POST /api/graphql) needs MORE than the session cookie:
sitconnect.net is a Laravel/axios SPA that also wants the `X-XSRF-TOKEN` header
(the `XSRF-TOKEN` cookie value, URL-decoded) and/or an `Authorization: Bearer`
token the SPA keeps in web storage. Missing those → the server returns **HTTP
200 with `data: null` and NO `errors`** (not a 401), so the old code logged only
"shape mismatch — null", findStudent returned null, and the create-wizard looped
~7× ("doğrulama hatası").

**How to apply (current design):** `collectAuth()` reads XSRF from the browser
CONTEXT cookie jar (`page.context().cookies(base)`, reliable even if HttpOnly —
`document.cookie` in-page would miss it) and scans local/sessionStorage for a
JWT-looking bearer. The POST is then sent via TWO transports, tried in order
until one returns usable data:
  1. **primary** `page.request.post` + `X-XSRF-TOKEN`/bearer + `x-requested-with`
     + Origin/Referer. It is CORS-immune and is the transport we KNOW reaches
     the server (200 in prod); it was only missing the auth headers.
  2. **secondary** in-page `window.fetch` (`credentials:"include"`) to a
     RELATIVE path (`/api/graphql`) so it is always same-origin.

**Why NOT an absolute-URL in-page fetch as primary:** an earlier version issued
the in-page fetch to the ABSOLUTE `SIT_URLS.base` URL; when the page origin
differs it is cross-origin → the browser throws → it silently fell back to a
cookie-only `page.request` (`via request xsrf=false bearer=false`), which is why
`data:null` persisted. Relative path + page.request-primary removes that trap.

**Diagnostics:** each attempt logs transport + HTTP status + which creds were
attached (xsrf/bearer) + GraphQL `errors` verbatim + an explicit `data:null`
branch. `interpret()` classifies: `ok` (typed data), `gotData` (data present but
shape mismatch → do NOT retry the other transport, shape won't change), `retry`
(threw/nonjson/errors/data:null → try next transport). A non-JSON body
(login-page HTML) is the redirect symptom — log a bounded snippet but strip JWTs
and csrf/token attribute values first.

# SIT GraphQL connection shape

SIT's read-only GraphQL (studentSearch / studentApplications) returns a
connection that can be `{nodes:[]}`, Relay `{edges:[{node}]}`, a bare array, or
`null` (empty search → no rows). The shared `connection()` zod helper normalises
all of these to `{nodes:[]}`.

**Why:** an empty search returning a `null` connection used to fail the
`{nodes}`-only union → logged "[sit:graphql] studentSearch: data shape mismatch"
→ findStudent returned null → the create-wizard ran and spammed the Zoho
validation-recovery loop ("doğrulama hatası — adım yeniden denenecek", up to ~7×).
Fixing idempotency (finding the existing student) skips the whole wizard.

**How to apply:** `undefined` (a genuinely ABSENT field) is intentionally NOT
accepted — only explicit `null` — so real schema drift still surfaces. On a
mismatch, `gqlRequest` dumps the ACTUAL response structure (bounded, with PII
keys email/passport/phone/address redacted via a JSON.stringify replacer) so the
true live shape is readable from run logs without leaking student data. If a live
dry run still logs a mismatch, read that dump to learn the real field name and
adjust the query/schema.

# University errors ≠ programMissing

The SIT allowlist (`SIT_ALLOWLIST`, 11 hardcoded universities in helpers.ts,
"do not add/remove without sign-off") is matched Turkish-fold + distinctive-token
aware by `matchAllowedUniversity`. A name genuinely absent from the list (e.g.
Gelişim — Beykoz IS on the list, Gelişim is NOT) is correctly rejected; do NOT
add members to the allowlist to "fix" it (that's a membership/sign-off decision).

**Rule:** a not-permitted university, or one that can't be selected in the live
combobox, returns `programMissing:false` + a university-specific `detail`. Only a
real program lookup failure sets `programMissing:true`.

**Why:** `programMissing:true` drives status=`program_missing` and can feed the
program-fallback orchestrator. A university error is not a program problem;
misreporting it risks wrong fallback and hides the real cause. On allowlist
mismatch the adapter also logs the permitted list (`[sit] izinli üniversiteler:
...`) for operator diagnosis.

**How to apply:** SIT/United are experimental (manual/dry only); in dry mode
writeback is `dry_run` regardless, in real mode a university error now resolves
to `failed` (not `program_missing`), which is the correct classification.
