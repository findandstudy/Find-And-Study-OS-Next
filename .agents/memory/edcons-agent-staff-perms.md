---
name: agent_staff permission enforcement
description: How the agent-staff granular permission system (Edit Staff Member dialog) is enforced end-to-end in edcons.
---

# agent_staff permission enforcement

The 7 granular perms (leads, students, applications, documents, course_finder,
messages, commissions) for the `agent_staff` role are enforced as follows:

- **Backend middleware**: `requireAgentStaffPermission(...keys)` in
  `api-server/src/lib/auth.ts`. It is a **no-op for every role except
  `agent_staff`** (returns next() early), and for agent_staff it reads
  `users.agentStaffPermissions` **fresh from the DB every request**. So adding
  it to a route never affects other roles, and changes take effect server-side
  immediately. It is named `requireAgentStaffPermission`, NOT
  `requireStaffPermission` — grepping the wrong name yields no hits and a false
  "no enforcement" conclusion.
- Already applied across leads/students/applications/documents/course_finder
  (`/agent/conversations`)/commissions (`finance.ts /agent/*`) routes.
- **Frontend route guard**: `ProtectedRoute requiredPermission="<key>"` checks
  `user.agentStaffPermissions`.
- **Sidebar**: `DashboardLayout` filters agent menu items by `permKey` against
  `agentStaffPermissions`.

**Why a user can still report "no effect" even when fully wired:**
1. The `documents` perm has no sidebar item / route — it only gates the
   document panels inside the Application detail. Those panels must be hidden
   client-side with `hasAgentStaffPermission("documents")` (added to `useAuth`);
   the backend stage-document endpoints already 403.
2. A logged-in staff member's frontend `user` (sidebar + route guard) is cached
   and won't update on a managing agent's permission change until `/auth/me`
   refetches. Fix: `useAuth`'s `useGetMe` polls `/auth/me` every 5s **only when
   role === agent_staff** (refetchInterval function form, react-query v5) +
   refetchOnWindowFocus.

**How to apply:** `useAuth().hasAgentStaffPermission(key)` returns `true` for all
non-agent_staff roles (so it never regresses staff/admin/agent access) and the
membership check only for agent_staff.
