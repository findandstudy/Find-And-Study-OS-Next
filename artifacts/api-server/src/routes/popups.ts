import { Router, type IRouter } from "express";
import { db, popupsTable, popupDismissalsTable } from "@workspace/db";
import { eq, and, or, isNull, lte, gte, desc } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth";
import { ADMIN_ROLES, AGENT_ROLES } from "../lib/roles";

const router: IRouter = Router();

router.get("/popups", requireAuth, requireRole(...ADMIN_ROLES), async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(popupsTable)
    .orderBy(desc(popupsTable.createdAt));
  res.json({ data: rows });
});

router.get("/popups/active", requireAuth, async (req, res): Promise<void> => {
  const user = req.user!;
  const isAgent = (AGENT_ROLES as readonly string[]).includes(user.role);
  if (!isAgent) {
    res.json({ data: [] });
    return;
  }

  const now = new Date();

  const rows = await db
    .select()
    .from(popupsTable)
    .where(
      and(
        eq(popupsTable.status, "active"),
        or(isNull(popupsTable.startsAt), lte(popupsTable.startsAt, now)),
        or(isNull(popupsTable.expiresAt), gte(popupsTable.expiresAt, now)),
        or(
          eq(popupsTable.targetAudience, "all_users"),
          eq(popupsTable.targetAudience, "all_agents"),
          eq(popupsTable.targetAudience, "specific_agents"),
        )
      )
    )
    .orderBy(desc(popupsTable.createdAt));

  const userDismissals = await db
    .select()
    .from(popupDismissalsTable)
    .where(eq(popupDismissalsTable.userId, user.id));

  const permanentDismissedIds = new Set(
    userDismissals.filter(d => d.permanent).map(d => d.popupId)
  );

  const anyDismissedIds = new Set(
    userDismissals.map(d => d.popupId)
  );

  const eligible = rows.filter(popup => {
    if (permanentDismissedIds.has(popup.id)) return false;

    if (popup.targetAudience === "specific_agents") {
      const ids = Array.isArray(popup.targetAgentIds) ? popup.targetAgentIds : [];
      if (!ids.includes(user.id)) return false;
    }

    if (popup.frequency === "once_per_user" && anyDismissedIds.has(popup.id)) return false;

    return true;
  });

  res.json({ data: eligible });
});

router.get("/popups/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [row] = await db.select().from(popupsTable).where(eq(popupsTable.id, id));
  if (!row) { res.status(404).json({ error: "Popup not found" }); return; }
  res.json(row);
});

router.post("/popups", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const {
    title, content, imageUrl, linkUrl, linkText,
    targetAudience, targetAgentIds, frequency, status,
    startsAt, expiresAt,
  } = req.body || {};

  if (typeof title !== "string" || !title.trim()) {
    res.status(400).json({ error: "Title is required" }); return;
  }
  if (typeof content !== "string" || !content.trim()) {
    res.status(400).json({ error: "Content is required" }); return;
  }

  const validAudiences = ["all_users", "all_agents", "specific_agents"];
  const aud = typeof targetAudience === "string" ? targetAudience : "all_agents";
  if (!validAudiences.includes(aud)) {
    res.status(400).json({ error: "Invalid target audience" }); return;
  }

  const validFreqs = ["every_session", "every_login", "once_per_user"];
  const freq = typeof frequency === "string" ? frequency : "every_session";
  if (!validFreqs.includes(freq)) {
    res.status(400).json({ error: "Invalid frequency" }); return;
  }

  const validStatuses = ["active", "inactive"];
  const stat = typeof status === "string" ? status : "active";
  if (!validStatuses.includes(stat)) {
    res.status(400).json({ error: "Invalid status" }); return;
  }

  const agentIds: number[] = Array.isArray(targetAgentIds)
    ? targetAgentIds.map(Number).filter(n => !isNaN(n) && n > 0)
    : [];

  const [created] = await db
    .insert(popupsTable)
    .values({
      title: title.trim(),
      content: content.trim(),
      imageUrl: typeof imageUrl === "string" && imageUrl.trim() ? imageUrl.trim() : null,
      linkUrl: typeof linkUrl === "string" && linkUrl.trim() ? linkUrl.trim() : null,
      linkText: typeof linkText === "string" && linkText.trim() ? linkText.trim() : null,
      targetAudience: aud,
      targetAgentIds: agentIds,
      frequency: freq,
      status: stat,
      startsAt: startsAt ? new Date(startsAt) : null,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      createdBy: req.user!.id,
    })
    .returning();

  res.status(201).json(created);
});

