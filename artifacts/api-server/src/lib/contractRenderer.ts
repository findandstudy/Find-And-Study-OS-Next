import { loadMainAgencySignatureDataUrl } from "./mainAgencySignature";
import { applyContractBranding, sanitizeContractBranding } from "./contractBranding";

type Ctx = Record<string, any>;

/**
 * Canonical contract number. This is the SINGLE source of truth for the value
 * rendered into the template's `{{contract_number}}` placeholder AND for the
 * download filename, so the two can never drift apart. Format: `FAS-YYYY-NNNNN`
 * where YYYY is the 4-digit sign year and NNNNN is the zero-padded signing
 * session id (deterministic, no DB lookup, stable across re-renders).
 */
export function contractNumber(sessionId: number, signedAt?: Date): string {
  const d = signedAt || new Date();
  const yyyy = String(d.getUTCFullYear());
  return `FAS-${yyyy}-${String(sessionId).padStart(5, "0")}`;
}

/**
 * Download filename for a signed contract PDF, derived from the SAME
 * `contractNumber()` source that feeds `{{contract_number}}` in the document
 * body. Pattern: `<contract_number>_signed.pdf` (e.g.
 * `FAS-2026-00025_signed.pdf`). The storage object key keeps its own uuid for
 * uniqueness; only the user-facing Content-Disposition filename uses this.
 */
export function signedContractFilename(sessionId: number, signedAt?: Date): string {
  return `${contractNumber(sessionId, signedAt)}_signed.pdf`;
}

/**
 * Per-language label shown in place of an unfilled signature box (used by
 * `cleanupSignatureImages`). Shared by the public signing routes and the
 * server-side finalizer so the unfilled-signature appearance is identical
 * across every render path.
 */
export const SIG_PLACEHOLDER: Record<string, string> = {
  en: "Signature will appear here",
  tr: "İmza buraya yerleşecek",
  ar: "سيظهر التوقيع هنا",
  fr: "La signature apparaîtra ici",
  ru: "Подпись появится здесь",
};

/**
 * Normalize a signature image (raw base64 or an existing data URL) into a
 * `data:image/png;base64,...` data URL suitable for injecting into a template's
 * `{{signature}}` placeholder so it renders inside the designed signature box.
 */
export function toSignatureDataUrl(sig: string | null | undefined): string {
  if (!sig) return "";
  return sig.startsWith("data:") ? sig : `data:image/png;base64,${sig}`;
}

function lookup(ctx: Ctx, path: string): string {
  const parts = path.split(".");
  // For unqualified keys (e.g. {{agency_name}}) fall through into the standard
  // sub-contexts so author-defined intake/agent fields resolve regardless of
  // whether the template uses {{agency_name}} or {{intake.agency_name}}.
  if (parts.length === 1) {
    const key = parts[0];
    for (const scope of [ctx, ctx.intake, ctx.agent, ctx.contract]) {
      if (scope && scope[key] != null && scope[key] !== "") {
        const v = scope[key];
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        return String(v);
      }
    }
    return "";
  }
  let cur: any = ctx;
  for (const p of parts) {
    if (cur == null) return "";
    cur = cur[p];
  }
  if (cur == null) return "";
  if (cur instanceof Date) return cur.toISOString().slice(0, 10);
  return String(cur);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Renders a Handlebars-flavored template (no logic, just `{{path.to.value}}`
 * and `{{{path.to.value}}}` for raw HTML). Missing values resolve to "".
 */
export function renderTemplate(body: string, ctx: Ctx): string {
  let out = body.replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_m, path) => lookup(ctx, path));
  out = out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path) => escapeHtml(lookup(ctx, path)));
  return out;
}

/**
 * Map an agent record to the standard "Template Variables" naming used in
 * contract templates (snake_case). Returning empty strings for missing
 * values so templates render with blanks rather than the literal `{{...}}`.
 */
