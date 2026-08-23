---
name: Service-fee visibility cascade
description: hideServiceFees must resolve up the whole agent ancestor chain on the backend; client can't, and several agency-side surfaces leak it.
---

# Service-fee (hizmet ücreti) visibility cascade

The per-agent `hideServiceFees` flag (set by a parent on each sub-agent) is meant
to cascade DOWN the entire sub-agent tree, but it is stored only on each agent's
own row. A naive read of "current agent's own flag" (or one parent level) lets
deeper sub-agents still see the service fee.

**Rule:** the effective hide = current agent's own flag OR any ancestor's flag.
Resolve it on the backend (`GET /api/agents/me` returns `effectiveHideServiceFees`,
mirroring how `effectiveCommissionRate` is computed in the same route) by walking
up `parentAgentId` with a visited-set seeded with `agent.id` (cycle/self-ref
guard) and stopping on a missing/orphan parent.

**Why:** the frontend cannot traverse the ancestor chain — a sub-agent has no API
access to other agents' records — so any cascade visibility flag MUST be resolved
server-side. The same was true for the commission cascade.

**How to apply:** when gating service-fee UI, consume `effectiveHideServiceFees`
for ALL agency-side roles, not just `agent`/`sub_agent`. Include `agent_staff`
(its /api/agents/me resolves via the managing agent) — otherwise an agency
bypasses the hide by viewing through a staff account. In edcons CourseFinder the
hide must cover EVERY service-fee surface, which is easy to under-cover: the card
badge lives inside `ApplyDialog`, the detail row inside `ProgramInfoDialog` (both
need a `hideServiceFee` prop), the PDF proposal (`generateProposalPdf` option),
the manual "Hide Service Fee" checkbox, AND the "PDF Fee Adjustment" /
`PdfMarkupModal` whose "Original Fee" prints the raw `serviceFeeAmount`.
