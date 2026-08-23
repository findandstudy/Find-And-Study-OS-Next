import { Router, type IRouter, json, raw } from "express";
import crypto from "crypto";
import { z } from "zod";
import {
  emptySummary,
  tallyResult,
  isValidConflictStrategy,
  ImportValidationError,
  type ConflictStrategy,
} from "../lib/exportImport";
import {
  buildWorkbookBuffer,
  parseWorkbookBuffer,
  XLSX_CONTENT_TYPE,
  AGENTS_KIND,
  agentColumns,
  agentExportRows,
  buildAgentReferenceSheets,
  toAgentInsertValues,
  type AgentCatalog,
} from "../lib/exportImportExcel";
import { db, agentsTable, usersTable, DEFAULT_ROLE_PERMISSIONS, commissionsTable, agentBranchesTable, branchesTable, contractTemplatesTable, signingSessionsTable, settingsTable, emailVerificationCodesTable, conversationsTable, messagesTable, broadcastsTable, messageTemplatesTable, notesTable, applicationStageDocumentsTable } from "@workspace/db";
import { getNewestSignedContractUrl } from "../lib/signContract";
import { eq, sql, isNull, isNotNull, and, or, ilike, inArray, desc, type SQL } from "drizzle-orm";
import { requireAuth, requireRole, requireAgentStaffPermission, logAudit, AGENT_STAFF_PERMISSIONS as PERM_KEYS } from "../lib/auth";
import { writeAudit } from "../lib/auditLog";
import { sendEmail, buildAgentCredentialsEmail, getAppBaseUrl } from "../lib/email";
import { createSigningToken } from "../lib/signingTokens";
import { ONBOARDING_HELPERS } from "./agentOnboarding";
import { STAFF_ROLES, MANAGER_ROLES, AGENT_ROLES } from "../lib/roles";
import { getVisibleBranchIds, isAgentInScope } from "../lib/branchScope";
import bcrypt from "bcryptjs";
import { createSession, getSession, deleteSession, deleteSessionsForUser, SESSION_COOKIE, SESSION_TTL, type SessionData } from "../lib/replitAuth";
import { getSessionCookieOptions } from "../lib/cookieOptions";
import { dispatchNotification } from "../lib/notificationDispatcher";
import { hasContractCompanySignature, type ContractBrandingConfig } from "../lib/contractBranding";
import { resolveContractTemplateBranding } from "../lib/contractTemplateBranding";
import { dispatchAgentProfileChangedNotif } from "../lib/agentProfileNotif";
import { toE164 } from "../lib/inbox/phone";
import { getCurrentSeason } from "../lib/season";
import { setAgencyStaff, getAgencyStaff, getAgencyStaffWithLegacy, getAgencyStaffMap, parseStaffInput, staffDisplayName } from "../lib/agencyStaff";
import { validatePassword } from "../lib/passwordPolicy";

const router: IRouter = Router();

/**
 * Generate a random login password that satisfies the password policy
 * (min 8 chars, at least one uppercase letter and one digit). Used when an
 * admin creates an agent so the account can be provisioned with credentials
 * emailed to the agent. The agent can change it later from their panel.
 */
function generateAgentPassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const all = upper + lower + digits;
  const pick = (set: string) => set[crypto.randomInt(0, set.length)];
  // Guarantee policy coverage, then fill to length 12 and shuffle.
  const chars = [pick(upper), pick(digits), pick(lower)];
  while (chars.length < 12) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

const AGENT_PATCH_FIELDS = [
  "firstName", "lastName", "email", "phone",
  "status", "commissionRate", "notes", "companyName", "country",
  "agencyCode", "state", "city", "address", "businessName",
  "entityType", "taxNumber", "preferredContractLanguage", "assignedContractTemplateId",
  "category", "logoUrl", "agentIdProofUrl", "businessCertUrl",
  "contractUrl", "contractStartDate", "contractEndDate",
  "branch", "parentAgentId",
  "subAgentCommissionRate", "hideServiceFees", "assignedStaffId", "canManageStaff",
];

const AGENT_SELF_PATCH_FIELDS = [
  "businessName", "logoUrl", "businessCertUrl",
];

function isValidStorageUrl(url: string): boolean {
  if (!url) return true;
  return url.startsWith("/api/storage/objects/") || url.startsWith("https://");
}

