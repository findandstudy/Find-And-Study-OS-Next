import { Router } from "express";
import { db, leadsTable, studentsTable, applicationsTable, notesTable, followUpsTable, auditLogsTable, usersTable, externalContactsTable } from "@workspace/db";
import { and, eq, or, inArray, isNull, desc, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireRole, logAudit } from "../lib/auth";
import { STAFF_ROLES, ADMIN_ROLES, AGENT_ROLES, isAgentRole, isStaffRole } from "../lib/roles";
import { getAgentVisibleIds } from "../lib/agentVisibility";
import { assertCanAccessStudent } from "../lib/studentAccess";
import { feedBus, personKeys } from "../lib/feedBus";

const router = Router();

const STATUS_CHANGE_ACTIONS = new Set([
  "update_lead", "update_student", "convert_lead",
  "create_lead", "create_student",
]);

const contextQuerySchema = z.object({
  context: z.enum(["lead", "student", "application"]),
  id: z.string().regex(/^\d+$/).transform(Number),
  before: z.string().optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).optional(),
});

interface PersonIds {
  leadId: number | null;
  studentId: number | null;
  applicationId: number | null;
}

async function resolvePersonIds(context: string, id: number): Promise<PersonIds | null> {
  if (context === "lead") {
    const [lead] = await db.select({ id: leadsTable.id, convertedStudentId: leadsTable.convertedStudentId })
      .from(leadsTable).where(and(eq(leadsTable.id, id), isNull(leadsTable.deletedAt)));
    if (!lead) return null;
    return { leadId: lead.id, studentId: lead.convertedStudentId ?? null, applicationId: null };
  }
  if (context === "student") {
    const [student] = await db.select({ id: studentsTable.id, originLeadId: studentsTable.originLeadId })
      .from(studentsTable).where(and(eq(studentsTable.id, id), isNull(studentsTable.deletedAt)));
    if (!student) return null;
    return { leadId: student.originLeadId ?? null, studentId: student.id, applicationId: null };
  }
  if (context === "application") {
    const [app] = await db.select({ id: applicationsTable.id, studentId: applicationsTable.studentId })
      .from(applicationsTable).where(and(eq(applicationsTable.id, id), isNull(applicationsTable.deletedAt)));
    if (!app) return null;
    const [student] = await db.select({ id: studentsTable.id, originLeadId: studentsTable.originLeadId })
      .from(studentsTable).where(and(eq(studentsTable.id, app.studentId), isNull(studentsTable.deletedAt)));
    if (!student) return null;
    return { leadId: student.originLeadId ?? null, studentId: student.id, applicationId: app.id };
  }
  return null;
}

type AccessResult = { ok: true; isStaff: boolean } | { ok: false; status: number; error: string };

async function checkPersonAccess(req: any, ids: PersonIds, context: string): Promise<AccessResult> {
  const user = req.user!;
  const staff = isStaffRole(user.role) || ["super_admin", "admin", "manager"].includes(user.role);
  if (staff) return { ok: true, isStaff: true };

  if (isAgentRole(user.role)) {
    const visibleIds = await getAgentVisibleIds(user.id, user.role);
    if (ids.studentId) {
      const result = await assertCanAccessStudent(req, ids.studentId);
      if (!result.ok) return { ok: false, status: result.status, error: result.error };
      return { ok: true, isStaff: false };
    }
    if (ids.leadId) {
      const [lead] = await db.select({ agentId: leadsTable.agentId })
        .from(leadsTable).where(and(eq(leadsTable.id, ids.leadId), isNull(leadsTable.deletedAt)));
      if (!lead || !lead.agentId || !visibleIds.includes(lead.agentId)) {
        return { ok: false, status: 403, error: "Access denied" };
      }
      return { ok: true, isStaff: false };
    }
    return { ok: false, status: 403, error: "Access denied" };
  }

  return { ok: false, status: 403, error: "Access denied" };
}

