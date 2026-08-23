import { Router, type IRouter } from "express";
import { db, quickLinksTable } from "@workspace/db";
import { eq, and, asc, sql } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireRole } from "../lib/auth";
import { validate, getValidated } from "../middlewares/validate";
import { MANAGER_ROLES } from "../lib/roles";

const VALID_TARGETS = ["agent", "sub_agent", "staff", "student"] as const;

const targetSchema = z
  .string()
  .transform(v => v.split(",").map(t => t.trim()).filter(Boolean))
  .refine(arr => arr.length > 0 && arr.every(t => (VALID_TARGETS as readonly string[]).includes(t)), {
    message: "target must be one or more of: agent, sub_agent, staff, student",
  })
  .transform(arr => arr.join(","));

// The frontend stores the uploaded logo as a ROOT-RELATIVE path
// (`/api/storage/objects/...`, or `${BASE}/api/...` when the app is mounted
// under a base path) — same as the working branding LogoUploader. A strict
// `z.string().url()` rejects relative paths and produced the HTTP 400
// "Validation failed" on save. Accept either an absolute http(s) URL (legacy
// rows) or a root-relative path.
const logoUrlSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    // Root-relative path (`/...`) but NOT protocol-relative (`//host` would
    // resolve to an external origin), or an absolute http(s) URL.
    v => (v.startsWith("/") && !v.startsWith("//")) || /^https?:\/\//i.test(v),
    { message: "logoUrl must be an absolute http(s) URL or a root-relative path" },
  )
  .optional()
  .nullable();

const createQuickLinkBodySchema = z.object({
  title: z.string().trim().min(1),
  url: z.string().trim().min(1),
  target: targetSchema,
  icon: z.string().trim().optional().nullable(),
  logoUrl: logoUrlSchema,
  color: z.string().trim().optional().nullable(),
  sortOrder: z.number().int().optional().default(0),
});

const patchQuickLinkBodySchema = z.object({
  title: z.string().trim().min(1).optional(),
  url: z.string().trim().min(1).optional(),
  target: targetSchema.optional(),
  icon: z.string().trim().optional().nullable(),
  logoUrl: logoUrlSchema,
  color: z.string().trim().optional().nullable(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

const router: IRouter = Router();

router.get("/quick-links", requireAuth, async (req, res): Promise<void> => {
  const userRole = req.user!.role;
  let target: string;

  if (userRole === "agent" || userRole === "agent_staff") target = "agent";
  else if (userRole === "sub_agent") target = "sub_agent";
  else if (userRole === "student") target = "student";
  else target = "staff";

  const links = await db
    .select()
    .from(quickLinksTable)
    .where(and(
      sql`(${quickLinksTable.target} = ${target} OR ${quickLinksTable.target} LIKE '%' || ${target} || '%')`,
      eq(quickLinksTable.isActive, true),
    ))
    .orderBy(asc(quickLinksTable.sortOrder), asc(quickLinksTable.id));

  res.json({ data: links });
});

router.get("/quick-links/admin", requireAuth, requireRole(...MANAGER_ROLES), async (_req, res): Promise<void> => {
  const links = await db
    .select()
    .from(quickLinksTable)
    .orderBy(asc(quickLinksTable.target), asc(quickLinksTable.sortOrder), asc(quickLinksTable.id));

  res.json({ data: links });
});

router.post("/quick-links", requireAuth, requireRole(...MANAGER_ROLES), validate({ body: createQuickLinkBodySchema }), async (req, res): Promise<void> => {
  const { title, url, icon, logoUrl, color, target, sortOrder } = getValidated<{ body: typeof createQuickLinkBodySchema }>(req).body;
  const [link] = await db.insert(quickLinksTable).values({
    title,
    url,
    icon: icon || null,
    logoUrl: logoUrl || null,
    color: color || null,
    target,
    sortOrder,
  }).returning();
  res.status(201).json(link);
});

router.patch("/quick-links/:id", requireAuth, requireRole(...MANAGER_ROLES), validate({ body: patchQuickLinkBodySchema }), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = getValidated<{ body: typeof patchQuickLinkBodySchema }>(req).body;
  const updates: Record<string, unknown> = {};
  for (const key of ["title", "url", "icon", "logoUrl", "color", "sortOrder", "isActive", "target"] as const) {
    if ((body as Record<string, unknown>)[key] !== undefined) updates[key] = (body as Record<string, unknown>)[key];
  }
  if (Object.keys(updates).length === 0) { res.status(400).json({ error: "No fields to update" }); return; }
  const [updated] = await db.update(quickLinksTable).set(updates).where(eq(quickLinksTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Quick link not found" }); return; }
  res.json(updated);
});

router.delete("/quick-links/:id", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [deleted] = await db.delete(quickLinksTable).where(eq(quickLinksTable.id, id)).returning();
  if (!deleted) { res.status(404).json({ error: "Quick link not found" }); return; }
  res.json({ success: true });
});

export default router;
