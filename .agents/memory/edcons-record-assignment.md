---
name: edcons record assignment (lead vs student)
description: How to assign a staff member to a lead vs a student via the API, including the field-name difference.
---

# Assigning staff to leads vs students (edcons)

Both leads and students support a single staff assignee (`assigned_to_id` column). The detail-page UI (an "Assigned To" Select) lives in `LeadDetail.tsx` and `StudentDetail.tsx`, loads staff from `/api/users` (admin-gated), filters to roles `super_admin/admin/manager/staff/consultant`, and is permission-gated by `canChangeAssigned` (`isAdmin || hasPermission("records.change_assigned")`).

## Field-name difference in the PATCH body (gotcha)
- Lead: `PATCH /api/leads/:id` expects `{ assignedTo: <id|null> }` — the route maps `assignedTo` → `assignedToId`.
- Student: `PATCH /api/students/:id` expects `{ assignedToId: <id|null> }` directly (it is in STUDENT_PATCH_FIELDS).
**Why:** the two routes were built with different body contracts; sending `assignedTo` to the student route silently does nothing.
**How to apply:** when wiring student assignment, send `assignedToId`; for leads send `assignedTo`. GET responses for both expose `assignedToId`.

## Two distinct assignment permissions (list/card/menu gating)
- `records.assign_button` (`canAssign`) = may assign an **unassigned** record (full staff picker) or self-claim it.
- `records.change_assigned` (`canReassign`) = may **reassign an already-assigned** record to someone else.
- `isAdmin` (super_admin/admin/manager) is always flexible (both true).
**Why:** an already-assigned lead/student/application must NOT be reassignable by a user lacking `records.change_assigned`.
**How to apply:** every assign affordance across Leads/Students/Applications (kanban card AssignPopover, list-table AssignPopover, and RowActionsMenu assign item) must gate with `record.assignedToId ? canReassign : canAssign`. BulkActionBar's Assign button shows only when its `staffUsers` prop is non-empty, so pass `staffUsers={canReassign ? staffUsersList : []}` (bulk endpoints are admin-only anyway). The "assign to me" self-claim fallback stays open for unassigned records (backend permits self-claim of unassigned without `change_assigned`). Backend per-record PATCH already strips `assignedTo` when the record is assigned and the user lacks `change_assigned` — UI gating is the cosmetic mirror of that rule.

## Documents uploaded to an already-converted lead must cross-link to the student
- `POST /api/leads/:id/documents` inserts with `studentId: lead.convertedStudentId ?? null` (not just `leadId`). Otherwise a doc added via Lead Detail AFTER conversion never appears in the student's documents tab (`GET /api/documents?studentId=` filters on `documents.studentId`).
**Why:** the convert handler only backfills docs that existed at conversion time; post-conversion uploads need the studentId link set at insert time. `leads.convertedStudentId` ↔ `students.originLeadId`.