function autoFromAgent(agent: any | null): Record<string, string> {
  if (!agent) return {};
  const fullName = [agent.firstName, agent.lastName].filter(Boolean).join(" ").trim();
  return {
    agency_name: agent.businessName || agent.companyName || "",
    agency_legal_name: agent.companyName || agent.businessName || "",
    agency_email: agent.email || "",
    agency_phone: agent.phoneE164 || agent.phone || "",
    whatsapp_phone: agent.phoneE164 || agent.phone || "",
    contact_person_name: agent.pointOfContact || fullName || "",
    contact_person_first_name: agent.firstName || "",
    contact_person_last_name: agent.lastName || "",
    country: agent.country || "",
    city: agent.city || "",
    address: agent.address || "",
    tax_number: agent.taxNumber || "",
    agency_code: agent.agencyCode || "",
  };
}

/**
 * Default values for the "Agency Information" intake step, derived from the
 * agent record the admin filled in at agent creation. Keyed by the intake field
 * keys our templates use (plus common aliases) so the signing UI can
 * pre-populate the form. The agent can edit these; their saved edits become
 * intakeData and override the agent record everywhere (see buildAgentContext).
 * Empty values are omitted so they never clobber a saved answer on the client.
 */
export function agentIntakeDefaults(agent: any | null): Record<string, string> {
  if (!agent) return {};
  const fullName = [agent.firstName, agent.lastName].filter(Boolean).join(" ").trim();
  const company = agent.businessName || agent.companyName || "";
  const tax = agent.taxNumber || "";
  const address = agent.address || "";
  const out: Record<string, string> = {
    fullName, fullname: fullName, contactName: fullName, signerName: fullName,
    companyName: company, company, tradeName: company, legalName: company, agencyName: company,
    taxNumber: tax, taxNo: tax, taxId: tax,
    address,
  };
  for (const k of Object.keys(out)) if (!out[k]) delete out[k];
  return out;
}

export function buildAgentContext(agent: any | null, intake: Record<string, any> | null, contract: { date?: string; signerEmail?: string; signerName?: string; number?: string } = {}): Ctx {
  const dateStr = contract.date || new Date().toISOString().slice(0, 10);
  const yearStr = String(new Date(dateStr).getUTCFullYear());

  // Bridge the signer's camelCase intake answers onto the canonical snake_case
  // template variables. Intake form keys are camelCase (fullName, companyName,
  // taxNumber) while standard template variables are snake_case, so without this
  // bridge name/company/tax would keep showing the admin-entered agent record.
  // (`address` already collides by name and reflects via the raw intake spread.)
  //
  // Guards keep this strictly additive and safe for public/admin templates:
  //   - We only fill a canonical key when the signer did NOT already supply that
  //     exact snake_case key in intake (raw spread handles those, and distinct
  //     `agency_name` vs `agency_legal_name` values are preserved as-is).
  //   - `signer_name` is intentionally left to `contract.signerName` (the name
  //     captured at the signature step) and never overwritten from intake.
  //   - Empty answers are skipped so they fall back to the agent record.
  const intakeObj = (intake || {}) as Record<string, any>;
  const val = (k: string): string => {
    const v = intakeObj[k];
    return typeof v === "string" ? v.trim() : "";
  };
  const firstVal = (...keys: string[]): string => {
    for (const k of keys) { const v = val(k); if (v) return v; }
    return "";
  };
  const intakeCanonical: Record<string, string> = {};
  if (!val("contact_person_name")) {
    const inName = firstVal("fullName", "fullname", "contactName", "signerName");
    if (inName) {
      intakeCanonical.contact_person_name = inName;
      const parts = inName.split(/\s+/);
      if (!val("contact_person_first_name")) intakeCanonical.contact_person_first_name = parts[0] || "";
      if (!val("contact_person_last_name")) intakeCanonical.contact_person_last_name = parts.slice(1).join(" ");
    }
  }
  const inCompany = firstVal("companyName", "company", "tradeName", "legalName", "agencyName");
  if (inCompany) {
    if (!val("agency_name")) intakeCanonical.agency_name = inCompany;
    if (!val("agency_legal_name")) intakeCanonical.agency_legal_name = inCompany;
  }
  if (!val("tax_number")) {
    const inTax = firstVal("taxNumber", "taxNo", "taxId");
    if (inTax) intakeCanonical.tax_number = inTax;
  }

  // Auto-mapped standard template variables (snake_case). Order of precedence
  // for unqualified placeholders such as `{{agency_name}}`:
  //   1. raw intake keys (signer's explicit snake_case answer)
  //   2. intake canonical bridge (camelCase form answers, only where 1 is empty)
  //   3. autoFromAgent (system-known agent fields)
  //   4. contract metadata (sign_date / contract_number)
  // Achieved by spreading intake (then its canonical bridge) LAST so they win.
  const auto = {
    ...autoFromAgent(agent),
    contract_number: contract.number || "",
    sign_date: dateStr,
    year: yearStr,
    signer_email: contract.signerEmail || "",
    signer_name: contract.signerName || "",
    // Signature image placeholders. They stay empty for the unsigned preview;
    // `cleanupSignatureImages` swaps empty <img src=""> for a styled box.
    signature: "",
    main_agency_signature: "",
    ...(intake || {}),
    ...intakeCanonical,
  };

  return {
    ...auto,
    agent: agent || {},
    intake: intake || {},
    contract: {
      date: dateStr,
      number: contract.number || "",
      signerEmail: contract.signerEmail || "",
      signerName: contract.signerName || "",
    },
  };
}

