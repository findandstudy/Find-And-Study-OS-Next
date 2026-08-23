/**
 * portalReadiness — Portal Uyumluluk Katmanı Faz 3 (soft gate).
 *
 * Pure computation of "is this student's profile ready for portal X?"
 * against the @workspace/db portal field matrix (portalRequirements) and
 * normalization utilities. NEVER blocks a submission — callers only show
 * warnings (manual path stays unlimited).
 *
 * Field resolution notes (CRM ↔ SIT matrix):
 * - countryOfResidence: CRM has no residence-country column; the SIT adapter
 *   falls back to nationality, so readiness mirrors that fallback.
 * - addressCity/postalCode: dedicated structured CRM columns. Legacy SIT's
 *   generic `city` rule may still inspect a short, city-like address only when
 *   addressCity is absent; Altınbaş never uses that fallback.
 * - fatherJob/motherJob: no CRM column and the adapter never sends them —
 *   skipped (evaluating them would flag every student forever).
 * - toggles (transferStudent/hasTcId/hasBlueCard): NOT NULL booleans with
 *   defaults → always present.
 */
import {
  portalRequirements,
  requiredEducationLevels,
  canonicalCountry,
  cleanCity,
  normalizeGpaInteger,
  formatDateISO,
  type FieldRule,
  type EducationLevel,
  type Student,
  type EducationRecord,
} from "@workspace/db";

export interface ReadinessIncompatibility {
  field: string;
  reason: string;
}

export interface PortalReadiness {
  ready: boolean;
  /** False when this portal does not yet have a readiness specification. */
  supported: boolean;
  portal: string;
  level: EducationLevel | null;
  missing: string[];
  incompatible: ReadinessIncompatibility[];
  /** rules that exist in the matrix but have no CRM source — informational */
  skipped: string[];
}

/** Fields in the matrix with no CRM source (never evaluated). */
const UNMAPPED_KEYS = new Set(["fatherJob", "motherJob"]);

/** Boolean toggle columns are NOT NULL with defaults — always satisfied. */
const ALWAYS_PRESENT_KEYS = new Set(["transferStudent", "hasTcId", "hasBlueCard"]);

const has = (v: string | null | undefined): boolean =>
  v != null && String(v).trim() !== "";

function findRecord(records: EducationRecord[], level: string): EducationRecord | undefined {
  return records.find((r) => r.level === level);
}

/**
 * Derive the matrix level parameter from the student's target study level:
 * prior-education chain [high_school] → "high_school", [bachelor] →
 * "bachelor", [bachelor, master] → "master".
 */
export function matrixLevelForInterestedLevel(interestedLevel: string | null | undefined): EducationLevel | null {
  if (!interestedLevel || !interestedLevel.trim()) return null;
  const prior = requiredEducationLevels(interestedLevel.trim());
  if (prior.length === 0) return null;
  if (prior.includes("master")) return "master";
  if (prior.includes("bachelor")) return "bachelor";
  return "high_school";
}

