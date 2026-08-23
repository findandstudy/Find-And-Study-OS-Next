---
name: Express /me route before /:param
description: Static path segments like /me must be registered BEFORE wildcard /:id routes in Express or they get swallowed by the param.
---

## Rule
Any route with a static second segment (e.g. `GET /staff-cards/me/revenue-month`) must be defined in the router **before** any route with a wildcard param at the same position (e.g. `GET /staff-cards/:userId`).

**Why:** Express matches routes in declaration order. If `GET /staff-cards/:userId` is registered first, a request to `/staff-cards/me/revenue-month` will match it with `userId = "me"` — bypassing the intended handler entirely.

**How to apply:**
- After adding any `/resource/me/…` route, run `grep -n "router.get.*resource" file.ts | head -20` and verify all `/me/` lines appear before the `/:id` catch-all.
- This was caught when `GET /staff-cards/me/revenue-month` was placed at the end of the file (line 735) while `GET /staff-cards/:userId` was at line 117.