/**
 * Replace `<img>` tags whose `src` is empty (rendered from an unfilled
 * `{{signature}}` placeholder) with a styled placeholder box. Also strips
 * literal `<img src="{{...}}">` placeholders that the renderer left intact
 * because the path didn't match its regex.
 */
/**
 * An <img> src looks "unfilled" when the template renderer was unable to
 * substitute a real value into it. Covers:
 *   - completely missing/whitespace src
 *   - bare handlebars remnants (`{{signature}}`, `{{...}}`, etc.) that the
 *     renderer left in place because the path didn't resolve
 *   - any src that still contains `{{` or `}}` from a partial substitution
 *   - `data:` URLs with an empty payload such as `data:image/png;base64,`
 *     produced when a template wraps `{{signature}}` inside a data-URL
 *     prefix and the signature variable resolved to ""
 *
 * We deliberately do NOT match on alt/class/id text, because contracts may
 * legitimately reference real signature artwork (e.g. a notarised seal
 * served from a CDN) and we must not swap those out.
 */
function looksUnfilled(src: string): boolean {
  const s = src.trim();
  if (!s) return true;
  if (/^\{\{[\w.\s]*\}\}$/.test(s)) return true;
  if (s.includes("{{") || s.includes("}}")) return true;
  if (/^data:[^,]*,\s*$/.test(s)) return true;
  return false;
}

