import { Router, type IRouter, type Request, type Response } from "express";
import { db, websiteCollectionsTeamMembersTable, websiteCollectionsOfficesTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { requireAuth, requireRole, logAudit } from "../lib/auth";
import { ADMIN_ROLES } from "../lib/roles";

const router: IRouter = Router();
const adminOnly = [requireAuth, requireRole(...ADMIN_ROLES)] as const;

// ── Team Members ──────────────────────────────────────────────────────────────
// GET is public (no auth) — used by About page.
// POST / PATCH / DELETE require admin and emit audit log entries.

router.get("/cms/team-members", async (req: Request, res: Response): Promise<void> => {
  try {
    const lang = typeof req.query.lang === "string" ? req.query.lang.toLowerCase() : null;
    const rows = await db
      .select()
      .from(websiteCollectionsTeamMembersTable)
      .where(eq(websiteCollectionsTeamMembersTable.isActive, true))
      .orderBy(asc(websiteCollectionsTeamMembersTable.sortOrder), asc(websiteCollectionsTeamMembersTable.id));
    const resolved = rows.map(row => {
      if (!lang || !row.translationsJson) return row;
      const tx = (row.translationsJson as Record<string, Record<string, string>>)[lang] ?? {};
      return {
        ...row,
        name: tx.name ?? row.name,
        title: tx.title !== undefined ? tx.title : row.title,
        bio: tx.bio !== undefined ? tx.bio : row.bio,
      };
    });
    res.json(resolved);
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Internal server error" });
  }
});

router.post("/cms/team-members", ...adminOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, title, bio, photoUrl, email, linkedinUrl, sortOrder, isActive, translationsJson } = req.body as Record<string, unknown>;
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required" }); return;
    }
    const [row] = await db.insert(websiteCollectionsTeamMembersTable).values({
      name: name.trim(),
      title: (title as string) || null,
      bio: (bio as string) || null,
      photoUrl: (photoUrl as string) || null,
      email: (email as string) || null,
      linkedinUrl: (linkedinUrl as string) || null,
      sortOrder: typeof sortOrder === "number" ? sortOrder : 0,
      isActive: isActive !== false,
      ...(translationsJson !== undefined ? { translationsJson: translationsJson as Record<string, unknown> } : {}),
    }).returning();
    logAudit(req.user!.id, "cms.team_member.create", "website_collections_team_members", row.id, { name: row.name });
    res.status(201).json(row);
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Internal server error" });
  }
});

router.patch("/cms/team-members/:id", ...adminOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
    const body = req.body as Record<string, unknown>;
    if (body.name !== undefined && (typeof body.name !== "string" || !String(body.name).trim())) {
      res.status(400).json({ error: "name must be a non-empty string" }); return;
    }
    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = String(body.name).trim();
    if (body.title !== undefined) updates.title = (body.title as string) || null;
    if (body.bio !== undefined) updates.bio = (body.bio as string) || null;
    if (body.photoUrl !== undefined) updates.photoUrl = (body.photoUrl as string) || null;
    if (body.email !== undefined) updates.email = (body.email as string) || null;
    if (body.linkedinUrl !== undefined) updates.linkedinUrl = (body.linkedinUrl as string) || null;
    if (body.sortOrder !== undefined) updates.sortOrder = typeof body.sortOrder === "number" ? body.sortOrder : parseInt(String(body.sortOrder), 10) || 0;
    if (body.isActive !== undefined) updates.isActive = Boolean(body.isActive);
    if (body.translationsJson !== undefined) updates.translationsJson = body.translationsJson;
    const [row] = await db.update(websiteCollectionsTeamMembersTable).set(updates).where(eq(websiteCollectionsTeamMembersTable.id, id)).returning();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    logAudit(req.user!.id, "cms.team_member.update", "website_collections_team_members", id, updates);
    res.json(row);
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Internal server error" });
  }
});

router.delete("/cms/team-members/:id", ...adminOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
    const [row] = await db.delete(websiteCollectionsTeamMembersTable).where(eq(websiteCollectionsTeamMembersTable.id, id)).returning();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    logAudit(req.user!.id, "cms.team_member.delete", "website_collections_team_members", id, { name: row.name });
    res.json({ success: true });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Internal server error" });
  }
});