function buildNotesConditions(ids: PersonIds) {
  const conds: ReturnType<typeof eq>[] = [];
  if (ids.leadId) conds.push(and(eq(notesTable.resourceType, "lead"), eq(notesTable.resourceId, ids.leadId)) as any);
  if (ids.studentId) conds.push(and(eq(notesTable.resourceType, "student"), eq(notesTable.resourceId, ids.studentId)) as any);
  if (ids.applicationId) conds.push(and(eq(notesTable.resourceType, "application"), eq(notesTable.resourceId, ids.applicationId)) as any);
  return conds;
}

router.get("/persons/feed", requireAuth, requireRole(...STAFF_ROLES, ...ADMIN_ROLES, ...AGENT_ROLES), async (req, res): Promise<void> => {
  const parsed = contextQuerySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid query params", details: parsed.error.flatten() }); return; }

  const { context, id, before, limit: rawLimit } = parsed.data;
  const limit = Math.min(rawLimit ?? 50, 100);
  const beforeDate = before ? new Date(before) : null;

  const ids = await resolvePersonIds(context, id);
  if (!ids) { res.status(404).json({ error: "Not found" }); return; }

  const access = await checkPersonAccess(req, ids, context);
  if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }
  const { isStaff } = access;

  const notesOrConds = buildNotesConditions(ids);
  if (notesOrConds.length === 0) {
    res.json({ data: [], meta: { leadId: ids.leadId, studentId: ids.studentId, applicationId: ids.applicationId } });
    return;
  }

  const [rawNotes, rawFollowUps, rawAudits] = await Promise.all([
    db.select({
      id: notesTable.id,
      content: notesTable.content,
      isInternal: notesTable.isInternal,
      authorId: notesTable.authorId,
      authorName: sql<string | null>`(SELECT NULLIF(CONCAT_WS(' ', u.first_name, u.last_name), '') FROM users u WHERE u.id = ${notesTable.authorId})`,
      resourceType: notesTable.resourceType,
      resourceId: notesTable.resourceId,
      createdAt: notesTable.createdAt,
    }).from(notesTable).where(
      and(
        or(...notesOrConds),
        ...(!isStaff ? [eq(notesTable.isInternal, false)] : []),
        ...(beforeDate ? [lt(notesTable.createdAt, beforeDate)] : []),
      )
    ).orderBy(desc(notesTable.createdAt)).limit(limit),

    db.select({
      id: followUpsTable.id,
      title: followUpsTable.title,
      scheduledAt: followUpsTable.scheduledAt,
      completed: followUpsTable.completed,
      completedAt: followUpsTable.completedAt,
      assignedToId: followUpsTable.assignedToId,
      assignedToName: sql<string | null>`(SELECT NULLIF(CONCAT_WS(' ', u.first_name, u.last_name), '') FROM users u WHERE u.id = ${followUpsTable.assignedToId})`,
      notes: followUpsTable.notes,
      leadId: followUpsTable.leadId,
      studentId: followUpsTable.studentId,
      resourceType: followUpsTable.resourceType,
      createdAt: followUpsTable.createdAt,
      updatedAt: followUpsTable.updatedAt,
    }).from(followUpsTable).where(
      and(
        or(
          ...(ids.leadId ? [eq(followUpsTable.leadId, ids.leadId)] : []),
          ...(ids.studentId ? [eq(followUpsTable.studentId, ids.studentId)] : []),
        ),
        ...(beforeDate ? [lt(followUpsTable.createdAt, beforeDate)] : []),
      )
    ).orderBy(desc(followUpsTable.createdAt)).limit(limit),

    isStaff ? db.select({
      id: auditLogsTable.id,
      action: auditLogsTable.action,
      resource: auditLogsTable.resource,
      resourceId: auditLogsTable.resourceId,
      changes: auditLogsTable.changes,
      userId: auditLogsTable.userId,
      actorName: sql<string | null>`(SELECT NULLIF(CONCAT_WS(' ', u.first_name, u.last_name), '') FROM users u WHERE u.id = ${auditLogsTable.userId})`,
      createdAt: auditLogsTable.createdAt,
    }).from(auditLogsTable).where(
      and(
        inArray(auditLogsTable.action, [...STATUS_CHANGE_ACTIONS]),
        or(
          ...(ids.leadId ? [and(eq(auditLogsTable.resource, "lead"), eq(auditLogsTable.resourceId, ids.leadId))] : []),
          ...(ids.studentId ? [and(eq(auditLogsTable.resource, "student"), eq(auditLogsTable.resourceId, ids.studentId))] : []),
        ),
        ...(beforeDate ? [lt(auditLogsTable.createdAt, beforeDate)] : []),
      )
    ).orderBy(desc(auditLogsTable.createdAt)).limit(limit) : Promise.resolve([]),
  ]);

  type FeedItem = {
    id: string; type: string; ts: string;
    [key: string]: unknown;
  };

  const feedItems: FeedItem[] = [
    ...rawNotes.map(n => ({
      id: `note_${n.id}`,
      type: "note",
      ts: n.createdAt.toISOString(),
      noteId: n.id,
      content: n.content,
      isInternal: n.isInternal,
      authorId: n.authorId,
      authorName: n.authorName,
      entityType: n.resourceType,
      entityId: n.resourceId,
    })),
    ...rawFollowUps.map(fu => ({
      id: `followup_${fu.id}`,
      type: "follow_up",
      ts: fu.createdAt.toISOString(),
      followUpId: fu.id,
      title: fu.title,
      dueAt: fu.scheduledAt?.toISOString() ?? null,
      completed: fu.completed,
      completedAt: fu.completedAt?.toISOString() ?? null,
      assignedToId: fu.assignedToId,
      assignedToName: fu.assignedToName,
      followUpNotes: fu.notes,
      entityType: fu.resourceType ?? (fu.studentId ? "student" : "lead"),
    })),
    ...rawAudits.map(a => {
      let changes: Record<string, unknown> | null = null;
      try { changes = a.changes ? JSON.parse(a.changes) : null; } catch { /* ignore */ }
      const hasStatusInChanges = changes && "status" in changes;
      if (!hasStatusInChanges && !["convert_lead", "create_lead", "create_student"].includes(a.action)) return null;
      return {
        id: `audit_${a.id}`,
        type: "status_change",
        ts: a.createdAt.toISOString(),
        auditId: a.id,
        action: a.action,
        entityType: a.resource,
        entityId: a.resourceId,
        actorId: a.userId,
        actorName: a.actorName,
        auditChanges: changes,
      };
    }).filter((x): x is NonNullable<typeof x> => x !== null),
  ];

  feedItems.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  const paged = feedItems.slice(0, limit);

  res.json({
    data: paged,
    meta: {
      leadId: ids.leadId,
      studentId: ids.studentId,
      applicationId: ids.applicationId,
      hasMore: feedItems.length > limit,
    },
  });
});

