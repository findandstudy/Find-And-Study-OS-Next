/**
 * criticalFieldValidation — staff-facing validation layer for the identity
 * fields that flow into REAL university portal submissions:
 * passport number, first/last name, date of birth, passport issue/expiry.
 *
 * Delegates all rule logic to the shared core in @workspace/portal-adapters
 * (single source of truth, also used by the portal-runner and worker guards)
 * and adds:
 *   - severity: "error" (blocks submission) vs "warning" (staff attention)
 *   - Turkish staff-facing messages per machine-readable reason code
 *   - a passport-expired WARNING via isPassportExpired (re-exported through
 *     ./passportValidity — same policy as the FAZ 2 expiry gate)
 *
 * NOTE: this module never auto-corrects data — it only reports issues.
 */

import {
  validatePassportNumber as coreValidatePassportNumber,
  validatePersonName as coreValidatePersonName,
  validateDateConsistency as coreValidateDateConsistency,
  type IdentityErrorCode,
  type IdentityValidationError,
  type DateConsistencyInput,
} from "@workspace/portal-adapters";
import { isPassportExpired } from "./passportValidity.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CriticalIssueSeverity = "error" | "warning";

export type CriticalIssueCode = IdentityErrorCode | "passport_expired";

export interface CriticalFieldIssue {
  /** Which profile field the issue is on (e.g. "passportNumber"). */
  field: string;
  /** Machine-readable reason code. */
  code: CriticalIssueCode;
  /** "error" blocks real portal submission; "warning" needs staff attention. */
  severity: CriticalIssueSeverity;
  /** Turkish staff-facing message. */
  message: string;
  /** English technical reason from the shared core (for logs). */
  reason: string;
}

export interface CriticalFieldValidationResult {
  hasErrors: boolean;
  hasWarnings: boolean;
  issues: CriticalFieldIssue[];
}

export interface CriticalIdentityInput {
  passportNumber?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  dateOfBirth?: string | null;
  passportIssueDate?: string | null;
  passportExpiryDate?: string | null;
}

// ---------------------------------------------------------------------------
// Turkish staff messages
// ---------------------------------------------------------------------------

const FIELD_LABEL_TR: Record<string, string> = {
  passportNumber: "Pasaport numarası",
  firstName: "Ad",
  lastName: "Soyad",
  dateOfBirth: "Doğum tarihi",
  passportIssueDate: "Pasaport veriliş tarihi",
  passportExpiryDate: "Pasaport geçerlilik (bitiş) tarihi",
};

function fieldLabel(field: string): string {
  return FIELD_LABEL_TR[field] ?? field;
}

function turkishMessage(err: IdentityValidationError): string {
  const label = fieldLabel(err.field);
  switch (err.code) {
    case "empty":
      return `${label} boş — bu alan doldurulmadan gerçek portal başvurusu yapılamaz.`;
    case "placeholder_value":
      return err.field === "passportNumber"
        ? `Pasaport numarası geçici/test bir değer olarak görünüyor (örn. "pending", "fixture") — henüz gerçek pasaport numarası girilmemiş.`
        : `${label} alanında geçici/test bir değer var — gerçek bilgi girilmeli.`;
    case "looks_like_national_id_not_passport":
      return `Bu numara pasaport değil, kimlik kartı (örn. CNIC) numarasına benziyor — pasaport numarası girilmeli.`;
    case "invalid_characters":
      return `${label} geçersiz karakterler içeriyor — sadece harf, rakam, boşluk ve tire kullanılabilir.`;
    case "invalid_length":
      return err.field === "passportNumber"
        ? `Pasaport numarasının uzunluğu geçersiz — boşluk/tire hariç 5 ile 12 karakter arasında olmalı.`
        : `${label} uzunluğu geçersiz.`;
    case "repeated_character":
      return `${label} tamamen aynı karakterden oluşuyor — büyük olasılıkla veri hatası.`;
    case "numeric_name":
      return `${label} hiç harf içermiyor — isim alanına sayı girilmiş görünüyor.`;
    case "unparseable_date":
      return `${label} tarih formatı okunamıyor — YYYY-AA-GG veya GG.AA.YYYY formatında olmalı.`;
    case "dob_in_future":
      return `Doğum tarihi bugün veya gelecekte olamaz — veri hatası.`;
    case "dob_before_1900":
      return `Doğum tarihi 1900'den önce görünüyor — büyük olasılıkla veri hatası.`;
    case "age_out_of_range":
      return `Doğum tarihine göre yaş üniversite başvurusu için makul aralığın dışında — tarihi kontrol edin.`;
    case "issue_date_in_future":
      return `Pasaport veriliş tarihi gelecekte — henüz geçerli olmayan bir pasaport görünüyor.`;
    case "issue_before_birth":
      return `Pasaport veriliş tarihi doğum tarihinden önce olamaz — tarihleri kontrol edin.`;
    case "expiry_before_issue":
      return `Pasaport bitiş tarihi veriliş tarihinden önce olamaz — tarihleri kontrol edin.`;
    default:
      return `${label} alanında doğrulama hatası: ${err.reason}`;
  }
}

