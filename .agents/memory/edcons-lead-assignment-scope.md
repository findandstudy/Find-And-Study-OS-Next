---
name: Agent lead assignment scope (L1)
description: Who an agent role may assign a lead to in PATCH /api/leads/:id, and how to prevent IDOR.
---

In `PATCH /api/leads/:id`, lead assignment (`assignedTo`) for agent roles is split by role:

- **agent / sub_agent**: may assign their lead to their own `agent_staff` member, claim it for themselves (`targetId === user.id`), or unassign (`null`). A staff target is valid only if `users.role='agent_staff'` AND `users.managingAgentId IN getAgentVisibleIds(user)`.
- **agent_staff**: self-claim ONLY — `assignedTo === user.id` AND `existing.assignedToId === null`. They may NOT unassign and may NOT assign to anyone else (mirrors the staff `records.change_assigned` claim rule).

**Why:** `isAgentRole` includes `agent_staff`, so a single agent branch would silently let a non-manager staffer reassign/unassign across the visible tree via direct API calls (the UI hides the dropdown for them, but that is not an authorization boundary). This is horizontal privilege escalation / IDOR.

**How to apply:** Always validate the assignment TARGET server-side against `getAgentVisibleIds`, never trust the client. Lead ownership itself is already gated earlier (`existing.agentId` must be in `agentVisibleIds`), so self-claim needs no extra lead-binding. Frontend: the shared `staff/LeadDetail.tsx` sources the dropdown from `/api/agents/me/staff` (agent/sub_agent only) and adds the acting user as a self option; `agent_staff` falls back to the "Assign to me" button.
