import { db, documentsTable, leadsTable, studentsTable } from "@workspace/db";
import { and, eq, isNull, inArray, or, isNotNull } from "drizzle-orm";
import { recomputeStudentPhoto } from "./studentPhoto";

/**
 * Adopt (re-own) staged lead documents onto a student.
 *
 * Inbox flows can leave documents attached to a lead while the conversation
 * is later matched to a newly-created student — the DOCUMENTS panel shows the
 * docs as present (it reads lead docs), but the application mandatory-doc
 * gate only reads student-owned docs and rejects the application.
 *
 * This mirrors the lead-convert behavior in routes/leads.ts: documents keep
 * their leadId for provenance and gain the studentId.
 *
 * Candidate leads are matched by:
 *  - leads.convertedStudentId === studentId, OR
 *  - same email as the student (case-insensitive exact), OR
 *  - same phoneE164 as the student.
 *
 * Returns the number of documents adopted. Never throws — failures are
 * logged and reported as 0 so callers can proceed with their own checks.
 * (See `adoptLeadDocsForStudent` below.)
 */

/**
 * Read-only preview of the lead-owned document TYPES that
 * `adoptLeadDocsForStudent` would move onto this student. Used by the
 * application pre-flight check so the UI never warns about a document that
 * the gate would adopt automatically at submit time. Never throws.
 */
export async function getAdoptableLeadDocTypes(studentId: number): Promise<string[]> {
  try {
    const leadIds = await findCandidateLeadIds(studentId);
    if (leadIds.length === 0) return [];
    const rows = await db
      .select({ type: documentsTable.type })
      .from(documentsTable)
      .where(and(
        inArray(documentsTable.leadId, leadIds),
        isNull(documentsTable.studentId),
        isNull(documentsTable.deletedAt),
      ));
    return rows.map((r) => r.type || "").filter(Boolean);
  } catch (err: any) {
    console.error("[leadDocAdoption:preview]", err?.message || err);
    return [];
  }
}

async function findCandidateLeadIds(studentId: number): Promise<number[]> {
  const [student] = await db
    .select({
      id: studentsTable.id,
      email: studentsTable.email,
      phoneE164: studentsTable.phoneE164,
    })
    .from(studentsTable)
    .where(and(eq(studentsTable.id, studentId), isNull(studentsTable.deletedAt)));
  if (!student) return [];

  const matchConds = [eq(leadsTable.convertedStudentId, studentId)];
  const contactConds = [];
  if (student.email) {
    contactConds.push(and(isNotNull(leadsTable.email), eq(leadsTable.email, student.email))!);
  }
  if (student.phoneE164) {
    contactConds.push(and(isNotNull(leadsTable.phoneE164), eq(leadsTable.phoneE164, student.phoneE164))!);
  }
  if (contactConds.length > 0) {
    matchConds.push(and(isNull(leadsTable.convertedStudentId), or(...contactConds))!);
  }

  const candidateLeads = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .where(and(or(...matchConds), isNull(leadsTable.deletedAt)));
  return candidateLeads.map((l) => l.id);
}

export async function adoptLeadDocsForStudent(studentId: number): Promise<number> {
  try {
    const [student] = await db
      .select({
        id: studentsTable.id,
        email: studentsTable.email,
        phoneE164: studentsTable.phoneE164,
      })
      .from(studentsTable)
      .where(and(eq(studentsTable.id, studentId), isNull(studentsTable.deletedAt)));
    if (!student) return 0;

    const matchConds = [eq(leadsTable.convertedStudentId, studentId)];
    // Contact-data fallbacks are gated below so a lead already converted to a
    // DIFFERENT student is never a candidate — only its explicit link counts.
    const contactConds = [];
    if (student.email) {
      contactConds.push(and(isNotNull(leadsTable.email), eq(leadsTable.email, student.email))!);
    }
    if (student.phoneE164) {
      contactConds.push(and(isNotNull(leadsTable.phoneE164), eq(leadsTable.phoneE164, student.phoneE164))!);
    }
    if (contactConds.length > 0) {
      matchConds.push(and(isNull(leadsTable.convertedStudentId), or(...contactConds))!);
    }

    const candidateLeads = await db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(and(or(...matchConds), isNull(leadsTable.deletedAt)));
    if (candidateLeads.length === 0) return 0;

    const leadIds = candidateLeads.map((l) => l.id);
    const updated = await db
      .update(documentsTable)
      .set({ studentId })
      .where(and(
        inArray(documentsTable.leadId, leadIds),
        isNull(documentsTable.studentId),
        isNull(documentsTable.deletedAt),
      ))
      .returning({ id: documentsTable.id });

    if (updated.length > 0) {
      await recomputeStudentPhoto(studentId);
    }
    return updated.length;
  } catch (err: any) {
    console.error("[leadDocAdoption]", err?.message || err);
    return 0;
  }
}
