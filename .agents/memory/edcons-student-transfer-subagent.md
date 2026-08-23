---
name: Agent→sub-agent student transfer (full ownership chain)
description: How a parent agent transfers a student to its own sub-agent without breaking ownership/commission consistency
---

# Parent agent → own sub-agent student transfer

A parent agent ("agent" role, no parentAgentId) can move a student to one of its
OWN sub-agents. The transfer must move the ENTIRE ownership chain in one DB
transaction, or downstream filtering/reporting/commission goes inconsistent.

## What must move together (all in one TX)
- `students.agentId` + full origin metadata (originType/originEntityType/originEntityId/originDisplayName)
- `applications.agentId` + the SAME full origin metadata (origin-based filtering exists on applications too — agentId alone is not enough; originType has its own index)
- `service_fees.agentId` (matched by applicationId)
- `commissions` recomputed per row (see below)
- `leads.agentId` for the source lead(s) (matched by `convertedStudentId`)

**Why:** updating only `agentId` leaves `originType`/`originEntityId` pointing at the
old owner; the architect flagged this as the gap that breaks "full ownership chain".
Always build origin via `inferOriginFromAgentId(subAgentId)` (lib/originHelper.ts) —
do NOT hardcode `originType: "sub_agent"` while leaving entityId stale.

## Commission recompute
- Use `resolveAgentCommission(subAgentId, universityCommissionAmount)`.
- For uniAmt>0 with a sub-agent it returns `agentId = PARENT` (parentAmount) and
  `subAgentId = sub` (sub share) — parent KEEPS its share, no double counting.
- For uniAmt<=0 it returns the passed id with null amounts; the transfer endpoint
  must OVERRIDE `agentId = acting parent` and `subAgentId = sub` so the link stays
  consistent even with zero amounts.

## IDOR guards (both ends)
- `requireRole("agent")`; reject if actingAgent.parentAgentId (sub-agents can't transfer).
- Source: student.agentId must be inside `getAgentVisibleIds(...)`.
- Destination: target.parentAgentId === actingAgent.id (own sub-agent only).

## Visibility coupling
`getAgentVisibleIds("agent")` for a parent (no parentAgentId) returns
[own, ...own sub-agent ids]; this is why a parent can see the student both before
and after transfer. This deliberately reverts the older "agent sees only own" rule
for the parent role; sub-agents stay own-only.
