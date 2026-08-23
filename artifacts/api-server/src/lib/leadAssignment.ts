import { db, leadAssignmentRulesTable, leadsTable, studentsTable, applicationsTable, universitiesTable, type LeadAssignmentRule } from "@workspace/db";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { logAudit } from "./auth";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | Tx;

interface LeadLike {
  id: number;
  source?: string | null;
  nationality?: string | null;
  country?: string | null;
  interestedCountry?: string | null;
  interestedProgram?: string | null;
  notes?: string | null;
  phone?: string | null;
  phoneE164?: string | null;
  /** The real inbox account that originated this lead, when applicable. */
  channelAccountId?: number | null;
}

/**
 * Normalize a phone number for prefix matching: strip everything except
 * digits and the leading '+', collapse double '00' to '+'.
 */
export function normalizePhoneForMatch(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (s.startsWith("00")) s = s.slice(2);
  const digits = s.replace(/[^\d]/g, "");
  return digits ? `+${digits}` : null;
}

function includesCI(haystacks: (string | null | undefined)[], needles: string[]): boolean {
  const hay = haystacks.filter((v): v is string => !!v).map(v => v.toLowerCase());
  if (hay.length === 0) return false;
  const wanted = needles.map(n => n.toLowerCase()).filter(Boolean);
  return wanted.some(n => hay.some(h => h === n || h.includes(n)));
}

async function ruleMatches(rule: LeadAssignmentRule, lead: LeadLike): Promise<boolean> {
  if (!rule.isActive) return false;
  if (!rule.staffUserIds || rule.staffUserIds.length === 0) return false;

  const haystack = [lead.interestedCountry, lead.nationality, lead.country, lead.interestedProgram, lead.notes];

  const countries = rule.countries || [];
  if (countries.length > 0 && !includesCI(haystack, countries)) return false;

  const cities = rule.cities || [];
  if (cities.length > 0 && !includesCI(haystack, cities)) return false;

  const phoneCodes: string[] = (rule as any).phoneCodes || [];
  if (phoneCodes.length > 0) {
    const normalizedPhones = [lead.phoneE164, lead.phone]
      .map(normalizePhoneForMatch)
      .filter((phone): phone is string => Boolean(phone));
    if (normalizedPhones.length === 0) return false;
    const matched = phoneCodes
      .map((c: string) => normalizePhoneForMatch(c))
      .filter((c): c is string => !!c)
      .some((prefix: string) => normalizedPhones.some((phone) => phone.startsWith(prefix)));
    if (!matched) return false;
  }

  const sources = rule.sources || [];
  if (sources.length > 0) {
    const normalizedSources = sources.map(s => s.toLowerCase());
    const genericSourceMatches = Boolean(
      lead.source && normalizedSources.includes(lead.source.toLowerCase()),
    );
    const accountSourceMatches = Boolean(
      lead.channelAccountId != null &&
      normalizedSources.includes(`channel-account:${lead.channelAccountId}`),
    );
    if (!genericSourceMatches && !accountSourceMatches) return false;
  }

  const universityIds = rule.universityIds || [];
  if (universityIds.length > 0) {
    // Resolve the university names and check whether any appears in the
    // lead's text fields (interestedProgram / interestedCountry — embed
    // widget stores university name in interestedCountry).
    const unis = await db.select({ name: universitiesTable.name })
      .from(universitiesTable)
      .where(inArray(universitiesTable.id, universityIds));
    const names = unis.map(u => u.name).filter(Boolean);
    if (names.length === 0) return false;
    if (!includesCI(haystack, names)) return false;
  }

  return true;
}

export async function findMatchingLeadAssignmentRule(lead: LeadLike): Promise<LeadAssignmentRule | null> {
  const rules = await db.select().from(leadAssignmentRulesTable)
    .where(eq(leadAssignmentRulesTable.isActive, true))
    .orderBy(asc(leadAssignmentRulesTable.priority), asc(leadAssignmentRulesTable.id));
  for (const rule of rules) {
    if (await ruleMatches(rule, lead)) return rule;
  }
  return null;
}

/**
 * Atomically pick the next staff member for a round-robin rule. Increments
 * `last_assigned_index` in a single SQL statement and returns the freshly
 * advanced value, so concurrent lead-creates can never collide on the same
 * staff slot.
 */
