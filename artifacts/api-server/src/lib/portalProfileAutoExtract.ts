import { and, asc, desc, eq, ilike, isNull, ne, or, sql } from "drizzle-orm";
import {
  auditLogsTable,
  db,
  documentsTable,
  studentsTable,
  usersTable,
} from "@workspace/db";
import {
  evaluateSitIdentity,
  sitPassportIdentityProofFromDocument,
  validatePassportNumber,
} from "@workspace/portal-adapters";
import { loadDocumentBytes } from "./documentBytes.js";
import { normalizeInboxStudentExtraction } from "./inboxStudentExtraction.js";
import { logAudit } from "./auth.js";
import { buildPassportDateRepairDecision } from "./portalPassportDateRepair.js";
import {
  hasHighConfidencePassportIdentityExtraction,
  shouldRefreshPassportIdentityExtraction,
  stampPassportIdentityExtraction,
} from "./portalPassportExtractionPolicy.js";
import {
  buildPassportIdentitySyncDecision,
  PASSPORT_IDENTITY_FIELDS,
  type PassportIdentityField,
} from "./portalPassportIdentitySync.js";
import { documentAiScheduler } from "./aiLaneScheduler.js";
import { getDocumentAiConnection } from "./documentAiConnection.js";

export interface PortalProfileAutoExtractResult {
  status:
    | "updated"
    | "no_passport_document"
    | "no_missing_fields"
    | "low_confidence"
    | "unreadable"
    | "ai_unavailable";
  fields: string[];
}

export interface PortalPassportIdentityVerificationResult {
  status:
    | "verified"
    | "mismatch"
    | "no_passport_document"
    | "low_confidence"
    | "unreadable"
    | "ai_unavailable";
  fields: string[];
  documentId?: number;
}

export interface PortalPassportIdentitySyncResult {
  status:
    | "updated"
    | "already_matches"
    | "manual_override"
    | "passport_conflict"
    | "no_passport_document"
    | "low_confidence"
    | "unreadable"
    | "ai_unavailable";
  fields: string[];
  lockedFields: string[];
  documentId?: number;
}

export interface PortalProfileDateRepairResult {
  status:
    | "updated"
    | "no_invalid_fields"
    | "no_passport_document"
    | "identity_mismatch"
    | "low_confidence"
    | "unreadable"
    | "ai_unavailable";
  fields: string[];
  documentId?: number;
}

const PROMPT = `You extract identity data from an official passport for a university application.
Return ONLY one JSON object with these keys:
{
  "firstName": "all given names exactly as printed, or null",
  "lastName": "surname exactly as printed, or null",
  "dateOfBirth": "YYYY-MM-DD or null",
  "cityOfBirth": "city name exactly as printed in the place of birth field, or null",
  "cityOfBirthConfidence": "high|medium|low",
  "gender": "male|female or null",
  "nationality": "full English country name or null",
  "passportNumber": "string or null",
  "passportIssueDate": "YYYY-MM-DD or null",
  "passportExpiry": "YYYY-MM-DD or null",
  "motherName": "exact text or null",
  "fatherName": "exact text or null",
  "identityConfidence": "high|medium|low",
  "confidence": "high|medium|low"
}
Never guess. Passport number must be cross-checked against the MRZ when present.
Passport numbers contain letters and digits only. Never output apostrophes,
quotation marks, backticks or OCR punctuation. If any character is ambiguous,
set passportNumber to null instead of guessing or removing the character.
identityConfidence applies ONLY to firstName, lastName and passportNumber. Set it
to high only when all three are clearly legible and the passport number agrees
with the MRZ when an MRZ is present. General confidence may remain medium when a
non-identity field (for example a parent name) is unclear.
Set cityOfBirthConfidence to high only when the passport explicitly labels a
clearly legible place/city of birth. Never use residence, address, nationality,
issuing place, issuing authority, province, district or country as cityOfBirth.
If any character or date is uncertain, use null.`;

const FIELD_MAP = {
  dateOfBirth: studentsTable.dateOfBirth,
  cityOfBirth: studentsTable.cityOfBirth,
  gender: studentsTable.gender,
  nationality: studentsTable.nationality,
  passportNumber: studentsTable.passportNumber,
  passportIssueDate: studentsTable.passportIssueDate,
  passportExpiry: studentsTable.passportExpiry,
  motherName: studentsTable.motherName,
  fatherName: studentsTable.fatherName,
} as const;

