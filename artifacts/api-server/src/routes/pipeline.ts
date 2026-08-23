import { Router, type IRouter } from "express";
import { db, pipelineStagesTable, programDocumentRequirementsTable } from "@workspace/db";
import type { StageAction } from "@workspace/db";
import { eq, asc, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth";
import { STAFF_ROLES, AGENT_ROLES } from "../lib/roles";
import { clearStageFinanceCache } from "../lib/stageFinance";

const router: IRouter = Router();

// Legacy migration archaeology only. This function is intentionally not
// invoked by API boot. Its DDL and data repairs must be reconciled into the
// reviewed Drizzle migration ledger or a bounded manual operation first.
async function legacyPipelineBootMigration(): Promise<void> {
  try {
    await db.execute(sql`
      DELETE FROM pipeline_stages
      WHERE id NOT IN (
        SELECT MIN(id) FROM pipeline_stages GROUP BY entity_type, key
      )
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS pipeline_stages_entity_key_uniq
      ON pipeline_stages(entity_type, key)
    `);
  } catch (e) {
    console.error("[pipeline] startup dedup/index migration failed:", e);
  }

  // Task #167 — admin-defined per-stage action buttons. Idempotent.
  // Kept in its own try-block so a failure here is visible (previously
  // bundled with dedup migration and swallowed silently, leaving the
  // column missing and admin-saved actions silently dropped).
  try {
    await db.execute(sql`
      ALTER TABLE pipeline_stages
      ADD COLUMN IF NOT EXISTS actions jsonb NOT NULL DEFAULT '[]'::jsonb
    `);
  } catch (e) {
    console.error("[pipeline] failed to ensure actions column (Task #167):", e);
  }

  // Task #187 — pipeline + missing-doc-notes schema extensions. Idempotent.
  try {
    await db.execute(sql`
      ALTER TABLE pipeline_stages
      ADD COLUMN IF NOT EXISTS missing_docs_fulfilled_target_stage_id integer
        REFERENCES pipeline_stages(id) ON DELETE SET NULL
    `);
    await db.execute(sql`
      ALTER TABLE application_stage_documents
      ADD COLUMN IF NOT EXISTS note text
    `);
    await db.execute(sql`
      ALTER TABLE application_stage_documents
      ADD COLUMN IF NOT EXISTS is_custom boolean NOT NULL DEFAULT false
    `);
    await db.execute(sql`
      ALTER TABLE application_stage_documents
      ADD COLUMN IF NOT EXISTS fulfilled_at timestamptz
    `);
    // Task #187 round-3 — custom requests "uploaded, awaiting review" state.
    await db.execute(sql`
      ALTER TABLE application_stage_documents
      ADD COLUMN IF NOT EXISTS responded_at timestamptz
    `);
    await db.execute(sql`
      ALTER TABLE application_stage_documents
      ADD COLUMN IF NOT EXISTS responded_document_id integer
    `);
    // Task #187 round-5 — snapshot of the missing-doc action's
    // targetStageKey on each request row, used to gate auto-advance.
    await db.execute(sql`
      ALTER TABLE application_stage_documents
      ADD COLUMN IF NOT EXISTS action_target_stage_key text
    `);
    // Pre-existing missing-doc rows used `fileName` as free-text — treat
    // them as custom (one-shot, gated by pipeline_migrations marker so we
    // don't reclassify newly-created catalog rows on every restart).
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS pipeline_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const marker = await db.execute(sql`
      SELECT 1 FROM pipeline_migrations WHERE name = 'task_187_backfill_is_custom'
    `);
    if ((marker as any).rows?.length === 0) {
      await db.execute(sql`
        UPDATE application_stage_documents
        SET is_custom = true
        WHERE is_missing_doc_note = true AND is_custom = false
      `);
      await db.execute(sql`
        INSERT INTO pipeline_migrations (name) VALUES ('task_187_backfill_is_custom')
        ON CONFLICT (name) DO NOTHING
      `);
    }
  } catch (e) {
    console.error("[pipeline] failed to ensure Task #187 columns:", e);
  }

  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS pipeline_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const claim = await db.execute<{ name: string }>(sql`
      INSERT INTO pipeline_migrations (name) VALUES ('task_134_backfill_v3')
      ON CONFLICT (name) DO NOTHING
      RETURNING name
    `);
    // node-postgres returns { rows: [...] }; some drivers return the array
    // directly. Handle both shapes without an `any` escape hatch.
    const claimed = Array.isArray(claim)
      ? claim.length > 0
      : (claim.rows?.length ?? 0) > 0;
    if (claimed) {
      await db.execute(sql`
        UPDATE pipeline_stages SET upload_permission_level = 'everyone'
        WHERE entity_type = 'application'
          AND upload_permission_level = 'none'
          AND key IN ('app_fee_paid','missing_docs','upload_payment','deposit_paid','visa_approved','student_card','visa_reject')
      `);
      // Offer stages were historically gated by ADMIN_ROLES only — preserve
      // that exact behavior using the dedicated 'admin_only' level.
      await db.execute(sql`
        UPDATE pipeline_stages SET upload_permission_level = 'admin_only', tracks_offer_expiry = true
        WHERE entity_type = 'application'
          AND key IN ('offer_received','acceptance_letter','final_acceptance')
      `);
      // Repair any rows that an earlier (v2) backfill broadened from
      // admin_only to staff_only on the legacy default offer keys.
      await db.execute(sql`
        UPDATE pipeline_stages SET upload_permission_level = 'admin_only'
        WHERE entity_type = 'application'
          AND upload_permission_level = 'staff_only'
          AND key IN ('offer_received','acceptance_letter','final_acceptance')
      `);
      await db.execute(sql`
        UPDATE pipeline_stages SET requires_valid_until = true
        WHERE entity_type = 'application' AND key = 'offer_received'
      `);
      await db.execute(sql`
        UPDATE pipeline_stages SET is_file_upload_mandatory = true, can_attach_file = true
        WHERE entity_type = 'application'
          AND key IN ('app_fee_paid','offer_received','acceptance_letter','final_acceptance','upload_payment','deposit_paid','visa_approved','student_card')
      `);
      await db.execute(sql`
        UPDATE pipeline_stages SET commission_finance_status = 'confirmed', service_fee_finance_status = 'confirmed', auto_cancel_siblings_on_won = true
        WHERE entity_type = 'application' AND key = 'enrolled'
      `);
      await db.execute(sql`
        UPDATE pipeline_stages SET commission_finance_status = 'excluded', service_fee_finance_status = 'confirmed'
        WHERE entity_type = 'application' AND key IN ('100scholar','visa_reject')
      `);
      await db.execute(sql`
        UPDATE pipeline_stages SET commission_finance_status = 'excluded', service_fee_finance_status = 'excluded'
        WHERE entity_type = 'application' AND key IN ('rejected','all_registered','cancelled','refound')
      `);
      // Catch-up: any custom application stage whose variant is 'won' should
      // also auto-cancel siblings by default (matches old hardcoded behavior
      // for any won-variant stage, not just the built-in 'enrolled' key).
      await db.execute(sql`
        UPDATE pipeline_stages SET auto_cancel_siblings_on_won = true
        WHERE entity_type = 'application'
          AND variant = 'won'
          AND auto_cancel_siblings_on_won = false
      `);
      clearStageFinanceCache();
      console.log("[PIPELINE] Task #134 backfill v3 applied (one-shot).");
    }
  } catch (err) {
    console.error("[PIPELINE] Backfill failed:", err);
  }
}