router.get("/agents/contract-alerts", requireAuth, requireRole(...STAFF_ROLES), async (req, res): Promise<void> => {
  try {
    const sixtyDaysFromNow = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
    const conditions: SQL[] = [
      isNotNull(agentsTable.contractEndDate),
      isNull(agentsTable.deletedAt),
      eq(agentsTable.status, "active"),
      sql`${agentsTable.contractEndDate} <= ${sixtyDaysFromNow.toISOString().split("T")[0]}`,
    ];
    // Branch scoping: restrict to agents the caller is allowed to see.
    const visible = await getVisibleBranchIds(req.user!.id, req.user!.role, req.user!);
    if (visible !== null) {
      if (visible.length === 0) { res.json([]); return; }
      // Use inArray with a subquery — raw sql `ANY(${visible})` does not
      // correctly serialize a JS number[] as a PostgreSQL array parameter.
      conditions.push(
        inArray(
          agentsTable.id,
          db.select({ id: agentBranchesTable.agentId })
            .from(agentBranchesTable)
            .where(inArray(agentBranchesTable.branchId, visible)),
        ),
      );
    }
    const rows = await db.select({
      id: agentsTable.id,
      firstName: agentsTable.firstName,
      lastName: agentsTable.lastName,
      companyName: agentsTable.companyName,
      contractEndDate: agentsTable.contractEndDate,
    }).from(agentsTable)
      .where(and(...conditions))
      .orderBy(agentsTable.contractEndDate);
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Excel export / import / template ─────────────────────────────────────
// Registered before the `/agents/:id` routes so "export"/"import"/"template"
// are never parsed as an :id. Restricted to managers — bulk creation and
// data export are administrative operations.

// `visible` is the caller's visible branch IDs (null = sees everything).
// Parent-agent suggestions are scoped to that visibility so branch-limited
// managers don't see cross-branch agent names/companies in the reference
// sheet. Contract templates are org-wide config shared by all managers.
async function loadAgentCatalog(visible: number[] | null): Promise<AgentCatalog> {
  const parentConditions: SQL[] = [isNull(agentsTable.parentAgentId), isNull(agentsTable.deletedAt)];
  if (visible !== null) {
    if (visible.length === 0) parentConditions.push(sql`false`);
    else parentConditions.push(sql`${agentsTable.id} IN (SELECT agent_id FROM agent_branches WHERE branch_id = ANY(${visible}))`);
  }
  const [templates, parents] = await Promise.all([
    db.select({
      id: contractTemplatesTable.id,
      name: contractTemplatesTable.name,
      language: contractTemplatesTable.language,
      entityType: contractTemplatesTable.entityType,
    }).from(contractTemplatesTable)
      .where(and(isNull(contractTemplatesTable.deletedAt), eq(contractTemplatesTable.isActive, true)))
      .orderBy(contractTemplatesTable.name),
    db.select({
      id: agentsTable.id,
      firstName: agentsTable.firstName,
      lastName: agentsTable.lastName,
      companyName: agentsTable.companyName,
    }).from(agentsTable)
      .where(and(...parentConditions))
      .orderBy(agentsTable.firstName),
  ]);
  const languages = Array.from(
    new Set(templates.map(t => (t.language ?? "").trim()).filter(Boolean)),
  ).sort();
  return {
    languages,
    contractTemplates: templates,
    parentAgents: parents.map(p => ({
      id: p.id,
      name: `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim(),
      company: p.companyName,
    })),
  };
}

router.post("/agents/export", requireAuth, requireRole(...MANAGER_ROLES), json({ limit: "64kb" }), async (req, res): Promise<void> => {
  const { ids } = (req.body || {}) as { ids?: unknown };
  const visible = await getVisibleBranchIds(req.user!.id, req.user!.role, req.user!);
  const conditions: SQL[] = [isNull(agentsTable.deletedAt)];
  if (visible !== null) {
    conditions.push(visible.length === 0
      ? sql`false`
      : sql`${agentsTable.id} IN (SELECT agent_id FROM agent_branches WHERE branch_id = ANY(${visible}))`);
  }
  if (Array.isArray(ids) && ids.length > 0) {
    const numericIds = ids.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0);
    if (numericIds.length === 0) { res.status(400).json({ error: "ids must be a non-empty array of positive integers" }); return; }
    conditions.push(inArray(agentsTable.id, numericIds));
  }
  const rows = await db.select().from(agentsTable).where(and(...conditions)).orderBy(agentsTable.firstName);
  const catalog = await loadAgentCatalog(visible);
  const buf = await buildWorkbookBuffer({
    sheets: [
      { name: "Agents", columns: agentColumns(catalog), rows: agentExportRows(rows as Array<Record<string, unknown>>) },
      ...buildAgentReferenceSheets(catalog),
    ],
    meta: { kind: AGENTS_KIND, version: "1", exportedAt: new Date().toISOString() },
  });
  await logAudit(req.user!.id, "export_agents", "agent", undefined, { count: rows.length }, req.ip);
  res.setHeader("Content-Type", XLSX_CONTENT_TYPE);
  res.setHeader("Content-Disposition", `attachment; filename="agents-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.send(buf);
});

router.get("/agents/template", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const visible = await getVisibleBranchIds(req.user!.id, req.user!.role, req.user!);
  const catalog = await loadAgentCatalog(visible);
  const exampleRows = [
    {
      firstName: "EXAMPLE — delete this row",
      lastName: "Agent",
      email: "agent@example.com",
      phone: "+15551234567",
      status: "active",
      entityType: "company",
      companyName: "Example Agency Ltd",
      country: "Turkey",
      city: "Istanbul",
      preferredContractLanguage: catalog.languages[0] ?? "en",
      commissionRate: 10,
      hideServiceFees: false,
      canManageStaff: true,
    },
  ];
  const buf = await buildWorkbookBuffer({
    sheets: [
      { name: "Agents", columns: agentColumns(catalog), rows: exampleRows as Array<Record<string, unknown>> },
      ...buildAgentReferenceSheets(catalog),
    ],
    meta: { kind: AGENTS_KIND, version: "1", exportedAt: new Date().toISOString() },
  });
  res.setHeader("Content-Type", XLSX_CONTENT_TYPE);
  res.setHeader("Content-Disposition", `attachment; filename="agents-template.xlsx"`);
  res.send(buf);
});

router.post(
  "/agents/import",
  requireAuth,
  requireRole(...MANAGER_ROLES),
  raw({ type: XLSX_CONTENT_TYPE, limit: "2mb" }),
  async (req, res): Promise<void> => {
    const conflict: ConflictStrategy = isValidConflictStrategy(req.query.conflict) ? req.query.conflict : "skip";
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "Upload an .xlsx file with Content-Type " + XLSX_CONTENT_TYPE });
      return;
    }
    const columns = agentColumns();
    let parsed;
    try {
      parsed = await parseWorkbookBuffer(req.body, { expectedKind: AGENTS_KIND }, { Agents: columns });
    } catch (err) {
      const e = err as ImportValidationError;
      res.status(e.status || 400).json({ error: e.message });
      return;
    }
    const rawItems = parsed.sheets.get("Agents")?.rows ?? [];
    const summary = emptySummary(rawItems.length);

    // Caller's visible branches (null = super_admin, sees all). Used to (a)
    // restrict which existing agents an import may match/overwrite, and (b)
    // assign a default branch link so created agents appear in scoped lists —
    // mirroring POST /agents.
    const visible = await getVisibleBranchIds(req.user!.id, req.user!.role, req.user!);
    const defaultBranchIds: number[] = visible && visible.length > 0 ? [visible[0]] : [];
    const scopeSql = visible !== null
      ? (visible.length === 0
          ? sql`false`
          : sql`${agentsTable.id} IN (SELECT agent_id FROM agent_branches WHERE branch_id = ANY(${visible}))`)
      : null;

    async function linkDefaultBranches(agentId: number): Promise<void> {
      if (defaultBranchIds.length === 0) return;
      await db.insert(agentBranchesTable)
        .values(defaultBranchIds.map(bid => ({ agentId, branchId: bid })))
        .onConflictDoNothing();
    }

    for (let i = 0; i < rawItems.length; i++) {
      const item = rawItems[i];
      // Surface a human-friendly identifier in the per-row result.
      const label = typeof item.email === "string" && item.email.trim()
        ? item.email.trim()
        : `${typeof item.firstName === "string" ? item.firstName : ""} ${typeof item.lastName === "string" ? item.lastName : ""}`.trim() || null;
      try {
        const values = toAgentInsertValues(item);

        // Validate optional foreign keys so we never persist dangling refs.
        // Parent agent must be within the caller's scope.
        if (values.parentAgentId) {
          if (!(await isAgentInScope(req.user!.id, req.user!.role, values.parentAgentId as number))) {
            throw new Error(`Parent agent ID ${values.parentAgentId} not found or out of scope`);
          }
        }
        // Contract template must exist, be active and not deleted (matches the
        // reference sheet shown in the template/export workbook).
        if (values.assignedContractTemplateId) {
          const [tpl] = await db.select({ id: contractTemplatesTable.id }).from(contractTemplatesTable)
            .where(and(
              eq(contractTemplatesTable.id, values.assignedContractTemplateId as number),
              eq(contractTemplatesTable.isActive, true),
              isNull(contractTemplatesTable.deletedAt),
            ));
          if (!tpl) throw new Error(`Contract template ID ${values.assignedContractTemplateId} not found, inactive, or deleted`);
        }

        const insertValues: any = {
          ...values,
          phoneE164: toE164((values.phone as string | null) ?? null),
          embedToken: crypto.randomUUID(),
        };

        const email = values.email as string | null;
        // Match existing agents by EXACT case-insensitive email, restricted to
        // the caller's visible branches. Exact equality (not ILIKE) prevents
        // wildcard characters in the cell from matching unintended rows. Rows
        // without an email can never conflict, so they are always created.
        const matchConditions: SQL[] = [
          sql`lower(${agentsTable.email}) = lower(${email})`,
          isNull(agentsTable.deletedAt),
        ];
        if (scopeSql) matchConditions.push(scopeSql);
        const existing = email
          ? (await db.select().from(agentsTable).where(and(...matchConditions)).orderBy(agentsTable.id))[0]
          : undefined;

        if (existing) {
          if (conflict === "skip") {
            tallyResult(summary, { index: i, slug: label, status: "skipped" });
            continue;
          }
          if (conflict === "overwrite") {
            const { embedToken, ...updateValues } = insertValues;
            await db.update(agentsTable).set(updateValues).where(eq(agentsTable.id, existing.id));
            await linkDefaultBranches(existing.id);
            tallyResult(summary, { index: i, slug: label, status: "updated" });
            continue;
          }
          // "rename" → import as a new record (duplicate email allowed; the
          // schema does not enforce email uniqueness).
          const [created] = await db.insert(agentsTable).values(insertValues).returning({ id: agentsTable.id });
          await linkDefaultBranches(created.id);
          tallyResult(summary, { index: i, slug: label, status: "renamed" });
          continue;
        }

        const [created] = await db.insert(agentsTable).values(insertValues).returning({ id: agentsTable.id });
        await linkDefaultBranches(created.id);
        tallyResult(summary, { index: i, slug: label, status: "created" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        tallyResult(summary, { index: i, slug: label, status: "error", error: msg });
      }
    }

    await logAudit(req.user!.id, "import_agents", "agent", undefined, {
      total: summary.total, created: summary.created, updated: summary.updated,
      renamed: summary.renamed, skipped: summary.skipped, errors: summary.errors, conflict,
    }, req.ip);
    res.json(summary);
  },
);

router.get("/agents/me", requireAuth, requireRole(...AGENT_ROLES), async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const userRole = req.user!.role;

  let agent;
  if (userRole === "agent_staff") {
    const [staffUser] = await db.select({ managingAgentId: usersTable.managingAgentId }).from(usersTable).where(eq(usersTable.id, userId));
    if (!staffUser?.managingAgentId) { res.status(404).json({ error: "Agent profile not found" }); return; }
    [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, staffUser.managingAgentId));
  } else {
    [agent] = await db.select().from(agentsTable).where(eq(agentsTable.userId, userId));
  }
  if (!agent) { res.status(404).json({ error: "Agent profile not found" }); return; }

  const assignedStaffList = await getAgencyStaffWithLegacy(agent.id, agent.assignedStaffId ?? null);
  const primaryEntry = assignedStaffList.find(s => s.isPrimary) || assignedStaffList[0] || null;
  const assignedStaff = primaryEntry ? {
    id: primaryEntry.userId,
    firstName: primaryEntry.firstName,
    lastName: primaryEntry.lastName,
    email: primaryEntry.email,
    phone: primaryEntry.phone,
    avatarUrl: primaryEntry.avatarUrl,
    role: primaryEntry.role,
  } : null;

  let parentAgent = null;
  if (userRole === "sub_agent" && agent.parentAgentId) {
    const [parentAgentRow] = await db.select().from(agentsTable).where(eq(agentsTable.id, agent.parentAgentId));
    if (parentAgentRow && parentAgentRow.userId) {
      const [parentUser] = await db.select({
        id: usersTable.id,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        email: usersTable.email,
        phone: usersTable.phone,
        avatarUrl: usersTable.avatarUrl,
        role: usersTable.role,
      }).from(usersTable).where(eq(usersTable.id, parentAgentRow.userId));
      if (parentUser) {
        parentAgent = {
          ...parentUser,
          companyName: parentAgentRow.companyName,
          logoUrl: parentAgentRow.logoUrl,
        };
      }
    }
  }

  // Effective commission rate: the rate the logged-in agent actually earns of a
  // university commission, used by Course Finder / PDF proposals to show an
  // estimate consistent with the value finance later books via
  // resolveAgentCommission. This MUST follow the same cascade + fallback rules:
  //   - Sub-agent with a valid parent: parentRate × subRate / 100 (multiplicative).
  //   - Parent / standalone agent: its own commissionRate.
  //   - Orphan parent (parentAgentId set but parent deleted) or self-reference:
  //     fall back to standalone (own rate), mirroring resolveAgentCommission.
  let effectiveCommissionRate: number | null = agent.commissionRate ?? null;
  if (agent.parentAgentId && agent.parentAgentId !== agent.id) {
    const [commissionParent] = await db.select().from(agentsTable).where(eq(agentsTable.id, agent.parentAgentId));
    if (commissionParent) {
      const parentRate = commissionParent.commissionRate ?? 0;
      const subRate = agent.commissionRate ?? 0;
      effectiveCommissionRate = (parentRate * subRate) / 100;
    }
  }

  // Effective service-fee visibility: the hideServiceFees flag is meant to
  // cascade DOWN the sub-agent tree. If any ancestor (the agent's parent, its
  // parent, and so on) has hideServiceFees = true, then the current agent must
  // also have service fees hidden — even when their OWN flag is false. Without
  // walking the chain, a grandparent's "hide" only affected its direct child,
  // letting deeper sub-agents still see the service fee. Walk up via
  // parentAgentId, OR-ing the flag, with a visited-set guard against cycles.
  let effectiveHideServiceFees = agent.hideServiceFees === true;
  if (!effectiveHideServiceFees) {
    const visited = new Set<number>([agent.id]);
    let ancestorId: number | null = agent.parentAgentId ?? null;
    while (ancestorId && !visited.has(ancestorId)) {
      visited.add(ancestorId);
      const [ancestor]: Array<{ hideServiceFees: boolean | null; parentAgentId: number | null }> =
        await db.select({ hideServiceFees: agentsTable.hideServiceFees, parentAgentId: agentsTable.parentAgentId })
          .from(agentsTable).where(eq(agentsTable.id, ancestorId));
      if (!ancestor) break;
      if (ancestor.hideServiceFees === true) { effectiveHideServiceFees = true; break; }
      ancestorId = ancestor.parentAgentId ?? null;
    }
  }

  // Resolve contractUrl at read time to the agent's NEWEST signed contract. The
  // stored agents.contractUrl is hydrated lazily on first PDF render and could be
  // locked to an earlier (possibly broken) contract when the agent later
  // re-signed via a resend. Falling back to the stored value preserves manually
  // set URLs and agents whose newest contract PDF has not rendered yet.
  let contractUrl = agent.contractUrl;
  try {
    const resolved = await getNewestSignedContractUrl(agent.id);
    if (resolved) contractUrl = resolved;
  } catch (err) {
    console.error(`[agents/me] failed to resolve newest contract url for agent ${agent.id}:`, err);
  }

  res.json({ ...agent, contractUrl, assignedStaff, assignedStaffList, parentAgent, effectiveCommissionRate, effectiveHideServiceFees });
});

router.patch("/agents/me", requireAuth, requireRole(...AGENT_ROLES), async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const userRole = (req.user as any).role as string;
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.userId, userId));
  if (!agent) { res.status(404).json({ error: "Agent profile not found" }); return; }
  if (userRole === "agent_staff" && req.body.businessName !== undefined) {
    res.status(403).json({ error: "Staff members cannot change the business name" });
    return;
  }
  const updates: Record<string, unknown> = {};
  for (const key of AGENT_SELF_PATCH_FIELDS) {
    if (req.body[key] !== undefined) {
      const val = req.body[key] || null;
      if ((key === "logoUrl" || key === "businessCertUrl") && val && !isValidStorageUrl(val)) {
        res.status(400).json({ error: `Invalid URL for ${key}` });
        return;
      }
      if (key === "businessName" && val && typeof val === "string" && val.length > 200) {
        res.status(400).json({ error: "Business name too long (max 200 characters)" });
        return;
      }
      updates[key] = val;
    }
  }
  if (Object.keys(updates).length === 0) {
    res.json(agent);
    return;
  }
  const [updated] = await db.update(agentsTable).set(updates).where(eq(agentsTable.id, agent.id)).returning();
  const changedFields: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(updates)) {
    const oldVal = (agent as Record<string, unknown>)[key];
    const newVal = updates[key];
    if (oldVal !== newVal) changedFields[key] = { from: oldVal ?? null, to: newVal ?? null };
  }
  if (Object.keys(changedFields).length > 0) {
    await writeAudit({
      userId,
      action: "agent_profile_field_changed",
      resource: "agent_profile",
      resourceId: agent.id,
      changes: changedFields,
      ipAddress: req.ip ?? null,
    });
    try {
      const agentName = `${agent.firstName ?? ""} ${agent.lastName ?? ""}`.trim() || agent.companyName || `Agent #${agent.id}`;
      await dispatchAgentProfileChangedNotif({
        agentId: agent.id,
        agentName,
        changedFields,
        actorUserId: userId,
        actionUrl: `/staff/agents/${agent.id}`,
      });
    } catch (err) {
      console.error("[agents/me] admin notification failed:", err);
    }
  }
  res.json(updated);
});

