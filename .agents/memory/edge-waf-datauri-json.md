---
name: Edge WAF blocks large data: URIs in JSON bodies
description: Why a POST can return an opaque HTML 403 with no app log when its JSON payload contains a data: URI — and the fix.
---

# Edge WAF blocks `data:` URIs in JSON request bodies

A JSON request body containing a `data:...;base64,<...>` URI larger than ~4 KB is
blocked by the Replit Autoscale edge/WAF with an **opaque HTML 403** *before* the
request reaches Express. Verified by live bisect: a data URI of ~4066 chars passes,
~4074 chars is blocked; **bare base64 passes even at ~200,000 chars**.

**Symptom:** a state-changing POST returns `403` with an **HTML** body, and there is
**no corresponding app/Express log** (because the request never arrived). Easy to
mis-diagnose as auth/CSRF/OOM. The agent contract-sign flow hit exactly this because
the canvas signature was sent as `canvas.toDataURL("image/png")` (a full data URL)
inside the JSON body.

**Fix / rule:**
- Client: always strip the `data:...;base64,` prefix and send **bare base64**
  (`toDataURL(...).split(",")[1]`, or slice after the first comma) for any
  canvas/image value posted as JSON.
- Server: defensively re-strip a leading `data:image/...;base64,` and validate the
  decoded bytes — PNG magic `89 50 4E 47 0D 0A 1A 0A` else 400, and a size cap
  (≤2 MB decoded) else 400. A prior bug let `"AAAA"` through and corrupted a signed
  contract record, which is why validation lives in the shared sign service, not just
  the route.

**Why:** the WAF is outside our control; the only reliable mitigation is to never
ship large `data:` URIs in JSON. **How to apply:** whenever you see a POST 403 with
an HTML body and no Express log, check the payload for a `data:` URI first.

**Note:** this is distinct from the autoscale *heavy-render* 403 (sync Chromium/OOM
crash → edge HTML 403). Both produce an opaque HTML 403 with no clean app error, but
this one is a payload-shape block, not a crash.
