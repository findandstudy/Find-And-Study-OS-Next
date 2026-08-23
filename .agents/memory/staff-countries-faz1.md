---
name: Staff "handled countries" Faz 1 foundation
description: staff_countries table + helper for the conversation auto-assignment feature (Faz 2 not built yet)
---

`staff_countries` mirrors `staff_languages` exactly (id, user_id FK cascade, country text, created_at; unique(user_id,country); index(user_id)) — no proficiency-equivalent field.

**Why:** Faz 2's `assignStuckConversation()` will use this as one of the assignment-priority signals (working-hours → country match → round-robin), so the shape needed to support simple membership lookup only.

**How to apply:** Added via boot-DDL block in api-server `src/index.ts` (the only prod migration path) even though sibling tables `staff_languages`/`staff_work_schedules` were originally created via `drizzle-kit push` in dev and are NOT in boot DDL — that inconsistency means those two tables may be missing in prod; don't assume they exist there without checking. New staff-related tables should always go through boot DDL going forward.

Reusable read helper lives in `artifacts/api-server/src/lib/staffCountries.ts` (`getStaffCountries(userId)`, `getStaffCountriesForUsers(userIds)`) — Faz 2 should import from there rather than querying the table directly.

API: `GET`/`PUT /api/staff-cards/:userId/countries` (replace-all in a tx, dedup on write), plus `countries` array added to the aggregate `GET /api/staff-cards/:userId` response. UI: new "Handled Countries" accordion section in `StaffCardDetail.tsx` using the existing `MultiSelectFilter` component + `useCountrySearch("")` (full catalog, endpoint caps at 500 so no pagination needed for countries specifically, unlike universities).
