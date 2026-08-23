import { normalizeGpaEvidenceTo100 } from "./gpaNormalize";
import { validatePassportNumber } from "@workspace/portal-adapters/identity-validation";

const MALE_VALUES = new Set(["m", "male", "man", "erkek"]);
const FEMALE_VALUES = new Set(["f", "female", "woman", "kadın", "kadin"]);

function normalizeGender(value: unknown): "male" | "female" | null {
  if (value == null) return null;
  const normalized = String(value).trim().toLocaleLowerCase("en-US");
  if (MALE_VALUES.has(normalized)) return "male";
  if (FEMALE_VALUES.has(normalized)) return "female";
  return null;
}

/**
 * Normalize the dedicated Inbox document-extraction response before it reaches
 * the browser. In particular, preserve the printed GPA for auditability and
 * only accept a value over 100 when the document supplied an explicit
 * numerator/denominator pair.
 */
export function normalizeInboxStudentExtraction(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const extracted: Record<string, unknown> = { ...input };

  if (extracted.passportNumber != null && extracted.passportNumber !== "") {
    const passportNumber = String(extracted.passportNumber).trim();
    if (validatePassportNumber(passportNumber)) {
      // Never auto-fill a passport number containing OCR punctuation or other
      // invalid evidence. The raw value is deliberately not returned to the
      // browser because a quoted/ambiguous number must be re-read by a human
      // or AI rather than copied into the student's identity record.
      extracted.passportNumber = null;
      extracted.passportNumberRejected = true;
    } else {
      extracted.passportNumber = passportNumber;
    }
  }

  if (extracted.gender != null && extracted.gender !== "") {
    extracted.gender = normalizeGender(extracted.gender);
  }

  if (extracted.graduationYear != null && extracted.graduationYear !== "") {
    const match = String(extracted.graduationYear).match(/\b(19|20)\d{2}\b/);
    extracted.graduationYear = match ? Number(match[0]) : null;
  }

  if (extracted.gpa != null && extracted.gpa !== "") {
    const raw = String(extracted.gpa).trim();
    const hasExplicitScale = /-?\d+(?:[.,]\d+)?\s*\/\s*\d+(?:[.,]\d+)?/.test(
      raw,
    );
    const bareNumber = raw.match(/^-?\d+(?:[.,]\d+)?\s*%?$/);
    const bareValue = bareNumber
      ? Number(bareNumber[0].replace("%", "").replace(",", ".").trim())
      : NaN;

    extracted.gpaRaw = raw;

    // A bare "955" is not a valid percentage and must not silently become
    // 100/100. Require the document/AI to return its printed denominator.
    if (!hasExplicitScale && Number.isFinite(bareValue) && bareValue > 100) {
      extracted.gpa = null;
      extracted.gpaScale = null;
    } else {
      const percentage = normalizeGpaEvidenceTo100(raw);
      if (Number.isFinite(percentage) && percentage >= 0 && percentage <= 100) {
        // Portal adapters expect an integer percentage.
        extracted.gpa = String(Math.round(percentage));
        extracted.gpaScale = 100;
      } else {
        extracted.gpa = null;
        extracted.gpaScale = null;
      }
    }
  }

  return extracted;
}
