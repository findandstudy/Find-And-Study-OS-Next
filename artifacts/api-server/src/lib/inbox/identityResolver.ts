import { db, leadsTable, studentsTable, agentsTable, externalContactsTable } from "@workspace/db";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { toE164 } from "./phone";

export interface IdentityCandidate {
  type: "lead" | "student" | "agent";
  id: number;
  displayName: string;
  email?: string | null;
  phone?: string | null;
}

export interface IdentityResolution {
  outcome: "strong" | "ambiguous" | "none";
  candidates: IdentityCandidate[];
}

/**
 * Resolve an external contact (a phone or email) to a lead/student/agent.
 * Phone matching is performed ONLY against the normalized phone_e164 columns.
 *
 * - "strong":     exactly one candidate across all entity types -> auto-link.
 * - "ambiguous":  more than one match -> show manual UI.
 * - "none":       no matches -> create unmatched conversation.
 */
export async function resolveIdentity(opts: {
  phone?: string | null;
  email?: string | null;
}): Promise<IdentityResolution> {
  const phoneE164 = toE164(opts.phone || null);
  const email = opts.email ? String(opts.email).trim().toLowerCase() : null;

  if (!phoneE164 && !email) {
    return { outcome: "none", candidates: [] };
  }

  const candidates: IdentityCandidate[] = [];

  if (phoneE164 || email) {
    const leads = await db
      .select({
        id: leadsTable.id,
        firstName: leadsTable.firstName,
        lastName: leadsTable.lastName,
        email: leadsTable.email,
        phone: leadsTable.phone,
      })
      .from(leadsTable)
      .where(
        and(
          isNull(leadsTable.deletedAt),
          // Leads that have already been converted to a student record are the
          // SAME person — the student entry takes over as the canonical candidate.
          // Counting them separately would make a single person look "ambiguous".
          isNull(leadsTable.convertedStudentId),
          or(
            phoneE164 ? eq(leadsTable.phoneE164, phoneE164) : sql`false`,
            email ? eq(sql`lower(${leadsTable.email})`, email) : sql`false`,
          ),
        ),
      )
      .limit(10);

    for (const l of leads) {
      candidates.push({
        type: "lead",
        id: l.id,
        displayName: `${l.firstName} ${l.lastName}`.trim(),
        email: l.email,
        phone: l.phone,
      });
    }

    const students = await db
      .select({
        id: studentsTable.id,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        email: studentsTable.email,
        phone: studentsTable.phone,
      })
      .from(studentsTable)
      .where(
        and(
          isNull(studentsTable.deletedAt),
          or(
            phoneE164 ? eq(studentsTable.phoneE164, phoneE164) : sql`false`,
            email ? eq(sql`lower(${studentsTable.email})`, email) : sql`false`,
          ),
        ),
      )
      .limit(10);

    for (const s of students) {
      candidates.push({
        type: "student",
        id: s.id,
        displayName: `${s.firstName} ${s.lastName}`.trim(),
        email: s.email,
        phone: s.phone,
      });
    }

    const agents = await db
      .select({
        id: agentsTable.id,
        firstName: agentsTable.firstName,
        lastName: agentsTable.lastName,
        email: agentsTable.email,
        phone: agentsTable.phone,
      })
      .from(agentsTable)
      .where(
        or(
          phoneE164 ? eq(agentsTable.phoneE164, phoneE164) : sql`false`,
          email ? eq(sql`lower(${agentsTable.email})`, email) : sql`false`,
        ),
      )
      .limit(10);

    for (const a of agents) {
      candidates.push({
        type: "agent",
        id: a.id,
        displayName: `${a.firstName} ${a.lastName}`.trim(),
        email: a.email,
        phone: a.phone,
      });
    }
  }

  if (candidates.length === 1) return { outcome: "strong", candidates };
  if (candidates.length > 1) return { outcome: "ambiguous", candidates };
  return { outcome: "none", candidates: [] };
}

/**
 * Apply a (manually-chosen or auto-resolved) identity to an external contact.
 */
export async function linkExternalContact(
  externalContactId: number,
  candidate: IdentityCandidate,
): Promise<void> {
  const updates: { leadId: number | null; studentId: number | null; agentId: number | null } = {
    leadId: null,
    studentId: null,
    agentId: null,
  };
  if (candidate.type === "lead") updates.leadId = candidate.id;
  if (candidate.type === "student") updates.studentId = candidate.id;
  if (candidate.type === "agent") updates.agentId = candidate.id;
  await db.update(externalContactsTable).set(updates).where(eq(externalContactsTable.id, externalContactId));
}
