import { Router, type IRouter, json } from "express";
import { z } from "zod";
import { db, aiExtractorsTable, aiExtractorRunsTable } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import { getAnthropicClient, getClaudeConfig } from "@workspace/integrations-anthropic-ai";
import { requireAuth, requireRole, logAudit } from "../lib/auth";
import { ADMIN_ROLES } from "../lib/roles";
import {
  buildExtractionPrompt,
  getExtractorById,
  getExtractorUsageStats,
  recordExtractorRun,
} from "../lib/aiExtractorService";
import { normalizeGpaEvidenceTo100 } from "../lib/gpaNormalize";

const router: IRouter = Router();
const jsonBody = json({ limit: "20mb" });

const FIELD_TYPES = ["string", "number", "date", "boolean", "enum"] as const;
const SCOPES = ["public_apply", "embed", "staff", "agent"] as const;
const PROVIDERS = ["anthropic", "openai", "gemini"] as const;

const fieldSchema = z.object({
  key: z.string().min(1).max(80).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "key must be camelCase"),
  label: z.string().min(1).max(160),
  description: z.string().max(500).optional().default(""),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().optional().default(false),
  enumValues: z.array(z.string()).optional().default([]),
  normalize: z.enum(["gpa100", "dateYmd", "none"]).optional().default("none"),
  format: z.string().max(40).optional().default(""),
  labelByLang: z.record(z.string(), z.string()).optional().default({}),
});

const extractorSchema = z.object({
  name: z.string().min(1).max(160),
  slug: z.string().min(1).max(120).regex(/^[a-z0-9-]+$/i, "slug must be alphanumeric/hyphens"),
  description: z.string().max(2000).optional().nullable(),
  provider: z.enum(PROVIDERS).default("anthropic"),
  model: z.string().min(1).max(120),
  systemPrompt: z.string().default(""),
  systemPromptByLang: z.record(z.string(), z.string()).default({}),
  fields: z.array(fieldSchema).min(1),
  rules: z
    .object({
      globalRules: z.array(z.string()).optional().default([]),
      perDocType: z.record(z.string(), z.array(z.string())).optional().default({}),
    })
    .default({ globalRules: [], perDocType: {} }),
  scopes: z.array(z.enum(SCOPES)).default([]),
  documentTypes: z.array(z.string()).default([]),
  temperature: z.coerce.number().min(0).max(2).default(0.2),
  maxTokens: z.coerce.number().int().min(256).max(32000).default(4096),
  isActive: z.boolean().default(true),
  isDefault: z.boolean().default(false),
});

// List
router.get(
  "/ai-extractors",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (_req, res): Promise<void> => {
    const rows = await db
      .select()
      .from(aiExtractorsTable)
      .orderBy(desc(aiExtractorsTable.isDefault), desc(aiExtractorsTable.updatedAt));
    const usage = await getExtractorUsageStats();
    res.json({
      extractors: rows.map((r) => ({
        ...r,
        usage: usage[r.id] ?? { runs: 0, lastRunAt: null },
      })),
    });
  },
);

// Get one
router.get(
  "/ai-extractors/:id",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const ext = await getExtractorById(id);
    if (!ext) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ extractor: ext });
  },
);

async function clearOtherDefaultsForScopes(scopes: string[], exceptId: number | null): Promise<void> {
  // Enforce one default per scope: clear the default flag on any active
  // extractor whose scope set overlaps the new defaults scope set.
  if (!scopes || scopes.length === 0) return;
  const rows = await db.select().from(aiExtractorsTable).where(eq(aiExtractorsTable.isDefault, true));
  for (const r of rows) {
    if (exceptId != null && r.id === exceptId) continue;
    const overlap = Array.isArray(r.scopes) && (r.scopes as string[]).some((s) => scopes.includes(s));
    if (overlap) {
      await db.update(aiExtractorsTable).set({ isDefault: false }).where(eq(aiExtractorsTable.id, r.id));
    }
  }
}

// Create
router.post(
  "/ai-extractors",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  jsonBody,
  async (req, res): Promise<void> => {
    const parsed = extractorSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
      return;
    }
    const data = parsed.data;
    try {
      if (data.isDefault) await clearOtherDefaultsForScopes(data.scopes, null);
      const [row] = await db
        .insert(aiExtractorsTable)
        .values({
          name: data.name,
          slug: data.slug,
          description: data.description ?? null,
          provider: data.provider,
          model: data.model,
          systemPrompt: data.systemPrompt,
          systemPromptByLang: data.systemPromptByLang,
          fields: data.fields,
          rules: data.rules,
          scopes: data.scopes,
          documentTypes: data.documentTypes,
          temperature: String(data.temperature),
          maxTokens: data.maxTokens,
          isActive: data.isActive,
          isDefault: data.isDefault,
          createdBy: req.user!.id,
        })
        .returning();
      logAudit(req.user!.id, "create_ai_extractor", "ai_extractor", row.id, { name: row.name });
      res.status(201).json({ extractor: row });
    } catch (e) {
      const msg = (e as Error).message;
      if (/unique|duplicate/i.test(msg)) {
        res.status(409).json({ error: "Slug already exists" });
        return;
      }
      res.status(500).json({ error: msg });
    }
  },
);

