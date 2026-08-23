---
name: CSRF double-submit must be seeded client-side
description: Why server-set CSRF cookies don't reach edge-served SPAs, and the deployment-independent client-seeding fix.
---

# CSRF double-submit must be seeded client-side, not by the server

**Rule:** For a double-submit CSRF scheme (server requires `csrf_token` cookie ===
`x-csrf-token` header on unsafe methods, cookie intentionally `httpOnly:false`),
seed the token **on the client** at app entry: if no `csrf_token` cookie exists,
generate a random high-entropy value and write it (`path=/`, `SameSite=Lax`,
`Secure` only on https), then always send it as the header. Replace any
`navigator.sendBeacon` to a CSRF-protected endpoint with `fetch(..., {keepalive:true})`
— sendBeacon cannot set custom headers, so it permanently 403s (`headerPresent:false`).

**Why:** In autoscale production the SPA's HTML is served by the **edge as a static
file** (response shows `last-modified`, `accept-ranges`, `cache-control:private`,
`Server: Google Frontend`), bypassing Express entirely. So the server's CSRF
middleware and any SPA-fallback `res.cookie(...)` never run on page load — the
cookie only gets set on the first `/api` response. A client that fires an unsafe
request before that first cookie-setting `/api` GET has no cookie → sends no header
→ silent 403. This blocked agents landing straight on the contract-signing screen.
The server only *seeds* the cookie when absent and only *checks* cookie===header,
so a client-generated matching pair passes and does not weaken the model.

**How to apply / diagnose:**
- Confirm the serving layer with `curl -D-`: `last-modified`/`accept-ranges` on the
  HTML + your app's `no-store` header absent ⇒ edge static, Express never sees it.
  Don't try to fix client-cookie races with server middleware in that case.
- Verify the cookie reaches the browser: `GET /` and a deep link should both carry
  the token. If only `/api` responses set it, you have the race.
- The CSRF reject path returns 403 **silently** — instrument it with a structured
  line (method/path/cookiePresent/headerPresent/match/userId/role/ua), never the
  token value. `cookiePresent:true,headerPresent:false` = sendBeacon / a caller that
  can't set headers; `cookiePresent:false` = the page-load seeding gap above.
- Asset `429 Too Many Requests` right after a deploy is usually transient autoscale
  cold-start/burst, not an app rate limiter — reproduce with concurrent GETs before
  treating it as a code bug (app limiters here only cover /api/public signing/onboarding).
