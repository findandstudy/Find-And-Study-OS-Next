---
name: Topkapi GPA scale + parent-name guard
description: topkapiGpaTo100 converts 4/5/10/20-scale GPA to 0-100; fatherName/motherName use "-" fallback in profile builders.
---

## Rule

**GPA**: `normalizeGpaRange()` (shared) returns the FIRST numeric token (e.g. 2.80 from "2.80/4"). Topkapı portal rejects sub-10 values as "unparseable GPA". `topkapiGpaTo100()` in `adapter.ts` applies the scale heuristic (same as `api-server/gpaNormalize.ts`):
- ≤4 → ×25 (4-scale: 3.5→87.5)
- ≤5 → ×20
- ≤10 → ×10
- ≤20 → ×5
- >20 → as-is (already 0-100)

Returns `"-"` when gpa is undefined. Located in `lib/portal-adapters/src/universities/topkapi/adapter.ts`.

**Parent names**: `buildProfile` requires non-empty `fatherName`/`motherName` (in REQUIRED_FIELDS). Both profile builders must use `|| "-"` fallback (not `?? ""`), because `?? ""` passes an empty string which throws. Pattern:
```typescript
fatherName: student.fatherName?.trim() || "-",
motherName: student.motherName?.trim() || "-",
```
With a `console.warn` log when the fallback fires. Files: `artifacts/portal-automation-worker/src/profile.ts` AND `lib/portal-runner/src/profile.ts`.

**Why**: Empty string `""` passes `?? ""` but fails `buildProfile`'s `=== ""` guard → throws → crashes the entire submission for a field that's genuinely absent in many student records.

**How to apply**: Any future change to profile field fallbacks in either profile builder must use `|| "-"` (not `?? ""`) for REQUIRED_FIELDS that may legitimately be null in the DB.
