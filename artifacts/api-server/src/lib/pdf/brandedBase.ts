import { db, settingsTable } from "@workspace/db";

export interface BrandedPdfSettings {
  companyName?: string | null;
  pdfLogoUrl?: string | null;
  pdfPrimaryColor?: string | null;
  pdfAccentColor?: string | null;
  pdfSealImageUrl?: string | null;
  pdfFooterText?: string | null;
  pdfHeaderText?: string | null;
  pdfWatermarkText?: string | null;
  pdfSignatureLabel?: string | null;
}

export async function loadBrandedPdfSettings(): Promise<BrandedPdfSettings> {
  const [row] = await db.select({
    companyName: settingsTable.companyName,
    pdfLogoUrl: settingsTable.pdfLogoUrl,
    pdfPrimaryColor: settingsTable.pdfPrimaryColor,
    pdfAccentColor: settingsTable.pdfAccentColor,
    pdfSealImageUrl: settingsTable.pdfSealImageUrl,
    pdfFooterText: settingsTable.pdfFooterText,
    pdfHeaderText: settingsTable.pdfHeaderText,
    pdfWatermarkText: settingsTable.pdfWatermarkText,
    pdfSignatureLabel: settingsTable.pdfSignatureLabel,
  }).from(settingsTable);
  return row ?? {};
}

const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1$|0\.0\.0\.0|fd[0-9a-f]{2}:|fc[0-9a-f]{2}:)/i;

async function fetchAsDataUri(rawUrl: string | null | undefined): Promise<string | null> {
  if (!rawUrl) return null;
  try {
    let url: string;
    if (rawUrl.startsWith("http")) {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== "https:") return null;
      if (PRIVATE_HOST_RE.test(parsed.hostname)) return null;
      url = rawUrl;
    } else {
      const port = process.env.PORT || "3001";
      url = `http://localhost:${port}${rawUrl}`;
    }
    const resp = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    const ct = resp.headers.get("content-type") || "image/png";
    if (!ct.startsWith("image/")) return null;
    return `data:${ct};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

function esc(s: string | null | undefined): string {
  // Decode the few named HTML entities that leak into report text (dashes,
  // separators) to their real glyphs BEFORE escaping, so they render as
  // "—"/"–" instead of literal "&mdash;"/"&ndash;" in the PDF (Job I).
  const decoded = (s ?? "")
    .replace(/&mdash;/g, "\u2014")
    .replace(/&ndash;/g, "\u2013")
    .replace(/&middot;/g, "\u00b7")
    .replace(/&nbsp;/g, " ");
  return decoded.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface BuildBrandedHtmlOptions {
  title: string;
  subtitle?: string;
  body: string;
  settings: BrandedPdfSettings;
  logoBuri?: string | null;
  sealUri?: string | null;
  /** BCP-47 locale tag used to format the "Generated" timestamp. */
  locale?: string;
}

export async function resolveBrandedAssets(s: BrandedPdfSettings): Promise<{ logoUri: string | null; sealUri: string | null }> {
  const [logoUri, sealUri] = await Promise.all([
    fetchAsDataUri(s.pdfLogoUrl),
    fetchAsDataUri(s.pdfSealImageUrl),
  ]);
  return { logoUri, sealUri };
}

export function buildBrandedHtml(opts: BuildBrandedHtmlOptions): string {
  const { title, subtitle, body, settings: s, logoBuri, sealUri } = opts;
  const primary = s.pdfPrimaryColor || "#2563eb";
  const accent = s.pdfAccentColor || "#0ea5e9";
  // Branding comes entirely from Settings — no hard-coded company name (Job I).
  const company = esc(s.companyName || "");
  const headerText = esc(s.pdfHeaderText || "");
  const watermarkText = esc(s.pdfWatermarkText || "");
  const signatureLabel = esc(s.pdfSignatureLabel || "");

  const logoHtml = logoBuri
    ? `<img src="${logoBuri}" alt="${company}" style="height:36px;object-fit:contain;max-width:180px;display:block" />`
    : `<span style="font-size:17px;font-weight:700;color:${esc(primary)}">${company}</span>`;

  const headerBlockHtml = `<div style="display:flex;flex-direction:column;gap:3px">
    ${logoHtml}
    ${headerText ? `<div style="font-size:9px;color:#64748b;line-height:1.3;max-width:220px">${headerText}</div>` : ""}
  </div>`;

  const sealHtml = sealUri
    ? `<img src="${sealUri}" alt="seal" style="height:56px;width:56px;object-fit:contain;opacity:.12;position:absolute;right:0;top:50%;transform:translateY(-50%)" />`
    : "";

  const watermarkHtml = watermarkText
    ? `<div style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-32deg);font-size:78px;font-weight:800;color:${esc(primary)};opacity:.06;white-space:nowrap;z-index:0;pointer-events:none;letter-spacing:.05em">${watermarkText}</div>`
    : "";

  const signatureHtml = signatureLabel
    ? `<div style="margin-top:38px;display:flex;justify-content:flex-end">
    <div style="text-align:center;min-width:190px">
      <div style="border-top:1px solid #94a3b8;margin-bottom:5px;height:34px"></div>
      <div style="font-size:9px;color:#64748b">${signatureLabel}</div>
    </div>
  </div>`
    : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<style>
