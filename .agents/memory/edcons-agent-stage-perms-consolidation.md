---
name: Agent stage perms moved into Roles & Permissions
description: How agent lead/student/app stage-change gating was consolidated from Settings toggles into the permission system
---

Agents' stage-change ability used to be gated by two Settings toggles
(`agentCanChangeLeadStage`, `agentCanChangeStudentAppStage`). These were folded
into the normal Roles & Permissions system.

- **Lead stage** reuses the EXISTING `leads.change_stage` key (Leads group). The
  staff enforcement branch historically excluded agents (`!isAgent`); agents now
  get their own check.
- **Student + application stage** uses ONE NEW combined key
  `applications.change_student_app_stage` (Applications group). It governs ONLY
  the AGENT student-status path (students.ts) and AGENT app-stage governed
  transition (applications.ts). Staff paths KEEP `students.change_stage` /
  `applications.change_stage` unchanged, so the new key is INERT for staff →
  staff/admin behavior unchanged.

**Why the agent check resolves perms separately:** in leads.ts/students.ts/
applications.ts the `perms` Set is intentionally EMPTY for the agent (and admin)
branch. So the agent stage check must call `getEffectivePermissionSet({id,role})`
separately, not read `perms`.

**Upgrade migration:** one-shot, gated by `system_flags` marker
`agent_stage_perms_migrated_v1` (must run exactly once or it clobbers admin
choices on reboot). It reads the live `settings.agent_can_change_lead_stage` /
`agent_can_change_student_app_stage` values and mirrors them onto agent-family
roles (agent/sub_agent/agent_staff), plus grants the new combined key to
non-agent stage roles (super_admin/admin/manager/staff/consultant). Defaults:
lead=true, student/app=false — mirrored into DEFAULT_ROLE_PERMISSIONS too (agent
family gets leads.change_stage by default, NOT the combined key).

**Note:** `agent_staff` may have no `roles` DB row; `getEffectivePermissionSet`
falls back to DEFAULT_ROLE_PERMISSIONS, so defaults matter for that role.

Legacy `settings` columns kept (unused) per no-destructive-drop rule; removed
from PATCH allowlist + deleted GET `/settings/agent-permissions`. Orphan
`agentStagePerms.*` i18n keys left in translation JSONs (harmless).
