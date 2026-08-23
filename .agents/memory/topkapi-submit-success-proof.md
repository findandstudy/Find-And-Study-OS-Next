---
name: Topkapı final-submit success proof
description: Why a portal HTTP 200 is not proof of submission, and what counts as real success.
---

# Topkapı final-submit success proof

**Current rule (the RESPONSE BODY decides, not the HTTP status):** read the
`application-save.php` response body and ALWAYS log it (`status + first 600
chars`). `saved = j.status==="success" || j.success===true || !!j.redirect ||
!!j.applicationId`. If the body is JSON but not saved, log `SAVE REJECTED:
<message|error>` so the rejection reason is visible. A bare HTTP 200 is NEVER
treated as success. `submitted = saved`.

The `/applications/success/<uuid>` redirect is BEST-EFFORT: parse `<uuid>` for
`externalRef` from the body's `redirect`/`url`, else (only if no ref yet) wait
~10 s for the page to land on `/applications/success/...`; capturing it there
also sets `saved=true`. A missing redirect does NOT by itself fail a body that
already said success (log "saved but success-url not captured").

History (do not re-litigate): v1 required the COMBINATION (modal + save 2xx/3xx
+ success-url uuid) — too strict. v2 used save 2xx/3xx alone — too loose (HTTP
200 with a rejecting body counted as success). v3 (current) keys on the body.

**Mechanics that stay regardless of the criterion:**
- Arm `waitForResponse(application-save.php)` BEFORE the submit click (a passive
  `page.on("response")` listener races a fast response and misses it).
- Confirm the optional `.jconfirm` summary modal when it appears.
- Parse the body type-safely: `JSON.parse` into `unknown`, narrow via
  `typeof === "object"` then `Record<string, unknown>` — no `any`.

**How to apply:** `SubmitResult.externalRef` carries the captured uuid; the
runner writeback (`stageWriteback.ts`) persists it to
`portal_submissions.external_ref` ONLY when present (conditional spread) so a
later run with no ref can't clobber it. Never touch the DRY (`doSubmit=false`)
branch, `alreadyExists`, or `programMissing` when changing real-submit logic.
