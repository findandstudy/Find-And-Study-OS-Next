const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /(?<!\d)(\+?\d[\d\s().-]{7,}\d)(?!\d)/g;
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{4}[A-Z0-9]{6,30}\b/g;
const TCKN_RE = /(?<!\d)\d{11}(?!\d)/g;
const PASSPORT_RE = /\b[A-PR-WY][A-Z0-9]\d{6,8}\b/g;

function maskEmail(s: string): string {
  const [user, domain] = s.split("@");
  if (!domain) return "[REDACTED_EMAIL]";
  const head = user.slice(0, Math.min(2, user.length));
  return `${head}***@${domain}`;
}

function maskTail(s: string, keep = 4): string {
  const clean = s.replace(/\s+/g, "");
  if (clean.length <= keep) return "***";
  return `***${clean.slice(-keep)}`;
}

export function redactString(input: string): string {
  if (!input) return input;
  let out = input;
  out = out.replace(EMAIL_RE, (m) => maskEmail(m));
  out = out.replace(IBAN_RE, (m) => `[IBAN:${maskTail(m, 4)}]`);
  out = out.replace(TCKN_RE, () => "[TCKN:***]");
  out = out.replace(PASSPORT_RE, (m) => `[PASSPORT:${maskTail(m, 3)}]`);
  out = out.replace(PHONE_RE, (m) => `[PHONE:${maskTail(m, 4)}]`);
  return out;
}

export function redactPII<T>(value: T): T {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactPII(v)) as unknown as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactPII(v);
    }
    return out as unknown as T;
  }
  return value;
}
