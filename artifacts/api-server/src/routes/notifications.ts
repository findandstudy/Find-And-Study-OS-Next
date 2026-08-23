import { Router, type IRouter } from "express";
import {
  db,
  notificationsTable,
  notificationRulesTable,
  applicationsTable,
  studentsTable,
  pipelineStagesTable,
} from "@workspace/db";
import { eq, and, desc, sql, isNull, inArray, like, or } from "drizzle-orm";
import { requireAuth, requireRole, logAudit } from "../lib/auth";
import { ADMIN_ROLES } from "../lib/roles";
import {
  DEFAULT_NOTIFICATION_RULES,
  NOTIFICATION_EVENTS,
  NOTIFICATION_CHANNELS,
} from "@workspace/db";
import { notificationBus, type NotificationBusEvent } from "../lib/notificationBus";
import { coalesceRead } from "../lib/readPathCoalescing";
import {
  cacheNotificationCounts,
  getCachedNotificationCounts,
  invalidateNotificationCounts,
  type NotificationSectionCounts,
} from "../lib/notificationCountCache";
import {
  IMPORTANT_NOTIFICATION_TYPES,
  isImportantNotification,
  notificationPriority,
} from "../lib/notificationPriority";

const router: IRouter = Router();

/**
 * SQL fragment that excludes notifications whose target resource has been
 * deleted (or, for soft-deletable tables, soft-deleted). The bell badge,
 * the per-section nav badges, and the notification panel listing all share
 * this filter so they stay in sync — a notification pointing at a vanished
 * lead/student/application/conversation never contributes to a count or
 * shows up in the panel.
 *
 * Notifications without a recognised resource reference (system messages,
 * etc.) are kept by default — only known patterns are checked.
 */
const liveResourceFilter = sql`(
  CASE
    WHEN ${notificationsTable.actionUrl} ~ '/applications/([0-9]+)' THEN
      EXISTS (
        SELECT 1 FROM applications a
        WHERE a.id = (regexp_match(${notificationsTable.actionUrl}, '/applications/([0-9]+)'))[1]::int
          AND a.deleted_at IS NULL
      )
    WHEN ${notificationsTable.actionUrl} ~ '/leads/([0-9]+)' THEN
      EXISTS (
        SELECT 1 FROM leads l
        WHERE l.id = (regexp_match(${notificationsTable.actionUrl}, '/leads/([0-9]+)'))[1]::int
          AND l.deleted_at IS NULL
      )
    WHEN ${notificationsTable.actionUrl} ~ '/students/([0-9]+)' THEN
      EXISTS (
        SELECT 1 FROM students s
        WHERE s.id = (regexp_match(${notificationsTable.actionUrl}, '/students/([0-9]+)'))[1]::int
          AND s.deleted_at IS NULL
      )
    WHEN ${notificationsTable.actionUrl} ~ 'conversation=([0-9]+)' THEN
      EXISTS (
        SELECT 1 FROM conversations c
        WHERE c.id = (regexp_match(${notificationsTable.actionUrl}, 'conversation=([0-9]+)'))[1]::int
      )
    ELSE TRUE
  END
)`;

/**
 * Map a notification to the sidebar section whose badge it should feed
 * (or null if it belongs to none). Shared by the section-count badge query
 * and the "mark section read on visit" endpoint so they never drift apart.
 */
function bucketSection(type: string, url: string, resourceType: string): "leads" | "students" | "applications" | "tasks" | null {
  if (type.startsWith("lead.") || resourceType === "lead" || url.includes("/leads/")) return "leads";
  if (type.startsWith("student.") || type.startsWith("document.") || resourceType === "student" || url.includes("/students/")) return "students";
  if (type.startsWith("application.") || resourceType === "application" || url.includes("/applications/")) return "applications";
  if (type.startsWith("task.") || resourceType === "task" || url.includes("/tasks")) return "tasks";
  return null;
}

