import { PDFDocument } from "pdf-lib";
import crypto from "crypto";
import { execSync } from "child_process";
import { documentShell } from "./contractRenderer";

interface BuildPdfParams {
  templateName: string;
  bodyHtml: string;
  signerEmail: string;
  signerName?: string | null;
  signerIp?: string | null;
  signerUserAgent?: string | null;
  signedAt: Date;
}

interface BuildPdfResult {
  pdfBytes: Uint8Array;
  evidenceHash: string;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Resolve the Chromium executable for headless PDF rendering.
 *
 * On Replit the browser binary is provided by Nix (`pkgs.chromium` in
 * replit.nix) rather than downloaded by Playwright, so we point
 * `playwright-core` at it explicitly. `.replit` exports
 * `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` (a nix-store path); if that is missing
 * we fall back to whatever `chromium` resolves to on PATH. Returning
 * `undefined` lets playwright-core try its own bundled lookup as a last resort.
 */
function resolveChromiumPath(): string | undefined {
  const fromEnv = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (fromEnv) return fromEnv;
  try {
    const found = execSync("which chromium", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (found) return found;
  } catch {
    /* fall through */
  }
  return undefined;
}

// The print-ready document shell that both the PDF and the on-screen signing
// preview share now lives in contractRenderer.ts (imported above) so the two
// render paths can never diverge. See documentShell there for details.

function evidencePageHtml(params: BuildPdfParams, evidenceHash: string): string {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 12px 6px 0;color:#64748b;white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td><td style="padding:6px 0;color:#0f172a;word-break:break-word;">${escapeHtml(value)}</td></tr>`;
  return `<section style="max-width:920px;margin:0 auto;padding:18px;font-size:12px;color:#0f172a;">
  <h1 style="font-size:20px;margin:0 0 6px;color:#143591;">Delil Sayfası / Evidence Page</h1>
  <p style="margin:0 0 18px;color:#475569;">Bu sayfa imzalanan sözleşmenin kriptografik delilini kaydeder. / This page records the cryptographic evidence for the signed contract.</p>
  <table style="width:100%;border-collapse:collapse;">
    ${row("İmzalayan / Signer", params.signerName || "-")}
    ${row("E-posta / Email", params.signerEmail)}
    ${row("IP adresi / IP address", params.signerIp || "-")}
    ${row("Tarayıcı / User agent", params.signerUserAgent || "-")}
    ${row("İmza zamanı (UTC) / Signed at", params.signedAt.toISOString())}
    ${row("Şablon / Template", params.templateName)}
  </table>
  <div style="margin-top:18px;">
    <div style="font-weight:600;margin-bottom:6px;">Delil özeti (SHA-256) / Evidence hash:</div>
    <div style="font-family:'DejaVu Sans Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;word-break:break-all;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;">${escapeHtml(evidenceHash)}</div>
  </div>
</section>`;
}

/**
 * SSRF guard: decide whether Chromium may fetch a subresource URL referenced by
 * the contract HTML (logo image, fonts, etc.). The document itself is supplied
 * via `setContent` (not fetched), so this only governs subresources.
 *
 * We allow inline `data:`/`blob:` payloads and public http(s) origins (the
 * templates legitimately load a remote brand logo), but block private,
 * loopback, link-local and cloud-metadata targets plus any non-web scheme so a
 * crafted URL can't turn PDF rendering into a server-side request primitive.
 */
function isBlockedSubresourceHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h === "metadata.google.internal") return true;
  if (h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10)
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  return false;
}

// Memory-minimizing launch args. See buildSignedPdf for the rationale behind
// each flag. Extracted here so both render calls use identical configuration.
const CHROMIUM_LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--font-render-hinting=none",
  "--single-process",
  "--no-zygote",
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--disable-extensions",
  "--disable-background-networking",
  "--mute-audio",
  // Defense-in-depth memory cap. --max-old-space-size / --max-semi-space-size
  // are V8 flags (NOT Chromium browser flags); passed directly as Chromium args
  // they are silently ignored. Routed through --js-flags they cap the browser
  // process's V8 heap so a runaway render makes Chromium's own V8 throw
  // "JavaScript heap out of memory" — failing the single render (caught + force-
  // closed below) instead of OOM-killing the 512MB autoscale container and
  // surfacing as an opaque edge-proxy 403. With --single-process the browser and
  // renderer share one process, so this cap applies to the whole Chromium heap.
  "--js-flags=--max-old-space-size=256 --max-semi-space-size=64",
];

/**
 * Render `html` to a PDF page using the supplied Chromium `browser`.
 *
 * The browser is NOT managed here — the caller (buildSignedPdf) owns its
 * lifecycle and must close it regardless of success/failure. This lets
 * buildSignedPdf force-close the browser on a render timeout, guaranteeing
 * memory is freed even when the underlying promise is still in flight.
 */
