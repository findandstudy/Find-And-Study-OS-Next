---
name: Contract PDF rendering
description: How signed/preview contract PDFs are produced and why they must use headless Chromium, not pdf-lib text.
---

# Contract PDF rendering

Contract templates (`contract_templates.body_html`) are authored explicitly for
**browser-to-PDF** rendering: they carry their own `<style>` blocks, CSS
variables, flexbox, tables, brand colors, `print-color-adjust:exact`, a remote
brand logo `<img>`, and signature placeholders rendered as
`<img src="{{signature}}">` / `{{main_agency_signature}}` / `{{sign_date}}`.

**Rule:** the signed PDF and the preview PDF must render the real template HTML
via headless Chromium (`playwright-core` + the Nix `pkgs.chromium`, resolved from
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` with a `which chromium` fallback). Do NOT
strip the HTML to text blocks and redraw with pdf-lib — that destroys all
CSS/tables/colors/layout and was the original "PDF doesn't match what the signer
sees" bug.

**Why:** every render path (`finalizeSign`, public-sign POST, public preview-pdf)
flows through `buildSignedPdf`. The signer's drawn signature must be injected
into the template's `{{signature}}` placeholder at context-build time (normalize
to a `data:image/png;base64,` URL) so it lands in the designed signature box;
remaining unfilled signature `<img>`s are swapped by `cleanupSignatureImages`.

**How to apply:**
- `playwright-core` is an api-server dependency kept **external** in `build.ts`
  (not in the esbuild allowlist) so it loads from `node_modules` at runtime.
- Chromium subresource fetches are an SSRF surface. `renderHtmlToPdf` installs a
  `page.route` filter: allow `data:`/`blob:`/`about:` and public http(s); block
  loopback/private/link-local/CGNAT IPs, cloud-metadata (169.254.169.254 /
  metadata.google.internal) and non-web schemes. The public brand logo
  (findandstudy.com) must stay allowed.
- `setContent` uses `waitUntil:"networkidle"` wrapped in try/catch so a slow or
  blocked asset renders the loaded DOM instead of failing the signing.
- Evidence hash is two-pass: sha256(content PDF bytes + signerEmail + signerName
  + signedAtIso), then a separately-rendered evidence page is merged via pdf-lib.
  Hash binds to content only (excludes the evidence page).
- Cold render is ~7-8s (browser launch per call); acceptable for an infrequent
  signing action.