async function pickStaffAtomic(rule: LeadAssignmentRule): Promise<number | null> {
  const staff = rule.staffUserIds;
  if (!staff || staff.length === 0) return null;
  if (rule.strategy !== "round_robin") return staff[0];

  const len = staff.length;
  const [updated] = await db.update(leadAssignmentRulesTable)
    .set({ lastAssignedIndex: sql`((${leadAssignmentRulesTable.lastAssignedIndex} + 1) % ${len})` })
    .where(eq(leadAssignmentRulesTable.id, rule.id))
    .returning({ lastAssignedIndex: leadAssignmentRulesTable.lastAssignedIndex });
  if (!updated) return null;
  // The returned value is the *next* index; the assigned slot is one before.
  const nextIdx = updated.lastAssignedIndex;
  const idx = ((nextIdx - 1) % len + len) % len;
  return staff[idx] ?? null;
}

/**
 * Apply lead auto-assignment rules to a freshly created lead. Walks active
 * rules in priority order (lowest priority first, then by id) and applies the
 * first matching one. If a match is found, updates `leads.assignedToId` and
 * writes an audit log. Silent no-op when no rule matches or the lead already
 * has an `assignedToId`. Errors are caught and logged so this helper never
 * breaks the calling lead-create flow.
 */
export async function applyLeadAssignmentRules(lead: LeadLike & { assignedToId?: number | null }, ipAddress?: string): Promise<number | null> {
  try {
    if (lead.assignedToId) return null;

    const rule = await findMatchingLeadAssignmentRule(lead);
    if (rule) {
      const staffId = await pickStaffAtomic(rule);
      if (!staffId) return null;

      const [assigned] = await db.update(leadsTable)
        .set({ assignedToId: staffId })
        .where(and(eq(leadsTable.id, lead.id), isNull(leadsTable.assignedToId)))
        .returning({ convertedStudentId: leadsTable.convertedStudentId });
      if (!assigned) return null;
      logAudit(null, "lead.auto_assigned", "lead", lead.id, { ruleId: rule.id, ruleName: rule.name, staffId }, ipAddress);
      await cascadeLeadAssignment({
        leadId: lead.id,
        convertedStudentId: assigned.convertedStudentId,
        newAssignedToId: staffId,
        actorUserId: null,
        ipAddress,
        nullFillOnly: true,
      });
      return staffId;
    }
    return null;
  } catch (err: any) {
    console.error("[applyLeadAssignmentRules] failed:", err?.message || err);
    return null;
  }
}

/**
 * Cascade a lead's assigned-staff change down to its converted student and that
 * student's applications.
 *
 * When `nullFillOnly` is false (default): requires the caller to have the
 * `records.cascade_assignment` permission; OVERWRITES already-assigned downstream
 * records so ownership follows the lead change entirely.
 *
 * When `nullFillOnly` is true: runs unconditionally (no permission gate at
 * call-site needed) but only updates records that are currently unassigned
 * (assignedToId IS NULL). This is the "soft" cascade used for first-touch
 * assignment consistency — assigning a lead for the first time automatically
 * fills the matching unassigned student and application records.
 */
