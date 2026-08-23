import { Router, type IRouter } from "express";
import { db, contractTemplatesTable, signingSessionsTable, signedContractsTable, agentsTable, usersTable, agentBranchesTable } from "@workspace/db";
import { and, desc, eq, getTableColumns, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { requireAuth, requirePermission } from "../lib/auth";
import { writeAudit } from "../lib/auditLog";
import { createSigningToken } from "../lib/signingTokens";
import { dispatchNotification } from "../lib/notificationDispatcher";
import { buildContractSignRequestEmail, sendEmail, getAppBaseUrl } from "../lib/email";
import { signedContractFilename } from "../lib/contractRenderer";
import { getVisibleBranchIds, isAgentInScope } from "../lib/branchScope";
import { hasContractCompanySignature } from "../lib/contractBranding";
import { resolveContractTemplateBranding } from "../lib/contractTemplateBranding";

const router: IRouter = Router();

const DEFAULT_EXPIRY_DAYS = 14;
const CONTRACT_SUBJECT_TYPES = new Set(["agent", "student", "lead", "application", "university", "company", "other"]);

function parseExpiryDays(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 90 ? parsed : DEFAULT_EXPIRY_DAYS;
}

function parseSubject(input: Record<string, unknown>) {
  const rawType = typeof input.subjectType === "string" ? input.subjectType.trim().toLowerCase() : "";
  if (!rawType) return { subjectType: null, subjectId: null, subjectLabel: null };
  if (!CONTRACT_SUBJECT_TYPES.has(rawType)) throw new Error("INVALID_SUBJECT_TYPE");
  const parsedId = input.subjectId === undefined || input.subjectId === null || input.subjectId === ""
    ? null
    : Number(input.subjectId);
  if (rawType !== "other" && (!Number.isInteger(parsedId) || Number(parsedId) <= 0)) {
    throw new Error("INVALID_SUBJECT_ID");
  }
  const subjectLabel = typeof input.subjectLabel === "string" && input.subjectLabel.trim()
    ? input.subjectLabel.trim().slice(0, 250)
    : null;
  return { subjectType: rawType, subjectId: parsedId ? Number(parsedId) : null, subjectLabel };
}

async function markEmailSent(sessionId: number, reminder = false) {
  const now = new Date();
  const updates: Record<string, unknown> = {
    lastSentAt: now,
    sendCount: sql`${signingSessionsTable.sendCount} + 1`,
  };
  if (reminder) updates.lastReminderAt = now;
  await db.update(signingSessionsTable).set(updates).where(eq(signingSessionsTable.id, sessionId));
}

// Status-neutral PDF-cache reset applied by the regenerate endpoint. It clears
// ONLY the rendered-PDF cache fields so the background sweep re-renders the PDF;
// it must NEVER include any status field (signed_contracts has no status; a
// signed contract's "signed" state lives on signing_sessions.status, which this
// payload does not touch). Exported so a regression test can assert the exact
// (PDF-cache-only) key set and catch any future status mutation. Keep this in
// lockstep with the agent's signed-contract detection: detection keys off
// signing_sessions.status='signed', never off these PDF-cache fields.
export const REGENERATE_PDF_CACHE_RESET = {
  pdfObjectKey: null,
  evidenceHash: null,
  deliveryClaimedAt: null,
} as const;

async function pickTemplate(language: string, entityType: string) {
  // Strict match: only the exact (language, entityType) pair, latest version.
  // No silent language fallback — caller must surface the 404 to the operator
  // so they can either pick another language or upload the missing template.
  const exact = await db.select().from(contractTemplatesTable)
    .where(and(
      isNull(contractTemplatesTable.deletedAt),
      eq(contractTemplatesTable.isActive, true),
      eq(contractTemplatesTable.publicationStatus, "published"),
      eq(contractTemplatesTable.language, language),
      eq(contractTemplatesTable.entityType, entityType),
    ))
    .orderBy(desc(contractTemplatesTable.version))
    .limit(1);
  return exact[0] || null;
}

async function loadTemplateById(id: number) {
  const [row] = await db.select().from(contractTemplatesTable)
    .where(and(eq(contractTemplatesTable.id, id), isNull(contractTemplatesTable.deletedAt), eq(contractTemplatesTable.isActive, true), eq(contractTemplatesTable.publicationStatus, "published")));
  return row || null;
}

async function describeUnavailableTemplate(id: number): Promise<{ status: number; error: string }> {
  const [row] = await db.select({
    isActive: contractTemplatesTable.isActive,
    publicationStatus: contractTemplatesTable.publicationStatus,
  }).from(contractTemplatesTable)
    .where(and(eq(contractTemplatesTable.id, id), isNull(contractTemplatesTable.deletedAt)));

  if (!row) return { status: 404, error: `Contract template ${id} not found` };
  if (!row.isActive) return { status: 409, error: `Contract template ${id} is inactive` };
  if (row.publicationStatus !== "published") {
    return {
      status: 409,
      error: `Contract template ${id} is ${row.publicationStatus}. Publish it before creating or sending a signing link.`,
    };
  }
  return { status: 404, error: `Contract template ${id} is unavailable` };
}

// Mode-aware gate: self-fill listings honor self_fill_links.view, admin-driven listings honor contracts.view.
async function gateSessionList(req: any, res: any, next: any) {
  const mode = (req.query.mode as string) || null;
  const need = mode === "self_fill" ? "self_fill_links.view" : "contracts.view";
  return requirePermission(need)(req, res, next);
}

type SessionStatus = "intake_pending" | "review_pending" | "signed" | "revoked" | "expired";
const ALLOWED_STATUSES: readonly SessionStatus[] = ["intake_pending", "review_pending", "signed", "revoked", "expired"] as const;

router.get("/contracts/sessions", requireAuth, gateSessionList, async (req, res): Promise<void> => {
  try {
    const me = (req as any).user!;
    const mode = (req.query.mode as string) || null;
    const filters: SQL<unknown>[] = [];
    if (mode === "self_fill" || mode === "admin_driven") filters.push(eq(signingSessionsTable.mode, mode));
    // Branch-scope: non-super_admin users only see sessions whose agent is in
    // their visible branches. agentId=null (self_fill with no agent) is always visible.
    const visible = await getVisibleBranchIds(me.id, me.role, me);
    if (visible !== null) {
      if (visible.length > 0) {
        const scopedAgents = await db
          .select({ agentId: agentBranchesTable.agentId })
          .from(agentBranchesTable)
          .where(inArray(agentBranchesTable.branchId, visible));
        const scopedIds = [...new Set(scopedAgents.map(r => r.agentId))];
        filters.push(or(isNull(signingSessionsTable.agentId), scopedIds.length ? inArray(signingSessionsTable.agentId, scopedIds) : isNull(signingSessionsTable.agentId))!);
      } else {
        // No visible branches → only agentId=null records
        filters.push(isNull(signingSessionsTable.agentId));
      }
    }
    const statusParam = (req.query.status as string) || "";
    if (statusParam) {
      const wanted = statusParam.split(",").map(s => s.trim()).filter((s): s is SessionStatus => (ALLOWED_STATUSES as readonly string[]).includes(s));
      if (wanted.length) filters.push(inArray(signingSessionsTable.status, wanted));
    }
    const language = (req.query.language as string) || "";
    const entityType = (req.query.entityType as string) || "";
    if (language || entityType) {
      const tplFilters: SQL<unknown>[] = [];
      if (language) tplFilters.push(eq(contractTemplatesTable.language, language));
      if (entityType === "company" || entityType === "individual") tplFilters.push(eq(contractTemplatesTable.entityType, entityType));
      const matchedTpls = await db.select({ id: contractTemplatesTable.id }).from(contractTemplatesTable).where(and(...tplFilters));
      const ids = matchedTpls.map(t => t.id);
      if (!ids.length) { res.json({ data: [] }); return; }
      filters.push(inArray(signingSessionsTable.templateId, ids));
    }
    const dateFrom = (req.query.dateFrom as string) || "";
    const dateTo = (req.query.dateTo as string) || "";
    if (dateFrom) {
      const d = new Date(dateFrom);
      if (!isNaN(d.getTime())) filters.push(gte(signingSessionsTable.createdAt, d));
    }
    if (dateTo) {
      const d = new Date(dateTo);
      if (!isNaN(d.getTime())) filters.push(lte(signingSessionsTable.createdAt, d));
    }
    const search = (req.query.search as string) || "";
    if (search) {
      const term = `%${search.replace(/[%_]/g, "\\$&")}%`;
      const orExpr = or(ilike(signingSessionsTable.signerEmail, term), ilike(signingSessionsTable.signerName, term));
      if (orExpr) filters.push(orExpr);
    }
    const where = filters.length ? and(...filters) : undefined;
    const rows = await db.select({
      id: signingSessionsTable.id,
      templateId: signingSessionsTable.templateId,
      agentId: signingSessionsTable.agentId,
      mode: signingSessionsTable.mode,
      status: signingSessionsTable.status,
      signerEmail: signingSessionsTable.signerEmail,
      signerName: signingSessionsTable.signerName,
      expiresAt: signingSessionsTable.expiresAt,
      openedAt: signingSessionsTable.openedAt,
      signedAt: signingSessionsTable.signedAt,
      revokedAt: signingSessionsTable.revokedAt,
      createdAt: signingSessionsTable.createdAt,
      isPrimaryOnboarding: signingSessionsTable.isPrimaryOnboarding,
      subjectType: signingSessionsTable.subjectType,
      subjectId: signingSessionsTable.subjectId,
      subjectLabel: signingSessionsTable.subjectLabel,
      lastSentAt: signingSessionsTable.lastSentAt,
      lastReminderAt: signingSessionsTable.lastReminderAt,
      sendCount: signingSessionsTable.sendCount,
    }).from(signingSessionsTable)
      .where(where)
      .orderBy(desc(signingSessionsTable.createdAt))
      .limit(500);
    res.json({ data: rows });
  } catch (err) {
    console.error("[contracts] sessions list:", err);
    res.status(500).json({ error: "Failed to list signing sessions" });
  }
});

router.get("/contracts/signed", requireAuth, requirePermission("contracts.view"), async (req, res): Promise<void> => {
  try {
    const me = (req as any).user!;
    const visible = await getVisibleBranchIds(me.id, me.role, me);
    const cols = {
      ...getTableColumns(signedContractsTable),
      templateTitle: contractTemplatesTable.title,
    };
    let rows;
    if (visible === null) {
      rows = await db.select(cols).from(signedContractsTable)
        .leftJoin(contractTemplatesTable, eq(signedContractsTable.templateId, contractTemplatesTable.id))
        .orderBy(desc(signedContractsTable.signedAt))
        .limit(500);
    } else if (visible.length > 0) {
      const scopedAgents = await db
        .select({ agentId: agentBranchesTable.agentId })
        .from(agentBranchesTable)
        .where(inArray(agentBranchesTable.branchId, visible));
      const scopedIds = [...new Set(scopedAgents.map(r => r.agentId))];
      rows = await db.select(cols).from(signedContractsTable)
        .leftJoin(contractTemplatesTable, eq(signedContractsTable.templateId, contractTemplatesTable.id))
        .where(scopedIds.length ? or(isNull(signedContractsTable.agentId), inArray(signedContractsTable.agentId, scopedIds)) : isNull(signedContractsTable.agentId))
        .orderBy(desc(signedContractsTable.signedAt))
        .limit(500);
    } else {
      rows = await db.select(cols).from(signedContractsTable)
        .leftJoin(contractTemplatesTable, eq(signedContractsTable.templateId, contractTemplatesTable.id))
        .where(isNull(signedContractsTable.agentId))
        .orderBy(desc(signedContractsTable.signedAt))
        .limit(500);
    }
    res.json({ data: rows });
  } catch (err) {
    console.error("[contracts] signed list:", err);
    res.status(500).json({ error: "Failed to list signed contracts" });
  }
});

// Signed contracts are immutable evidence records. They may be downloaded or
// regenerated from their captured snapshot, but never deleted through the API.
router.delete("/contracts/signed/:id", requireAuth, requirePermission("contracts.manage"), async (_req, res): Promise<void> => {
  res.status(409).json({ error: "Signed contracts are immutable and cannot be deleted." });
});

// Admin-gated streaming download for a signed contract PDF.
router.get("/contracts/signed/:id/pdf", requireAuth, requirePermission("contracts.view"), async (req, res): Promise<void> => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
    const [row] = await db.select().from(signedContractsTable).where(eq(signedContractsTable.id, id));
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    if (row.agentId) {
      const inScope = await isAgentInScope((req as any).user!.id, (req as any).user!.role, row.agentId);
      if (!inScope) { res.status(403).json({ error: "Access denied: agent is outside your branch scope" }); return; }
    }
    const pdfKey = row.pdfObjectKey;
    if (!pdfKey) {
      // PDF not yet rendered. The signed-contract delivery worker generates it
      // off the request path (no Chromium here — synchronous render was the
      // autoscale OOM root cause). Tell the client to retry shortly.
      res.setHeader("Retry-After", "30");
      res.status(202).json({ status: "pending", message: "PDF is being generated. Please try again in a moment.", retryAfter: 30 });
      return;
    }
    const { ObjectStorageService } = await import("../lib/objectStorage");
    const svc = new ObjectStorageService();
    const file = await svc.getObjectEntityFile(pdfKey);
    // Meaningful, deterministic filename derived from the SAME contractNumber()
    // source as the document body's {{contract_number}} (e.g.
    // FAS-2026-00025_signed.pdf). The storage object key keeps its uuid.
    const filename = signedContractFilename(row.signingSessionId, row.signedAt ? new Date(row.signedAt) : (row.createdAt ? new Date(row.createdAt) : undefined));
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    await svc.streamObjectToResponse(req, res, file, {
      contentType: "application/pdf",
      cacheControl: "private, no-store",
    });
  } catch (err) {
    console.error("[contracts] signed pdf:", err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to download" });
  }
});

