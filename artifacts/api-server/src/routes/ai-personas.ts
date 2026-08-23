import { Router, type IRouter } from "express";
import { z } from "zod";
import {
  db,
  aiPersonasTable,
  aiPersonaRunsTable,
  aiActionQueueTable,
  usersTable,
  portalSubmissionsTable,
  portalAdapterSpecsTable,
} from "@workspace/db";
import { and, eq, desc, sql } from "drizzle-orm";
import { requireAuth, requireRole, logAudit } from "../lib/auth";
import { ADMIN_ROLES } from "../lib/roles";
import { listScopes } from "../lib/scopeRegistry";
import { listTools, TOOL_REGISTRY } from "../lib/toolRegistry";
import { runPersona } from "../lib/personaService";
import { portalDiagnosisSchema } from "../lib/portalAiGuardianContract";
import {
  stagingReportsMatch,
  validateGuardianStagingPatch,
} from "../lib/portalAiGuardianStaging";
import { buildPortalDeployProposalPayload } from "../lib/portalAiGuardianApproval";
import { aiRetryDelaySeconds, classifyAiFailure } from "../lib/aiFailurePolicy";

const router: IRouter = Router();

const personaSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9-]+$/i, "slug must be alphanumeric/hyphens"),
  personaType: z.enum(["advisor", "operator"]),
  description: z.string().optional().nullable(),
  avatarUrl: z.string().optional().nullable(),
  provider: z.enum(["anthropic", "openai"]),
  model: z.string().min(1),
  systemPrompt: z.string().default(""),
  guidelines: z.string().default(""),
  negativePrompt: z.string().default(""),
  temperature: z.coerce.number().min(0).max(2).default(0.7),
  maxTokens: z.coerce.number().int().min(64).max(32000).default(2048),
  allowedDataScopes: z.array(z.string()).default([]),
  toolsEnabled: z.array(z.string()).default([]),
  triggerMode: z.enum(["manual", "scheduled", "event_driven"]).default("manual"),
  scheduleCron: z.string().optional().nullable(),
  eventSubscriptions: z.array(z.string()).optional().nullable(),
  outputTargets: z.array(z.string()).default([]),
  monthlyCostCapUsd: z.coerce.number().nullable().optional(),
  isActive: z.boolean().default(false),
});

function guardToolsForType(
  personaType: "advisor" | "operator",
  tools: string[],
): { ok: boolean; offending?: string } {
  if (personaType !== "advisor") return { ok: true };
  for (const t of tools) {
    const def = TOOL_REGISTRY[t];
    if (def?.sideEffect) return { ok: false, offending: t };
  }
  return { ok: true };
}

// Registry endpoints
router.get(
  "/ai-personas/registry/scopes",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  (_req, res): void => {
    res.json({ scopes: listScopes() });
  },
);

// A retry is always explicit, bounded and recorded as a new run. It re-reads
// current scoped data instead of replaying a persisted prompt that may contain
// stale or sensitive context.
router.post(
  "/ai-personas/runs/:runId/retry",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const runId = Number(req.params.runId);
    if (!Number.isFinite(runId) || runId <= 0) {
      res.status(400).json({ error: "Invalid run id" });
      return;
    }
    const [run] = await db.select().from(aiPersonaRunsTable).where(eq(aiPersonaRunsTable.id, runId));
    if (!run || !["error", "rate_limited"].includes(run.status)) {
      res.status(409).json({ error: "Only failed AI runs can be retried" });
      return;
    }
    const output = reviewRecord(run.outputPayload);
    const previousRetry = reviewRecord(output.retry);
    const attempt = Number(previousRetry.attempt ?? 0) + 1;
    if (attempt > 3) {
      res.status(409).json({ error: "AI retry limit reached", maxAttempts: 3 });
      return;
    }
    const failure = classifyAiFailure(run.errorMessage ?? "");
    if (!failure.retryable) {
      res.status(409).json({
        error: "AI failure is not safely retryable",
        category: failure.category,
      });
      return;
    }
    const retryAfterSeconds = aiRetryDelaySeconds(attempt, failure.retryAfterSeconds ?? 30);
    const earliestRetryAt = new Date(run.createdAt.getTime() + retryAfterSeconds * 1000);
    if (earliestRetryAt.getTime() > Date.now()) {
      res.status(429).json({
        error: "Retry backoff is still active",
        category: failure.category,
        retryAt: earliestRetryAt.toISOString(),
      });
      return;
    }
    const result = await runPersona({
      personaId: run.personaId,
      triggeredBy: "manual",
      triggerActor: req.user!.id,
      retryOfRunId: runId,
      retryAttempt: attempt,
    });
    await logAudit(req.user!.id, "retry_ai_persona_run", "ai_persona_run", runId, {
      newRunId: result.runId,
      attempt,
      failureCategory: failure.category,
      resultStatus: result.status,
    }, req.ip);
    res.status(201).json(result);
  },
);

