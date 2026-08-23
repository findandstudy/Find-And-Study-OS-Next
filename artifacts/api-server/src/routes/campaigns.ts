import { Router, type IRouter } from "express";
import { db, campaignsTable, universitiesTable, agentsTable } from "@workspace/db";
import { eq, and, desc, isNull, isNotNull, inArray, sql } from "drizzle-orm";
import { requireAuth, requireRole, logAudit } from "../lib/auth";
import { ADMIN_ROLES } from "../lib/roles";

const router: IRouter = Router();

const VALID_TYPES = ["discount", "markup"] as const;
type ChangeType = (typeof VALID_TYPES)[number];

function isValidType(v: unknown): v is ChangeType {
  return typeof v === "string" && (VALID_TYPES as readonly string[]).includes(v);
}

function isISODateOnly(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function todayDateString(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function statusOf(c: { isActive: boolean; startDate: string; endDate: string; archivedAt: Date | null }): "active" | "scheduled" | "expired" | "disabled" | "archived" {
  if (c.archivedAt) return "archived";
  if (!c.isActive) return "disabled";
  const today = todayDateString();
  if (today < c.startDate) return "scheduled";
  if (today > c.endDate) return "expired";
  return "active";
}

function sanitizeNumberArray(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  const out: number[] = [];
  for (const v of input) {
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    if (!isNaN(n) && n > 0) out.push(n);
  }
  return Array.from(new Set(out));
}

function sanitizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const v of input) {
    if (typeof v === "string") {
      const t = v.trim();
      if (t) out.push(t);
    }
  }
  return Array.from(new Set(out));
}

router.get("/campaigns", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const showArchived = String(req.query.archived || "") === "true";
  const rows = await db
    .select()
    .from(campaignsTable)
    .where(showArchived ? isNotNull(campaignsTable.archivedAt) : isNull(campaignsTable.archivedAt))
    .orderBy(desc(campaignsTable.createdAt));
  const data = rows.map(r => ({ ...r, status: statusOf(r) }));
  res.json({ data });
});

router.get("/campaigns/agent-countries", requireAuth, requireRole(...ADMIN_ROLES), async (_req, res): Promise<void> => {
  const rows = await db
    .selectDistinct({ country: agentsTable.country })
    .from(agentsTable)
    .where(eq(agentsTable.status, "active"));
  const countries = rows.map(r => r.country).filter((c): c is string => !!c && c.trim() !== "").sort((a, b) => a.localeCompare(b));
  res.json({ data: countries });
});

router.get("/campaigns/universities", requireAuth, requireRole(...ADMIN_ROLES), async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: universitiesTable.id,
      name: universitiesTable.name,
      country: universitiesTable.country,
    })
    .from(universitiesTable)
    .orderBy(universitiesTable.country, universitiesTable.name);
  res.json({ data: rows });
});

router.post("/campaigns", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const { name, description, changeType, changePercent, startDate, endDate, universityIds, agentCountries, isActive } = req.body || {};

  if (typeof name !== "string" || !name.trim()) { res.status(400).json({ error: "Name is required" }); return; }
  if (!isValidType(changeType)) { res.status(400).json({ error: "Invalid change type" }); return; }
  const pct = Number(changePercent);
  if (isNaN(pct) || pct <= 0 || pct > 100) { res.status(400).json({ error: "Percent must be between 0 and 100" }); return; }
  if (!isISODateOnly(startDate) || !isISODateOnly(endDate)) { res.status(400).json({ error: "Dates must be in YYYY-MM-DD format" }); return; }
  if (startDate > endDate) { res.status(400).json({ error: "Start date must be on or before end date" }); return; }

  const unis = sanitizeNumberArray(universityIds);
  if (unis.length === 0) { res.status(400).json({ error: "Select at least one university" }); return; }
  const countries = sanitizeStringArray(agentCountries);

  // Verify universities exist
  const found = await db.select({ id: universitiesTable.id }).from(universitiesTable).where(inArray(universitiesTable.id, unis));
  if (found.length !== unis.length) { res.status(400).json({ error: "One or more universities are invalid" }); return; }

  const [created] = await db
    .insert(campaignsTable)
    .values({
      name: name.trim(),
      description: typeof description === "string" ? description.trim() || null : null,
      changeType,
      changePercent: pct,
      startDate,
      endDate,
      universityIds: unis,
      agentCountries: countries,
      isActive: isActive !== false,
      createdBy: req.user!.id,
    })
    .returning();

  logAudit(req.user!.id, "campaign.create", "campaign", created.id, { name: created.name, percent: pct, type: changeType });
  res.status(201).json({ ...created, status: statusOf(created) });
});