// Force-regenerate a signed contract's final PDF, bypassing the idempotent
// render cache. ensureSignedContractPdf() early-returns whenever
// pdf_object_key + evidence_hash are already set, so a template/renderer change
// (e.g. adding the main-agency seal) never reaches an already-rendered contract.
// This endpoint clears those columns (and releases any delivery lease) so the
// existing background sweep (backfillMissingSignedPdfs, which targets
// pdf_object_key IS NULL) re-renders the PDF with the current renderer.
//
// The render itself deliberately runs OFF the request path: launching headless
// Chromium inside an HTTP handler OOM-killed the 512MB autoscale container and
// surfaced as an opaque edge 403, so we never render synchronously here. We only
// clear the cache and let the worker pick it up (within ~30s of any instance
// being alive). We do NOT touch emailed_at, so an already-delivered contract is
// regenerated WITHOUT re-sending any notification email.
router.post("/contracts/signed/:id/regenerate", requireAuth, requirePermission("contracts.manage"), async (req, res): Promise<void> => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
    const [row] = await db.select().from(signedContractsTable).where(eq(signedContractsTable.id, id));
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    if (row.agentId) {
      const inScope = await isAgentInScope((req as any).user!.id, (req as any).user!.role, row.agentId);
      if (!inScope) { res.status(403).json({ error: "Access denied: agent is outside your branch scope" }); return; }
    }
    await db.update(signedContractsTable)
      .set(REGENERATE_PDF_CACHE_RESET)
      .where(eq(signedContractsTable.id, id));
    await writeAudit({
      userId: (req as any).user?.id ?? null,
      action: "contract.regenerate_pdf",
      resource: "signed_contract",
      resourceId: id,
      changes: { signingSessionId: row.signingSessionId, agentId: row.agentId },
      ipAddress: Array.isArray(req.ip) ? req.ip[0] : req.ip,
    });
    res.status(202).json({ status: "queued", message: "PDF yeniden oluşturuluyor; kısa süre içinde indirilmeye hazır olacak." });
  } catch (err) {
    console.error("[contracts] regenerate pdf:", err);
    res.status(500).json({ error: "Failed to queue regeneration" });
  }
});

