import { Router, type IRouter } from "express";
import { z } from "zod";
import {
  aiBotsTable,
  channelAccountsTable,
  communicationPipelineAccountsTable,
  communicationPipelinesTable,
  db,
  knowledgeChunksTable,
  knowledgeSourcesTable,
} from "@workspace/db";
import { and, asc, eq, ne } from "drizzle-orm";
import { requireAuth, requireRole, logAudit } from "../lib/auth";
import { ADMIN_ROLES } from "../lib/roles";
import {
  aiAgentPatchRequiresSuperAdmin,
  aiAgentConfigPatchSchema,
  getAiAgentConfig,
  writeAiAgentConfig,
} from "../lib/inbox/aiAgentConfig";
import { encryptConfig } from "../lib/encryption";

const router: IRouter = Router();

const slugSchema = z.string().trim().min(2).max(80).regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/);
const botCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: slugSchema,
  description: z.string().trim().max(500).nullish(),
  cloneFromBotId: z.number().int().positive().nullish(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
const botUpdateSchema = botCreateSchema.omit({ cloneFromBotId: true }).partial();
const pipelineCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: slugSchema,
  description: z.string().trim().max(500).nullish(),
  aiBotId: z.number().int().positive(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
const pipelineUpdateSchema = pipelineCreateSchema.partial();
const assignmentSchema = z.object({
  accounts: z.array(z.object({
    channelAccountId: z.number().int().positive(),
    canSend: z.boolean().default(false),
    canReceive: z.boolean().default(false),
    priority: z.union([z.literal(1), z.literal(2)]).nullable().optional(),
  })).max(2),
});

function botDto(row: typeof aiBotsTable.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    isDefault: row.isDefault,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

router.get("/ai-bots", requireAuth, requireRole(...ADMIN_ROLES), async (_req, res) => {
  const rows = await db.select().from(aiBotsTable).orderBy(asc(aiBotsTable.name));
  res.json({ bots: rows.map(botDto) });
});

router.post("/ai-bots", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const parsed = botCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid AI bot", details: parsed.error.flatten() });
    return;
  }
  const input = parsed.data;
  const existing = await db.select({ id: aiBotsTable.id }).from(aiBotsTable);
  const makeDefault = input.isDefault === true || existing.length === 0;
  if (makeDefault && input.isActive === false) {
    res.status(400).json({ error: "The default AI bot must remain active" });
    return;
  }
  const [cloneSource] = input.cloneFromBotId
    ? await db.select({ id: aiBotsTable.id }).from(aiBotsTable).where(eq(aiBotsTable.id, input.cloneFromBotId))
    : [];
  if (input.cloneFromBotId && !cloneSource) {
    res.status(400).json({ error: "Source AI bot not found" });
    return;
  }
  const sourceConfig = await getAiAgentConfig(input.cloneFromBotId ?? null);
  const initialConfig = {
    ...sourceConfig,
    externalAutoReplyEnabled: false,
    defaultOnForNew: false,
  };
  const [row] = await db.transaction(async (tx) => {
    if (makeDefault) await tx.update(aiBotsTable).set({ isDefault: false });
    const [created] = await tx.insert(aiBotsTable).values({
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      configEncrypted: JSON.stringify(encryptConfig(initialConfig)),
      isDefault: makeDefault,
      isActive: input.isActive !== false,
      createdById: req.user!.id,
    }).returning();

    if (input.cloneFromBotId) {
      const sourceRows = await tx
        .select()
        .from(knowledgeSourcesTable)
        .where(eq(knowledgeSourcesTable.aiBotId, input.cloneFromBotId));
      for (const source of sourceRows) {
        const [clonedSource] = await tx.insert(knowledgeSourcesTable).values({
          aiBotId: created.id,
          type: source.type,
          name: source.name,
          config: source.config,
          isActive: source.isActive,
          status: source.status,
          lastSyncedAt: source.lastSyncedAt,
        }).returning({ id: knowledgeSourcesTable.id });
        const chunks = await tx
          .select()
          .from(knowledgeChunksTable)
          .where(eq(knowledgeChunksTable.sourceId, source.id));
        if (chunks.length > 0) {
          await tx.insert(knowledgeChunksTable).values(chunks.map((chunk) => ({
            sourceId: clonedSource.id,
            content: chunk.content,
            embedding: chunk.embedding,
            tokenCount: chunk.tokenCount,
            chunkIndex: chunk.chunkIndex,
            metadata: chunk.metadata,
          })));
        }
      }
    }
    return [created];
  });
  await logAudit(req.user!.id, "create_ai_bot", "ai_bot", row.id, { slug: row.slug }, req.ip);
  res.status(201).json({ bot: botDto(row), config: initialConfig });
});

router.patch("/ai-bots/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const parsed = botUpdateSchema.safeParse(req.body);
  if (!Number.isInteger(id) || !parsed.success) {
    res.status(400).json({ error: "Invalid AI bot update" });
    return;
  }
  const [existing] = await db.select().from(aiBotsTable).where(eq(aiBotsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "AI bot not found" });
    return;
  }
  const input = parsed.data;
  if (existing.isDefault && input.isDefault === false) {
    res.status(400).json({ error: "Choose another default bot before removing this default" });
    return;
  }
  const willBeDefault = input.isDefault ?? existing.isDefault;
  const willBeActive = input.isActive ?? existing.isActive;
  if (willBeDefault && !willBeActive) {
    res.status(400).json({ error: "The default AI bot must remain active" });
    return;
  }
  if (!willBeActive) {
    const [activePipeline] = await db
      .select({ id: communicationPipelinesTable.id })
      .from(communicationPipelinesTable)
      .where(and(
        eq(communicationPipelinesTable.aiBotId, id),
        eq(communicationPipelinesTable.isActive, true),
      ));
    if (activePipeline) {
      res.status(409).json({ error: "Disable this AI bot's communication pipelines first" });
      return;
    }
  }
  const row = await db.transaction(async (tx) => {
    if (input.isDefault === true) {
      await tx.update(aiBotsTable).set({ isDefault: false }).where(ne(aiBotsTable.id, id));
    }
    const [updated] = await tx.update(aiBotsTable).set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
      ...(input.description !== undefined ? { description: input.description ?? null } : {}),
      ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      updatedAt: new Date(),
    }).where(eq(aiBotsTable.id, id)).returning();
    return updated;
  });
  await logAudit(req.user!.id, "update_ai_bot", "ai_bot", id, { slug: row.slug }, req.ip);
  res.json({ bot: botDto(row) });
});

