---
name: edcons application created_source classification
description: Which app-creation paths set created_source and why the automation backfill is only a best-effort proxy.
---

# applications.created_source (student | staff | automation)

Additive nullable column classifying WHO created an application. Null is treated as
`student` by the UI (safe default).

## UI surfaces that read created_source (keep in sync)
- Student-detail Applications tab: 3-group view (`student`/`staff`/`automation`), null→student.
- Applications board (`Applications.tsx`) filter panel: a "Source" dropdown
  (`filters.createdSource`: all / exclude_automation / only_automation), filtered
  CLIENT-side over `allApps` like every other board filter (no server param / OpenAPI
  change). Default `all` = board shows everything (unchanged behavior).
Neither surface changes pipeline/stage/fan-out logic — created_source is display/filter only.
NOTE: the board's "Origin" filter (`filters.originType`: direct/agent/sub_agent) is a
SEPARATE acquisition-channel filter — do not confuse it with the Source filter. An old
dead `filters.source` (agent/staff) was the removed duplicate-Origin remnant; gone now.

## Creation points that MUST set it
- `student`: public-apply.ts (embed/public/self-fill helper), leads.ts createApplicationFromSubmission (public lead intake).
- `staff`: applications.ts POST /applications, course-finder.ts authenticated apply.
- `automation`: portalAutomation.ts fanOutApplicationToUniversities (apply-to-all / bulk) AND lib/portal-runner/src/fallback.ts supersession (backup-programme) inserts.

**Why two automation paths matter:** the fallback/supersession insert in portal-runner is
a SECOND automation creation path, easy to miss because it lives outside api-server routes.
Any new app-creation path must set created_source or it silently falls into `student`.

## Backfill (boot DDL in api-server src/index.ts) is best-effort
- Mark `automation` when `superseded_from_application_id IS NOT NULL` OR the app has any
  linked portal_submissions row; everything else NULL → `student`.
- **Why it's a proxy, not exact:** there is no created_by history pre-migration, and
  fan-out portal_submissions ALSO set enqueued_by = user.id (the triggering staff), so
  enqueued_by canNOT distinguish fan-out from a manual portal enqueue. A manually-enqueued
  submission on a human-created app is therefore an ACCEPTED false positive.
- No historical `staff` detection is feasible (no marker), so old staff-panel apps backfill
  as `student`. Going forward they're correct via the creation-point assignment above.