router.post("/contracts/admin-send", requireAuth, requirePermission("contracts.manage"), async (req, res): Promise<void> => {
  try {
    const body = req.body || {};
    const {
      agentId,
      signerEmail: requestedSignerEmail,
      signerName: requestedSignerName,
      language: requestedLang,
      entityType: requestedEntityType,
      expiryDays,
      templateId: explicitTemplateId,
    } = body;
    let subject;
    try {
      subject = parseSubject(body);
    } catch (err: any) {
      if (err?.message === "INVALID_SUBJECT_TYPE") { res.status(400).json({ error: "Invalid subjectType" }); return; }
      if (err?.message === "INVALID_SUBJECT_ID") { res.status(400).json({ error: "subjectId is required for the selected subjectType" }); return; }
      throw err;
    }

    // Backwards-compatible agentId support. The new UI treats the association
    // as optional and represents an agent association through subjectType/id.
    const legacyAgentId = agentId === undefined || agentId === null || agentId === ""
      ? null
      : parseInt(String(agentId), 10);
    if (legacyAgentId !== null && (!Number.isInteger(legacyAgentId) || legacyAgentId <= 0)) {
      res.status(400).json({ error: "Invalid agentId" }); return;
    }
    const subjectAgentId = subject.subjectType === "agent" ? subject.subjectId : null;
    if (legacyAgentId && subjectAgentId && legacyAgentId !== subjectAgentId) {
      res.status(400).json({ error: "agentId and subjectId must reference the same agent" }); return;
    }
    const aId = legacyAgentId || subjectAgentId;

    let agent: typeof agentsTable.$inferSelect | null = null;
    if (aId) {
      const rows = await db.select().from(agentsTable).where(eq(agentsTable.id, aId));
      agent = rows[0] || null;
      if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
      const inScope = await isAgentInScope((req as any).user!.id, (req as any).user!.role, aId);
      if (!inScope) { res.status(403).json({ error: "Access denied: agent is outside your branch scope" }); return; }
    }
    if (agent?.userId) {
      const [linkedUser] = await db.select({ role: usersTable.role }).from(usersTable).where(eq(usersTable.id, agent.userId));
      if (linkedUser && (linkedUser.role === "agent_staff" || linkedUser.role === "sub_agent")) {
        res.status(400).json({ error: "Contracts cannot be sent to agent staff or sub-agent accounts" });
        return;
      }
    }

    const fallbackAgentName = agent
      ? (`${agent.firstName || ""} ${agent.lastName || ""}`.trim() || agent.businessName || null)
      : null;
    const signerName = typeof requestedSignerName === "string" && requestedSignerName.trim()
      ? requestedSignerName.trim().slice(0, 200)
      : fallbackAgentName;
    const signerEmail = (typeof requestedSignerEmail === "string" && requestedSignerEmail.trim()
      ? requestedSignerEmail
      : agent?.email || "").trim().toLowerCase();
    if (!signerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(signerEmail)) {
      res.status(400).json({ error: agent ? "Agent has no valid email on file; enter a signerEmail" : "A valid signerEmail is required" });
      return;
    }

    if (agent) {
      subject = {
        subjectType: "agent",
        subjectId: agent.id,
        subjectLabel: subject.subjectLabel || agent.businessName || fallbackAgentName,
      };
    }

    const lang = (requestedLang && typeof requestedLang === "string") ? requestedLang : (agent?.preferredContractLanguage || "en");
    const entityType = requestedEntityType === "individual" || agent?.entityType === "individual" ? "individual" : "company";
    let tpl = null as unknown as Awaited<ReturnType<typeof pickTemplate>>;
    if (explicitTemplateId) {
      const tid = parseInt(String(explicitTemplateId), 10);
      if (!tid) { res.status(400).json({ error: "Invalid templateId" }); return; }
      tpl = await loadTemplateById(tid);
      if (!tpl) {
        const unavailable = await describeUnavailableTemplate(tid);
        res.status(unavailable.status).json({ error: unavailable.error });
        return;
      }
    } else {
      tpl = await pickTemplate(lang, entityType);
      if (!tpl) { res.status(404).json({ error: `No active template found for language=${lang}, entityType=${entityType}` }); return; }
    }

    const { rawToken, tokenHash } = createSigningToken();
    const days = parseExpiryDays(expiryDays);
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    const brandingSnapshot = await resolveContractTemplateBranding(tpl);
    if (!hasContractCompanySignature(brandingSnapshot)) {
      res.status(409).json({
        error: "The selected template has no official company signature. Assign a brand profile with a signature and publish a new template version before issuing a signing link.",
      });
      return;
    }

    const [session] = await db.insert(signingSessionsTable).values({
      templateId: tpl.id,
      templateVersionSnapshot: tpl.version,
      templateNameSnapshot: tpl.name,
      templateLanguageSnapshot: tpl.language,
      templateEntityTypeSnapshot: tpl.entityType,
      templateBodyHtmlSnapshot: tpl.bodyHtml,
      templateIntakeSchemaSnapshot: tpl.intakeSchema,
      templateSigningPageConfigSnapshot: brandingSnapshot,
      agentId: aId || null,
      tokenHash,
      mode: "admin_driven",
      status: "review_pending",
      intakeData: null,
      signerEmail,
      signerName,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      subjectLabel: subject.subjectLabel,
      expiresAt,
      createdByUserId: (req as any).user?.id ?? null,
    }).returning();

    const signUrl = `${getAppBaseUrl()}/sign/${rawToken}`;
    let emailSent = false;
    try {
      const email = await buildContractSignRequestEmail({
        signerName,
        agentName: agent?.businessName || subject.subjectLabel || null,
        templateName: tpl.name,
        signUrl,
        expiresAt,
        selfFill: false,
      });
      await sendEmail(signerEmail, email);
      await markEmailSent(session.id);
      emailSent = true;
    } catch (err) {
      console.error("[contracts] failed to send sign request email:", err);
    }

    const actorUserId = (req as any).user?.id ?? undefined;
    const sentVars = { signerName: signerName || "", signerEmail, contractName: tpl.name || "", contractLink: signUrl };
    (async () => {
      try {
        await dispatchNotification({
          event: "contract.sent",
          title: "Contract Sent",
          body: `Contract "${sentVars.contractName}" sent to ${sentVars.signerName || sentVars.signerEmail}.`,
          actorUserId,
          templateVars: sentVars,
        });
      } catch (e) { console.error("[contracts] contract.sent dispatch:", e); }
    })();

    await writeAudit({
      userId: actorUserId ?? null,
      action: "contract.link_sent",
      resource: "signing_session",
      resourceId: session.id,
      changes: {
        mode: "admin_driven",
        agentId: aId || null,
        templateId: tpl.id,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        expiresAt: expiresAt.toISOString(),
      },
      ipAddress: req.ip,
    });

    res.status(201).json({ data: { sessionId: session.id, signUrl, templateId: tpl.id, expiresAt, emailSent } });
  } catch (err) {
    console.error("[contracts] admin-send:", err);
    res.status(500).json({ error: "Failed to create signing session" });
  }
});