const PASSPORT_EXPIRED_MESSAGE_TR =
  "Pasaportun geçerlilik süresi dolmuş görünüyor — başvurudan önce pasaportun yenilenmesi gerekebilir.";

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

function toIssue(err: IdentityValidationError): CriticalFieldIssue {
  return {
    field: err.field,
    code: err.code,
    severity: "error",
    message: turkishMessage(err),
    reason: err.reason,
  };
}

/** Passport number check with severity + Turkish message. */
export function checkPassportNumber(value: string | null | undefined): CriticalFieldIssue | null {
  const err = coreValidatePassportNumber(value);
  return err ? toIssue(err) : null;
}

/** Person-name check (field: "firstName" | "lastName") with Turkish message. */
export function checkPersonName(
  value: string | null | undefined,
  field: "firstName" | "lastName",
): CriticalFieldIssue | null {
  const err = coreValidatePersonName(value, field);
  return err ? toIssue(err) : null;
}

/** Date-consistency checks (DOB / issue / expiry) with Turkish messages. */
export function checkDateConsistency(input: DateConsistencyInput): CriticalFieldIssue[] {
  return coreValidateDateConsistency(input).map(toIssue);
}

/**
 * Full critical-field validation for one student/profile record.
 *
 * Errors (block real submission): all shared-core identity rules.
 * Warnings (staff attention, do NOT block here): passport already expired —
 * the dedicated FAZ 2 expiry gate owns the blocking decision for that case.
 */
export function validateCriticalIdentityFields(
  input: CriticalIdentityInput,
  now: Date = new Date(),
): CriticalFieldValidationResult {
  const issues: CriticalFieldIssue[] = [];

  const p = checkPassportNumber(input.passportNumber);
  if (p) issues.push(p);

  const fn = checkPersonName(input.firstName, "firstName");
  if (fn) issues.push(fn);

  const ln = checkPersonName(input.lastName, "lastName");
  if (ln) issues.push(ln);

  issues.push(
    ...checkDateConsistency({
      dateOfBirth: input.dateOfBirth ?? undefined,
      passportIssueDate: input.passportIssueDate ?? undefined,
      passportExpiryDate: input.passportExpiryDate ?? undefined,
      now,
    }),
  );

  // Warning: passport expired (parseable + strictly before today).
  if (
    input.passportExpiryDate &&
    !issues.some((i) => i.field === "passportExpiryDate") &&
    isPassportExpired(input.passportExpiryDate, now)
  ) {
    issues.push({
      field: "passportExpiryDate",
      code: "passport_expired",
      severity: "warning",
      message: PASSPORT_EXPIRED_MESSAGE_TR,
      reason: "Passport expiry date is in the past",
    });
  }

  return {
    hasErrors: issues.some((i) => i.severity === "error"),
    hasWarnings: issues.some((i) => i.severity === "warning"),
    issues,
  };
}
