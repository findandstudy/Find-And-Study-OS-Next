import express, { Router, type IRouter } from "express";
import { db, contractTemplatesTable } from "@workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { requireAuth, requirePermission } from "../lib/auth";
import { writeAudit } from "../lib/auditLog";
import { hasContractCompanySignature, sanitizeContractBranding, validateContractBrandingInput } from "../lib/contractBranding";
import { resolveContractTemplateBranding } from "../lib/contractTemplateBranding";

const router: IRouter = Router();
router.use("/contract-templates", express.json({ limit: "3mb" }));

router.get("/contract-templates", requireAuth, requirePermission("contract_templates.view"), async (req, res): Promise<void> => {
  try {
    const filters: any[] = [isNull(contractTemplatesTable.deletedAt)];
    const language = (req.query.language as string) || null;
    const entityType = (req.query.entityType as string) || null;
    const isActiveQ = req.query.isActive;
    const publicationStatus = String(req.query.publicationStatus || "");
    if (language) filters.push(eq(contractTemplatesTable.language, language));
    if (entityType === "company" || entityType === "individual") filters.push(eq(contractTemplatesTable.entityType, entityType));
    if (isActiveQ === "true") filters.push(eq(contractTemplatesTable.isActive, true));
    if (isActiveQ === "false") filters.push(eq(contractTemplatesTable.isActive, false));
    if (["draft", "review_pending", "published", "archived"].includes(publicationStatus)) filters.push(eq(contractTemplatesTable.publicationStatus, publicationStatus));
    const rows = await db.select().from(contractTemplatesTable)
      .where(and(...filters))
      .orderBy(desc(contractTemplatesTable.updatedAt));
    res.json({ data: rows });
  } catch (err) {
    console.error("[contract-templates] list:", err);
    res.status(500).json({ error: "Failed to list contract templates" });
  }
});

// Render a template against an arbitrary intake payload — used by admins to
// preview the final HTML before sending or saving template edits.
router.post("/contract-templates/:id/preview", requireAuth, requirePermission("contract_templates.view"), async (req, res): Promise<void> => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
    const [row] = await db.select().from(contractTemplatesTable)
      .where(and(eq(contractTemplatesTable.id, id), isNull(contractTemplatesTable.deletedAt)));
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    const { renderTemplate, buildAgentContext } = await import("../lib/contractRenderer");
    let agent: any = null;
    const agentIdRaw = req.body?.agentId;
    if (agentIdRaw) {
      const aid = parseInt(String(agentIdRaw), 10);
      if (aid) {
        const { agentsTable } = await import("@workspace/db");
        const rows = await db.select().from(agentsTable).where(eq(agentsTable.id, aid));
        agent = rows[0] || null;
      }
    }
    const ctx = buildAgentContext(agent, req.body?.intakeData || null, {
      signerEmail: req.body?.signerEmail || (agent?.email ?? ""),
      signerName: req.body?.signerName || (agent ? `${agent.firstName || ""} ${agent.lastName || ""}`.trim() : ""),
    });
    const html = renderTemplate(row.bodyHtml, ctx);
    res.json({ data: { html, templateName: row.name, language: row.language, entityType: row.entityType, version: row.version } });
  } catch (err) {
    console.error("[contract-templates] preview:", err);
    res.status(500).json({ error: "Failed to render preview" });
  }
});

router.get("/contract-templates/:id", requireAuth, requirePermission("contract_templates.view"), async (req, res): Promise<void> => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
    const [row] = await db.select().from(contractTemplatesTable)
      .where(and(eq(contractTemplatesTable.id, id), isNull(contractTemplatesTable.deletedAt)));
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json({ data: row });
  } catch (err) {
    console.error("[contract-templates] get:", err);
    res.status(500).json({ error: "Failed to fetch contract template" });
  }
});