router.put("/campaigns/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [existing] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, id));
  if (!existing) { res.status(404).json({ error: "Campaign not found" }); return; }
  if (existing.archivedAt) { res.status(400).json({ error: "Cannot edit archived campaign" }); return; }

  const { name, description, changeType, changePercent, startDate, endDate, universityIds, agentCountries, isActive } = req.body || {};
  const updates: Partial<typeof campaignsTable.$inferInsert> = {};

  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim()) { res.status(400).json({ error: "Name is required" }); return; }
    updates.name = name.trim();
  }
  if (description !== undefined) updates.description = typeof description === "string" ? (description.trim() || null) : null;
  if (changeType !== undefined) {
    if (!isValidType(changeType)) { res.status(400).json({ error: "Invalid change type" }); return; }
    updates.changeType = changeType;
  }
  if (changePercent !== undefined) {
    const pct = Number(changePercent);
    if (isNaN(pct) || pct <= 0 || pct > 100) { res.status(400).json({ error: "Percent must be between 0 and 100" }); return; }
    updates.changePercent = pct;
  }
  if (startDate !== undefined) {
    if (!isISODateOnly(startDate)) { res.status(400).json({ error: "Invalid start date" }); return; }
    updates.startDate = startDate;
  }
  if (endDate !== undefined) {
    if (!isISODateOnly(endDate)) { res.status(400).json({ error: "Invalid end date" }); return; }
    updates.endDate = endDate;
  }
  const newStart = updates.startDate ?? existing.startDate;
  const newEnd = updates.endDate ?? existing.endDate;
  if (newStart > newEnd) { res.status(400).json({ error: "Start date must be on or before end date" }); return; }

  if (universityIds !== undefined) {
    const unis = sanitizeNumberArray(universityIds);
    if (unis.length === 0) { res.status(400).json({ error: "Select at least one university" }); return; }
    const found = await db.select({ id: universitiesTable.id }).from(universitiesTable).where(inArray(universitiesTable.id, unis));
    if (found.length !== unis.length) { res.status(400).json({ error: "One or more universities are invalid" }); return; }
    updates.universityIds = unis;
  }
  if (agentCountries !== undefined) updates.agentCountries = sanitizeStringArray(agentCountries);
  if (isActive !== undefined) updates.isActive = !!isActive;

  const [updated] = await db.update(campaignsTable).set(updates).where(eq(campaignsTable.id, id)).returning();
  logAudit(req.user!.id, "campaign.update", "campaign", id, updates);
  res.json({ ...updated, status: statusOf(updated) });
});

router.delete("/campaigns/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [updated] = await db
    .update(campaignsTable)
    .set({ archivedAt: new Date(), isActive: false })
    .where(and(eq(campaignsTable.id, id), isNull(campaignsTable.archivedAt)))
    .returning();
  if (!updated) { res.status(404).json({ error: "Campaign not found" }); return; }
  logAudit(req.user!.id, "campaign.archive", "campaign", id);
  res.json({ ok: true });
});

router.post("/campaigns/:id/restore", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [updated] = await db
    .update(campaignsTable)
    .set({ archivedAt: null })
    .where(and(eq(campaignsTable.id, id), isNotNull(campaignsTable.archivedAt)))
    .returning();
  if (!updated) { res.status(404).json({ error: "Campaign not found" }); return; }
  logAudit(req.user!.id, "campaign.restore", "campaign", id);
  res.json({ ...updated, status: statusOf(updated) });
});

// Reference sql to avoid unused import warnings if drizzle keeps it tree-shakable.
void sql;

export default router;
