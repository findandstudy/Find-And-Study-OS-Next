import { Router, type IRouter } from "express";
import { db, tasksTable, usersTable, type TaskNote } from "@workspace/db";
import { eq, and, desc, isNull, isNotNull, or, sql, inArray } from "drizzle-orm";
import { requireAuth, requireRole, requireAgentStaffPermission, logAudit } from "../lib/auth";
import { ADMIN_ROLES, STAFF_ROLES } from "../lib/roles";
import { dispatchNotification } from "../lib/notificationDispatcher";

const router: IRouter = Router();

const VALID_PRIORITIES = ["low", "medium", "high"] as const;
const VALID_STATUSES = ["todo", "in_progress", "done"] as const;

type Priority = (typeof VALID_PRIORITIES)[number];
type Status = (typeof VALID_STATUSES)[number];

function isValidPriority(value: unknown): value is Priority {
  return typeof value === "string" && (VALID_PRIORITIES as readonly string[]).includes(value);
}
function isValidStatus(value: unknown): value is Status {
  return typeof value === "string" && (VALID_STATUSES as readonly string[]).includes(value);
}

function isAdmin(role: string): boolean {
  return (ADMIN_ROLES as readonly string[]).includes(role);
}

function isStaff(role: string): boolean {
  return (STAFF_ROLES as readonly string[]).includes(role);
}

async function getUserDisplayName(userId: number): Promise<string> {
  const [u] = await db
    .select({ firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (!u) return "Unknown";
  const full = `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim();
  return full || u.email || "Unknown";
}

router.get("/tasks", requireAuth, requireRole(...STAFF_ROLES, "agent_staff"), requireAgentStaffPermission("tasks"), async (req, res): Promise<void> => {
  const archived = String(req.query.archived ?? "") === "true";
  const limit = Math.min(1000, Math.max(1, parseInt(String(req.query.limit ?? "500"), 10) || 500));
  const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10) || 0);
  const assignedToMe = String(req.query.assignedTo ?? "") === "me";
  const me = req.user!;

  const conditions = [];
  conditions.push(archived ? isNotNull(tasksTable.archivedAt) : isNull(tasksTable.archivedAt));
  if (assignedToMe) {
    // Explicitly request only tasks assigned to the current user (any role).
    conditions.push(eq(tasksTable.assignedTo, me.id));
  } else if (!isAdmin(me.role)) {
    conditions.push(or(eq(tasksTable.assignedTo, me.id), isNull(tasksTable.assignedTo))!);
  }

  const data = await db
    .select()
    .from(tasksTable)
    .where(and(...conditions))
    .orderBy(desc(tasksTable.createdAt))
    .limit(limit)
    .offset(offset);

  res.json({ data });
});

router.get("/tasks/assignees", requireAuth, requireRole(...STAFF_ROLES), async (_req, res): Promise<void> => {
  const data = await db
    .select({
      id: usersTable.id,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      email: usersTable.email,
      role: usersTable.role,
    })
    .from(usersTable)
    .where(and(
      eq(usersTable.isActive, true),
      isNull(usersTable.deletedAt),
      inArray(usersTable.role, [...STAFF_ROLES]),
    ));
  res.json({ data });
});

router.post("/tasks", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const { title, description, assignedTo, assignedToName, dueDate, priority, status } = req.body ?? {};
  if (!title || typeof title !== "string" || !title.trim()) {
    res.status(400).json({ error: "Title is required" });
    return;
  }
  if (priority !== undefined && priority !== null && !isValidPriority(priority)) {
    res.status(400).json({ error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(", ")}` });
    return;
  }
  if (status !== undefined && status !== null && !isValidStatus(status)) {
    res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` });
    return;
  }

  let resolvedAssignedToName: string | null = assignedToName ?? null;
  if (assignedTo !== undefined && assignedTo !== null) {
    const assigneeId = Number(assignedTo);
    if (!Number.isFinite(assigneeId)) {
      res.status(400).json({ error: "Invalid assignedTo" });
      return;
    }
    const [u] = await db.select().from(usersTable).where(eq(usersTable.id, assigneeId));
    if (!u || !u.isActive) {
      res.status(400).json({ error: "Assigned user not found or inactive" });
      return;
    }
    if (!resolvedAssignedToName) {
      resolvedAssignedToName = `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email || "Unknown";
    }
  }

  const initialStatus = (status as Status) || "todo";
  const [created] = await db.insert(tasksTable).values({
    title: title.trim(),
    description: description?.toString().trim() || null,
    assignedTo: assignedTo === undefined || assignedTo === null ? null : Number(assignedTo),
    assignedToName: resolvedAssignedToName,
    dueDate: dueDate || null,
    priority: (priority as Priority) || "medium",
    status: initialStatus,
    completedAt: initialStatus === "done" ? new Date() : null,
    taskNotes: [],
    createdBy: req.user!.id,
  }).returning();

  logAudit(req.user!.id, "task.create", "task", created.id, { title: created.title });

  if (created.assignedTo) {
    const actorName = `${req.user!.firstName ?? ""} ${req.user!.lastName ?? ""}`.trim() || req.user!.email || "Bir yönetici";
    try {
      await dispatchNotification({
        actorUserId: req.user!.id,
        event: "task.assigned",
        title: "Yeni görev atandı",
        body: `${actorName} size yeni bir görev atadı: "${created.title}"`,
        actionUrl: `/staff/tasks?taskId=${created.id}`,
        icon: "ClipboardList",
        recipientUserIds: [created.assignedTo],
        data: { resourceType: "task", taskId: created.id },
        templateVars: { actorName, taskTitle: created.title },
      });
    } catch {}
  }

  res.status(201).json(created);
});

