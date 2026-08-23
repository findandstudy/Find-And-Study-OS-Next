export type ContractBrandingConfig = {
  brandName?: string;
  logoUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  pageTitle?: string;
  pageSubtitle?: string;
  pdfHeaderText?: string;
  pdfFooterText?: string;
  companySignatureDataUrl?: string;
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const IMAGE_DATA_URL = /^data:image\/(png|jpeg);base64,([a-z0-9+/]+={0,2})$/i;
const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024;

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

export function sanitizeContractBranding(value: unknown): ContractBrandingConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const color = (key: string): string | undefined => {
    const candidate = text(input[key], 7);
    return candidate && HEX_COLOR.test(candidate) ? candidate : undefined;
  };
  const signature = typeof input.companySignatureDataUrl === "string"
    ? input.companySignatureDataUrl.trim()
    : undefined;
  const safeSignature = signature && validateCompanySignatureDataUrl(signature) === null
    ? signature
    : undefined;
  const config: ContractBrandingConfig = {
    brandName: text(input.brandName, 200),
    logoUrl: text(input.logoUrl, 2000),
    primaryColor: color("primaryColor"),
    accentColor: color("accentColor"),
    pageTitle: text(input.pageTitle, 500),
    pageSubtitle: text(input.pageSubtitle, 1000),
    pdfHeaderText: text(input.pdfHeaderText, 500),
    pdfFooterText: text(input.pdfFooterText, 500),
    companySignatureDataUrl: safeSignature,
  };
  return Object.values(config).some(Boolean) ? config : null;
}

/**
 * Reject malformed admin-managed signature input explicitly instead of
 * silently dropping it during sanitization. An empty string intentionally
 * removes the signature and is therefore valid.
 */
export function validateContractBrandingInput(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const signature = (value as Record<string, unknown>).companySignatureDataUrl;
  if (signature === undefined || signature === null || signature === "") return null;
  return validateCompanySignatureDataUrl(signature);
}

export function validateCompanySignatureDataUrl(value: unknown): string | null {
  if (typeof value !== "string") return "Company signature must be a PNG or JPEG image";
  const match = IMAGE_DATA_URL.exec(value.trim());
  if (!match) return "Company signature must be a valid PNG or JPEG image";
  const [, format, payload] = match;
  if (payload.length % 4 !== 0) return "Company signature must be a valid PNG or JPEG image";
  let bytes: Buffer;
  try {
    bytes = Buffer.from(payload, "base64");
  } catch {
    return "Company signature must be a valid PNG or JPEG image";
  }
  if (bytes.length === 0 || bytes.length > MAX_SIGNATURE_BYTES) return "Company signature must be 2 MB or smaller";
  const isPng = bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = bytes.length >= 4
    && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  if ((format.toLowerCase() === "png" && !isPng) || (format.toLowerCase() === "jpeg" && !isJpeg)) {
    return "Company signature content does not match its image type";
  }
  return null;
}

export function hasContractCompanySignature(value: unknown): boolean {
  return Boolean(sanitizeContractBranding(value)?.companySignatureDataUrl);
}

/** Public signing responses must never expose the pre-approved company signature. */
export function publicContractBranding(value: unknown): ContractBrandingConfig | null {
  const config = sanitizeContractBranding(value);
  if (!config) return null;
  const { companySignatureDataUrl: _privateSignature, ...publicConfig } = config;
  return Object.values(publicConfig).some(Boolean) ? publicConfig : null;
}

export function escapeBrandingHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function applyContractBranding(innerHtml: string, value: unknown): string {
  const config = sanitizeContractBranding(value);
  if (!config) return innerHtml;
  const primary = config.primaryColor || "#1e3a8a";
  const accent = config.accentColor || primary;
  const header = (config.logoUrl || config.brandName || config.pdfHeaderText) ? `
    <header class="fas-contract-brand-header">
      ${config.logoUrl ? `<img src="${escapeBrandingHtml(config.logoUrl)}" alt="" />` : ""}
      <div><strong>${escapeBrandingHtml(config.brandName || "")}</strong>${config.pdfHeaderText ? `<span>${escapeBrandingHtml(config.pdfHeaderText)}</span>` : ""}</div>
    </header>` : "";
  const footer = config.pdfFooterText
    ? `<footer class="fas-contract-brand-footer">${escapeBrandingHtml(config.pdfFooterText)}</footer>`
    : "";
  return `<style>
    :root { --contract-brand-primary:${primary}; --contract-brand-accent:${accent}; }
    .fas-contract-brand-header { display:flex;align-items:center;gap:12px;padding:0 0 12px;margin:0 0 18px;border-bottom:2px solid var(--contract-brand-primary);color:var(--contract-brand-primary); }
    .fas-contract-brand-header img { width:auto;max-width:150px;max-height:52px;object-fit:contain; }
    .fas-contract-brand-header div { display:flex;flex-direction:column;gap:2px; }
    .fas-contract-brand-header strong { font-size:16px; }
    .fas-contract-brand-header span,.fas-contract-brand-footer { font-size:10px;color:#64748b; }
    .fas-contract-brand-footer { margin-top:20px;padding-top:10px;border-top:1px solid #cbd5e1;text-align:center; }
  </style>${header}${innerHtml}${footer}`;
}