router.post("/contracts/self-fill-link", requireAuth, requirePermission("self_fill_links.manage"), async (req, res): Promise<void> => {
  try {
    const { signerEmail, signerName, language, entityType, expiryDays, templateId } = req.body || {};
    let subject;
    try {
      subject = parseSubject(req.body || {});
    } catch (err: any) {
      if (err?.message === "INVALID_SUBJECT_TYPE") { res.status(400).json({ error: "Invalid subjectType" }); return; }
      if (err?.message === "INVALID_SUBJECT_ID") { res.status(400).json({ error: "subjectId is required for the selected subjectType" }); return; }
      throw err;
    }
    const hasEmail = typeof signerEmail === "string" && signerEmail.trim().length > 0;
    let tpl: Awaited<ReturnType<typeof pickTemplate>> | Awaited<ReturnType<typeof loadTemplateById>> | null = null;
    if (templateId !== undefined && templateId !== null && templateId !== "") {
      const tid = typeof templateId === "number" ? templateId : parseInt(String(templateId), 10);
      if (!Number.isInteger(tid) || tid <= 0) { res.status(400).json({ error: "Invalid templateId" }); return; }
      tpl = await loadTemplateById(tid);
      if (!tpl) {
        const unavailable = await describeUnavailableTemplate(tid);
        res.status(unavailable.status).json({ error: unavailable.error });
        return;
      }
    } else {
      const lang = (language && typeof language === "string") ? language : "en";
      const ent = entityType === "individual" ? "individual" : "company";
      tpl = await pickTemplate(lang, ent);
      if (!tpl) { res.status(404).json({ error: `No active template found for language=${lang}, entityType=${ent}` }); return; }
    }

    const { rawToken, tokenHash } = createSigningToken();
    const days = parseExpiryDays(expiryDays);
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    const normalizedEmail = hasEmail ? String(signerEmail).toLowerCase().trim() : "";
    const brandingSnapshot = await resolveContractTemplateBranding(tpl);
    if (!hasContractCompanySignature(brandingSnapshot)) {
      res.status(409).json({
        error: "The selected template has no official company signature. Assign a brand profile with a signature and publish a new template version before issuing a signing link.",
      });
      return;
    }
    const [session] = await db.insert(signingSessionsTable).values({
      templateId: tpl.id,
      templateVersionSnapshot: tpl.version,
      templateNameSnapshot: tpl.name,
      templateLanguageSnapshot: tpl.language,
      templateEntityTypeSnapshot: tpl.entityType,
      templateBodyHtmlSnapshot: tpl.bodyHtml,
      templateIntakeSchemaSnapshot: tpl.intakeSchema,
      templateSigningPageConfigSnapshot: brandingSnapshot,
      agentId: null,
      tokenHash,
      mode: "self_fill",
      status: "intake_pending",
      intakeData: null,
      signerEmail: normalizedEmail,
      // Lock the expected email at creation time. send-code/verify-code will
      // reject any address that doesn't match, preventing a signer from
      // redirecting the verification code to an arbitrary inbox after the link
      // has been issued (email rebinding attack).
      expectedEmail: hasEmail ? normalizedEmail : null,
      signerName: signerName ? String(signerName).slice(0, 200) : null,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      subjectLabel: subject.subjectLabel,
      expiresAt,
      createdByUserId: (req as any).user?.id ?? null,
    }).returning();

    const signUrl = `${getAppBaseUrl()}/sign/${rawToken}`;
    let emailSent = false;
    if (hasEmail) {
      try {
        const email = await buildContractSignRequestEmail({
          signerName: signerName || null,
          agentName: null,
          templateName: tpl.name,
          signUrl,
          expiresAt,
          selfFill: true,
        });
        await sendEmail(session.signerEmail, email);
        await markEmailSent(session.id);
        emailSent = true;
      } catch (err) {
        console.error("[contracts] failed to send self-fill email:", err);
      }
    }

    const sfActorId = (req as any).user?.id ?? undefined;
    const sfVars = { signerName: signerName || "", signerEmail: normalizedEmail || "", contractName: tpl.name || "", contractLink: signUrl };
    (async () => {
      try {
        await dispatchNotification({
          event: "contract.sent",
          title: "Contract Sent",
          body: `Contract "${sfVars.contractName}" sent to ${sfVars.signerName || sfVars.signerEmail}.`,
          actorUserId: sfActorId,
          templateVars: sfVars,
        });
      } catch (e) { console.error("[contracts] contract.sent dispatch (self_fill):", e); }
    })();

    await writeAudit({
      userId: sfActorId ?? null,
      action: "contract.link_sent",
      resource: "signing_session",
      resourceId: session.id,
      changes: { mode: "self_fill", templateId: tpl.id, expiresAt: expiresAt.toISOString() },
      ipAddress: req.ip,
    });

    res.status(201).json({ data: { sessionId: session.id, signUrl, templateId: tpl.id, expiresAt, emailSent } });
  } catch (err) {
    console.error("[contracts] self-fill-link:", err);
    res.status(500).json({ error: "Failed to create self-fill link" });
  }
});

