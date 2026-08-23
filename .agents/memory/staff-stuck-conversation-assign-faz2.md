---
name: Stuck-conversation auto-assign (Faz 2)
description: assignStuckConversation core (immediate hook + periodic sweep) — tiering logic, granular settings toggles, in-app-only notification, round-robin persistence
---

Two trigger paths share one core (`assignStuckConversation()` in `artifacts/api-server/src/lib/stuckConversationAssigner.ts`), both gated by `settings.autoAssignStuckConversationsEnabled` (default false):
1. **Immediate handoff:** `assignStuckConversationById(conversationId)`, called fire-and-forget right after `needsHuman=true` is set (both escalation points in `botAutoReply.ts`). Validates not-already-assigned/needs_human/non-internal itself, so it's safe to call unconditionally from any needsHuman-flip site.
2. **Periodic catch-up sweep:** `runStuckConversationSweep()` (5 min interval, 45s initial delay) — a safety net for anything that slipped through (manual needsHuman flips, transient failures in the immediate path). Stuck definition: `needsHuman=true AND assignedToId IS NULL AND status='open' AND channel != 'internal' AND updatedAt <= now - 10min` (matches portal-automation's 10-min stuck-threshold convention).

**Race safety:** the assignment UPDATE is `WHERE id=? AND assignedToId IS NULL RETURNING id` — if another process (sweep vs. immediate hook) already assigned it, the `.returning()` comes back empty and the caller treats it as a no-op, not an error.

**Granular settings (3 toggles, all in `settingsTable`, all default to the pre-existing sweep-only behavior):** `stuckAssignConsiderWorkingHours` (bool, default true), `stuckAssignConsiderCountryMatch` (bool, default true), `stuckAssignOffHoursBehavior` (`'assign_anyway'|'leave_unassigned'`, default `'assign_anyway'`). UI in `AutoAssignStuckConversationsCard` (edcons Settings.tsx) only shows the three sub-controls when the master toggle is on; off-hours-behavior Select is itself disabled when working-hours consideration is off (behavior is meaningless without it).

**Tiering respects the toggles (each tier narrows only if enabled AND non-empty, else falls back to the wider pool — UNLESS `considerWorkingHours` is on, the working-hours pool is empty, AND `offHoursBehavior='leave_unassigned'`, in which case `pickAssignee` returns `null` and the conversation stays queued/unassigned for the next sweep):** eligible pool (active users, role in `STAFF_ROLES`) → working-hours match (per-user `timezone` + `staff_work_schedules`, DST-safe Intl-based helpers) → country match (via Faz 1's `getStaffCountriesForUsers`, conversation country resolved through `externalContactsTable.leadId → leadsTable.interestedCountry || country`) → round-robin (persisted cursor in `system_kv` key `stuck_conversation_rr_last_user_id`).

**Why the null-return branch matters:** without it, "leave unassigned outside working hours" was impossible to express — the old sweep-only design always fell back to the full pool, silently ignoring the operator's intent to hold off-hours conversations for a human decision later.

**Notification is in_app-only by design:** `notification_rules` row for event `conversation.stuck_assigned` seeded with `channels=["in_app"]`, `recipient_type='specific'` (dispatchNotification's `ctx.recipientUserIds` overrides recipient resolution regardless of recipientType).

**Testing gotcha — don't test against the real staff pool:** `getEligibleStaffPool()` pulls ALL active `STAFF_ROLES` users, not just synthetic test rows; a manual round-trip test that enables the feature flag on the shared dev DB will round-robin-assign to a REAL staff member and fire a real in-app notification + audit_log row (event `conversation.stuck_assigned`, resource `conversation`) pointing at the test conversation id. If you must test end-to-end against real data, clean up `notifications`/`audit_logs` rows referencing the test conversation id afterward (they aren't cascade-deleted when the conversation itself is deleted).
