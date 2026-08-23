---
name: edcons agent onboarding gate — allowlist & "Later until deadline day"
description: How the agent-onboarding gate blocks/allows, and the postpone-until-deadline-day contract rule
---

# Agent onboarding gate (server-side authorization boundary)

The agent-onboarding gate lives in `api-server/src/routes/index.ts` (an `router.use` before all feature routers). For AGENT_ROLES it blocks every path NOT in `ALLOWLIST_EXACT` / `ALLOWLIST_PREFIX` until email verified + password set + contract handled.

**Rule:** any endpoint the agent must reach *while still in onboarding* (before the contract is signed) MUST be added to `ALLOWLIST_EXACT`, or the gate 403s it with `CONTRACT_SIGNATURE_REQUIRED`.
**Why:** the intake step (`POST /contracts/me/intake`) was missing from the allowlist, so clicking Continue in the "Sign your agency contract" popup 403'd. The contract endpoints (`/contracts/me`, `/contracts/me/intake`, `/contracts/me/sign`) are all allowlisted.

# "Later" / mandatory-on-deadline-day contract behavior

`isOnboardingContractMandatory(session)` (in `agentOnboarding.ts`, exported via `ONBOARDING_HELPERS`) is the single source of truth, used in BOTH the gate and `/agents/me/onboarding-status` (returns `contractMandatory`). Keep these in lockstep — never recompute mandatory independently on the frontend.

- mandatory = session pending AND `now >= startOfDay(expiresAt)` (the calendar day of the deadline).
- Before deadline day: gate calls `next()` (full portal access); frontend `AgentOnboardingGuard` shows a **dismissible** reminder popup (onClose → per-mount `dismissed` state, so it reappears every login).
- On/after deadline day: gate 403s; frontend shows a **non-dismissible** popup → must sign.
- Expired/revoked: still hard-blocked (`CONTRACT_EXPIRED` → ContractExpired screen). lazyExpire flips intake_pending/review_pending → expired once fully past due.

**Caveat:** `startOfDay` uses server-local tz (UTC on Replit), so the day boundary is UTC, not the agent's business tz. Acceptable per current intent; revisit if a tz-correct deadline is needed.