async function gateSessionMutate(req: any, res: any, next: any) {
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const [row] = await db.select({ mode: signingSessionsTable.mode, agentId: signingSessionsTable.agentId }).from(signingSessionsTable).where(eq(signingSessionsTable.id, id));
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  // Branch-scope check: admin_driven sessions belong to an agent; verify
  // the caller can see that agent's branch before allowing any mutation.
  if (row.mode === "admin_driven" && row.agentId) {
    const inScope = await isAgentInScope(req.user!.id, req.user!.role, row.agentId);
    if (!inScope) { res.status(403).json({ error: "Access denied: agent is outside your branch scope" }); return; }
  }
  const need = row.mode === "self_fill" ? "self_fill_links.manage" : "contracts.manage";
  return requirePermission(need)(req, res, next);
}

// Update signer details on a non-signed session (self_fill only; admin_driven identity is fixed after dispatch).
router.patch("/contracts/sessions/:id", requireAuth, gateSessionMutate, async (req, res): Promise<void> => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const [existing] = await db.select({ status: signingSessionsTable.status, mode: signingSessionsTable.mode }).from(signingSessionsTable).where(eq(signingSessionsTable.id, id));
    if (!existing) { res.status(404).json({ error: "Not found" }); return; }
    if (existing.mode !== "self_fill") { res.status(409).json({ error: "Signer identity is fixed on admin-driven sessions and cannot be edited" }); return; }
    if (existing.status === "signed") { res.status(409).json({ error: "Cannot edit a signed session" }); return; }
    const { signerName, signerEmail } = req.body as { signerName?: string; signerEmail?: string };
    const updates: Record<string, any> = {};
    if (signerName !== undefined) updates.signerName = signerName || null;
    if (signerEmail !== undefined) {
      const normalizedEmail = signerEmail.trim().toLowerCase();
      if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        res.status(400).json({ error: "Invalid signerEmail" }); return;
      }
      updates.signerEmail = normalizedEmail;
      updates.expectedEmail = normalizedEmail;
      updates.verifiedEmail = null;
    }
    if (req.body.subjectType !== undefined || req.body.subjectId !== undefined || req.body.subjectLabel !== undefined) {
      try {
        Object.assign(updates, parseSubject(req.body as Record<string, unknown>));
      } catch (err: any) {
        if (err?.message === "INVALID_SUBJECT_TYPE") { res.status(400).json({ error: "Invalid subjectType" }); return; }
        if (err?.message === "INVALID_SUBJECT_ID") { res.status(400).json({ error: "subjectId is required for the selected subjectType" }); return; }
        throw err;
      }
    }
    if (Object.keys(updates).length === 0) { res.status(400).json({ error: "No fields to update" }); return; }
    const [row] = await db.update(signingSessionsTable).set(updates).where(eq(signingSessionsTable.id, id)).returning();
    await writeAudit({
      userId: (req as any).user?.id ?? null,
      action: "contract.session_updated",
      resource: "signing_session",
      resourceId: id,
      changes: updates,
      ipAddress: req.ip,
    });
    res.json({ data: row });
  } catch (err) {
    console.error("[contracts] patch session:", err);
    res.status(500).json({ error: "Failed to update session" });
  }
});