type NotificationRow = typeof notificationsTable.$inferSelect;

function dataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Older offer-expiry notifications only stored applicationId/stage/date.
 * Enrich them at read time so the browser can render both old and new rows in
 * the language currently selected by the user. This stays batched (at most two
 * extra queries for the notification page), avoiding an N+1 query path.
 */
async function enrichOfferExpiryNotifications(rows: NotificationRow[]): Promise<NotificationRow[]> {
  const offerRows = rows.filter(row => row.type === "application.offer_letter_expiring");
  if (offerRows.length === 0) return rows;

  const applicationIds = Array.from(new Set(offerRows
    .map(row => Number(dataRecord(row.data).applicationId))
    .filter(id => Number.isInteger(id) && id > 0)));
  const stageKeys = Array.from(new Set(offerRows
    .map(row => String(dataRecord(row.data).stage || "").trim())
    .filter(Boolean)));

  const applicationRows = applicationIds.length > 0
    ? await db.select({
        id: applicationsTable.id,
        universityName: applicationsTable.universityName,
        programName: applicationsTable.programName,
        studentFirstName: studentsTable.firstName,
        studentLastName: studentsTable.lastName,
      })
      .from(applicationsTable)
      .leftJoin(studentsTable, eq(applicationsTable.studentId, studentsTable.id))
      .where(inArray(applicationsTable.id, applicationIds))
    : [];
  const stageRows = stageKeys.length > 0
    ? await db.select({ key: pipelineStagesTable.key, label: pipelineStagesTable.label })
      .from(pipelineStagesTable)
      .where(and(
        eq(pipelineStagesTable.entityType, "application"),
        inArray(pipelineStagesTable.key, stageKeys),
      ))
    : [];

  const applicationsById = new Map(applicationRows.map(app => [app.id, app]));
  const stageLabels = new Map(stageRows.map(stage => [stage.key, stage.label]));

  return rows.map(row => {
    if (row.type !== "application.offer_letter_expiring") return row;
    const currentData = dataRecord(row.data);
    const applicationId = Number(currentData.applicationId);
    const app = applicationsById.get(applicationId);
    const stage = String(currentData.stage || "");
    const studentName = app
      ? [app.studentFirstName, app.studentLastName].filter(Boolean).join(" ").trim()
      : "";
    return {
      ...row,
      data: {
        ...currentData,
        studentName: currentData.studentName || studentName,
        universityName: currentData.universityName || app?.universityName || "",
        programName: currentData.programName || app?.programName || "",
        stageLabel: currentData.stageLabel || stageLabels.get(stage) || stage || "Offer Letter",
      },
    };
  });
}

/**
 * Live notification stream (SSE). Replaces the previous 15 s polling loop in
 * the browser NotificationCenter — events are pushed immediately when
 * dispatchNotification() inserts a row. Heartbeat every 25 s keeps idle
 * proxies from closing the connection.
 */