router.get("/agents/me/embed-token", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.userId, userId));
  if (!agent) { res.status(404).json({ error: "Agent profile not found" }); return; }
  if (!agent.embedToken) {
    const token = crypto.randomUUID();
    await db.update(agentsTable).set({ embedToken: token }).where(eq(agentsTable.id, agent.id));
    res.json({ embedToken: token });
    return;
  }
  res.json({ embedToken: agent.embedToken });
});

router.get("/agents/:agentId/embed-token", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const agentId = parseInt(String(req.params.agentId), 10);
  if (isNaN(agentId)) { res.status(400).json({ error: "Invalid agent id" }); return; }
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, agentId));
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
  if (!agent.embedToken) {
    const token = crypto.randomUUID();
    await db.update(agentsTable).set({ embedToken: token }).where(eq(agentsTable.id, agentId));
    res.json({ embedToken: token });
    return;
  }
  res.json({ embedToken: agent.embedToken });
});

router.get("/agents/me/sub-agents", requireAuth, requireRole("agent"), async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.userId, userId));
  if (!agent) { res.status(404).json({ error: "Agent profile not found" }); return; }

  const { search, status, page = "1", limit = "50" } = req.query as Record<string, string>;
  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const offset = (pageNum - 1) * limitNum;

  const conditions: SQL[] = [eq(agentsTable.parentAgentId, agent.id)];

  if (status && status !== "all") {
    conditions.push(eq(agentsTable.status, status));
  }
  if (search) {
    conditions.push(
      or(
        ilike(agentsTable.firstName, `%${search}%`),
        ilike(agentsTable.lastName, `%${search}%`),
        ilike(agentsTable.email, `%${search}%`),
        ilike(agentsTable.phone, `%${search}%`),
      )!
    );
  }

  const whereClause = and(...conditions);
  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(agentsTable).where(whereClause);

  const data = await db
    .select()
    .from(agentsTable)
    .where(whereClause)
    .limit(limitNum)
    .offset(offset)
    .orderBy(desc(agentsTable.createdAt));

  res.json({
    data,
    meta: { total: Number(count), page: pageNum, limit: limitNum, totalPages: Math.ceil(Number(count) / limitNum) },
  });
});

router.post("/agents/me/sub-agents", requireAuth, requireRole("agent"), async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const [parentAgent] = await db.select().from(agentsTable).where(eq(agentsTable.userId, userId));
  if (!parentAgent) { res.status(404).json({ error: "Agent profile not found" }); return; }

  const { firstName, lastName, email, phone, commissionRate, password, companyName, logoUrl, hideServiceFees } = req.body;
  if (!firstName || !lastName) {
    res.status(400).json({ error: "First name and last name are required" });
    return;
  }

  let newUserId: number | null = null;
  if (email) {
    const [existingUser] = await db.select().from(usersTable).where(eq(usersTable.email, email));
    if (existingUser) {
      res.status(400).json({ error: "A user with this email already exists" });
      return;
    }
    const userValues: any = { email, firstName, lastName, role: "sub_agent", phone: phone || null, phoneE164: toE164(phone || null), emailVerified: true };
    if (password) {
      const pwd = validatePassword(password);
      if (!pwd.ok) { res.status(400).json({ error: pwd.message }); return; }
      userValues.passwordHash = await bcrypt.hash(pwd.value, 10);
    }
    const [newUser] = await db.insert(usersTable).values(userValues).returning();
    newUserId = newUser.id;
  }

  const [subAgent] = await db.insert(agentsTable).values({
    userId: newUserId,
    parentAgentId: parentAgent.id,
    firstName,
    lastName,
    email: email || null,
    phone: phone || null,
    phoneE164: toE164(phone || null),
    commissionRate: commissionRate ? parseFloat(commissionRate) : (parentAgent.subAgentCommissionRate || null),
    status: "active",
    agencyCode: parentAgent.agencyCode || null,
    country: parentAgent.country || null,
    companyName: companyName || parentAgent.companyName || null,
    businessName: parentAgent.businessName || null,
    logoUrl: logoUrl || null,
    hideServiceFees: hideServiceFees === true,
    embedToken: crypto.randomUUID(),
  }).returning();

  try {
    await dispatchNotification({
      actorUserId: req.user!.id,
      event: "agent.sub_agent_added",
      title: "Sub-Agent Added",
      body: `A new sub-agent ${firstName} ${lastName} has been added.`,
      actionUrl: `/staff/agents`,
      icon: "UserPlus",
      templateVars: { firstName, lastName, email: email || "" },
    });
  } catch (err) {
    console.error("[AGENTS] sub_agent_added dispatch error:", err);
  }

  res.status(201).json(subAgent);
});

router.patch("/agents/me/sub-agents/:id", requireAuth, requireRole("agent"), async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const subAgentId = parseInt(String(req.params.id), 10);
  const [parentAgent] = await db.select().from(agentsTable).where(eq(agentsTable.userId, userId));
  if (!parentAgent) { res.status(404).json({ error: "Agent profile not found" }); return; }

  const [subAgent] = await db.select().from(agentsTable).where(and(eq(agentsTable.id, subAgentId), eq(agentsTable.parentAgentId, parentAgent.id)));
  if (!subAgent) { res.status(404).json({ error: "Sub-agent not found" }); return; }

  const allowed = ["firstName", "lastName", "email", "phone", "commissionRate", "status", "companyName", "logoUrl", "hideServiceFees", "canManageStaff"];
  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      if (key === "commissionRate") {
        updates[key] = req.body[key] !== null && req.body[key] !== "" ? parseFloat(req.body[key]) : null;
      } else if (key === "hideServiceFees" || key === "canManageStaff") {
        updates[key] = req.body[key] === true;
      } else {
        updates[key] = req.body[key] || null;
      }
    }
  }

  if (Object.keys(updates).length === 0) {
    res.json(subAgent);
    return;
  }

  if (Object.prototype.hasOwnProperty.call(updates, "phone")) {
    (updates as any).phoneE164 = toE164((updates as any).phone);
  }
  const [updated] = await db.update(agentsTable).set(updates).where(eq(agentsTable.id, subAgentId)).returning();
  if (subAgent.userId && (updates.firstName !== undefined || updates.lastName !== undefined || updates.email !== undefined || updates.phone !== undefined)) {
    const userUpdates: Record<string, unknown> = {};
    if (updates.firstName !== undefined) userUpdates.firstName = updates.firstName;
    if (updates.lastName !== undefined) userUpdates.lastName = updates.lastName;
    if (updates.email !== undefined) userUpdates.email = updates.email;
    if (updates.phone !== undefined) {
      userUpdates.phone = updates.phone;
      (userUpdates as any).phoneE164 = toE164((updates as any).phone);
    }
    if (Object.keys(userUpdates).length > 0) {
      await db.update(usersTable).set(userUpdates).where(eq(usersTable.id, subAgent.userId));
    }
  }

  const subAgentRateChanged = updates.commissionRate !== undefined && updates.commissionRate !== subAgent.commissionRate;
  if (subAgentRateChanged) {
    const newSubRate = updated.commissionRate ?? 0;
    const currentSeason = await getCurrentSeason();

    const subAgentComms = await db.select().from(commissionsTable)
      .where(and(
        eq(commissionsTable.subAgentId, subAgentId),
        eq(commissionsTable.season, currentSeason),
        sql`${commissionsTable.agentCommissionAmount} IS NOT NULL`,
        sql`CAST(${commissionsTable.agentCommissionAmount} AS numeric) > 0`
      ));

    let recalculated = 0;
    for (const comm of subAgentComms) {
      const agentAmount = parseFloat(String(comm.agentCommissionAmount ?? "0")) || 0;
      const subAmount = (agentAmount * newSubRate) / 100;
      await db.update(commissionsTable).set({
        subAgentCommissionRate: String(newSubRate),
        subAgentCommissionAmount: String(Math.round(subAmount * 100) / 100),
      }).where(eq(commissionsTable.id, comm.id));
      recalculated++;
    }

    if (recalculated > 0) {
      console.log(`[Commission Recalc] Sub-agent ${subAgentId} rate changed to ${newSubRate}% → recalculated ${recalculated} commission(s) for season ${currentSeason}`);
    }
  }

  res.json(updated);
});

router.delete("/agents/me/sub-agents/:id", requireAuth, requireRole("agent"), async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const subAgentId = parseInt(String(req.params.id), 10);
  const [parentAgent] = await db.select().from(agentsTable).where(eq(agentsTable.userId, userId));
  if (!parentAgent) { res.status(404).json({ error: "Agent profile not found" }); return; }

  const [subAgent] = await db.select().from(agentsTable).where(and(eq(agentsTable.id, subAgentId), eq(agentsTable.parentAgentId, parentAgent.id)));
  if (!subAgent) { res.status(404).json({ error: "Sub-agent not found" }); return; }

  if (subAgent.userId) {
    await db.delete(usersTable).where(eq(usersTable.id, subAgent.userId));
  }
  await db.delete(agentsTable).where(eq(agentsTable.id, subAgentId));
  res.json({ success: true });
});

router.post("/agents/me/sub-agents/:id/set-password", requireAuth, requireRole("agent"), async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const subAgentId = parseInt(String(req.params.id), 10);
  const [parentAgent] = await db.select().from(agentsTable).where(eq(agentsTable.userId, userId));
  if (!parentAgent) { res.status(404).json({ error: "Agent profile not found" }); return; }

  const [subAgent] = await db.select().from(agentsTable).where(and(eq(agentsTable.id, subAgentId), eq(agentsTable.parentAgentId, parentAgent.id)));
  if (!subAgent) { res.status(404).json({ error: "Sub-agent not found" }); return; }
  if (!subAgent.userId) { res.status(400).json({ error: "Sub-agent has no login account" }); return; }

  const { password } = req.body;
  const pwd = validatePassword(password);
  if (!pwd.ok) { res.status(400).json({ error: pwd.message }); return; }
  const hash = await bcrypt.hash(pwd.value, 10);
  await db.update(usersTable).set({ passwordHash: hash, passwordResetToken: null, passwordResetExpires: null }).where(eq(usersTable.id, subAgent.userId));
  await deleteSessionsForUser(subAgent.userId);
  res.json({ success: true });
});