router.post("/contracts/sessions/:id/revoke", requireAuth, gateSessionMutate, async (req, res): Promise<void> => {
  try {
    const id = parseInt(String(req.params.id), 10);
    // Lifecycle guard: a signed session is final and must not be revoked —
    // doing so would orphan the signed_contracts row and break token-gated
    // PDF access. Already-revoked is a no-op.
    const [existing] = await db.select({ status: signingSessionsTable.status }).from(signingSessionsTable).where(eq(signingSessionsTable.id, id));
    if (!existing) { res.status(404).json({ error: "Not found" }); return; }
    if (existing.status === "signed") { res.status(409).json({ error: "Cannot revoke a signed session" }); return; }
    if (existing.status === "revoked") { res.json({ success: true, alreadyRevoked: true }); return; }
    const [row] = await db.update(signingSessionsTable)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(and(eq(signingSessionsTable.id, id), eq(signingSessionsTable.status, existing.status)))
      .returning();
    if (!row) { res.status(409).json({ error: "Session state changed; refresh and try again" }); return; }
    await writeAudit({
      userId: (req as any).user?.id ?? null,
      action: "contract.revoked",
      resource: "signing_session",
      resourceId: id,
      ipAddress: req.ip,
    });
    res.json({ success: true });
  } catch (err) {
    console.error("[contracts] revoke:", err);
    res.status(500).json({ error: "Failed to revoke session" });
  }
});

