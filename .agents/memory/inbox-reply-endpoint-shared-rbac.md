---
name: Inbox reply endpoint shared RBAC (WhatsApp + Meta DM)
description: Why agent_staff is 403 on POST /inbox/conversations/:id/messages and must stay that way
---

The single endpoint `POST /api/inbox/conversations/:id/messages` sends outbound
replies for ALL external channels — WhatsApp, Messenger, Instagram DM — and is
gated by `requireAuth + requireRole(...STAFF_ROLES, ...ADMIN_ROLES)`.

STAFF_ROLES = [super_admin, admin, manager, staff, consultant, editor, accountant].
`agent_staff` is in AGENT_ROLES, so it gets **403** here. That is the intended
matrix, not a bug.

**Why:** the route is shared. Adding `agent_staff` (or wiring the agent_staff
"messages" permission) to make Meta DM replies work would simultaneously grant
agent_staff WhatsApp send — a scope/authz change to the WhatsApp channel. Any
"fix" that loosens this gate touches WhatsApp.

**How to apply:** when writing/auditing inbox reply RBAC tests or adding channels,
assert the *enforced* matrix (agent_staff=403); do NOT broaden the shared gate.
If a future requirement genuinely needs agent_staff to reply, split the endpoint
or gate per-channel rather than editing the shared `requireRole` list.

Outbound branch facts: 24h window → 409 `outside_24h_window`; recipient =
externalContacts.externalId || conversation.externalThreadId; live send gated by
`isLiveIntegrationsEnabled()` (NODE_ENV=production || ALLOW_LIVE_INTEGRATIONS=true),
otherwise simulated `{ simulated: true }`.
