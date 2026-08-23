/**
 * identityValidation — shared pure validation for student identity fields.
 *
 * Used in TWO enforcement points:
 *  1. Portal automation enqueue gate (api-server, mode=real only):
 *     invalid identity → submission never enters the queue.
 *  2. Worker browser-fill guard (real mode only):
 *     if invalid data somehow reached the worker, abort before touching
 *     the portal form — never submit silently wrong data.
 *
 * All functions are pure (no DB, no I/O) so they are trivially testable.
 *
 * This module is also the SINGLE SOURCE for parseFlexibleDate and
 * isPassportExpired — the api-server's passportValidity.ts re-exports them
 * from here so the logic never exists in two places.
 */

// ---------------------------------------------------------------------------
// Shared date helpers (single source; re-exported by api-server passportValidity)
// ---------------------------------------------------------------------------

/** Parse "YYYY-MM-DD", "DD.MM.YYYY" or "DD/MM/YYYY" → Date (UTC midnight) or null. */
export function parseFlexibleDate(s: string): Date | null {
  const v = String(s || "").trim();
  if (!v) return null;
  let year: number, month: number, day: number;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  if (m) {
    year = Number(m[1]); month = Number(m[2]); day = Number(m[3]);
  } else {
    m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(v);
    if (!m) return null;
    day = Number(m[1]); month = Number(m[2]); year = Number(m[3]);
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  // Reject overflow dates like 31.02.2030
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d;
}

/** true only when expiry parses AND is strictly before today (00:00 UTC). */
export function isPassportExpired(expiry: string | null | undefined, now: Date = new Date()): boolean {
  if (!expiry) return false;
  const d = parseFlexibleDate(String(expiry));
  if (!d) return false; // unparseable → do not block
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return d.getTime() < todayUtc;
}

/** Internal alias used by the date-consistency checks below. */
const parseDate = (s: string | null | undefined): Date | null =>
  parseFlexibleDate(String(s ?? ""));

// ---------------------------------------------------------------------------
// Error shape
// ---------------------------------------------------------------------------

/** Stable machine-readable reason codes (mapped to Turkish staff messages in
 *  api-server criticalFieldValidation.ts). */
export type IdentityErrorCode =
  | "empty"
  | "placeholder_value"
  | "looks_like_national_id_not_passport"
  | "invalid_characters"
  | "invalid_length"
  | "repeated_character"
  | "numeric_name"
  | "unparseable_date"
  | "dob_in_future"
  | "dob_before_1900"
  | "age_out_of_range"
  | "issue_date_in_future"
  | "issue_before_birth"
  | "expiry_before_issue";

export interface IdentityValidationError {
  field: string;
  code: IdentityErrorCode;
  reason: string;
}

// ---------------------------------------------------------------------------
// Passport number validation
// ---------------------------------------------------------------------------

/**
 * Common placeholder / test / non-passport strings that should never reach a
 * university portal.  Checked case-insensitively after stripping whitespace.
 */
const PASSPORT_PLACEHOLDER_RE = /^(?:pending|n\/a|na|applying|applied|tbd|none|unknown|waiting|hesapta|yok|belirtilmemi[sş]|-)$|fixture|placeholder/i;

/** All characters are the same (e.g. "111111111" or "AAAAAAA"). */
function isAllSameChar(s: string): boolean {
  return s.length > 0 && [...s].every((c) => c === s[0]);
}

/**
 * Validate a passport number.
 *
 * Rules (in order — mirrors the staff-facing spec):
 *  1. Required — must be non-empty.                          → empty
 *  2. No known placeholder / test text.                      → placeholder_value
 *  3. Pakistan CNIC pattern (DDDDD-DDDDDDD-D).               → looks_like_national_id_not_passport
 *  4. All-digit (ignoring spaces/hyphens) longer than 10.    → looks_like_national_id_not_passport
 *  5. Characters: only letters, digits, spaces, hyphens.     → invalid_characters
 *  6. Not all the same character.                            → repeated_character
 *  7. Length 5–12 after stripping spaces/hyphens.            → invalid_length
 *
 * Spaces and hyphens are IGNORED for length so Russian-style numbers like
 * "76 7365488" (series + space + number) are accepted, and CNIC-style
 * hyphenated IDs are still caught by the earlier structural rules.
 */
export function validatePassportNumber(
  value: string | null | undefined,
): IdentityValidationError | null {
  const raw = String(value || "").trim();

  if (!raw) {
    return { field: "passportNumber", code: "empty", reason: "Passport number is required" };
  }

  if (PASSPORT_PLACEHOLDER_RE.test(raw)) {
    return {
      field: "passportNumber",
      code: "placeholder_value",
      reason: `Passport number "${raw}" is a placeholder or test value`,
    };
  }

  // Pakistan CNIC pattern (DDDDD-DDDDDDD-D — 13 digits with hyphens).
  if (/^\d{5}-\d{7}-\d{1}$/.test(raw)) {
    return {
      field: "passportNumber",
      code: "looks_like_national_id_not_passport",
      reason: `Value "${raw}" matches Pakistan CNIC pattern (DDDDD-DDDDDDD-D) — this is a national ID, not a passport number`,
    };
  }

  // Pure digits (ignoring spaces/hyphens) with 11+ characters → national ID,
  // fabricated number or data-entry error, never a real passport. Real
  // all-numeric passports (Iran, some older formats) top out at 9–10 digits.
  const stripped = raw.replace(/[\s-]/g, "");
  if (/^\d+$/.test(stripped) && stripped.length > 10) {
    return {
      field: "passportNumber",
      code: "looks_like_national_id_not_passport",
      reason: `Passport number is a ${stripped.length}-digit all-numeric string — too long for any real passport (max 10 digits for all-numeric passports)`,
    };
  }

  // Only letters, digits, spaces, or hyphens are allowed.
  if (!/^[A-Za-z0-9 -]+$/.test(raw)) {
    return {
      field: "passportNumber",
      code: "invalid_characters",
      reason: `Passport number contains invalid characters: "${raw}"`,
    };
  }

  if (isAllSameChar(stripped)) {
    return {
      field: "passportNumber",
      code: "repeated_character",
      reason: `Passport number is all the same character: "${raw}"`,
    };
  }

  // Length check on the stripped value (spaces/hyphens don't count).
  if (stripped.length < 5 || stripped.length > 12) {
    return {
      field: "passportNumber",
      code: "invalid_length",
      reason: `Passport number length ${stripped.length} (ignoring spaces/hyphens) is outside the valid 5–12 range`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Name validation
// ---------------------------------------------------------------------------

const NAME_PLACEHOLDER_RE = /^(?:n\/a|na|none|unknown|pending|tbd|-+|test)$/i;

/**
 * Validate a required person name (firstName or lastName).
 * Allows multi-word names and names with hyphens (e.g. "MARY-ANNE", "AL SAYED").
 */
export function validatePersonName(
  value: string | null | undefined,
  field: string,
): IdentityValidationError | null {
  const raw = String(value || "").trim();

  if (!raw) {
    return { field, code: "empty", reason: `${field} is required` };
  }

  if (NAME_PLACEHOLDER_RE.test(raw)) {
    return { field, code: "placeholder_value", reason: `${field} contains a placeholder value: "${raw}"` };
  }

  // Names must contain at least one letter — digits-only values are data errors.
  if (!/\p{L}/u.test(raw)) {
    return { field, code: "numeric_name", reason: `${field} contains no letters: "${raw}"` };
  }

  if (raw.length < 2) {
    return { field, code: "invalid_length", reason: `${field} too short (${raw.length} char; minimum 2)` };
  }

  if (raw.length > 100) {
    return { field, code: "invalid_length", reason: `${field} too long (${raw.length} chars; maximum 100)` };
  }

  if (isAllSameChar(raw.replace(/[\s-]/g, ""))) {
    return { field, code: "repeated_character", reason: `${field} is all the same character: "${raw}"` };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Date consistency validation
// ---------------------------------------------------------------------------

export interface DateConsistencyInput {
  dateOfBirth?: string | null;
  passportIssueDate?: string | null;
  passportExpiryDate?: string | null;
  /** Reference point for "today"; defaults to new Date(). */
  now?: Date;
}

/**
 * Validate the logical relationship between the three identity dates.
 * All fields are optional — only present+parseable dates participate.
 *
 * Rules (only applied when the relevant dates are both present AND parseable):
 *  - dateOfBirth must be in the past (≥ 1 day ago).
 *  - dateOfBirth year: 1900 – (today − 10 years).
 *  - passportIssueDate must not be in the future.
 *  - passportIssueDate must be after dateOfBirth (a person can't have a
 *    passport before being born).
 *  - passportExpiryDate must be after passportIssueDate.
 */
export function validateDateConsistency(
  input: DateConsistencyInput,
): IdentityValidationError[] {
  const errors: IdentityValidationError[] = [];
  const now = input.now ?? new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  const dob = parseDate(input.dateOfBirth);
  const issueDate = parseDate(input.passportIssueDate);
  const expiryDate = parseDate(input.passportExpiryDate);

  if (input.dateOfBirth && !dob) {
    errors.push({
      field: "dateOfBirth",
      code: "unparseable_date",
      reason: `Cannot parse date of birth: "${input.dateOfBirth}"`,
    });
  }
  if (input.passportIssueDate && !issueDate) {
    errors.push({
      field: "passportIssueDate",
      code: "unparseable_date",
      reason: `Cannot parse passport issue date: "${input.passportIssueDate}"`,
    });
  }
  if (input.passportExpiryDate && !expiryDate) {
    errors.push({
      field: "passportExpiryDate",
      code: "unparseable_date",
      reason: `Cannot parse passport expiry date: "${input.passportExpiryDate}"`,
    });
  }

  if (dob) {
    if (dob.getTime() >= todayUtc) {
      errors.push({
        field: "dateOfBirth",
        code: "dob_in_future",
        reason: "Date of birth cannot be today or in the future",
      });
    } else if (dob.getUTCFullYear() < 1900) {
      errors.push({
        field: "dateOfBirth",
        code: "dob_before_1900",
        reason: `Date of birth year ${dob.getUTCFullYear()} is before 1900 — likely a data error`,
      });
    } else {
      const ageYears = (todayUtc - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
      if (ageYears < 10) {
        errors.push({
          field: "dateOfBirth",
          code: "age_out_of_range",
          reason: `Date of birth implies age ${ageYears.toFixed(1)} — too young for a university applicant`,
        });
      } else if (ageYears > 100) {
        errors.push({
          field: "dateOfBirth",
          code: "age_out_of_range",
          reason: `Date of birth implies age ${ageYears.toFixed(1)} — likely a data error`,
        });
      }
    }
  }

  if (issueDate) {
    if (issueDate.getTime() > todayUtc) {
      errors.push({
        field: "passportIssueDate",
        code: "issue_date_in_future",
        reason: "Passport issue date is in the future — not yet a valid passport",
      });
    }
    if (dob && issueDate.getTime() <= dob.getTime()) {
      errors.push({
        field: "passportIssueDate",
        code: "issue_before_birth",
        reason: "Passport issue date must be after date of birth",
      });
    }
  }

  if (expiryDate && issueDate) {
    if (expiryDate.getTime() <= issueDate.getTime()) {
      errors.push({
        field: "passportExpiryDate",
        code: "expiry_before_issue",
        reason: "Passport expiry date must be after issue date",
      });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Combined entry point
// ---------------------------------------------------------------------------

export interface IdentityFieldsInput {
  passportNumber?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  dateOfBirth?: string | null;
  passportIssueDate?: string | null;
  passportExpiryDate?: string | null;
  /** Reference point for "today" (defaults to new Date()). */
  now?: Date;
}

/**
 * Run all identity field validations and return every error found.
 * An empty array means the identity data is valid.
 */
export function validateIdentityFields(
  input: IdentityFieldsInput,
): IdentityValidationError[] {
  const errors: IdentityValidationError[] = [];

  const ppError = validatePassportNumber(input.passportNumber);
  if (ppError) errors.push(ppError);

  const fnError = validatePersonName(input.firstName, "firstName");
  if (fnError) errors.push(fnError);

  const lnError = validatePersonName(input.lastName, "lastName");
  if (lnError) errors.push(lnError);

  errors.push(...validateDateConsistency({
    dateOfBirth:       input.dateOfBirth,
    passportIssueDate: input.passportIssueDate,
    passportExpiryDate: input.passportExpiryDate,
    now:               input.now,
  }));

  return errors;
}

/**
 * Format validation errors into a human-readable message string.
 * Suitable for portal submission result_json / error messages.
 */
export function formatIdentityErrors(errors: IdentityValidationError[]): string {
  return errors.map((e) => `[${e.field}] ${e.reason}`).join("; ");
}