async function renderHtmlToPdf(browser: any, html: string): Promise<Uint8Array> {
  const page = await browser.newPage();
  try {
    await page.route("**/*", (route: any) => {
      const url = route.request().url();
      if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:")) {
        return route.continue();
      }
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return route.abort();
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return route.abort();
      }
      if (isBlockedSubresourceHost(parsed.hostname)) {
        return route.abort();
      }
      return route.continue();
    });
    try {
      await page.setContent(html, { waitUntil: "networkidle", timeout: 15000 });
    } catch {
      // A slow or blocked external asset can prevent networkidle from settling.
      // The DOM content is already in place, so render what loaded rather than
      // failing the whole signing flow.
      console.warn("[contractPdf] networkidle wait timed out; rendering current state");
    }
    const buf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
    return new Uint8Array(buf);
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Render the signer-facing HTML contract to a PDF that faithfully reproduces
 * the designed document (CSS, tables, colors, signature placement), then append
 * a tamper-evident evidence page.
 *
 * Rendering uses headless Chromium via `playwright-core`. The signer's drawn
 * signature is expected to already be embedded in `bodyHtml` (the caller injects
 * it into the template's `{{signature}}` placeholder), so this function does NOT
 * draw signatures separately — that is what kept the old pdf-lib text renderer
 * from matching the on-screen design.
 *
 * Two-pass evidence hash: pass 1 renders the contract content and computes
 * sha256(contentBytes || signerEmail || signerName || signedAtIso); pass 2
 * renders a human-readable evidence page printing that hash. The hash binds to
 * the content PDF (excluding the evidence page) exactly as before.
 */
// Hard ceiling on a single render. On expiry we throw, and the finally block
// below closes the browser — terminating the in-flight Chromium render so its
// memory is freed BEFORE the serialization lock (in signContract.ts) releases
// and the next render starts. Without this, a timed-out render would keep
// running in the background, overlap the next one, multiply RSS, and re-introduce
// the OOM that crashes the autoscale instance and surfaces as an opaque proxy
// "403 Forbidden". Normal renders finish in well under 10s.
const RENDER_TIMEOUT_MS = 30_000;
function renderWithTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export async function buildSignedPdf(params: BuildPdfParams): Promise<BuildPdfResult> {
  const { chromium } = await import("playwright-core");
  const executablePath = resolveChromiumPath();
  // Two separate short-lived Chromium browser instances are used — one for the
  // content page and one for the evidence page. Previously a single browser was
  // shared; with --single-process the Chromium renderer can crash after the
  // first page is generated, causing browser.newPage() to throw "Target page,
  // context or browser has been closed" on the evidence render.
  //
  // buildSignedPdf owns both browser handles. The finally block force-closes
  // whichever browser is still alive when a render timeout or any error fires,
  // so Chromium is never left running in the background after the render lock
  // is released. renderHtmlToPdf does NOT close the browser (it only closes the
  // page), keeping all lifecycle management in one place here.
  let browser1: any = null;
  let browser2: any = null;

  const renderStart = Date.now();
  const rssMb = () => Math.round(process.memoryUsage().rss / (1024 * 1024));
  console.log(`[contract-pdf] render start signer=${params.signerEmail} rss=${rssMb()}MB`);
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  const remainingMs = () => Math.max(1, deadline - Date.now());
  try {
    browser1 = await chromium.launch({ executablePath, args: CHROMIUM_LAUNCH_ARGS });
    const contentBytes = await renderWithTimeout(
      renderHtmlToPdf(browser1, documentShell(params.bodyHtml)),
      remainingMs(),
      "Contract PDF content render",
    );
    // Close browser1 before launching browser2 so the two browsers are never
    // alive simultaneously (keeps peak RSS bounded to one Chromium at a time).
    await browser1.close().catch(() => {});
    browser1 = null;

    const hasher = crypto.createHash("sha256");
    hasher.update(Buffer.from(contentBytes));
    hasher.update("|");
    hasher.update(params.signerEmail);
    hasher.update("|");
    hasher.update(params.signerName || "");
    hasher.update("|");
    hasher.update(params.signedAt.toISOString());
    const evidenceHash = hasher.digest("hex");

    browser2 = await chromium.launch({ executablePath, args: CHROMIUM_LAUNCH_ARGS });
    const evidenceBytes = await renderWithTimeout(
      renderHtmlToPdf(browser2, documentShell(evidencePageHtml(params, evidenceHash))),
      remainingMs(),
      "Contract PDF evidence render",
    );

    // Merge content + evidence into a single document. pdf-lib copies page
    // content faithfully, preserving the Chromium-rendered vector/text output.
    const merged = await PDFDocument.create();
    const contentDoc = await PDFDocument.load(contentBytes);
    const evidenceDoc = await PDFDocument.load(evidenceBytes);
    const contentPages = await merged.copyPages(contentDoc, contentDoc.getPageIndices());
    contentPages.forEach((p) => merged.addPage(p));
    const evidencePages = await merged.copyPages(evidenceDoc, evidenceDoc.getPageIndices());
    evidencePages.forEach((p) => merged.addPage(p));
    const pdfBytes = await merged.save();

    console.log(`[contract-pdf] render done signer=${params.signerEmail} ms=${Date.now() - renderStart} rss=${rssMb()}MB`);
    return { pdfBytes, evidenceHash };
  } catch (err) {
    console.error(`[contract-pdf] render failed signer=${params.signerEmail} ms=${Date.now() - renderStart} rss=${rssMb()}MB:`, err);
    throw err;
  } finally {
    // Force-close any browser still alive. This is the critical path for
    // timeout scenarios: renderWithTimeout rejects and buildSignedPdf throws,
    // but the underlying renderHtmlToPdf promise may still be running inside
    // Chromium. Closing the browser here terminates the Chromium process
    // immediately, bounding peak memory before the render lock is released.
    if (browser1) await browser1.close().catch(() => {});
    if (browser2) await browser2.close().catch(() => {});
  }
}
