import { Router, type IRouter, type Request, type Response, type NextFunction, json } from "express";
import * as XLSX from "xlsx";
import { z } from "zod";
import { requireAuth, requireRole, requireAgentStaffPermission, logAudit } from "../lib/auth";
import { STAFF_ROLES } from "../lib/roles";
import { validate, getValidated } from "../middlewares/validate";
import { normalizeGpaEvidenceTo100 } from "../lib/gpaNormalize";
import { canonicalCountry, cleanCity } from "@workspace/db";
import {
  buildExtractionPrompt,
  getActiveExtractor,
  isFallbackExtractor,
  recordExtractorRun,
} from "../lib/aiExtractorService";
import {
  db,
  educationRecordsTable,
  studentsTable,
  applicationsTable,
  programsTable,
} from "@workspace/db";
import { eq, desc, and, isNull } from "drizzle-orm";
import { isPassportExpired } from "../lib/passportValidity";
import {
  buildEducationPromptSection,
  mapExtractionToEducation,
  decideLegacyEducationAutoUpsert,
} from "../lib/educationExtraction";
import { EXTRACT_PROMPT } from "../lib/extractPrompt";
import { runEducationExtraction } from "../lib/educationAutoExtract";
import { AiLaneQueueError, documentAiScheduler } from "../lib/aiLaneScheduler";
import { getDocumentAiConnection } from "../lib/documentAiConnection";
import { normalizeInboxStudentExtraction } from "../lib/inboxStudentExtraction";
import {
  DocumentPartMergeError,
  mergeDocumentParts,
  type DocumentPartInput,
} from "../lib/documentPartMerge";

// AI extraction endpoints accept base64-encoded PDF/image documents in the
// JSON body. Base64 inflates payload size by ~33%, and the route itself
// allows up to 10 MB of raw document data — so the global 1mb body limit
// blocks legitimate requests before they reach the route. These routes are
// gated by requireAuth + aiRateLimit so a higher local limit is acceptable.
const aiJson = json({ limit: "20mb" });

/**
 * Convert whatever GPA string the AI extracted from a diploma/transcript
 * into a 0-100 percentage number. The AI is allowed to return the value
 * in its native scale (e.g. "3.5/4", "85%", "15/20") and we normalize it
 * server-side so every consumer (panel form, public-apply form, widget)
 * sees the same percent value. Returns the original raw string in
 * `gpaRaw` for traceability and a rounded percent string in `gpa`.
 */
function normalizeExtractedGpa(extracted: Record<string, any>): void {
  if (extracted.gpa == null || extracted.gpa === "") return;
  const raw = String(extracted.gpa);
  const pct = normalizeGpaEvidenceTo100(raw);
  if (!isNaN(pct)) {
    extracted.gpaRaw = raw;
    // Portal compatibility: SIT/Zoho rejects decimal GPA — integer 0–100.
    extracted.gpa = String(Math.min(100, Math.max(0, Math.round(pct))));
    extracted.gpaScale = 100;
  }
}

function applyExtractorNormalize(extractor: { fields: any[] }, extracted: Record<string, any>): void {
  for (const f of (extractor.fields as any[]) || []) {
    if (f.normalize === "gpa100" && extracted[f.key] != null && extracted[f.key] !== "") {
      const pct = normalizeGpaEvidenceTo100(String(extracted[f.key]));
      if (!isNaN(pct)) {
        extracted[`${f.key}Raw`] = extracted[f.key];
        // Portal compatibility: integer 0–100 (SIT/Zoho rejects decimals).
        extracted[f.key] = String(Math.min(100, Math.max(0, Math.round(pct))));
        extracted[`${f.key}Scale`] = 100;
      }
    }
  }
}

const router: IRouter = Router();

const aiRateLimitMap = new Map<string, { count: number; resetAt: number }>();
function aiRateLimit(maxRequests: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `ai:${(req as any).user?.id || req.ip}`;
    const now = Date.now();
    const entry = aiRateLimitMap.get(key);
    if (!entry || now > entry.resetAt) {
      aiRateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (entry.count >= maxRequests) {
      res.status(429).json({ error: "Too many requests. Please try again later." });
      return;
    }
    entry.count++;
    next();
  };
}

const DEFAULT_VISION_MODEL = "claude-sonnet-4-6";
const DEFAULT_CSV_MODEL = "claude-haiku-4-5";