const addNoteBodySchema = z.object({
  content: z.string().min(1).max(4000),
  isInternal: z.boolean().default(false),
});

router.post("/persons/feed/notes", requireAuth, requireRole(...STAFF_ROLES, ...ADMIN_ROLES, ...AGENT_ROLES), async (req, res): Promise<void> => {
  const parsed = contextQuerySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid query params" }); return; }

  const bodyParsed = addNoteBodySchema.safeParse(req.body);
  if (!bodyParsed.success) { res.status(400).json({ error: "Invalid body", details: bodyParsed.error.flatten() }); return; }

  const { context, id } = parsed.data;
  const { content, isInternal } = bodyParsed.data;

  const ids = await resolvePersonIds(context, id);
  if (!ids) { res.status(404).json({ error: "Not found" }); return; }

  const access = await checkPersonAccess(req, ids, context);
  if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }

  if (isInternal && !access.isStaff) {
    res.status(403).json({ error: "Only staff can create internal notes" });
    return;
  }

  // canonical anchor: student if available, else lead
  const resourceType = ids.studentId ? "student" : "lead";
  const resourceId = (ids.studentId ?? ids.leadId)!;

  const [note] = await db.insert(notesTable).values({
    content,
    authorId: req.user!.id,
    resourceType,
    resourceId,
    isInternal,
  }).returning();

  feedBus.publish({ personKeys: personKeys(ids.leadId, ids.studentId), action: "note_added", itemId: note.id });
  logAudit(req.user!.id, "create_note", resourceType, resourceId, { noteId: note.id, isInternal }, req.ip);

  res.status(201).json({
    data: {
      id: `note_${note.id}`,
      type: "note",
      ts: note.createdAt.toISOString(),
      noteId: note.id,
      content: note.content,
      isInternal: note.isInternal,
      authorId: note.authorId,
      entityType: resourceType,
      entityId: resourceId,
    },
  });
});

