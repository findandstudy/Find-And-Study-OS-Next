---
name: SIT upload guard uses createdViaWebhook
description: Why the SIT document/photo upload is gated on a dedicated flag, not `created`
---

# SIT document/photo upload gating

The SIT `createStudent` result exposes THREE flags: `created`, `alreadyExists`,
and `createdViaWebhook`. The document/photo upload (`uploadStudentDocuments`) is
gated ONLY on `createdViaWebhook && studentId`, never on `created`.

**Why:** `created` is dual-purposed — it also drives the user-facing `detail`
message in `submit()`. Coupling the upload to `created` means any future reword
of that message's semantics silently disables the upload. `createdViaWebhook`
isolates the single fact the upload cares about: "the create webhook fired for a
NEW record in THIS run (precheck said missing)".

**How to apply:**
- `createdViaWebhook: true` ONLY at the two post-webhook success returns: the
  webhook returned an id, AND the async post-create poll (`resolveCreatedStudentId`)
  resolved an id. Both are fresh creates → upload must run.
- `createdViaWebhook: false` on EVERY other return: precheck-reuse ("found"),
  dry-run, zero-doc protection, identity failure, unknown-precheck, and the
  poll-timeout failure. Failure paths are always false (contract).
- Reused/existing students ("found") are never re-uploaded — SIT has no update
  webhook, and a just-created student has no docs so there is no duplicate risk.
- If you add a new `createStudent` return branch, you MUST set `createdViaWebhook`
  or the typecheck fails (it's a required field). Keep the `created:` and
  `createdViaWebhook:` return-line counts equal as a quick sanity check.

**Live symptom that motivated this:** a student was created + id resolved +
application submitted (submitted=true) but NO `[sit] wizard upload:` log line —
upload was skipped because the guard keyed off the wrong/ambiguous flag.

## Webhook-created students aren't immediately visible in the SIT UI

A student created via the SIT create webhook is persisted ASYNCHRONOUSLY in
Zoho; the SIT list/detail SPA does not show the new record for several seconds
(indexing lag + lazy render). So ANY Playwright UI action on a just-created
student (opening the detail page to upload docs/photo) must RETRY with backoff
— a single open+verify right after create fails and the identity guard then
cancels the upload. `openStudentDetail` mirrors `resolveCreatedStudentId`'s
"wait until it appears" poll (retry loop + content-poll verifyIdentity).

**Why:** the old flow created the student via the UI wizard, so its detail was
already open in-session with no indexing wait; moving create to the webhook
introduced this delay.

**How to apply:** never do one-shot open+verify on a fresh SIT record. Keep the
identity guard strict (email/passport must appear on the card) — only add
retries around it, never loosen it.
