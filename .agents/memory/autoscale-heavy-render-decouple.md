---
name: Autoscale heavy render → HTML 403
description: Heavy synchronous CPU/Chromium work in the request path crashes autoscale instances; symptom is a raw HTML 403 from the edge, not app JSON. Decouple it.
---

# Heavy synchronous render in the autoscale request path crashes the instance

When a request handler does heavy synchronous work (headless Chromium PDF render,
big image processing, large in-memory transforms), it can OOM/CPU-crash the
autoscale instance **mid-request**. The Replit edge then returns a raw HTML
`403 Forbidden` page (NOT application JSON) to the client, and there are **no app
logs** for the failed request because the process died before logging.

**Why:** autoscale instances are memory/CPU constrained; a Chromium render inside
the agent contract sign request was crashing the instance only in production
(worked in dev). Tell-tale signs: works in dev, fails only in prod; HTML 403 (not
JSON) at the client; no app-side error log; the DB row stays in its pre-action
state (e.g. session never flips to "signed"); ECONNRESET afterward.

**How to apply:** keep the hot request path free of heavy renders. Persist only
the minimal inputs (e.g. the signature image + a status flip) and return fast,
then generate the heavy artifact **lazily on first access** (or in a background
job). Make the lazy generator idempotent with a compare-and-set DB update
(`WHERE ... AND pdf_object_key IS NULL`) so concurrent first-accesses don't both
render, and **fail hard** (no silent empty/placeholder output) when a required
input can't be read — otherwise you persist a bogus artifact as if valid.
Note: a second inline sign handler in `publicSigning.ts` (public self-fill links)
still renders synchronously — same latent crash risk, left out of the agent-flow fix.
