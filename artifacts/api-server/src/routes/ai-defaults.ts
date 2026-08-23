import { Router, type IRouter } from "express";
import { z } from "zod";
import { db, aiDefaultConfigsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, requireRole, logAudit } from "../lib/auth";
import { ADMIN_ROLES } from "../lib/roles";
import {
  HARDCODED_DEFAULTS,
  ALL_DEFAULT_KEYS,
  type AiDefaultKey,
} from "../lib/aiDefaultConfigs";

const router: IRouter = Router();

router.get(
  "/ai-defaults",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (_req, res): Promise<void> => {
    const rows = await db.select().from(aiDefaultConfigsTable);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const defaults = ALL_DEFAULT_KEYS.map((key) => {
      const dbRow = byKey.get(key);
      return {
        key,
        value: dbRow?.value ?? HARDCODED_DEFAULTS[key],
        hardcoded: HARDCODED_DEFAULTS[key],
        isCustom: Boolean(dbRow),
        updatedAt: dbRow?.updatedAt ?? null,
      };
    });
    res.json({ defaults });
  },
);

router.get(
  "/ai-defaults/:key",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const key = req.params.key as AiDefaultKey;
    if (!HARDCODED_DEFAULTS[key]) {
      res.status(404).json({ error: "Unknown key" });
      return;
    }
    const [dbRow] = await db
      .select()
      .from(aiDefaultConfigsTable)
      .where(eq(aiDefaultConfigsTable.key, key));
    res.json({
      key,
      value: dbRow?.value ?? HARDCODED_DEFAULTS[key],
      hardcoded: HARDCODED_DEFAULTS[key],
      isCustom: Boolean(dbRow),
      updatedAt: dbRow?.updatedAt ?? null,
    });
  },
);

const putSchema = z.object({ value: z.record(z.string(), z.unknown()) });

router.put(
  "/ai-defaults/:key",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const key = req.params.key as AiDefaultKey;
    if (!HARDCODED_DEFAULTS[key]) {
      res.status(404).json({ error: "Unknown key" });
      return;
    }
    const parsed = putSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
      return;
    }
    const value = parsed.data.value;
    const [row] = await db
      .insert(aiDefaultConfigsTable)
      .values({ key, value, updatedBy: req.user!.id })
      .onConflictDoUpdate({
        target: aiDefaultConfigsTable.key,
        set: { value, updatedBy: req.user!.id, updatedAt: new Date() },
      })
      .returning();
    logAudit(req.user!.id, "update_ai_default", "ai_default_config", undefined, { key });
    res.json({
      key: row.key,
      value: row.value,
      hardcoded: HARDCODED_DEFAULTS[key],
      isCustom: true,
      updatedAt: row.updatedAt,
    });
  },
);

router.delete(
  "/ai-defaults/:key",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const key = req.params.key as AiDefaultKey;
    if (!HARDCODED_DEFAULTS[key]) {
      res.status(404).json({ error: "Unknown key" });
      return;
    }
    await db.delete(aiDefaultConfigsTable).where(eq(aiDefaultConfigsTable.key, key));
    logAudit(req.user!.id, "reset_ai_default", "ai_default_config", undefined, { key });
    res.json({ ok: true, key, hardcoded: HARDCODED_DEFAULTS[key] });
  },
);

export default router;
