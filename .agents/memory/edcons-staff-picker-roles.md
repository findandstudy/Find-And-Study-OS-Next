---
name: edcons staff picker must filter by role server-side
description: Why assign/staff-picker dropdowns must request /api/users?roles=<csv>, not fetch unfiltered and whitelist client-side.
---

# Staff pickers must role-filter on the server, not the client

`GET /api/users` returns ALL non-deleted users (students, agents included), ordered `createdAt DESC`, capped by pagination (default 50, maxLimit "small" = 100). It accepts `role` (single), `roles` (comma-separated → `role IN (...)`), and `search`.

**Rule:** any staff/assignable picker (the Assign popover on Leads/Students/Applications cards, the "Assigned To" select on Lead/Student Detail, the staff filter popover, bulk assign) MUST fetch with the server-side role filter, e.g. `/api/users?roles=super_admin,admin,manager,staff,consultant,accountant,editor&limit=100`. Keep the client-side role whitelist only as a harmless secondary guard.

**Why:** fetching `/api/users` unfiltered and whitelisting roles client-side is a silent truncation bug. With many students/agents (e.g. 67 students vs 5 staff), the newest-first first page is dominated by students and older staff (low IDs) never appear — the dropdown then shows only whichever staff happened to land in that page (often just the newest one), while the Staff table looks complete because it sources from a server-side role-filtered endpoint (`/api/staff-cards`, which `inArray`-filters the same role set and `.limit(500)`).

**How to apply:** same class as the universities limit-cap precedent — selectors needing a complete list must constrain the query server-side (or paginate), never rely on the first default page. Role-filtered staff sets are small, so one `limit=100` page suffices.
