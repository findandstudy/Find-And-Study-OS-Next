# AI External Delivery Safety

This document defines the release and incident-response contract for automatic
AI messages sent to customer-facing channels. It covers WhatsApp, Messenger,
Instagram, web chat, Zernio-routed bot messages, and scheduled DormBooking
follow-ups. Internal AI notes remain available when external delivery is off.

## Safety invariant

An external AI message may be delivered only when all applicable controls are
open:

1. The selected AI bot is active.
2. The global AI switch (`enabled`) is on.
3. The bot's explicit external-delivery approval
   (`externalAutoReplyEnabled`) is on.
4. The conversation-level bot switch is on.
5. Schedule, escalation, consent/contact, idempotency, and provider-policy
   checks pass.
6. `AI_EXTERNAL_AUTO_REPLY_KILL_SWITCH` is not set to a stop value.

Missing fields in older encrypted configurations merge to
`externalAutoReplyEnabled=false`. New and cloned bots also start with external
delivery and default-on-for-new-conversations disabled.

## Control ownership

- Only `super_admin` may change an activation control from off to on:
  `enabled`, `externalAutoReplyEnabled`, or `defaultOnForNew`.
- Any admin may turn those controls off. This is the primary immediate stop
  path because it does not require a process restart.
- The infrastructure kill switch is stop-only. Values `1`, `true`, `yes`, and
  `on` block non-internal bot delivery. It is an incident override, not the
  normal long-term product control.
- Configuration changes are written through the authenticated API surface and are
  recorded in the audit log with the actor and resulting safety state.

## Production rollout gate

Production remains read-only until a named approver authorizes each mutation.
For a release that contains this change:

1. Record the release commit and take the normal configuration/database
   recovery evidence required by the deployment runbook.
2. With explicit production approval, set the infrastructure kill switch to
   `true` before the candidate API can send customer messages.
3. Deploy through the standard atomic release process; do not run an
   unreviewed database or storage mutation for this feature.
4. Verify API health and confirm every existing bot reports external delivery
   off unless a post-release Super Admin approval deliberately enables it.
5. Exercise the test console, which must never call a customer transport.
6. For each approved pilot bot, have a Super Admin enable the bot-specific
   external gate only after its knowledge, escalation, schedule, templates,
   recipient scope, and human handoff are reviewed.
7. Only after a GO decision, explicitly approve removal of the infrastructure
   stop. Observe the first messages and provider receipts with a named human
   owner present.

No bulk enablement is permitted. Approval is bot-specific and reversible.

## Incident stop and rollback

1. An admin switches off external delivery for the affected bot. For a broad
   incident, switch off the global AI control for every affected bot.
2. An infrastructure operator sets
   `AI_EXTERNAL_AUTO_REPLY_KILL_SWITCH=true` and reloads the API only with
   explicit production approval.
3. Confirm that new customer-facing attempts return
   `external_delivery_disabled` or fail with
   `external_ai_delivery_killed`; internal notes may continue.
4. Preserve provider receipts, affected conversation IDs, audit events, and
   timestamps. Do not copy message bodies or credentials into incident logs.
5. If code rollback is required, use `deploy/DEPLOYMENT.md`. Keep the external
   kill switch on throughout rollback and re-enable only through a new GO
   decision.

## Required verification

- TypeScript workspace typecheck passes.
- API production bundle builds.
- i18n keys are synchronized across all supported languages.
- AI delivery safety and security regression tests pass.
- DB-backed route tests run only against an explicitly named local/E2E
  database with live integrations disabled.
- A production smoke test must prove: admin enable is denied, Super Admin
  enable is accepted, admin disable is accepted, kill switch blocks both
  direct and scheduled bot transports, and the test console sends nothing.
