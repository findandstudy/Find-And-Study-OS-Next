---
name: Active-program-only country/university lists
description: Where to source destination/university dropdowns so they only show entries with active programs (Course Finder parity)
---

To populate a country/university selector that must EXCLUDE destinations/universities with no active programs (i.e. match the Course Finder filter exactly), fetch `/api/course-finder/filters` (optionally `?country=<encoded>`), NOT `/api/universities/countries` or `/api/universities?country=`.

**Why:** `/api/course-finder/filters` builds facets via `buildProgramFacetConditions`, which starts from `programs.isActive = true`. So its `countries` (string[]) and `universities` ([{id,name}]) are guaranteed to only include entries that actually have active programs. The `/api/universities*` endpoints return raw university records and surface empty destinations (e.g. a country with a university row but zero active programs).

**How to apply:** Reuse `/course-finder/filters` for any "pick where to apply / pick a university" UI that should mirror Course Finder. Do NOT remove `/api/universities/countries` — it has other consumers (e.g. UniversityContracts) that intentionally want all universities.