export async function cascadeLeadAssignment(opts: {
  leadId: number;
  convertedStudentId: number | null;
  newAssignedToId: number | null;
  actorUserId: number | null;
  ipAddress?: string;
  nullFillOnly?: boolean;
  throwOnError?: boolean;
  executor?: DbLike;
}): Promise<void> {
  const {
    leadId,
    convertedStudentId,
    newAssignedToId,
    actorUserId,
    ipAddress,
    nullFillOnly = false,
    throwOnError = false,
    executor = db,
  } = opts;
  try {
    if (!convertedStudentId) return;

    const [student] = await executor
      .select({ id: studentsTable.id, assignedToId: studentsTable.assignedToId })
      .from(studentsTable)
      .where(and(eq(studentsTable.id, convertedStudentId), isNull(studentsTable.deletedAt)));
    if (!student) return;

    if (student.assignedToId !== newAssignedToId && (!nullFillOnly || student.assignedToId === null)) {
      await executor.update(studentsTable)
        .set({ assignedToId: newAssignedToId })
        .where(eq(studentsTable.id, student.id));
      logAudit(actorUserId, nullFillOnly ? "assignment.null_fill_cascade" : "assignment.cascade", "student", student.id, {
        from: student.assignedToId ?? null,
        to: newAssignedToId ?? null,
        source: "lead",
        sourceId: leadId,
      }, ipAddress);
    }

    // One person may legitimately have multiple acquisition leads.  Once a
    // lead is converted they all belong to the same student journey, so a full
    // reassignment must not leave an older sibling lead on another owner.
    const siblingLeads = await executor
      .select({ id: leadsTable.id, assignedToId: leadsTable.assignedToId })
      .from(leadsTable)
      .where(and(eq(leadsTable.convertedStudentId, student.id), isNull(leadsTable.deletedAt)));
    for (const siblingLead of siblingLeads) {
      if (siblingLead.id === leadId || siblingLead.assignedToId === newAssignedToId) continue;
      if (nullFillOnly && siblingLead.assignedToId !== null) continue;
      await executor.update(leadsTable)
        .set({ assignedToId: newAssignedToId })
        .where(eq(leadsTable.id, siblingLead.id));
      logAudit(actorUserId, nullFillOnly ? "assignment.null_fill_cascade" : "assignment.cascade", "lead", siblingLead.id, {
        from: siblingLead.assignedToId ?? null,
        to: newAssignedToId ?? null,
        source: "lead",
        sourceId: leadId,
      }, ipAddress);
    }

    const apps = await executor
      .select({ id: applicationsTable.id, assignedToId: applicationsTable.assignedToId })
      .from(applicationsTable)
      .where(and(eq(applicationsTable.studentId, student.id), isNull(applicationsTable.deletedAt)));

    for (const app of apps) {
      if (app.assignedToId === newAssignedToId) continue;
      if (nullFillOnly && app.assignedToId !== null) continue;
      await executor.update(applicationsTable)
        .set({ assignedToId: newAssignedToId })
        .where(eq(applicationsTable.id, app.id));
      logAudit(actorUserId, nullFillOnly ? "assignment.null_fill_cascade" : "assignment.cascade", "application", app.id, {
        from: app.assignedToId ?? null,
        to: newAssignedToId ?? null,
        source: "lead",
        sourceId: leadId,
      }, ipAddress);
    }
  } catch (err: any) {
    console.error("[cascadeLeadAssignment] failed:", err?.message || err);
    if (throwOnError) throw err;
  }
}

/**
 * Cascade a student's assigned-staff change up to its source lead(s) and across
 * the student's applications.
 *
 * When `nullFillOnly` is false (default): OVERWRITES already-assigned records
 * (requires permission gate at call-site).
 * When `nullFillOnly` is true: only fills records where assignedToId IS NULL —
 * no permission gate needed; used for first-touch assignment consistency.
 */
export async function cascadeStudentAssignment(opts: {
  studentId: number;
  newAssignedToId: number | null;
  actorUserId: number | null;
  ipAddress?: string;
  nullFillOnly?: boolean;
  throwOnError?: boolean;
  executor?: DbLike;
}): Promise<void> {
  const {
    studentId,
    newAssignedToId,
    actorUserId,
    ipAddress,
    nullFillOnly = false,
    throwOnError = false,
    executor = db,
  } = opts;
  try {
    const leads = await executor
      .select({ id: leadsTable.id, assignedToId: leadsTable.assignedToId })
      .from(leadsTable)
      .where(and(eq(leadsTable.convertedStudentId, studentId), isNull(leadsTable.deletedAt)));

    for (const lead of leads) {
      if (lead.assignedToId === newAssignedToId) continue;
      if (nullFillOnly && lead.assignedToId !== null) continue;
      await executor.update(leadsTable)
        .set({ assignedToId: newAssignedToId })
        .where(eq(leadsTable.id, lead.id));
      logAudit(actorUserId, nullFillOnly ? "assignment.null_fill_cascade" : "assignment.cascade", "lead", lead.id, {
        from: lead.assignedToId ?? null,
        to: newAssignedToId ?? null,
        source: "student",
        sourceId: studentId,
      }, ipAddress);
    }

    const apps = await executor
      .select({ id: applicationsTable.id, assignedToId: applicationsTable.assignedToId })
      .from(applicationsTable)
      .where(and(eq(applicationsTable.studentId, studentId), isNull(applicationsTable.deletedAt)));

    for (const app of apps) {
      if (app.assignedToId === newAssignedToId) continue;
      if (nullFillOnly && app.assignedToId !== null) continue;
      await executor.update(applicationsTable)
        .set({ assignedToId: newAssignedToId })
        .where(eq(applicationsTable.id, app.id));
      logAudit(actorUserId, nullFillOnly ? "assignment.null_fill_cascade" : "assignment.cascade", "application", app.id, {
        from: app.assignedToId ?? null,
        to: newAssignedToId ?? null,
        source: "student",
        sourceId: studentId,
      }, ipAddress);
    }
  } catch (err: any) {
    console.error("[cascadeStudentAssignment] failed:", err?.message || err);
    if (throwOnError) throw err;
  }
}

