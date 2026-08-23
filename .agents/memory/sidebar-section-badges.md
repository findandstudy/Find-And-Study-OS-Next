---
name: Sidebar section notification badges
description: How the red count badges on the staff sidebar nav (Leads/Students/Applications/Tasks) are driven, and the gotcha when adding a new one.
---

# Sidebar section badges (EduConsult OS / Find And Study OS)

The red count badges next to sidebar nav items are NOT a bespoke per-section counter.
They are derived entirely from **unread in-app notifications**:

- Frontend (`artifacts/edcons/src/components/layout/DashboardLayout.tsx`) queries
  `/api/notifications/section-counts` and renders a badge when `sectionCounts?.<section> > 0`,
  matched by `item.url.endsWith("/<section>")`.
- Backend (`artifacts/api-server/src/routes/notifications.ts` `section-counts` handler) buckets
  each unread notification into a section by inspecting the notification `type` prefix
  (e.g. `task.`, `lead.`), `data.resourceType`, or the `actionUrl` substring.
- Badges also clear when the user visits the section's page: `DashboardLayout` watches the
  route and POSTs `/notifications/section/:section/read`, which marks all unread notifications
  bucketed to that section (leads/students/applications/tasks) as read, then invalidates the
  section-counts query. The bell panel (NotificationCenter) is plain local state + SSE, NOT
  react-query, so invalidating react-query keys does not refresh it — it updates on its own
  SSE/focus cycle.
- Both the badge count query and the mark-section-read endpoint share one `bucketSection()`
  helper so their section-matching rules can never drift apart. Edit both behaviors by editing
  that single function.

## Gotcha: a notification is only created if an ACTIVE notification rule exists for the event
`dispatchNotification` (`artifacts/api-server/src/lib/notificationDispatcher.ts`) returns early
(`if (!rule) return;`) when there is no active row in `notification_rules` for the event.

**Why:** This is why simply calling `dispatchNotification("task.assigned", ...)` produces nothing
unless the rule is registered. The existing leads/students/applications badges work only because
their `*.created` rules are seeded and active.

**How to apply — to add a new section badge end to end:**
1. Add the event to `NOTIFICATION_EVENTS` + a row in `DEFAULT_NOTIFICATION_RULES`
   (`lib/db/src/schema/notifications.ts`).
2. Add a matching `INSERT INTO notification_rules ... ON CONFLICT (event) DO NOTHING` to
   `artifacts/api-server/src/seed.sql`. `runSeedSQL` runs on every boot and is idempotent, so a
   plain insert (no system_flags marker needed) lands the rule in the existing external DB on restart.
3. `dispatchNotification(...)` from the route that performs the action (pass `recipientUserIds`
   for `recipientType: "specific"`; the dispatcher excludes the actor automatically).
4. Add a bucket branch in the `section-counts` handler.
5. Add the badge render block in `DashboardLayout.tsx`.
