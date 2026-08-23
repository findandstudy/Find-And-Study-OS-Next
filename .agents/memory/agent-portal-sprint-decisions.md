---
name: Agent-portal sprint — visibility & commission decisions
description: Durable cross-cutting rules for the agent portal (parent/sub-agent hierarchy, commission sharing, IDOR) established across the whole agent-portal sprint
---

# Agent-portal sprint — durable decisions

The agent-portal sprint (parent agents managing their own sub-agents) is complete
and approved. These are the cross-cutting rules future work must stay consistent
with — they override the older Sprint-A "agent sees only own" assumption for the
parent role.

## Visibility (parent vs sub-agent)
- A **parent** agent ("agent" role, `parentAgentId` is null) sees **own + its OWN
  sub-agents'** records. `getAgentVisibleIds("agent")` returns `[own, ...subAgentIds]`.
- A **sub-agent** sees **own only** — never siblings, never the parent's other data.
- Cross-agency isolation is absolute: one agency's parent must NEVER see another
  agency's records. All visibility scoping derives from `getAgentVisibleIds` +
  `parentAgentId=own`, never from client-supplied ids (IDOR-safe).

## Commission sharing (hierarchical)
- When a record belongs to a sub-agent but commission is computed, the **parent
  keeps its share**: `resolveAgentCommission` sets `commission.agentId = PARENT`
  (parentAmount) and `commission.subAgentId = sub` (sub share). No double counting.
- University commission amount is agent-independent; only the agent/sub split changes.
- Zero-amount commission rows still need the parent/sub link set explicitly.

## IDOR pattern (applies to every agent-portal mutation)
- Gate by role (`requireRole`/`requireAgentStaffPermission`), then re-derive scope
  server-side. Source object must be inside `getAgentVisibleIds`; destination
  sub-agent must satisfy `target.parentAgentId === actingAgent.id`.
- Sub-agents cannot perform parent-only actions (e.g. transferring students).

## Ownership-chain operations
- Any operation that re-owns a student (transfer, reassignment) must move the WHOLE
  chain in one TX: student + applications + service_fees + leads `agentId` AND full
  origin metadata via `inferOriginFromAgentId`. See `edcons-student-transfer-subagent.md`.

**Why:** verified and approved by architect review (commission correctness, no double
counting, IDOR sound). Keep these invariants when extending the agent portal.