router.get("/ai-bots/:id/config", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [bot] = Number.isInteger(id)
    ? await db.select({ id: aiBotsTable.id }).from(aiBotsTable).where(eq(aiBotsTable.id, id))
    : [];
  if (!bot) {
    res.status(404).json({ error: "AI bot not found" });
    return;
  }
  res.json({ config: await getAiAgentConfig(id) });
});

router.put("/ai-bots/:id/config", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const parsed = aiAgentConfigPatchSchema.safeParse(req.body);
  if (!Number.isInteger(id) || !parsed.success) {
    res.status(400).json({ error: "Invalid AI bot config", details: parsed.success ? undefined : parsed.error.flatten() });
    return;
  }
  try {
    const current = await getAiAgentConfig(id);
    if (
      req.user!.role !== "super_admin" &&
      aiAgentPatchRequiresSuperAdmin(current, parsed.data)
    ) {
      res.status(403).json({ error: "Super Admin approval is required to enable AI automation" });
      return;
    }
    const config = await writeAiAgentConfig(parsed.data, id);
    await logAudit(req.user!.id, "update_ai_bot_config", "ai_bot", id, {
      enabled: config.enabled,
      externalAutoReplyEnabled: config.externalAutoReplyEnabled,
      defaultOnForNew: config.defaultOnForNew,
      model: config.model,
    }, req.ip);
    res.json({ config });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid AI bot config", details: error.flatten() });
      return;
    }
    throw error;
  }
});

router.get("/ai-bots/channel-accounts", requireAuth, requireRole(...ADMIN_ROLES), async (_req, res) => {
  const accounts = await db
    .select({
      id: channelAccountsTable.id,
      displayName: channelAccountsTable.displayName,
      provider: channelAccountsTable.provider,
      status: channelAccountsTable.status,
      isActive: channelAccountsTable.isActive,
      isDefault: channelAccountsTable.isDefault,
      lastSeenAt: channelAccountsTable.lastSeenAt,
    })
    .from(channelAccountsTable)
    .where(eq(channelAccountsTable.channel, "whatsapp"))
    .orderBy(asc(channelAccountsTable.displayName));
  res.json({ accounts });
});

