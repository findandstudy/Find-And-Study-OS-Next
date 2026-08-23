---
name: Main-agency seal + contract number/filename in final signed PDF
description: Why the Ana Acente seal and the contract number live only in the final signed PDF, and how the body number and download filename share one source
---

The contract template has two signature boxes: {{signature}} = alt acente (sub-agent
signer input) and {{main_agency_signature}} = ana acente (Find And Study kaşe+imza).

**Rule 1 — seal only in the final PDF:** the main-agency seal appears ONLY in the
final, post-signature PDF — never in preview or signing-screen renders.

**Why:** preview/sign renders happen before signing; leaking the seal there (or an
empty `<img src="">` broken icon) is wrong. The seal is server-stamped after signing.

**Rule 2 — ONE final render path:** all signed-PDF producers (sign-time delivery
worker, legacy backfill sweep, admin force-regenerate) must funnel through a single
shared renderer so neither the seal nor the contract number can be present on one
path and missing on another. Mirroring the injection inline per-caller is how they
silently drift (a sign-time PDF lost the seal while regenerate had it).

**Rule 3 — body number == filename number:** the value rendered into
{{contract_number}} and the value used for the download Content-Disposition filename
must come from the SAME function, or they drift. Filename pattern:
`<contract_number>_signed.pdf` (e.g. `FAS-2026-00025_signed.pdf`). There are THREE
download routes that must all use it: admin, public-token, and the agent-portal
(`/api/contracts/me/pdf`) — it's easy to miss the third. Use an identical
signedAt→createdAt fallback in all three so the year can't differ per route.

**How to apply:**
- buildAgentContext defaults main_agency_signature to "" → every preview path stays
  empty automatically; do NOT set it there.
- The single final renderer builds the ctx, sets ctx.signature, sets
  ctx.main_agency_signature (inlined base64 data URL, never a fetch), and passes the
  contract number; the PDF finalizer calls only this. cleanupSignatureImages collapses
  an empty box to a styled placeholder via the img's alt label.
- The contract number is deterministic from the signing session id + sign year (no DB
  lookup), so it is stable across re-renders.

**Regenerate an already-rendered contract (idempotent cache bypass):**
The finalizer early-returns when pdfObjectKey+evidenceHash are set, so a renderer
change never reaches old contracts. Admin regenerate endpoint NULLs
pdfObjectKey+evidenceHash+deliveryClaimedAt and returns 202; the backfill worker
(pdfObjectKey IS NULL AND emailedAt IS NOT NULL) re-renders OFF the request path.
Never render synchronously in the endpoint (autoscale Chromium-in-request OOM →
opaque edge 403). emailedAt is untouched → no notification re-send.
