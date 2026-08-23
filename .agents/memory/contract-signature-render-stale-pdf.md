---
name: Contract signature renders as a broken-image icon in the signed PDF
description: Why a signed contract PDF shows a broken signature icon and how to actually fix it (it is almost never a renderer bug)
---

# Broken signature icon in the signed contract PDF

Signatures are stored **bare base64** (no `data:` prefix) in the DB
(`signed_contracts.signature_image_base64`). The PDF render path already wraps it
into a `data:image/png;base64,...` URL via `toSignatureDataUrl()` in
`contractRenderer.ts` (applied at the `ctx.signature = ...` line in
`ensureSignedContractPdf`). So a broken `<img>` in a live PDF is almost never a
missing-prefix renderer bug.

The two real causes:
1. **Stale cached PDF.** `ensureSignedContractPdf` is idempotent — it returns
   early once `pdf_object_key` + `evidence_hash` are set and **never
   regenerates**. A PDF rendered before a fix (or from a corrupt signature) stays
   broken forever. To force a fresh render you must clear the row's
   `pdf_object_key` + `evidence_hash` (then next download regenerates) **or**
   re-sign.
2. **Corrupt source signature.** If `signature_image_base64` is garbage (the
   classic prod incident stored the literal `"AAAA"`, 4 chars, decodes to
   `00 00 00` — not PNG), there is **no real signature to render**. Regenerating
   the PDF cannot help; the agent must **re-sign** (revoke/resend the session so a
   new, validated signature is captured).

**How to diagnose (prod is read-only via executeSql):** check the *active* row for
the session — `length(signature_image_base64)`, `signature_image_base64 LIKE
'iVBORw0KGgo%'` (base64 of the PNG magic). A short length / false magic = corrupt
source → re-sign, not regen. There is a unique index on `signing_session_id`, so
a session has exactly one signed_contract row (no "#3 vs #4" duplicates unless one
was deleted).

**Canonical rule:** DB + API carry bare base64; build the `data:` URL only at the
render/display point (`toSignatureDataUrl`, idempotent for legacy data-URL rows).
Never write the data-URL form back to the DB.

## The deeper cause: agents.contract_url locks to the FIRST contract

`agents.contract_url` is hydrated lazily in `ensureSignedContractPdf` on the first
PDF render. The original guard `.where(... isNull(agentsTable.contractUrl))` meant
the URL was set **once and never updated**. So when an agent **re-signs** (a
"resend" creates a brand-new `signing_sessions` row + a new `signed_contracts`
row), the new contract's render became a no-op and the agent stayed pointed at the
**stale/broken** earlier PDF. This is the real reason the portal kept showing the
broken `contract-23.pdf` even after a valid re-sign produced a good
`contract-24.pdf`.

**Fix:** gate the hydration on "is this row the agent's *newest* signed_contract"
(`ORDER BY signed_at DESC, id DESC LIMIT 1`), then update without the `isNull`
guard. A re-sign now wins; a late download of an OLD contract's PDF won't clobber
the URL back to a superseded contract. This fix only auto-corrects an agent on the
**next** render of their newest contract — because rendering is idempotent, an
already-rendered newest contract won't re-run, so an agent stuck on an old URL
still needs a one-off `UPDATE agents SET contract_url = <newest pdf url>`.

**Resend creates a NEW session, not a reused one:** don't scope diagnosis to a
single session id. A "missing #N" record is usually on the newer session — query
`signed_contracts ORDER BY id DESC` across ALL sessions before concluding data
loss. A 200 + "Contract.Signed #N" activity with "no row" almost always means you
looked at the wrong session. The resend session is typically
`isPrimaryOnboarding=false`.

## Read-time resolution is required (the write-time fix alone is not enough)

The lazy `contract_url` write-time fix only self-corrects on the NEXT render of the
newest contract — but renders are idempotent, so an already-rendered newest
contract never re-runs, leaving the agent stuck on the old URL. And the
agent-facing endpoints had their OWN staleness:
- `GET /api/agents/me` returned the stored `agents.contract_url` verbatim.
- `GET /api/contracts/me` selected only the PRIMARY onboarding session
  (`loadOnboardingSession` = newest where `isPrimaryOnboarding=true`), so a resend
  session was invisible.
- `GET /api/contracts/me/pdf` streamed the primary session's PDF.

**Fix:** a single read-time resolver in `signContract.ts`
(`loadNewestSignedContractForAgent` / `getNewestSignedContractUrl`, ordered by
`signed_at DESC, id DESC`) used by all three endpoints. `/agents/me` overrides
`contractUrl` (falling back to the stored value so manual URLs and not-yet-rendered
PDFs survive); `/contracts/me` surfaces a strictly-newer signed session when the
primary is already signed; `/contracts/me/pdf` streams the newest. This fixes the
LIVE read path without any prod DB write — the prod data row can stay as-is.

## Generic object ACL must not depend on agents.contractUrl for signed PDFs

After the read-time resolver pointed `/agents/me` at the NEWEST signed PDF, the
download itself 403'd: the frontend fetches the PDF via the generic
`GET /api/storage/objects/*path` route, whose authorizer (`canAccessGenericObject`
in `objectAuthz.ts`) reached signed-contract PDFs ONLY through the
`agents.contractUrl` reference rule. That column is stale (locked to the earlier
contract after a resend, and we can't write prod), so the old contract returned
200 while the new one returned 403 "Access denied" — *for the same logged-in
agent*. `object_owners` doesn't help either: server-generated PDFs are never
bound to a user uploader, so the uploader rule never fires.

**Rule added (section 2b):** authorize signed PDFs directly against the
`signed_contracts` ledger — if the requested key matches any
`signed_contracts.pdf_object_key`, grant to admins or the owning agent (via
`getAgentVisibleIds`, which includes the agent's own id + sub-agents). Safe from
IDOR because `pdf_object_key` is server-written only (like the agent trust-doc
rule), never user-writable. This lets an agent download ANY of their own signed
contracts (old or new) regardless of which one `agents.contractUrl` currently
points at. **Why:** an agent accumulates multiple signed contracts over time; the
single `contractUrl` pointer cannot gate all of them.

**Note:** the unsigned-preview render paths (publicSigning preview,
agentOnboarding preview) intentionally leave `signature`/`main_agency_signature`
empty; `cleanupSignatureImages` swaps an empty `<img src="">` for a styled
placeholder box, reusing the `<img alt=...>` text as the label when present, else
the per-language `SIG_PLACEHOLDER`.
