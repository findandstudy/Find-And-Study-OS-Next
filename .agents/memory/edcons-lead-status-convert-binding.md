---
name: Lead "converted" status binds to convert endpoint
description: Why selecting the converted lead status must go through the convert flow, and how agent lead-stage editing is gated.
---

Selecting the `converted` status in the shared lead detail (`staff/LeadDetail.tsx`, used by both staff `/staff` and agent `/agent` via `basePath`) must trigger the idempotent convert endpoint (`POST /api/leads/:id/convert`) so a student is actually created/merged. A plain status PATCH only flips the string and leaves no student.

**Why:** A lead whose status reads "converted" but has no `convertedStudentId` is a broken state — downstream students/applications never get created. The convert endpoint is idempotent (checks `convertedStudentId`, merges by email) so re-running is safe sequentially. It is NOT concurrency-hardened (no row lock), so the frontend must guard against rapid re-fire (`convertLead.isPending` short-circuit + disable the Select while pending).

**How to apply:** Any new UI that changes a lead's stage to the won/"converted" variant should route through convert, not a raw status update. Agents can edit lead stage only when the agency setting `agentCanChangeLeadStage` (default true) is on — fetch it from `GET /api/settings/agent-permissions` (requireAuth only). The shared LeadDetail's `canChangeStage` must special-case agents (`isAgent ? agentCanChangeLeadStage : isAdmin || hasPermission("leads.change_stage")`); the staff permission model alone excludes agents.