// ── Offices ───────────────────────────────────────────────────────────────────
// GET is public (no auth) — used by Contact page.

router.get("/cms/offices", async (req: Request, res: Response): Promise<void> => {
  try {
    const lang = typeof req.query.lang === "string" ? req.query.lang.toLowerCase() : null;
    const rows = await db
      .select()
      .from(websiteCollectionsOfficesTable)
      .where(eq(websiteCollectionsOfficesTable.isActive, true))
      .orderBy(asc(websiteCollectionsOfficesTable.sortOrder), asc(websiteCollectionsOfficesTable.id));
    const resolved = rows.map(row => {
      if (!lang || !row.translationsJson) return row;
      const tx = (row.translationsJson as Record<string, Record<string, string>>)[lang] ?? {};
      return {
        ...row,
        name: tx.name !== undefined ? tx.name : row.name,
        city: tx.city !== undefined ? tx.city : row.city,
        country: tx.country !== undefined ? tx.country : row.country,
        address: tx.address !== undefined ? tx.address : row.address,
      };
    });
    res.json(resolved);
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Internal server error" });
  }
});

router.post("/cms/offices", ...adminOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body as Record<string, unknown>;
    if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
      res.status(400).json({ error: "name is required" }); return;
    }
    const [row] = await db.insert(websiteCollectionsOfficesTable).values({
      name: body.name.trim(),
      city: (body.city as string) || null,
      country: (body.country as string) || null,
      address: (body.address as string) || null,
      phone: (body.phone as string) || null,
      email: (body.email as string) || null,
      mapEmbedUrl: (body.mapEmbedUrl as string) || null,
      imageUrl: (body.imageUrl as string) || null,
      sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : 0,
      isActive: body.isActive !== false,
      ...(body.translationsJson !== undefined ? { translationsJson: body.translationsJson as Record<string, unknown> } : {}),
    }).returning();
    logAudit(req.user!.id, "cms.office.create", "website_collections_offices", row.id, { name: row.name });
    res.status(201).json(row);
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Internal server error" });
  }
});

router.patch("/cms/offices/:id", ...adminOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
    const body = req.body as Record<string, unknown>;
    if (body.name !== undefined && (typeof body.name !== "string" || !String(body.name).trim())) {
      res.status(400).json({ error: "name must be a non-empty string" }); return;
    }
    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = String(body.name).trim();
    if (body.city !== undefined) updates.city = (body.city as string) || null;
    if (body.country !== undefined) updates.country = (body.country as string) || null;
    if (body.address !== undefined) updates.address = (body.address as string) || null;
    if (body.phone !== undefined) updates.phone = (body.phone as string) || null;
    if (body.email !== undefined) updates.email = (body.email as string) || null;
    if (body.mapEmbedUrl !== undefined) updates.mapEmbedUrl = (body.mapEmbedUrl as string) || null;
    if (body.imageUrl !== undefined) updates.imageUrl = (body.imageUrl as string) || null;
    if (body.sortOrder !== undefined) updates.sortOrder = typeof body.sortOrder === "number" ? body.sortOrder : parseInt(String(body.sortOrder), 10) || 0;
    if (body.isActive !== undefined) updates.isActive = Boolean(body.isActive);
    if (body.translationsJson !== undefined) updates.translationsJson = body.translationsJson;
    const [row] = await db.update(websiteCollectionsOfficesTable).set(updates).where(eq(websiteCollectionsOfficesTable.id, id)).returning();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    logAudit(req.user!.id, "cms.office.update", "website_collections_offices", id, updates);
    res.json(row);
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Internal server error" });
  }
});

router.delete("/cms/offices/:id", ...adminOnly, async (req: Request, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
    const [row] = await db.delete(websiteCollectionsOfficesTable).where(eq(websiteCollectionsOfficesTable.id, id)).returning();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    logAudit(req.user!.id, "cms.office.delete", "website_collections_offices", id, { name: row.name });
    res.json({ success: true });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Internal server error" });
  }
});

export default router;
