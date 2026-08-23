/**
 * portalNormalize — pure, side-effect-free normalization helpers that bring
 * FAS-OS data into portal-compatible shape (SIT/Zoho rules first).
 *
 * - normalizeGpaInteger: portals (SIT) reject decimal GPA values — always
 *   store/submit an INTEGER percentage 0–100.
 * - cleanCity: the City field must be a real city name, never an address
 *   fragment ("HOUSE NO. 165" was submitted as a city in production).
 *   When in doubt returns null so the readiness gate can flag it — it never
 *   derives a city from an address line.
 * - formatDateISO: single date standard (YYYY-MM-DD) for DOB/passport dates.
 *
 * Imported by both backend and frontend via @workspace/db.
 */

/**
 * Convert a raw GPA (string or number) to an integer percentage 0–100.
 * ai-extract already produces percentages; here we only round to an integer
 * and clamp. Non-numeric input → null.
 */
export function normalizeGpaInteger(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  let num: number;
  if (typeof raw === "number") {
    num = raw;
  } else {
    const s = String(raw).replace(",", ".").trim();
    if (!s) return null; // Number("") === 0 — empty input is not a GPA
    num = Number(s);
  }
  if (!Number.isFinite(num)) return null;
  const rounded = Math.round(num);
  if (rounded < 0) return 0;
  if (rounded > 100) return 100;
  return rounded;
}

/** Address-ish keywords that must never appear in a clean city value. */
const ADDRESS_KEYWORDS = [
  "house", "flat", "apartment", "apt", "street", "st.", "road", "rd.",
  "block", "sector", "plot", "floor", "avenue", "ave", "lane", "colony",
  "mahalle", "mah.", "sokak", "sok.", "cadde", "cad.", "no:", "no.", "p.o",
  "po box", "postal", "zip",
];

/**
 * Validate/clean a city value. Rejects address-like fragments (digit-heavy,
 * address keywords, overly long strings). Does NOT attempt to derive a city
 * from the address line — ambiguous input yields null so the completeness
 * gate can surface it as missing.
 */
export function cleanCity(
  rawCity: string | null | undefined,
  _addressLine?: string | null,
): string | null {
  if (rawCity == null) return null;
  const city = String(rawCity).replace(/\s+/g, " ").trim();
  if (!city) return null;
  // Too long to be a city name → likely a full address line.
  if (city.length > 40) return null;
  const lower = city.toLowerCase();
  if (ADDRESS_KEYWORDS.some((k) => lower.includes(k))) return null;
  const digits = (city.match(/\d/g) ?? []).length;
  // Any digits at all are suspicious for a city; more than 1 → reject.
  if (digits > 0) return null;
  const letters = (city.match(/\p{L}/gu) ?? []).length;
  if (letters < 2) return null;
  // Mostly-punctuation strings are not cities.
  if (letters / city.length < 0.6) return null;
  return city;
}

/**
 * Normalize common date inputs ("DD.MM.YYYY", "DD/MM/YYYY", "YYYY-MM-DD",
 * with optional time suffix) to "YYYY-MM-DD". Invalid/unknown → null.
 */
export function formatDateISO(raw: string | Date | null | undefined): string | null {
  if (raw == null) return null;
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    return raw.toISOString().slice(0, 10);
  }
  const s = String(raw).trim();
  if (!s) return null;
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (match) {
    y = Number(match[1]); m = Number(match[2]); d = Number(match[3]);
  } else {
    match = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s);
    if (!match) return null;
    d = Number(match[1]); m = Number(match[2]); y = Number(match[3]);
  }
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