router.patch("/agents/me/sub-agents/:id/status", requireAuth, requireRole("agent"), async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const subAgentId = parseInt(String(req.params.id), 10);
  const [parentAgent] = await db.select().from(agentsTable).where(eq(agentsTable.userId, userId));
  if (!parentAgent) { res.status(404).json({ error: "Agent profile not found" }); return; }

  const [subAgent] = await db.select().from(agentsTable).where(and(eq(agentsTable.id, subAgentId), eq(agentsTable.parentAgentId, parentAgent.id)));
  if (!subAgent) { res.status(404).json({ error: "Sub-agent not found" }); return; }

  const { status } = req.body;
  if (!["active", "inactive"].includes(status)) {
    res.status(400).json({ error: "Status must be 'active' or 'inactive'" });
    return;
  }
  const [updated] = await db.update(agentsTable).set({ status }).where(eq(agentsTable.id, subAgentId)).returning();
  if (subAgent.userId) {
    await db.update(usersTable).set({ isActive: status === "active" }).where(eq(usersTable.id, subAgent.userId));
  }
  res.json(updated);
});

router.post("/agents/me/sub-agents/:id/impersonate", requireAuth, requireRole("agent"), async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const subAgentId = parseInt(String(req.params.id), 10);
  const [parentAgent] = await db.select().from(agentsTable).where(eq(agentsTable.userId, userId));
  if (!parentAgent) { res.status(404).json({ error: "Agent profile not found" }); return; }

  const [subAgent] = await db.select().from(agentsTable).where(and(eq(agentsTable.id, subAgentId), eq(agentsTable.parentAgentId, parentAgent.id)));
  if (!subAgent) { res.status(404).json({ error: "Sub-agent not found" }); return; }
  if (!subAgent.userId) { res.status(400).json({ error: "Sub-agent has no login account" }); return; }

  if (subAgent.status !== "active") { res.status(400).json({ error: "Sub-agent account is deactivated" }); return; }

  const [targetUser] = await db.select().from(usersTable).where(eq(usersTable.id, subAgent.userId));
  if (!targetUser) { res.status(404).json({ error: "User not found" }); return; }

  const currentSid = req.cookies[SESSION_COOKIE];
  if (!currentSid) { res.status(400).json({ error: "Session cookie required for impersonation" }); return; }
  const currentSession = await getSession(currentSid);
  if (!currentSession || currentSession.originalSid) {
    logAudit(req.user!.id, "auth.impersonate.denied", "user", targetUser.id, {
      reason: currentSession ? "nested_impersonation" : "invalid_session",
      via: "agents/sub-agents",
    }, req.ip);
    res.status(403).json({ error: "Impersonation cannot be started from this session" });
    return;
  }
  if (!targetUser.isActive || targetUser.deletedAt != null) {
    logAudit(req.user!.id, "auth.impersonate.denied", "user", targetUser.id, {
      reason: "inactive_target",
      via: "agents/sub-agents",
    }, req.ip);
    res.status(403).json({ error: "Cannot impersonate an inactive account" });
    return;
  }

  const sessionData: SessionData = {
    user: {
      id: targetUser.id,
      replitId: targetUser.replitId || `impersonated-${targetUser.id}`,
      email: targetUser.email,
      firstName: targetUser.firstName,
      lastName: targetUser.lastName,
      role: targetUser.role,
      avatarUrl: targetUser.avatarUrl,
      language: targetUser.language,
      isActive: targetUser.isActive,
      emailVerified: targetUser.emailVerified,
    },
    access_token: `agent-impersonation-${Date.now()}`,
    originalSid: currentSid,
  };

  const sid = await createSession(sessionData);
  res.cookie(SESSION_COOKIE, sid, getSessionCookieOptions(req, SESSION_TTL));
  logAudit(req.user!.id, "auth.impersonate.start", "user", targetUser.id, { targetRole: targetUser.role, via: "agents/sub-agents" }, req.ip);
  res.json({ success: true, redirectTo: "/agent" });
});

router.post("/agents/me/return-to-agent", requireAuth, async (req, res): Promise<void> => {
  const currentSid = req.cookies[SESSION_COOKIE];
  if (!currentSid) { res.status(400).json({ error: "No active session" }); return; }

  const sessionData = await getSession(currentSid);
  if (!sessionData) { res.status(400).json({ error: "Invalid session" }); return; }

  const originalSid = sessionData.originalSid;
  if (!originalSid) { res.status(400).json({ error: "No parent session to return to" }); return; }

  const originalSession = await getSession(originalSid);
  if (!originalSession) { res.status(400).json({ error: "Original session expired. Please log in again." }); return; }

  await deleteSession(currentSid);

  res.cookie(SESSION_COOKIE, originalSid, getSessionCookieOptions(req, SESSION_TTL));
  const originalUserId = originalSession.user?.id ?? null;
  const impersonatedUserId = req.user?.id;
  logAudit(originalUserId, "auth.impersonate.end", "user", impersonatedUserId, {}, req.ip);
  res.json({ success: true, redirectTo: "/" });
});

const AGENT_STAFF_PERMISSIONS = PERM_KEYS.map(key => ({
  key,
  label: key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
}));

async function resolveManagingAgent(userId: number, userRole: string) {
  if (userRole === "agent" || userRole === "sub_agent") {
    const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.userId, userId));
    return agent || null;
  }
  if (userRole === "agent_staff") {
    const [staffUser] = await db.select({ managingAgentId: usersTable.managingAgentId }).from(usersTable).where(eq(usersTable.id, userId));
    if (!staffUser?.managingAgentId) return null;
    const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, staffUser.managingAgentId));
    return agent || null;
  }
  return null;
}

router.get("/agents/me/staff", requireAuth, requireRole("agent", "sub_agent"), async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const userRole = req.user!.role;
  const agent = await resolveManagingAgent(userId, userRole);
  if (!agent) { res.status(404).json({ error: "Agent profile not found" }); return; }
  const { search, page = "1", limit = "50" } = req.query as Record<string, string>;
  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const offset = (pageNum - 1) * limitNum;

  const conditions: SQL[] = [
    eq(usersTable.role, "agent_staff"),
    eq(usersTable.managingAgentId, agent.id),
  ];

  if (search) {
    conditions.push(
      or(
        ilike(usersTable.firstName, `%${search}%`),
        ilike(usersTable.lastName, `%${search}%`),
        ilike(usersTable.email, `%${search}%`),
      )!
    );
  }

  const whereClause = and(...conditions);
  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(usersTable).where(whereClause);

  const data = await db
    .select({
      id: usersTable.id,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      email: usersTable.email,
      phone: usersTable.phone,
      isActive: usersTable.isActive,
      agentStaffPermissions: usersTable.agentStaffPermissions,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(whereClause)
    .limit(limitNum)
    .offset(offset)
    .orderBy(desc(usersTable.createdAt));

  res.json({
    data,
    meta: { total: Number(count), page: pageNum, limit: limitNum, totalPages: Math.ceil(Number(count) / limitNum) },
  });
});

router.post("/agents/me/staff", requireAuth, requireRole("agent", "sub_agent"), async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const userRole = req.user!.role;
  const agent = await resolveManagingAgent(userId, userRole);
  if (!agent) { res.status(404).json({ error: "Agent profile not found" }); return; }

  const { firstName, lastName, email, phone, password, permissions } = req.body;
  if (!firstName || !lastName || !email) {
    res.status(400).json({ error: "First name, last name, and email are required" });
    return;
  }
  const pwdNew = validatePassword(password);
  if (!pwdNew.ok) { res.status(400).json({ error: pwdNew.message }); return; }

  const [existingUser] = await db.select().from(usersTable).where(eq(usersTable.email, email));
  if (existingUser) {
    res.status(400).json({ error: "A user with this email already exists" });
    return;
  }

  const validPerms = Array.isArray(permissions) 
    ? permissions.filter((p: string) => AGENT_STAFF_PERMISSIONS.some(asp => asp.key === p)) 
    : ["leads", "students", "applications", "documents", "course_finder"];

  const passwordHash = await bcrypt.hash(password, 10);
  const [newUser] = await db.insert(usersTable).values({
    email,
    firstName,
    lastName,
    phone: phone || null,
    phoneE164: toE164(phone || null),
    role: "agent_staff",
    passwordHash,
    managingAgentId: agent.id,
    agentStaffPermissions: validPerms,
    isActive: true,
    emailVerified: true,
  }).returning();

  res.status(201).json({
    id: newUser.id,
    firstName: newUser.firstName,
    lastName: newUser.lastName,
    email: newUser.email,
    phone: newUser.phone,
    isActive: newUser.isActive,
    agentStaffPermissions: newUser.agentStaffPermissions,
    createdAt: newUser.createdAt,
  });
});

router.patch("/agents/me/staff/:id", requireAuth, requireRole("agent", "sub_agent"), async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const userRole = req.user!.role;
  const staffId = parseInt(String(req.params.id), 10);
  const agent = await resolveManagingAgent(userId, userRole);
  if (!agent) { res.status(404).json({ error: "Agent profile not found" }); return; }

  const [staffUser] = await db.select().from(usersTable).where(
    and(eq(usersTable.id, staffId), eq(usersTable.role, "agent_staff"), eq(usersTable.managingAgentId, agent.id))
  );
  if (!staffUser) { res.status(404).json({ error: "Staff member not found" }); return; }

  const updates: Record<string, unknown> = {};
  if (req.body.firstName !== undefined) updates.firstName = req.body.firstName;
  if (req.body.lastName !== undefined) updates.lastName = req.body.lastName;
  if (req.body.phone !== undefined) {
    updates.phone = req.body.phone || null;
    (updates as any).phoneE164 = toE164(req.body.phone || null);
  }
  if (req.body.isActive !== undefined) updates.isActive = req.body.isActive;
  if (req.body.permissions !== undefined) {
    const validPerms = Array.isArray(req.body.permissions)
      ? req.body.permissions.filter((p: string) => AGENT_STAFF_PERMISSIONS.some(asp => asp.key === p))
      : [];
    updates.agentStaffPermissions = validPerms;
  }
  if (req.body.password) {
    const pwd = validatePassword(req.body.password);
    if (!pwd.ok) { res.status(400).json({ error: pwd.message }); return; }
    updates.passwordHash = await bcrypt.hash(pwd.value, 10);
  }

  if (Object.keys(updates).length === 0) {
    const { passwordHash: _ph, ...safeStaff } = staffUser;
    res.json(safeStaff);
    return;
  }

  const [updated] = await db.update(usersTable).set(updates).where(eq(usersTable.id, staffId)).returning();
  if (updates.passwordHash) {
    await deleteSessionsForUser(staffId);
  }
  res.json({
    id: updated.id,
    firstName: updated.firstName,
    lastName: updated.lastName,
    email: updated.email,
    phone: updated.phone,
    isActive: updated.isActive,
    agentStaffPermissions: updated.agentStaffPermissions,
    createdAt: updated.createdAt,
  });
});