router.get("/notifications/events", requireAuth, (req, res): void => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof (res as { flushHeaders?: () => void }).flushHeaders === "function") {
    (res as { flushHeaders: () => void }).flushHeaders();
  }
  res.write(`retry: 5000\n\n`);

  const userId = req.user!.id;

  const ping = setInterval(() => {
    try { res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`); } catch { /* ignore */ }
  }, 25000);

  const handler = (event: NotificationBusEvent) => {
    if (event.userId !== userId) return;
    try {
      res.write(`event: notification\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch { /* socket may be closed */ }
  };
  const unsubscribe = notificationBus.subscribe(handler);

  const cleanup = () => {
    clearInterval(ping);
    unsubscribe();
    try { res.end(); } catch { /* ignore */ }
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
});

async function seedNotificationRules() {
  const existing = await db.select().from(notificationRulesTable);
  const existingEvents = new Set(existing.map(r => r.event));

  let added = 0;
  for (const rule of DEFAULT_NOTIFICATION_RULES) {
    if (existingEvents.has(rule.event)) continue;
    await db.insert(notificationRulesTable).values({
      event: rule.event,
      name: rule.name,
      category: rule.category,
      channels: rule.channels,
      recipientType: rule.recipientType,
      recipientRoles: rule.recipientRoles,
      isActive: true,
    });
    added++;
  }
  if (added > 0) console.log(`[notifications] Seeded ${added} new notification rules`);
}

seedNotificationRules().catch((err) => console.error("[notifications] Seed error:", err));

router.get("/notifications", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const { limit = "20", unreadOnly, view = "all" } = req.query as Record<string, string>;
  const parsedLimit = Math.max(1, Math.min(parseInt(limit, 10) || 20, 100));

  const conditions = [eq(notificationsTable.userId, userId), liveResourceFilter];
  if (unreadOnly === "true") {
    conditions.push(eq(notificationsTable.isRead, false));
  }
  if (view === "important") {
    conditions.push(
      or(
        inArray(notificationsTable.type, [...IMPORTANT_NOTIFICATION_TYPES]),
        like(notificationsTable.type, "%failed%"),
        like(notificationsTable.type, "%expired%"),
        like(notificationsTable.type, "%missing%"),
        like(notificationsTable.type, "%unmatched%"),
      )!,
    );
  }

  const notifications = await db
    .select()
    .from(notificationsTable)
    .where(and(...conditions))
    .orderBy(desc(notificationsTable.createdAt))
    .limit(parsedLimit);

  const enriched = await enrichOfferExpiryNotifications(notifications);
  res.json({
    data: enriched.map(row => ({ ...row, priority: notificationPriority(row.type) })),
  });
});

router.get("/notifications/unread-count", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const cached = getCachedNotificationCounts(userId);
  if (cached) {
    res.setHeader("X-Notification-Count-Cache", "hit");
    res.json({ count: cached.total });
    return;
  }
  const { value: count } = await coalesceRead({
    namespace: "notification-unread-count",
    key: String(userId),
    execute: async () => {
      const [row] = await db
        .select({ count: sql<number>`count(*)` })
        .from(notificationsTable)
        .where(and(
          eq(notificationsTable.userId, userId),
          eq(notificationsTable.isRead, false),
          liveResourceFilter,
        ));
      return Number(row.count);
    },
  });

  res.json({ count });
});

router.get("/notifications/section-counts", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const cached = getCachedNotificationCounts(userId);
  if (cached) {
    res.setHeader("X-Notification-Count-Cache", "hit");
    res.json(cached);
    return;
  }
  const { value: sections } = await coalesceRead({
    namespace: "notification-section-counts",
    key: String(userId),
    execute: async () => {
      const rows = await db
        .select({
          type: notificationsTable.type,
          actionUrl: notificationsTable.actionUrl,
          data: notificationsTable.data,
        })
        .from(notificationsTable)
        .where(and(
          eq(notificationsTable.userId, userId),
          eq(notificationsTable.isRead, false),
          liveResourceFilter,
        ));

      const result: NotificationSectionCounts = {
        total: rows.length,
        importantTotal: rows.filter(row => isImportantNotification(row.type || "")).length,
        leads: 0,
        students: 0,
        applications: 0,
        tasks: 0,
      };
      for (const row of rows) {
        const section = bucketSection(
          row.type || "",
          row.actionUrl || "",
          (row.data as any)?.resourceType || "",
        );
        if (section) result[section]++;
      }
      return result;
    },
  });
  cacheNotificationCounts(userId, sections);
  res.setHeader("X-Notification-Count-Cache", "miss");
  res.json(sections);
});

/**
 * Mark every unread notification belonging to a sidebar section as read.
 * Driven by the same bucketing rules used for the section badge counts, so
 * visiting a section page (Leads/Students/Applications/Tasks) clears its badge.
 */