/**
 * One-time null-fill backfill: for every student journey (lead → student → applications),
 * find the authoritative assigned-to value and propagate it to any sibling records
 * that are currently NULL. Never overwrites an explicit assignment.
 *
 * Priority: student.assignedToId > lead.assignedToId
 *
 * Explicit administrative backfill only. It only touches rows where
 * assignedToId IS NULL, so a repeated manual run is a no-op once consistent.
 */
export async function backfillNullAssignments(actorUserId: number | null = null, ipAddress?: string): Promise<{ studentsFixed: number; leadsFixed: number; appsFixed: number }> {
  let studentsFixed = 0;
  let leadsFixed = 0;
  let appsFixed = 0;

  try {
    // --- Pass 1: student.assignedToId → fill their null leads and applications ---
    const assignedStudents = await db
      .select({ id: studentsTable.id, assignedToId: studentsTable.assignedToId })
      .from(studentsTable)
      .where(and(isNull(studentsTable.deletedAt), isNotNull(studentsTable.assignedToId)));

    for (const student of assignedStudents) {
      if (!student.assignedToId) continue;

      // Fill null leads for this student
      const leads = await db
        .select({ id: leadsTable.id, assignedToId: leadsTable.assignedToId })
        .from(leadsTable)
        .where(and(eq(leadsTable.convertedStudentId, student.id), isNull(leadsTable.assignedToId), isNull(leadsTable.deletedAt)));

      for (const lead of leads) {
        await db.update(leadsTable).set({ assignedToId: student.assignedToId }).where(eq(leadsTable.id, lead.id));
        logAudit(actorUserId, "assignment.null_fill_backfill", "lead", lead.id, { from: null, to: student.assignedToId, source: "student", sourceId: student.id }, ipAddress);
        leadsFixed++;
      }

      // Fill null applications for this student
      const apps = await db
        .select({ id: applicationsTable.id, assignedToId: applicationsTable.assignedToId })
        .from(applicationsTable)
        .where(and(eq(applicationsTable.studentId, student.id), isNull(applicationsTable.assignedToId), isNull(applicationsTable.deletedAt)));

      for (const app of apps) {
        await db.update(applicationsTable).set({ assignedToId: student.assignedToId }).where(eq(applicationsTable.id, app.id));
        logAudit(actorUserId, "assignment.null_fill_backfill", "application", app.id, { from: null, to: student.assignedToId, source: "student", sourceId: student.id }, ipAddress);
        appsFixed++;
      }
    }

    // --- Pass 2: if student is unassigned but their lead has an assignment, promote it ---
    const unassignedStudents = await db
      .select({ id: studentsTable.id })
      .from(studentsTable)
      .where(and(isNull(studentsTable.deletedAt), isNull(studentsTable.assignedToId)));

    for (const student of unassignedStudents) {
      const [assignedLead] = await db
        .select({ id: leadsTable.id, assignedToId: leadsTable.assignedToId })
        .from(leadsTable)
        .where(and(eq(leadsTable.convertedStudentId, student.id), isNotNull(leadsTable.assignedToId), isNull(leadsTable.deletedAt)))
        .limit(1);

      if (!assignedLead?.assignedToId) continue;

      // Set student from lead
      await db.update(studentsTable).set({ assignedToId: assignedLead.assignedToId }).where(eq(studentsTable.id, student.id));
      logAudit(actorUserId, "assignment.null_fill_backfill", "student", student.id, { from: null, to: assignedLead.assignedToId, source: "lead", sourceId: assignedLead.id }, ipAddress);
      studentsFixed++;

      // Fill null applications for this student
      const apps = await db
        .select({ id: applicationsTable.id })
        .from(applicationsTable)
        .where(and(eq(applicationsTable.studentId, student.id), isNull(applicationsTable.assignedToId), isNull(applicationsTable.deletedAt)));

      for (const app of apps) {
        await db.update(applicationsTable).set({ assignedToId: assignedLead.assignedToId }).where(eq(applicationsTable.id, app.id));
        logAudit(actorUserId, "assignment.null_fill_backfill", "application", app.id, { from: null, to: assignedLead.assignedToId, source: "lead", sourceId: assignedLead.id }, ipAddress);
        appsFixed++;
      }
    }

    if (studentsFixed + leadsFixed + appsFixed > 0) {
      console.log(`[backfillNullAssignments] Fixed: ${studentsFixed} students, ${leadsFixed} leads, ${appsFixed} applications`);
    } else {
      console.log("[backfillNullAssignments] No null assignments to fix — all consistent.");
    }
  } catch (err: any) {
    console.error("[backfillNullAssignments] error:", err?.message || err);
  }

  return { studentsFixed, leadsFixed, appsFixed };
}