router.put("/popups/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [existing] = await db.select().from(popupsTable).where(eq(popupsTable.id, id));
  if (!existing) { res.status(404).json({ error: "Popup not found" }); return; }

  const {
    title, content, imageUrl, linkUrl, linkText,
    targetAudience, targetAgentIds, frequency, status,
    startsAt, expiresAt,
  } = req.body || {};

  const updates: Partial<typeof popupsTable.$inferInsert> = {};

  if (title !== undefined) {
    if (typeof title !== "string" || !title.trim()) {
      res.status(400).json({ error: "Title is required" }); return;
    }
    updates.title = title.trim();
  }
  if (content !== undefined) {
    if (typeof content !== "string" || !content.trim()) {
      res.status(400).json({ error: "Content is required" }); return;
    }
    updates.content = content.trim();
  }
  if (imageUrl !== undefined) updates.imageUrl = typeof imageUrl === "string" && imageUrl.trim() ? imageUrl.trim() : null;
  if (linkUrl !== undefined) updates.linkUrl = typeof linkUrl === "string" && linkUrl.trim() ? linkUrl.trim() : null;
  if (linkText !== undefined) updates.linkText = typeof linkText === "string" && linkText.trim() ? linkText.trim() : null;

  if (targetAudience !== undefined) {
    const validAudiences = ["all_users", "all_agents", "specific_agents"];
    if (!validAudiences.includes(targetAudience)) {
      res.status(400).json({ error: "Invalid target audience" }); return;
    }
    updates.targetAudience = targetAudience;
  }

  if (targetAgentIds !== undefined) {
    updates.targetAgentIds = Array.isArray(targetAgentIds)
      ? targetAgentIds.map(Number).filter(n => !isNaN(n) && n > 0)
      : [];
  }

  if (frequency !== undefined) {
    const validFreqs = ["every_session", "every_login", "once_per_user"];
    if (!validFreqs.includes(frequency)) {
      res.status(400).json({ error: "Invalid frequency" }); return;
    }
    updates.frequency = frequency;
  }

  if (status !== undefined) {
    const validStatuses = ["active", "inactive"];
    if (!validStatuses.includes(status)) {
      res.status(400).json({ error: "Invalid status" }); return;
    }
    updates.status = status;
  }

  if (startsAt !== undefined) updates.startsAt = startsAt ? new Date(startsAt) : null;
  if (expiresAt !== undefined) updates.expiresAt = expiresAt ? new Date(expiresAt) : null;

  const [updated] = await db
    .update(popupsTable)
    .set(updates)
    .where(eq(popupsTable.id, id))
    .returning();

  res.json(updated);
});

router.delete("/popups/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [deleted] = await db
    .delete(popupsTable)
    .where(eq(popupsTable.id, id))
    .returning();
  if (!deleted) { res.status(404).json({ error: "Popup not found" }); return; }
  res.json({ ok: true });
});

router.post("/popups/:id/dismiss", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const user = req.user!;
  const permanent = req.body?.permanent === true;

  const [existing] = await db
    .select({ id: popupDismissalsTable.id, permanent: popupDismissalsTable.permanent })
    .from(popupDismissalsTable)
    .where(
      and(
        eq(popupDismissalsTable.popupId, id),
        eq(popupDismissalsTable.userId, user.id)
      )
    );

  if (existing) {
    if (permanent && !existing.permanent) {
      await db
        .update(popupDismissalsTable)
        .set({ permanent: true })
        .where(eq(popupDismissalsTable.id, existing.id));
    }
  } else {
    await db.insert(popupDismissalsTable).values({
      popupId: id,
      userId: user.id,
      permanent,
    });
  }

  res.json({ ok: true });
});


export default router;
