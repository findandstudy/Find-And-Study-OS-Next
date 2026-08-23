// FAZ 3 — AI agent lead capture & document tracking.
//
// This module turns the inbox intake bot from a "replier" into a funnel
// advancer. On each handled inbound message (while the bot is enabled) the
// engine calls in here to:
//   1. Run a SEPARATE, confident-only structured extraction (own Claude call,
//      test-overridable) over the conversation transcript.
//   2. Idempotently create OR update a native Lead, matched by phone/email so a
//      duplicate is never produced, link it to the conversation, and advance
//      the pipeline stage forward (never downgrade).
//   3. Record inbound media (PDF/photo) as `documents` rows on the lead/student
//      and compute which level-appropriate documents are still missing so the
//      bot can prompt for them.
//
// Everything here is best-effort: callers wrap calls in try/catch so a capture
// or extraction failure never blocks the auto-reply.
import {
  db,
  conversationsTable,
  externalContactsTable,
  messagesTable,
  leadsTable,
  studentsTable,
  documentsTable,
} from "@workspace/db";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getAnthropicClient } from "@workspace/integrations-anthropic-ai";
import {
  getDocEquivalenceGroup,
  getRelevantGroupsForLevel,
  type DocEquivalenceGroupId,
} from "@workspace/doc-equivalence";
import { DEFAULT_BOT_MODEL } from "./aiAgentConfig";
import { validateStudentDocumentFile } from "@workspace/file-upload-validation";
import { resolveIdentity } from "./identityResolver";
import { directOrigin } from "../originHelper";
import { applyLeadAssignmentRules } from "../leadAssignment";
import { toLatinUpper, normalizePhoneField } from "../textNormalize";

// Dedicated extraction model — cheap + structured. Independent of the reply
// model so cost is bounded.
const STRUCTURED_EXTRACTION_MODEL = DEFAULT_BOT_MODEL;

// How many transcript turns we feed the extractor. Intake is short-turn.
const EXTRACTION_HISTORY_LIMIT = 40;

// ---------------------------------------------------------------------------
// Structured extraction (separate Claude call + test seam)
// ---------------------------------------------------------------------------

export interface StructuredLeadFields {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  motherName: string | null;
  fatherName: string | null;
  program: string | null;
  language: string | null;
  country: string | null;
  city: string | null;
  university: string | null;
  department: string | null;
  campus: string | null;
  gender: string | null;
  checkInDate: string | null;
  duration: string | null;
  /** Free-form budget text as the student stated it (e.g. "5000 USD/year"). */
  budget: string | null;
  /** Raw study level as stated (e.g. "master", "lisans"); normalized later. */
  level: string | null;
}

export interface StructuredExtractionInput {
  transcript: string;
}

const EMPTY_FIELDS: StructuredLeadFields = {
  firstName: null,
  lastName: null,
  email: null,
  motherName: null,
  fatherName: null,
  program: null,
  language: null,
  country: null,
  city: null,
  university: null,
  department: null,
  campus: null,
  gender: null,
  checkInDate: null,
  duration: null,
  budget: null,
  level: null,
};

// Test seam: tests override the extractor to assert capture/upsert behavior
// without spending tokens or needing an API key.
let __structuredExtractionOverride:
  | ((input: StructuredExtractionInput) => Promise<StructuredLeadFields>)
  | null = null;
export function __setStructuredExtractionOverrideForTests(
  fn: ((input: StructuredExtractionInput) => Promise<StructuredLeadFields>) | null,
): void {
  __structuredExtractionOverride = fn;
}

const STRUCTURED_EXTRACTION_SYSTEM =
  "You are a CRM intake data extractor for an international study-abroad agency. " +
  "Read the WhatsApp conversation and extract ONLY the fields you are CONFIDENT about. " +
  "If a field is not explicitly and clearly stated, return null for it — never guess, never infer.\n" +
  "Return ONLY valid JSON with this exact shape — no markdown, no explanation:\n" +
  '{ "firstName": string|null, "lastName": string|null, "email": string|null, ' +
  '"motherName": string|null, "fatherName": string|null, "program": string|null, ' +
  '"language": string|null, "country": string|null, "budget": string|null, "level": string|null }\n' +
  'Also include: "city", "university", "department", "campus", "gender", "checkInDate", "duration" as string|null.\n' +
  '- "program": the field/program of study they want (e.g. "Computer Engineering").\n' +
  '- "language": preferred language of instruction (e.g. "English").\n' +
  '- "country": destination country they want to study in.\n' +
  '- "budget": yearly budget exactly as stated.\n' +
  '- "level": study level as stated (e.g. "bachelor", "master", "phd", "associate").';