router.get(
  "/ai-personas/registry/tools",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  (_req, res): void => {
    res.json({ tools: listTools() });
  },
);

// List
router.get(
  "/ai-personas",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (_req, res): Promise<void> => {
    const rows = await db
      .select()
      .from(aiPersonasTable)
      .orderBy(desc(aiPersonasTable.createdAt));
    res.json({ personas: rows });
  },
);

// Get one
router.get(
  "/ai-personas/:id",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [row] = await db.select().from(aiPersonasTable).where(eq(aiPersonasTable.id, id));
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ persona: row });
  },
);

// Create
router.post(
  "/ai-personas",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const parsed = personaSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
      return;
    }
    const data = parsed.data;
    const guard = guardToolsForType(data.personaType, data.toolsEnabled);
    if (!guard.ok) {
      res.status(400).json({
        error: `Advisor persona cannot enable side-effect tool: ${guard.offending}`,
      });
      return;
    }
    try {
      const [inserted] = await db
        .insert(aiPersonasTable)
        .values({
          name: data.name,
          slug: data.slug,
          personaType: data.personaType,
          description: data.description ?? null,
          avatarUrl: data.avatarUrl ?? null,
          provider: data.provider,
          model: data.model,
          systemPrompt: data.systemPrompt,
          guidelines: data.guidelines,
          negativePrompt: data.negativePrompt,
          temperature: String(data.temperature),
          maxTokens: data.maxTokens,
          allowedDataScopes: data.allowedDataScopes,
          toolsEnabled: data.toolsEnabled,
          triggerMode: data.triggerMode,
          scheduleCron: data.scheduleCron ?? null,
          eventSubscriptions: data.eventSubscriptions ?? null,
          outputTargets: data.outputTargets,
          monthlyCostCapUsd:
            data.monthlyCostCapUsd == null ? null : String(data.monthlyCostCapUsd),
          isActive: data.isActive,
          createdBy: req.user!.id,
        })
        .returning();
      logAudit(req.user!.id, "create_ai_persona", "ai_persona", inserted.id, {
        name: inserted.name,
      });
      res.status(201).json({ persona: inserted });
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
  "/ai-personas/:id",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = personaSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
      return;
    }
    const data = parsed.data;
    if (data.personaType && data.toolsEnabled) {
      const guard = guardToolsForType(data.personaType, data.toolsEnabled);
      if (!guard.ok) {
        res.status(400).json({
          error: `Advisor persona cannot enable side-effect tool: ${guard.offending}`,
        });
        return;
      }
    } else if (data.toolsEnabled || data.personaType) {
      const [existing] = await db
        .select()
        .from(aiPersonasTable)
        .where(eq(aiPersonasTable.id, id));
      if (existing) {
        const t = (data.personaType ?? existing.personaType) as "advisor" | "operator";
        const tools = data.toolsEnabled ?? (existing.toolsEnabled as string[]) ?? [];
        const guard = guardToolsForType(t, tools);
        if (!guard.ok) {
          res.status(400).json({
            error: `Advisor persona cannot enable side-effect tool: ${guard.offending}`,
          });
          return;
        }
      }
    }
    const updates: Record<string, unknown> = { ...data };
    if (data.temperature != null) updates.temperature = String(data.temperature);
    if (data.monthlyCostCapUsd !== undefined)
      updates.monthlyCostCapUsd =
        data.monthlyCostCapUsd == null ? null : String(data.monthlyCostCapUsd);
    const [updated] = await db
      .update(aiPersonasTable)
      .set(updates)
      .where(eq(aiPersonasTable.id, id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    logAudit(req.user!.id, "update_ai_persona", "ai_persona", id, data);
    res.json({ persona: updated });
  },
);

