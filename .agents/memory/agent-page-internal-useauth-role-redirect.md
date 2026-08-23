---
name: Page-level useAuth role array silently excludes a role
description: agent_staff bounced to /en from Leads/Students/Applications despite route-level authorization — a page-internal useAuth(true, roleArray) excluded the role.
---

# Page-internal `useAuth(true, roleArray)` can override route-level authorization

A role with valid permissions could open a portal page's route (route-level
`ProtectedRoute allowedRoles={AGENT_ROLES} requiredPermission=...` authorized it
and rendered the page), but was then bounced to `/` → LanguageRedirect → `/en`
public homepage. No AccessDenied, looks like a "redirect to home" bug.

**Root cause:** the page COMPONENT itself called `useAuth(true, ["agent","sub_agent"])`
— a hardcoded role array that excluded `agent_staff`. `useAuth`'s effect fires
`setLocation("/")` whenever `allowedRoles && !allowedRoles.includes(user.role)`,
so the page redirected itself AFTER the route guard had already allowed it. Two
authorization points disagreed.

**Fix:** drop the role array — call `useAuth(true)` (auth-only). Route-level
`ProtectedRoute` is the single source of truth for role + granular permission.
Passing `AGENT_ROLES` again would work but duplicates policy and risks future drift.

**Why:** authorization centralized at the route is the intended pattern (sibling
agent pages Dashboard/Commissions/Messages already use `useAuth(true)`). A page
re-deciding role membership with a stale/narrow list is the trap.

**How to apply / debug:**
- Symptom "logged-in user with permission lands on /en when clicking a sidebar
  link" → grep the destination PAGE for `useAuth(true, [` , not just the router.
- The redirect to `/en` (public) is `useAuth`'s role-mismatch branch
  (`setLocation("/")`); the `/login` redirect is the unauthenticated branch.
- Fastest isolation: temporarily log `user.role` + `allowedRoles` in that branch,
  reproduce via Playwright; the offending `allowedRoles` value names the culprit.
- Staff pages legitimately use `useAuth(true, [...])`; only the agent-portal pages
  were wrong here. Don't blanket-remove.