router.delete("/persons/feed/notes/:noteId", requireAuth, requireRole(...STAFF_ROLES, ...ADMIN_ROLES, ...AGENT_ROLES), async (req, res): Promise<void> => {
  const parsedQ = contextQuerySchema.safeParse(req.query);
  if (!parsedQ.success) { res.status(400).json({ error: "Invalid query params" }); return; }

  const noteId = parseInt(req.params["noteId"] as string, 10);
  if (isNaN(noteId)) { res.status(400).json({ error: "Invalid noteId" }); return; }

  const { context, id } = parsedQ.data;
  const ids = await resolvePersonIds(context, id);
  if (!ids) { res.status(404).json({ error: "Not found" }); return; }

  const access = await checkPersonAccess(req, ids, context);
  if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }

  const contextOrConds = buildNotesConditions(ids);
  const [note] = await db.select().from(notesTable).where(
    and(eq(notesTable.id, noteId), or(...contextOrConds)),
  );
  if (!note) { res.status(404).json({ error: "Note not found" }); return; }

  if (note.authorId !== req.user!.id && !access.isStaff) {
    res.status(403).json({ error: "Can only delete your own notes" });
    return;
  }

  await db.delete(notesTable).where(eq(notesTable.id, noteId));
  feedBus.publish({ personKeys: personKeys(ids.leadId, ids.studentId), action: "note_deleted", itemId: noteId });
  logAudit(req.user!.id, "delete_note", note.resourceType, note.resourceId, { noteId }, req.ip);

  res.status(204).end();
});

const addFollowUpBodySchema = z.object({
  title: z.string().min(1).max(500),
  scheduledAt: z.string().refine(s => !isNaN(Date.parse(s)), { message: "Invalid date" }),
  notes: z.string().max(2000).optional(),
  assignedToId: z.number().int().positive().optional(),
});

router.post("/persons/feed/follow-ups", requireAuth, requireRole(...STAFF_ROLES, ...ADMIN_ROLES, ...AGENT_ROLES), async (req, res): Promise<void> => {
  const parsedQ = contextQuerySchema.safeParse(req.query);
  if (!parsedQ.success) { res.status(400).json({ error: "Invalid query params" }); return; }

  const bodyParsed = addFollowUpBodySchema.safeParse(req.body);
  if (!bodyParsed.success) { res.status(400).json({ error: "Invalid body", details: bodyParsed.error.flatten() }); return; }

  const { context, id } = parsedQ.data;
  const ids = await resolvePersonIds(context, id);
  if (!ids) { res.status(404).json({ error: "Not found" }); return; }

  const access = await checkPersonAccess(req, ids, context);
  if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }

  const resourceType: "lead" | "student" = ids.studentId ? "student" : "lead";

  const [fu] = await db.insert(followUpsTable).values({
    leadId: ids.leadId,
    studentId: ids.studentId,
    resourceType,
    title: bodyParsed.data.title,
    scheduledAt: new Date(bodyParsed.data.scheduledAt),
    notes: bodyParsed.data.notes ?? null,
    assignedToId: bodyParsed.data.assignedToId ?? req.user!.id,
    createdById: req.user!.id,
  }).returning();

  feedBus.publish({ personKeys: personKeys(ids.leadId, ids.studentId), action: "followup_added", itemId: fu.id });
  logAudit(req.user!.id, "create_follow_up", resourceType, (ids.studentId ?? ids.leadId)!, { fuId: fu.id }, req.ip);

  res.status(201).json({
    data: {
      id: `followup_${fu.id}`,
      type: "follow_up",
      ts: fu.createdAt.toISOString(),
      followUpId: fu.id,
      title: fu.title,
      dueAt: fu.scheduledAt?.toISOString() ?? null,
      completed: fu.completed,
      assignedToId: fu.assignedToId,
      entityType: resourceType,
    },
  });
});