const extractionSchema = z.object({
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  motherName: z.string().nullable(),
  fatherName: z.string().nullable(),
  program: z.string().nullable(),
  language: z.string().nullable(),
  country: z.string().nullable(),
  city: z.string().nullable(),
  university: z.string().nullable(),
  department: z.string().nullable(),
  campus: z.string().nullable(),
  gender: z.string().nullable(),
  checkInDate: z.string().nullable(),
  duration: z.string().nullable(),
  budget: z.string().nullable(),
  level: z.string().nullable(),
});

/** Normalize "" / whitespace-only model output to null. */
function nullifyBlank(v: string | null): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t ? t : null;
}

function sanitizeFields(raw: StructuredLeadFields): StructuredLeadFields {
  return {
    firstName: nullifyBlank(raw.firstName),
    lastName: nullifyBlank(raw.lastName),
    email: nullifyBlank(raw.email),
    motherName: nullifyBlank(raw.motherName),
    fatherName: nullifyBlank(raw.fatherName),
    program: nullifyBlank(raw.program),
    language: nullifyBlank(raw.language),
    country: nullifyBlank(raw.country),
    city: nullifyBlank(raw.city),
    university: nullifyBlank(raw.university),
    department: nullifyBlank(raw.department),
    campus: nullifyBlank(raw.campus),
    gender: nullifyBlank(raw.gender),
    checkInDate: nullifyBlank(raw.checkInDate),
    duration: nullifyBlank(raw.duration),
    budget: nullifyBlank(raw.budget),
    level: nullifyBlank(raw.level),
  };
}

/**
 * Run the confident-only structured extraction over a transcript. Honors the
 * test override. Throws on a malformed model response (caller wraps).
 */
export async function extractStructuredLead(
  input: StructuredExtractionInput,
): Promise<StructuredLeadFields> {
  if (__structuredExtractionOverride) {
    return sanitizeFields(await __structuredExtractionOverride(input));
  }
  const anthropic = await getAnthropicClient();
  const aiResponse = await anthropic.messages.create({
    model: STRUCTURED_EXTRACTION_MODEL,
    max_tokens: 400,
    system: STRUCTURED_EXTRACTION_SYSTEM,
    messages: [{ role: "user", content: `Conversation:\n${input.transcript}` }],
  });
  const textBlock = aiResponse.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("AI returned no text");
  return sanitizeFields(extractionSchema.parse(JSON.parse(textBlock.text.trim())));
}

// ---------------------------------------------------------------------------
// Study-level normalization → doc-equivalence level keys.
// ---------------------------------------------------------------------------

/**
 * Map a free-form study-level string (English/Turkish, any case) to the
 * normalized level keys used by APPLY_FORM_GROUPS_BY_LEVEL
 * (pre_bachelors | bachelors | masters | phd | others). Returns null when it
 * can't confidently classify — callers treat null as "no doc requirements".
 */
export function normalizeLevel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (/(phd|ph\.d|doctor|doktora|doctora)/.test(s)) return "phd";
  if (/(master|yüksek lisans|yuksek lisans|m\.?sc|m\.?a\b|graduate)/.test(s)) return "masters";
  if (/(associate|önlisans|onlisans|ön lisans|on lisans|foundation|pre[- ]?bachelor)/.test(s)) {
    return "pre_bachelors";
  }
  if (/(bachelor|undergrad|lisans|b\.?sc|b\.?a\b|licence|license)/.test(s)) return "bachelors";
  return null;
}

// ---------------------------------------------------------------------------
// Pipeline stage advancement (forward-only).
// ---------------------------------------------------------------------------

// Advisory-lock namespaces (arbitrary, file-local) used to serialize concurrent
// bot writes. maybeAutoReply runs fire-and-forget, so two inbound messages can
// reach capture concurrently; these locks prevent duplicate leads / document rows.
const LEAD_CAPTURE_LOCK_NS = 7311;
const DOC_CAPTURE_LOCK_NS = 7312;

