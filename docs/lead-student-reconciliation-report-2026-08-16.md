# Lead–Student–Application Reconciliation Report

Generated: 2026-08-16 (Europe/Istanbul)  
Environment: production, read-only SQL analysis  
Scope: active leads, students and applications; no record was changed.

## Executive summary

- Referential integrity is healthy for active applications: there are no active applications without an active student, no orphan `origin_lead_id` values, and no explicitly linked application whose lead points to another student.
- 205 active applications do not have an explicit `lead_id`. The conservative matcher classifies only 6 as safe candidates. Those six still require administrator approval through the existing one-row approval endpoint.
- 11 active leads point to deleted students. These are blocking lifecycle inconsistencies and must be reviewed before any automatic repair.
- 10 active lead–student pairs and 2 active application–student pairs have different assignees. These are ownership inconsistencies, not identity evidence, and must not be used to infer links.
- The historical reverse link remains incomplete: of 823 active lead → active student conversion links, only 42 are also recorded as the student's `origin_lead_id`; 776 students have no origin lead and 5 point to another origin lead. Nine students are referenced by more than one converted lead.

## Application → lead candidate analysis

| Classification | Count | Rule |
|---|---:|---|
| Safe candidate | 6 | Exactly one active application, exactly one candidate lead, and authoritative lineage (`origin_lead_id` or `converted_student_id`) |
| Review unique identity | 4 | Exactly one active application and one email/phone candidate, but no authoritative lineage |
| Ambiguous | 154 | Multiple candidates and/or multiple applications for the student |
| No candidate | 41 | No active lead matched by lineage, normalized email or normalized phone |

Safe candidate application IDs: `3246`, `3252`, `3256`, `3307`, `3308`, `3310`.

These IDs are candidates only. Approval must remain one-row-at-a-time through `POST /admin/data-quality/application-lead-links/:applicationId/approve`; that endpoint requires the selected lead to already reference the same student through `converted_student_id` and is transactionally guarded.

## Integrity exceptions requiring review

Active leads pointing to deleted students:

`1590`, `1775`, `2417`, `2681`, `2701`, `2724`, `2900`, `3046`, `3157`, `5218`, `5223`

Lead:student assignment mismatches:

`1816:2154`, `2454:2229`, `2671:2363`, `2959:2511`, `3031:2686`, `3185:2644`, `3231:2661`, `3290:2717`, `3318:2710`, `3912:2851`

Application:student assignment mismatches:

`2233:2229`, `3237:2196`

## Safe remediation order

1. Review the 11 active leads that point to deleted students. Decide per row whether the student should be restored, the lead should be detached, or the lead should be linked to a different already-existing student. Do not infer this from assignment alone.
2. Review and approve the 6 safe application candidates individually. Re-run the report after every batch.
3. Manually inspect the 4 unique-identity candidates. Email/phone equality alone is not sufficient for an automatic write.
4. Resolve the 12 assignment mismatches independently of identity reconciliation.
5. Leave the 154 ambiguous and 41 no-candidate applications untouched until additional evidence is available.
6. Re-run `/admin/data-quality/lifecycle-integrity` and `/admin/data-quality/application-lead-links`; deployment blockers must be zero before enabling any broader backfill.

## Existing safeguards used

- `/admin/data-quality/lifecycle-integrity` is count-only and performs no writes.
- `/admin/data-quality/application-lead-links` returns record-level candidates but performs no writes.
- The approval endpoint is admin-only, one-row, idempotent, advisory-lock protected, rejects applications already linked elsewhere, and refuses leads that do not authoritatively reference the same student.