type ExtractField = keyof typeof FIELD_MAP;

const has = (value: unknown): boolean =>
  value != null && String(value).trim() !== "";

const EXTRACT_ALIASES: Record<ExtractField, string[]> = {
  dateOfBirth: ["dateOfBirth", "birthDate", "dob"],
  cityOfBirth: ["cityOfBirth", "placeOfBirth", "birthPlace", "birthCity"],
  gender: ["gender", "sex"],
  nationality: ["nationality", "citizenship"],
  passportNumber: ["passportNumber", "passportNo"],
  passportIssueDate: ["passportIssueDate", "issueDate"],
  passportExpiry: ["passportExpiry", "passportExpiryDate", "expiryDate"],
  motherName: ["motherName"],
  fatherName: ["fatherName"],
};

type PassportDocument = typeof documentsTable.$inferSelect;

type PassportExtractionResult =
  | {
      status: "ok";
      document: PassportDocument;
      extracted: Record<string, unknown>;
      confidenceScore: number;
    }
  | {
      status:
        | "no_passport_document"
        | "unreadable"
        | "ai_unavailable";
      document?: PassportDocument;
    };

function readExtractedField(
  extracted: Record<string, unknown>,
  field: ExtractField,
): unknown {
  for (const key of EXTRACT_ALIASES[field]) {
    if (has(extracted[key])) return extracted[key];
  }
  return null;
}

function validIsoDate(value: unknown): value is string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}

function safeExtractedValue(
  field: ExtractField,
  value: unknown,
): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (
    field === "dateOfBirth" ||
    field === "passportIssueDate" ||
    field === "passportExpiry"
  ) {
    return validIsoDate(text) ? text : null;
  }
  if (field === "gender") {
    return /^(male|female)$/.test(text.toLowerCase())
      ? text.toLowerCase()
      : null;
  }
  if (field === "passportNumber") {
    return validatePassportNumber(text) ? null : text;
  }
  if (field === "cityOfBirth") {
    if (
      text.length < 2 ||
      text.length > 80 ||
      /\d/u.test(text) ||
      !/\p{L}/u.test(text) ||
      !/^[\p{L}\p{M}.'’\-\s]+$/u.test(text)
    ) {
      return null;
    }
    return text.replace(/\s+/g, " ");
  }
  return text.slice(0, 255);
}

function parseExtractedData(
  value: string | null | undefined,
): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function findLatestPassportDocument(
  studentId: number,
): Promise<PassportDocument | null> {
  const [document] = await db
    .select()
    .from(documentsTable)
    .where(and(
      eq(documentsTable.studentId, studentId),
      isNull(documentsTable.deletedAt),
      or(
        ilike(documentsTable.type, "%passport%"),
        ilike(documentsTable.type, "%pasaport%"),
        ilike(documentsTable.name, "%passport%"),
        ilike(documentsTable.name, "%pasaport%"),
      ),
    ))
    .orderBy(desc(documentsTable.createdAt), desc(documentsTable.id))
    .limit(1);
  return document ?? null;
}