@page{size:A4;margin:18mm 16mm 22mm}
@page{@bottom-center{content:none}}
*,*::before,*::after{box-sizing:border-box}
body{font-family:'DejaVu Sans','Noto Sans',Arial,sans-serif;color:#0f172a;font-size:10px;line-height:1.5;margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.pdf-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;padding-bottom:12px;border-bottom:2.5px solid ${esc(primary)};position:relative}
.pdf-title{font-size:19px;font-weight:700;color:${esc(primary)};margin:0 0 2px;line-height:1.2}
.pdf-subtitle{font-size:9px;color:#64748b}
h2{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#64748b;margin:18px 0 6px;padding-bottom:3px;border-bottom:2px solid ${esc(primary)}22}
h2 .accent{color:${esc(primary)};margin-right:4px}
.kpi-row{display:flex;gap:10px;margin-bottom:16px}
.kpi{border:1px solid #e2e8f0;border-radius:7px;padding:9px 13px;flex:1;border-top:3px solid ${esc(primary)};background:#f8fafc}
.kpi-label{font-size:8px;color:#64748b;text-transform:uppercase;letter-spacing:.06em}
.kpi-value{font-size:16px;font-weight:700;color:#0f172a;margin-top:1px}
.kpi-sub{font-size:8px;color:#94a3b8;margin-top:2px}
table{width:100%;border-collapse:collapse;margin-bottom:8px}
thead th{background:${esc(primary)};color:#fff;text-align:left;padding:5px 8px;font-size:8.5px;text-transform:uppercase;letter-spacing:.05em}
tbody tr:nth-child(odd){background:#fff}
tbody tr:nth-child(even){background:#f8fafc}
tbody td{padding:4px 8px;border-bottom:1px solid #f1f5f9;font-size:9.5px;vertical-align:middle}
.bar-chart{margin-bottom:16px}
.pct-bar{height:6px;background:${esc(accent)}33;border-radius:3px;overflow:hidden;margin-top:2px}
.pct-bar-fill{height:100%;background:${esc(primary)};border-radius:3px}
</style></head><body>
${watermarkHtml}
<div style="position:relative;z-index:1">
<div class="pdf-header">
  ${headerBlockHtml}
  ${sealHtml}
  <div style="text-align:right">
    <div class="pdf-title" style="font-size:15px">${esc(title)}</div>
    ${subtitle ? `<div class="pdf-subtitle">${esc(subtitle)}</div>` : ""}
  </div>
</div>
${body}
${signatureHtml}
</div>
</body></html>`;
}

/**
 * Build the footer markup for Chromium's `page.pdf({ displayHeaderFooter, footerTemplate })`.
 * Chromium does NOT resolve CSS `counter(page)`/`counter(pages)` in body content (they render
 * as 0), so page numbering must live in the print header/footer template where the special
 * `pageNumber` / `totalPages` classes are substituted. Keeps the branded footer (company,
 * footer text, generated timestamp) consistent with the in-body report.
 */
export function buildBrandedFooterTemplate(s: BrandedPdfSettings, locale?: string): string {
  // Branding comes entirely from Settings — no hard-coded company name (Job I).
  const company = esc(s.companyName || "");
  const footerText = esc(s.pdfFooterText || "");
  const generatedAt = new Date().toLocaleString(locale || "en-GB", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
  return `<div style="font-size:8px;color:#94a3b8;width:100%;margin:0 16mm;padding-top:4px;border-top:1px solid #e2e8f0;font-family:'DejaVu Sans','Noto Sans',Arial,sans-serif;display:flex;justify-content:space-between;-webkit-print-color-adjust:exact">
  <span>${company}${footerText ? " — " + footerText : ""}</span>
  <span>Generated: ${generatedAt} &nbsp;|&nbsp; Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>
</div>`;
}

export function buildDailyBarChartSvg(
  days: Array<{ day: string; activeDuration: number }>,
  primary: string,
  accent: string,
): string {
  if (days.length === 0) return "";
  const W = 520, H = 110, PAD_L = 38, PAD_R = 8, PAD_T = 8, PAD_B = 28;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;
  const maxVal = Math.max(...days.map(d => d.activeDuration), 1);
  const barW = Math.max(4, Math.floor(chartW / days.length) - 2);
  const gap = (chartW - barW * days.length) / Math.max(days.length - 1, 1);

  function fmtH(sec: number): string {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h > 0) return `${h}h${m > 0 ? m + "m" : ""}`;
    return m > 0 ? `${m}m` : `${sec}s`;
  }

  const bars = days.map((d, i) => {
    const bh = Math.max(2, Math.round((d.activeDuration / maxVal) * chartH));
    const x = PAD_L + i * (barW + gap);
    const y = PAD_T + chartH - bh;
    const labelDate = d.day.slice(5); // MM-DD
    const showLabel = days.length <= 14 || i % Math.ceil(days.length / 14) === 0;
    return [
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW}" height="${bh}" rx="2" fill="${primary}" fill-opacity=".85" />`,
      showLabel ? `<text x="${(x + barW / 2).toFixed(1)}" y="${(H - 6).toFixed(1)}" text-anchor="middle" font-size="7" fill="#64748b">${labelDate}</text>` : "",
    ].join("");
  }).join("");

  const yLabels = [0, 0.5, 1].map(f => {
    const val = Math.round(maxVal * f);
    const y = PAD_T + chartH - Math.round(f * chartH);
    return `<text x="${PAD_L - 3}" y="${y + 3}" text-anchor="end" font-size="7" fill="#94a3b8">${fmtH(val)}</text>
<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="#e2e8f0" stroke-width="0.5" />`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
${yLabels}
${bars}
</svg>`;
}