// Hard-delete a non-signed session. Signed sessions are protected because the
// signed_contracts row holds them as the audit anchor.
router.delete("/contracts/sessions/:id", requireAuth, gateSessionMutate, async (req, res): Promise<void> => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const [existing] = await db.select({ status: signingSessionsTable.status }).from(signingSessionsTable).where(eq(signingSessionsTable.id, id));
    if (!existing) { res.status(404).json({ error: "Not found" }); return; }
    if (existing.status === "signed") { res.status(409).json({ error: "Cannot delete a signed session" }); return; }
    await db.delete(signingSessionsTable).where(eq(signingSessionsTable.id, id));
    await writeAudit({
      userId: (req as any).user?.id ?? null,
      action: "contract.session_deleted",
      resource: "signing_session",
      resourceId: id,
      changes: { previousStatus: existing.status },
      ipAddress: req.ip,
    });
    res.json({ success: true });
  } catch (err) {
    console.error("[contracts] delete session:", err);
    res.status(500).json({ error: "Failed to delete session" });
  }
});

router.post("/contracts/sessions/:id/resend", requireAuth, gateSessionMutate, async (req, res): Promise<void> => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
    const [session] = await db.select().from(signingSessionsTable).where(eq(signingSessionsTable.id, id));
    if (!session) { res.status(404).json({ error: "Not found" }); return; }
    if (session.status === "signed" || session.status === "revoked") {
      res.status(409).json({ error: "Cannot resend a signed or revoked session" }); return;
    }
    // Issue a new token and reset expiry.
    const { rawToken, tokenHash } = createSigningToken();
    const expiresAt = new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await db.update(signingSessionsTable)
      .set({ tokenHash, expiresAt })
      .where(eq(signingSessionsTable.id, id));
    const [tpl] = await db.select().from(contractTemplatesTable).where(eq(contractTemplatesTable.id, session.templateId));
    const signUrl = `${getAppBaseUrl()}/sign/${rawToken}`;
    let emailSent = false;
    if (tpl && session.signerEmail) {
      try {
        const email = await buildContractSignRequestEmail({
          signerName: session.signerName,
          agentName: null,
          templateName: tpl.name,
          signUrl,
          expiresAt,
          selfFill: session.mode === "self_fill",
        });
        await sendEmail(session.signerEmail, email);
        await markEmailSent(id);
        emailSent = true;
      } catch (err) {
        console.error("[contracts] failed to resend email:", err);
      }
    }
    const resendActorId = (req as any).user?.id ?? undefined;
    const resendVars = { signerName: session.signerName || "", signerEmail: session.signerEmail || "", contractName: tpl?.name || "", contractLink: signUrl };
    if (emailSent) (async () => {
      try {
        await dispatchNotification({
          event: "contract.sent",
          title: "Contract Resent",
          body: `Contract "${resendVars.contractName}" resent to ${resendVars.signerName || resendVars.signerEmail}.`,
          actorUserId: resendActorId,
          templateVars: resendVars,
        });
      } catch (e) { console.error("[contracts] contract.sent dispatch (resend):", e); }
    })();
    await writeAudit({
      userId: resendActorId ?? null,
      action: "contract.link_sent",
      resource: "signing_session",
      resourceId: id,
      changes: { resent: true, emailSent },
      ipAddress: req.ip,
    });
    res.json({ data: { signUrl, expiresAt, emailSent } });
  } catch (err) {
    console.error("[contracts] resend:", err);
    res.status(500).json({ error: "Failed to resend session" });
  }
});

