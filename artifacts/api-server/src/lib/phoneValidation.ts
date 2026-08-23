import type { Response } from "express";
import { isValidPhone, type CountryCode } from "@workspace/phone";

const DEFAULT_COUNTRY: CountryCode = "TR";

/**
 * Country-aware phone gate for create/update endpoints.
 *
 * When `phone` is present and NON-EMPTY but not a valid number for its
 * country (libphonenumber rules — TR needs 10 national digits, UZ 9, etc.),
 * responds `422` with the i18n key `phone.invalid` and returns true (caller
 * must `return`). Empty/absent phones pass through — optionality stays the
 * caller's decision.
 *
 * Deliberately NOT applied to inbound bot/inbox pipelines or bulk Excel
 * imports (best-effort capture must never drop records).
 */
export function rejectInvalidPhone(
  res: Response,
  phone: unknown,
  defaultCountry: CountryCode = DEFAULT_COUNTRY,
): boolean {
  if (phone === undefined || phone === null) return false;
  const raw = String(phone).trim();
  if (!raw) return false;
  if (isValidPhone(raw, defaultCountry)) return false;
  res.status(422).json({
    error: "Enter a valid phone number for the selected country",
    code: "phone.invalid",
  });
  return true;
}
