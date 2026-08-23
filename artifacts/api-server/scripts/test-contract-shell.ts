/**
 * Shared-document-shell regression suite.
 *
 * Task #577 moved documentShell() out of contractPdf.ts into
 * contractRenderer.ts so ONE shell now wraps BOTH:
 *   - the final, legally-signed PDF (contractPdf.buildSignedPdf, print media)
 *   - the in-browser signing review preview (publicSigning /preview and the
 *     agent-onboarding endpoints, rendered in a sandboxed <iframe>, screen media)
 *
 * To make the on-screen preview look like a printed A4 page, documentShell adds
 * an `@media screen { ... }` block (page width, centering, white background).
 * Playwright page.pdf() emulates PRINT media, so that block MUST stay inert for
 * the PDF. Nothing guarded that invariant — a future edit could drag the
 * screen-only chrome out of the @media block and silently reflow every
 * legally-signed PDF. These are pure unit + source-wiring checks (no DB, no
 * headless Chromium), so they are safe to run in CI.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server exec tsx --test ./scripts/test-contract-shell.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { documentShell, cleanupSignatureImages, renderTemplate, buildAgentContext } from "../src/lib/contractRenderer";

// A deliberately style-heavy contract body: a custom <style> block, inline
// styles, and a bordered table — exactly the kinds of markup the old
// prose-div + DOMPurify preview used to strip.
const STYLE_HEAVY_BODY = `
<style>.contract-title{color:#b91c1c;font-weight:800;text-transform:uppercase}</style>
<h1 class="contract-title">Danışmanlık Sözleşmesi</h1>
<p style="font-style:italic;color:#334155;margin:0 0 8px">Taraflar arasında imzalanmıştır.</p>
<table style="width:100%;border:1px solid #000">
  <thead><tr><th style="border:1px solid #000;padding:4px">Madde</th><th style="border:1px solid #000">Açıklama</th></tr></thead>
  <tbody><tr><td style="padding:4px">1</td><td>Ödeme koşulları</td></tr></tbody>
</table>`;

/**
 * Slice the balanced `@media screen { ... }` block out of the shell, returning
 * both the block itself and the shell WITHOUT it. The "without" string is what
 * a print-media consumer (PDF) effectively sees, since @media screen never
 * applies to print. Uses brace counting because the block nests `html {}` /
 * `body {}` rules, which a lazy regex would mis-terminate.
 */
function splitMediaScreen(shell: string): { block: string; withoutScreen: string } {
  const marker = "@media screen";
  const start = shell.indexOf(marker);
  assert.notEqual(start, -1, "documentShell must contain an @media screen block");
  const braceStart = shell.indexOf("{", start);
  let depth = 0;
  let end = braceStart;
  for (; end < shell.length; end++) {
    const ch = shell[end];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { end++; break; }
    }
  }
  assert.equal(depth, 0, "@media screen block must have balanced braces");
  return {
    block: shell.slice(start, end),
    withoutScreen: shell.slice(0, start) + shell.slice(end),
  };
}

const shell = documentShell(STYLE_HEAVY_BODY);

test("documentShell returns a single, complete HTML document", () => {
  assert.ok(shell.startsWith("<!doctype html>"), "must start with a doctype");
  assert.match(shell, /<html[^>]*>/i);
  assert.match(shell, /<head>[\s\S]*<\/head>/i);
  assert.match(shell, /<body>[\s\S]*<\/body>/i);
  assert.ok(shell.trimEnd().endsWith("</html>"), "must close the html element");
  // Exactly one document wrapper — no accidental double-wrapping.
  assert.equal(shell.match(/<!doctype html>/gi)?.length, 1);
  assert.equal(shell.match(/<html/gi)?.length, 1);
});

test("documentShell embeds arbitrary body content verbatim (no sanitizing/stripping)", () => {
  // The template's own <style>, inline styles, and table survive untouched.
  assert.ok(shell.includes(".contract-title{color:#b91c1c"), "custom <style> block preserved");
  assert.ok(shell.includes('style="font-style:italic;color:#334155'), "inline styles preserved");
  assert.ok(shell.includes("<table style=\"width:100%;border:1px solid #000\""), "table + inline border preserved");
  assert.ok(shell.includes("Danışmanlık Sözleşmesi"), "unicode text preserved");
  // The body is inserted between <body> and </body> exactly as given.
  assert.ok(shell.includes(`<body>${STYLE_HEAVY_BODY}</body>`), "body inserted verbatim");
});