router.post("/notifications/section/:section/read", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const section = String(req.params.section);
  if (!["leads", "students", "applications", "tasks"].includes(section)) {
    res.status(400).json({ error: "Unknown section" });
    return;
  }

  const rows = await db
    .select({
      id: notificationsTable.id,
      type: notificationsTable.type,
      actionUrl: notificationsTable.actionUrl,
      data: notificationsTable.data,
    })
    .from(notificationsTable)
    .where(and(
      eq(notificationsTable.userId, userId),
      eq(notificationsTable.isRead, false),
      liveResourceFilter,
    ));

  const ids = rows
    .filter(r => bucketSection(r.type || "", r.actionUrl || "", (r.data as any)?.resourceType || "") === section)
    .map(r => r.id);

  if (ids.length > 0) {
    await db
      .update(notificationsTable)
      .set({ isRead: true, readAt: new Date() })
      .where(and(eq(notificationsTable.userId, userId), inArray(notificationsTable.id, ids)));
    invalidateNotificationCounts(userId);
  }

  res.json({ success: true, marked: ids.length });
});

router.patch("/notifications/:id/read", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const userId = req.user!.id;

  const [notification] = await db
    .update(notificationsTable)
    .set({ isRead: true, readAt: new Date() })
    .where(and(eq(notificationsTable.id, id), eq(notificationsTable.userId, userId)))
    .returning();

  if (!notification) {
    res.status(404).json({ error: "Notification not found" });
    return;
  }
  invalidateNotificationCounts(userId);
  res.json(notification);
});

router.post("/notifications/mark-all-read", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.id;
  await db
    .update(notificationsTable)
    .set({ isRead: true, readAt: new Date() })
    .where(and(eq(notificationsTable.userId, userId), eq(notificationsTable.isRead, false)));

  invalidateNotificationCounts(userId);
  res.json({ success: true });
});

router.get("/notification-rules", requireAuth, requireRole(...ADMIN_ROLES), async (_req, res): Promise<void> => {
  const rules = await db
    .select()
    .from(notificationRulesTable)
    .orderBy(notificationRulesTable.category, notificationRulesTable.event);

  res.json({ data: rules });
});

router.get("/notification-rules/schema", requireAuth, requireRole(...ADMIN_ROLES), async (_req, res): Promise<void> => {
  res.json({
    events: NOTIFICATION_EVENTS,
    channels: NOTIFICATION_CHANNELS,
  });
});

router.patch("/notification-rules/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const updates: Record<string, unknown> = {};

  if (req.body.channels !== undefined) updates.channels = req.body.channels;
  if (req.body.recipientType !== undefined) updates.recipientType = req.body.recipientType;
  if (req.body.recipientRoles !== undefined) updates.recipientRoles = req.body.recipientRoles;
  if (req.body.isActive !== undefined) updates.isActive = req.body.isActive;
  if (req.body.template !== undefined) updates.template = req.body.template;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
  }

  const [rule] = await db
    .update(notificationRulesTable)
    .set(updates)
    .where(eq(notificationRulesTable.id, id))
    .returning();

  if (!rule) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }

  await logAudit(req.user!.id, "update_notification_rule", "notification_rule", id, updates, req.ip);
  res.json(rule);
});

router.post("/notification-rules", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const { event, name, category, channels, recipientType, recipientRoles, template } = req.body;

  if (!event || !name) {
    res.status(400).json({ error: "Event and name are required" });
    return;
  }

  const [rule] = await db
    .insert(notificationRulesTable)
    .values({
      event,
      name,
      category: category || "general",
      channels: channels || ["in_app"],
      recipientType: recipientType || "specific",
      recipientRoles: recipientRoles || [],
      isActive: true,
      template: template || {},
    })
    .returning();

  await logAudit(req.user!.id, "create_notification_rule", "notification_rule", rule.id, { event }, req.ip);
  res.status(201).json(rule);
});

export default router;