router.delete("/agents/me/staff/:id", requireAuth, requireRole("agent", "sub_agent"), async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const userRole = req.user!.role;
  const staffId = parseInt(String(req.params.id), 10);
  const agent = await resolveManagingAgent(userId, userRole);
  if (!agent) { res.status(404).json({ error: "Agent profile not found" }); return; }

  const [staffUser] = await db.select().from(usersTable).where(
    and(eq(usersTable.id, staffId), eq(usersTable.role, "agent_staff"), eq(usersTable.managingAgentId, agent.id))
  );
  if (!staffUser) { res.status(404).json({ error: "Staff member not found" }); return; }

  await db.delete(usersTable).where(eq(usersTable.id, staffId));
  res.json({ success: true });
});

router.get("/agents/me/staff/permissions", requireAuth, requireRole("agent", "sub_agent"), async (_req, res): Promise<void> => {
  res.json(AGENT_STAFF_PERMISSIONS);
});

router.get("/agents", requireAuth, requireRole(...STAFF_ROLES), async (req, res): Promise<void> => {
  const { search, status, page = "1", limit = "50", type, country, branchId } = req.query as Record<string, string>;
  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const offset = (pageNum - 1) * limitNum;

  const conditions: SQL[] = [];

  // Branch scoping: super_admin sees all (or filtered by ?branchId=).
  // Other staff are restricted to agents linked to their visible branches.
  const visible = await getVisibleBranchIds(req.user!.id, req.user!.role, req.user!);
  const requestedBranchId = branchId && branchId !== "all" ? parseInt(branchId, 10) : null;
  if (visible !== null) {
    if (visible.length === 0) {
      res.json({ data: [], meta: { total: 0, page: pageNum, limit: limitNum, totalPages: 0 } });
      return;
    }
    // Bind each visible branch as a typed IN-list value. Passing the JS array
    // directly to ANY(${visible}) produced `ANY(($1))`, which node-postgres sent
    // as an untyped scalar and caused every branch-scoped agent search to 500.
    const visibleAgentIds = db
      .select({ id: agentBranchesTable.agentId })
      .from(agentBranchesTable)
      .where(inArray(agentBranchesTable.branchId, visible));
    conditions.push(inArray(agentsTable.id, visibleAgentIds));
  } else if (requestedBranchId && !isNaN(requestedBranchId)) {
    conditions.push(sql`${agentsTable.id} IN (SELECT agent_id FROM agent_branches WHERE branch_id = ${requestedBranchId})`);
  }

  if (type === "agent") {
    conditions.push(isNull(agentsTable.parentAgentId));
  } else if (type === "sub_agent") {
    conditions.push(isNotNull(agentsTable.parentAgentId));
  }

  if (status && status !== "all") {
    conditions.push(eq(agentsTable.status, status));
  }

  if (country && country !== "all") {
    conditions.push(eq(agentsTable.country, country));
  }

  if (search) {
    conditions.push(
      or(
        ilike(agentsTable.firstName, `%${search}%`),
        ilike(agentsTable.lastName, `%${search}%`),
        ilike(agentsTable.email, `%${search}%`),
        ilike(agentsTable.companyName, `%${search}%`),
        ilike(agentsTable.agencyCode, `%${search}%`),
        ilike(agentsTable.businessName, `%${search}%`),
      )!
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(agentsTable).where(whereClause);

  const rows = await db
    .select()
    .from(agentsTable)
    .where(whereClause)
    .limit(limitNum)
    .offset(offset)
    .orderBy(desc(agentsTable.createdAt));

  // Pull branch links and assigned-staff for the current page in one query each.
  const agentIds = rows.map(r => r.id);
  const branchLinks = agentIds.length > 0
    ? await db.select({ agentId: agentBranchesTable.agentId, branchId: agentBranchesTable.branchId })
        .from(agentBranchesTable).where(inArray(agentBranchesTable.agentId, agentIds))
    : [];
  const branchesByAgent = new Map<number, number[]>();
  for (const l of branchLinks) {
    const arr = branchesByAgent.get(l.agentId) || [];
    arr.push(l.branchId);
    branchesByAgent.set(l.agentId, arr);
  }
  const staffByAgent = await getAgencyStaffMap(agentIds);

  // Back-compat: agents whose join rows haven't been backfilled yet — resolve
  // legacy scalar to a synthetic primary entry in one batched user query.
  const legacyOnlyIds = new Map<number, number>();
  for (const r of rows) {
    if ((staffByAgent.get(r.id)?.length ?? 0) === 0 && r.assignedStaffId) {
      legacyOnlyIds.set(r.id, r.assignedStaffId);
    }
  }
  if (legacyOnlyIds.size > 0) {
    const legacyUsers = await db.select({
      id: usersTable.id,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      email: usersTable.email,
      phone: usersTable.phone,
      avatarUrl: usersTable.avatarUrl,
      role: usersTable.role,
    }).from(usersTable).where(inArray(usersTable.id, Array.from(new Set(legacyOnlyIds.values()))));
    const userMap = new Map(legacyUsers.map(u => [u.id, u]));
    for (const [agentId, uid] of legacyOnlyIds) {
      const u = userMap.get(uid);
      if (u) staffByAgent.set(agentId, [{
        userId: u.id, isPrimary: true,
        firstName: u.firstName, lastName: u.lastName, email: u.email,
        phone: u.phone, avatarUrl: u.avatarUrl, role: u.role,
      }]);
    }
  }

  const data = rows.map(r => {
    const list = staffByAgent.get(r.id) || [];
    const primary = list.find(s => s.isPrimary) || list[0] || null;
    return {
      ...r,
      branchIds: branchesByAgent.get(r.id) || [],
      assignedStaffId: primary ? primary.userId : r.assignedStaffId,
      assignedStaffName: primary ? staffDisplayName(primary) : null,
      assignedStaffList: list,
    };
  });

  res.json({
    data,
    meta: {
      total: Number(count),
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(Number(count) / limitNum),
    },
  });
});

router.get("/agents/:id/sub-agents", requireAuth, requireRole(...STAFF_ROLES), async (req, res): Promise<void> => {
  const parentId = parseInt(String(req.params.id), 10);
  if (!(await isAgentInScope(req.user!.id, req.user!.role, parentId))) {
    res.status(403).json({ error: "Agent not in your branch scope" });
    return;
  }
  const { page = "1", limit = "50" } = req.query as Record<string, string>;
  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10)));
  const offset = (pageNum - 1) * limitNum;
  const subs = await db.select().from(agentsTable).where(eq(agentsTable.parentAgentId, parentId)).orderBy(desc(agentsTable.createdAt)).limit(limitNum).offset(offset);
  // Attach academyAccess from users table (single batch lookup)
  const userIds = subs.map(s => s.userId).filter((id): id is number => id != null);
  const userMap = new Map<number, boolean | null>();
  if (userIds.length > 0) {
    const rows = await db.select({ id: usersTable.id, role: usersTable.role, permissionOverrides: usersTable.permissionOverrides }).from(usersTable).where(inArray(usersTable.id, userIds));
    for (const r of rows) {
      const overrides = (r.permissionOverrides as Record<string, boolean> | null) ?? {};
      const roleDefault = ((DEFAULT_ROLE_PERMISSIONS as Record<string, string[]>)[r.role] ?? []).includes("academy.access");
      userMap.set(r.id, "academy.access" in overrides ? overrides["academy.access"] : roleDefault);
    }
  }
  res.json(subs.map(s => ({ ...s, academyAccess: s.userId != null ? (userMap.get(s.userId) ?? null) : null })));
});