// Delete
router.delete(
  "/ai-personas/:id",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [deleted] = await db
      .delete(aiPersonasTable)
      .where(eq(aiPersonasTable.id, id))
      .returning({ id: aiPersonasTable.id });
    if (!deleted) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    logAudit(req.user!.id, "delete_ai_persona", "ai_persona", id);
    res.json({ ok: true });
  },
);

// Manual run
router.post(
  "/ai-personas/:id/run",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const input = typeof req.body?.input === "string" ? req.body.input : undefined;
    try {
      const result = await runPersona({
        personaId: id,
        input,
        triggeredBy: "manual",
        triggerActor: req.user!.id,
      });
      logAudit(req.user!.id, "run_ai_persona", "ai_persona", id, {
        runId: result.runId,
        status: result.status,
      });
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  },
);

// Runs history
router.get(
  "/ai-personas/:id/runs",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const runs = await db
      .select({
        id: aiPersonaRunsTable.id,
        triggeredBy: aiPersonaRunsTable.triggeredBy,
        triggerActor: aiPersonaRunsTable.triggerActor,
        model: aiPersonaRunsTable.model,
        promptTokens: aiPersonaRunsTable.promptTokens,
        completionTokens: aiPersonaRunsTable.completionTokens,
        costUsd: aiPersonaRunsTable.costUsd,
        latencyMs: aiPersonaRunsTable.latencyMs,
        status: aiPersonaRunsTable.status,
        errorMessage: aiPersonaRunsTable.errorMessage,
        outputPayload: aiPersonaRunsTable.outputPayload,
        createdAt: aiPersonaRunsTable.createdAt,
      })
      .from(aiPersonaRunsTable)
      .where(eq(aiPersonaRunsTable.personaId, id))
      .orderBy(desc(aiPersonaRunsTable.createdAt))
      .limit(50);
    const [agg] = await db
      .select({
        totalRuns: sql<number>`count(*)::int`,
        totalPromptTokens: sql<number>`coalesce(sum(${aiPersonaRunsTable.promptTokens}),0)::int`,
        totalCompletionTokens: sql<number>`coalesce(sum(${aiPersonaRunsTable.completionTokens}),0)::int`,
        totalCostUsd: sql<string>`coalesce(sum(${aiPersonaRunsTable.costUsd}),0)::text`,
      })
      .from(aiPersonaRunsTable)
      .where(eq(aiPersonaRunsTable.personaId, id));
    res.json({ runs, summary: agg });
  },
);

// Action queue list
router.get(
  "/ai-personas/queue/actions",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (_req, res): Promise<void> => {
    const legacyGuardianNoise = sql<boolean>`
      ${aiActionQueueTable.actionType} = 'portal_fix_proposal'
      and ${aiActionQueueTable.status} = 'failed'
      and ${aiActionQueueTable.payload}->'specDraft'->>'draftReason' = 'NO_ENABLED_SPEC_BASE'
    `;
    const rows = await db
      .select({
        id: aiActionQueueTable.id,
        personaId: aiActionQueueTable.personaId,
        runId: aiActionQueueTable.runId,
        actionType: aiActionQueueTable.actionType,
        payload: aiActionQueueTable.payload,
        preview: aiActionQueueTable.preview,
        status: aiActionQueueTable.status,
        createdAt: aiActionQueueTable.createdAt,
        reviewedAt: aiActionQueueTable.reviewedAt,
        personaName: aiPersonasTable.name,
        reviewerEmail: usersTable.email,
      })
      .from(aiActionQueueTable)
      .leftJoin(aiPersonasTable, eq(aiActionQueueTable.personaId, aiPersonasTable.id))
      .leftJoin(usersTable, eq(aiActionQueueTable.reviewedBy, usersTable.id))
      .where(sql`not (${legacyGuardianNoise})`)
      .orderBy(desc(aiActionQueueTable.createdAt))
      .limit(100);
    const [suppressed] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(aiActionQueueTable)
      .where(legacyGuardianNoise);
    res.json({
      actions: rows,
      suppressed: { guardianNoEnabledSpec: suppressed?.count ?? 0 },
    });
  },
);

const reviewActionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
});

function reviewRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// Two human gates, both deliberately non-executing:
// 1) approving a staged fix creates a deploy proposal;
// 2) approving that deploy proposal records readiness for a manual deploy.
// Neither gate enables a spec, retries a student, runs a canary, restarts a
// process, writes production code, or performs a portal mutation.
router.post(
  "/ai-personas/queue/actions/:id/review",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    const parsed = reviewActionSchema.safeParse(req.body);
    if (!Number.isFinite(id) || id <= 0 || !parsed.success) {
      res.status(400).json({ error: "Invalid review request" });
      return;
    }
    const [current] = await db
      .select()
      .from(aiActionQueueTable)
      .where(eq(aiActionQueueTable.id, id));
    if (!current || current.status !== "pending_approval") {
      res.status(409).json({
        error: "ACTION_NOT_PENDING",
        message: "This action was already reviewed or does not exist",
      });
      return;
    }
    const payload = reviewRecord(current.payload);
    const context = reviewRecord(payload.context);
    const isPortalAction = [
      "portal_fix_proposal",
      "portal_deploy_proposal",
    ].includes(current.actionType);

    if (
      parsed.data.decision === "approved" &&
      isPortalAction &&
      req.user!.role !== "super_admin"
    ) {
      res.status(403).json({
        error: "SUPER_ADMIN_REQUIRED",
        message: "Portal patch and deploy proposals require super-admin approval",
      });
      return;
    }

    if (
      parsed.data.decision === "approved" &&
      current.actionType === "portal_fix_proposal"
    ) {
      const submissionId = Number(context.submissionId);
      const baseSpecId = Number(context.baseSpecId);
      const draftSpecId = Number(context.draftSpecId);
      const fingerprint = String(context.fingerprint ?? "");
      const diagnosis = portalDiagnosisSchema.safeParse(payload.diagnosis);
      if (
        !Number.isFinite(submissionId) ||
        !Number.isFinite(baseSpecId) ||
        !Number.isFinite(draftSpecId) ||
        !fingerprint ||
        !diagnosis.success
      ) {
        res.status(409).json({
          error: "PORTAL_STAGING_ARTIFACT_INVALID",
          message: "The proposal is missing a complete staged patch artifact",
        });
        return;
      }
      const [[submission], [base], [draft]] = await Promise.all([
        db
          .select({ resultJson: portalSubmissionsTable.resultJson })
          .from(portalSubmissionsTable)
          .where(eq(portalSubmissionsTable.id, submissionId)),
        db
          .select()
          .from(portalAdapterSpecsTable)
          .where(eq(portalAdapterSpecsTable.id, baseSpecId)),
        db
          .select()
          .from(portalAdapterSpecsTable)
          .where(eq(portalAdapterSpecsTable.id, draftSpecId)),
      ]);
      const guardian = reviewRecord(reviewRecord(submission?.resultJson).aiGuardian);
      const regenerated =
        base && draft
          ? validateGuardianStagingPatch({
              baseSpec: base.spec,
              patchedSpec: draft.spec,
              operations: diagnosis.data.proposedSpecPatch,
              testedAt: String(reviewRecord(payload.staging).testedAt || new Date().toISOString()),
            })
          : null;
      if (
        !submission ||
        !base ||
        !draft ||
        !base.enabled ||
        draft.enabled ||
        draft.source !== "uploaded" ||
        base.key !== draft.key ||
        guardian.status !== "proposed" ||
        guardian.fingerprint !== fingerprint ||
        guardian.actionId !== id ||
        !regenerated ||
        regenerated.status !== "passed" ||
        !stagingReportsMatch(payload.staging, regenerated)
      ) {
        res.status(409).json({
          error: "STALE_OR_FAILED_PORTAL_STAGING",
          message:
            "The active base, disabled draft, fingerprint or staging proof changed; run a new diagnosis",
        });
        return;
      }

      const deployPayload = buildPortalDeployProposalPayload({
        sourceActionId: id,
        submissionId,
        universityKey:
          typeof context.universityKey === "string" ? context.universityKey : null,
        adapterKey:
          typeof context.adapterKey === "string" ? context.adapterKey : null,
        fingerprint,
        baseSpecId: base.id,
        baseSpecVersion: base.version,
        draftSpecId: draft.id,
        draftSpecVersion: draft.version,
        diagnosis: diagnosis.data,
        staging: regenerated,
      });
      const transactionResult = await db.transaction(async (tx) => {
        const [reviewed] = await tx
          .update(aiActionQueueTable)
          .set({
            status: "approved",
            reviewedBy: req.user!.id,
            reviewedAt: new Date(),
          })
          .where(
            and(
              eq(aiActionQueueTable.id, id),
              eq(aiActionQueueTable.status, "pending_approval"),
            ),
          )
          .returning();
        if (!reviewed) return null;
        const [deployAction] = await tx
          .insert(aiActionQueueTable)
          .values({
            personaId: current.personaId,
            runId: current.runId,
            actionType: "portal_deploy_proposal",
            payload: deployPayload,
            preview: `Deploy staged ${draft.key} spec v${draft.version} after the required manual checks.`,
            status: "pending_approval",
          })
          .returning();
        await tx
          .update(portalSubmissionsTable)
          .set({
            resultJson: sql`coalesce(${portalSubmissionsTable.resultJson}, '{}'::jsonb) || jsonb_build_object(
              'aiGuardian',
              coalesce(${portalSubmissionsTable.resultJson}->'aiGuardian', '{}'::jsonb)
                || jsonb_build_object(
                  'status', 'deploy_proposed',
                  'deployActionId', ${deployAction.id},
                  'deployProposedAt', ${new Date().toISOString()}
                )
            )`,
          })
          .where(eq(portalSubmissionsTable.id, submissionId));
        return { reviewed, deployAction };
      });
      if (!transactionResult) {
        res.status(409).json({
          error: "ACTION_NOT_PENDING",
          message: "This action was already reviewed or does not exist",
        });
        return;
      }
      await logAudit(
        req.user!.id,
        "approve_ai_action",
        "ai_action_queue",
        id,
        {
          actionType: current.actionType,
          executionMode: "create_non_executing_deploy_proposal",
          deployActionId: transactionResult.deployAction.id,
          productionChanged: false,
        },
        req.ip,
      );
      res.json({
        action: transactionResult.reviewed,
        deployProposal: transactionResult.deployAction,
        executed: false,
        productionChanged: false,
        message:
          "Staged patch approved. A separate non-executing deploy proposal was created; no spec, student, process or portal state changed.",
      });
      return;
    }

    if (
      parsed.data.decision === "approved" &&
      current.actionType === "portal_deploy_proposal"
    ) {
      const submissionId = Number(context.submissionId);
      const baseSpecId = Number(context.baseSpecId);
      const draftSpecId = Number(context.draftSpecId);
      const fingerprint = String(context.fingerprint ?? "");
      const diagnosis = portalDiagnosisSchema.safeParse(payload.diagnosis);
      const [[submission], [base], [draft]] = await Promise.all([
        Number.isFinite(submissionId)
          ? db
              .select({ resultJson: portalSubmissionsTable.resultJson })
              .from(portalSubmissionsTable)
              .where(eq(portalSubmissionsTable.id, submissionId))
          : Promise.resolve([]),
        Number.isFinite(baseSpecId)
          ? db
              .select()
              .from(portalAdapterSpecsTable)
              .where(eq(portalAdapterSpecsTable.id, baseSpecId))
          : Promise.resolve([]),
        Number.isFinite(draftSpecId)
          ? db
              .select()
              .from(portalAdapterSpecsTable)
              .where(eq(portalAdapterSpecsTable.id, draftSpecId))
          : Promise.resolve([]),
      ]);
      const guardian = reviewRecord(reviewRecord(submission?.resultJson).aiGuardian);
      const regenerated =
        diagnosis.success && base && draft
          ? validateGuardianStagingPatch({
              baseSpec: base.spec,
              patchedSpec: draft.spec,
              operations: diagnosis.data.proposedSpecPatch,
              testedAt: String(reviewRecord(payload.staging).testedAt || new Date().toISOString()),
            })
          : null;
      if (
        !submission ||
        !base ||
        !draft ||
        !base.enabled ||
        draft.enabled ||
        draft.source !== "uploaded" ||
        base.key !== draft.key ||
        guardian.status !== "deploy_proposed" ||
        guardian.fingerprint !== fingerprint ||
        guardian.deployActionId !== id ||
        !regenerated ||
        regenerated.status !== "passed" ||
        !stagingReportsMatch(payload.staging, regenerated)
      ) {
        res.status(409).json({
          error: "STALE_PORTAL_DEPLOY_PROPOSAL",
          message:
            "The staged artifact is no longer deploy-ready; create a fresh diagnosis and staging report",
        });
        return;
      }
      const updatedRows = await db.transaction(async (tx) => {
        const reviewed = await tx
          .update(aiActionQueueTable)
          .set({
            status: "approved",
            reviewedBy: req.user!.id,
            reviewedAt: new Date(),
          })
          .where(
            and(
              eq(aiActionQueueTable.id, id),
              eq(aiActionQueueTable.status, "pending_approval"),
            ),
          )
          .returning();
        if (!reviewed[0]) return [];
        await tx
          .update(portalSubmissionsTable)
          .set({
            resultJson: sql`coalesce(${portalSubmissionsTable.resultJson}, '{}'::jsonb) || jsonb_build_object(
              'aiGuardian',
              coalesce(${portalSubmissionsTable.resultJson}->'aiGuardian', '{}'::jsonb)
                || jsonb_build_object(
                  'status', 'deploy_approved',
                  'deployApprovedAt', ${new Date().toISOString()},
                  'productionChanged', false
                )
            )`,
          })
          .where(eq(portalSubmissionsTable.id, submissionId));
        return reviewed;
      });
      const updated = updatedRows[0];
      if (!updated) {
        res.status(409).json({
          error: "ACTION_NOT_PENDING",
          message: "This action was already reviewed or does not exist",
        });
        return;
      }
      await logAudit(
        req.user!.id,
        "approve_ai_action",
        "ai_action_queue",
        id,
        {
          actionType: current.actionType,
          executionMode: "manual_deploy_readiness_recorded",
          productionChanged: false,
        },
        req.ip,
      );
      res.json({
        action: updated,
        executed: false,
        productionChanged: false,
        message:
          "Deploy readiness was recorded. Deployment, canary, spec activation and process restarts remain manual and were not executed.",
      });
      return;
    }

    const updatedRows = await db
      .update(aiActionQueueTable)
      .set({
        status: parsed.data.decision,
        reviewedBy: req.user!.id,
        reviewedAt: new Date(),
      })
      .where(
        and(
          eq(aiActionQueueTable.id, id),
          eq(aiActionQueueTable.status, "pending_approval"),
        ),
      )
      .returning();
    const updated = updatedRows[0];
    if (!updated) {
      res.status(409).json({
        error: "ACTION_NOT_PENDING",
        message: "This action was already reviewed or does not exist",
      });
      return;
    }
    if (isPortalAction) {
      const submissionId = Number(context.submissionId);
      const fingerprint = String(context.fingerprint ?? "");
      if (Number.isFinite(submissionId) && fingerprint) {
        await db
          .update(portalSubmissionsTable)
          .set({
            resultJson: sql`coalesce(${portalSubmissionsTable.resultJson}, '{}'::jsonb) || jsonb_build_object(
              'aiGuardian',
              coalesce(${portalSubmissionsTable.resultJson}->'aiGuardian', '{}'::jsonb)
                || jsonb_build_object(
                  'status', ${current.actionType === "portal_deploy_proposal" ? "deploy_rejected" : "proposal_rejected"},
                  'reviewedAt', ${new Date().toISOString()}
                )
            )`,
          })
          .where(
            and(
              eq(portalSubmissionsTable.id, submissionId),
              sql`coalesce(${portalSubmissionsTable.resultJson}->'aiGuardian'->>'fingerprint', '') = ${fingerprint}`,
            ),
          );
      }
    }
    await logAudit(
      req.user!.id,
      parsed.data.decision === "approved" ? "approve_ai_action" : "reject_ai_action",
      "ai_action_queue",
      id,
      {
        actionType: updated.actionType,
        executionMode: "review_only",
        productionChanged: false,
      },
      req.ip,
    );
    res.json({
      action: updated,
      executed: false,
      productionChanged: false,
      message: "Action reviewed. No code, spec, process, student or portal state was changed.",
    });
  },
);

export default router;
