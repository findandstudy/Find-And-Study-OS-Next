---
name: edcons agent onboarding (auto-credentials + intake)
description: How agent self-onboarding works after dropping the 6-digit email-verification step — auto password, account state, and the intake→review→sign state machine.
---

# Agent onboarding: auto-credentials + pre-contract intake

Agents are provisioned for direct login at create time (no 6-digit email-verification step).
On `POST /agents`: generate a policy-compliant password, set the user `emailVerified=true`,
`isActive=true`, `passwordHash`, and email the credentials. The agent logs in and is guided
straight to signing; they change the password later from their own panel.

**Existing-user-by-email guard (security):** the create handler may match an existing `users`
row by case-insensitive email and reset its `passwordHash`/`emailVerified`/`isActive`. This is
ONLY safe for agent-family roles. Gate it with `AGENT_ROLES.includes(existingUser.role)` and
reject otherwise — without the guard, creating an agent with an internal/staff/student email
silently takes over and reactivates that unrelated account.

**Onboarding signing state machine:** `intake_pending → review_pending → signed`.
- A session starts `intake_pending` only when the assigned template's `intakeSchema` is non-empty,
  otherwise it starts `review_pending`.
- `finalizeSign()` rejects only signed/revoked/expired — it does NOT block `intake_pending`. So the
  onboarding sign route (`POST /contracts/me/sign`) must itself reject `intake_pending`, or a direct
  API call skips the required "Your Details" intake step.
- `POST /contracts/me/intake` intentionally accepts both `intake_pending` and `review_pending`
  (always writes `review_pending`) so the frontend "Back" button can re-edit details before signing.

**Why:** code review flagged that (a) sign could bypass intake via direct API, and (b) agent
creation could mutate unrelated accounts sharing an email.

**How to apply:** any new signing entry point that reuses `finalizeSign` must re-check the
intake gate itself; any account-reuse-by-email path must validate role before resetting auth state.

Intake field rendering mirrors the public self-fill flow (`SignFlow.tsx`): name/email/year/tel/file
heuristics; email field is read-only + locked to the agent's own address with NO verification;
file/logo fields upload to object storage and store the resulting URL string.
