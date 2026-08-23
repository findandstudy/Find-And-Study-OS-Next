---
name: Self-fill / contract link shows localhost
description: Why admin-copied signing links can be http://localhost:5000 and how the frontend must rebuild them
---

Admin-created self-fill / contract signing links displayed as `http://localhost:5000/sign/<token>` instead of the real domain.

**Root cause:** the server builds `signUrl = ${getAppBaseUrl()}/sign/<token>` (api-server contracts.ts). `getAppBaseUrl()` (api-server/src/lib/email.ts) priority is APP_BASE_URL → REPLIT_DOMAINS → REPLIT_DEPLOYMENT_URL → REPLIT_DEV_DOMAIN → `http://localhost:5000` (last resort). If a request is served before the domain env vars are injected at process boot, it falls through to the localhost default; the value is then copied/emailed verbatim.

**Fix / rule:** any admin-facing UI that displays or copies a server-returned signing/share URL must rebuild it against `window.location.origin` (swap ONLY the origin, keep path+query). `SelfFillLinks.tsx` has `toBrowserSignUrl()` used by both create() and resend(). The `/sign/:token` route lives at origin root (wouter matches `spaPath.startsWith("/sign/")` regardless of BASE_URL), so `origin + pathname` is always correct.

**Why:** the copied/shared link must work on the exact domain the admin is browsing, independent of server-env boot timing. Restarting api-server also fixes freshly-emailed links (getAppBaseUrl then resolves REPLIT_DOMAINS), but the client rebuild is the durable guarantee.

**How to apply:** emailed links stay server-side (getAppBaseUrl, correct once env present); the DISPLAYED/COPIED link is a pure client concern — never show a raw server signUrl to the admin.