router.get("/communication-pipelines", requireAuth, requireRole(...ADMIN_ROLES), async (_req, res) => {
  const rows = await db.select().from(communicationPipelinesTable).orderBy(asc(communicationPipelinesTable.name));
  const assignments = await db
    .select({
      pipelineId: communicationPipelineAccountsTable.pipelineId,
      channelAccountId: communicationPipelineAccountsTable.channelAccountId,
      canSend: communicationPipelineAccountsTable.canSend,
      canReceive: communicationPipelineAccountsTable.canReceive,
      priority: communicationPipelineAccountsTable.priority,
      displayName: channelAccountsTable.displayName,
      channel: channelAccountsTable.channel,
      isActive: channelAccountsTable.isActive,
    })
    .from(communicationPipelineAccountsTable)
    .innerJoin(channelAccountsTable, eq(channelAccountsTable.id, communicationPipelineAccountsTable.channelAccountId))
    .orderBy(asc(communicationPipelineAccountsTable.priority));
  res.json({
    pipelines: rows.map((row) => ({
      ...row,
      accounts: assignments.filter((assignment) => assignment.pipelineId === row.id),
    })),
  });
});

router.post("/communication-pipelines", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const parsed = pipelineCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid communication pipeline", details: parsed.error.flatten() });
    return;
  }
  const input = parsed.data;
  const [bot] = await db
    .select({ id: aiBotsTable.id, isActive: aiBotsTable.isActive })
    .from(aiBotsTable)
    .where(eq(aiBotsTable.id, input.aiBotId));
  if (!bot) {
    res.status(400).json({ error: "AI bot not found" });
    return;
  }
  const existing = await db.select({ id: communicationPipelinesTable.id }).from(communicationPipelinesTable);
  const makeDefault = input.isDefault === true || existing.length === 0;
  const willBeActive = input.isActive !== false;
  if (makeDefault && !willBeActive) {
    res.status(400).json({ error: "The default communication pipeline must remain active" });
    return;
  }
  if (willBeActive && !bot.isActive) {
    res.status(400).json({ error: "An active communication pipeline requires an active AI bot" });
    return;
  }
  const [row] = await db.transaction(async (tx) => {
    if (makeDefault) await tx.update(communicationPipelinesTable).set({ isDefault: false });
    return tx.insert(communicationPipelinesTable).values({
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      aiBotId: input.aiBotId,
      isDefault: makeDefault,
      isActive: input.isActive !== false,
      createdById: req.user!.id,
    }).returning();
  });
  await logAudit(req.user!.id, "create_communication_pipeline", "communication_pipeline", row.id, { slug: row.slug }, req.ip);
  res.status(201).json({ pipeline: row });
});

router.patch("/communication-pipelines/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const parsed = pipelineUpdateSchema.safeParse(req.body);
  if (!Number.isInteger(id) || !parsed.success) {
    res.status(400).json({ error: "Invalid communication pipeline update" });
    return;
  }
  const [existing] = await db.select().from(communicationPipelinesTable).where(eq(communicationPipelinesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Communication pipeline not found" });
    return;
  }
  if (existing.isDefault && parsed.data.isDefault === false) {
    res.status(400).json({ error: "Choose another default pipeline before removing this default" });
    return;
  }
  const willBeDefault = parsed.data.isDefault ?? existing.isDefault;
  const willBeActive = parsed.data.isActive ?? existing.isActive;
  if (willBeDefault && !willBeActive) {
    res.status(400).json({ error: "The default communication pipeline must remain active" });
    return;
  }
  const targetBotId = parsed.data.aiBotId ?? existing.aiBotId;
  const [bot] = await db
    .select({ id: aiBotsTable.id, isActive: aiBotsTable.isActive })
    .from(aiBotsTable)
    .where(eq(aiBotsTable.id, targetBotId));
  if (!bot) {
    res.status(400).json({ error: "AI bot not found" });
    return;
  }
  if (willBeActive && !bot.isActive) {
    res.status(400).json({ error: "An active communication pipeline requires an active AI bot" });
    return;
  }
  const row = await db.transaction(async (tx) => {
    if (parsed.data.isDefault === true) {
      await tx.update(communicationPipelinesTable).set({ isDefault: false }).where(ne(communicationPipelinesTable.id, id));
    }
    const [updated] = await tx.update(communicationPipelinesTable).set({
      ...parsed.data,
      description: parsed.data.description === undefined ? existing.description : parsed.data.description ?? null,
      updatedAt: new Date(),
    }).where(eq(communicationPipelinesTable.id, id)).returning();
    return updated;
  });
  await logAudit(req.user!.id, "update_communication_pipeline", "communication_pipeline", id, { slug: row.slug }, req.ip);
  res.json({ pipeline: row });
});