// PATCH /agents/:id/academy-access — süper admin (herkes için) veya agent (sadece kendi sub_agent'ı için)
router.patch("/agents/:id/academy-access", requireAuth, async (req, res): Promise<void> => {
  const agentId = parseInt(String(req.params.id), 10);
  if (Number.isNaN(agentId)) { res.status(400).json({ error: "Invalid agent id" }); return; }
  const parsed = z.object({ academyAccess: z.boolean() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid body" }); return; }
  const actor = req.user!;
  const [targetAgent] = await db
    .select({ id: agentsTable.id, userId: agentsTable.userId, parentAgentId: agentsTable.parentAgentId })
    .from(agentsTable)
    .where(and(eq(agentsTable.id, agentId), isNull(agentsTable.deletedAt)));
  if (!targetAgent) { res.status(404).json({ error: "Agent not found" }); return; }
  if (!targetAgent.userId) { res.status(404).json({ error: "Agent has no user account" }); return; }
  const isStaffActor = (STAFF_ROLES as readonly string[]).includes(actor.role);
  if (!isStaffActor) {
    if (actor.role !== "agent") { res.status(403).json({ error: "Forbidden" }); return; }
    const [actingAgent] = await db.select({ id: agentsTable.id }).from(agentsTable).where(and(eq(agentsTable.userId, actor.id), isNull(agentsTable.deletedAt)));
    if (!actingAgent || targetAgent.parentAgentId !== actingAgent.id) { res.status(403).json({ error: "Not your sub-agent" }); return; }
  } else if (!(await isAgentInScope(actor.id, actor.role, agentId))) {
    res.status(403).json({ error: "Agent not in your branch scope" }); return;
  }
  const [uRow] = await db.select({ role: usersTable.role }).from(usersTable).where(eq(usersTable.id, targetAgent.userId));
  const roleDefault = ((DEFAULT_ROLE_PERMISSIONS as Record<string, string[]>)[uRow?.role ?? ""] ?? []).includes("academy.access");
  if (parsed.data.academyAccess === roleDefault) {
    await db.execute(sql`UPDATE users SET permission_overrides = COALESCE(permission_overrides, '{}'::jsonb) - 'academy.access' WHERE id = ${targetAgent.userId}`);
  } else {
    await db.execute(sql`UPDATE users SET permission_overrides = COALESCE(permission_overrides, '{}'::jsonb) || ${JSON.stringify({ "academy.access": parsed.data.academyAccess })}::jsonb WHERE id = ${targetAgent.userId}`);
  }
  logAudit(actor.id, "agent.academy_access.update", "agent", agentId, { academyAccess: parsed.data.academyAccess }, req.ip);
  res.json({ success: true });
});

router.post("/agents", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const {
    firstName, lastName, status = "active", email, phone,
    companyName, country, commissionRate, agencyCode,
    state, city, address, businessName, category,
    logoUrl, agentIdProofUrl, businessCertUrl, contractUrl, branch,
    parentAgentId, subAgentCommissionRate, hideServiceFees,
    assignedStaffId, branchIds,
    entityType, taxNumber, preferredContractLanguage,
    assignedContractTemplateId,
    contractStartDate, contractEndDate, notes,
  } = req.body;

  const parseDate = (v: unknown): Date | null => {
    if (v === null || v === undefined || v === "") return null;
    if (v instanceof Date) return v;
    const d = new Date(String(v));
    return isNaN(d.getTime()) ? null : d;
  };

  if (!firstName || !lastName) {
    res.status(400).json({ error: "firstName and lastName are required" });
    return;
  }

  // A contract template is OPTIONAL. When one is selected, the agent is
  // auto-assigned an admin-driven onboarding signing session and must sign.
  // When omitted, no contract/signing session is created and the agent can use
  // the system without signing.
  const ent = entityType === "individual" ? "individual" : "company";
  const tplId = assignedContractTemplateId ? parseInt(String(assignedContractTemplateId), 10) : null;
  // A provided-but-unparseable id is a malformed request, not a "no contract"
  // choice — reject it rather than silently dropping the contract.
  if (assignedContractTemplateId && (tplId === null || isNaN(tplId))) {
    res.status(400).json({ error: "assignedContractTemplateId is invalid" });
    return;
  }
  let template: typeof contractTemplatesTable.$inferSelect | null = null;
  let templateBrandingSnapshot: ContractBrandingConfig | null = null;
  if (tplId && !isNaN(tplId)) {
    const [tpl] = await db.select().from(contractTemplatesTable).where(and(
      eq(contractTemplatesTable.id, tplId),
      isNull(contractTemplatesTable.deletedAt),
      eq(contractTemplatesTable.isActive, true),
    ));
    if (!tpl) {
      res.status(404).json({ error: "Selected contract template not found or inactive" });
      return;
    }
    template = tpl;
    // Validate template language/entityType match the agent metadata when provided.
    if (template.entityType !== ent) {
      res.status(400).json({ error: `Template entityType (${template.entityType}) does not match agent entityType (${ent})` });
      return;
    }
    if (preferredContractLanguage && template.language !== preferredContractLanguage) {
      res.status(400).json({ error: `Template language (${template.language}) does not match agent preferredContractLanguage (${preferredContractLanguage})` });
      return;
    }
    templateBrandingSnapshot = await resolveContractTemplateBranding(template);
    if (!hasContractCompanySignature(templateBrandingSnapshot)) {
      res.status(409).json({
        error: "Selected contract template has no official company signature. Configure one in Contract Brand Profiles before creating the agent.",
      });
      return;
    }
  }
  if (!email) {
    res.status(400).json({ error: "Email is required to send onboarding verification" });
    return;
  }
  // Normalize at the source: the email_verification_codes row created below
  // uses the lowercase address, and the public verify-with-link endpoint
  // resolves the user via that same address. Storing the user with mixed
  // case here was the root cause of "Invalid or expired link" — the code
  // was created lowercase, but the user lookup later compared lowercase
  // against the original case and missed the row. Use a case-insensitive
  // lookup as well so legacy mixed-case rows are still matched.
  const normalizedAccountEmail = String(email).toLowerCase().trim();

  // Auto-generate a login password for the new agent. The account is
  // provisioned active + email-verified immediately (no 6-digit code step);
  // the agent receives these credentials by email and signs in directly,
  // then is guided to sign their contract. They can change the password
  // later from their own panel.
  const generatedPassword = generateAgentPassword();
  const generatedPasswordHash = await bcrypt.hash(generatedPassword, 10);

  let userId: number | null = null;
  {
    const [existingUser] = await db.select().from(usersTable).where(ilike(usersTable.email, normalizedAccountEmail));
    if (existingUser) {
      // Only reuse an existing account when it already belongs to the agent
      // family. Refuse to take over (and silently reset the password of) an
      // internal/staff/student account that merely shares this email — doing
      // so would let agent creation reset credentials and reactivate
      // unrelated accounts.
      if (!AGENT_ROLES.includes(existingUser.role)) {
        res.status(409).json({ error: "An account with this email already exists and is not an agent account. Use a different email." });
        return;
      }
      userId = existingUser.id;
      // Provision the existing agent account for direct login: normalize the
      // stored address, mark email verified + active, and (re)set a fresh
      // password so the credentials email is valid.
      await db.update(usersTable)
        .set({ email: normalizedAccountEmail, emailVerified: true, isActive: true, passwordHash: generatedPasswordHash })
        .where(eq(usersTable.id, existingUser.id));
    } else {
      const role = parentAgentId ? "sub_agent" : "agent";
      const [newUser] = await db.insert(usersTable).values({
        email: normalizedAccountEmail, firstName, lastName, role,
        phone: phone || null, phoneE164: toE164(phone || null),
        emailVerified: true, isActive: true, passwordHash: generatedPasswordHash,
      }).returning();
      userId = newUser.id;
    }
  }

  const [agent] = await db.insert(agentsTable).values({
    userId,
    firstName, lastName, status,
    entityType: ent,
    taxNumber: taxNumber || null,
    preferredContractLanguage: preferredContractLanguage || template?.language || "en",
    assignedContractTemplateId: template?.id ?? null,
    email: email || null,
    phone: phone || null,
    phoneE164: toE164(phone || null),
    companyName: companyName || null,
    country: country || null,
    commissionRate: commissionRate ? parseFloat(commissionRate) : null,
    agencyCode: agencyCode || null,
    state: state || null,
    city: city || null,
    address: address || null,
    businessName: businessName || null,
    category: category || null,
    logoUrl: logoUrl || null,
    agentIdProofUrl: agentIdProofUrl || null,
    businessCertUrl: businessCertUrl || null,
    contractUrl: contractUrl || null,
    contractStartDate: parseDate(contractStartDate),
    contractEndDate: parseDate(contractEndDate),
    notes: notes || null,
    branch: branch || null,
    parentAgentId: parentAgentId ? parseInt(parentAgentId, 10) : null,
    subAgentCommissionRate: subAgentCommissionRate ? parseFloat(subAgentCommissionRate) : null,
    hideServiceFees: hideServiceFees === true || hideServiceFees === "true" ? true : false,
    embedToken: crypto.randomUUID(),
  }).returning();

  // Persist agency-assigned staff (multi). Accepts either the new
  // `assignedStaff: [{userId, isPrimary}]` array or the legacy single
  // `assignedStaffId` (treated as the primary contact).
  {
    const staff = parseStaffInput(
      req.body.assignedStaff,
      assignedStaffId ? parseInt(String(assignedStaffId), 10) : null,
    );
    if (staff.length > 0) await setAgencyStaff(agent.id, staff);
  }

  // Branch links: explicit list, else inherit creator's first visible branch.
  let finalBranchIds: number[] = Array.isArray(branchIds)
    ? branchIds.map((x: any) => parseInt(x, 10)).filter((n: number) => !isNaN(n))
    : [];
  // Authorization: non-super_admin may only assign visible branches.
  if (req.user!.role !== "super_admin" && finalBranchIds.length > 0) {
    const visible = await getVisibleBranchIds(req.user!.id, req.user!.role, req.user!);
    const allowed = new Set(visible || []);
    const bad = finalBranchIds.filter(b => !allowed.has(b));
    if (bad.length > 0) {
      res.status(403).json({ error: "Cannot assign branches outside your scope", branches: bad });
      return;
    }
  }
  if (finalBranchIds.length === 0) {
    const visible = await getVisibleBranchIds(req.user!.id, req.user!.role, req.user!);
    if (visible && visible.length > 0) finalBranchIds = [visible[0]];
  }
  if (finalBranchIds.length > 0) {
    await db.insert(agentBranchesTable)
      .values(finalBranchIds.map(bid => ({ agentId: agent.id, branchId: bid })))
      .onConflictDoNothing();
  }

  // ── Onboarding: credentials email + admin-driven signing session ──
  try {
    const normalizedEmail = normalizedAccountEmail;
    // Invalidate any stale verification codes for this address (legacy flow).
    await db.update(emailVerificationCodesTable)
      .set({ used: true })
      .where(and(eq(emailVerificationCodesTable.email, normalizedEmail), eq(emailVerificationCodesTable.used, false)));

    try {
      const emailContent = await buildAgentCredentialsEmail({
        firstName,
        email: normalizedEmail,
        password: generatedPassword,
        loginUrl: `${getAppBaseUrl()}/login`,
        hasContract: !!template,
      });
      await sendEmail(normalizedEmail, emailContent);
    } catch (err) {
      console.error("[agents POST] failed to send credentials email:", err);
    }
    await writeAudit({
      userId: req.user!.id,
      action: "agent.credentials_sent",
      resource: "user",
      resourceId: userId,
      changes: { agentId: agent.id, initial: true },
      ipAddress: req.ip,
    });

    // Only open an admin-driven signing session when a contract template was
    // selected. With no template the agent has no onboarding contract and is
    // granted full portal access immediately (no signing gate).
    if (template) {
      const [s] = await db.select({ days: settingsTable.defaultSigningDeadlineDays }).from(settingsTable);
      const days = Math.max(1, Math.min(365, s?.days || 14));
      const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      const { tokenHash } = createSigningToken();
      const signerName = `${firstName} ${lastName}`.trim() || businessName || null;
      // Start at the intake ("Your Details") step when the template defines an
      // intake schema; otherwise jump straight to review.
      const hasIntake = Array.isArray(template.intakeSchema) && (template.intakeSchema as any[]).length > 0;
      const [session] = await db.insert(signingSessionsTable).values({
        templateId: template.id,
        templateVersionSnapshot: template.version,
        templateNameSnapshot: template.name,
        templateLanguageSnapshot: template.language,
        templateEntityTypeSnapshot: template.entityType,
        templateBodyHtmlSnapshot: template.bodyHtml,
        templateIntakeSchemaSnapshot: template.intakeSchema,
        templateSigningPageConfigSnapshot: templateBrandingSnapshot,
        agentId: agent.id,
        tokenHash,
        mode: "admin_driven",
        status: hasIntake ? "intake_pending" : "review_pending",
        intakeData: null,
        signerEmail: normalizedEmail,
        signerName,
        expiresAt,
        isPrimaryOnboarding: true,
        createdByUserId: req.user!.id,
      }).returning();
      await writeAudit({
        userId: req.user!.id,
        action: "agent.contract_auto_assigned",
        resource: "signing_session",
        resourceId: session.id,
        changes: { agentId: agent.id, templateId: template.id, expiresAt: expiresAt.toISOString(), days },
        ipAddress: req.ip,
      });
    }
  } catch (err) {
    console.error("[agents POST] onboarding setup failed:", err);
  }

  dispatchNotification({
    actorUserId: req.user!.id,
    event: "agent.new_registration",
    title: "New Agent Registration",
    body: `A new agent ${firstName} ${lastName} (${companyName || "N/A"}) has been registered.`,
    actionUrl: `/staff/agents/${agent.id}`,
    icon: "Building",
    templateVars: { firstName, lastName, companyName: companyName || "", email: email || "" },
  }).catch(() => {});

  res.status(201).json(agent);
});

router.get("/agents/:id", requireAuth, requireRole(...STAFF_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, id));
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
  if (!(await isAgentInScope(req.user!.id, req.user!.role, id))) {
    res.status(403).json({ error: "Agent not in your branch scope" });
    return;
  }
  const links = await db.select({ branchId: agentBranchesTable.branchId }).from(agentBranchesTable).where(eq(agentBranchesTable.agentId, id));
  const assignedStaffList = await getAgencyStaffWithLegacy(id, agent.assignedStaffId ?? null);
  const primary = assignedStaffList.find(s => s.isPrimary) || assignedStaffList[0] || null;
  // Include academyAccess computed from permissionOverrides + role default
  let academyAccess: boolean | null = null;
  if (agent.userId) {
    const [uRow] = await db.select({ role: usersTable.role, permissionOverrides: usersTable.permissionOverrides }).from(usersTable).where(eq(usersTable.id, agent.userId));
    if (uRow) {
      const overrides = (uRow.permissionOverrides as Record<string, boolean> | null) ?? {};
      const roleDefault = ((DEFAULT_ROLE_PERMISSIONS as Record<string, string[]>)[uRow.role] ?? []).includes("academy.access");
      academyAccess = "academy.access" in overrides ? overrides["academy.access"] : roleDefault;
    }
  }
  res.json({
    ...agent,
    academyAccess,
    branchIds: links.map(l => l.branchId),
    assignedStaffList,
    assignedStaffName: primary ? staffDisplayName(primary) : null,
  });
});

