---
name: Embed/public-apply auto-convert gating
description: Why lead auto-convert and document attachment must gate on the student existing, not the application
---

# Embed/public-apply lead auto-convert gating

In the public intake handlers (`routes/embed.ts` `POST /public/embed/:slug/apply`
and `routes/public-apply.ts`), after the lead+submission transaction the
post-processing creates/links a student, then calls
`createApplicationForStudent(...)`, then attaches documents, then auto-converts
the lead.

**Rule:** document attachment and lead auto-convert must gate on the *student*
existing (`resultStudentId`), NOT on `resultStudentId && resultAppId`.

**Why:** `createApplicationForStudent` returns `{ appId: null }` (not a throw)
when the target program's eligibility fails (GPA / language below minimum, or
missing) or the program quota is full. The embed widget collects fewer fields
than the full apply dialog, so program-targeted widgets frequently hit this.
When the gate also required `resultAppId`, an ineligible/quota-blocked submit
left the student created but the lead stuck in "new" and the uploaded documents
orphaned on the lead (studentId/applicationId null). Spec intent: hitting Submit
is the funnel-closing event for the lead regardless of missing docs or whether
an application could be created — staff resolve eligibility from the student
detail view.

**How to apply:** `documents.applicationId` is nullable (onDelete set null), so
attaching docs with `applicationId: resultAppId` (possibly null) is valid. Keep
the lead-only fallback branch only for the true no-student case
(`resultStudentId` null), e.g. when an email collides with an existing
non-student user account (that path still creates no student).

Lead "converted" stage: setting `leadsTable.status = "converted"` is correct —
"converted" is the canonical lead `won`-variant pipeline stage key (see
`pipeline.ts` defaults and `leads.ts` convert route). Manual convert hardcodes
"converted" on first conversion too, so embed mirroring it is consistent.
