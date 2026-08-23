---
name: SIT auth single-session + token grant
description: How SIT adapter authenticates without tripping captcha/rate-limit
---

# SIT auth: mint token, never submit the login form

The SIT (sitconnect) portal trips **captcha / rate-limit** when the /auth/login
FORM is SUBMITTED repeatedly. The old flow ran `performLogin` (fill + submit)
once per submission and cached the Supabase token per-page (WeakMap), so every
fresh page re-logged-in.

**Rule:** obtain the Supabase bearer via a **token grant** (global `fetch`,
`grant_type=password` or `refresh_token`) — never by submitting the form. The
token is cached at **process level**, keyed by lowercased email, and reused
across all submissions (single-session). UI form login is a LAST RESORT gated by
a ~10-min cooldown after a captcha failure (no tight retry loop).

Acquisition order in `getSitAccessToken`: fresh cached token → env
`SIT_REFRESH_TOKEN` refresh grant → env `SIT_ACCESS_TOKEN` (JWT) → password
grant. Optional env `SIT_SUPABASE_URL` / `SIT_SUPABASE_ANON_KEY` override the
hardcoded URL + page-captured anon key.

**Chicken-and-egg (the anon apikey):** the password grant itself NEEDS the
public Supabase anon apikey, but the SPA only fires its `*.supabase.co` request
(carrying the key) AFTER a successful login — which trips captcha. So the anon
key must be obtained WITHOUT logging in. Anon-key resolution order:
env `SIT_SUPABASE_ANON_KEY` → process cache → passive SPA-boot capture (page) →
**JS-bundle regex fallback** (no page). The bundle fallback fetches the SPA root
HTML and its **same-origin** JS assets and regexes the embedded anon JWT out —
prefer role=`anon` with matching project ref, else any anon-role JWT.
**Why (live gotcha):** the anon-key chunk is a deep vendor bundle (observed at
the ~19th `<script>` tag), so the ref scan must NOT cap low (cap 48, not 12) or
it silently misses the key and falls back to captcha login. Only fetch
same-origin refs (SSRF / supply-chain guard); never a third-party URL in the
markup.

**Why (two easy-to-miss traps):**
- **Always GET the origin even when a token is cached.** GraphQL reads need the
  Laravel **XSRF-TOKEN cookie** (+ Bearer + apikey). Each submission gets a
  brand-new page, so `login()` must still navigate (plain GET, no submit) to set
  the cookie. Use `sitCanAuthWithoutPage()` ONLY to decide whether to also wait
  for the SPA to boot and capture the anon key — never to skip navigation.
- **Env refresh fallback must key off token *validity*, not presence.** A
  non-JWT `SIT_ACCESS_TOKEN` must not block the `SIT_REFRESH_TOKEN` refresh
  branch. Gate on `injectedValid = injected && JWT_RE.test(injected)`.

Never log token/secret VALUES — only acquired/refreshed/reused/expired state and
HTTP status. In-memory only (no DB persistence → honors no-migration);
`SIT_REFRESH_TOKEN` survives restarts.
