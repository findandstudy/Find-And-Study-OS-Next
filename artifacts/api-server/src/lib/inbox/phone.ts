import { isValidPhoneNumber, type CountryCode } from "libphonenumber-js";
import { normalizePhone } from "@workspace/phone";

const DEFAULT_COUNTRY: CountryCode = "TR";

/**
 * Normalize a phone string to E.164 format. Returns null if it cannot
 * be parsed OR is not a valid number for its country. Default country
 * is Turkey (TR). Delegates to the shared @workspace/phone util so the
 * whole project uses one parsing engine.
 */
export function toE164(input: string | null | undefined, defaultCountry: CountryCode = DEFAULT_COUNTRY): string | null {
  const n = normalizePhone(input, defaultCountry);
  return n.isValid ? n.e164 : null;
}

export function isValidE164(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    return isValidPhoneNumber(value);
  } catch {
    return false;
  }
}