async function loadPassportExtraction(
  studentId: number,
): Promise<PassportExtractionResult> {
  const document = await findLatestPassportDocument(studentId);
  if (!document) return { status: "no_passport_document" };

  let extracted = parseExtractedData(document.extractedData);
  let confidenceScore = document.confidenceScore ?? 0;

  // Legacy payloads either omitted identity or stored only a document-wide
  // medium score. Re-read once with identity-specific confidence, then stamp
  // the payload so an unclear source does not cause an AI request per click.
  if (shouldRefreshPassportIdentityExtraction(extracted, confidenceScore)) {
    const bytes = await loadDocumentBytes(document);
    if (!bytes) return { status: "unreadable", document };
    const mime = bytes.mimeType.toLowerCase();
    const isPdf = mime === "application/pdf";
    const supportedImage = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
    ].includes(mime);
    if (!isPdf && !supportedImage) {
      return { status: "unreadable", document };
    }

    try {
      const connection = await getDocumentAiConnection("claude", { fallbackToDefault: false });
      const anthropic = connection.client;
      const config = { model: connection.model };
      const source = {
        type: "base64" as const,
        media_type: mime,
        data: bytes.buffer.toString("base64"),
      };
      const content = isPdf
        ? [
            { type: "text" as const, text: PROMPT },
            { type: "document" as const, source },
          ]
        : [
            { type: "text" as const, text: PROMPT },
            { type: "image" as const, source },
          ];
      const message = await documentAiScheduler.run(
        { laneKey: "portal-document", connectionKey: "claude" },
        () => anthropic.messages.create({
          model: config.model || "claude-sonnet-4-6",
          max_tokens: 2048,
          messages: [{ role: "user", content: content as never }],
        }),
      );
      const textBlock = message.content.find((block) => block.type === "text");
      const json = textBlock?.type === "text"
        ? textBlock.text.match(/\{[\s\S]*\}/)?.[0]
        : null;
      if (!json) return { status: "unreadable", document };
      extracted = stampPassportIdentityExtraction(
        normalizeInboxStudentExtraction(
          JSON.parse(json) as Record<string, unknown>,
        ),
      );
      confidenceScore =
        extracted.confidence === "high"
          ? 1
          : extracted.confidence === "medium" ? 0.6 : 0.3;
      await db.update(documentsTable)
        .set({
          extractedData: JSON.stringify(extracted),
          confidenceScore,
        })
        .where(eq(documentsTable.id, document.id));
    } catch (error) {
      const details = error && typeof error === "object"
        ? error as { name?: unknown; code?: unknown; status?: unknown }
        : {};
      console.warn("[portal-passport] AI identity extraction unavailable", {
        studentId,
        documentId: document.id,
        errorName: String(details.name ?? "Error").slice(0, 80),
        errorCode: String(details.code ?? "unknown").slice(0, 80),
        status: Number(details.status) || undefined,
      });
      return { status: "ai_unavailable", document };
    }
  }

  if (!extracted) return { status: "unreadable", document };
  return { status: "ok", document, extracted, confidenceScore };
}

async function findHumanLockedPassportIdentityFields(
  studentId: number,
): Promise<Set<PassportIdentityField>> {
  const rows = await db
    .select({
      id: auditLogsTable.id,
      action: auditLogsTable.action,
      changes: auditLogsTable.changes,
      role: usersTable.role,
      createdAt: auditLogsTable.createdAt,
    })
    .from(auditLogsTable)
    .leftJoin(usersTable, eq(auditLogsTable.userId, usersTable.id))
    .where(and(
      eq(auditLogsTable.resource, "student"),
      eq(auditLogsTable.resourceId, studentId),
      or(
        eq(auditLogsTable.action, "update_student"),
        eq(
          auditLogsTable.action,
          "portal_preflight_identity_sync_updated",
        ),
        eq(
          auditLogsTable.action,
          "portal_preflight_auto_fill_identity",
        ),
      ),
    ))
    .orderBy(asc(auditLogsTable.createdAt), asc(auditLogsTable.id));

  const locked = new Set<PassportIdentityField>();
  const aiSynced = new Set<PassportIdentityField>();
  for (const row of rows) {
    try {
      const changes = JSON.parse(row.changes ?? "{}") as Record<string, unknown>;
      if (
        row.action === "portal_preflight_identity_sync_updated" ||
        row.action === "portal_preflight_auto_fill_identity"
      ) {
        const fields = Array.isArray(changes.fields) ? changes.fields : [];
        for (const field of PASSPORT_IDENTITY_FIELDS) {
          if (fields.includes(field)) aiSynced.add(field);
        }
        continue;
      }

      // Student-entered values and staff edits made before the first passport
      // synchronization do not outrank the passport. A later staff/admin/agent
      // correction does, and is locked field-by-field from that point onward.
      if (
        row.action !== "update_student" ||
        !row.role ||
        row.role === "student"
      ) continue;
      for (const field of PASSPORT_IDENTITY_FIELDS) {
        if (
          aiSynced.has(field) &&
          Object.prototype.hasOwnProperty.call(changes, field)
        ) {
          locked.add(field);
        }
      }
    } catch {
      // Old malformed audit payloads cannot safely prove a field-level edit.
    }
  }
  return locked;
}

/**
 * Synchronize populated CRM identity fields from a complete, high-confidence
 * passport proof before portal submission. Only staff/admin edits recorded
 * after an AI passport synchronization remain authoritative and are never
 * overwritten by a later preflight.
 */
