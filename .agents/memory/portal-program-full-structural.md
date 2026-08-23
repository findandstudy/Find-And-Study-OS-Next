---
name: Structured program_full (Kontenjan dolu)
description: How quota-full is modeled structurally end-to-end (adapter → SubmitResult → writeback meta) and the dryRun precedence rule.
---

# Structured `program_full` (Topkapı "Kontenjan dolu")

Quota-full is a STRUCTURAL outcome, not a thrown error. Adapter Step-4 fast-fail
returns `{ submitted:false, programFull:true, requestedProgram, openPrograms }`
(openPrograms = portal options mapped to `{value,name,enabled:!disabled}`).
Writeback sets `portal_submissions.status='program_full'`, writes the
`requestedProgram`/`openPrograms`/`reason`/`detectedAt` payload to the
`portal_submissions.meta` jsonb, and makes **NO** application stage change.

**Rule:** in `stageWriteback.resolveTarget`, the `program_full` branch MUST come
**before** the `dryRun` branch.
**Why:** a dry-run that hits quota-full is still a real structural finding worth
surfacing; if `dryRun` were checked first it would mask `program_full` as a plain
`dry_run`. The `meta` jsonb is written ONLY when `result.programFull` is true.

**How to apply:** when adding any new structural SubmitResult outcome, decide its
precedence vs `dryRun` explicitly and add a regression test asserting it wins
(TW5 covers program_full-beats-dry_run).
