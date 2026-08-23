---
name: Public contract signing email verification
description: How the /sign/:token public flow gates signing on signer email verification, and the two traps when changing it.
---

# Public contract signing — signer email verification

The public signing flow (`/sign/:token`, `artifacts/api-server/src/routes/publicSigning.ts` + `artifacts/edcons/src/pages/sign/SignFlow.tsx`) requires the signer to enter their OWN email and verify it via a 6-digit code before `/sign` succeeds. The session stores `verifiedEmail`; the `/sign` handler 403s with `code: "email_not_verified"` until it is set.

## Rule 1: verification codes MUST be bound to the signing link
**Why:** `email_verification_codes` is shared across flows (agent onboarding, auth, signing). Matching a code by `email + code` alone lets a code issued for one link verify a different link/flow for the same email.
**How to apply:** store `hashToken(rawToken)` (same sha256 used for `signing_sessions.tokenHash`) in the codes table's `token` column on send-code, and require that exact `token` hash match on verify-code. Mark only the matched row used (by `id`), not all of the email's rows. The agent-onboarding flow already uses this `token` column the same way — do not set `token: null`.

## Rule 2: the verify widget must render in BOTH the intake AND sign steps
**Why:** `self_fill` sessions pass through the intake step (where verification lives), but `admin_driven` sessions start at review→sign and never see intake. If the widget only renders in intake, admin_driven signers hit the 403 gate with no UI to verify.
**How to apply:** render `EmailVerify` in the sign step when `!verified`, and disable the sign button until `verified`. `verifiedEmail` persists on the session, so self_fill signers (already verified at intake) won't see it again.

## Notes
- Two limiters back these endpoints via `PgRateLimitStore` (Postgres-backed, survives restarts): `signLimiter` (max 30) and a tighter `codeLimiter` (max 8) for send/verify-code. To smoke-test locally, clear `pg_rate_limits`.
- Signed PDF is emailed as a direct nodemailer attachment to the verified signer + all active super_admin/admin users; the download link (token-gated `/pdf`) remains as fallback.
