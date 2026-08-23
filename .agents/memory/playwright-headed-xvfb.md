---
name: Playwright headed launch needs a display (Xvfb) or falls back to headless
description: Why UI portal adapters (Topkapı/Altınbaş) crashed "Missing X server" on the auto worker, and the env-driven headed/headless contract in browser.ts.
---

# Headed Chromium requires an X display; server workers have none

`lib/portal-adapters/src/browser.ts` `launchPortal()` is the SINGLE launch point
for every UI portal adapter (Topkapı, Altınbaş, United, etc.). SIT is unaffected
(webhook/GraphQL replay, no full browser).

**Contract (env-driven, never patch via deploy-time `sed`):**
- Default headless. Headed ONLY when `PW_HEADFUL=1` AND `DISPLAY` is set.
- A headed launch that throws an X-server error (`Missing X server` / `$DISPLAY`
  / `headed browser`) falls back to headless instead of hard-crashing; other
  errors rethrow.

**Why:** an older deploy step ran `sed 's/headless: true/headless: false/g'`
on browser.ts to force headed. Headed Chromium needs a real/virtual screen.
Manual tests wrapped the command in `xvfb-run` (so they worked), but the pm2
auto/queue worker had no `DISPLAY` → headed launch crashed at startup. Symptom:
"some submissions go through, some fail" = manual (xvfb) succeed, automatic
(no xvfb) crash. The `sed` also re-broke the file on every deploy.

**How to apply:** to keep headed behavior (bot-evasion), the VPS must run the
worker under a persistent Xvfb (`DISPLAY=:99 PW_HEADFUL=1`, pm2) — that's infra,
user-handled. The code fallback is the safety net: if Xvfb dies the worker
degrades to headless, never stalls the queue. Do NOT reintroduce the deploy
`sed`; headed/headless is env-only now.
