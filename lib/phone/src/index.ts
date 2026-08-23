import {
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js";

export type { CountryCode } from "libphonenumber-js";

export interface NormalizedPhone {
  /** Canonical E.164 form (e.g. "+905055588151"), or null when unparseable. */
  e164: string | null;
  /** Country-aware validity (length + pattern for the detected country). */
  isValid: boolean;
  /** ISO-3166 alpha-2 of the detected country (e.g. "TR"), or null. */
  country: string | null;
}

/**
 * Parse + validate a raw phone string with country-aware rules.
 *
 * - International input ("+998 33 092 92 17") is validated against the
 *   country encoded in the number itself.
 * - National input ("0505 558 51 81") is interpreted with `defaultCountry`.
 * - `e164` is returned even for invalid-but-parseable numbers so callers can
 *   decide; gate writes on `isValid`.
 */
export function normalizePhone(
  raw: string | null | undefined,
  defaultCountry?: CountryCode,
): NormalizedPhone {
  if (!raw || !String(raw).trim()) {
    return { e164: null, isValid: false, country: null };
  }
  let parsed;
  try {
    parsed = parsePhoneNumberFromString(String(raw).trim(), defaultCountry);
  } catch {
    parsed = undefined;
  }
  if (!parsed) return { e164: null, isValid: false, country: null };
  return {
    e164: parsed.number,
    isValid: parsed.isValid(),
    country: parsed.country ?? null,
  };
}

/** True when the raw input is a valid phone number for its country. */
export function isValidPhone(
  raw: string | null | undefined,
  defaultCountry?: CountryCode,
): boolean {
  return normalizePhone(raw, defaultCountry).isValid;
}

/**
 * Convenience: canonical E.164 for VALID numbers only, else null.
 * (Matches the long-standing api-server `toE164` contract.)
 */
export function toValidE164(
  raw: string | null | undefined,
  defaultCountry?: CountryCode,
): string | null {
  const n = normalizePhone(raw, defaultCountry);
  return n.isValid ? n.e164 : null;
}