export async function autoSyncProfileIdentityFromPassport(opts: {
  studentId: number;
  actorUserId: number | null;
  ip?: string;
}): Promise<PortalPassportIdentitySyncResult> {
  const [student] = await db
    .select({
      id: studentsTable.id,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      passportNumber: studentsTable.passportNumber,
    })
    .from(studentsTable)
    .where(and(
      eq(studentsTable.id, opts.studentId),
      isNull(studentsTable.deletedAt),
    ));
  if (!student) {
    return { status: "unreadable", fields: [], lockedFields: [] };
  }

  const loaded = await loadPassportExtraction(opts.studentId);
  if (loaded.status !== "ok") {
    return {
      status: loaded.status,
      fields: [],
      lockedFields: [],
      ...(loaded.document ? { documentId: loaded.document.id } : {}),
    };
  }

  const proof = sitPassportIdentityProofFromDocument({
    extractedData: loaded.extracted,
    confidenceScore: loaded.confidenceScore,
    documentId: loaded.document.id,
  });
  if (!proof) {
    return {
      status: hasHighConfidencePassportIdentityExtraction(
        loaded.extracted,
        loaded.confidenceScore,
      ) ? "unreadable" : "low_confidence",
      fields: [],
      lockedFields: [],
      documentId: loaded.document.id,
    };
  }

  const locked = await findHumanLockedPassportIdentityFields(opts.studentId);
  const normalizedPassport = proof.passportNumber
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const [duplicate] = await db
    .select({ id: studentsTable.id })
    .from(studentsTable)
    .where(and(
      ne(studentsTable.id, opts.studentId),
      isNull(studentsTable.deletedAt),
      sql`upper(regexp_replace(coalesce(${studentsTable.passportNumber}, ''), '[^A-Z0-9]', '', 'g')) = ${normalizedPassport}`,
    ))
    .limit(1);

  const decision = buildPassportIdentitySyncDecision({
    student,
    proof,
    lockedFields: locked,
    passportConflict: Boolean(duplicate),
  });
  const fields = Object.keys(decision.patch);

  if (decision.status === "updated") {
    await db.update(studentsTable)
      .set(decision.patch)
      .where(and(
        eq(studentsTable.id, opts.studentId),
        isNull(studentsTable.deletedAt),
      ));
  }

  await logAudit(
    opts.actorUserId,
    `portal_preflight_identity_sync_${decision.status}`,
    "student",
    opts.studentId,
    {
      documentId: loaded.document.id,
      fields,
      mismatchedFields: decision.mismatchedFields,
      lockedFields: decision.lockedFields,
      confidence: "high",
    },
    opts.ip,
  );
  return {
    status: decision.status,
    fields,
    lockedFields: decision.lockedFields,
    documentId: loaded.document.id,
  };
}

/**
 * Independently verify CRM name + passport number against the latest passport
 * document. Synchronization is deliberately performed by the separate helper
 * above; this final verifier stays read-only and fail-closed.
 */
export async function verifyStudentIdentityAgainstPassport(opts: {
  studentId: number;
  actorUserId: number | null;
  ip?: string;
}): Promise<PortalPassportIdentityVerificationResult> {
  const [student] = await db
    .select()
    .from(studentsTable)
    .where(and(
      eq(studentsTable.id, opts.studentId),
      isNull(studentsTable.deletedAt),
    ));
  if (!student) return { status: "unreadable", fields: [] };

  const loaded = await loadPassportExtraction(opts.studentId);
  if (loaded.status !== "ok") {
    return {
      status: loaded.status,
      fields: [],
      ...(loaded.document ? { documentId: loaded.document.id } : {}),
    };
  }

  const proof = sitPassportIdentityProofFromDocument({
    extractedData: loaded.extracted,
    confidenceScore: loaded.confidenceScore,
    documentId: loaded.document.id,
  });
  if (!proof) {
    const highConfidence = hasHighConfidencePassportIdentityExtraction(
      loaded.extracted,
      loaded.confidenceScore,
    );
    return {
      status: highConfidence ? "unreadable" : "low_confidence",
      fields: [],
      documentId: loaded.document.id,
    };
  }

  const evaluation = evaluateSitIdentity(
    {
      firstName: student.firstName ?? "",
      lastName: student.lastName ?? "",
      passportNumber: student.passportNumber ?? "",
    },
    proof,
  );
  const fields = [...new Set([
    ...evaluation.missingFields,
    ...evaluation.mismatchedFields,
  ])];
  const status = evaluation.matched ? "verified" : "mismatch";
  await logAudit(
    opts.actorUserId,
    `portal_preflight_identity_${status}`,
    "student",
    opts.studentId,
    { documentId: loaded.document.id, fields, confidence: "high" },
    opts.ip,
  );
  return { status, fields, documentId: loaded.document.id };
}