// Update
router.put(
  "/ai-extractors/:id",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  jsonBody,
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = extractorSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
      return;
    }
    const data = parsed.data;
    if (data.isDefault === true) {
      // Need to know which scopes this extractor occupies (incoming or stored).
      const existing = data.scopes ?? (await getExtractorById(id))?.scopes ?? [];
      await clearOtherDefaultsForScopes(existing as string[], id);
    }
    const updates: Record<string, unknown> = { ...data };
    if (data.temperature != null) updates.temperature = String(data.temperature);
    const [row] = await db
      .update(aiExtractorsTable)
      .set(updates)
      .where(eq(aiExtractorsTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    logAudit(req.user!.id, "update_ai_extractor", "ai_extractor", id, data);
    res.json({ extractor: row });
  },
);

// Delete
router.delete(
  "/ai-extractors/:id",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [row] = await db
      .delete(aiExtractorsTable)
      .where(eq(aiExtractorsTable.id, id))
      .returning({ id: aiExtractorsTable.id });
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    logAudit(req.user!.id, "delete_ai_extractor", "ai_extractor", id);
    res.json({ ok: true });
  },
);

// Test run (does not persist run)
router.post(
  "/ai-extractors/:id/test",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  jsonBody,
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    const ext = await getExtractorById(id);
    if (!ext) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const { documents, lang } = req.body as {
      documents: Array<{ type: "image" | "pdf"; data: string; mediaType: string; label: string }>;
      lang?: string;
    };
    if (!Array.isArray(documents) || documents.length === 0) {
      res.status(400).json({ error: "No documents provided" });
      return;
    }
    if (ext.provider !== "anthropic") {
      res.status(400).json({
        error: `Provider "${ext.provider}" is not yet wired into the runtime. Switch the provider to "anthropic" or contact engineering to enable additional providers.`,
      });
      return;
    }
    let anthropic;
    try {
      anthropic = await getAnthropicClient();
      await getClaudeConfig();
    } catch (e: any) {
      res.status(503).json({ error: e?.message || "AI integration not configured" });
      return;
    }
    const prompt = buildExtractionPrompt(ext, { lang });
    const content: any[] = [{ type: "text", text: prompt }];
    for (const d of documents.slice(0, 4)) {
      content.push({ type: "text", text: `\n--- Document: ${d.label} ---` });
      if (d.type === "image") {
        const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
        const mt = allowed.includes(d.mediaType) ? d.mediaType : "image/jpeg";
        content.push({ type: "image", source: { type: "base64", media_type: mt, data: d.data } });
      } else {
        content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: d.data } });
      }
    }
    const start = Date.now();
    try {
      const msg = await anthropic.messages.create({
        model: ext.model,
        max_tokens: ext.maxTokens,
        messages: [{ role: "user", content }],
      });
      const text = msg.content.find((b: any) => b.type === "text") as any;
      let extracted: any = {};
      try {
        const match = text?.text?.match(/\{[\s\S]*\}/);
        if (match) extracted = JSON.parse(match[0]);
      } catch {}
      // apply normalize rules
      for (const f of ext.fields as any[]) {
        if (f.normalize === "gpa100" && extracted[f.key] != null && extracted[f.key] !== "") {
          const pct = normalizeGpaEvidenceTo100(String(extracted[f.key]));
          if (!isNaN(pct)) {
            extracted[`${f.key}Raw`] = extracted[f.key];
            extracted[f.key] = (Math.round(pct * 10) / 10).toString();
            extracted[`${f.key}Scale`] = 100;
          }
        }
      }
      res.json({
        extracted,
        prompt,
        usage: {
          promptTokens: (msg as any).usage?.input_tokens ?? null,
          completionTokens: (msg as any).usage?.output_tokens ?? null,
          latencyMs: Date.now() - start,
          model: ext.model,
        },
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Extraction failed" });
    }
  },
);

// Recent runs (for detail page)
router.get(
  "/ai-extractors/:id/runs",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const runs = await db
      .select()
      .from(aiExtractorRunsTable)
      .where(eq(aiExtractorRunsTable.extractorId, id))
      .orderBy(desc(aiExtractorRunsTable.createdAt))
      .limit(50);
    const [agg] = await db
      .select({
        totalRuns: sql<number>`count(*)::int`,
        totalPromptTokens: sql<number>`coalesce(sum(${aiExtractorRunsTable.promptTokens}),0)::int`,
        totalCompletionTokens: sql<number>`coalesce(sum(${aiExtractorRunsTable.completionTokens}),0)::int`,
      })
      .from(aiExtractorRunsTable)
      .where(eq(aiExtractorRunsTable.extractorId, id));
    res.json({ runs, summary: agg });
  },
);

export default router;