// EXTRACT_PROMPT moved to ../lib/extractPrompt (shared with educationAutoExtract).

router.post(
  "/ai/merge-document-parts",
  requireAuth,
  aiRateLimit(30, 15 * 60 * 1000),
  aiJson,
  async (req, res): Promise<void> => {
    try {
      const documentType = String(req.body?.documentType || "").trim();
      const label = String(req.body?.label || documentType).trim();
      const parts = req.body?.parts as DocumentPartInput[];
      if (!documentType || !label) {
        res.status(400).json({ error: "Document type and label are required." });
        return;
      }
      const merged = await mergeDocumentParts(documentType, label, parts);
      res.json(merged);
    } catch (error) {
      if (error instanceof DocumentPartMergeError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      console.error("[document-part-merge] authenticated merge failed", {
        userId: (req as any).user?.id,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Document parts could not be merged." });
    }
  },
);

router.post("/ai/extract-document", requireAuth, aiRateLimit(10, 15 * 60 * 1000), aiJson, async (req, res): Promise<void> => {
  const runStart = Date.now();
  const requestedLang = ((req as any).body?.lang || req.headers["accept-language"] || "en").toString().slice(0, 2);
  // The authenticated /ai/extract-document endpoint is shared between staff
  // and agent panels. Clients may pass a `scope` field so admins can wire a
  // separate extractor (prompt, fields, model) per audience.
  const requestedScope = ((req as any).body?.scope || "staff").toString();
  const scope: "staff" | "agent" = requestedScope === "agent" ? "agent" : "staff";
  const extractor = await getActiveExtractor(scope);
  try {
    const { documents } = req.body as {
      documents: Array<{
        type: "image" | "pdf";
        data: string;
        mediaType: string;
        label: string;
      }>;
    };

    if (!documents || !Array.isArray(documents) || documents.length === 0) {
      res.status(400).json({ error: "No documents provided" });
      return;
    }

    let anthropic;
    let claudeConfig;
    try {
      const connection = await getDocumentAiConnection("claude", { fallbackToDefault: false });
      anthropic = connection.client;
      claudeConfig = { model: connection.model };
    } catch (err: any) {
      res.status(503).json({ error: err.message || "AI integration not configured" });
      return;
    }

    if (extractor.provider !== "anthropic") {
      res.status(400).json({
        error: `Provider "${extractor.provider}" is not yet wired into the runtime. Set the active extractor's provider to "anthropic" in the admin panel.`,
      });
      return;
    }
    // Backward compatibility: when no DB extractor is configured for this scope,
    // keep the exact legacy prompt + token defaults so existing callers see no
    // behavioural change. As soon as an admin defines an extractor, the dynamic
    // prompt + per-extractor model/tokens take over.
    const useLegacy = isFallbackExtractor(extractor);
    let promptText = useLegacy ? EXTRACT_PROMPT : buildExtractionPrompt(extractor, { lang: requestedLang });

    // FAZ 3 — level-based education extraction. Resolve the applied study
    // level from the student's interestedLevel, falling back to the level
    // (degree) of the most recent application's program. When resolvable,
    // instruct the AI which education records to fill.
    let appliedLevelKey: string | null = null;
    {
      const studentIdParam = Number((req.body as { studentId?: unknown })?.studentId);
      const explicitLevel = (req.body as { appliedLevel?: unknown })?.appliedLevel;
      if (typeof explicitLevel === "string" && explicitLevel.trim()) {
        appliedLevelKey = explicitLevel.trim();
      } else if (Number.isFinite(studentIdParam) && studentIdParam > 0) {
        try {
          const [stu] = await db.select({ interestedLevel: studentsTable.interestedLevel })
            .from(studentsTable)
            .where(and(eq(studentsTable.id, studentIdParam), isNull(studentsTable.deletedAt)));
          if (stu?.interestedLevel && stu.interestedLevel.trim()) {
            appliedLevelKey = stu.interestedLevel.trim();
          } else {
            const [appRow] = await db.select({ degree: programsTable.degree })
              .from(applicationsTable)
              .innerJoin(programsTable, eq(applicationsTable.programId, programsTable.id))
              .where(eq(applicationsTable.studentId, studentIdParam))
              .orderBy(desc(applicationsTable.id))
              .limit(1);
            if (appRow?.degree && appRow.degree.trim()) appliedLevelKey = appRow.degree.trim();
          }
        } catch (levelErr) {
          console.warn("[ai-extract] applied-level lookup failed (non-fatal):", levelErr);
        }
      }
    }
    if (appliedLevelKey) {
      promptText += "\n" + buildEducationPromptSection(appliedLevelKey);
    }

    const contentBlocks: any[] = [
      { type: "text", text: promptText },
    ];

    for (const doc of documents) {
      contentBlocks.push({
        type: "text",
        text: `\n--- Document: ${doc.label} ---`,
      });

      if (doc.type === "image") {
        const validMediaTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
        const mediaType = validMediaTypes.includes(doc.mediaType) ? doc.mediaType : "image/jpeg";
        contentBlocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
            data: doc.data,
          },
        });
      } else {
        contentBlocks.push({
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: doc.data,
          },
        });
      }
    }

    const model = useLegacy
      ? (claudeConfig.model || DEFAULT_VISION_MODEL)
      : (extractor.model || claudeConfig.model || DEFAULT_VISION_MODEL);
    const maxTokens = useLegacy ? 8192 : (extractor.maxTokens || 8192);
    const message = await documentAiScheduler.run(
      { laneKey: scope === "agent" ? "agent-document" : "staff-document", connectionKey: "claude" },
      () => anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: contentBlocks }],
      }),
    );

    const textBlock = message.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      res.status(500).json({ error: "No response from AI" });
      return;
    }

    let extracted: Record<string, any> = {};
    try {
      const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        extracted = JSON.parse(jsonMatch[0]);
      }
    } catch {
      res.status(500).json({ error: "Failed to parse AI response" });
      return;
    }

    if (useLegacy) {
      normalizeExtractedGpa(extracted);
    } else {
      applyExtractorNormalize(extractor, extracted);
    }

    extracted = normalizeInboxStudentExtraction(extracted) as Record<string, any>;
    const warnings: string[] = [];
    if (extracted.passportNumberRejected === true) {
      warnings.push(
        "Passport number could not be read reliably. Please enter it manually from the passport; quotation marks are not allowed.",
      );
      delete extracted.passportNumberRejected;
    }

    if (extracted.passportExpiry) {
      const parts = String(extracted.passportExpiry).split("-").map(Number);
      const expiryDate = parts.length === 3 ? new Date(parts[0], parts[1] - 1, parts[2]) : new Date(NaN);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (!isNaN(expiryDate.getTime()) && expiryDate < today) {
        extracted.passportExpired = true;
        warnings.push(`Passport has expired on ${extracted.passportExpiry}. This passport cannot be used for applications.`);
      } else if (!isNaN(expiryDate.getTime())) {
        extracted.passportExpired = false;
      }
    }

    // FAZ 3 — stable soft-warning code (never blocks extraction). Frontend
    // translates this in Faz 4; keep the code stable.
    if (isPassportExpired(typeof extracted.passportExpiry === "string" ? extracted.passportExpiry : null)) {
      if (!warnings.includes("PASSPORT_EXPIRED")) warnings.push("PASSPORT_EXPIRED");
    }

    // Portal Uyumluluk Katmanı — soft normalization of residence country and
    // city. Never blocks extraction; unmatched values are cleared with a
    // stable warning code so the UI can flag them.
    if (extracted.countryOfResidence != null && String(extracted.countryOfResidence).trim() !== "") {
      const rawResidence = String(extracted.countryOfResidence).trim();
      const canon = canonicalCountry(rawResidence);
      if (canon) {
        extracted.countryOfResidence = canon;
      } else {
        extracted.countryOfResidenceRaw = rawResidence;
        extracted.countryOfResidence = null;
        warnings.push("RESIDENCE_COUNTRY_UNMATCHED");
      }
    }
    if (extracted.city != null && String(extracted.city).trim() !== "") {
      const rawCity = String(extracted.city).trim();
      const cleaned = cleanCity(rawCity);
      if (cleaned) {
        extracted.city = cleaned;
      } else {
        extracted.cityRaw = rawCity;
        extracted.city = null;
        warnings.push("CITY_UNCLEAN");
      }
    }

    // FAZ 3 — map AI educationRecords[] to the PUT /students/:id/education
    // body shape, filtered/ordered by the applied level's required records,
    // with the GPA-percent guarantee applied.
    const education = appliedLevelKey
      ? mapExtractionToEducation(extracted.educationRecords, appliedLevelKey)
      : [];

    // FIX-15D (FAZ 2 refactor): Auto-upsert education_records when diploma or
    // transcript is extracted and a studentId is provided in the request body.
    // Confidence gating now uses the SHARED core rule
    // (decideLegacyEducationAutoUpsert / educationRecordHasData): low
    // confidence never blanket-skips — a record with at least one readable
    // field is still saved (partial-save) and flagged LOW_CONFIDENCE_EDUCATION.
    const studentIdRaw = (req.body as any)?.studentId;
    const eduUpserted = { skipped: true, level: null as string | null };
    let lowConfidenceEducationSaved = false;
    if (studentIdRaw && /diploma|transcript|degree/i.test(String(extracted.documentType || ""))) {
      const studentId = Number(studentIdRaw);
      if (Number.isFinite(studentId) && studentId > 0) {
        try {
          // Determine education level — eduLevel canonical field takes priority.
          const eduLevelNorm = String(extracted.eduLevel || "").toLowerCase().replace(/[-\s]+/g, "_").trim();
          let level: "high_school" | "bachelor" | "master";
          if (eduLevelNorm === "high_school" || eduLevelNorm === "high school" || eduLevelNorm === "highschool") {
            level = "high_school";
          } else if (eduLevelNorm === "master") {
            level = "master";
          } else if (eduLevelNorm === "bachelor") {
            level = "bachelor";
          } else {
            // Fallback: keyword scan of degree / level / documentType fields
            const degreeRaw = String(extracted.degree || extracted.level || extracted.documentType || "").toLowerCase();
            if (/high.?school|secondary|lisans öncesi/i.test(degreeRaw)) level = "high_school";
            else if (/master|msc|ma\b|mba|graduate/i.test(degreeRaw)) level = "master";
            else level = "bachelor";
          }

          // Derive gpaType from gpaScale returned by normalizer
          const gpaType: string | null =
            extracted.gpaScale === 100 ? "percentage" :
            extracted.gpaScale === 4   ? "4.0" :
            null;

          // Parse graduation year from extracted data for endYear
          const endYear = extracted.graduationYear
            ? Number(String(extracted.graduationYear).slice(0, 4))
            : null;

          // Parse start year from extracted data
          const startYearRaw = extracted.eduStartYear
            ? Number(String(extracted.eduStartYear).slice(0, 4))
            : null;
          const startYear = Number.isFinite(startYearRaw) && startYearRaw! > 1900 ? startYearRaw : null;

          const upsertRow = {
            studentId,
            level,
            schoolName:    extracted.institutionName ?? extracted.schoolName ?? null,
            country:       extracted.country ?? null,
            city:          extracted.eduCity ?? null,
            fieldOfStudy:  extracted.fieldOfStudy ?? extracted.major ?? null,
            startMonth:    extracted.eduStartMonth ?? null,
            startYear,
            endMonth:      extracted.eduEndMonth ?? null,
            endYear:       Number.isFinite(endYear) ? endYear : null,
            gpa:           extracted.gpa ? String(extracted.gpa) : null,
            gpaType,
            languageScore: extracted.eduLanguageScore ?? null,
            source:        "ai_extracted" as const,
          };

          // Shared low-confidence gate: save when at least one readable field
          // is present (partial-save), skip only truly empty low-conf records.
          const gate = decideLegacyEducationAutoUpsert({
            confidence: extracted.confidence,
            record: {
              level,
              institution: upsertRow.schoolName != null ? String(upsertRow.schoolName) : null,
              program: upsertRow.fieldOfStudy != null ? String(upsertRow.fieldOfStudy) : null,
              graduationYear: upsertRow.endYear,
              gpa: upsertRow.gpa,
              gpaRaw: upsertRow.gpa,
              gpaScale: null,
              languageScore: upsertRow.languageScore != null ? String(upsertRow.languageScore) : null,
            },
          });

          if (gate.save) {
            await db
              .insert(educationRecordsTable)
              .values(upsertRow)
              .onConflictDoUpdate({
                target: [educationRecordsTable.studentId, educationRecordsTable.level],
                set: {
                  ...upsertRow,
                  updatedAt: new Date(),
                },
              });
            eduUpserted.skipped = false;
            eduUpserted.level = level;
            if (gate.lowConfidence) {
              lowConfidenceEducationSaved = true;
              warnings.push("LOW_CONFIDENCE_EDUCATION");
            }
          }
        } catch (upsertErr) {
          // Non-fatal — AI extraction result is still returned to client.
          console.warn("[ai-extract] education_records upsert failed (non-fatal):", upsertErr);
        }
      }
    }

    if (extracted.confidence === "low") {
      extracted.extractedNotes = [
        extracted.extractedNotes,
        lowConfidenceEducationSaved
          ? "LOW_CONFIDENCE_EDUCATION: Low confidence — education record was auto-saved with the readable fields (partial-save). Please review."
          : "Low confidence — extracted fields were not auto-saved. Please review and save manually.",
      ].filter(Boolean).join(" ");
    }

    res.json({ extracted, warnings, extractorId: extractor.id || null, eduUpserted, education, appliedLevel: appliedLevelKey });
    await recordExtractorRun({
      extractorId: extractor.id,
      scope: "staff",
      documentCount: documents.length,
      documentTypes: [extracted.documentType].filter(Boolean) as string[],
      model,
      promptTokens: (message as any).usage?.input_tokens ?? null,
      completionTokens: (message as any).usage?.output_tokens ?? null,
      latencyMs: Date.now() - runStart,
      status: "success",
      triggeredBy: (req as any).user?.id ?? null,
    });
  } catch (err: any) {
    console.error("AI extraction error:", err);
    res.status(err instanceof AiLaneQueueError ? 503 : 500).json({
      error: err instanceof AiLaneQueueError
        ? "AI analysis is busy. Your documents remain available; please retry shortly."
        : "AI extraction failed",
    });
    await recordExtractorRun({
      extractorId: extractor.id,
      scope: "staff",
      documentCount: 0,
      model: extractor.model,
      latencyMs: Date.now() - runStart,
      status: "error",
      errorMessage: String(err?.message || err),
      triggeredBy: (req as any).user?.id ?? null,
    });
  }
});

