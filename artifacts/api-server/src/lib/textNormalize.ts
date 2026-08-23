const TR_TO_LATIN_MAP: Record<string, string> = {
  // Turkish
  "ç": "c", "Ç": "C",
  "ğ": "g", "Ğ": "G",
  "ı": "i", "İ": "I",
  "ö": "o", "Ö": "O",
  "ş": "s", "Ş": "S",
  "ü": "u", "Ü": "U",
  "â": "a", "Â": "A",
  "î": "i", "Î": "I",
  "û": "u", "Û": "U",
  // Azerbaijani (schwa — does NOT decompose via NFD)
  "ə": "e", "Ə": "E",
  // Nordic / Germanic / Celtic
  "ø": "o", "Ø": "O",
  "ß": "ss",
  "æ": "ae", "Æ": "AE",
  "œ": "oe", "Œ": "OE",
  "ð": "d", "Ð": "D",
  "þ": "th", "Þ": "Th",
  // Slavic / Baltic
  "đ": "d", "Đ": "D",
  "ł": "l", "Ł": "L",
};

export function transliterateToLatin(input: string): string {
  let out = "";
  for (const ch of input) {
    if (TR_TO_LATIN_MAP[ch] !== undefined) {
      out += TR_TO_LATIN_MAP[ch];
      continue;
    }
    const stripped = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    out += stripped;
  }
  // Safety net: one final NFKD pass to catch any remaining composed forms,
  // then drop any non-ASCII characters that neither the map nor NFD resolved.
  // (Name fields must be pure ASCII; unknown chars are silently removed.)
  return out
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x00-\x7F]/g, "");
}

export function toLatinUpper(input: string): string {
  if (!input) return "";
  return transliterateToLatin(input).toUpperCase();
}

export function digitsOnly(input: string | null | undefined): string {
  if (!input) return "";
  return String(input).replace(/\D+/g, "");
}

const LATIN_NAME_RE = /^[A-Za-z\s'-]+$/;

export function isLatinText(text: string): boolean {
  return LATIN_NAME_RE.test(text);
}

/**
 * True when `text` contains at least one letter (\p{L}) that is NOT in the Latin
 * script — i.e. Arabic, Cyrillic, Greek, CJK, Hebrew, etc. Turkish letters
 * (ç ğ ı ş ö ü â î û) ARE Latin-script so they are accepted (and later
 * transliterated to ASCII by toLatinUpper). Non-letter characters (spaces,
 * digits, punctuation, combining marks) are ignored by this check.
 */
export function containsNonLatinLetter(text: string): boolean {
  for (const ch of text) {
    if (/\p{L}/u.test(ch) && !/\p{Script=Latin}/u.test(ch)) return true;
  }
  return false;
}

/**
 * Machine-readable prefix returned in the `error` field when a name contains a
 * non-Latin-script letter. Format: `NON_LATIN_NAME:<field>`. Clients can detect
 * this prefix to localize the message; the human-readable English suffix is a
 * safe fallback for surfaces that display the raw string.
 */
export const NON_LATIN_NAME_CODE = "NON_LATIN_NAME";

export function normalizeNameField(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return "";
  return toLatinUpper(value.trim());
}

const DEFAULT_NAME_FIELDS = new Set<string>([
  "firstName", "lastName", "motherName", "fatherName",
]);

export const EXTENDED_NAME_FIELDS: string[] = [
  "firstName", "lastName", "motherName", "fatherName",
  "highSchool", "universityBachelor", "universityMaster",
  "schoolName", "address",
];

export function normalizeAndValidateNames(
  body: Record<string, unknown>,
  fields?: string[],
): { error: string | null; normalized: Record<string, unknown> } {
  const result = { ...body };
  const checkFields = fields || [...DEFAULT_NAME_FIELDS];
  for (const field of checkFields) {
    const val = result[field];
    if (val !== undefined && val !== null && typeof val === "string" && val.trim() !== "") {
      const trimmed = val.trim();
      if (containsNonLatinLetter(trimmed)) {
        return {
          error: `${NON_LATIN_NAME_CODE}:${field}: This field must contain only Latin letters.`,
          normalized: result,
        };
      }
      result[field] = trimmed;
    }
  }
  return { error: null, normalized: result };
}

export function normalizePhoneField(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" && typeof value !== "number") return "";
  const raw = String(value);
  const hasLeadingPlus = raw.trim().startsWith("+");
  const digits = digitsOnly(raw);
  return hasLeadingPlus ? `+${digits}` : digits;
}
