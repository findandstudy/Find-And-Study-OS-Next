---
name: Contract PDF render → opaque 403 (Autoscale)
description: Why headless-Chromium PDF renders crash the Autoscale deployment and surface as an opaque proxy 403, and why post-response fire-and-forget rendering is forbidden on Autoscale.
---

# Heavy PDF render on Autoscale = opaque edge-proxy 403

The edcons deployment is **Autoscale** (`deploymentTarget = "autoscale"` in
`.replit`). Two hard constraints drive this whole bug class:

1. **Memory-constrained instances.** A headless-Chromium PDF render
   (`buildSignedPdf`, ~15s, large RSS) can exceed the instance memory and
   OOM-kill the process. A crashed/recycled instance makes the Replit edge proxy
   return its own opaque `<!doctype html>...403 Forbidden` page — NOT one of the
   app's JSON 403s. App 403s are always JSON; an HTML 403 is the proxy, the
   instance is dead/unhealthy. Once an instance is crash-looping, EVERY request
   to it 403s — including `POST /api/contracts/me/sign`, even though sign itself
   does no rendering.

2. **No reliable background execution.** Autoscale freezes/recycles the instance
   after the HTTP response is sent. Fire-and-forget work scheduled after the
   response (e.g. a "pre-warm" Chromium render kicked off at the end of
   `finalizeSign`) is NOT supported — it destabilizes the instance and made the
   sign POST itself surface as a proxy 403. **Never** start a post-response
   background Chromium render on Autoscale. (This was tried as a "fix" and was
   itself the regression — it ran Chromium after every sign and crash-looped prod.)

## Rules
- Sign hot path stays lightweight: signature upload + DB commit only. No Chromium.
- Render the PDF **lazily, INSIDE the download request** via
  `ensureSignedContractPdf()` so the work completes within a request (the only
  execution model Autoscale supports). All download callers
  (`/contracts/me/pdf`, admin `/contracts/signed/:id/pdf`, public
  `/sign/:token/pdf`) route through it.
- `withRenderLock` (in-process promise-chain mutex) serializes renders so at most
  ONE Chromium runs at a time per instance — kills the concurrent-render OOM
  multiplier. `ensureSignedContractPdf` re-checks the stored `pdfObjectKey`
  inside the lock so concurrent downloads of the same contract skip redundant work.
- Chromium launch args matter for RSS: beyond `--no-sandbox` /
  `--disable-dev-shm-usage`, add `--single-process` + `--no-zygote` (collapse
  Chromium's multi-process model — the single biggest RSS cut for short-lived
  HTML→PDF) plus `--disable-gpu` / `--disable-software-rasterizer` /
  `--disable-extensions` / `--disable-background-networking` / `--mute-audio`.
  These do NOT guarantee no OOM, but meaningfully lower the per-render peak so a
  render is far less likely to collateral-kill a concurrent sign POST. Safe here
  because each browser renders one doc then closes, and renders are bounded by a
  30s timeout + `browser.close()` in finally + `withRenderLock` serialization.

## Diagnosing
- Dev has generous memory and hides the OOM — sign + download both return 200 in
  dev. Reproduction in dev will NOT show the production 403. Trust the
  Autoscale-memory hypothesis over a dev repro.

## Residual risk / real fix
- The in-process lock bounds concurrency, not a single render's peak memory. If a
  single render still OOMs the Autoscale instance (PDF viewing crash-loops prod),
  the durable fix is a **Reserved VM deployment** (persistent, more memory,
  supports real background workers) or out-of-process rendering — not more
  in-process tricks.