const LEAD_FIELDS = [
  "firstName", "lastName", "email", "phone", "nationality",
  "interestedProgram", "interestedUniversity", "interestedCountry",
  "source", "estimatedValue", "notes",
];
const STUDENT_FIELDS = [
  "firstName", "lastName", "email", "phone", "nationality", "dateOfBirth",
  "passportNumber", "highSchool", "graduationYear", "gpa", "languageScore",
  "motherName", "fatherName", "passportExpiry", "passportIssueDate", "address", "notes",
];

// Maximum data rows accepted per bulk import to protect the DB / request budget.
const BULK_CSV_MAX_ROWS = 5000;

function normHeader(h: string): string {
  return String(h ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Synonyms shared by both entities (names, contact, nationality, notes).
const SHARED_SYNONYMS: Record<string, string> = {
  firstname: "firstName", fname: "firstName", givenname: "firstName", givennames: "firstName",
  ad: "firstName", adi: "firstName", isim: "firstName", name: "firstName",
  lastname: "lastName", surname: "lastName", lname: "lastName", familyname: "lastName",
  soyad: "lastName", soyadi: "lastName", soyisim: "lastName",
  email: "email", emailaddress: "email", mail: "email", eposta: "email", epostaadresi: "email",
  phone: "phone", phonenumber: "phone", mobile: "phone", mobilephone: "phone", tel: "phone",
  telephone: "phone", telefon: "phone", gsm: "phone", cep: "phone", ceptelefonu: "phone", whatsapp: "phone",
  nationality: "nationality", citizenship: "nationality", uyruk: "nationality", milliyet: "nationality",
  notes: "notes", note: "notes", comment: "notes", comments: "notes", remarks: "notes",
  aciklama: "notes", description: "notes",
};
const LEAD_SYNONYMS: Record<string, string> = {
  interestedprogram: "interestedProgram", program: "interestedProgram", programofinterest: "interestedProgram",
  bolum: "interestedProgram", department: "interestedProgram", major: "interestedProgram",
  interesteduniversity: "interestedUniversity", university: "interestedUniversity", uni: "interestedUniversity",
  universite: "interestedUniversity",
  interestedcountry: "interestedCountry", destinationcountry: "interestedCountry", targetcountry: "interestedCountry",
  hedefulke: "interestedCountry", country: "interestedCountry",
  source: "source", leadsource: "source", kaynak: "source",
  estimatedvalue: "estimatedValue", value: "estimatedValue", dealvalue: "estimatedValue",
  amount: "estimatedValue", deger: "estimatedValue", tutar: "estimatedValue", budget: "estimatedValue",
};
const STUDENT_SYNONYMS: Record<string, string> = {
  dateofbirth: "dateOfBirth", dob: "dateOfBirth", birthdate: "dateOfBirth", birthday: "dateOfBirth",
  dogumtarihi: "dateOfBirth",
  passportnumber: "passportNumber", passportno: "passportNumber", passport: "passportNumber",
  pasaport: "passportNumber", pasaportno: "passportNumber",
  highschool: "highSchool", school: "highSchool", lise: "highSchool",
  graduationyear: "graduationYear", gradyear: "graduationYear", mezuniyetyili: "graduationYear",
  gpa: "gpa", gradepointaverage: "gpa", ortalama: "gpa",
  languagescore: "languageScore", langscore: "languageScore", ielts: "languageScore",
  toefl: "languageScore", dilpuani: "languageScore",
  mothername: "motherName", anneadi: "motherName",
  fathername: "fatherName", babaadi: "fatherName",
  passportexpiry: "passportExpiry", passportexpiration: "passportExpiry", passportexpirydate: "passportExpiry",
  passportissuedate: "passportIssueDate", passportissue: "passportIssueDate",
  address: "address", adres: "address",
};

function buildHeaderMap(isLead: boolean): Record<string, string> {
  const fields = isLead ? LEAD_FIELDS : STUDENT_FIELDS;
  const map: Record<string, string> = {};
  // Canonical field names always map to themselves.
  for (const f of fields) map[normHeader(f)] = f;
  Object.assign(map, SHARED_SYNONYMS, isLead ? LEAD_SYNONYMS : STUDENT_SYNONYMS);
  // Drop any synonym whose target isn't valid for this entity.
  const valid = new Set(fields);
  for (const k of Object.keys(map)) {
    if (!valid.has(map[k])) delete map[k];
  }
  return map;
}

/**
 * Parse a CSV string into a header row + data rows using SheetJS so quoting,
 * embedded commas and newlines are handled correctly.
 */
function parseCsvRows(csvData: string): string[][] {
  const wb = XLSX.read(csvData, { type: "string", raw: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const sheet = wb.Sheets[sheetName];
  return XLSX.utils.sheet_to_json<string[]>(sheet, {
    header: 1,
    defval: "",
    blankrows: false,
    raw: false,
  });
}

router.post("/ai/extract-bulk-csv", requireAuth, aiRateLimit(20, 15 * 60 * 1000), aiJson, async (req, res): Promise<void> => {
  try {
    const { csvData, entity } = req.body as { csvData: string; entity?: "student" | "lead" };
    if (!csvData || !csvData.trim()) {
      res.status(400).json({ error: "No CSV data provided" });
      return;
    }
    const isLead = entity === "lead";
    const fields = isLead ? LEAD_FIELDS : STUDENT_FIELDS;

    const rows = parseCsvRows(csvData);
    if (rows.length < 2) {
      res.json({ students: [], records: [] });
      return;
    }

    const headers = (rows[0] || []).map((h) => String(h ?? "").trim());
    const headerMap = buildHeaderMap(isLead);
    const colToField: (string | null)[] = headers.map((h) => headerMap[normHeader(h)] ?? null);

    // Fuzzy header fallback: if the required name columns weren't recognized,
    // ask the AI to map ONLY the header names (a tiny payload, never row data).
    const haveName = colToField.includes("firstName") && colToField.includes("lastName");
    if (!haveName) {
      const unmappedIdx = colToField
        .map((f, i) => (f === null ? i : -1))
        .filter((i) => i >= 0 && headers[i]);
      if (unmappedIdx.length > 0) {
        try {
          const connection = await getDocumentAiConnection("claude", { fallbackToDefault: false });
          const anthropic = connection.client;
          const claudeConfig = { model: connection.model };
          const msg = await documentAiScheduler.run(
            { laneKey: "staff-csv", connectionKey: "claude" },
            () => anthropic.messages.create({
              model: claudeConfig.model || DEFAULT_CSV_MODEL,
              max_tokens: 1024,
              messages: [{
                role: "user",
                content: `Map each CSV column header to exactly one of these canonical field names, or null if none fit. Canonical fields: ${fields.join(", ")}.
Return ONLY a JSON object whose keys are the EXACT header strings and whose values are a canonical field name or null. No explanation.
Headers: ${JSON.stringify(unmappedIdx.map((i) => headers[i]))}`,
              }],
            }),
          );
          const tb = msg.content.find((b) => b.type === "text");
          if (tb && tb.type === "text") {
            const m = tb.text.match(/\{[\s\S]*\}/);
            if (m) {
              const mapping = JSON.parse(m[0]) as Record<string, string | null>;
              const validSet = new Set(fields);
              for (const i of unmappedIdx) {
                const target = mapping[headers[i]];
                if (target && validSet.has(target) && !colToField.includes(target)) {
                  colToField[i] = target;
                }
              }
            }
          }
        } catch (err) {
          // AI mapping is best-effort; deterministic mapping still applies.
          console.warn("CSV header AI-mapping fallback failed:", (err as any)?.message || err);
        }
      }
    }

    const records: Record<string, any>[] = [];
    for (let r = 1; r < rows.length && records.length < BULK_CSV_MAX_ROWS; r++) {
      const row = rows[r] || [];
      const rec: Record<string, any> = {};
      for (let c = 0; c < colToField.length; c++) {
        const field = colToField[c];
        if (!field) continue;
        const raw = row[c];
        const v = raw == null ? "" : String(raw).trim();
        if (v === "") continue;
        rec[field] = v;
      }
      // Skip fully empty rows; rows missing names are reported by the bulk insert.
      if (rec.firstName || rec.lastName) records.push(rec);
    }

    res.json({ students: records, records });
  } catch (err: any) {
    console.error("CSV parse error:", err);
    res.status(500).json({ error: "CSV parsing failed" });
  }
});

// ---------------------------------------------------------------------------
// FAZ 1 — POST /ai/students/:id/extract-education
//
// Sends ALL of a student's education-related documents (transcript, diploma,
// "other"; never photo/passport) to the AI in ONE messages.create call, maps
// the returned educationRecords[] to the PUT /students/:id/education body
// shape via mapExtractionToEducation, and idempotently upserts them into
// student_education_records level-by-level (no duplicates thanks to the
// partial unique index on (student_id, level) WHERE deleted_at IS NULL).
//
// Critical gate fix vs /ai/extract-document: even when the AI reports
// confidence === "low", a record is STILL saved as long as at least one of
// institution/program/gpa/graduationYear/languageScore is non-null — the
// response then carries a "LOW_CONFIDENCE_EDUCATION" warning instead of
// silently dropping readable data.
// ---------------------------------------------------------------------------

const extractEducationParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

router.post(
  "/ai/students/:id/extract-education",
  requireAuth,
  requireRole(...STAFF_ROLES),
  requireAgentStaffPermission("students"),
  aiRateLimit(10, 15 * 60 * 1000),
  validate({ params: extractEducationParamsSchema }),
  async (req, res): Promise<void> => {
    const { id: studentId } = getValidated<{ params: typeof extractEducationParamsSchema }>(req).params;
    try {
      // Core moved to ../lib/educationAutoExtract so the automatic
      // document-upload trigger reuses EXACTLY the same logic.
      const result = await runEducationExtraction({
        studentId,
        actorUserId: req.user!.id,
        ip: req.ip,
      });
      switch (result.status) {
        case "not_found":
          res.status(404).json({ error: "Student not found" });
          return;
        case "ai_unavailable":
          res.status(503).json({ error: result.error });
          return;
        case "ai_failed":
          console.error("[ai-extract-education] extraction failed:", result.error);
          res.status(500).json({ error: "AI extraction failed" });
          return;
        case "skipped_filled":
          // Manual endpoint never sets skipIfFilled — unreachable, kept for
          // exhaustiveness.
          res.json({ records: [], warnings: [], levelKey: null, upserted: 0 });
          return;
        case "ok":
          res.json({
            records: result.records,
            warnings: result.warnings,
            levelKey: result.levelKey,
            upserted: result.upserted,
          });
          return;
      }
    } catch (err) {
      console.error("[ai-extract-education] extraction failed:", err);
      res.status(500).json({ error: "AI extraction failed" });
    }
  },
);

export default router;
