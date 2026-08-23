---
name: SIT SPA session seed for UI wizard
description: Why SIT UI automation (doc/photo upload) must seed the Supabase session into the browser instead of logging in
---

# SIT UI wizard needs the Supabase session seeded into the browser

**Lesson:** SIT authenticates GraphQL with a Supabase bearer minted via a token
grant and deliberately never submits the SPA login form (the form trips
captcha/rate-limit). So the browser has no Supabase session in localStorage, and
any UI route the runner opens (the student-detail wizard used for the
file-chooser doc/photo upload) sees no session and bounces to the captcha'd
login — the upload guard/retry run fine but every attempt fails.

**Rule:** never "fix" that redirect by switching to a UI form login. Instead seed
the already-minted session into the browser's Supabase localStorage key **before
navigation** (Playwright `addInitScript`, not post-load `evaluate` — the SPA
reads auth on boot). Do the seeding inside `ensureLoggedIn` (the sanctioned
session helper that `reLogin` delegates to) so every later navigation on the same
page is covered and redirect recovery re-seeds.

**Why:** live doc/photo uploads silently failed with "oturum /auth/login'e
düştü" despite correct create/guard/upload logic; the only missing piece was the
browser session. Reuses the same injection the graphql probe page already relies
on, which proves the shape authenticates the SPA.