export function computeReadiness(
  student: Student,
  educationRecords: EducationRecord[],
  portalKey: string,
  documentTypes: string[] = [],
): PortalReadiness {
  const level = matrixLevelForInterestedLevel(student.interestedLevel) ?? "high_school";
  const rules = portalRequirements(portalKey, level);
  const missing: string[] = [];
  const incompatible: ReadinessIncompatibility[] = [];
  const skipped: string[] = [];

  const docTypesLower = new Set(documentTypes.map((t) => String(t).toLowerCase()));
  const hasDoc = (kind: string): boolean => {
    if (kind === "photo") {
      return student.hasPhoto || has(student.photoUrl) || docTypesLower.has("photo") || docTypesLower.has("photograph");
    }
    return docTypesLower.has(kind);
  };

  const eduField = (key: string): {
    value: string | null;
    rec: EducationRecord | undefined;
    kind: "country" | "school" | "gpa" | "endYear" | "gpaType";
  } | null => {
    const m = /^(hs|bachelor|master)(Country|Name|School|Gpa|EndYear|GpaType)$/.exec(key);
    if (!m) return null;
    const lvl = m[1] === "hs" ? "high_school" : m[1];
    const rec = findRecord(educationRecords, lvl);
    const kind =
      m[2] === "Country" ? "country" :
      m[2] === "Gpa" ? "gpa" :
      m[2] === "EndYear" ? "endYear" :
      m[2] === "GpaType" ? "gpaType" :
      "school";
    const value =
      kind === "country" ? rec?.country ?? null :
      kind === "gpa" ? rec?.gpa ?? null :
      kind === "endYear" ? rec?.endYear != null ? String(rec.endYear) : null :
      kind === "gpaType" ? rec?.gpaType ?? null :
      rec?.schoolName ?? null;
    return { value, rec, kind };
  };

  for (const rule of rules) {
    if (!rule.required) continue;
    if (UNMAPPED_KEYS.has(rule.key)) { skipped.push(rule.key); continue; }
    if (ALWAYS_PRESENT_KEYS.has(rule.key)) continue;

    if (rule.type === "document") {
      if (!hasDoc(rule.key)) missing.push(rule.key);
      continue;
    }

    const edu = eduField(rule.key);
    if (edu) {
      if (!has(edu.value)) { missing.push(rule.key); continue; }
      if (edu.kind === "country" && !canonicalCountry(edu.value)) {
        incompatible.push({ field: rule.key, reason: "countryUnmatched" });
      } else if (edu.kind === "gpa" && rule.type === "integer") {
        const intGpa = normalizeGpaInteger(edu.value);
        if (intGpa == null) {
          incompatible.push({ field: rule.key, reason: "gpaMustBeInteger" });
        } else if (String(edu.value).trim() !== String(intGpa)) {
          // present but decimal / out of 0-100 integer form
          incompatible.push({ field: rule.key, reason: "gpaMustBeInteger" });
        }
      } else if (rule.type === "integer") {
        const numeric = Number(edu.value);
        if (
          !Number.isInteger(numeric) ||
          (rule.min != null && numeric < rule.min) ||
          (rule.max != null && numeric > rule.max)
        ) {
          incompatible.push({ field: rule.key, reason: "invalidInteger" });
        }
      } else if (
        rule.type === "enum" &&
        rule.values &&
        !rule.values.includes(String(edu.value).toLowerCase())
      ) {
        incompatible.push({ field: rule.key, reason: "invalidValue" });
      }
      continue;
    }

    let value: string | null = null;
    switch (rule.key) {
      case "dob": value = student.dateOfBirth; break;
      case "gender": value = student.gender; break;
      case "nationality": value = student.nationality; break;
      case "passportNo": value = student.passportNumber; break;
      case "passportIssueDate": value = student.passportIssueDate; break;
      case "passportExpiryDate": value = student.passportExpiry; break;
      case "email": value = student.email; break;
      case "mobile": value = student.phone; break;
      // Adapter falls back to nationality when CRM has no residence country.
      case "countryOfResidence": value = student.nationality; break;
      case "city": value = student.addressCity ?? cleanCityFromAddress(student.address); break;
      case "address": value = student.address; break;
      case "addressCity": value = student.addressCity; break;
      case "postalCode": value = student.postalCode; break;
      case "needsVisaSupport":
        value =
          student.needsVisaSupport == null
            ? null
            : student.needsVisaSupport ? "yes" : "no";
        break;
      case "fatherName": value = student.fatherName; break;
      case "motherName": value = student.motherName; break;
      case "languageScore": value = student.languageScore; break;
      default:
        skipped.push(rule.key);
        continue;
    }

    if (!has(value)) { missing.push(rule.key); continue; }

    switch (rule.type) {
      case "country":
        if (!canonicalCountry(value)) incompatible.push({ field: rule.key, reason: "countryUnmatched" });
        break;
      case "city":
        if (!cleanCity(value)) incompatible.push({ field: rule.key, reason: "cityUnclean" });
        break;
      case "date": {
        const iso = formatDateISO(value);
        if (!iso) {
          incompatible.push({ field: rule.key, reason: "invalidDate" });
        } else if (rule.key === "passportExpiryDate" && iso < new Date().toISOString().slice(0, 10)) {
          incompatible.push({ field: rule.key, reason: "passportExpired" });
        }
        break;
      }
      case "enum":
        if (rule.values && !rule.values.includes(String(value).toLowerCase())) {
          incompatible.push({ field: rule.key, reason: "invalidValue" });
        } else if (
          portalKey === "altinbas" &&
          rule.key === "needsVisaSupport" &&
          String(value).toLowerCase() === "yes"
        ) {
          incompatible.push({
            field: rule.key,
            reason: "questionnaireFollowupUnmapped",
          });
        }
        break;
      default:
        break;
    }
  }

  return {
    ready: missing.length === 0 && incompatible.length === 0,
    supported: rules.length > 0,
    portal: portalKey,
    level,
    missing,
    incompatible,
    skipped,
  };
}

/**
 * Legacy fallback for portals whose matrix still asks for generic `city`.
 * Altınbaş asks for `addressCity` and therefore never reaches this function.
 * A bare city-like value may pass; address-like text is rejected.
 */
function cleanCityFromAddress(address: string | null): string | null {
  return cleanCity(address);
}