const STAGE_RANK: Record<string, number> = {
  new: 0,
  contacted: 1,
  interested: 2,
  qualified: 3,
  converted: 4,
  lost: 5,
};

/**
 * Decide the stage the bot's gathered information justifies. The bot never
 * jumps past "qualified" — converting / losing a lead is a human/finance
 * decision.
 */
export function computeTargetStage(fields: StructuredLeadFields, hasContact: boolean): string {
  const hasName = Boolean(fields.firstName || fields.lastName);
  const hasIntent = Boolean(fields.program || fields.level);
  const hasReach = Boolean(fields.email || hasContact);
  if (hasName && hasIntent && hasReach) return "qualified";
  if (
    fields.program ||
    fields.level ||
    fields.country ||
    fields.budget ||
    fields.language ||
    fields.email
  ) {
    return "interested";
  }
  return "contacted";
}

/**
 * Return the further-along of two stages. Terminal stages (converted/lost) and
 * any unknown custom stage are never overwritten by the bot.
 */
export function advanceStage(current: string | null | undefined, target: string): string {
  const cur = current ?? "new";
  const curRank = STAGE_RANK[cur];
  const tgtRank = STAGE_RANK[target];
  // Unknown current stage (custom pipeline) — leave it untouched.
  if (curRank === undefined) return cur;
  if (tgtRank === undefined) return cur;
  // Never pull a converted/lost lead back into the active funnel.
  if (cur === "converted" || cur === "lost") return cur;
  return tgtRank > curRank ? target : cur;
}

type AccommodationSlotKey = "city" | "university" | "department" | "campus" | "gender" | "checkInDate" | "duration" | "budget";

function mergeAccommodationSlots(
  educationData: unknown,
  fields: StructuredLeadFields,
): { value: Record<string, unknown>; changed: boolean } {
  const root = educationData && typeof educationData === "object"
    ? { ...(educationData as Record<string, unknown>) }
    : {};
  const current = root.accommodationSlots && typeof root.accommodationSlots === "object"
    ? { ...(root.accommodationSlots as Record<string, unknown>) }
    : {};
  const candidates: Record<AccommodationSlotKey, string | null> = {
    city: fields.city,
    university: fields.university,
    department: fields.department,
    campus: fields.campus,
    gender: fields.gender,
    checkInDate: fields.checkInDate,
    duration: fields.duration,
    budget: fields.budget,
  };
  let changed = false;
  for (const [key, value] of Object.entries(candidates)) {
    if (value && !current[key]) {
      current[key] = value;
      changed = true;
    }
  }
  if (changed) root.accommodationSlots = current;
  return { value: root, changed };
}

export async function getAccommodationSlotInstruction(leadId: number | null): Promise<string> {
  if (!leadId) return "";
  const [lead] = await db.select({ educationData: leadsTable.educationData })
    .from(leadsTable)
    .where(eq(leadsTable.id, leadId));
  const root = lead?.educationData && typeof lead.educationData === "object"
    ? lead.educationData as Record<string, unknown>
    : {};
  const slots = root.accommodationSlots && typeof root.accommodationSlots === "object"
    ? root.accommodationSlots as Record<string, unknown>
    : {};
  const filled = Object.entries(slots).filter(([, value]) => typeof value === "string" && value.trim());
  if (!filled.length) return "";
  return [
    "## Persisted accommodation intake slots",
    ...filled.map(([key, value]) => `- ${key}: ${value}`),
    "- Treat these as already supplied. Never ask for them again unless the student explicitly gives a conflicting value; then ask which value is correct.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Lead upsert (idempotent by phone/email).
// ---------------------------------------------------------------------------

export interface CaptureResult {
  leadId: number | null;
  studentId: number | null;
  /** true when a NEW lead row was created (vs. an existing one updated). */
  created: boolean;
  /** The lead's stage after capture (null when no lead was touched). */
  stage: string | null;
  /** Normalized study level resolved for this contact, if any. */
  level: string | null;
}

const NO_CAPTURE: CaptureResult = {
  leadId: null,
  studentId: null,
  created: false,
  stage: null,
  level: null,
};

async function buildTranscript(conversationId: number): Promise<string> {
  const rows = await db
    .select({ direction: messagesTable.direction, content: messagesTable.content })
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, conversationId))
    .orderBy(asc(messagesTable.createdAt))
    .limit(EXTRACTION_HISTORY_LIMIT);
  return rows
    .map((m) => `[${m.direction === "inbound" ? "Customer" : "Agent"}] ${m.content}`)
    .join("\n");
}

