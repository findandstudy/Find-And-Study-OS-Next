---
name: Topkapı Step 3 education-field mapping & gpa normalization
description: Why portal Step-3 fields (school/gpa/grad) come through empty, and where to normalize gpa once for all adapters.
---

# Portal Step-3 education fields empty despite DB data

A portal adapter filling Step-3 fields (schoolName, gpa, graduationDate) with
"-"/empty is almost never an adapter bug — it's a **profile-builder mapping gap**.

**Why:** there are TWO independent SubmitProfile builders that must stay in sync:
- `lib/portal-runner/src/profile.ts` (api-server "Run Now" / poller path)
- `artifacts/portal-automation-worker/src/profile.ts` (worker path)
A field mapped in one but not the other silently yields `undefined` on the
unmapped path, and the adapter then fills a placeholder. The runner builder was
missing schoolName/graduationYear entirely.

**gpa:** never `Number(student.gpa)` in a builder — CRM gpa can be a range
("2.8-3.0"), which becomes NaN. Normalize once at the shared ingestion point:
`normalizeGpaRange()` in `lib/portal-adapters/src/profile.ts`, called inside
`buildProfile`. Range→upper bound, comma→dot, empty→undefined, unparseable→throw
(fail loud). Builders pass the RAW gpa string; SubmitProfile.gpa stays `number`.

**graduation:** CRM stores year-only. Expand to the portal's widget format by the
REAL DOM input type, not by guessing — log `describeInput()` (tag/type/attrs)
first, then `formatGraduationForInput(year, type)` (date→YYYY-01-01, month→YYYY-01,
week→YYYY-W01, else year).

**How to apply:** when a Step-N field is "empty after retry", check the builder
mapping on BOTH paths before touching the adapter; keep the fail-visible
verify/retry gate, it surfaces the real gap rather than causing it.
