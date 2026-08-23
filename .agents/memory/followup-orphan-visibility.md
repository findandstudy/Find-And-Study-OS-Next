---
name: Follow-up/note orphan visibility
description: How soft-delete hides follow_ups/notes (no deleted_at column) and the dual-link pitfall.
---
Rule: follow_ups and notes tables have NO deleted_at. Deleting a lead/student does not touch them; every listing/notification surface must filter by parent-alive (EXISTS ... deleted_at IS NULL). Covered: followUpChecker, GET /follow-ups/upcoming, personFeed, per-entity notes routes, export/leads. Any NEW surface that reads follow_ups/notes must add the same filter.
**Why:** Orphaned follow-ups kept showing in "upcoming" and firing reminder notifications after their lead/student was deleted ("arafta kalıyor").
**How to apply:** Visibility predicate = (both ids NULL) OR (lead set AND lead alive) OR (student set AND student alive). Do NOT AND the two checks independently — inbox creates dual-linked rows (leadId+studentId) and independent ANDing hides them when only one parent is deleted.
Pitfall: CTE INSERT rows are invisible to EXISTS in the same SQL statement — seed test data in separate statements.
