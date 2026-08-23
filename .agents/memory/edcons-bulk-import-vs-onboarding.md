---
name: edcons agent bulk Excel import vs onboarding
description: Why bulk agent import must not reuse the heavy POST /agents onboarding flow, and the scoping/matching rules it must follow.
---

Bulk Excel import of agents (staff Agents page) inserts agent profile rows
DIRECTLY — no onboarding email, no user account, no signing session. The
normal `POST /agents` flow is unsuitable for bulk because it requires an
`assignedContractTemplateId` + email and creates a user, sends onboarding
mail, and opens an admin-driven signing session per agent.

**Why:** bulk roster import should be predictable and idempotent; triggering
onboarding side effects per row would spam emails and create half-finished
signing sessions. Admins onboard individually afterward if needed.

**How to apply (rules that must hold for the import route):**
- Conflict key = email, matched with EXACT case-insensitive equality
  (`lower(email)=lower($1)`), never ILIKE — a cell containing `%`/`_` would
  otherwise match unintended rows.
- Restrict the existing-row match AND any FK (parent agent) to the caller's
  visible branches (`getVisibleBranchIds`; null = super_admin sees all). A
  branch-limited manager must not overwrite/expose out-of-scope agents.
- On create, assign a default `agent_branches` link (creator's first visible
  branch) exactly like `POST /agents`, or scoped managers won't see the
  imported agents in their own lists (orphan rows).
- Reference sheets in the template/export (parent-agent suggestions) must be
  branch-scoped too; contract templates are org-wide config so they stay global.
- Conflict strategies: skip=leave existing, overwrite=update fields,
  rename=insert a new row (email has NO unique constraint, duplicates allowed).
