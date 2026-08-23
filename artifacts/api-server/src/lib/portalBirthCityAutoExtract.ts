import { and, desc, eq, isNull, or } from "drizzle-orm";
import { db, documentsTable, studentsTable } from "@workspace/db";
import { loadDocumentBytes } from "./documentBytes.js";
import { logAudit } from "./auth.js";
import { documentAiScheduler } from "./aiLaneScheduler.js";
import { getDocumentAiConnection } from "./documentAiConnection.js";

export interface PortalBirthCityAutoExtractResult {
  status:
    | "updated"
    | "no_missing_city"
    | "no_documents"
    | "low_confidence"
    | "unreadable"
    | "ai_unavailable";
  fields: string[];
  source?: "stored" | "ai";
  documentId?: number;
}

interface BirthCityExtraction {
  cityOfBirth?: unknown;
  placeOfBirth?: unknown;
  birthPlace?: unknown;
  birthCity?: unknown;
  cityOfBirthConfidence?: unknown;
  birthPlaceConfidence?: unknown;
  evidenceLabel?: unknown;
  evidenceValue?: unknown;
  sourceDocument?: unknown;
  confidence?: unknown;
}

interface BirthCityDocumentDescriptor {
  type?: string | null;
  name?: string | null;
}

const MAX_BIRTH_CITY_DOCUMENTS = 4;
const MAX_BIRTH_CITY_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_SINGLE_DOCUMENT_BYTES = 5 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const NON_CITY_TOKEN_RE =
  /\b(?:address|street|road|avenue|house|building|district|province|region|state|country|postal|school|university|college|campus|issued|issue)\b/iu;

const PROMPT = `Extract the applicant's CITY OF BIRTH from the supplied official documents.
Return ONLY one JSON object:
{
  "cityOfBirth": "city name only or null",
  "evidenceLabel": "the exact field label printed next to the value or null",
  "evidenceValue": "the exact printed value proving the city of birth or null",
  "sourceDocument": "1-based document number or null",
  "confidence": "high|medium|low"
}
Rules:
- Never guess, infer, geocode, or use outside knowledge.
- Accept a value only when the same document explicitly identifies it as place
  of birth, birthplace, birth place, city of birth, or the equivalent label in
  the document's language.
- A residence city, current address, school city, institution location,
  nationality, issuing place, issue authority, province, district, or country
  is NOT a city of birth.
- Prefer evidence in this order: passport; national identity/birth certificate;
  diploma; transcript; another official document.
- Return only the city portion. If the printed value cannot be reduced to a
  city without guessing, return null.
- Use confidence=high only when the field label and value are both clearly
  legible. Otherwise return cityOfBirth=null and confidence=low.`;