/**
 * Extract from the conversation transcript and idempotently create/update the
 * linked Lead. Matched by phone/email via resolveIdentity so a contact who
 * writes from a new conversation never produces a duplicate lead. Advances the
 * pipeline stage forward and links the lead to the conversation's contact.
 *
 * When the contact is already a Student, no lead is created — we return the
 * student id so document tracking can still attach to it.
 */
export async function captureLeadFromConversation(opts: {
  conversationId: number;
}): Promise<CaptureResult> {
  const { conversationId } = opts;

  const [conv] = await db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.id, conversationId));
  if (!conv || !conv.externalContactId) return NO_CAPTURE;

  const [contact] = await db
    .select()
    .from(externalContactsTable)
    .where(eq(externalContactsTable.id, conv.externalContactId));
  if (!contact) return NO_CAPTURE;

  // Already a student — don't create a lead; surface the (live) student id so
  // document tracking can attach to it.
  if (contact.studentId != null) {
    const [stu] = await db
      .select({ id: studentsTable.id, level: studentsTable.interestedLevel })
      .from(studentsTable)
      .where(and(eq(studentsTable.id, contact.studentId), isNull(studentsTable.deletedAt)));
    if (stu) {
      return { ...NO_CAPTURE, studentId: stu.id, level: normalizeLevel(stu.level) };
    }
  }

  const transcript = await buildTranscript(conversationId);
  let fields: StructuredLeadFields = EMPTY_FIELDS;
  if (transcript.trim()) {
    try {
      fields = await extractStructuredLead({ transcript });
    } catch {
      fields = EMPTY_FIELDS;
    }
  }

  const email = fields.email?.toLowerCase() || contact.email?.toLowerCase() || null;
  const phone = contact.phoneE164 || contact.phone || null;
  const phoneE164 = contact.phoneE164 || null;
  const normalizedLevel = normalizeLevel(fields.level);

  // Find an existing live lead: prefer the one already linked to this contact,
  // else resolve by phone/email.
  let existingLeadId: number | null = null;
  if (contact.leadId != null) {
    const [row] = await db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(and(eq(leadsTable.id, contact.leadId), isNull(leadsTable.deletedAt)));
    if (row) existingLeadId = row.id;
  }
  if (existingLeadId == null) {
    const resolution = await resolveIdentity({ phone, email });
    const leadCandidate = resolution.candidates.find((c) => c.type === "lead");
    if (leadCandidate) existingLeadId = leadCandidate.id;
    const studentCandidate = resolution.candidates.find((c) => c.type === "student");
    // If they're already a student (matched by phone/email), link + skip lead.
    if (!leadCandidate && studentCandidate) {
      await db
        .update(externalContactsTable)
        .set({ studentId: studentCandidate.id })
        .where(eq(externalContactsTable.id, contact.id));
      await db
        .update(conversationsTable)
        .set({ unmatched: false })
        .where(eq(conversationsTable.id, conversationId));
      const [stu] = await db
        .select({ level: studentsTable.interestedLevel })
        .from(studentsTable)
        .where(eq(studentsTable.id, studentCandidate.id));
      return {
        ...NO_CAPTURE,
        studentId: studentCandidate.id,
        level: normalizedLevel ?? normalizeLevel(stu?.level),
      };
    }
  }

  const budgetNumeric = parseBudget(fields.budget);

  if (existingLeadId != null) {
    // ---- UPDATE: fill empty columns only (never clobber human edits) -------
    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, existingLeadId));
    if (!lead) return NO_CAPTURE;

    const patch: Record<string, unknown> = {};
    const fillIfEmpty = (col: keyof typeof lead, value: string | null) => {
      if (value && !lead[col]) patch[col as string] = value;
    };
    fillIfEmpty("email", email);
    fillIfEmpty("interestedProgram", fields.program);
    fillIfEmpty("interestedUniversity", fields.university);
    fillIfEmpty("interestedCountry", fields.country);
    fillIfEmpty("interestedLevel", fields.level);
    fillIfEmpty("preferredLanguage", fields.language);
    fillIfEmpty("motherName", fields.motherName ? toLatinUpper(fields.motherName) : null);
    fillIfEmpty("fatherName", fields.fatherName ? toLatinUpper(fields.fatherName) : null);
    if (budgetNumeric != null && (lead.estimatedValue == null || lead.estimatedValue === "")) {
      patch.estimatedValue = budgetNumeric;
    }
    if (phone && !lead.phone) patch.phone = normalizePhoneField(phone);
    if (contact.phoneE164 && !lead.phoneE164) patch.phoneE164 = contact.phoneE164;
    const slotMerge = mergeAccommodationSlots(lead.educationData, fields);
    if (slotMerge.changed) patch.educationData = slotMerge.value;

    const target = computeTargetStage(fields, Boolean(phone || email));
    const nextStage = advanceStage(lead.status, target);
    if (nextStage !== lead.status) patch.status = nextStage;

    if (Object.keys(patch).length > 0) {
      await db.update(leadsTable).set(patch).where(eq(leadsTable.id, lead.id));
    }

    // Ensure the contact + conversation are linked to this lead.
    if (contact.leadId !== lead.id) {
      await db
        .update(externalContactsTable)
        .set({ leadId: lead.id })
        .where(eq(externalContactsTable.id, contact.id));
    }
    if (conv.unmatched) {
      await db
        .update(conversationsTable)
        .set({ unmatched: false })
        .where(eq(conversationsTable.id, conversationId));
    }

    return {
      leadId: lead.id,
      studentId: null,
      created: false,
      stage: nextStage,
      level: normalizedLevel ?? normalizeLevel(lead.interestedLevel),
    };
  }

  // ---- CREATE (serialized by identity to prevent duplicate leads) ---------
  // maybeAutoReply is fire-and-forget, so two inbound messages can run this path
  // concurrently. Lock on EVERY identifier this capture can be deduped by, in a deterministic
  // (sorted) order so concurrent workers acquire them in the same order → no
  // deadlock. Two workers that share ANY identifier — even when one extracted an
  // email and the other only has the phone — serialize on the shared lock, and
  // the in-lock recheck (below) dedups by the same identifiers.
  const normalizedPhone = phone ? normalizePhoneField(phone) : null;
  const identityKeys = Array.from(
    new Set(
      [
        email ? `email:${email}` : null,
        phoneE164 ? `phone:${phoneE164}` : null,
        normalizedPhone ? `phone:${normalizedPhone}` : null,
      ].filter((k): k is string => k != null),
    ),
  ).sort();
  const lockKeys = identityKeys.length > 0 ? identityKeys : [`contact:${contact.id}`];
  const firstNameRaw = fields.firstName || (contact.displayName || "").split(/\s+/)[0] || "Lead";
  const lastNameRaw =
    fields.lastName ||
    (contact.displayName || "").split(/\s+/).slice(1).join(" ") ||
    "Contact";
  const stage = computeTargetStage(fields, Boolean(phone || email));

  const result = await db.transaction(async (tx) => {
    for (const key of lockKeys) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(${LEAD_CAPTURE_LOCK_NS}, hashtext(${key}))`,
      );
    }

    // Re-check under the lock by all known identifiers (phoneE164, email, and
    // the normalized phone fallback when phoneE164 is absent).
    const dupConds = [
      phoneE164 ? eq(leadsTable.phoneE164, phoneE164) : null,
      email ? eq(sql`lower(${leadsTable.email})`, email) : null,
      normalizedPhone ? eq(leadsTable.phone, normalizedPhone) : null,
    ].filter((c): c is NonNullable<typeof c> => c != null);
    const [dup] = dupConds.length
      ? await tx
          .select()
          .from(leadsTable)
          .where(and(isNull(leadsTable.deletedAt), or(...dupConds)))
          .limit(1)
      : [undefined];

    if (dup) {
      const patch: Record<string, unknown> = {};
      const fillIfEmpty = (col: keyof typeof dup, value: string | null) => {
        if (value && !dup[col]) patch[col as string] = value;
      };
      fillIfEmpty("email", email);
      fillIfEmpty("interestedProgram", fields.program);
      fillIfEmpty("interestedUniversity", fields.university);
      fillIfEmpty("interestedCountry", fields.country);
      fillIfEmpty("interestedLevel", fields.level);
      fillIfEmpty("preferredLanguage", fields.language);
      fillIfEmpty("motherName", fields.motherName ? toLatinUpper(fields.motherName) : null);
      fillIfEmpty("fatherName", fields.fatherName ? toLatinUpper(fields.fatherName) : null);
      if (budgetNumeric != null && (dup.estimatedValue == null || dup.estimatedValue === "")) {
        patch.estimatedValue = budgetNumeric;
      }
      if (phone && !dup.phone) patch.phone = normalizePhoneField(phone);
      if (contact.phoneE164 && !dup.phoneE164) patch.phoneE164 = contact.phoneE164;
      const slotMerge = mergeAccommodationSlots(dup.educationData, fields);
      if (slotMerge.changed) patch.educationData = slotMerge.value;
      const nextStage = advanceStage(dup.status, stage);
      if (nextStage !== dup.status) patch.status = nextStage;
      if (Object.keys(patch).length > 0) {
        await tx.update(leadsTable).set(patch).where(eq(leadsTable.id, dup.id));
      }
      await tx
        .update(externalContactsTable)
        .set({ leadId: dup.id })
        .where(eq(externalContactsTable.id, contact.id));
      await tx
        .update(conversationsTable)
        .set({ unmatched: false })
        .where(eq(conversationsTable.id, conversationId));
      return { lead: dup, created: false, stage: nextStage };
    }

    const [inserted] = await tx
      .insert(leadsTable)
      .values({
        firstName: toLatinUpper(firstNameRaw).slice(0, 100),
        lastName: toLatinUpper(lastNameRaw).slice(0, 100),
        email: email || null,
        phone: phone ? normalizePhoneField(phone) : null,
        phoneE164: contact.phoneE164 || null,
        country: fields.country || null,
        interestedProgram: fields.program || null,
        interestedUniversity: fields.university || null,
        interestedCountry: fields.country || null,
        interestedLevel: fields.level || null,
        preferredLanguage: fields.language || null,
        motherName: fields.motherName ? toLatinUpper(fields.motherName) : null,
        fatherName: fields.fatherName ? toLatinUpper(fields.fatherName) : null,
        estimatedValue: budgetNumeric != null ? budgetNumeric : null,
        educationData: mergeAccommodationSlots(null, fields).value,
        source: conv.channel,
        status: stage,
        ...directOrigin(),
      })
      .returning();

    await tx
      .update(externalContactsTable)
      .set({ leadId: inserted.id })
      .where(eq(externalContactsTable.id, contact.id));
    await tx
      .update(conversationsTable)
      .set({ unmatched: false })
      .where(eq(conversationsTable.id, conversationId));
    return { lead: inserted, created: true, stage };
  });

  if (result.created) {
    await applyLeadAssignmentRules({
      ...result.lead,
      channelAccountId: conv.channelAccountId,
    });
  }

  return {
    leadId: result.lead.id,
    studentId: null,
    created: result.created,
    stage: result.stage,
    level: normalizedLevel ?? normalizeLevel(result.lead.interestedLevel),
  };
}

/** Parse a free-form budget string to a numeric string (or null). */
function parseBudget(raw: string | null): string | null {
  if (!raw) return null;
  // Keep digits and a single decimal separator; strip currency words/symbols.
  const cleaned = raw.replace(/[, ]/g, "").match(/\d+(\.\d+)?/);
  if (!cleaned) return null;
  const n = Number(cleaned[0]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(n);
}

// ---------------------------------------------------------------------------
// Document tracking.
// ---------------------------------------------------------------------------

// Filename/caption keyword → canonical doc type. Best-effort: an unrecognized
// file still gets recorded as a generic document so staff see it.
const DOC_KEYWORD_RULES: Array<{ re: RegExp; type: string }> = [
  { re: /passport|pasaport|جواز/i, type: "passport" },
  { re: /photo|photograph|foto|fotoğraf|vesikalık|vesikalik/i, type: "photo" },
  { re: /(high.?school|lise).*(diploma|certificate)|hs.?diploma|lise.?diploma/i, type: "class_12th_hsc_certificate" },
  { re: /(high.?school|lise).*(transcript|marks)|hs.?transcript/i, type: "class_12th_hsc_marks_sheet" },
  { re: /bachelor.*(transcript|marks)|lisans.*(transkript|not)/i, type: "bachelors_transcript" },
  { re: /bachelor.*(diploma|certificate)|lisans.*(diploma|mezuniyet)/i, type: "bachelors_certificate" },
  { re: /master.*(transcript|marks)|yüksek.?lisans.*(transkript|not)/i, type: "masters_transcript" },
  { re: /master.*(diploma|certificate)|yüksek.?lisans.*(diploma|mezuniyet)/i, type: "masters_certificate" },
  { re: /ielts|toefl|duolingo|pte|gre|gmat|language|dil.?belge/i, type: "ielts_pte_gre_gmat_toefl_duolingo" },
  { re: /recognition|denklik|equivalen/i, type: "diploma_recognition" },
  { re: /\bcv\b|resume|özgeçmiş|ozgecmis/i, type: "cv" },
  { re: /\bsop\b|statement.?of.?purpose|motivation/i, type: "sop" },
];

const WA_MEDIA_TYPES = ["document", "image", "video", "audio"] as const;

interface ParsedMedia {
  mediaId: string;
  waType: string;
  filename: string | null;
  caption: string | null;
  mimeType: string | null;
}

/**
 * Pull media descriptors out of a stored inbound message's raw WhatsApp
 * payload (`metadata.raw`). Returns [] for text-only messages.
 */
export function parseInboundMedia(metadata: unknown): ParsedMedia[] {
  const meta = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {};
  const raw = meta.raw && typeof meta.raw === "object" ? (meta.raw as Record<string, unknown>) : null;
  if (!raw) return [];
  const out: ParsedMedia[] = [];
  for (const t of WA_MEDIA_TYPES) {
    const obj = raw[t];
    if (obj && typeof obj === "object") {
      const o = obj as Record<string, unknown>;
      const mediaId = typeof o.id === "string" ? o.id : null;
      if (!mediaId) continue;
      out.push({
        mediaId,
        waType: t,
        filename: typeof o.filename === "string" ? o.filename : null,
        caption: typeof o.caption === "string" ? o.caption : null,
        mimeType: typeof o.mime_type === "string" ? o.mime_type : null,
      });
    }
  }
  return out;
}

/** Best-effort canonical doc type from a filename + caption. */
export function detectDocType(filename: string | null, caption: string | null): string {
  const hay = `${filename || ""} ${caption || ""}`;
  const matches = new Set(
    DOC_KEYWORD_RULES.filter((rule) => rule.re.test(hay)).map((rule) => rule.type),
  );
  return matches.size === 1 ? [...matches][0] : "other_certificates_documents";
}

/**
 * Record any media attached to an inbound message as `documents` rows on the
 * linked lead/student. Idempotent: a given WhatsApp media id is recorded once
 * (we key on fileKey = `wa:<mediaId>`). Returns the number of NEW rows created.
 */
export async function recordInboundDocuments(opts: {
  metadata: unknown;
  leadId: number | null;
  studentId: number | null;
}): Promise<number> {
  const { metadata, leadId, studentId } = opts;
  if (leadId == null && studentId == null) return 0;
  const media = parseInboundMedia(metadata);
  if (media.length === 0) return 0;

  let created = 0;
  for (const m of media) {
    const fileKey = `wa:${m.mediaId}`;
    // Serialize per-fileKey so concurrent bot invocations can't insert the same
    // inbound media twice (select-then-insert is otherwise racy).
    const inserted = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(${DOC_CAPTURE_LOCK_NS}, hashtext(${fileKey}))`,
      );
      const [existing] = await tx
        .select({ id: documentsTable.id })
        .from(documentsTable)
        .where(eq(documentsTable.fileKey, fileKey))
        .limit(1);
      if (existing) return false;

      const type = detectDocType(m.filename, m.caption);
      await tx.insert(documentsTable).values({
        leadId: leadId ?? null,
        studentId: studentId ?? null,
        name: m.filename || `WhatsApp ${m.waType}`,
        type,
        status: "pending",
        fileKey,
        mimeType: m.mimeType || null,
        notes: m.caption || null,
      });
      return true;
    });
    if (inserted) created += 1;
  }
  return created;
}