export function cleanupSignatureImages(html: string, placeholderText: string): string {
  return html.replace(/<img\b([^>]*)>/gi, (full, attrs) => {
    const a = attrs as string;
    const srcMatch = a.match(/\bsrc\s*=\s*(["'])(.*?)\1/i);
    const src = srcMatch ? srcMatch[2] : "";
    if (!looksUnfilled(src)) return full;
    const altMatch = a.match(/\balt\s*=\s*(["'])(.*?)\1/i);
    const alt = altMatch ? altMatch[2].trim() : "";
    const safe = escapeHtml(alt || placeholderText);
    return `<div style="display:flex;align-items:center;justify-content:center;min-height:64px;border:1px dashed #cbd5e1;border-radius:8px;background:#f8fafc;color:#94a3b8;font-size:12px;font-style:italic;padding:16px;margin:4px 0;">${safe}</div>`;
  });
}

/**
 * Wrap author-designed contract markup in a complete, print-ready HTML
 * document. Keeps the template's own `<style>` blocks, inline CSS, tables,
 * colors and signature `<img>` placement intact — the templates are explicitly
 * authored for browser-to-PDF rendering (CSS variables, flexbox,
 * `print-color-adjust:exact`). The shell only supplies an A4 page box and a
 * font fallback chain so Turkish/Cyrillic/Arabic glyphs resolve.
 *
 * SHARED by BOTH render paths so the on-screen signing preview and the final
 * headless-Chromium PDF stay visually identical and can never drift:
 *   - PDF: Playwright `page.pdf()` renders with PRINT media, so the `@page` box
 *     and margins apply and the `@media screen` block below is ignored — the
 *     final PDF output is unchanged by that block.
 *   - Preview: the signing UI drops this same document into a sandboxed
 *     `<iframe>` (screen media), where `@page` has no effect, so the
 *     `@media screen` block reproduces the A4 page width + margins to mirror the
 *     PDF layout.
 */
export function documentShell(innerHtml: string): string {
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  @page { size: A4; margin: 14mm 10mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: 'Inter', 'DejaVu Sans', 'Noto Sans', system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
    color: #0f172a;
    font-size: 12px;
    line-height: 1.6;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  img { max-width: 100%; }
  table { border-collapse: collapse; }
  /* Screen-only: reproduce the A4 page box + margins for the in-browser
     signing preview. Playwright page.pdf() emulates PRINT media, so this block
     is ignored during PDF generation and the final PDF is left unchanged. */
  @media screen {
    html { background: #f1f5f9; }
    body {
      max-width: 210mm;
      margin: 0 auto;
      padding: 14mm 10mm;
      background: #ffffff;
    }
  }
</style>
</head>
<body>${innerHtml}</body>
</html>`;
}

/**
 * THE single render path for a FINAL, post-signature contract. Every caller
 * that produces the legally-signed PDF — the sign-time delivery worker, the
 * legacy backfill sweep, and the admin force-regenerate — funnels its HTML
 * through here so the two things that must always be present in a signed
 * document can never be forgotten by one path and remembered by another:
 *
 *   1. {{main_agency_signature}} -> the Find And Study (main agency) seal,
 *      loaded from protected persistent storage. The unsigned preview /
 *      signing-screen renders deliberately leave this empty (buildAgentContext
 *      defaults it to ""), so the seal appears ONLY after signing.
 *   2. {{contract_number}} -> the canonical contract number, identical to the
 *      value used for the download filename.
 *
 * `{{signature}}` is the sub-agent's captured signature (distinct image,
 * distinct source). Returns the cleaned HTML ready for headless-Chromium PDF.
 */
export function buildFinalSignedContractHtml(params: {
  bodyHtml: string;
  templateLanguage: string;
  agent: any | null;
  intakeData: Record<string, any> | null;
  signerEmail: string;
  signerName?: string | null;
  signedAt: Date;
  signatureBase64: string;
  contractNumber: string;
  signingPageConfig?: unknown;
}): string {
  const ctx = buildAgentContext(params.agent, params.intakeData || null, {
    signerEmail: params.signerEmail,
    signerName: params.signerName || undefined,
    date: params.signedAt.toISOString().slice(0, 10),
    number: params.contractNumber,
  });
  ctx.signature = toSignatureDataUrl(params.signatureBase64);
  const branding = sanitizeContractBranding(params.signingPageConfig);
  ctx.main_agency_signature = branding?.companySignatureDataUrl || loadMainAgencySignatureDataUrl();
  const placeholder = SIG_PLACEHOLDER[params.templateLanguage] || SIG_PLACEHOLDER.en;
  return applyContractBranding(cleanupSignatureImages(renderTemplate(params.bodyHtml, ctx), placeholder), branding);
}