const patchFollowUpBodySchema = z.object({
  completed: z.boolean().optional(),
  title: z.string().min(1).max(500).optional(),
  scheduledAt: z.string().refine(s => !isNaN(Date.parse(s)), { message: "Invalid date" }).optional(),
  notes: z.string().max(2000).nullable().optional(),
  assignedToId: z.number().int().positive().nullable().optional(),
});

router.patch("/persons/feed/follow-ups/:fuId", requireAuth, requireRole(...STAFF_ROLES, ...ADMIN_ROLES, ...AGENT_ROLES), async (req, res): Promise<void> => {
  const parsedQ = contextQuerySchema.safeParse(req.query);
  if (!parsedQ.success) { res.status(400).json({ error: "Invalid query params" }); return; }

  const fuId = parseInt(req.params["fuId"] as string, 10);
  if (isNaN(fuId)) { res.status(400).json({ error: "Invalid fuId" }); return; }

  const bodyParsed = patchFollowUpBodySchema.safeParse(req.body);
  if (!bodyParsed.success) { res.status(400).json({ error: "Invalid body" }); return; }

  const { context, id } = parsedQ.data;
  const ids = await resolvePersonIds(context, id);
  if (!ids) { res.status(404).json({ error: "Not found" }); return; }

  const access = await checkPersonAccess(req, ids, context);
  if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }

  const updates: Record<string, unknown> = { updatedById: req.user!.id };
  const { completed, title, scheduledAt, notes, assignedToId } = bodyParsed.data;
  if (completed !== undefined) {
    updates.completed = completed;
    updates.completedAt = completed ? new Date() : null;
  }
  if (title !== undefined) updates.title = title;
  if (scheduledAt !== undefined) updates.scheduledAt = new Date(scheduledAt);
  if (notes !== undefined) updates.notes = notes;
  if (assignedToId !== undefined) updates.assignedToId = assignedToId;

  const fuContextConds = [
    ...(ids.leadId ? [eq(followUpsTable.leadId, ids.leadId)] : []),
    ...(ids.studentId ? [eq(followUpsTable.studentId, ids.studentId)] : []),
  ];
  const [updated] = await db.update(followUpsTable).set(updates as any).where(
    and(eq(followUpsTable.id, fuId), fuContextConds.length > 0 ? or(...fuContextConds) : sql`false`),
  ).returning();
  if (!updated) { res.status(404).json({ error: "Follow-up not found" }); return; }

  feedBus.publish({ personKeys: personKeys(ids.leadId, ids.studentId), action: "followup_updated", itemId: fuId });

  res.json({ data: updated });
});

router.get("/persons/feed/stream", requireAuth, requireRole(...STAFF_ROLES, ...ADMIN_ROLES, ...AGENT_ROLES), async (req, res): Promise<void> => {
  const parsed = contextQuerySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid query params" }); return; }

  const { context, id } = parsed.data;
  const ids = await resolvePersonIds(context, id);
  if (!ids) { res.status(404).json({ error: "Not found" }); return; }

  const access = await checkPersonAccess(req, ids, context);
  if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }

  const myKeys = new Set(personKeys(ids.leadId, ids.studentId));

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof (res as any).flushHeaders === "function") (res as any).flushHeaders();
  res.write(`retry: 5000\n\n`);

  const ping = setInterval(() => {
    try { res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`); } catch { /* ignore */ }
  }, 25000);

  const handler = (event: { personKeys: string[]; action: string; itemId: number }) => {
    if (!event.personKeys.some(k => myKeys.has(k))) return;
    try {
      res.write(`event: feed_update\n`);
      res.write(`data: ${JSON.stringify({ action: event.action, itemId: event.itemId })}\n\n`);
    } catch { /* ignore */ }
  };

  const unsubscribe = feedBus.subscribe(handler);
  const cleanup = () => {
    clearInterval(ping);
    unsubscribe();
    try { res.end(); } catch { /* ignore */ }
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
});

export default router;