router.post("/contract-templates", requireAuth, requirePermission("contract_templates.manage"), async (req, res): Promise<void> => {
  try {
    const { name, title, language, entityType, version, bodyHtml, intakeSchema, isActive, signingPageConfig, brandProfileId } = req.body || {};
    if (!name || typeof name !== "string") { res.status(400).json({ error: "name is required" }); return; }
    if (!bodyHtml || typeof bodyHtml !== "string") { res.status(400).json({ error: "bodyHtml is required" }); return; }
    const brandingError = validateContractBrandingInput(signingPageConfig);
    if (brandingError) { res.status(400).json({ error: brandingError }); return; }
    const norm = {
      name: String(name).slice(0, 200),
      title: title && typeof title === "string" ? String(title).slice(0, 500) : "",
      language: language && typeof language === "string" ? language.slice(0, 8) : "en",
      entityType: entityType === "individual" ? "individual" : "company",
      version: Number.isInteger(version) && version > 0 ? version : 1,
      bodyHtml: String(bodyHtml),
      intakeSchema: Array.isArray(intakeSchema) ? intakeSchema : null,
      isActive: isActive !== false,
      signingPageConfig: sanitizeContractBranding(signingPageConfig),
      brandProfileId: Number.isInteger(brandProfileId) && brandProfileId > 0 ? brandProfileId : null,
      publicationStatus: "draft",
    };
    const [row] = await db.insert(contractTemplatesTable).values(norm).returning();
    await writeAudit({
      userId: (req as any).user?.id ?? null,
      action: "contract_template.create",
      resource: "contract_template",
      resourceId: row.id,
      changes: { name: row.name, language: row.language, entityType: row.entityType, version: row.version },
      ipAddress: req.ip,
    });
    res.status(201).json({ data: row });
  } catch (err) {
    console.error("[contract-templates] create:", err);
    res.status(500).json({ error: "Failed to create contract template" });
  }
});

router.patch("/contract-templates/:id", requireAuth, requirePermission("contract_templates.manage"), async (req, res): Promise<void> => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
    const updates: any = {};
    const allowed = ["name", "title", "language", "entityType", "version", "bodyHtml", "intakeSchema", "isActive", "signingPageConfig", "brandProfileId"];
    for (const k of allowed) {
      if (k in (req.body || {})) updates[k] = req.body[k];
    }
    if (updates.entityType && updates.entityType !== "individual") updates.entityType = "company";
    if (updates.intakeSchema != null && !Array.isArray(updates.intakeSchema)) updates.intakeSchema = null;
    if ("signingPageConfig" in updates) {
      const brandingError = validateContractBrandingInput(updates.signingPageConfig);
      if (brandingError) { res.status(400).json({ error: brandingError }); return; }
      updates.signingPageConfig = sanitizeContractBranding(updates.signingPageConfig);
    }
    if (Object.keys(updates).length === 0) { res.status(400).json({ error: "No fields to update" }); return; }
    const [existing] = await db.select().from(contractTemplatesTable)
      .where(and(eq(contractTemplatesTable.id, id), isNull(contractTemplatesTable.deletedAt)));
    if (!existing) { res.status(404).json({ error: "Not found" }); return; }
    const immutableFields = ["title", "language", "entityType", "bodyHtml", "intakeSchema", "signingPageConfig", "brandProfileId"];
    if (existing.publicationStatus === "published" && immutableFields.some(key => key in updates)) {
      res.status(409).json({ error: "Published templates are immutable. Create a new version before changing content, fields, or branding." });
      return;
    }
    const [row] = await db.update(contractTemplatesTable).set(updates)
      .where(and(eq(contractTemplatesTable.id, id), isNull(contractTemplatesTable.deletedAt)))
      .returning();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    const auditChanges = { ...updates };
    if ("signingPageConfig" in auditChanges) {
      auditChanges.signingPageConfig = {
        configUpdated: true,
        companySignatureConfigured: hasContractCompanySignature(updates.signingPageConfig),
      };
    }
    await writeAudit({
      userId: (req as any).user?.id ?? null,
      action: "contract_template.update",
      resource: "contract_template",
      resourceId: row.id,
      changes: auditChanges,
      ipAddress: req.ip,
    });
    res.json({ data: row });
  } catch (err) {
    console.error("[contract-templates] update:", err);
    res.status(500).json({ error: "Failed to update contract template" });
  }
});

