import express, { Router, type IRouter } from "express";
import { contractBrandProfilesTable, db } from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import { requireAuth, requirePermission } from "../lib/auth";
import { writeAudit } from "../lib/auditLog";
import {
  hasContractCompanySignature,
  publicContractBranding,
  sanitizeContractBranding,
  validateContractBrandingInput,
} from "../lib/contractBranding";

const router: IRouter = Router();
router.use("/contract-brands", express.json({ limit: "3mb" }));

function normalizeKey(value: unknown): string | null {
  const key = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{1,63}$/.test(key) ? key : null;
}

function presentBrandProfile<T extends { config: unknown }>(row: T) {
  return {
    ...row,
    config: publicContractBranding(row.config),
    hasCompanySignature: hasContractCompanySignature(row.config),
  };
}

router.get("/contract-brands", requireAuth, requirePermission("contract_templates.view"), async (_req, res): Promise<void> => {
  try {
    const rows = await db.select().from(contractBrandProfilesTable).orderBy(asc(contractBrandProfilesTable.name));
    res.json({ data: rows.map(presentBrandProfile) });
  } catch (err) {
    console.error("[contract-brands] list:", err);
    res.status(500).json({ error: "Failed to list contract brands" });
  }
});

router.post("/contract-brands", requireAuth, requirePermission("contract_templates.manage"), async (req, res): Promise<void> => {
  try {
    const key = normalizeKey(req.body?.key);
    const name = String(req.body?.name || "").trim().slice(0, 120);
    if (!key || !name) { res.status(400).json({ error: "A valid key and name are required" }); return; }
    const brandingError = validateContractBrandingInput(req.body?.config);
    if (brandingError) { res.status(400).json({ error: brandingError }); return; }
    const userId = (req as any).user?.id ?? null;
    const [row] = await db.insert(contractBrandProfilesTable).values({
      key,
      name,
      config: sanitizeContractBranding(req.body?.config),
      isActive: req.body?.isActive !== false,
      createdByUserId: userId,
      updatedByUserId: userId,
    }).returning();
    await writeAudit({ userId, action: "contract_brand.create", resource: "contract_brand", resourceId: row.id, changes: { key, name }, ipAddress: req.ip });
    res.status(201).json({ data: presentBrandProfile(row) });
  } catch (err: any) {
    if (err?.code === "23505") { res.status(409).json({ error: "Brand key already exists" }); return; }
    console.error("[contract-brands] create:", err);
    res.status(500).json({ error: "Failed to create contract brand" });
  }
});

router.patch("/contract-brands/:id", requireAuth, requirePermission("contract_templates.manage"), async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid id" }); return; }
    const [existing] = await db.select().from(contractBrandProfilesTable).where(eq(contractBrandProfilesTable.id, id));
    if (!existing) { res.status(404).json({ error: "Not found" }); return; }
    const updates: Record<string, unknown> = { updatedByUserId: (req as any).user?.id ?? null };
    const auditChanges: Record<string, unknown> = {};
    if ("key" in (req.body || {})) {
      const key = normalizeKey(req.body.key);
      if (!key) { res.status(400).json({ error: "Invalid brand key" }); return; }
      updates.key = key;
      auditChanges.key = key;
    }
    if ("name" in (req.body || {})) {
      const name = String(req.body.name || "").trim().slice(0, 120);
      if (!name) { res.status(400).json({ error: "Name is required" }); return; }
      updates.name = name;
      auditChanges.name = name;
    }
    if ("config" in (req.body || {})) {
      const brandingError = validateContractBrandingInput(req.body.config);
      if (brandingError) { res.status(400).json({ error: brandingError }); return; }
      const incoming = req.body.config && typeof req.body.config === "object" && !Array.isArray(req.body.config)
        ? { ...req.body.config }
        : {};
      const existingConfig = sanitizeContractBranding(existing.config) || {};
      if (!Object.prototype.hasOwnProperty.call(incoming, "companySignatureDataUrl") && existingConfig.companySignatureDataUrl) {
        incoming.companySignatureDataUrl = existingConfig.companySignatureDataUrl;
      }
      updates.config = sanitizeContractBranding(incoming);
      auditChanges.configUpdated = true;
      auditChanges.companySignatureConfigured = hasContractCompanySignature(updates.config);
    }
    if ("isActive" in (req.body || {})) {
      updates.isActive = req.body.isActive !== false;
      auditChanges.isActive = updates.isActive;
    }
    const [row] = await db.update(contractBrandProfilesTable).set(updates).where(eq(contractBrandProfilesTable.id, id)).returning();
    await writeAudit({ userId: (req as any).user?.id ?? null, action: "contract_brand.update", resource: "contract_brand", resourceId: id, changes: auditChanges, ipAddress: req.ip });
    res.json({ data: presentBrandProfile(row) });
  } catch (err: any) {
    if (err?.code === "23505") { res.status(409).json({ error: "Brand key already exists" }); return; }
    console.error("[contract-brands] update:", err);
    res.status(500).json({ error: "Failed to update contract brand" });
  }
});

router.delete("/contract-brands/:id", requireAuth, requirePermission("contract_templates.manage"), async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid id" }); return; }
    const [row] = await db.update(contractBrandProfilesTable).set({ isActive: false, updatedByUserId: (req as any).user?.id ?? null }).where(eq(contractBrandProfilesTable.id, id)).returning();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    await writeAudit({ userId: (req as any).user?.id ?? null, action: "contract_brand.deactivate", resource: "contract_brand", resourceId: id, ipAddress: req.ip });
    res.json({ success: true });
  } catch (err) {
    console.error("[contract-brands] deactivate:", err);
    res.status(500).json({ error: "Failed to deactivate contract brand" });
  }
});

export default router;
