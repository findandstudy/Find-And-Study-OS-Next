---
name: edcons User Activity internal-only scope
description: User Activity module must be scoped to internal team roles in every data path; agent roles excluded.
---

# User Activity is internal-team-only

The admin **User Activity** module (presence, analytics, module usage, per-user
detail, PDF report) must show ONLY internal staff — `@workspace/roles`
`STAFF_ROLES` (super_admin/admin/manager/staff/consultant/editor/accountant).
`agent`/`sub_agent`/`agent_staff` are excluded (`AGENT_ROLES`).

**Why:** agency personnel (e.g. "DORM BOOKING", sub-agent staff) were polluting
the "All Staff" dropdown and the aggregate cards, hiding the real internal team.

**How to apply:** the role filter has to be enforced in FIVE independent places —
missing any one leaks agent data:
- `/activity/presence` — `inArray(users.role, STAFF_ROLES)` in conditions.
- `/activity/analytics` — same filter in the session-aggregation conditions.
- `/activity/modules` — needs an explicit `innerJoin(usersTable)` first, because
  it aggregates `user_page_visits` which has no role column of its own.
- `/activity/user/:userId` — 404 if target role ∉ STAFF_ROLES.
- `/activity/report/pdf` — 404 if target role ∉ STAFF_ROLES.
- Frontend `Activity.tsx` — build the staff `Set` from `@workspace/roles`
  `STAFF_ROLES`, never a hand-written literal (the old literal wrongly included
  `agent_staff`).

# Activity PDF branding & counts
- `brandedBase.ts` `esc()` decodes named entities (`&mdash;`/`&ndash;`/`&middot;`
  /`&nbsp;`) BEFORE escaping `&`, so report titles render real dashes not literal
  entity text. `esc` is shared by all branded PDFs — decode is safe (only changes
  output when raw text literally contains those entities).
- Branding is 100% Settings-driven: NO hardcoded company fallback ("Find & Study"
  removed from `buildBrandedHtml` + `buildBrandedFooterTemplate`; empty when unset).
- Page numbers use Chromium's `pageNumber`/`totalPages` footer classes with
  `displayHeaderFooter:true` — CSS `counter(page)` renders as 0 in Chromium body.
- The PDF "Sessions" KPI must use a real `COUNT(*)` query, NOT `sessions.length`
  (the session list is `.limit(100)`, so length caps at 100).