// ---------------------------------------------------------------------------
// Missing-document computation + bot prompt instruction.
// ---------------------------------------------------------------------------

const DOC_GROUP_LABEL: Record<DocEquivalenceGroupId, string> = {
  passport: "passport",
  photo: "passport-style photo",
  hs_certificate: "high-school diploma",
  hs_transcript: "high-school transcript",
  ssc_marks_sheet: "secondary-school marks sheet",
  bachelors_certificate: "bachelor's diploma",
  bachelors_transcript: "bachelor's transcript",
  masters_certificate: "master's diploma",
  masters_transcript: "master's transcript",
  language_proof: "language proof (IELTS/TOEFL etc.)",
  cv: "CV / resume",
  sop: "statement of purpose",
  equivalency_letter: "recognition (denklik) document",
  diploma_certificate: "diploma certificate",
  diploma_transcript: "diploma transcript",
  lor: "letter of recommendation",
  essay: "essay",
  experience_letters: "experience letters",
  other_certificates_documents: "supporting documents",
};

/**
 * Compute which level-appropriate document groups the lead/student has not yet
 * provided. Returns [] when the level is unknown (no requirements to check) or
 * nothing is linked.
 */
export async function computeMissingDocGroups(opts: {
  leadId: number | null;
  studentId: number | null;
  level: string | null;
}): Promise<DocEquivalenceGroupId[]> {
  const { leadId, studentId, level } = opts;
  if (!level) return [];
  if (leadId == null && studentId == null) return [];
  const relevant = getRelevantGroupsForLevel(level);
  if (!relevant) return [];

  const rows = await db
    .select({
      type: documentsTable.type,
      status: documentsTable.status,
      mimeType: documentsTable.mimeType,
      sizeBytes: documentsTable.sizeBytes,
      fileKey: documentsTable.fileKey,
      fileUrl: documentsTable.fileUrl,
      fileData: documentsTable.fileData,
    })
    .from(documentsTable)
    .where(
      and(
        leadId != null ? eq(documentsTable.leadId, leadId) : eq(documentsTable.studentId, studentId!),
        isNull(documentsTable.deletedAt),
      ),
    );
  const uploadedGroups = new Set<DocEquivalenceGroupId>();
  for (const r of rows) {
    if (r.status === "rejected" || !r.mimeType) continue;
    const hasStoredContent = Boolean(r.fileKey || r.fileUrl || r.fileData);
    if (!hasStoredContent) continue;
    const decodedBytes = r.fileData
      ? Math.max(0, Math.floor((r.fileData.replace(/\s/g, "").length * 3) / 4))
      : 0;
    const sizeBytes = Number(r.sizeBytes) || decodedBytes;
    const ext = r.mimeType === "application/pdf"
      ? ".pdf"
      : r.mimeType === "image/png"
        ? ".png"
        : r.mimeType === "image/jpeg"
          ? ".jpg"
          : ".bin";
    if (validateStudentDocumentFile(r.type, `document${ext}`, r.mimeType, sizeBytes)) continue;
    const g = getDocEquivalenceGroup(r.type);
    if (g) uploadedGroups.add(g);
  }
  return [...relevant].filter((g) => !uploadedGroups.has(g));
}

/**
 * Build a short system-prompt addendum instructing the bot to remind the
 * student which documents are still missing. Returns null when nothing is
 * missing.
 */
export function buildMissingDocsInstruction(missing: DocEquivalenceGroupId[]): string | null {
  if (missing.length === 0) return null;
  const labels = missing.map((g) => DOC_GROUP_LABEL[g] ?? g).join(", ");
  return (
    "## Documents still needed\n" +
    `Based on the student's study level, these documents are still missing: ${labels}. ` +
    "Ask for the first missing document, then continue one item at a time. Remind the student that every document " +
    "must be uploaded separately in the correct slot and may be at most 5 MB. Do not repeat documents that the " +
    "system has already validated."
  );
}