test("PDF (print media) layout carries the @page rule and base typography", () => {
  const { withoutScreen } = splitMediaScreen(shell);
  // These rules apply to the printed PDF and MUST remain outside @media screen.
  assert.match(withoutScreen, /@page\s*\{\s*size:\s*A4;\s*margin:\s*14mm 10mm;\s*\}/);
  assert.ok(withoutScreen.includes("print-color-adjust: exact"), "print color fidelity kept");
  assert.ok(withoutScreen.includes("font-size: 12px"), "base body typography kept");
  assert.ok(withoutScreen.includes("border-collapse: collapse"), "table reset kept for PDF");
});

test("screen-only page chrome is quarantined inside @media screen — inert for the PDF", () => {
  const { block, withoutScreen } = splitMediaScreen(shell);
  // The A4-page-simulation chrome lives ONLY inside @media screen...
  assert.ok(block.includes("max-width: 210mm"), "page width is screen-only");
  assert.ok(block.includes("margin: 0 auto"), "page centering is screen-only");
  assert.ok(block.includes("padding: 14mm 10mm"), "screen page padding is screen-only");
  assert.ok(block.includes("#f1f5f9"), "grey page backdrop is screen-only");
  assert.ok(block.includes("#ffffff"), "white page surface is screen-only");
  // ...and is completely ABSENT from what a print/PDF consumer sees. This is
  // the core guard: dragging any of these out of @media screen would change
  // the legally-signed PDF's layout, and this test would fail.
  assert.ok(!withoutScreen.includes("210mm"), "page width must NOT reach print media");
  assert.ok(!withoutScreen.includes("margin: 0 auto"), "centering must NOT reach print media");
  assert.ok(!withoutScreen.includes("#f1f5f9"), "grey backdrop must NOT reach print media");
});

test("preview HTML and signed-PDF input HTML share the identical shell wrapper", () => {
  // Reproduce the exact pipeline the /public/sign/:token/preview endpoint runs:
  //   documentShell(cleanupSignatureImages(renderTemplate(body, ctx), placeholder))
  // The final PDF runs documentShell(bodyHtml) too, so the only permitted
  // differences are the inner body (signatures/seal) and the media type the
  // browser applies — never the shell chrome itself.
  const ctx = buildAgentContext({ businessName: "Örnek Acente", email: "a@b.com" }, null, {});
  const previewInner = cleanupSignatureImages(renderTemplate(STYLE_HEAVY_BODY, ctx), "");
  const previewHtml = documentShell(previewInner);
  const pdfHtml = documentShell(previewInner);
  assert.equal(previewHtml, pdfHtml, "same inner body ⇒ byte-identical wrapped document");
  // Everything outside <body> (the shell chrome: <head>, <style>, @page,
  // @media screen) must be byte-identical between the two documents.
  const chromeOf = (html: string) => html.slice(0, html.indexOf("<body>")) + html.slice(html.indexOf("</body>"));
  assert.equal(chromeOf(previewHtml), chromeOf(pdfHtml));
});

test("all shell consumers still route through the shared documentShell", () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

  // The PDF renderer wraps the contract body (and the evidence page) via the
  // shared shell imported from contractRenderer — not a private copy.
  const contractPdf = read("../src/lib/contractPdf.ts");
  assert.match(contractPdf, /import\s*\{[^}]*documentShell[^}]*\}\s*from\s*["']\.\/contractRenderer["']/);
  assert.ok(contractPdf.includes("documentShell(params.bodyHtml)"), "buildSignedPdf wraps the contract body");

  // The public signing preview endpoint returns a full document from the shell.
  const publicSigning = read("../src/routes/publicSigning.ts");
  assert.match(
    publicSigning,
    /documentShell\(applyContractBranding\(\s*cleanupSignatureImages\(/,
    "public /preview applies canonical branding inside the shared shell",
  );

  // The agent-onboarding preview endpoints (Task #578) route through it too.
  const agentOnboarding = read("../src/routes/agentOnboarding.ts");
  assert.ok(
    (agentOnboarding.match(/documentShell\(cleanupSignatureImages\(/g)?.length ?? 0) >= 2,
    "both agent-onboarding preview endpoints wrap via shell",
  );
});