const MANAGER_ROLES = ["super_admin", "admin", "manager"] as const;

const ENTITY_TYPES = ["lead", "application", "student"];

type DefaultStage = {
  key: string; label: string; sortOrder: number; variant?: string;
  uploadPermissionLevel?: string;
  tracksOfferExpiry?: boolean;
  requiresValidUntil?: boolean;
  isFileUploadMandatory?: boolean;
  canAttachFile?: boolean;
  commissionFinanceStatus?: string | null;
  serviceFeeFinanceStatus?: string | null;
  autoCancelSiblingsOnWon?: boolean;
};

const DEFAULT_STAGES: Record<string, DefaultStage[]> = {
  lead: [
    { key: "new", label: "New", sortOrder: 0 },
    { key: "contacted", label: "Contacted", sortOrder: 1 },
    { key: "interested", label: "Interested", sortOrder: 2 },
    { key: "qualified", label: "Qualified", sortOrder: 3 },
    { key: "converted", label: "Converted", sortOrder: 4, variant: "won" },
    { key: "lost", label: "LOST", sortOrder: 5, variant: "lost" },
  ],
  application: [
    { key: "inquiry", label: "Inquiry", sortOrder: 0 },
    { key: "documents_collected", label: "Documents", sortOrder: 1 },
    { key: "submitted", label: "Submitted", sortOrder: 2 },
    {
      key: "offer_received", label: "Offer", sortOrder: 3,
      uploadPermissionLevel: "admin_only", tracksOfferExpiry: true,
      requiresValidUntil: true, isFileUploadMandatory: true, canAttachFile: true,
    },
    { key: "visa_applied", label: "Visa Applied", sortOrder: 4 },
    {
      key: "visa_approved", label: "Visa OK", sortOrder: 5,
      uploadPermissionLevel: "everyone", isFileUploadMandatory: true, canAttachFile: true,
    },
    {
      key: "enrolled", label: "Enrolled", sortOrder: 6, variant: "won",
      commissionFinanceStatus: "confirmed", serviceFeeFinanceStatus: "confirmed",
      autoCancelSiblingsOnWon: true,
    },
    {
      key: "rejected", label: "Rejected", sortOrder: 7, variant: "lost",
      commissionFinanceStatus: "excluded", serviceFeeFinanceStatus: "excluded",
    },
  ],
  student: [
    { key: "active", label: "Active", sortOrder: 0 },
    { key: "inactive", label: "Inactive", sortOrder: 1 },
    { key: "graduated", label: "Graduated", sortOrder: 2, variant: "won" },
    { key: "suspended", label: "Suspended", sortOrder: 3, variant: "lost" },
  ],
};

