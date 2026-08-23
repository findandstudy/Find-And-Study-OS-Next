import { Router, type IRouter } from "express";
import { db, leadAssignmentRulesTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { requireAuth, requireRole, logAudit } from "../lib/auth";
import { MANAGER_ROLES } from "../lib/roles";

const router: IRouter = Router();

const VALID_STRATEGIES = ["first", "round_robin"] as const;

function sanitizeStringArray(v: any): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(x => String(x).trim()).filter(Boolean).slice(0, 200);
}
function sanitizeIntArray(v: any): number[] {
  if (!Array.isArray(v)) return [];
  return v.map(x => parseInt(String(x), 10)).filter(n => Number.isFinite(n)).slice(0, 200);
}

router.get("/settings/lead-assignment-rules", requireAuth, requireRole(...MANAGER_ROLES), async (_req, res): Promise<void> => {
  const rows = await db.select().from(leadAssignmentRulesTable)
    .orderBy(asc(leadAssignmentRulesTable.priority), asc(leadAssignmentRulesTable.id));
  res.json({ data: rows });
});

router.post("/settings/lead-assignment-rules", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const { name, priority, isActive, countries, universityIds, cities, phoneCodes, sources, staffUserIds, strategy } = req.body;
  if (!name || !String(name).trim()) { res.status(400).json({ error: "name is required" }); return; }
  const staff = sanitizeIntArray(staffUserIds);
  if (staff.length === 0) { res.status(400).json({ error: "At least one staff member is required" }); return; }
  const strat: "first" | "round_robin" = VALID_STRATEGIES.includes(strategy as any) ? strategy : "first";

  const [rule] = await db.insert(leadAssignmentRulesTable).values({
    name: String(name).trim().slice(0, 200),
    priority: Number.isFinite(Number(priority)) ? Number(priority) : 0,
    isActive: isActive !== false,
    countries: sanitizeStringArray(countries),
    universityIds: sanitizeIntArray(universityIds),
    cities: sanitizeStringArray(cities),
    phoneCodes: sanitizeStringArray(phoneCodes),
    sources: sanitizeStringArray(sources),
    staffUserIds: staff,
    strategy: strat,
    lastAssignedIndex: 0,
  }).returning();
  logAudit(req.user!.id, "create_lead_assignment_rule", "lead_assignment_rule", rule.id, { name: rule.name }, req.ip);
  res.status(201).json(rule);
});

router.patch("/settings/lead-assignment-rules/:id", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const updates: Record<string, unknown> = {};
  const b = req.body;
  if (b.name !== undefined) updates.name = String(b.name).trim().slice(0, 200);
  if (b.priority !== undefined && Number.isFinite(Number(b.priority))) updates.priority = Number(b.priority);
  if (b.isActive !== undefined) updates.isActive = !!b.isActive;
  if (b.countries !== undefined) updates.countries = sanitizeStringArray(b.countries);
  if (b.universityIds !== undefined) updates.universityIds = sanitizeIntArray(b.universityIds);
  if (b.cities !== undefined) updates.cities = sanitizeStringArray(b.cities);
  if (b.phoneCodes !== undefined) updates.phoneCodes = sanitizeStringArray(b.phoneCodes);
  if (b.sources !== undefined) updates.sources = sanitizeStringArray(b.sources);
  if (b.staffUserIds !== undefined) {
    const staff = sanitizeIntArray(b.staffUserIds);
    if (staff.length === 0) { res.status(400).json({ error: "At least one staff member is required" }); return; }
    updates.staffUserIds = staff;
    updates.lastAssignedIndex = 0;
  }
  if (b.strategy !== undefined) {
    updates.strategy = VALID_STRATEGIES.includes(b.strategy as any) ? b.strategy : "first";
  }
  if (Object.keys(updates).length === 0) { res.status(400).json({ error: "No fields to update" }); return; }
  const [updated] = await db.update(leadAssignmentRulesTable).set(updates).where(eq(leadAssignmentRulesTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Rule not found" }); return; }
  logAudit(req.user!.id, "update_lead_assignment_rule", "lead_assignment_rule", id, updates, req.ip);
  res.json(updated);
});

router.delete("/settings/lead-assignment-rules/:id", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [deleted] = await db.delete(leadAssignmentRulesTable).where(eq(leadAssignmentRulesTable.id, id)).returning();
  if (!deleted) { res.status(404).json({ error: "Rule not found" }); return; }
  logAudit(req.user!.id, "delete_lead_assignment_rule", "lead_assignment_rule", id, {}, req.ip);
  res.json({ success: true });
});

export default router;
