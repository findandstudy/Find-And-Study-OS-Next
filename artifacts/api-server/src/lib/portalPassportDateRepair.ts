import {
  evaluateSitIdentity,
  sitPassportIdentityProofFromDocument,
} from "@workspace/portal-adapters";

export type RepairablePassportDateField =
  | "dateOfBirth"
  | "passportIssueDate"
  | "passportExpiryDate";

export type PassportDateRepairPatch = Partial<{
  dateOfBirth: string;
  passportIssueDate: string;
  passportExpiry: string;
}>;

export type PassportDateRepairDecision =
  | { status: "repairable"; patch: PassportDateRepairPatch; fields: string[] }
  | {
      status:
        | "no_invalid_fields"
        | "low_confidence"
        | "identity_mismatch"
        | "unreadable";
      patch: PassportDateRepairPatch;
      fields: string[];
    };

const REPAIRABLE_FIELDS = new Set<RepairablePassportDateField>([
  "dateOfBirth",
  "passportIssueDate",
  "passportExpiryDate",
]);

function validIsoDate(value: unknown): value is string {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === text;
}

function extractedDate(
  extracted: Record<string, unknown>,
  field: RepairablePassportDateField,
): string | null {
  const aliases = field === "dateOfBirth"
    ? ["dateOfBirth", "birthDate", "dob"]
    : field === "passportIssueDate"
      ? ["passportIssueDate", "issueDate"]
      : ["passportExpiry", "passportExpiryDate", "expiryDate"];
  for (const key of aliases) {
    if (validIsoDate(extracted[key])) return String(extracted[key]).trim();
  }
  return null;
}

/**
 * Produce a fail-closed repair decision for invalid passport-backed dates.
 *
 * Populated CRM values are replaced only when the latest passport extraction
 * is high-confidence and independently matches the student's name and
 * passport number. This prevents a document attached to the wrong student
 * from silently overwriting identity data.
 */
export function buildPassportDateRepairDecision(input: {
  student: {
    firstName?: string | null;
    lastName?: string | null;
    passportNumber?: string | null;
    dateOfBirth?: string | null;
    passportIssueDate?: string | null;
    passportExpiry?: string | null;
  };
  extracted: Record<string, unknown>;
  confidenceScore: number;
  documentId: number;
  invalidFields: readonly string[];
}): PassportDateRepairDecision {
  const requested = [...new Set(input.invalidFields)]
    .filter((field): field is RepairablePassportDateField =>
      REPAIRABLE_FIELDS.has(field as RepairablePassportDateField));
  if (requested.length === 0) {
    return { status: "no_invalid_fields", patch: {}, fields: [] };
  }

  const highConfidence =
    input.extracted.confidence === "high" || input.confidenceScore >= 0.9;
  if (!highConfidence) {
    return { status: "low_confidence", patch: {}, fields: [] };
  }

  const proof = sitPassportIdentityProofFromDocument({
    extractedData: input.extracted,
    confidenceScore: input.confidenceScore,
    documentId: input.documentId,
  });
  if (!proof) {
    return { status: "unreadable", patch: {}, fields: [] };
  }
  const identity = evaluateSitIdentity({
    firstName: input.student.firstName ?? "",
    lastName: input.student.lastName ?? "",
    passportNumber: input.student.passportNumber ?? "",
  }, proof);
  if (!identity.matched) {
    return {
      status: "identity_mismatch",
      patch: {},
      fields: [...new Set([
        ...identity.missingFields,
        ...identity.mismatchedFields,
      ])],
    };
  }

  const patch: PassportDateRepairPatch = {};
  const fields: string[] = [];
  for (const field of requested) {
    const value = extractedDate(input.extracted, field);
    if (!value) continue;
    const databaseField = field === "passportExpiryDate"
      ? "passportExpiry"
      : field;
    if (String(input.student[databaseField] ?? "").trim() === value) continue;
    patch[databaseField] = value;
    fields.push(field);
  }
  if (fields.length === 0) {
    return { status: "unreadable", patch: {}, fields: [] };
  }
  return { status: "repairable", patch, fields };
}