router.post("/contracts/sessions/:id/remind", requireAuth, gateSessionMutate, async (req, res): Promise<void> => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
    const [session] = await db.select().from(signingSessionsTable).where(eq(signingSessionsTable.id, id));
    if (!session) { res.status(404).json({ error: "Not found" }); return; }
    if (session.status === "signed" || session.status === "revoked") {
      res.status(409).json({ error: "Cannot remind a signed or revoked session" }); return;
    }
    if (!session.signerEmail) { res.status(409).json({ error: "A signer email is required before sending a reminder" }); return; }

    const [tpl] = await db.select().from(contractTemplatesTable).where(eq(contractTemplatesTable.id, session.templateId));
    if (!tpl) { res.status(404).json({ error: "Contract template not found" }); return; }

    let rawToken: string;
    let expiresAt = session.expiresAt;
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      const token = createSigningToken();
      rawToken = token.rawToken;
      expiresAt = new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
      await db.update(signingSessionsTable)
        .set({ tokenHash: token.tokenHash, expiresAt, status: "intake_pending" })
        .where(eq(signingSessionsTable.id, id));
    } else {
      const token = createSigningToken();
      rawToken = token.rawToken;
      await db.update(signingSessionsTable).set({ tokenHash: token.tokenHash }).where(eq(signingSessionsTable.id, id));
    }

    const signUrl = `${getAppBaseUrl()}/sign/${rawToken}`;
    const email = await buildContractSignRequestEmail({
      signerName: session.signerName,
      agentName: null,
      templateName: tpl.name,
      signUrl,
      expiresAt,
      selfFill: session.mode === "self_fill",
    });
    await sendEmail(session.signerEmail, email);
    await markEmailSent(id, true);
    await writeAudit({
      userId: (req as any).user?.id ?? null,
      action: "contract.reminder_sent",
      resource: "signing_session",
      resourceId: id,
      changes: { signerEmail: session.signerEmail, expiresAt: expiresAt.toISOString() },
      ipAddress: req.ip,
    });
    res.json({ data: { signUrl, expiresAt, emailSent: true } });
  } catch (err) {
    console.error("[contracts] reminder:", err);
    res.status(502).json({ error: "Failed to send contract reminder" });
  }
});

export default router;