router.patch("/agents/:id", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!(await isAgentInScope(req.user!.id, req.user!.role, id))) {
    res.status(403).json({ error: "Agent not in your branch scope" });
    return;
  }
  const updates: Record<string, unknown> = {};
  for (const key of AGENT_PATCH_FIELDS) {
    if (req.body[key] !== undefined) {
      if (key === "commissionRate" || key === "subAgentCommissionRate") {
        updates[key] = req.body[key] !== null && req.body[key] !== "" ? parseFloat(req.body[key]) : null;
      } else if (key === "hideServiceFees" || key === "canManageStaff") {
        updates[key] = req.body[key] === true || req.body[key] === "true";
      } else if (key === "parentAgentId") {
        updates[key] = req.body[key] ? parseInt(req.body[key], 10) : null;
      } else if (key === "assignedStaffId") {
        // Handled out-of-band by setAgencyStaff below to keep the
        // agency_assigned_staff join table in sync.
      } else if (key === "contractStartDate" || key === "contractEndDate") {
        const v = req.body[key];
        if (v === null || v === "" || v === undefined) {
          updates[key] = null;
        } else if (v instanceof Date) {
          updates[key] = v;
        } else {
          const d = new Date(String(v));
          updates[key] = isNaN(d.getTime()) ? null : d;
        }
      } else {
        updates[key] = req.body[key];
      }
    }
  }
  const hasStaffUpdate = req.body.assignedStaff !== undefined || req.body.assignedStaffId !== undefined;
  if (Object.keys(updates).length === 0 && req.body.branchIds === undefined && !hasStaffUpdate) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
  }
  if (Object.prototype.hasOwnProperty.call(updates, "phone")) {
    (updates as any).phoneE164 = toE164((updates as any).phone);
  }
  const [oldAgent] = await db.select().from(agentsTable).where(eq(agentsTable.id, id));
  if (!oldAgent) { res.status(404).json({ error: "Agent not found" }); return; }

  // branchIds is a separate concern (join table), handle it before/after the agent update.
  if (req.body.branchIds !== undefined && Array.isArray(req.body.branchIds)) {
    const newIds: number[] = req.body.branchIds
      .map((x: any) => parseInt(x, 10))
      .filter((n: number) => !isNaN(n));
    // Authorization: non-super_admin may only assign visible branches.
    if (req.user!.role !== "super_admin" && newIds.length > 0) {
      const visible = await getVisibleBranchIds(req.user!.id, req.user!.role, req.user!);
      const allowed = new Set(visible || []);
      const bad = newIds.filter(b => !allowed.has(b));
      if (bad.length > 0) {
        res.status(403).json({ error: "Cannot assign branches outside your scope", branches: bad });
        return;
      }
    }
    await db.delete(agentBranchesTable).where(eq(agentBranchesTable.agentId, id));
    if (newIds.length > 0) {
      await db.insert(agentBranchesTable)
        .values(newIds.map(bid => ({ agentId: id, branchId: bid })))
        .onConflictDoNothing();
    }
  }

  // No regular fields? Return early.
  let agent = oldAgent;
  if (Object.keys(updates).length > 0) {
    [agent] = await db.update(agentsTable).set(updates).where(eq(agentsTable.id, id)).returning();
  }
  if (hasStaffUpdate) {
    const staff = parseStaffInput(
      req.body.assignedStaff,
      req.body.assignedStaffId === null || req.body.assignedStaffId === undefined || req.body.assignedStaffId === ""
        ? null
        : parseInt(String(req.body.assignedStaffId), 10),
    );
    await setAgencyStaff(id, staff);
    [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, id));
  }
  if (oldAgent.userId && Object.prototype.hasOwnProperty.call(updates, "phone")) {
    await db.update(usersTable).set({
      phone: (updates as any).phone,
      phoneE164: (updates as any).phoneE164,
    }).where(eq(usersTable.id, oldAgent.userId));
  }

  const commissionRateChanged = updates.commissionRate !== undefined && updates.commissionRate !== oldAgent.commissionRate;
  if (commissionRateChanged) {
    const newRate = agent.commissionRate ?? 0;
    const currentSeason = await getCurrentSeason();

    const agentComms = await db.select().from(commissionsTable)
      .where(and(
        eq(commissionsTable.agentId, id),
        eq(commissionsTable.season, currentSeason),
        sql`${commissionsTable.universityCommissionAmount} IS NOT NULL`,
        sql`CAST(${commissionsTable.universityCommissionAmount} AS numeric) > 0`
      ));

    let recalculated = 0;
    for (const comm of agentComms) {
      const uAmount = parseFloat(String(comm.universityCommissionAmount ?? "0")) || 0;
      const agentAmount = (uAmount * newRate) / 100;
      const commUpdates: Record<string, unknown> = {
        agentCommissionRate: String(newRate),
        agentCommissionAmount: String(Math.round(agentAmount * 100) / 100),
      };

      if (comm.subAgentId) {
        const [subAgent] = await db.select().from(agentsTable).where(eq(agentsTable.id, comm.subAgentId));
        if (subAgent && subAgent.commissionRate) {
          const subAmount = (agentAmount * subAgent.commissionRate) / 100;
          commUpdates.subAgentCommissionRate = String(subAgent.commissionRate);
          commUpdates.subAgentCommissionAmount = String(Math.round(subAmount * 100) / 100);
        }
      }

      await db.update(commissionsTable).set(commUpdates).where(eq(commissionsTable.id, comm.id));
      recalculated++;
    }

    if (recalculated > 0) {
      console.log(`[Commission Recalc] Agent ${id} rate changed to ${newRate}% → recalculated ${recalculated} commission(s) for season ${currentSeason}`);
    }
  }

  const auditChanges: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(updates)) {
    const oldVal = (oldAgent as Record<string, unknown>)[key];
    const newVal = (agent as Record<string, unknown>)[key];
    if (String(oldVal ?? "") !== String(newVal ?? "")) {
      auditChanges[key] = { from: oldVal ?? null, to: newVal ?? null };
    }
  }
  if (req.body.branchIds !== undefined) {
    auditChanges["branchIds"] = { from: null, to: Array.isArray(req.body.branchIds) ? req.body.branchIds.join(",") : String(req.body.branchIds) };
  }
  if (hasStaffUpdate) {
    auditChanges["assignedStaff"] = { from: null, to: String(req.body.assignedStaff ?? req.body.assignedStaffId ?? null) };
  }
  if (Object.keys(auditChanges).length > 0) {
    await writeAudit({
      userId: req.user!.id,
      action: "agent_profile_field_changed",
      resource: "agent_profile",
      resourceId: id,
      changes: auditChanges,
      ipAddress: req.ip ?? null,
    });
  }

  res.json(agent);
});

/**
 * Delete login users together with their agent profiles, clearing the foreign
 * keys that would otherwise block the `users` delete. Most user references use
 * ON DELETE SET NULL / CASCADE, but a handful do not and would throw a 23503
 * FK violation:
 *   - conversations.createdById, messages.senderId, broadcasts.sentById,
 *     messageTemplates.createdById  → nullable, no ON DELETE rule → set NULL
 *   - notes.authorId, applicationStageDocuments.uploadedBy → NOT NULL +
 *     ON DELETE RESTRICT → reassign authorship/upload to the acting admin so
 *     the content (notes, uploaded application documents) is preserved.
 * Runs inside the caller's transaction so agent + user removal is atomic and a
 * mid-way FK error can no longer leave the agent deleted while the user lingers
 * (the partial state behind the "error but it deleted anyway" report).
 */
async function clearUserReferencesAndDelete(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userIds: number[],
  actingUserId: number,
): Promise<void> {
  if (userIds.length === 0) return;
  await tx.update(conversationsTable).set({ createdById: null }).where(inArray(conversationsTable.createdById, userIds));
  await tx.update(messagesTable).set({ senderId: null }).where(inArray(messagesTable.senderId, userIds));
  await tx.update(broadcastsTable).set({ sentById: null }).where(inArray(broadcastsTable.sentById, userIds));
  await tx.update(messageTemplatesTable).set({ createdById: null }).where(inArray(messageTemplatesTable.createdById, userIds));
  await tx.update(notesTable).set({ authorId: actingUserId }).where(inArray(notesTable.authorId, userIds));
  await tx.update(applicationStageDocumentsTable).set({ uploadedBy: actingUserId }).where(inArray(applicationStageDocumentsTable.uploadedBy, userIds));
  await tx.delete(usersTable).where(inArray(usersTable.id, userIds));
}

router.delete("/agents/:id", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!(await isAgentInScope(req.user!.id, req.user!.role, id))) {
    res.status(403).json({ error: "Agent not in your branch scope" });
    return;
  }
  // Match the parent-deletes-sub-agent path (line ~325): when an agent has a
  // linked login user, remove that user too. Without this the admin "Delete
  // agent" action left an orphan `users` row with role=agent and no profile,
  // diverging from the sub-agent delete behaviour. Wrapped in a transaction so
  // the agent row and its user are removed atomically.
  const deletedAgent = await db.transaction(async (tx) => {
    const [agent] = await tx.delete(agentsTable).where(eq(agentsTable.id, id)).returning();
    if (!agent) return null;
    if (agent.userId) {
      await clearUserReferencesAndDelete(tx, [agent.userId], req.user!.id);
    }
    return agent;
  });
  if (!deletedAgent) { res.status(404).json({ error: "Agent not found" }); return; }
  res.json({ success: true });
});

