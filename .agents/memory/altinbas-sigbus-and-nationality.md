---
name: Altınbaş SIGBUS fix and mapCountry null contract
description: SIGBUS (exit 135) root cause in Chromium + mapCountry string|null contract change
---

## SIGBUS (exit 135) — root cause and fix

`--disable-dev-shm-usage` was already present but was NOT sufficient.
Chromium's zygote process spawns BEFORE the dev-shm flag propagates to
renderer IPC mappings — the zygote still creates shared-memory regions used
for forking renderers. In RAM-constrained containers this triggers SIGBUS
(signal 7, exit code 135) in the Chromium subprocess or (when the signal
propagates) in the Node worker process itself.

**Fix:** Added to `MEM_ARGS` in `lib/portal-adapters/src/browser.ts`:
- `--no-zygote` — disables the zygote process entirely; renderers are spawned
  without shared-memory forking.
- `--disable-setuid-sandbox` — prevents sandbox helper from requesting setuid
  (another SIGBUS path in our container security model).

These flags apply to ALL portal adapters via the shared browser.ts.

**Worker crash recovery (already in place):**
- `worker.ts` has `uncaughtException` + `unhandledRejection` handlers that
  keep the loop alive for Playwright-thrown errors (non-fatal crashes).
- Stale-lock recovery (`releaseStale`, default 5 min) re-queues submissions
  if the Node process itself dies. Do NOT lower WORKER_STALE_MS below 60s.

## mapCountry — null contract (not "")

`mapCountry()` in `flow-fields.ts` now returns `string | null`:
- `null` only when input is empty/missing/whitespace.
- `string` (canonical portal name) when found in the extended map.
- `string` (title-cased raw + `console.warn`) for unknown values.

**Why:** The previous `|| "Turkey"` fallback in `buildPersonalFields` silently
submitted wrong nationality data for students with blank nationality fields.
3,709 prod students were affected. The fix throws `MISSING_NATIONALITY` instead.

**COUNTRY_EN_MAP now handles 3 input conventions:**
1. Adjective / demonym form: "Pakistani" → "Pakistan" (legacy CRM)
2. Country name (lowercase): "pakistan" → "Pakistan" (prod DB norm)
3. ISO alpha-2: "tr" → "Turkey" (seen in prod)

**How to apply:**
- Any call site that was using `mapCountry(x) || "some default"` is now
  a type error (`string | null` can't feed `||` expecting `string`).
  Replace with: `const c = mapCountry(x); if (c === null) throw ...`
- If you add a new adapter that maps nationality, start from the existing
  COUNTRY_EN_MAP (all 3 conventions) rather than building your own.