const ALLOWED_PERMISSION_LEVELS = new Set(["none", "admin_only", "staff_only", "staff_and_agent", "everyone"]);
const ALLOWED_FINANCE_STATUS = new Set(["potential", "confirmed", "excluded"]);
const ALLOWED_ACTION_TYPES = new Set(["upload", "download", "missing_docs"]);
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

class ActionValidationError extends Error {}

function normActions(v: unknown, validStageKeys: Set<string>, ownStageKey: string, stageLabel: string): StageAction[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    throw new ActionValidationError(`Stage "${stageLabel}": actions must be an array`);
  }
  const out: StageAction[] = [];
  for (let i = 0; i < v.length; i++) {
    const raw = v[i];
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    const rawType = String(a.type || "none");
    // "none" / empty slots are treated as no-op and skipped (Task #167).
    if (rawType === "none" || rawType === "") continue;
    if (out.length >= 2) {
      throw new ActionValidationError(`Stage "${stageLabel}": at most 2 action buttons allowed`);
    }
    if (!ALLOWED_ACTION_TYPES.has(rawType)) {
      throw new ActionValidationError(`Stage "${stageLabel}" action ${i + 1}: invalid type "${rawType}"`);
    }
    // targetStageKey is optional: empty/null = "Don't change" (no stage transition).
    let targetStageKey: string | null = null;
    if (a.targetStageKey !== undefined && a.targetStageKey !== null && a.targetStageKey !== "") {
      const t = String(a.targetStageKey).toLowerCase().replace(/[^a-z0-9_]/g, "_");
      if (!validStageKeys.has(t)) {
        throw new ActionValidationError(`Stage "${stageLabel}" action ${i + 1}: target stage "${t}" does not exist`);
      }
      if (t === ownStageKey) {
        throw new ActionValidationError(`Stage "${stageLabel}" action ${i + 1}: target stage cannot be the same stage`);
      }
      targetStageKey = t;
    }
    let label: string | null = null;
    if (a.label !== undefined && a.label !== null) {
      if (typeof a.label !== "string") {
        throw new ActionValidationError(`Stage "${stageLabel}" action ${i + 1}: label must be a string`);
      }
      const trimmed = a.label.trim();
      if (trimmed.length > 32) {
        throw new ActionValidationError(`Stage "${stageLabel}" action ${i + 1}: label too long (max 32)`);
      }
      label = trimmed || null;
    }
    // Document Name — independent of button label. Used for stored filename
    // (upload) and selecting matching document (download). Max 64 chars.
    let documentName: string | null = null;
    if (a.documentName !== undefined && a.documentName !== null) {
      if (typeof a.documentName !== "string") {
        throw new ActionValidationError(`Stage "${stageLabel}" action ${i + 1}: documentName must be a string`);
      }
      const trimmed = a.documentName.trim();
      if (trimmed.length > 64) {
        throw new ActionValidationError(`Stage "${stageLabel}" action ${i + 1}: documentName too long (max 64)`);
      }
      documentName = trimmed || null;
    }
    let color: string | null = null;
    if (a.color !== undefined && a.color !== null && a.color !== "") {
      if (typeof a.color !== "string" || !HEX_COLOR.test(a.color)) {
        throw new ActionValidationError(`Stage "${stageLabel}" action ${i + 1}: color must be a #RRGGBB hex value`);
      }
      color = a.color;
    }
    let requiredDocTypes: string[] = [];
    if (a.requiredDocTypes !== undefined && a.requiredDocTypes !== null) {
      if (!Array.isArray(a.requiredDocTypes)) {
        throw new ActionValidationError(`Stage "${stageLabel}" action ${i + 1}: requiredDocTypes must be an array`);
      }
      requiredDocTypes = (a.requiredDocTypes as unknown[])
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((s) => s.trim())
        .slice(0, 20);
    }
    out.push({ type: rawType as StageAction["type"], label, documentName, color, targetStageKey, requiredDocTypes });
  }
  return out;
}

