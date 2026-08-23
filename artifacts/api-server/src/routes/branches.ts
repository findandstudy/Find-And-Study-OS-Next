import { Router, type IRouter } from "express";
import { db, branchesTable, agentBranchesTable, agentsTable, usersTable } from "@workspace/db";
import { eq, isNull, and, sql, inArray, getTableColumns } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireRole, logAudit } from "../lib/auth";
import { validate, getValidated } from "../middlewares/validate";
import { STAFF_ROLES } from "../lib/roles";
import { getVisibleBranchIds } from "../lib/branchScope";

// Optional URL/email fields arrive from the UI as "" when the user clears them.
// Coerce blank strings to null BEFORE .email()/.url() so clearing a field never
// trips validation (Job D: "Branch save 400 on empty contactEmail/logoUrl").
const emptyToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

// Logos are uploaded to object storage and stored as a RELATIVE path
// (/api/storage/objects/branding/...), not an absolute URL — so a strict
// z.url() rejects every branch that carries a logo. Mirror the agents route's
// isValidStorageUrl rule: accept a relative storage path or an absolute https
// URL (empty/cleared already coerced to null by emptyToNull above).
const isStorageUrl = (v: string): boolean =>
  v.startsWith("/api/storage/objects/") || v.startsWith("https://");

const logoUrlSchema = z.preprocess(
  emptyToNull,
  z
    .string()
    .trim()
    .refine(isStorageUrl, { message: "Geçersiz logo adresi." })
    .nullable()
    .optional(),
);

const createBranchBodySchema = z.object({
  name: z.string().trim().min(1, "Şube adı zorunludur."),
  country: z.string().trim().optional().nullable(),
  city: z.string().trim().optional().nullable(),
  contactName: z.string().trim().optional().nullable(),
  contactEmail: z.preprocess(emptyToNull, z.string().trim().email().nullable().optional()),
  contactPhone: z.string().trim().optional().nullable(),
  contactUserId: z.number().int().optional().nullable(),
  logoUrl: logoUrlSchema,
  notes: z.string().trim().optional().nullable(),
});

const patchBranchBodySchema = z.object({
  name: z.string().trim().min(1, "Şube adı boş olamaz.").optional(),
  country: z.string().trim().optional().nullable(),
  city: z.string().trim().optional().nullable(),
  contactName: z.string().trim().optional().nullable(),
  contactEmail: z.preprocess(emptyToNull, z.string().trim().email().nullable().optional()),
  contactPhone: z.string().trim().optional().nullable(),
  contactUserId: z.number().int().optional().nullable(),
  logoUrl: logoUrlSchema,
  notes: z.string().trim().optional().nullable(),
});

const router: IRouter = Router();

// List branches. Staff can read; super_admin sees all incl. archived (?archived=1).
router.get("/branches", requireAuth, requireRole(...STAFF_ROLES), async (req, res): Promise<void> => {
  const includeArchived = req.query.archived === "1" || req.query.archived === "true";
  const conditions = [];
  if (!includeArchived) conditions.push(isNull(branchesTable.archivedAt));

  // Non-super_admin staff only see their visible branches.
  const visible = await getVisibleBranchIds(req.user!.id, req.user!.role, req.user!);
  if (visible !== null) {
    if (visible.length === 0) {
      res.json({ data: [] });
      return;
    }
    conditions.push(inArray(branchesTable.id, visible));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await db
    .select({
      ...getTableColumns(branchesTable),
      contactUserFirstName: usersTable.firstName,
      contactUserLastName: usersTable.lastName,
      contactUserEmail: usersTable.email,
    })
    .from(branchesTable)
    .leftJoin(usersTable, eq(branchesTable.contactUserId, usersTable.id))
    .where(where)
    .orderBy(branchesTable.name);
  res.json({ data: rows });
});

router.post("/branches", requireAuth, requireRole("super_admin"), validate({ body: createBranchBodySchema }), async (req, res): Promise<void> => {
  const { name, country, city, contactName, contactEmail, contactPhone, contactUserId, logoUrl, notes } =
    getValidated<{ body: typeof createBranchBodySchema }>(req).body;
  try {
    const [branch] = await db.insert(branchesTable).values({
      name,
      country: country || null,
      city: city || null,
      contactName: contactName || null,
      contactEmail: contactEmail || null,
      contactPhone: contactPhone || null,
      contactUserId: contactUserId ?? null,
      logoUrl: logoUrl || null,
      notes: notes || null,
    }).returning();
    await logAudit(req.user!.id, "platform_config.branch.create", "branch", branch.id, {
      name: branch.name,
    }, req.ip);
    res.status(201).json(branch);
  } catch (err: any) {
    if (err?.code === "23505") {
      res.status(409).json({ error: "Bu isimde bir şube zaten var." });
      return;
    }
    res.status(500).json({ error: err?.message || "Failed to create branch" });
  }
});

router.patch("/branches/:id", requireAuth, requireRole("super_admin"), validate({ body: patchBranchBodySchema }), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const rawBody = getValidated<{ body: typeof patchBranchBodySchema }>(req).body;
  const updates: Record<string, unknown> = {};
  for (const k of ["name", "country", "city", "contactName", "contactEmail", "contactPhone", "contactUserId", "logoUrl", "notes"] as const) {
    if ((rawBody as Record<string, unknown>)[k] !== undefined) {
      updates[k] = (rawBody as Record<string, unknown>)[k] ?? null;
    }
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }
  try {
    const [branch] = await db.update(branchesTable).set(updates).where(eq(branchesTable.id, id)).returning();
    if (!branch) { res.status(404).json({ error: "Branch not found" }); return; }
    await logAudit(req.user!.id, "platform_config.branch.update", "branch", id, updates, req.ip);
    res.json(branch);
  } catch (err: any) {
    if (err?.code === "23505") {
      res.status(409).json({ error: "Bu isimde bir şube zaten var." });
      return;
    }
    res.status(500).json({ error: err?.message || "Failed" });
  }
});

router.post("/branches/:id/archive", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [branch] = await db.update(branchesTable).set({ archivedAt: new Date() }).where(eq(branchesTable.id, id)).returning();
  if (!branch) { res.status(404).json({ error: "Branch not found" }); return; }
  await logAudit(req.user!.id, "platform_config.branch.archive", "branch", id, {}, req.ip);
  res.json(branch);
});

router.post("/branches/:id/unarchive", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [branch] = await db.update(branchesTable).set({ archivedAt: null }).where(eq(branchesTable.id, id)).returning();
  if (!branch) { res.status(404).json({ error: "Branch not found" }); return; }
  await logAudit(req.user!.id, "platform_config.branch.unarchive", "branch", id, {}, req.ip);
  res.json(branch);
});

// Stats: how many agents/users are linked to each branch (super_admin only).
router.get("/branches/stats", requireAuth, requireRole("super_admin"), async (_req, res): Promise<void> => {
  const rows = await db.execute<{ branch_id: number; agents: string; }>(sql`
    SELECT b.id AS branch_id,
           (SELECT COUNT(*)::text FROM agent_branches ab WHERE ab.branch_id = b.id) AS agents
    FROM branches b
  `);
  const result: Record<number, { agents: number }> = {};
  for (const r of rows.rows as any[]) {
    result[Number(r.branch_id)] = { agents: parseInt(r.agents, 10) || 0 };
  }
  res.json(result);
});

export default router;
