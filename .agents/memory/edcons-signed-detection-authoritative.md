---
name: Agent signed-contract detection must be authoritative
description: How "is this agent signed?" must be computed across the agent portal so a signed agent is never nagged.
---

An agent counts as **signed** whenever they have ANY `signing_sessions` row with
`status='signed'`, resolved to the globally-newest signed contract over ALL
sessions via `loadNewestSignedContractForAgent(agentId)` (ORDER BY signed_at
DESC, id DESC). This is the same resolution used by `/api/contracts/me`,
`/api/contracts/me/pdf`, and `/api/agents/me`.

**Rule:** signed detection must NEVER key off PDF presence
(`pdf_object_key` / `evidence_hash`) or `agents.contract_url`.

**Why:** the regenerate endpoint (`POST /api/contracts/signed/:id/regenerate`)
legitimately NULLs `pdf_object_key` + `evidence_hash` + `delivery_claimed_at` so
the background sweep re-renders the PDF. If detection keyed off those cache
fields, a regenerate (or a re-sign that lands on a later non-primary session)
would make an already-signed agent look unsigned and re-trigger the onboarding
gate/banner. Verified prod incident: agent 1266 (session 25 signed+primary,
signed_contract id 5).

**How to apply:**
- `onboarding-status` resolves signed via `loadNewestSignedContractForAgent`,
  not solely the primary onboarding session from `loadOnboardingSession`.
- The Dashboard `OnboardingContractBanner` gates on
  `onboarding-status.contractStatus === "pending"` (authoritative) in addition
  to `/api/contracts/me` session status.
- Keep regenerate **status-neutral**: its update payload is
  `REGENERATE_PDF_CACHE_RESET` (exported from `routes/contracts.ts`) — PDF-cache
  fields only, no status. A unit test in `scripts/test-contract-sign.ts` locks
  the exact key set so a future status mutation breaks the build.