router.post("/agents/bulk-delete", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "ids array is required" });
    return;
  }
  const numIds = ids.map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id));
  if (numIds.length === 0) {
    res.status(400).json({ error: "No valid IDs provided" });
    return;
  }
  // Branch-scope enforcement: silently skip out-of-scope agent IDs (matches bulk-assign behaviour).
  const scoped: number[] = [];
  for (const aid of numIds) {
    if (await isAgentInScope(req.user!.id, req.user!.role, aid)) scoped.push(aid);
  }
  if (scoped.length === 0) {
    res.json({ success: true, count: 0, skipped: numIds.length });
    return;
  }
  const deleted = await db.transaction(async (tx) => {
    const rows = await tx.delete(agentsTable).where(inArray(agentsTable.id, scoped)).returning();
    // Same cascade as the single-delete handler above — keep `users` and
    // `agents` in sync (and clear blocking FKs) so admin bulk-delete doesn't
    // leave orphan login rows or 500 on a dependent record.
    const userIdsToRemove = rows.map(a => a.userId).filter((u): u is number => u !== null && u !== undefined);
    await clearUserReferencesAndDelete(tx, userIdsToRemove, req.user!.id);
    return rows;
  });
  res.json({ success: true, count: deleted.length, skipped: numIds.length - deleted.length });
});

router.post("/agents/bulk-assign", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const { ids, assignedStaffId } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "ids array is required" });
    return;
  }
  const numIds = ids.map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id));
  if (numIds.length === 0) {
    res.status(400).json({ error: "No valid IDs provided" });
    return;
  }
  const staffVal = assignedStaffId === null || assignedStaffId === undefined ? null : parseInt(assignedStaffId, 10);
  const newStaff = staffVal && !isNaN(staffVal) ? [{ userId: staffVal, isPrimary: true }] : [];
  // Branch-scope enforcement: silently skip out-of-scope agent IDs.
  const scoped: number[] = [];
  for (const aid of numIds) {
    if (await isAgentInScope(req.user!.id, req.user!.role, aid)) scoped.push(aid);
  }
  for (const aid of scoped) await setAgencyStaff(aid, newStaff);
  res.json({ success: true, count: scoped.length, skipped: numIds.length - scoped.length });
});

router.patch("/agents/:id/status", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const { status } = req.body;
  if (!status || !["active", "inactive"].includes(status)) {
    res.status(400).json({ error: "status must be 'active' or 'inactive'" });
    return;
  }
  if (!await isAgentInScope(req.user!.id, req.user!.role, id)) {
    res.status(403).json({ error: "Unauthorised action: Agent is not within your branch scope." });
    return;
  }
  const [agent] = await db.update(agentsTable).set({ status }).where(eq(agentsTable.id, id)).returning();
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
  res.json(agent);
});

router.post("/agents/:id/set-password", requireAuth, async (req, res, next): Promise<void> => {
  // `/agents/me/set-password` belongs to the agent self-service onboarding
  // router (agentOnboarding.ts). Express matches this `:id` route first
  // because agentsRouter is mounted earlier; without skipping "me" here
  // we'd hit requireRole(MANAGER_ROLES) for the agent (403) or, for an
  // admin who somehow lands on this URL, run `parseInt("me") = NaN`
  // through a `agents.id = NaN` query and crash with a 500.
  if (req.params.id === "me") { next(); return; }
  // Inline the manager-role check now that requireRole is no longer in the
  // chain (we needed an async wrapper to call next() above).
  if (!req.user || !MANAGER_ROLES.includes(req.user.role)) {
    res.status(403).json({ error: "Unauthorised action: Only an administrator can perform this action." });
    return;
  }
  const id = parseInt(String(req.params.id), 10);
  const { password } = req.body;
  const pwd = validatePassword(password);
  if (!pwd.ok) { res.status(400).json({ error: pwd.message }); return; }
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, id));
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
  if (!await isAgentInScope(req.user!.id, req.user!.role, id)) {
    res.status(403).json({ error: "Unauthorised action: Agent is not within your branch scope." });
    return;
  }
  if (!agent.userId) {
    res.status(400).json({ error: "Agent has no linked user account" });
    return;
  }
  const hash = await bcrypt.hash(password, 10);
  await db.update(usersTable).set({ passwordHash: hash, passwordResetToken: null, passwordResetExpires: null }).where(eq(usersTable.id, agent.userId));
  await deleteSessionsForUser(agent.userId);
  res.json({ success: true });
});

router.post("/agents/:id/resend-credentials", requireAuth, async (req, res, next): Promise<void> => {
  if (req.params.id === "me") { next(); return; }
  if (!req.user || !MANAGER_ROLES.includes(req.user.role)) {
    res.status(403).json({ error: "Unauthorised action: Only an administrator can perform this action." });
    return;
  }
  const id = parseInt(String(req.params.id), 10);
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, id));
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
  if (!await isAgentInScope(req.user!.id, req.user!.role, id)) {
    res.status(403).json({ error: "Unauthorised action: Agent is not within your branch scope." });
    return;
  }

  const newPassword = generateAgentPassword();
  const newHash = await bcrypt.hash(newPassword, 10);

  let resolvedUserId: number;
  let resolvedEmail: string;

  if (!agent.userId) {
    // Agent was created via bulk import and has no linked user account yet.
    // Provision one now using the same pattern as manual agent creation:
    // create or reuse an existing agent-role user, mark email verified + active,
    // link it to the agent row, and send credentials by email.
    const agentEmail = agent.email?.toLowerCase().trim();
    if (!agentEmail) {
      res.status(400).json({ error: "Agent has no email on file; cannot provision credentials" });
      return;
    }
    const [existingUser] = await db.select().from(usersTable).where(ilike(usersTable.email, agentEmail));
    let newUserId: number;
    if (existingUser) {
      if (!AGENT_ROLES.includes(existingUser.role)) {
        res.status(409).json({ error: "An account with this email already exists and is not an agent account" });
        return;
      }
      await db.update(usersTable)
        .set({ email: agentEmail, emailVerified: true, isActive: true, passwordHash: newHash, passwordResetToken: null, passwordResetExpires: null })
        .where(eq(usersTable.id, existingUser.id));
      newUserId = existingUser.id;
    } else {
      const role = "agent";
      const [created] = await db.insert(usersTable).values({
        email: agentEmail,
        firstName: agent.firstName,
        lastName: agent.lastName || "",
        role,
        emailVerified: true,
        isActive: true,
        passwordHash: newHash,
      }).returning({ id: usersTable.id });
      newUserId = created.id;
    }
    await db.update(agentsTable).set({ userId: newUserId }).where(eq(agentsTable.id, agent.id));
    resolvedUserId = newUserId;
    resolvedEmail = agentEmail;
  } else {
    const [user] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, agent.userId));
    if (!user?.email) { res.status(404).json({ error: "Agent user account not found" }); return; }
    await db.update(usersTable)
      .set({ passwordHash: newHash, passwordResetToken: null, passwordResetExpires: null })
      .where(eq(usersTable.id, agent.userId));
    resolvedUserId = agent.userId;
    resolvedEmail = user.email;
  }

  let emailSent = false;
  try {
    const emailContent = await buildAgentCredentialsEmail({
      firstName: agent.firstName,
      email: resolvedEmail,
      password: newPassword,
      loginUrl: `${getAppBaseUrl()}/login`,
      hasContract: !!agent.assignedContractTemplateId,
    });
    await sendEmail(resolvedEmail, emailContent);
    emailSent = true;
  } catch (err) {
    console.error("[agents resend-credentials] failed to send email:", err);
  }

  await writeAudit({
    userId: req.user!.id,
    action: "agent.credentials_sent",
    resource: "user",
    resourceId: resolvedUserId,
    changes: { agentId: id, initial: !agent.userId, resent: !!agent.userId, emailSent },
    ipAddress: req.ip,
  });

  res.json({ success: true, emailSent });
});

router.post("/agents/:id/impersonate", requireAuth, async (req, res, next): Promise<void> => {
  // Same defence as /agents/:id/set-password above — never let "me" fall
  // through to a `parseInt("me") = NaN` agents lookup. No agentOnboarding
  // counterpart today, so we 404 instead of next()'ing.
  if (req.params.id === "me") { res.status(404).json({ error: "Not found" }); return; }
  if (!req.user || !MANAGER_ROLES.includes(req.user.role)) {
    res.status(403).json({ error: "Unauthorised action: Only an administrator can perform this action." });
    return;
  }
  const id = parseInt(String(req.params.id), 10);
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, id));
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
  if (!await isAgentInScope(req.user!.id, req.user!.role, id)) {
    res.status(403).json({ error: "Unauthorised action: Agent is not within your branch scope." });
    return;
  }
  if (!agent.userId) {
    res.status(400).json({ error: "Agent has no linked user account" });
    return;
  }
  const [targetUser] = await db.select().from(usersTable).where(eq(usersTable.id, agent.userId));
  if (!targetUser) { res.status(404).json({ error: "User not found" }); return; }
  if (!["agent", "sub_agent"].includes(targetUser.role)) {
    res.status(403).json({ error: "Can only impersonate agent or sub-agent accounts" });
    return;
  }

  const currentSid = req.cookies[SESSION_COOKIE];
  if (!currentSid) { res.status(400).json({ error: "Session cookie required for impersonation" }); return; }
  const currentSession = await getSession(currentSid);
  if (!currentSession || currentSession.originalSid) {
    logAudit(req.user!.id, "auth.impersonate.denied", "user", targetUser.id, {
      reason: currentSession ? "nested_impersonation" : "invalid_session",
      via: "agents",
    }, req.ip);
    res.status(403).json({ error: "Impersonation cannot be started from this session" });
    return;
  }
  if (!targetUser.isActive || targetUser.deletedAt != null) {
    logAudit(req.user!.id, "auth.impersonate.denied", "user", targetUser.id, {
      reason: "inactive_target",
      via: "agents",
    }, req.ip);
    res.status(403).json({ error: "Cannot impersonate an inactive account" });
    return;
  }

  const sessionData: SessionData = {
    user: {
      id: targetUser.id,
      replitId: targetUser.replitId || `impersonated-${targetUser.id}`,
      email: targetUser.email,
      firstName: targetUser.firstName,
      lastName: targetUser.lastName,
      role: targetUser.role,
      avatarUrl: targetUser.avatarUrl,
      language: targetUser.language,
      isActive: targetUser.isActive,
      emailVerified: targetUser.emailVerified,
    },
    access_token: `impersonation-${Date.now()}`,
    originalSid: currentSid,
  };

  const sid = await createSession(sessionData);
  res.cookie(SESSION_COOKIE, sid, getSessionCookieOptions(req, SESSION_TTL));
  logAudit(req.user!.id, "auth.impersonate.start", "user", targetUser.id, { targetRole: targetUser.role, via: "agents" }, req.ip);
  res.json({ success: true, redirectTo: "/agent" });
});

export default router;