// Task #167 — surface the catalog of document types admins can pick from when
// configuring "Missing Documents" / "Upload" actions. Combines the built-in
// catalog (used in StudentDocChecklist) with any custom types referenced in
// program_document_requirements so the picker matches real-world data.
const BUILTIN_DOC_TYPES = [
  "high_school_diploma_translation","class_10th_ssc_marks_sheet","class_12th_hsc_certificate",
  "class_12th_hsc_marks_sheet","diploma_certificate","diploma_transcript",
  "bachelors_certificate","bachelors_transcript","bachelors_provisional_certificate",
  "bachelors_transcript_all_semesters","masters_certificate","masters_transcript",
  "masters_provisional_certificate","masters_transcript_all_semesters",
  "passport","cv","lor","sop","essay","experience_letters",
  "other_certificates_documents","ielts_pte_gre_gmat_toefl_duolingo","photo","diploma_recognition",
];

router.get("/document-types", requireAuth, requireRole(...STAFF_ROLES, ...AGENT_ROLES), async (_req, res): Promise<void> => {
  let extra: string[] = [];
  try {
    const rows = await db
      .selectDistinct({ documentType: programDocumentRequirementsTable.documentType })
      .from(programDocumentRequirementsTable);
    extra = rows.map(r => r.documentType).filter((s): s is string => !!s);
  } catch {}
  const set = new Set<string>([...BUILTIN_DOC_TYPES, ...extra]);
  res.json([...set].sort());
});

router.get("/pipeline-stages/:entityType", requireAuth, requireRole(...STAFF_ROLES, ...AGENT_ROLES), async (req, res): Promise<void> => {
  const entityType = String(req.params.entityType);
  if (!ENTITY_TYPES.includes(entityType)) {
    res.status(400).json({ error: "Invalid entity type" });
    return;
  }

  let stages = await db
    .select()
    .from(pipelineStagesTable)
    .where(eq(pipelineStagesTable.entityType, entityType))
    .orderBy(asc(pipelineStagesTable.sortOrder));

  if (stages.length === 0) {
    const defaults = DEFAULT_STAGES[entityType];
    if (defaults) {
      await db.insert(pipelineStagesTable)
        .values(defaults.map(d => ({ ...d, entityType })))
        .onConflictDoNothing();
      stages = await db
        .select()
        .from(pipelineStagesTable)
        .where(eq(pipelineStagesTable.entityType, entityType))
        .orderBy(asc(pipelineStagesTable.sortOrder));
    }
  }

  res.json(stages);
});