router.put("/communication-pipelines/:id/accounts", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const parsed = assignmentSchema.safeParse(req.body);
  if (!Number.isInteger(id) || !parsed.success) {
    res.status(400).json({ error: "Invalid pipeline account assignments", details: parsed.success ? undefined : parsed.error.flatten() });
    return;
  }
  const [pipeline] = await db.select({ id: communicationPipelinesTable.id }).from(communicationPipelinesTable).where(eq(communicationPipelinesTable.id, id));
  if (!pipeline) {
    res.status(404).json({ error: "Communication pipeline not found" });
    return;
  }
  const accounts = parsed.data.accounts;
  if (new Set(accounts.map((account) => account.channelAccountId)).size !== accounts.length) {
    res.status(400).json({ error: "A WhatsApp line can be assigned only once per pipeline" });
    return;
  }
  if (accounts.some((account) => !account.canSend && !account.canReceive)) {
    res.status(400).json({ error: "Every assigned line must send, receive, or both" });
    return;
  }
  if (accounts.some((a) => a.canSend && a.priority == null)) {
    res.status(400).json({ error: "Every sending account needs priority 1 or 2" });
    return;
  }
  if (new Set(accounts.filter((a) => a.canSend).map((a) => a.priority)).size !== accounts.filter((a) => a.canSend).length) {
    res.status(400).json({ error: "Primary and secondary priorities must be unique" });
    return;
  }
  if (accounts.some((account) => account.canSend && account.priority === 2)
    && !accounts.some((account) => account.canSend && account.priority === 1)) {
    res.status(400).json({ error: "A secondary sender requires a primary sender" });
    return;
  }
  const selectedRows = await Promise.all(accounts.map(async (assignment) => {
    const [account] = await db.select().from(channelAccountsTable).where(eq(channelAccountsTable.id, assignment.channelAccountId));
    return account;
  }));
  if (selectedRows.some((account) => !account || account.channel !== "whatsapp" || !account.isActive)) {
    res.status(400).json({ error: "Only active WhatsApp accounts can be assigned" });
    return;
  }
  for (const assignment of accounts.filter((a) => a.canReceive)) {
    const [owned] = await db.select().from(communicationPipelineAccountsTable).where(and(
      eq(communicationPipelineAccountsTable.channelAccountId, assignment.channelAccountId),
      eq(communicationPipelineAccountsTable.canReceive, true),
      ne(communicationPipelineAccountsTable.pipelineId, id),
    ));
    if (owned) {
      res.status(409).json({ error: "A receiving WhatsApp line can belong to only one pipeline" });
      return;
    }
  }
  await db.transaction(async (tx) => {
    await tx.delete(communicationPipelineAccountsTable).where(eq(communicationPipelineAccountsTable.pipelineId, id));
    if (accounts.length > 0) {
      await tx.insert(communicationPipelineAccountsTable).values(accounts.map((assignment) => ({
        pipelineId: id,
        channelAccountId: assignment.channelAccountId,
        canSend: assignment.canSend,
        canReceive: assignment.canReceive,
        priority: assignment.canSend ? assignment.priority ?? 1 : null,
      })));
    }
  });
  await logAudit(req.user!.id, "assign_pipeline_accounts", "communication_pipeline", id, { accounts }, req.ip);
  res.json({ ok: true });
});

export default router;