router.post("/contract-templates/:id/submit-review", requireAuth, requirePermission("contract_templates.manage"), async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    const [row] = await db.update(contractTemplatesTable).set({ publicationStatus: "review_pending" })
      .where(and(eq(contractTemplatesTable.id, id), eq(contractTemplatesTable.publicationStatus, "draft"), isNull(contractTemplatesTable.deletedAt))).returning();
    if (!row) { res.status(409).json({ error: "Only a draft template can be submitted for review" }); return; }
    await writeAudit({ userId: (req as any).user?.id ?? null, action: "contract_template.submit_review", resource: "contract_template", resourceId: id, ipAddress: req.ip });
    res.json({ data: row });
  } catch (err) {
    console.error("[contract-templates] submit review:", err);
    res.status(500).json({ error: "Failed to submit template for review" });
  }
});

router.post("/contract-templates/:id/publish", requireAuth, requirePermission("contract_templates.manage"), async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    const userId = (req as any).user?.id ?? null;
    const [existing] = await db.select().from(contractTemplatesTable).where(and(eq(contractTemplatesTable.id, id), isNull(contractTemplatesTable.deletedAt)));
    if (!existing || !["draft", "review_pending"].includes(existing.publicationStatus)) { res.status(409).json({ error: "Only draft or review-pending templates can be published" }); return; }
    if (!existing.bodyHtml.trim() || !Array.isArray(existing.intakeSchema)) { res.status(400).json({ error: "Contract body and form fields must be valid before publishing" }); return; }
    const branding = await resolveContractTemplateBranding(existing);
    if (!hasContractCompanySignature(branding)) {
      res.status(409).json({ error: "Add an official company signature to the selected brand profile before publishing this template" });
      return;
    }
    const now = new Date();
    const [row] = await db.update(contractTemplatesTable).set({
      publicationStatus: "published",
      isActive: true,
      reviewedAt: now,
      reviewedByUserId: userId,
      publishedAt: now,
      publishedByUserId: userId,
    }).where(eq(contractTemplatesTable.id, id)).returning();
    await writeAudit({ userId, action: "contract_template.publish", resource: "contract_template", resourceId: id, changes: { version: row.version }, ipAddress: req.ip });
    res.json({ data: row });
  } catch (err) {
    console.error("[contract-templates] publish:", err);
    res.status(500).json({ error: "Failed to publish template" });
  }
});

router.post("/contract-templates/:id/new-version", requireAuth, requirePermission("contract_templates.manage"), async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    const [source] = await db.select().from(contractTemplatesTable).where(and(eq(contractTemplatesTable.id, id), isNull(contractTemplatesTable.deletedAt)));
    if (!source) { res.status(404).json({ error: "Not found" }); return; }
    const [row] = await db.insert(contractTemplatesTable).values({
      name: source.name,
      title: source.title,
      language: source.language,
      entityType: source.entityType,
      version: source.version + 1,
      bodyHtml: source.bodyHtml,
      intakeSchema: source.intakeSchema,
      signingPageConfig: source.signingPageConfig,
      brandProfileId: source.brandProfileId,
      publicationStatus: "draft",
      supersedesTemplateId: source.id,
      isActive: true,
    }).returning();
    await writeAudit({ userId: (req as any).user?.id ?? null, action: "contract_template.new_version", resource: "contract_template", resourceId: row.id, changes: { sourceId: id, version: row.version }, ipAddress: req.ip });
    res.status(201).json({ data: row });
  } catch (err) {
    console.error("[contract-templates] new version:", err);
    res.status(500).json({ error: "Failed to create a new template version" });
  }
});

router.delete("/contract-templates/:id", requireAuth, requirePermission("contract_templates.manage"), async (req, res): Promise<void> => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
    await db.update(contractTemplatesTable)
      .set({ deletedAt: new Date(), isActive: false })
      .where(eq(contractTemplatesTable.id, id));
    await writeAudit({
      userId: (req as any).user?.id ?? null,
      action: "contract_template.delete",
      resource: "contract_template",
      resourceId: id,
      ipAddress: req.ip,
    });
    res.json({ success: true });
  } catch (err) {
    console.error("[contract-templates] delete:", err);
    res.status(500).json({ error: "Failed to delete contract template" });
  }
});

export default router;
