import { Router, type IRouter } from "express";
import { db, degreeDocumentRequirementsTable, catalogOptionsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireRole, logAudit } from "../lib/auth";
import { MANAGER_ROLES } from "../lib/roles";

const router: IRouter = Router();

// GET — by catalog option id (admin/staff use)
router.get("/catalog-options/:id/document-requirements", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const rows = await db.select().from(degreeDocumentRequirementsTable)
    .where(eq(degreeDocumentRequirementsTable.catalogOptionId, id))
    .orderBy(degreeDocumentRequirementsTable.sortOrder);
  res.json(rows);
});

// GET — by degree value (used by Add Student form when only the value string is in hand)
router.get("/degrees/by-value/:value/document-requirements", requireAuth, async (req, res): Promise<void> => {
  const raw = String(req.params.value || "").trim();
  if (!raw) { res.status(400).json({ error: "Invalid value" }); return; }
  const [opt] = await db.select({ id: catalogOptionsTable.id }).from(catalogOptionsTable)
    .where(and(eq(catalogOptionsTable.category, "degree"), eq(catalogOptionsTable.value, raw)));
  if (!opt) { res.json([]); return; }
  const rows = await db.select().from(degreeDocumentRequirementsTable)
    .where(eq(degreeDocumentRequirementsTable.catalogOptionId, opt.id))
    .orderBy(degreeDocumentRequirementsTable.sortOrder);
  res.json(rows);
});

// PUT — replace the requirements list for a catalog option (admin only)
router.put("/catalog-options/:id/document-requirements", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [opt] = await db.select({ id: catalogOptionsTable.id, category: catalogOptionsTable.category })
    .from(catalogOptionsTable).where(eq(catalogOptionsTable.id, id));
  if (!opt) { res.status(404).json({ error: "Catalog option not found" }); return; }
  if (opt.category !== "degree") {
    res.status(400).json({ error: "Document requirements are only supported for degree options" });
    return;
  }

  const { requirements } = req.body as { requirements?: { documentType: string; mandatory?: boolean; sortOrder?: number }[] };
  if (!Array.isArray(requirements)) { res.status(400).json({ error: "requirements array is required" }); return; }

  const cleaned: { documentType: string; mandatory: boolean; sortOrder: number }[] = [];
  const seen = new Set<string>();
  requirements.forEach((r, idx) => {
    if (!r || typeof r.documentType !== "string") return;
    const dt = r.documentType.trim();
    if (!dt || seen.has(dt)) return;
    seen.add(dt);
    cleaned.push({
      documentType: dt,
      mandatory: !!r.mandatory,
      sortOrder: typeof r.sortOrder === "number" ? r.sortOrder : idx,
    });
  });

  await db.transaction(async (tx) => {
    await tx.delete(degreeDocumentRequirementsTable).where(eq(degreeDocumentRequirementsTable.catalogOptionId, id));
    if (cleaned.length > 0) {
      await tx.insert(degreeDocumentRequirementsTable).values(cleaned.map(c => ({ ...c, catalogOptionId: id })));
    }
  });

  await logAudit(req.user!.id, "update_degree_document_requirements", "catalog_option", id, { count: cleaned.length }, req.ip);

  const rows = await db.select().from(degreeDocumentRequirementsTable)
    .where(eq(degreeDocumentRequirementsTable.catalogOptionId, id))
    .orderBy(degreeDocumentRequirementsTable.sortOrder);
  res.json(rows);
});

export default router;
