---
name: RBAC agent-source scope (Sprint A)
description: Non-admin staff blocked from agent-sourced records; agent sees only its own (not sub-agents). Pattern + scope of change.
---

## Rule

**KURAL 1** — Non-admin staff (staff / consultant / editor / accountant) must not see or
mutate any record where `agentId IS NOT NULL`, regardless of `assignedToId`.

**KURAL 2** — `role="agent"` sees only records matching its own `agentId`. Sub-agents'
records are excluded. `agent_staff` visibility is unchanged (managing agent + sub-agents).

## Implementation Pattern

Helper: `artifacts/api-server/src/lib/rbac/agentSourceScope.ts`
- `isAgentSourcedAndBlockedForStaff(user, recordAgentId)` — pure function, no DB needed.
  Returns `true` when user is non-admin staff AND `recordAgentId != null`.
- `buildAgentSourceScope(user, agentIdCol)` — async, returns a Drizzle WHERE condition.
  Unused in route code (routes inline the condition manually for clarity).

List endpoints: add `isNull(agentIdCol)` inside the non-admin-staff branch before other
visibility filters (permissions, assignedToId).

Detail / mutation / sub-resource endpoints: fetch `agentId` in the pre-check query, then
call `isAgentSourcedAndBlockedForStaff`; return 404 (not 403) to avoid information leakage.

Endpoints covered in applications.ts: GET list, GET detail, PATCH, DELETE, GET notes.
Endpoints covered in leads.ts: GET list, GET detail, PATCH, DELETE, GET notes, GET documents, GET follow-ups.

## Why 404 not 403

403 reveals the record exists. Non-admin staff should not know agent-sourced records exist at
all. 404 prevents enumeration.

## Breaking behavior

- Staff previously saw agent-sourced records they were `assignedToId` on. Now they don't.
- Agents previously saw sub-agents' records via `getAgentVisibleIds`. Now they see only their own.
- agent_staff: no change.

## Tests

`artifacts/api-server/scripts/test-rbac-agent-source-scope.ts` — 5 unit tests covering the
`isAgentSourcedAndBlockedForStaff` helper (all roles, null/non-null agentId, edge cases).
Run with `pnpm --filter @workspace/api-server run test:rbac-agent-source-scope`.

## Documentation

`docs/RBAC.md` — full access-control matrix + breaking-change notes.