router.put("/tasks/:id", requireAuth, requireRole(...STAFF_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const me = req.user!;
  const [existing] = await db.select().from(tasksTable).where(eq(tasksTable.id, id));
  if (!existing || existing.archivedAt) { res.status(404).json({ error: "Task not found" }); return; }

  if (!isAdmin(me.role)) {
    if (existing.assignedTo !== me.id) {
      res.status(403).json({ error: "You can only update tasks assigned to you" });
      return;
    }
  }

  const { title, description, assignedTo, assignedToName, dueDate, priority, status } = req.body ?? {};
  const updates: Record<string, unknown> = {};

  if (title !== undefined) {
    if (typeof title !== "string" || !title.trim()) {
      res.status(400).json({ error: "Title is required" });
      return;
    }
    updates.title = title.trim();
  }
  if (description !== undefined) updates.description = description?.toString().trim() || null;
  if (dueDate !== undefined) updates.dueDate = dueDate || null;
  if (priority !== undefined) {
    if (!isValidPriority(priority)) {
      res.status(400).json({ error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(", ")}` });
      return;
    }
    updates.priority = priority;
  }
  if (status !== undefined) {
    if (!isValidStatus(status)) {
      res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` });
      return;
    }
    updates.status = status;
    if (status === "done") {
      updates.completedAt = existing.status === "done" && existing.completedAt
        ? existing.completedAt
        : new Date();
    } else {
      updates.completedAt = null;
    }
  }
  if (assignedTo !== undefined) {
    if (!isAdmin(me.role)) {
      res.status(403).json({ error: "Only admins can reassign tasks" });
      return;
    }
    if (assignedTo === null) {
      updates.assignedTo = null;
      updates.assignedToName = null;
    } else {
      const assigneeId = Number(assignedTo);
      if (!Number.isFinite(assigneeId)) {
        res.status(400).json({ error: "Invalid assignedTo" });
        return;
      }
      const [u] = await db.select().from(usersTable).where(eq(usersTable.id, assigneeId));
      if (!u || !u.isActive) {
        res.status(400).json({ error: "Assigned user not found or inactive" });
        return;
      }
      updates.assignedTo = assigneeId;
      updates.assignedToName = assignedToName ?? (`${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email || "Unknown");
    }
  } else if (assignedToName !== undefined && isAdmin(me.role)) {
    updates.assignedToName = assignedToName;
  }

  if (Object.keys(updates).length === 0) {
    res.json(existing);
    return;
  }

  updates.updatedAt = new Date();

  const [updated] = await db.update(tasksTable).set(updates).where(eq(tasksTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Task not found" }); return; }
  logAudit(me.id, "task.update", "task", id, updates);

  if (
    updated.assignedTo &&
    updated.assignedTo !== existing.assignedTo &&
    updated.assignedTo !== me.id
  ) {
    const actorName = `${me.firstName ?? ""} ${me.lastName ?? ""}`.trim() || me.email || "Bir yönetici";
    try {
      await dispatchNotification({
        actorUserId: me.id,
        event: "task.assigned",
        title: "Yeni görev atandı",
        body: `${actorName} size bir görev atadı: "${updated.title}"`,
        actionUrl: `/staff/tasks?taskId=${updated.id}`,
        icon: "ClipboardList",
        recipientUserIds: [updated.assignedTo],
        data: { resourceType: "task", taskId: updated.id },
        templateVars: { actorName, taskTitle: updated.title },
      });
    } catch {}
  }

  res.json(updated);
});

router.delete("/tasks/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const now = new Date();
  const [updated] = await db
    .update(tasksTable)
    .set({ archivedAt: now, updatedAt: now })
    .where(and(eq(tasksTable.id, id), isNull(tasksTable.archivedAt)))
    .returning();
  if (!updated) { res.status(404).json({ error: "Task not found" }); return; }
  logAudit(req.user!.id, "task.archive", "task", id);
  res.json({ success: true });
});

router.post("/tasks/bulk-archive", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const ids: number[] = Array.from(new Set<number>(
    rawIds
      .map((value: unknown) => Number(value))
      .filter((value: number) => Number.isInteger(value) && value > 0),
  ));

  if (ids.length === 0) {
    res.status(400).json({ error: "At least one valid task id is required" });
    return;
  }
  if (ids.length > 500) {
    res.status(400).json({ error: "A maximum of 500 tasks can be archived at once" });
    return;
  }

  const now = new Date();
  const updated = await db
    .update(tasksTable)
    .set({ archivedAt: now, updatedAt: now })
    .where(and(inArray(tasksTable.id, ids), isNull(tasksTable.archivedAt)))
    .returning({ id: tasksTable.id });

  for (const task of updated) {
    logAudit(req.user!.id, "task.archive", "task", task.id, { source: "bulk" });
  }

  res.json({ success: true, archived: updated.length });
});

router.post("/tasks/restore/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [updated] = await db
    .update(tasksTable)
    .set({ archivedAt: null, updatedAt: new Date() })
    .where(and(eq(tasksTable.id, id), isNotNull(tasksTable.archivedAt)))
    .returning();
  if (!updated) { res.status(404).json({ error: "Archived task not found" }); return; }
  logAudit(req.user!.id, "task.restore", "task", id);
  res.json(updated);
});

router.post("/tasks/:id/notes", requireAuth, requireRole(...STAFF_ROLES, "agent_staff"), requireAgentStaffPermission("tasks"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) { res.status(400).json({ error: "Note text is required" }); return; }

  const me = req.user!;
  const [task] = await db.select().from(tasksTable).where(and(eq(tasksTable.id, id), isNull(tasksTable.archivedAt)));
  if (!task) { res.status(404).json({ error: "Task not found" }); return; }

  if (!isAdmin(me.role)) {
    const allowed = task.assignedTo === me.id || task.assignedTo === null;
    if (!allowed) { res.status(403).json({ error: "You cannot comment on this task" }); return; }
  }

  // Validate mention IDs: must be active, non-deleted users; dedupe and exclude self.
  const rawMentions = Array.isArray(req.body?.mentions) ? req.body.mentions : [];
  const requestedIds = Array.from(new Set(
    rawMentions
      .map((v: unknown) => Number(v))
      .filter((n: number) => Number.isFinite(n) && n !== me.id)
  )) as number[];

  let validMentions: number[] = [];
  if (requestedIds.length > 0) {
    const validUsers = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(
        inArray(usersTable.id, requestedIds),
        eq(usersTable.isActive, true),
        isNull(usersTable.deletedAt),
      ));
    validMentions = validUsers.map(u => u.id);
  }

  const authorName = await getUserDisplayName(me.id);
  const note: TaskNote = {
    id: crypto.randomUUID(),
    text,
    createdAt: new Date().toISOString(),
    authorName,
    ...(validMentions.length > 0 ? { mentions: validMentions } : {}),
  };
  // Atomic JSONB append to avoid races where two concurrent appends
  // both read the same baseline and one overwrites the other.
  const noteJson = JSON.stringify([note]);
  const [updated] = await db
    .update(tasksTable)
    .set({
      taskNotes: sql`COALESCE(${tasksTable.taskNotes}, '[]'::jsonb) || ${noteJson}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(tasksTable.id, id))
    .returning();

  if (validMentions.length > 0) {
    const snippet = text.length > 140 ? `${text.slice(0, 140)}…` : text;
    try {
      await dispatchNotification({
        actorUserId: me.id,
        event: "task.mention",
        title: `${authorName} mentioned you in a task`,
        body: `${authorName} mentioned you in a note on "${task.title}": ${snippet}`,
        actionUrl: `/staff/tasks?taskId=${task.id}&noteId=${note.id}`,
        icon: "AtSign",
        recipientUserIds: validMentions,
        templateVars: {
          authorName,
          taskTitle: task.title,
          snippet,
        },
      });
    } catch {}
  }

  res.status(201).json(updated);
});

router.delete("/tasks/:id/notes/:noteId", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const noteId = req.params.noteId;
  if (!Number.isFinite(id) || !noteId) { res.status(400).json({ error: "Invalid id" }); return; }
  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, id));
  if (!task) { res.status(404).json({ error: "Task not found" }); return; }
  const existingNotes = Array.isArray(task.taskNotes) ? (task.taskNotes as TaskNote[]) : [];
  const newNotes = existingNotes.filter(n => n.id !== noteId);
  const [updated] = await db
    .update(tasksTable)
    .set({ taskNotes: newNotes, updatedAt: new Date() })
    .where(eq(tasksTable.id, id))
    .returning();
  res.json(updated);
});

export default router;