router.put("/pipeline-stages/:entityType", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const entityType = String(req.params.entityType);
  if (!ENTITY_TYPES.includes(entityType)) {
    res.status(400).json({ error: "Invalid entity type" });
    return;
  }

  const { stages } = req.body;
  if (!Array.isArray(stages) || stages.length === 0) {
    res.status(400).json({ error: "stages array is required" });
    return;
  }

  for (const s of stages) {
    if (!s.key || !s.label) {
      res.status(400).json({ error: "Each stage needs key and label" });
      return;
    }
  }

  const normalizedKeys = stages.map((s: any) => String(s.key).toLowerCase().replace(/[^a-z0-9_]/g, "_"));
  const uniqueKeys = new Set(normalizedKeys);
  if (uniqueKeys.size !== normalizedKeys.length) {
    res.status(400).json({ error: "Duplicate keys not allowed" });
    return;
  }

  function normPermission(v: any): string {
    const s = typeof v === "string" ? v : "none";
    return ALLOWED_PERMISSION_LEVELS.has(s) ? s : "none";
  }
  function normFinance(v: any): string | null {
    if (v === null || v === undefined || v === "" || v === "auto") return null;
    const s = String(v);
    return ALLOWED_FINANCE_STATUS.has(s) ? s : null;
  }

  // Task #187 — `missingDocsFulfilledTargetStageKey` is sent by the UI
  // (keys survive the delete-and-reinsert cycle, ids do not). Map each
  // key to the new stage id after insert. Explicitly reject self-
  // reference and unknown keys with 400 — silent skip would let admins
  // save a pipeline whose target stage is silently dropped.
  // Task #187 — preserve existing target stage when UI omits the key.
  // The dialog only writes `missingDocsFulfilledTargetStageKey` into the
  // payload when the admin explicitly touches that Select. Otherwise the
  // field is undefined, which used to cause silent data loss because the
  // delete-and-reinsert below wiped previously configured target stages.
  // Build an id->key map of CURRENT stages so we can fall back to the id
  // when the key is absent from the payload.
  const existingIdToKey = new Map<number, string>();
  if (entityType === "application") {
    const existing = await db
      .select({ id: pipelineStagesTable.id, key: pipelineStagesTable.key })
      .from(pipelineStagesTable)
      .where(eq(pipelineStagesTable.entityType, "application"));
    for (const r of existing) existingIdToKey.set(r.id, r.key);
  }

  const targetKeyByStageIdx: (string | null)[] = [];
  const targetErrors: string[] = [];
  for (let i = 0; i < stages.length; i++) {
    if (entityType !== "application") { targetKeyByStageIdx.push(null); continue; }
    const s: any = stages[i];
    let raw = s.missingDocsFulfilledTargetStageKey;
    // Key omitted but the payload still carries the id from a prior load?
    // Resolve to the existing row's key so saves preserve the setting.
    if ((raw === undefined) && typeof s.missingDocsFulfilledTargetStageId === "number") {
      const fallback = existingIdToKey.get(s.missingDocsFulfilledTargetStageId);
      if (fallback) raw = fallback;
    }
    if (raw === null || raw === undefined || raw === "") { targetKeyByStageIdx.push(null); continue; }
    if (typeof raw !== "string" || !raw.trim()) {
      targetErrors.push(`"${normalizedKeys[i]}": eksik belge hedef aşaması geçersiz.`);
      targetKeyByStageIdx.push(null);
      continue;
    }
    const k = raw.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    if (k === normalizedKeys[i]) {
      targetErrors.push(`"${normalizedKeys[i]}": eksik belge hedef aşaması kendisi olamaz.`);
      targetKeyByStageIdx.push(null);
      continue;
    }
    if (!normalizedKeys.includes(k)) {
      targetErrors.push(`"${normalizedKeys[i]}": bilinmeyen hedef aşama "${raw}".`);
      targetKeyByStageIdx.push(null);
      continue;
    }
    targetKeyByStageIdx.push(k);
  }
  if (targetErrors.length > 0) {
    res.status(400).json({ error: targetErrors.join(" ") });
    return;
  }

  try {
    const inserted = await db.transaction(async (tx) => {
      await tx.delete(pipelineStagesTable).where(eq(pipelineStagesTable.entityType, entityType));

      const rows = await tx.insert(pipelineStagesTable)
        .values(stages.map((s: any, i: number) => ({
          entityType,
          key: normalizedKeys[i],
          label: String(s.label).slice(0, 50),
          sortOrder: i,
          variant: s.variant || null,
          icon: s.icon || null,
          color: s.color || null,
          isNotesMandatory: !!s.isNotesMandatory,
          canAttachFile: !!s.canAttachFile,
          maxFiles: s.canAttachFile ? Math.max(1, parseInt(s.maxFiles) || 1) : 1,
          isFileUploadMandatory: s.canAttachFile ? !!s.isFileUploadMandatory : false,
          canGoBack: s.canGoBack !== false,
          isCaseClose: !!s.isCaseClose,
          countries: s.countries || null,
          mappedStudentStageKey: entityType === "application" && s.mappedStudentStageKey ? String(s.mappedStudentStageKey) : null,
          uploadPermissionLevel: entityType === "application" ? normPermission(s.uploadPermissionLevel) : "none",
          tracksOfferExpiry: entityType === "application" && !!s.tracksOfferExpiry,
          requiresValidUntil: entityType === "application" && !!s.requiresValidUntil,
          commissionFinanceStatus: entityType === "application" ? normFinance(s.commissionFinanceStatus) : null,
          serviceFeeFinanceStatus: entityType === "application" ? normFinance(s.serviceFeeFinanceStatus) : null,
          autoCancelSiblingsOnWon: entityType === "application" && !!s.autoCancelSiblingsOnWon,
          actions: entityType === "application"
            ? normActions(
                s.actions,
                new Set(normalizedKeys),
                String(s.key || "").toLowerCase().replace(/[^a-z0-9_]/g, "_"),
                String(s.label || s.key || ""),
              )
            : [],
        })))
        .returning();

      // Task #187 — second pass to set FK ids now that all new rows exist.
      if (entityType === "application") {
        const idByKey = new Map(rows.map(r => [r.key, r.id]));
        for (let i = 0; i < rows.length; i++) {
          const targetKey = targetKeyByStageIdx[i];
          const targetId = targetKey ? idByKey.get(targetKey) : null;
          if (!targetId || targetId === rows[i].id) continue;
          await tx.update(pipelineStagesTable)
            .set({ missingDocsFulfilledTargetStageId: targetId })
            .where(eq(pipelineStagesTable.id, rows[i].id));
          rows[i].missingDocsFulfilledTargetStageId = targetId;
        }
      }

      return rows;
    });

    clearStageFinanceCache();

    // Non-blocking warnings — surfaced to admin UI as toasts but do not
    // prevent the save (admins can intentionally run pipelines without
    // these features).
    const warnings: string[] = [];
    if (entityType === "application") {
      const hasOfferTracking = inserted.some(s => s.tracksOfferExpiry);
      if (!hasOfferTracking) {
        warnings.push("No stage tracks offer expiry. Offer-letter deadlines and expiry reminders will not run until at least one stage has 'Track offer expiry' enabled.");
      }
      const hasConfirmedCommission = inserted.some(s => s.commissionFinanceStatus === "confirmed" || (s.commissionFinanceStatus === null && s.variant === "won"));
      if (!hasConfirmedCommission) {
        warnings.push("No stage marks commission as confirmed. Commission finance entries will never move to confirmed without a stage configured for it.");
      }
    }

    res.json({
      stages: inserted.sort((a, b) => a.sortOrder - b.sortOrder),
      warnings,
    });
  } catch (err: any) {
    if (err instanceof ActionValidationError) {
      res.status(400).json({ error: err.message, code: "INVALID_ACTION" });
      return;
    }
    console.error("Failed to save pipeline stages:", err);
    res.status(500).json({ error: "Failed to save pipeline stages" });
  }
});

export default router;