function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function cleanBirthCityCandidate(value: unknown): string | null {
  const text = String(value ?? "")
    .trim()
    .replace(/^[,;:/\s]+|[,;:/\s]+$/g, "")
    .replace(/\s+/g, " ");
  if (
    text.length < 2 ||
    text.length > 80 ||
    /\d/u.test(text) ||
    !/\p{L}/u.test(text) ||
    NON_CITY_TOKEN_RE.test(text) ||
    text.split(/\s+/).length > 6 ||
    !/^[\p{L}\p{M}.'’\-\s]+$/u.test(text)
  ) {
    return null;
  }
  return text;
}

function parseJsonRecord(
  value: string | null | undefined,
): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readBirthCityValue(extracted: BirthCityExtraction): unknown {
  return (
    extracted.cityOfBirth ??
    extracted.placeOfBirth ??
    extracted.birthPlace ??
    extracted.birthCity
  );
}

export function parseStoredBirthCityExtraction(
  extracted: BirthCityExtraction,
): string | null {
  const confidence = String(
    extracted.cityOfBirthConfidence ?? extracted.birthPlaceConfidence ?? "",
  )
    .trim()
    .toLowerCase();
  if (confidence !== "high") return null;
  return cleanBirthCityCandidate(readBirthCityValue(extracted));
}

export function parseBirthCityAiExtraction(
  extracted: BirthCityExtraction,
  documentCount: number,
): { city: string; sourceDocument: number } | null {
  if (
    String(extracted.confidence ?? "")
      .trim()
      .toLowerCase() !== "high"
  ) {
    return null;
  }
  const city = cleanBirthCityCandidate(readBirthCityValue(extracted));
  const evidenceLabel = String(extracted.evidenceLabel ?? "").trim();
  const evidenceValue = String(extracted.evidenceValue ?? "").trim();
  const sourceDocument = Number(extracted.sourceDocument);
  if (
    !city ||
    !evidenceLabel ||
    !evidenceValue ||
    !Number.isInteger(sourceDocument) ||
    sourceDocument < 1 ||
    sourceDocument > documentCount ||
    !fold(evidenceValue).includes(fold(city))
  ) {
    return null;
  }
  return { city, sourceDocument };
}

/** Lower values are more authoritative. Negative means ineligible. */
export function birthCityDocumentPriority(
  doc: BirthCityDocumentDescriptor,
): number {
  const label = fold(`${doc.type ?? ""} ${doc.name ?? ""}`);
  if (!label || /\b(?:photo|photograph|portrait|selfie)\b/u.test(label))
    return -1;
  if (/\b(?:passport|pasaport)\b/u.test(label)) return 0;
  if (
    /\b(?:birth certificate|identity card|national id|id card|kimlik)\b/u.test(
      label,
    )
  )
    return 1;
  if (/\b(?:transcript|marksheet|mark sheet)\b/u.test(label)) return 3;
  if (/\b(?:diploma|degree|graduation certificate)\b/u.test(label)) return 2;
  if (/\b(?:certificate|official|other|document)\b/u.test(label)) return 4;
  return -1;
}

async function persistMissingBirthCity(
  studentId: number,
  city: string,
): Promise<boolean> {
  const updated = await db
    .update(studentsTable)
    .set({ cityOfBirth: city })
    .where(
      and(
        eq(studentsTable.id, studentId),
        isNull(studentsTable.deletedAt),
        or(
          isNull(studentsTable.cityOfBirth),
          eq(studentsTable.cityOfBirth, ""),
        ),
      ),
    )
    .returning({ id: studentsTable.id });
  return updated.length > 0;
}

export async function autoFillMissingBirthCityFromDocuments(opts: {
  studentId: number;
  actorUserId: number | null;
  ip?: string;
  requiredFields?: readonly string[];
  /** Skip a duplicate provider call when passport extraction already proved the AI lane unavailable. */
  allowAi?: boolean;
}): Promise<PortalBirthCityAutoExtractResult> {
  if (opts.requiredFields && !opts.requiredFields.includes("cityOfBirth")) {
    return { status: "no_missing_city", fields: [] };
  }

  const [student] = await db
    .select({ cityOfBirth: studentsTable.cityOfBirth })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.id, opts.studentId),
        isNull(studentsTable.deletedAt),
      ),
    );
  if (!student) return { status: "unreadable", fields: [] };
  if (student.cityOfBirth?.trim()) {
    return { status: "no_missing_city", fields: [] };
  }

  const rows = await db
    .select({
      id: documentsTable.id,
      name: documentsTable.name,
      type: documentsTable.type,
      fileKey: documentsTable.fileKey,
      fileData: documentsTable.fileData,
      mimeType: documentsTable.mimeType,
      extractedData: documentsTable.extractedData,
      createdAt: documentsTable.createdAt,
    })
    .from(documentsTable)
    .where(
      and(
        eq(documentsTable.studentId, opts.studentId),
        isNull(documentsTable.deletedAt),
      ),
    )
    .orderBy(desc(documentsTable.createdAt), desc(documentsTable.id));

  const documents = rows
    .map((document) => ({
      ...document,
      priority: birthCityDocumentPriority(document),
    }))
    .filter(
      (document) =>
        document.priority >= 0 &&
        Boolean(document.fileKey || document.fileData),
    )
    .sort((a, b) => a.priority - b.priority || b.id - a.id);
  if (documents.length === 0) {
    return { status: "no_documents", fields: [] };
  }

  for (const document of documents) {
    const extracted = parseJsonRecord(document.extractedData);
    const city = extracted
      ? parseStoredBirthCityExtraction(extracted as BirthCityExtraction)
      : null;
    if (!city) continue;
    const persisted = await persistMissingBirthCity(opts.studentId, city);
    if (!persisted) return { status: "no_missing_city", fields: [] };
    await logAudit(
      opts.actorUserId,
      "portal_preflight_auto_fill_birth_city",
      "student",
      opts.studentId,
      {
        documentId: document.id,
        fields: ["cityOfBirth"],
        confidence: "high",
        source: "stored",
      },
      opts.ip,
    );
    return {
      status: "updated",
      fields: ["cityOfBirth"],
      source: "stored",
      documentId: document.id,
    };
  }

  if (opts.allowAi === false) {
    return { status: "ai_unavailable", fields: [] };
  }

  const loaded: Array<{
    documentId: number;
    type: string;
    mimeType: string;
    base64: string;
  }> = [];
  let totalBytes = 0;
  for (const document of documents) {
    if (loaded.length >= MAX_BIRTH_CITY_DOCUMENTS) break;
    try {
      const bytes = await loadDocumentBytes(document);
      if (!bytes) continue;
      const mimeType = bytes.mimeType.toLowerCase();
      const supported =
        mimeType === "application/pdf" || SUPPORTED_IMAGE_TYPES.has(mimeType);
      if (
        !supported ||
        bytes.buffer.length > MAX_SINGLE_DOCUMENT_BYTES ||
        totalBytes + bytes.buffer.length > MAX_BIRTH_CITY_TOTAL_BYTES
      ) {
        continue;
      }
      totalBytes += bytes.buffer.length;
      loaded.push({
        documentId: document.id,
        type: document.type,
        mimeType,
        base64: bytes.buffer.toString("base64"),
      });
    } catch (error) {
      console.warn("[portal-birth-city] document load failed", {
        studentId: opts.studentId,
        documentId: document.id,
        errorName: error instanceof Error ? error.name : "Error",
      });
    }
  }
  if (loaded.length === 0) {
    return { status: "unreadable", fields: [] };
  }

  try {
    const connection = await getDocumentAiConnection("claude", {
      fallbackToDefault: false,
    });
    const anthropic = connection.client;
    type ContentBlock =
      | { type: "text"; text: string }
      | {
          type: "image";
          source: {
            type: "base64";
            media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
            data: string;
          };
        }
      | {
          type: "document";
          source: {
            type: "base64";
            media_type: "application/pdf";
            data: string;
          };
        };
    const content: ContentBlock[] = [{ type: "text", text: PROMPT }];
    loaded.forEach((document, index) => {
      content.push({
        type: "text",
        text: `\n--- Document ${index + 1}; type: ${document.type} ---`,
      });
      content.push(
        document.mimeType === "application/pdf"
          ? {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: document.base64,
              },
            }
          : {
              type: "image",
              source: {
                type: "base64",
                media_type: document.mimeType as
                  | "image/jpeg"
                  | "image/png"
                  | "image/gif"
                  | "image/webp",
                data: document.base64,
              },
            },
      );
    });

    const message = await documentAiScheduler.run(
      { laneKey: "portal-data-extraction", connectionKey: "claude" },
      () =>
        anthropic.messages.create({
          model: connection.model || "claude-sonnet-4-6",
          max_tokens: 512,
          messages: [{ role: "user", content: content as never }],
        }),
    );
    const block = message.content.find((item) => item.type === "text");
    const json =
      block?.type === "text" ? block.text.match(/\{[\s\S]*\}/)?.[0] : null;
    if (!json) return { status: "unreadable", fields: [], source: "ai" };
    let decoded: BirthCityExtraction;
    try {
      decoded = JSON.parse(json) as BirthCityExtraction;
    } catch {
      return { status: "unreadable", fields: [], source: "ai" };
    }
    const parsed = parseBirthCityAiExtraction(decoded, loaded.length);
    if (!parsed) {
      return { status: "low_confidence", fields: [], source: "ai" };
    }

    const sourceDocument = loaded[parsed.sourceDocument - 1];
    const persisted = await persistMissingBirthCity(
      opts.studentId,
      parsed.city,
    );
    if (!persisted) return { status: "no_missing_city", fields: [] };

    const sourceRow = documents.find(
      (document) => document.id === sourceDocument.documentId,
    );
    const existing = parseJsonRecord(sourceRow?.extractedData) ?? {};
    try {
      await db
        .update(documentsTable)
        .set({
          extractedData: JSON.stringify({
            ...existing,
            cityOfBirth: parsed.city,
            cityOfBirthConfidence: "high",
          }),
        })
        .where(
          and(
            eq(documentsTable.id, sourceDocument.documentId),
            isNull(documentsTable.deletedAt),
          ),
        );
    } catch (error) {
      // The student field is the authoritative result; a cache-write failure
      // must not turn a successfully persisted city into a false AI failure.
      console.warn("[portal-birth-city] document cache update failed", {
        studentId: opts.studentId,
        documentId: sourceDocument.documentId,
        errorName: error instanceof Error ? error.name : "Error",
      });
    }
    await logAudit(
      opts.actorUserId,
      "portal_preflight_auto_fill_birth_city",
      "student",
      opts.studentId,
      {
        documentId: sourceDocument.documentId,
        fields: ["cityOfBirth"],
        confidence: "high",
        source: "ai",
      },
      opts.ip,
    );
    return {
      status: "updated",
      fields: ["cityOfBirth"],
      source: "ai",
      documentId: sourceDocument.documentId,
    };
  } catch (error) {
    const details =
      error && typeof error === "object"
        ? (error as { name?: unknown; code?: unknown; status?: unknown })
        : {};
    console.warn("[portal-birth-city] AI extraction unavailable", {
      studentId: opts.studentId,
      errorName: String(details.name ?? "Error").slice(0, 80),
      errorCode: String(details.code ?? "unknown").slice(0, 80),
      status: Number(details.status) || undefined,
    });
    return { status: "ai_unavailable", fields: [], source: "ai" };
  }
}