export async function autoFillMissingProfileFromPassport(opts: {
  studentId: number;
  actorUserId: number | null;
  ip?: string;
  requiredFields?: readonly string[];
}): Promise<PortalProfileAutoExtractResult> {
  const [student] = await db
    .select()
    .from(studentsTable)
    .where(and(
      eq(studentsTable.id, opts.studentId),
      isNull(studentsTable.deletedAt),
    ));
  if (!student) return { status: "unreadable", fields: [] };

  const requested = opts.requiredFields
    ? new Set(opts.requiredFields)
    : null;
  const isRequested = (field: ExtractField): boolean =>
    !requested ||
    requested.has(field) ||
    (field === "passportExpiry" && requested.has("passportExpiryDate"));
  const missing = (Object.keys(FIELD_MAP) as ExtractField[])
    .filter((field) => isRequested(field) && !has(student[field]));
  if (missing.length === 0) {
    return { status: "no_missing_fields", fields: [] };
  }

  const loaded = await loadPassportExtraction(opts.studentId);
  if (loaded.status !== "ok") {
    return { status: loaded.status, fields: [] };
  }
  const { document, extracted, confidenceScore } = loaded;

  const highConfidence = hasHighConfidencePassportIdentityExtraction(
    extracted,
    confidenceScore,
  );
  if (!highConfidence) return { status: "low_confidence", fields: [] };

  const patch: Record<string, string> = {};
  for (const field of missing) {
    if (
      field === "cityOfBirth" &&
      String(extracted.cityOfBirthConfidence ?? "").trim().toLowerCase() !== "high"
    ) {
      continue;
    }
    const value = safeExtractedValue(
      field,
      readExtractedField(extracted, field),
    );
    if (value) patch[field] = value;
  }
  if (Object.keys(patch).length === 0) {
    return { status: "unreadable", fields: [] };
  }

  await db.update(studentsTable)
    .set(patch)
    .where(and(
      eq(studentsTable.id, opts.studentId),
      isNull(studentsTable.deletedAt),
    ));

  const fields = Object.keys(patch);
  await logAudit(
    opts.actorUserId,
    "portal_preflight_auto_fill_identity",
    "student",
    opts.studentId,
    { documentId: document.id, fields, confidence: "high" },
    opts.ip,
  );
  return { status: "updated", fields };
}

export async function autoRepairInvalidProfileDatesFromPassport(opts: {
  studentId: number;
  actorUserId: number | null;
  ip?: string;
  invalidFields: readonly string[];
}): Promise<PortalProfileDateRepairResult> {
  const [student] = await db
    .select()
    .from(studentsTable)
    .where(and(
      eq(studentsTable.id, opts.studentId),
      isNull(studentsTable.deletedAt),
    ));
  if (!student) return { status: "unreadable", fields: [] };

  const requested = opts.invalidFields.filter((field) =>
    field === "dateOfBirth" ||
    field === "passportIssueDate" ||
    field === "passportExpiryDate");
  if (requested.length === 0) {
    return { status: "no_invalid_fields", fields: [] };
  }

  const loaded = await loadPassportExtraction(opts.studentId);
  if (loaded.status !== "ok") {
    return {
      status: loaded.status,
      fields: [],
      ...(loaded.document ? { documentId: loaded.document.id } : {}),
    };
  }

  const decision = buildPassportDateRepairDecision({
    student,
    extracted: loaded.extracted,
    confidenceScore: loaded.confidenceScore,
    documentId: loaded.document.id,
    invalidFields: requested,
  });
  if (decision.status !== "repairable") {
    return {
      status: decision.status,
      fields: decision.fields,
      documentId: loaded.document.id,
    };
  }

  await db.update(studentsTable)
    .set(decision.patch)
    .where(and(
      eq(studentsTable.id, opts.studentId),
      isNull(studentsTable.deletedAt),
    ));
  await logAudit(
    opts.actorUserId,
    "portal_preflight_auto_repair_identity_dates",
    "student",
    opts.studentId,
    {
      documentId: loaded.document.id,
      fields: decision.fields,
      confidence: "high",
    },
    opts.ip,
  );
  return {
    status: "updated",
    fields: decision.fields,
    documentId: loaded.document.id,
  };
}