/**
 * Cascade an application's assigned-staff change up to its student and that
 * student's source lead(s).
 *
 * When `nullFillOnly` is false (default): OVERWRITES already-assigned records
 * (requires permission gate at call-site).
 * When `nullFillOnly` is true: only fills records where assignedToId IS NULL —
 * no permission gate needed; used for first-touch assignment consistency.
 */
export async function cascadeApplicationAssignment(opts: {
  applicationId: number;
  studentId: number;
  newAssignedToId: number | null;
  actorUserId: number | null;
  ipAddress?: string;
  nullFillOnly?: boolean;
  throwOnError?: boolean;
  executor?: DbLike;
}): Promise<void> {
  const {
    applicationId,
    studentId,
    newAssignedToId,
    actorUserId,
    ipAddress,
    nullFillOnly = false,
    throwOnError = false,
    executor = db,
  } = opts;
  try {
    const [student] = await executor
      .select({ id: studentsTable.id, assignedToId: studentsTable.assignedToId })
      .from(studentsTable)
      .where(and(eq(studentsTable.id, studentId), isNull(studentsTable.deletedAt)));

    if (student && student.assignedToId !== newAssignedToId && (!nullFillOnly || student.assignedToId === null)) {
      await executor.update(studentsTable)
        .set({ assignedToId: newAssignedToId })
        .where(eq(studentsTable.id, student.id));
      logAudit(actorUserId, nullFillOnly ? "assignment.null_fill_cascade" : "assignment.cascade", "student", student.id, {
        from: student.assignedToId ?? null,
        to: newAssignedToId ?? null,
        source: "application",
        sourceId: applicationId,
      }, ipAddress);
    }

    const leads = await executor
      .select({ id: leadsTable.id, assignedToId: leadsTable.assignedToId })
      .from(leadsTable)
      .where(and(eq(leadsTable.convertedStudentId, studentId), isNull(leadsTable.deletedAt)));

    for (const lead of leads) {
      if (lead.assignedToId === newAssignedToId) continue;
      if (nullFillOnly && lead.assignedToId !== null) continue;
      await executor.update(leadsTable)
        .set({ assignedToId: newAssignedToId })
        .where(eq(leadsTable.id, lead.id));
      logAudit(actorUserId, nullFillOnly ? "assignment.null_fill_cascade" : "assignment.cascade", "lead", lead.id, {
        from: lead.assignedToId ?? null,
        to: newAssignedToId ?? null,
        source: "application",
        sourceId: applicationId,
      }, ipAddress);
    }
    // Sibling applications of the same student — keep the whole person's
    // applications in sync when one is reassigned (full-sync consistency).
    const siblingApps = await executor
      .select({ id: applicationsTable.id, assignedToId: applicationsTable.assignedToId })
      .from(applicationsTable)
      .where(and(eq(applicationsTable.studentId, studentId), isNull(applicationsTable.deletedAt)));

    for (const app of siblingApps) {
      if (app.id === applicationId) continue;
      if (app.assignedToId === newAssignedToId) continue;
      if (nullFillOnly && app.assignedToId !== null) continue;
      await executor.update(applicationsTable)
        .set({ assignedToId: newAssignedToId })
        .where(eq(applicationsTable.id, app.id));
      logAudit(actorUserId, nullFillOnly ? "assignment.null_fill_cascade" : "assignment.cascade", "application", app.id, {
        from: app.assignedToId ?? null,
        to: newAssignedToId ?? null,
        source: "application",
        sourceId: applicationId,
      }, ipAddress);
    }
  } catch (err: any) {
    console.error("[cascadeApplicationAssignment] failed:", err?.message || err);
    if (throwOnError) throw err;
  }
}
