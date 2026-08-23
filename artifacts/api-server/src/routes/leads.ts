import { Router, type IRouter } from "express";
import { db, leadsTable, studentsTable, notesTable, usersTable, followUpsTable, agentsTable, documentsTable, embedSubmissionsTable, embedWidgetsTable, applicationsTable, programsTable, universitiesTable, pipelineStagesTable, settingsTable, softDelete, externalContactsTable, channelAccountsTable, lifecycleCascadeStateTable } from "@workspace/db";
import { eq, ilike, or, sql, and, lt, lte, gte, asc, desc, inArray, isNull, isNotNull, ne } from "drizzle-orm";
import { requireAuth, requireRole, requireAgentStaffPermission, logAudit } from "../lib/auth";
import { publicLeadLimiter } from "../lib/limiters";
import { STAFF_ROLES, ADMIN_ROLES, AGENT_ROLES, isAgentRole } from "../lib/roles";
import { getAgentVisibleIds, getAgentRecord } from "../lib/agentVisibility";
import { isAgentSourcedAndBlockedForStaff } from "../lib/rbac/agentSourceScope";
import { assertCanAccessStudent } from "../lib/studentAccess";
import { getAssignmentVisibility, getEffectivePermissionSet, canAccessAssignedRecord, userHasPermission } from "../lib/permissions";
import { getVisibleBranchIds, resolveCreateBranchId, isInBranchScope } from "../lib/branchScope";
import { normalizeAndValidateNames, normalizePhoneField, toLatinUpper } from "../lib/textNormalize";
import { dispatchNotification } from "../lib/notificationDispatcher";
import { inferOriginFromUser, inferOriginFromAgentId, directOrigin, type OriginMeta } from "../lib/originHelper";
import { toE164 } from "../lib/inbox/phone";
import { rejectInvalidPhone } from "../lib/phoneValidation";
import { getCurrentSeason } from "../lib/season";
import { enqueueOnStageChange, maybeEnqueuePortalSubmission } from "../lib/portalAutoTrigger.js";
import { applyLeadAssignmentRules, cascadeLeadAssignment } from "../lib/leadAssignment";
import { findOrUpsertPublicLead } from "../lib/leadDedup";
import { recomputeStudentPhoto, studentHasServablePhotoSql } from "../lib/studentPhoto";
import { maybeTriggerAutoEducationExtractForStudent } from "../lib/educationAutoExtract";
import { parsePaginationParams, buildPageMeta } from "@workspace/pagination";
import { validateStudentDocumentFile, validateStudentDocumentBuffer, sanitizeFileName, isPdf } from "../lib/fileUploadValidation";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { buildDocNameFromParts } from "../lib/docNaming";
import { callerOwnsObject } from "../lib/objectAuthz";
import { checkMandatoryDocs, checkMandatoryDocsForStudent, reEvaluateMandatoryDocsForStudent } from "../lib/mandatoryDocs";
import { getDocLabel } from "../lib/docNaming";
import { recompressStoredObjectIfNeeded } from "../lib/documentBytes";
import { UploadTooLargeError } from "../lib/uploads/processUpload";
import { resolveResidenceAddress } from "../lib/studentAddressDefaults";
import { validatePassportNumber } from "@workspace/portal-adapters/identity-validation";
import { buildStableSignedStudentPhotoThumbnailPath } from "@workspace/portal-adapters";
import { recordRequestSpan } from "../lib/requestTelemetry";
import { buildFacetFilterInput, loadFacetValue } from "../lib/facetCache";
import { isFtcEmbedSource, trackFtcLeadStageChange } from "../lib/ga4LeadTracking";

const router: IRouter = Router();

const leadDocsObjectStorage = new ObjectStorageService();

function enqueueFtcLeadStageAnalytics(
  lead: typeof leadsTable.$inferSelect,
  previousStage: string,
  nextStageKey: string,
): void {
  if (!isFtcEmbedSource(lead.source) || previousStage === nextStageKey) return;
  void (async () => {
    const [stage] = await db.select({ key: pipelineStagesTable.key, variant: pipelineStagesTable.variant })
      .from(pipelineStagesTable)
      .where(and(eq(pipelineStagesTable.entityType, "lead"), eq(pipelineStagesTable.key, nextStageKey)))
      .limit(1);
    const result = await trackFtcLeadStageChange({
      lead: { ...lead, status: nextStageKey },
      previousStage,
      nextStage: stage || { key: nextStageKey, variant: null },
    });
    if (!result.sent && ["ga4_http_error", "ga4_network_error"].includes(result.reason || "")) {
      console.error(`[GA4] FTC lead stage event failed (${result.reason}, status=${result.status || "n/a"})`);
    }
  })().catch((error) => console.error("[GA4] FTC lead stage tracking failed:", error));
}

const LEAD_PATCH_FIELDS = [
  "firstName", "lastName", "email", "phone", "nationality",
  "motherName", "fatherName",
  "interestedProgram", "interestedUniversity", "interestedCountry", "source",
  "status", "assignedTo", "notes", "estimatedValue", "season", "agentId", "interestedLevel",
  "educationData",
];

function addDateRangeCondition(conditions: any[], column: any, range?: string): void {
  if (!range || range === "all") return;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (range === "today") conditions.push(and(gte(column, today), lt(column, tomorrow))!);
  else if (range === "yesterday") {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    conditions.push(and(gte(column, yesterday), lt(column, today))!);
  } else if (range === "last7") {
    const start = new Date(today);
    start.setDate(start.getDate() - 7);
    conditions.push(gte(column, start));
  } else if (range === "thisMonth") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    conditions.push(and(gte(column, start), lt(column, end))!);
  } else if (range === "thisYear") {
    const start = new Date(now.getFullYear(), 0, 1);
    const end = new Date(now.getFullYear() + 1, 0, 1);
    conditions.push(and(gte(column, start), lt(column, end))!);
  }
}

router.get("/leads/distinct-sources", requireAuth, requireRole(...STAFF_ROLES), async (_req, res): Promise<void> => {
  const [leadRows, widgetRows, accountRows] = await Promise.all([
    db
      .selectDistinct({ source: leadsTable.source })
      .from(leadsTable)
      .where(sql`${leadsTable.source} IS NOT NULL AND ${leadsTable.source} != ''`),
    db
      .select({ slug: embedWidgetsTable.slug, name: embedWidgetsTable.name, mode: embedWidgetsTable.mode })
      .from(embedWidgetsTable),
    db
      .select({
        id: channelAccountsTable.id,
        channel: channelAccountsTable.channel,
        displayName: channelAccountsTable.displayName,
        metadata: channelAccountsTable.metadata,
      })
      .from(channelAccountsTable)
      .where(eq(channelAccountsTable.isActive, true)),
  ]);
  type SourceItem = { value: string; label: string; kind: "connected_account" | "lead_form" | "embed" | "other" };
  const byValue = new Map<string, SourceItem>();
  const nonMessagingAccountChannels = new Set(["web_form", "embed", "internal"]);
  const channelLabels: Record<string, string> = {
    whatsapp: "WhatsApp",
    instagram: "Instagram",
    messenger: "Facebook / Messenger",
    facebook: "Facebook",
    telegram: "Telegram",
    sms: "SMS",
    email: "Email",
  };
  for (const account of accountRows) {
    const normalizedChannel = account.channel.trim().toLowerCase();
    // Forms and embeds have their own canonical entries below. Historical
    // channel_accounts rows for them would otherwise flood this list with
    // duplicate technical records that cannot receive/reply to messages.
    if (nonMessagingAccountChannels.has(normalizedChannel)) continue;
    const metadata = account.metadata && typeof account.metadata === "object"
      ? account.metadata as Record<string, unknown>
      : {};
    const label = typeof metadata.brandLabel === "string" && metadata.brandLabel.trim()
      ? metadata.brandLabel.trim()
      : account.displayName;
    const channelLabel = channelLabels[normalizedChannel] ??
      normalizedChannel.replace(/(^|[_-])(\w)/g, (_match, _separator, char: string) => ` ${char.toUpperCase()}`).trim();
    byValue.set(`channel-account:${account.id}`, {
      value: `channel-account:${account.id}`,
      label: `${channelLabel} — ${label}`,
      kind: "connected_account",
    });
  }
  for (const w of widgetRows) {
    if (!w.slug) continue;
    const value = `embed:${w.slug}`;
    const isLeadForm = w.mode === "lead_form";
    const prefix = isLeadForm ? "Web Form" : "Embed";
    byValue.set(value, {
      value,
      label: `${prefix}: ${w.name || w.slug}`,
      kind: isLeadForm ? "lead_form" : "embed",
    });
  }
  for (const r of leadRows) {
    const v = r.source;
    if (!v || byValue.has(v)) continue;
    byValue.set(v, { value: v, label: v, kind: "other" });
  }
  const order: Record<SourceItem["kind"], number> = { connected_account: 0, lead_form: 1, embed: 2, other: 3 };
  const data = [...byValue.values()].sort((a, b) => {
    const k = order[a.kind] - order[b.kind];
    return k !== 0 ? k : a.label.localeCompare(b.label, "tr");
  });
  res.json({ data });
});

router.get("/leads/distinct-cities", requireAuth, requireRole(...STAFF_ROLES), async (_req, res): Promise<void> => {
  const ur = await db
    .selectDistinct({ v: universitiesTable.city })
    .from(universitiesTable)
    .where(sql`${universitiesTable.city} IS NOT NULL AND ${universitiesTable.city} != ''`);
  const all = new Set<string>(ur.map(r => r.v!).filter(Boolean));
  res.json({ data: [...all].sort() });
});

router.get("/nationalities", requireAuth, requireRole(...STAFF_ROLES), async (_req, res): Promise<void> => {
  const leadNats = db
    .selectDistinct({ nationality: leadsTable.nationality })
    .from(leadsTable)
    .where(sql`${leadsTable.nationality} IS NOT NULL AND ${leadsTable.nationality} != ''`);
  const studentNats = db
    .selectDistinct({ nationality: studentsTable.nationality })
    .from(studentsTable)
    .where(sql`${studentsTable.nationality} IS NOT NULL AND ${studentsTable.nationality} != ''`);
  const [lr, sr] = await Promise.all([leadNats, studentNats]);
  const all = new Set([...lr.map(r => r.nationality!), ...sr.map(r => r.nationality!)]);
  res.json([...all].sort());
});

router.post("/public/lead", publicLeadLimiter, async (req, res): Promise<void> => {
  const { firstName, lastName, email, phone, nationality, interestedProgram, interestedUniversity, interestedCountry, message, sourcePageUrl, utmSource, utmMedium, utmCampaign, utmTerm, utmContent, source: bodySource } = req.body;
  if (!firstName || !lastName || !email || !phone) {
    res.status(400).json({ error: "firstName, lastName, email, and phone are required" });
    return;
  }
  const { error: nameErr, normalized: normLead } = normalizeAndValidateNames({ firstName, lastName }, ["firstName", "lastName"]);
  if (nameErr) { res.status(400).json({ error: nameErr }); return; }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    res.status(400).json({ error: "Invalid email address" });
    return;
  }
  if (rejectInvalidPhone(res, phone)) return;
  const origin = directOrigin();
  const phoneStr = phone ? normalizePhoneField(phone).slice(0, 30) : null;
  // Guard against cross-channel lead overwrite via untrusted body.source.
  // /public/lead now dedupes by (lower(email), source); accepting reserved
  // channel strings would let an unauthenticated caller update leads
  // belonging to embed widgets, agent web forms, or website builder forms.
  const rawSource = bodySource ? String(bodySource).slice(0, 100) : "website";
  const lcSource = rawSource.toLowerCase().trim();
  const isReservedSource =
    lcSource === "web_form" ||
    lcSource.startsWith("embed:") ||
    lcSource.startsWith("website-form:");
  const resolvedSource = isReservedSource ? "website" : rawSource;
  const { lead, created } = await findOrUpsertPublicLead({
    source: resolvedSource,
    uniqueKey: { kind: "emailSource" },
    fields: {
      firstName: String(normLead.firstName).slice(0, 100),
      lastName: String(normLead.lastName).slice(0, 100),
      email: String(email).slice(0, 255),
      phone: phoneStr,
      phoneE164: toE164(phoneStr),
      nationality: nationality ? String(nationality).slice(0, 100) : null,
      interestedProgram: interestedProgram ? String(interestedProgram).slice(0, 255) : null,
      interestedUniversity: interestedUniversity ? String(interestedUniversity).slice(0, 255) : null,
      interestedCountry: interestedCountry ? String(interestedCountry).slice(0, 100) : null,
      notes: message ? String(message).replace(/<[^>]*>/g, "").slice(0, 400) : null,
      sourcePageUrl: sourcePageUrl ? String(sourcePageUrl).slice(0, 500) : null,
      utmSource: utmSource ? String(utmSource).slice(0, 100) : null,
      utmMedium: utmMedium ? String(utmMedium).slice(0, 100) : null,
      utmCampaign: utmCampaign ? String(utmCampaign).slice(0, 100) : null,
      utmTerm: utmTerm ? String(utmTerm).slice(0, 100) : null,
      utmContent: utmContent ? String(utmContent).slice(0, 100) : null,
    },
    extras: {
      originType: origin.originType,
      originEntityType: origin.originEntityType,
      originEntityId: origin.originEntityId,
      originDisplayName: origin.originDisplayName,
    },
    ip: req.ip,
  });
  // SECURITY (Public Intake): only disclose the numeric lead ID for a lead
  // this request actually created. Returning the ID of an already-existing
  // (deduped) lead would let an unauthenticated caller recover the lead ID
  // for any known email and target it elsewhere. The apply endpoint no
  // longer trusts a client-supplied lead ID (it re-derives by email+source),
  // so suppressing the existing-lead ID here is safe.
  res.status(201).json({ success: true, message: "Inquiry submitted successfully", leadId: created ? lead.id : null });
});

router.post("/public/lead/:token", publicLeadLimiter, async (req, res): Promise<void> => {
  const token = String(req.params.token);
  const [agent] = await db.select({ id: agentsTable.id, status: agentsTable.status })
    .from(agentsTable).where(eq(agentsTable.embedToken, token));
  if (!agent || agent.status !== "active") {
    res.status(404).json({ error: "Invalid or inactive form" });
    return;
  }

  const { firstName, lastName, email, phone } = req.body;
  if (!firstName || !lastName || !email || !phone) {
    res.status(400).json({ error: "firstName, lastName, email, and phone are required" });
    return;
  }
  const { error: nameErr, normalized: normAgentLead } = normalizeAndValidateNames({ firstName, lastName }, ["firstName", "lastName"]);
  if (nameErr) { res.status(400).json({ error: nameErr }); return; }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    res.status(400).json({ error: "Invalid email address" });
    return;
  }

  if (rejectInvalidPhone(res, phone)) return;

  const origin = await inferOriginFromAgentId(agent.id);

  const phoneStr2 = normalizePhoneField(phone).slice(0, 30);
  await findOrUpsertPublicLead({
    source: "web_form",
    uniqueKey: { kind: "emailSourceAgent", agentId: agent.id },
    fields: {
      firstName: String(normAgentLead.firstName).slice(0, 100),
      lastName: String(normAgentLead.lastName).slice(0, 100),
      email: String(email).slice(0, 255),
      phone: phoneStr2,
      phoneE164: toE164(phoneStr2),
    },
    extras: {
      agentId: agent.id,
      originType: origin.originType,
      originEntityType: origin.originEntityType,
      originEntityId: origin.originEntityId,
      originDisplayName: origin.originDisplayName,
    },
    ip: req.ip,
  });

  const accept = req.headers.accept || "";
  if (accept.includes("application/json")) {
    res.status(201).json({ success: true, message: "Thank you! Your information has been submitted." });
  } else {
    res.status(200).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb}div{text-align:center;padding:40px;border-radius:12px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.1);max-width:400px}h2{color:#059669;margin:0 0 8px}p{color:#6b7280;margin:0}</style></head><body><div><h2>&#10003; Success!</h2><p>Thank you! Your information has been submitted successfully.</p></div></body></html>`);
  }
});

router.get("/leads", requireAuth, requireRole(...STAFF_ROLES, ...AGENT_ROLES), requireAgentStaffPermission("leads"), async (req, res): Promise<void> => {
  const user = req.user!;
  const query = req.query as Record<string, string>;
  const includeFacets = query.includeFacets !== "0";
  const {
    status, search, season, agentId: agentIdFilter, originType: originFilter,
    source, appSource, assignment, nationality, name, email, program, country,
    minValue, dateRange, followupRange, sortKey = "date", sortDir = "desc",
  } = query;
  const pageParams = parsePaginationParams(req, { defaultLimit: 20, maxLimit: 5000 });
  const pageNum = pageParams.page;
  const limitNum = pageParams.limit;
  const offset = pageParams.offset;

  const conditions = [isNull(leadsTable.deletedAt)];
  const scopeResolveStartedAt = process.hrtime.bigint();
  if (season) conditions.push(eq(leadsTable.season, season));

  const isNonAdminStaff = !isAgentRole(user.role)
    && !(ADMIN_ROLES as readonly string[]).includes(user.role);
  const staffPerms = isNonAdminStaff
    ? await getEffectivePermissionSet(user)
    : null;
  let agentVisibleIds: number[] | null = null;

  // KURAL 1: non-admin staff cannot see agent-sourced leads
  // unless they have records.view_others (Task #494)
  if (staffPerms) {
    if (!staffPerms.has("records.view_others")) {
      conditions.push(isNull(leadsTable.agentId));
    }
  }
  if (isAgentRole(user.role)) {
    agentVisibleIds = await getAgentVisibleIds(user.id, user.role);
    if (agentVisibleIds.length === 0) {
      res.json({ data: [], meta: { total: 0, page: pageNum, limit: limitNum, totalPages: 0 } });
      return;
    }
    conditions.push(inArray(leadsTable.agentId, agentVisibleIds));
  }
  // Branch scoping (super_admin: null = all). Applies to staff AND agents.
  // We include null-branch records: public-form leads (POST /public/lead,
  // embed widgets, course-finder apply popup step 1) are created without a
  // branch, so excluding nulls would hide every web inbox lead from
  // branch-scoped staff. Treat null-branch as "global / unassigned to a
  // branch — visible to any branch's staff so they can pick it up".
  const visibleBranchIds = await getVisibleBranchIds(user.id, user.role, user);
  if (visibleBranchIds !== null) {
    if (visibleBranchIds.length === 0) {
      conditions.push(isNull(leadsTable.branchId));
    } else {
      conditions.push(or(inArray(leadsTable.branchId, visibleBranchIds), isNull(leadsTable.branchId))!);
    }
  }
  const staffAssignmentVisibility = staffPerms
    ? getAssignmentVisibility(staffPerms)
    : null;
  if (staffPerms && staffAssignmentVisibility !== "all") {
    // Non-admin staff: visibility is driven by the records.* permission keys.
    // They always see their own records; records.view_unassigned adds the
    // unassigned pool; records.view_others adds records assigned to teammates.
    // Origin (direct vs agent vs sub_agent) is intentionally NOT a filter here.
    const orParts: any[] = staffAssignmentVisibility === "assigned"
      ? [isNotNull(leadsTable.assignedToId)]
      : [eq(leadsTable.assignedToId, user.id)];
    if (staffAssignmentVisibility === "own_or_unassigned") {
      orParts.push(isNull(leadsTable.assignedToId));
    }
    conditions.push(or(...orParts)!);
  }
  recordRequestSpan("scopeResolve", Number(process.hrtime.bigint() - scopeResolveStartedAt) / 1_000_000);
  const facetScope = {
    userId: user.id,
    role: user.role,
    permissions: staffPerms ? [...staffPerms].sort() : null,
    assignmentVisibility: staffAssignmentVisibility,
    visibleBranchIds: visibleBranchIds ? [...visibleBranchIds].sort((a, b) => a - b) : visibleBranchIds,
    agentVisibleIds: agentVisibleIds ? [...agentVisibleIds].sort((a, b) => a - b) : null,
  };

  if (search) {
    const rawTerm = search.trim();
    const translitTerm = toLatinUpper(rawTerm);
    const terms = Array.from(new Set([rawTerm, translitTerm].filter(Boolean)));
    const tokens = translitTerm.split(/\s+/).filter(Boolean);
    const orParts: any[] = [];
    for (const t of terms) {
      orParts.push(
        ilike(leadsTable.firstName, `%${t}%`),
        ilike(leadsTable.lastName, `%${t}%`),
        ilike(leadsTable.email, `%${t}%`),
        ilike(leadsTable.phone, `%${t}%`),
        sql`(coalesce(${leadsTable.firstName},'') || ' ' || coalesce(${leadsTable.lastName},'')) ILIKE ${'%' + t + '%'}`,
        sql`(coalesce(${leadsTable.lastName},'') || ' ' || coalesce(${leadsTable.firstName},'')) ILIKE ${'%' + t + '%'}`,
      );
    }
    if (tokens.length > 1) {
      // Çok-kelimeli aramada her token'ı KELİME SINIRINDA eşleştir.
      // Aksi halde "murat vural" araması "MURATL VURAL"ı da getirir.
      // Postgres `~*` + `\m...\M` word boundary; regex meta karakterleri escape.
      const esc = (s: string) => s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
      orParts.push(and(
        ...tokens.map((tok: string) => {
          const pat = `\\m${esc(tok)}\\M`;
          return or(
            sql`${leadsTable.firstName} ~* ${pat}`,
            sql`${leadsTable.lastName} ~* ${pat}`,
          )!;
        })
      )!);
    }
    conditions.push(or(...orParts)!);
  }

  if (status && status !== "all") conditions.push(eq(leadsTable.status, status));
  if (source && source !== "all") conditions.push(eq(leadsTable.source, source));
  if (agentIdFilter && agentIdFilter !== "all") {
    if (agentIdFilter === "none") conditions.push(isNull(leadsTable.agentId));
    else {
      const parsed = parseInt(agentIdFilter, 10);
      if (Number.isFinite(parsed)) conditions.push(eq(leadsTable.agentId, parsed));
    }
  }
  if (originFilter && originFilter !== "all" && ["direct", "agent", "sub_agent"].includes(originFilter)) {
    conditions.push(eq(leadsTable.originType, originFilter));
  }
  if (appSource === "agent") conditions.push(isNotNull(leadsTable.agentId));
  else if (appSource === "staff") conditions.push(isNull(leadsTable.agentId));
  if (assignment === "mine") conditions.push(eq(leadsTable.assignedToId, user.id));
  else if (assignment === "unassigned") conditions.push(isNull(leadsTable.assignedToId));
  else if (assignment === "mine_unassigned") {
    conditions.push(or(eq(leadsTable.assignedToId, user.id), isNull(leadsTable.assignedToId))!);
  } else if (assignment && assignment !== "all") {
    const parsed = parseInt(assignment, 10);
    if (Number.isFinite(parsed)) conditions.push(eq(leadsTable.assignedToId, parsed));
  }
  if (nationality && nationality !== "all") conditions.push(eq(leadsTable.nationality, nationality));
  if (name) {
    const term = `%${name.trim()}%`;
    conditions.push(or(
      ilike(leadsTable.firstName, term),
      ilike(leadsTable.lastName, term),
      sql`(coalesce(${leadsTable.firstName},'') || ' ' || coalesce(${leadsTable.lastName},'')) ILIKE ${term}`,
    )!);
  }
  if (email) conditions.push(ilike(leadsTable.email, `%${email.trim()}%`));
  if (program) conditions.push(ilike(leadsTable.interestedProgram, `%${program.trim()}%`));
  if (country) conditions.push(ilike(leadsTable.interestedCountry, `%${country.trim()}%`));
  if (minValue) {
    const parsed = Number(minValue);
    if (Number.isFinite(parsed)) {
      conditions.push(sql`CASE
        WHEN COALESCE(${leadsTable.estimatedValue}, '') ~ '^[+-]?[0-9]+([.][0-9]+)?$'
        THEN ${leadsTable.estimatedValue}::numeric
        ELSE 0
      END >= ${parsed}`);
    }
  }
  addDateRangeCondition(conditions, leadsTable.createdAt, dateRange);
  if (followupRange && followupRange !== "all") {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const nextWeek = new Date(today);
    nextWeek.setDate(nextWeek.getDate() + 7);
    const openFollowup = sql`EXISTS (
      SELECT 1 FROM ${followUpsTable}
      WHERE ${followUpsTable.leadId} = ${leadsTable.id}
        AND ${followUpsTable.completed} = false
    )`;
    if (followupRange === "none") {
      conditions.push(sql`NOT (${openFollowup})`);
    } else if (followupRange === "today") {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM ${followUpsTable}
        WHERE ${followUpsTable.leadId} = ${leadsTable.id}
          AND ${followUpsTable.completed} = false
          AND ${followUpsTable.scheduledAt} >= ${today}
          AND ${followUpsTable.scheduledAt} < ${tomorrow}
      )`);
    } else if (followupRange === "upcoming7") {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM ${followUpsTable}
        WHERE ${followUpsTable.leadId} = ${leadsTable.id}
          AND ${followUpsTable.completed} = false
          AND ${followUpsTable.scheduledAt} >= ${today}
          AND ${followUpsTable.scheduledAt} <= ${nextWeek}
      )`);
    } else if (followupRange === "overdue") {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM ${followUpsTable}
        WHERE ${followUpsTable.leadId} = ${leadsTable.id}
          AND ${followUpsTable.completed} = false
          AND ${followUpsTable.scheduledAt} < ${today}
      )`);
    }
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const sortColumns: Record<string, any> = {
    name: sql`lower(coalesce(${leadsTable.firstName}, '') || ' ' || coalesce(${leadsTable.lastName}, ''))`,
    email: leadsTable.email,
    status: leadsTable.status,
    source: leadsTable.source,
    program: leadsTable.interestedProgram,
    country: leadsTable.interestedCountry,
    value: sql`CASE
      WHEN COALESCE(${leadsTable.estimatedValue}, '') ~ '^[+-]?[0-9]+([.][0-9]+)?$'
      THEN ${leadsTable.estimatedValue}::numeric
      ELSE 0
    END`,
    date: leadsTable.createdAt,
  };
  const orderColumn = sortColumns[sortKey] || leadsTable.createdAt;
  const order = sortDir === "asc" ? asc(orderColumn) : desc(orderColumn);

  const facetRowsPromise = includeFacets
    ? loadFacetValue({
        namespace: "leads-list",
        scope: facetScope,
        filters: buildFacetFilterInput(query),
        load: async () => {
          const [statusRows, nationalityRows, agentRows] = await Promise.all([
            db.select({ status: leadsTable.status, count: sql<number>`count(*)` })
              .from(leadsTable).where(whereClause).groupBy(leadsTable.status),
            db.selectDistinct({ value: leadsTable.nationality })
              .from(leadsTable).where(and(whereClause, isNotNull(leadsTable.nationality))).orderBy(leadsTable.nationality),
            db.selectDistinct({ id: agentsTable.id, name: agentsTable.companyName })
              .from(leadsTable).innerJoin(agentsTable, eq(leadsTable.agentId, agentsTable.id))
              .where(whereClause).orderBy(agentsTable.companyName),
          ]);
          return { statusRows, nationalityRows, agentRows };
        },
      })
    : Promise.resolve({
        statusRows: [] as Array<{ status: string; count: number }>,
        nationalityRows: [] as Array<{ value: string | null }>,
        agentRows: [] as Array<{ id: number | null; name: string | null }>,
      });

  const [countRows, rows, facetRows] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(leadsTable).where(whereClause),
    db
    .select({
      lead: leadsTable,
      agentName: agentsTable.companyName,
      studentHasPhoto: studentHasServablePhotoSql(),
    })
    .from(leadsTable)
    .leftJoin(agentsTable, eq(leadsTable.agentId, agentsTable.id))
    .leftJoin(studentsTable, and(
      eq(leadsTable.convertedStudentId, studentsTable.id),
      isNull(studentsTable.deletedAt),
    ))
    .where(whereClause)
    .limit(limitNum)
    .offset(offset)
    .orderBy(order, desc(leadsTable.id)),
    facetRowsPromise,
  ]);
  const { statusRows, nationalityRows, agentRows } = facetRows;
  const count = countRows[0]?.count ?? 0;

  const leadIds = rows.map(r => r.lead.id);
  let nextFollowupMap = new Map<number, string>();
  if (leadIds.length > 0) {
    const fuRows = await db
      .select({
        leadId: followUpsTable.leadId,
        nextDate: sql<string>`min(${followUpsTable.scheduledAt})`,
      })
      .from(followUpsTable)
      .where(and(
        sql`${followUpsTable.leadId} IN (${sql.join(leadIds.map(id => sql`${id}`), sql`, `)})`,
        eq(followUpsTable.completed, false),
      ))
      .groupBy(followUpsTable.leadId);
    fuRows.forEach(r => { if (r.leadId) nextFollowupMap.set(r.leadId, r.nextDate); });
  }

  const data = rows.map(r => ({
    ...r.lead,
    agentName: r.agentName || null,
    nextFollowup: nextFollowupMap.get(r.lead.id) || null,
    convertedStudentHasPhoto: r.studentHasPhoto ?? false,
    convertedStudentPhotoUrl: r.studentHasPhoto && r.lead.convertedStudentId
      ? buildStableSignedStudentPhotoThumbnailPath(r.lead.convertedStudentId)
      : null,
  }));

  res.json({
    data,
    meta: {
      total: Number(count),
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(Number(count) / limitNum),
      ...(includeFacets ? {
        statusCounts: Object.fromEntries(statusRows.map((row) => [row.status, Number(row.count)])),
        facets: {
          nationalities: nationalityRows.map((row) => row.value).filter(Boolean),
          agents: agentRows.filter((row) => row.id != null && row.name).map((row) => ({ id: row.id, name: row.name })),
        },
      } : {}),
    },
  });
});

router.post("/leads", requireAuth, requireRole(...STAFF_ROLES, ...AGENT_ROLES), requireAgentStaffPermission("leads"), async (req, res): Promise<void> => {
  const user = req.user!;
  const { firstName, lastName, status = "new", email, phone, nationality, interestedProgram, interestedUniversity, interestedCountry, source, notes, assignedTo, season, agentId, interestedLevel, educationData } = req.body;
  if (!firstName || !lastName || !email || !phone) {
    res.status(400).json({ error: "firstName, lastName, email, and phone are required" });
    return;
  }
  const { error: nameErr, normalized: normBody } = normalizeAndValidateNames(
    { firstName, lastName }, ["firstName", "lastName"]
  );
  if (nameErr) { res.status(400).json({ error: nameErr }); return; }
  if (rejectInvalidPhone(res, phone)) return;
  const currentYear = await getCurrentSeason();
  let resolvedAgentId = agentId || null;
  if (isAgentRole(user.role)) {
    const agentRec = await getAgentRecord(user.id, user.role);
    resolvedAgentId = agentRec?.id || null;
  }
  const origin = resolvedAgentId
    ? await inferOriginFromAgentId(resolvedAgentId)
    : await inferOriginFromUser(user);
  const inheritedBranchId = await resolveCreateBranchId(user.id, user.role, req.body.branchId ?? null, user);
  if (inheritedBranchId == null && user.role !== "super_admin" && !isAgentRole(user.role)) {
    res.status(403).json({ error: "No accessible branch — cannot create lead" });
    return;
  }
  const [lead] = await db.insert(leadsTable).values({
    branchId: inheritedBranchId,
    firstName: normBody.firstName as string, lastName: normBody.lastName as string, status, email,
    phone: phone ? normalizePhoneField(phone) : phone, phoneE164: toE164(phone ? normalizePhoneField(phone) : phone),
    nationality: nationality || null,
    interestedProgram: interestedProgram || null,
    interestedUniversity: interestedUniversity || null,
    interestedCountry: interestedCountry || null,
    source: source || null, notes: notes || null,
    assignedToId: assignedTo || null,
    agentId: resolvedAgentId,
    season: season || currentYear,
    interestedLevel: interestedLevel || null,
    educationData: educationData && typeof educationData === "object" ? educationData : null,
    ...origin,
  }).returning();
  await applyLeadAssignmentRules(lead, req.ip);
  await logAudit(user.id, "create_lead", "lead", lead.id, {}, req.ip);

  // Sprint B: agent-sourced leads notify only admin roles (parity with Sprint A KURAL 1).
  // Direct leads broadcast to all roles defined in the notification rule (staff + consultant).
  const leadCreatedCtx: Parameters<typeof dispatchNotification>[0] = {
    actorUserId: req.user!.id,
    event: "lead.created",
    title: "New Lead Created",
    body: `${lead.firstName} ${lead.lastName} has been added as a new lead.`,
    actionUrl: `/staff/leads/${lead.id}`,
    icon: "UserPlus",
    templateVars: { firstName: lead.firstName, lastName: lead.lastName, email: lead.email || "", phone: lead.phone || "" },
  };
  if (lead.agentId != null) {
    const adminRows = await db.select({ id: usersTable.id })
      .from(usersTable)
      .where(and(inArray(usersTable.role, ADMIN_ROLES as string[]), eq(usersTable.isActive, true)));
    leadCreatedCtx.recipientUserIds = adminRows.map(u => u.id);
  }
  dispatchNotification(leadCreatedCtx).catch(() => {});

  res.status(201).json(lead);
});

router.post("/leads/bulk", requireAuth, requireRole(...STAFF_ROLES, ...AGENT_ROLES), requireAgentStaffPermission("leads"), async (req, res): Promise<void> => {
  const user = req.user!;
  const { leads } = req.body as { leads: any[] };
  if (!Array.isArray(leads) || leads.length === 0) {
    res.status(400).json({ error: "leads array is required" });
    return;
  }

  const currentYear = await getCurrentSeason();
  let resolvedAgentId: number | null = null;
  if (isAgentRole(user.role)) {
    const agentRec = await getAgentRecord(user.id, user.role);
    resolvedAgentId = agentRec?.id || null;
  }
  const origin = resolvedAgentId
    ? await inferOriginFromAgentId(resolvedAgentId)
    : await inferOriginFromUser(user);
  const inheritedBranchId = await resolveCreateBranchId(user.id, user.role, null, user);
  if (inheritedBranchId == null && user.role !== "super_admin" && !isAgentRole(user.role)) {
    res.status(403).json({ error: "No accessible branch — cannot create leads" });
    return;
  }

  const inserted: any[] = [];
  const errors: any[] = [];

  for (let i = 0; i < leads.length; i++) {
    const l = leads[i];
    if (!l.firstName || !l.lastName) {
      errors.push({ index: i, error: "firstName and lastName are required", row: l });
      continue;
    }
    const { error: nameErr, normalized: ns } = normalizeAndValidateNames(
      { firstName: l.firstName, lastName: l.lastName }, ["firstName", "lastName"]
    );
    if (nameErr) {
      errors.push({ index: i, error: nameErr, row: l });
      continue;
    }
    const normPhone = l.phone ? normalizePhoneField(l.phone) : null;
    let estimatedValue: string | null = null;
    if (l.estimatedValue != null && String(l.estimatedValue).trim() !== "") {
      const parsed = parseFloat(String(l.estimatedValue).replace(/[^0-9.\-]/g, ""));
      estimatedValue = Number.isFinite(parsed) ? String(parsed) : null;
    }
    try {
      const [lead] = await db.insert(leadsTable).values({
        branchId: inheritedBranchId,
        firstName: ns.firstName as string,
        lastName: ns.lastName as string,
        status: l.status || "new",
        email: l.email || null,
        phone: normPhone,
        phoneE164: toE164(normPhone),
        nationality: l.nationality || null,
        interestedProgram: l.interestedProgram || null,
        interestedUniversity: l.interestedUniversity || null,
        interestedCountry: l.interestedCountry || null,
        source: l.source || null,
        notes: l.notes || null,
        estimatedValue,
        agentId: resolvedAgentId,
        season: l.season || currentYear,
        ...origin,
      }).returning();
      await applyLeadAssignmentRules(lead, req.ip);
      inserted.push(lead);
    } catch (err: any) {
      errors.push({ index: i, error: err.message, row: l });
    }
  }

  await logAudit(user.id, "bulk_create_leads", "lead", undefined, { count: inserted.length }, req.ip);
  res.status(201).json({ inserted, errors, total: leads.length, success: inserted.length });
});

router.get("/leads/:id", requireAuth, requireRole(...STAFF_ROLES, ...AGENT_ROLES), requireAgentStaffPermission("leads"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [lead] = await db.select().from(leadsTable).where(and(eq(leadsTable.id, id), isNull(leadsTable.deletedAt)));
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }
  const user = req.user!;
  if (isAgentRole(user.role)) {
    const visibleIds = await getAgentVisibleIds(user.id, user.role);
    if (!lead.agentId || !visibleIds.includes(lead.agentId)) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  } else if (!(ADMIN_ROLES as readonly string[]).includes(user.role)) {
    const perms = await getEffectivePermissionSet(user);
    const viewOthers = perms.has("records.view_others");
    // KURAL 1: non-admin staff cannot access agent-sourced lead detail
    // unless they have records.view_others (Task #494) — within branch scope only
    if (lead.agentId !== null && !viewOthers) {
      res.status(404).json({ error: "Lead not found" }); return;
    }
    if (viewOthers && !(await isInBranchScope(user.id, user.role, lead.branchId, user))) {
      res.status(404).json({ error: "Lead not found" }); return;
    }
    if (!viewOthers && lead.assignedToId !== null && lead.assignedToId !== user.id) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  }
  res.json(lead);
});

// GET /api/leads/:id/documents — list documents tied to a lead.
// Reuses lead authz (same rules as GET /leads/:id), then returns every active
// document linked either directly to the lead (documents.leadId), or via the
// converted student (lead.convertedStudentId → students/applications). This
// lets staff see the documents a contact uploaded through public/apply or the
// embed widget even before the lead is converted to a student.
router.get("/leads/:id/documents", requireAuth, requireRole(...STAFF_ROLES, ...AGENT_ROLES), requireAgentStaffPermission("leads"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [lead] = await db.select().from(leadsTable).where(and(eq(leadsTable.id, id), isNull(leadsTable.deletedAt)));
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }
  const user = req.user!;
  if (isAgentRole(user.role)) {
    const visibleIds = await getAgentVisibleIds(user.id, user.role);
    if (!lead.agentId || !visibleIds.includes(lead.agentId)) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  } else if (!(ADMIN_ROLES as readonly string[]).includes(user.role)) {
    const docPerms = await getEffectivePermissionSet(user);
    const docViewOthers = docPerms.has("records.view_others");
    // KURAL 1: non-admin staff cannot access documents of agent-sourced leads
    // unless they have records.view_others (Task #494) — within branch scope only
    if (lead.agentId !== null && !docViewOthers) {
      res.status(404).json({ error: "Lead not found" }); return;
    }
    if (docViewOthers && !(await isInBranchScope(user.id, user.role, lead.branchId, user))) {
      res.status(404).json({ error: "Lead not found" }); return;
    }
    if (!docViewOthers && lead.assignedToId !== null && lead.assignedToId !== user.id) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  }

  const orConds: any[] = [eq(documentsTable.leadId, id)];
  if (lead.convertedStudentId) {
    orConds.push(eq(documentsTable.studentId, lead.convertedStudentId));
  }
  const docs = await db.select({
    id: documentsTable.id,
    name: documentsTable.name,
    type: documentsTable.type,
    status: documentsTable.status,
    mimeType: documentsTable.mimeType,
    sizeBytes: documentsTable.sizeBytes,
    fileUrl: documentsTable.fileUrl,
    fileData: documentsTable.fileData,
    fileKey: documentsTable.fileKey,
    studentId: documentsTable.studentId,
    applicationId: documentsTable.applicationId,
    leadId: documentsTable.leadId,
    createdAt: documentsTable.createdAt,
    sourceAttachmentId: documentsTable.sourceAttachmentId,
  })
    .from(documentsTable)
    .where(and(isNull(documentsTable.deletedAt), or(...orConds)!))
    .orderBy(desc(documentsTable.createdAt));
  res.json(docs);
});

// POST /api/leads/:id/documents — staff/agents manually attach a document to a
// lead, choosing a type from the admin-managed document catalog
// (catalog_options category='documents'). The document is linked to the lead
// (documents.leadId) so that, when the lead is converted to a student, it
// carries over (see /leads/:id/convert) and counts toward the program's
// document-requirements checklist. Uses the same fileKey object-storage flow
// and validation as POST /documents.
router.post("/leads/:id/documents", requireAuth, requireRole(...STAFF_ROLES, ...AGENT_ROLES), requireAgentStaffPermission("leads"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [lead] = await db.select().from(leadsTable).where(and(eq(leadsTable.id, id), isNull(leadsTable.deletedAt)));
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }
  const user = req.user!;
  if (isAgentRole(user.role)) {
    const visibleIds = await getAgentVisibleIds(user.id, user.role);
    if (!lead.agentId || !visibleIds.includes(lead.agentId)) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  } else if (!(ADMIN_ROLES as readonly string[]).includes(user.role)) {
    if (lead.assignedToId !== null && lead.assignedToId !== user.id) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  }

  if (req.body.fileData) {
    res.status(400).json({ error: "fileData uploads are no longer accepted. Upload via /storage/uploads/request-url and pass fileKey." });
    return;
  }

  const { type, fileKey, mimeType, sizeBytes, originalFileName } = req.body;
  if (!type || typeof type !== "string") { res.status(400).json({ error: "type is required" }); return; }
  if (!fileKey || typeof fileKey !== "string") { res.status(400).json({ error: "fileKey is required" }); return; }
  if (!mimeType) { res.status(400).json({ error: "mimeType is required for file uploads" }); return; }

  const validationFileName = originalFileName
    ? sanitizeFileName(originalFileName)
    : (() => {
        const syntheticExt = isPdf(mimeType) ? ".pdf" : mimeType === "image/png" ? ".png" : ".jpg";
        return `document${syntheticExt}`;
      })();
  const declaredSize = sizeBytes ? Number(sizeBytes) : 0;
  const validationError = validateStudentDocumentFile(type, validationFileName, mimeType, declaredSize);
  if (validationError) {
    const httpStatus = validationError.type === "size_exceeded" ? 413 : 400;
    res.status(httpStatus).json({ error: validationError.message });
    return;
  }

  let head: Buffer;
  try {
    const file = await leadDocsObjectStorage.getObjectEntityFile(fileKey);
    const [buf] = await file.download();
    head = buf;
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(400).json({ error: "Uploaded file could not be located in object storage." });
      return;
    }
    console.error("[LEADS] head-byte fetch failed:", err);
    res.status(502).json({ error: "Failed to verify uploaded file." });
    return;
  }
  const bufferError = await validateStudentDocumentBuffer(type, validationFileName, mimeType, head);
  if (bufferError) {
    try {
      const file = await leadDocsObjectStorage.getObjectEntityFile(fileKey);
      await file.delete({ ignoreNotFound: true });
    } catch (delErr) {
      console.error("[LEADS] failed to clean up rejected upload:", delErr);
    }
    const httpStatus = bufferError.type === "size_exceeded" ? 413 : 400;
    res.status(httpStatus).json({ error: bufferError.message });
    return;
  }

  // Ownership guard: agent callers may only attach storage objects they
  // uploaded themselves. Staff are trusted and bypass this check.
  if (isAgentRole(user.role)) {
    const owned = await callerOwnsObject(user.id, fileKey);
    if (!owned) {
      console.warn(`[LEADS] fileKey ownership violation: userId=${user.id} role=${user.role} key=${fileKey}`);
      res.status(403).json({ error: "You can only attach files that you have uploaded" });
      return;
    }
  }

  let storedMimeType = mimeType;
  let storedSizeBytes = sizeBytes ? Number(sizeBytes) : null;
  try {
    const recompressed = await recompressStoredObjectIfNeeded(fileKey, mimeType);
    if (recompressed?.recompressed) {
      storedMimeType = recompressed.mimeType;
      storedSizeBytes = recompressed.sizeBytes;
    }
  } catch (err) {
    if (err instanceof UploadTooLargeError) {
      res.status(413).json({ error: err.message });
      return;
    }
    console.error("[LEADS] recompressStoredObjectIfNeeded failed, keeping original:", err);
  }

  const safeName = buildDocNameFromParts(lead.firstName, lead.lastName, type, storedMimeType);

  // Match the canonical student upload semantics: a new content-bearing file
  // replaces the previous active document of the same type in the same
  // profile scope. Validation and storage verification have already succeeded,
  // so a rejected/abandoned upload can never retire the existing document.
  const previousScope = lead.convertedStudentId
    ? and(
        eq(documentsTable.studentId, lead.convertedStudentId),
        eq(documentsTable.type, type),
        isNull(documentsTable.applicationId),
        isNull(documentsTable.deletedAt),
      )
    : and(
        eq(documentsTable.leadId, id),
        isNull(documentsTable.studentId),
        eq(documentsTable.type, type),
        isNull(documentsTable.deletedAt),
      );
  const doc = await db.transaction(async (tx) => {
    await tx.update(documentsTable)
      .set({ deletedAt: new Date() })
      .where(previousScope);

    const [inserted] = await tx.insert(documentsTable).values({
      name: safeName,
      type,
      status: "pending",
      leadId: id,
      studentId: lead.convertedStudentId ?? null,
      fileKey,
      mimeType: storedMimeType || null,
      sizeBytes: storedSizeBytes,
    }).returning();
    return inserted;
  });
  await logAudit(user.id, "create_document", "document", doc.id, { name: safeName, type, leadId: id, studentId: lead.convertedStudentId ?? null }, req.ip);

  // Converted-lead uploads are student profile documents too. Run the same
  // downstream lifecycle as POST /documents so avatars, education extraction,
  // portal/mandatory checks and every linked application see the new file.
  if (doc.studentId) {
    if (type === "photo" || type === "photograph") {
      await recomputeStudentPhoto(doc.studentId);
    }
    maybeTriggerAutoEducationExtractForStudent({
      studentId: doc.studentId,
      actorUserId: user.id,
      ip: req.ip,
    });
    try {
      await reEvaluateMandatoryDocsForStudent(doc.studentId);
    } catch (err) {
      console.error("[LEADS] mandatory-document re-evaluation failed:", err);
    }
  }
  res.status(201).json(doc);
});

const AGENT_LEAD_PATCH_FIELDS = [
  "firstName", "lastName", "email", "phone", "nationality",
  "motherName", "fatherName",
  "interestedProgram", "interestedUniversity", "interestedCountry", "source",
  "notes", "estimatedValue", "interestedLevel",
  "educationData",
];

router.patch("/leads/:id", requireAuth, requireRole(...STAFF_ROLES, ...AGENT_ROLES), requireAgentStaffPermission("leads"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const user = req.user!;
  const isAgent = isAgentRole(user.role);

  const [existing] = await db.select().from(leadsTable).where(and(eq(leadsTable.id, id), isNull(leadsTable.deletedAt)));
  if (!existing) { res.status(404).json({ error: "Lead not found" }); return; }

  const isAdmin = (ADMIN_ROLES as readonly string[]).includes(user.role);
  const perms = isAgent || isAdmin
    ? new Set<string>()
    : await getEffectivePermissionSet(user);

  let agentVisibleIds: number[] = [];
  if (isAgent) {
    agentVisibleIds = await getAgentVisibleIds(user.id, user.role);
    if (!existing.agentId || !agentVisibleIds.includes(existing.agentId)) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  } else if (!isAdmin) {
    // KURAL 1: non-admin staff cannot update agent-sourced leads
    // unless they have records.view_others (Task #494) — within branch scope only
    if (existing.agentId !== null && !perms.has("records.view_others")) {
      res.status(404).json({ error: "Lead not found" }); return;
    }
    if (perms.has("records.view_others") && !(await isInBranchScope(user.id, user.role, existing.branchId, user))) {
      res.status(404).json({ error: "Lead not found" }); return;
    }
    if (!canAccessAssignedRecord(perms, existing.assignedToId, user.id)) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  }

  let allowedFields = isAgent ? [...AGENT_LEAD_PATCH_FIELDS] : LEAD_PATCH_FIELDS;
  // Lead stage change is governed by the leads.change_stage permission for all
  // non-admin roles (Task #564 — replaces the old agentCanChangeLeadStage
  // Settings toggle for agents). Agents resolve their effective permission set
  // here since `perms` is intentionally empty for the agent branch above.
  if (isAgent && req.body.status !== undefined) {
    const agentPerms = await getEffectivePermissionSet(user);
    if (agentPerms.has("leads.change_stage")) {
      allowedFields = [...allowedFields, "status"];
    }
  }
  if (!isAdmin && !isAgent && !perms.has("leads.change_stage")) {
    allowedFields = allowedFields.filter(f => f !== "status");
  }
  // L1: lead assignment scope for agent roles.
  //  - agent / sub_agent: may assign their lead to their own agent_staff
  //    member, claim it for themselves, or unassign it.
  //  - agent_staff: self-claim only (assign to self on a currently-unassigned
  //    lead); may NOT unassign or assign it to anyone else.
  // Targets are validated against the visible agent tree to prevent assigning
  // leads to out-of-scope users (IDOR / horizontal privilege escalation).
  if (isAgent && req.body.assignedTo !== undefined) {
    const isAgentManagerRole = user.role === "agent" || user.role === "sub_agent";
    const target = req.body.assignedTo;
    if (!isAgentManagerRole) {
      // agent_staff: only self-claim of an unassigned lead.
      if (target === null || Number(target) !== user.id || existing.assignedToId !== null) {
        res.status(403).json({ error: "Access denied" }); return;
      }
      allowedFields = [...allowedFields, "assignedTo"];
    } else if (target === null) {
      allowedFields = [...allowedFields, "assignedTo"];
    } else {
      const targetId = Number(target);
      let ok = !Number.isNaN(targetId) && targetId === user.id;
      if (!ok && !Number.isNaN(targetId) && agentVisibleIds.length > 0) {
        const [staffRow] = await db
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(and(
            eq(usersTable.id, targetId),
            eq(usersTable.role, "agent_staff"),
            inArray(usersTable.managingAgentId, agentVisibleIds),
          ));
        ok = !!staffRow;
      }
      if (!ok) { res.status(403).json({ error: "Access denied" }); return; }
      allowedFields = [...allowedFields, "assignedTo"];
    }
  }
  if (!isAdmin && !isAgent && req.body.assignedTo !== undefined) {
    // Task #494: strict rule — non-admin may only change assignment when they ARE the current assignee.
    // Exception (Task #507): self-claim of an unassigned record is allowed.
    // Exception: users with records.change_assigned permission may reassign any record.
    const isSelfClaim = existing.assignedToId === null && req.body.assignedTo === user.id;
    const canChangeAssigned = perms.has("records.change_assigned");
    if (!isSelfClaim && !canChangeAssigned && existing.assignedToId !== user.id) {
      res.status(403).json({ error: "Only the current assignee or an admin can change assignment" });
      return;
    }
  }
  const updates: Record<string, unknown> = {};
  for (const key of allowedFields) {
    if (req.body[key] !== undefined) {
      if (key === "assignedTo") {
        updates["assignedToId"] = req.body[key];
      } else {
        updates[key] = req.body[key];
      }
    }
  }
  if (isAdmin && req.body.originType !== undefined) {
    const validOrigin = ["direct", "agent", "sub_agent"];
    if (validOrigin.includes(req.body.originType)) {
      updates["originType"] = req.body.originType;
      updates["originEntityType"] = req.body.originEntityType ?? null;
      updates["originEntityId"] = req.body.originEntityId ?? null;
      updates["originDisplayName"] = req.body.originDisplayName ?? null;
      updates["originLocked"] = true;
    }
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
  }
  const { error: nameErr, normalized: normUpdates } = normalizeAndValidateNames(updates, ["firstName", "lastName"]);
  if (nameErr) { res.status(400).json({ error: nameErr }); return; }
  if (Object.prototype.hasOwnProperty.call(normUpdates, "phone")) {
    const rawPhone = (normUpdates as any).phone;
    if (rejectInvalidPhone(res, rawPhone)) return;
    (normUpdates as any).phone = rawPhone ? normalizePhoneField(rawPhone) : rawPhone;
    (normUpdates as any).phoneE164 = toE164((normUpdates as any).phone);
  }
  const assignmentChanged =
    Object.prototype.hasOwnProperty.call(normUpdates, "assignedToId") &&
    existing.assignedToId !== normUpdates.assignedToId;
  const canCascadeAssignment = assignmentChanged
    ? await userHasPermission({ id: user.id, role: user.role }, "records.cascade_assignment")
    : false;
  const statusChanged = Object.prototype.hasOwnProperty.call(normUpdates, "status") && existing.status !== normUpdates.status;
  const lead = assignmentChanged || statusChanged
    ? await db.transaction(async (tx) => {
        const [updatedLead] = await tx.update(leadsTable).set(normUpdates).where(eq(leadsTable.id, id)).returning();
        if (!updatedLead) return null;
        if (statusChanged) {
          // A direct staff status change supersedes any earlier application
          // automation ownership. A later reopen must never restore over it.
          await tx.delete(lifecycleCascadeStateTable).where(and(
            eq(lifecycleCascadeStateTable.entityType, "lead"),
            eq(lifecycleCascadeStateTable.entityId, id),
          ));
        }
        if (assignmentChanged && updatedLead.convertedStudentId && (canCascadeAssignment || updatedLead.assignedToId !== null)) {
          await cascadeLeadAssignment({
            leadId: updatedLead.id,
            convertedStudentId: updatedLead.convertedStudentId,
            newAssignedToId: updatedLead.assignedToId,
            actorUserId: user.id,
            ipAddress: req.ip,
            nullFillOnly: !canCascadeAssignment,
            throwOnError: true,
            executor: tx,
          });
        }
        return updatedLead;
      })
    : (await db.update(leadsTable).set(normUpdates).where(eq(leadsTable.id, id)).returning())[0];
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }
  const diff: Record<string, any> = {};
  for (const k of Object.keys(normUpdates)) {
    if (k === "phoneE164") continue;
    const oldVal = (existing as any)[k];
    const newVal = (normUpdates as any)[k];
    const oldNorm = oldVal instanceof Date ? oldVal.toISOString() : oldVal;
    const newNorm = newVal instanceof Date ? newVal.toISOString() : newVal;
    if (oldNorm !== newNorm) {
      diff[k] = { from: oldVal ?? null, to: newVal ?? null };
    }
  }
  await logAudit(user.id, "update_lead", "lead", id, Object.keys(diff).length ? diff : updates, req.ip);

  // T4: Cross-sync contact info to converted student (best-effort, ignore unique conflicts)
  if (lead.convertedStudentId) {
    const syncFields: Record<string, unknown> = {};
    for (const f of ["firstName", "lastName", "email", "phone", "phoneE164", "nationality"]) {
      if (Object.prototype.hasOwnProperty.call(normUpdates, f)) {
        syncFields[f] = (normUpdates as any)[f];
      }
    }
    if (Object.keys(syncFields).length > 0) {
      try {
        await db.update(studentsTable).set(syncFields).where(eq(studentsTable.id, lead.convertedStudentId));
      } catch (err) {
        console.warn("[lead->student sync] failed:", err);
      }
    }
  }

  // Cascade reassignment down to the converted student and its applications.
  // With `records.cascade_assignment` permission: OVERWRITES all downstream records.
  // Without it: null-fill only — fills unassigned downstream records automatically.
  if (updates.status && updates.status !== existing.status) {
    enqueueFtcLeadStageAnalytics(lead, existing.status, String(updates.status));
    // Event-driven portal enqueue: if this lead is already converted to a
    // student, propagate the stage change to their applications immediately.
    if (lead.convertedStudentId) {
      void enqueueOnStageChange({
        studentId:   lead.convertedStudentId,
        newStage:    String(updates.status),
        actorUserId: req.user!.id,
      });
    }

    dispatchNotification({
    actorUserId: req.user!.id,
      event: "lead.stage_changed",
      title: "Lead Stage Changed",
      body: `Lead ${lead.firstName} ${lead.lastName} moved from "${existing.status}" to "${updates.status}".`,
      actionUrl: `/staff/leads/${lead.id}`,
      icon: "ArrowRight",
      recipientUserIds: lead.assignedToId ? [lead.assignedToId] : undefined,
      templateVars: { firstName: lead.firstName, lastName: lead.lastName, oldStage: existing.status || "", newStage: String(updates.status) },
    }).catch(() => {});
  }

  if (updates.assignedToId && updates.assignedToId !== existing.assignedToId) {
    dispatchNotification({
    actorUserId: req.user!.id,
      event: "lead.assigned",
      title: "Lead Assigned to You",
      body: `Lead ${lead.firstName} ${lead.lastName} has been assigned to you.`,
      actionUrl: `/staff/leads/${lead.id}`,
      icon: "UserCheck",
      recipientUserIds: [updates.assignedToId as number],
      templateVars: { firstName: lead.firstName, lastName: lead.lastName },
    }).catch(() => {});
  }

  if (updates.agentId !== undefined && updates.agentId !== existing.agentId) {
    if (updates.agentId) {
      dispatchNotification({
    actorUserId: req.user!.id,
        event: "lead.agent_linked",
        title: "Lead Linked to Agent",
        body: `Lead ${lead.firstName} ${lead.lastName} has been linked to an agent.`,
        actionUrl: `/staff/leads/${lead.id}`,
        icon: "Building2",
        recipientUserIds: lead.assignedToId ? [lead.assignedToId] : undefined,
        templateVars: { firstName: lead.firstName, lastName: lead.lastName },
      }).catch(() => {});
    } else {
      dispatchNotification({
    actorUserId: req.user!.id,
        event: "lead.agent_unlinked",
        title: "Lead Unlinked from Agent",
        body: `Lead ${lead.firstName} ${lead.lastName} has been unlinked from their agent.`,
        actionUrl: `/staff/leads/${lead.id}`,
        icon: "Unlink",
        recipientUserIds: lead.assignedToId ? [lead.assignedToId] : undefined,
        templateVars: { firstName: lead.firstName, lastName: lead.lastName },
      }).catch(() => {});
    }
  }

  res.json(lead);
});

router.delete("/leads/:id", requireAuth, requireRole(...STAFF_ROLES, ...AGENT_ROLES), requireAgentStaffPermission("leads"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [existing] = await db.select().from(leadsTable).where(and(eq(leadsTable.id, id), isNull(leadsTable.deletedAt)));
  if (!existing) { res.status(404).json({ error: "Lead not found" }); return; }
  const delUser = req.user!;
  if (existing.convertedStudentId !== null) {
    res.status(409).json({
      error: "A converted lead belongs to an active student journey; archive the student journey instead",
      code: "LEAD_CONVERTED",
      studentId: existing.convertedStudentId,
    });
    return;
  }
  if (isAgentRole(delUser.role)) {
    // Agents may only delete leads within their own visibility tree.
    const visibleIds = await getAgentVisibleIds(delUser.id, delUser.role);
    if (!existing.agentId || !visibleIds.includes(existing.agentId)) {
      res.status(403).json({ error: "Access denied" }); return;
    }
  } else if (!(ADMIN_ROLES as readonly string[]).includes(delUser.role)) {
    // KURAL 1: non-admin staff cannot delete agent-sourced leads
    if (existing.agentId !== null) {
      res.status(404).json({ error: "Lead not found" }); return;
    }
    if (existing.assignedToId !== null && existing.assignedToId !== delUser.id) {
      res.status(403).json({ error: "Access denied" }); return;
    }
  }
  await softDelete(leadsTable, [id], { actorUserId: delUser.id });
  await logAudit(delUser.id, "delete_lead", "lead", id, { soft: true }, req.ip);
  res.sendStatus(204);
});

// Hard-delete (purge) — super_admin only. Permanently removes the row.
router.post("/leads/:id/purge", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [originStudent] = await db.select({ id: studentsTable.id }).from(studentsTable)
    .where(and(eq(studentsTable.originLeadId, id), isNull(studentsTable.deletedAt)))
    .limit(1);
  if (originStudent) {
    res.status(409).json({
      error: "This lead is the origin of an active student journey and cannot be permanently deleted",
      code: "LEAD_HAS_ACTIVE_STUDENT_JOURNEY",
      studentId: originStudent.id,
    });
    return;
  }
  const result = await db.delete(leadsTable).where(eq(leadsTable.id, id));
  await logAudit(req.user!.id, "purge_lead", "lead", id, { hard: true }, req.ip);
  res.json({ success: true, deleted: result.rowCount ?? 0 });
});

router.post("/leads/bulk-action", requireAuth, requireRole(...STAFF_ROLES), async (req, res): Promise<void> => {
  const user = req.user!;
  const isAdmin = (ADMIN_ROLES as readonly string[]).includes(user.role);
  const { ids, action, assignedToId, status } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) { res.status(400).json({ error: "ids required" }); return; }
  if (!["delete", "assign", "move"].includes(action)) { res.status(400).json({ error: "Invalid action" }); return; }
  // Task #494: non-admin may only bulk-assign their own records; delete/move remain admin-only
  if (!isAdmin && action !== "assign") {
    res.status(403).json({ error: "Only admins can bulk delete or move leads" }); return;
  }
  const numericIds = ids.map(Number).filter((n: number) => !isNaN(n));
  let updated = 0;
  if (action === "delete") {
    const converted = await db.select({ id: leadsTable.id, studentId: leadsTable.convertedStudentId })
      .from(leadsTable)
      .where(and(
        inArray(leadsTable.id, numericIds),
        isNotNull(leadsTable.convertedStudentId),
        isNull(leadsTable.deletedAt),
      ));
    if (converted.length > 0) {
      res.status(409).json({
        error: "Converted leads must be archived from their student journey",
        code: "BULK_DELETE_CONVERTED_LEADS",
        blockedLeadIds: converted.map((row) => row.id),
      });
      return;
    }
    updated = await softDelete(leadsTable, numericIds, { actorUserId: user.id });
    for (const id of numericIds) logAudit(user.id, "delete_lead", "lead", id, { soft: true }, req.ip);
  } else if (action === "assign" && assignedToId !== undefined) {
    const newAssignedToId = assignedToId ? Number(assignedToId) : null;
    // Non-admin: filter to only records they are the current assignee of
    let idsToUpdate = numericIds;
    let skipped = 0;
    if (!isAdmin) {
      const ownedRows = await db.select({ id: leadsTable.id })
        .from(leadsTable)
        .where(and(inArray(leadsTable.id, numericIds), eq(leadsTable.assignedToId, user.id), isNull(leadsTable.deletedAt)));
      idsToUpdate = ownedRows.map(r => r.id);
      skipped = numericIds.length - idsToUpdate.length;
      if (idsToUpdate.length === 0) {
        res.json({ success: true, updated: 0, skipped }); return;
      }
    }
    const affectedLeads = await db.select({ id: leadsTable.id, convertedStudentId: leadsTable.convertedStudentId })
      .from(leadsTable).where(and(inArray(leadsTable.id, idsToUpdate), isNull(leadsTable.deletedAt)));
    const canCascadeLeads = await userHasPermission({ id: user.id, role: user.role }, "records.cascade_assignment");
    updated = await db.transaction(async (tx) => {
      const result = await tx.update(leadsTable).set({ assignedToId: newAssignedToId }).where(inArray(leadsTable.id, idsToUpdate));
      const firstByStudent = new Map<number, number>();
      for (const lead of affectedLeads) {
        if (lead.convertedStudentId && !firstByStudent.has(lead.convertedStudentId)) {
          firstByStudent.set(lead.convertedStudentId, lead.id);
        }
      }
      for (const [studentId, leadId] of firstByStudent) {
        if (canCascadeLeads || newAssignedToId !== null) {
          await cascadeLeadAssignment({
            leadId,
            convertedStudentId: studentId,
            newAssignedToId,
            actorUserId: user.id,
            ipAddress: req.ip,
            nullFillOnly: !canCascadeLeads,
            throwOnError: true,
            executor: tx,
          });
        }
      }
      return result.rowCount ?? idsToUpdate.length;
    });
    await logAudit(user.id, "bulk_assign_leads", "lead", undefined, { ids: idsToUpdate, assignedToId }, req.ip);
    res.json({ success: true, updated, skipped }); return;
  } else if (action === "move" && status) {
    const affectedLeads = await db.select().from(leadsTable)
      .where(and(inArray(leadsTable.id, numericIds), isNull(leadsTable.deletedAt)));
    updated = await db.transaction(async (tx) => {
      const result = await tx.update(leadsTable).set({ status })
        .where(and(inArray(leadsTable.id, numericIds), isNull(leadsTable.deletedAt)));
      await tx.delete(lifecycleCascadeStateTable).where(and(
        eq(lifecycleCascadeStateTable.entityType, "lead"),
        inArray(lifecycleCascadeStateTable.entityId, numericIds),
      ));
      return result.rowCount ?? affectedLeads.length;
    });
    await logAudit(user.id, "bulk_move_leads", "lead", undefined, { ids: numericIds, status }, req.ip);
    for (const affectedLead of affectedLeads) {
      enqueueFtcLeadStageAnalytics(affectedLead, affectedLead.status, String(status));
    }
  } else {
    res.status(400).json({ error: "Missing required fields for action" }); return;
  }
  res.json({ success: true, updated });
});

router.post("/leads/:id/convert", requireAuth, requireRole(...STAFF_ROLES, ...AGENT_ROLES), async (req, res): Promise<void> => {
  const user = req.user!;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [lead] = await db.select().from(leadsTable).where(and(eq(leadsTable.id, id), isNull(leadsTable.deletedAt)));
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

  if (isAgentRole(user.role)) {
    const visibleIds = await getAgentVisibleIds(user.id, user.role);
    if (!lead.agentId || !visibleIds.includes(lead.agentId)) {
      res.status(403).json({ error: "You do not have access to this lead" });
      return;
    }
  }
  const missingFields: string[] = [];
  if (!lead.firstName?.trim()) missingFields.push("firstName");
  if (!lead.lastName?.trim()) missingFields.push("lastName");
  if (!lead.email?.trim()) missingFields.push("email");
  if (!lead.phone?.trim()) missingFields.push("phone");
  if (missingFields.length > 0) {
    res.status(422).json({
      error: `Cannot convert: missing required fields — ${missingFields.join(", ")}`,
      missingFields,
    });
    return;
  }

  if (lead.convertedStudentId) {
    const [existing] = await db.select().from(studentsTable).where(and(eq(studentsTable.id, lead.convertedStudentId), isNull(studentsTable.deletedAt)));
    if (existing) {
      const wonStages = await db.select().from(pipelineStagesTable)
        .where(and(eq(pipelineStagesTable.entityType, "lead"), eq(pipelineStagesTable.variant, "won")));
      const convertedKey = wonStages.length > 0 ? wonStages[0].key : "converted";
      if (lead.status !== convertedKey) {
        await db.update(leadsTable).set({ status: convertedKey }).where(eq(leadsTable.id, id));
        enqueueFtcLeadStageAnalytics(lead, lead.status, convertedKey);
      }
      res.json({ student: existing, merged: false, alreadyConverted: true });
      return;
    }
    await db.update(leadsTable).set({ convertedStudentId: null }).where(eq(leadsTable.id, id));
  }

  const embedSubmissions = await db.select().from(embedSubmissionsTable).where(eq(embedSubmissionsTable.leadId, lead.id));
  const submission = embedSubmissions.length > 0 ? embedSubmissions[0] : null;
  const aiData: Record<string, any> = (submission?.aiExtractedData as Record<string, any>) || {};

  // A lead is not converted into a student/application until every Mandatory
  // document configured for the selected program + degree is present. The
  // document rows already belong to the lead at this point, so a failed gate
  // leaves the funnel exactly where staff can continue collecting files.
  if (submission?.programId) {
    const leadDocs = await db
      .select({ type: documentsTable.type })
      .from(documentsTable)
      .where(and(
        eq(documentsTable.leadId, lead.id),
        isNull(documentsTable.deletedAt),
        or(isNull(documentsTable.status), ne(documentsTable.status, "rejected")),
      ));
    const docStatus = await checkMandatoryDocs(
      submission.programId,
      leadDocs.map((d) => String(d.type || "")).filter(Boolean),
    );
    if (docStatus.missing.length > 0) {
      const missingDocLabels = docStatus.missing.map(getDocLabel);
      res.status(422).json({
        error: `Mandatory documents are missing: ${missingDocLabels.join(", ")}`,
        code: "LEAD_MANDATORY_DOCS_REQUIRED",
        missingDocTypes: docStatus.missing,
        missingDocLabels,
        leadId: lead.id,
      });
      return;
    }
  }

  const s = (v: any) => (v && v !== "null" && v !== "N/A") ? String(v) : null;
  const residence = resolveResidenceAddress({
    address: s(aiData.address),
    addressCity: s(aiData.addressCity),
    postalCode: s(aiData.postalCode),
    nationality: lead.nationality || s(aiData.nationality),
  });
  const aiPassportNumber = s(aiData.passportNumber);
  const safeAiPassportNumber = aiPassportNumber &&
    !validatePassportNumber(aiPassportNumber)
    ? aiPassportNumber.trim()
    : null;

  const studentValues: any = {
    firstName: lead.firstName,
    lastName: lead.lastName,
    email: lead.email || null,
    phone: lead.phone || null,
    phoneE164: (lead as any).phoneE164 || toE164(lead.phone || "") || null,
    nationality: lead.nationality || s(aiData.nationality) || null,
    agentId: (lead as any).agentId || null,
    assignedToId: lead.assignedToId || null,
    branchId: lead.branchId || null,
    status: "active",
    motherName: s(aiData.motherName) || null,
    fatherName: s(aiData.fatherName) || null,
    passportNumber: safeAiPassportNumber,
    passportIssueDate: s(aiData.passportIssueDate) || null,
    passportExpiry: s(aiData.passportExpiry) || null,
    dateOfBirth: s(aiData.dateOfBirth) || null,
    address: s(aiData.address) || null,
    addressCity: residence.addressCity,
    postalCode: residence.postalCode,
    highSchool: s(aiData.highSchool) || null,
    graduationYear: aiData.graduationYear ? parseInt(String(aiData.graduationYear), 10) || null : null,
    gpa: s(aiData.gpa) || null,
    languageScore: s(aiData.languageScore) || null,
    originType: lead.originType || "direct",
    originEntityType: lead.originEntityType || null,
    originEntityId: lead.originEntityId || null,
    originDisplayName: lead.originDisplayName || "Find And Study",
    originLocked: true,
    originLeadId: lead.id,
  };

  try {
    const conversion = await db.transaction(async (tx) => {
      // Serialize every conversion attempt for this lead. Repeated clicks and
      // concurrent workers either observe the committed result or perform the
      // conversion once; they cannot create parallel students.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(76123, ${lead.id})`);
      const [lockedLead] = await tx.select().from(leadsTable)
        .where(and(eq(leadsTable.id, lead.id), isNull(leadsTable.deletedAt)));
      if (!lockedLead) throw new Error("Lead disappeared during conversion");
      if (lockedLead.convertedStudentId) {
        const [alreadyStudent] = await tx.select().from(studentsTable).where(and(
          eq(studentsTable.id, lockedLead.convertedStudentId),
          isNull(studentsTable.deletedAt),
        ));
        if (alreadyStudent) {
          if (lockedLead.status !== "converted") {
            await tx.update(leadsTable).set({ status: "converted" }).where(eq(leadsTable.id, lockedLead.id));
          }
          return { studentId: alreadyStudent.id, merged: true, alreadyConverted: true, app: null, appCreated: false };
        }
        await tx.update(leadsTable).set({ convertedStudentId: null }).where(eq(leadsTable.id, lockedLead.id));
      }

      const normalizedLeadEmail = lockedLead.email?.trim().toLowerCase() ?? "";
      // A per-lead lock prevents repeated clicks for one row. The normalized
      // e-mail lock additionally serializes two different leads representing
      // the same person, so they cannot both create a new student.
      if (normalizedLeadEmail) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${normalizedLeadEmail}, 0))`);
      }
      const matchingStudents = normalizedLeadEmail
        ? await tx.select().from(studentsTable).where(and(
            sql`lower(trim(${studentsTable.email})) = ${normalizedLeadEmail}`,
            isNull(studentsTable.deletedAt),
          )).orderBy(asc(studentsTable.id)).limit(2)
        : [];
      if (matchingStudents.length > 1) {
        const err = new Error("Multiple active students match this lead email") as Error & { code?: string; ids?: number[] };
        err.code = "LEAD_CONVERSION_IDENTITY_AMBIGUOUS";
        err.ids = matchingStudents.map((row) => row.id);
        throw err;
      }

      const normalizedPassport = studentValues.passportNumber
        ? String(studentValues.passportNumber).trim().toUpperCase()
        : "";
      const passportMatches = normalizedPassport
        ? await tx.select({ id: studentsTable.id, email: studentsTable.email, passportNumber: studentsTable.passportNumber })
            .from(studentsTable)
            .where(and(
              sql`upper(trim(${studentsTable.passportNumber})) = ${normalizedPassport}`,
              isNull(studentsTable.deletedAt),
            ))
            .orderBy(asc(studentsTable.id))
            .limit(2)
        : [];
      const emailStudent = matchingStudents[0] ?? null;
      if (passportMatches.length > 1 || (passportMatches[0] && passportMatches[0].id !== emailStudent?.id)) {
        const err = new Error("Passport identity conflicts with an existing active student") as Error & { code?: string };
        err.code = "LEAD_CONVERSION_PASSPORT_CONFLICT";
        throw err;
      }
      if (emailStudent?.passportNumber && normalizedPassport &&
          emailStudent.passportNumber.trim().toUpperCase() !== normalizedPassport) {
        const err = new Error("Lead passport conflicts with the matching student's passport") as Error & { code?: string };
        err.code = "LEAD_CONVERSION_PASSPORT_CONFLICT";
        throw err;
      }

      let student = emailStudent;
      const merged = !!student;
      if (student) {
        const mergeUpdates: any = {};
        if (!student.assignedToId && lockedLead.assignedToId) mergeUpdates.assignedToId = lockedLead.assignedToId;
        if (!student.branchId && lockedLead.branchId) mergeUpdates.branchId = lockedLead.branchId;
        if (!student.motherName && studentValues.motherName) mergeUpdates.motherName = studentValues.motherName;
        if (!student.fatherName && studentValues.fatherName) mergeUpdates.fatherName = studentValues.fatherName;
        if (!student.passportNumber && studentValues.passportNumber) mergeUpdates.passportNumber = studentValues.passportNumber;
        if (!student.passportIssueDate && studentValues.passportIssueDate) mergeUpdates.passportIssueDate = studentValues.passportIssueDate;
        if (!student.passportExpiry && studentValues.passportExpiry) mergeUpdates.passportExpiry = studentValues.passportExpiry;
        if (!student.dateOfBirth && studentValues.dateOfBirth) mergeUpdates.dateOfBirth = studentValues.dateOfBirth;
        if (!student.address && studentValues.address) mergeUpdates.address = studentValues.address;
        const mergedResidence = resolveResidenceAddress({
          address: studentValues.address || student.address,
          addressCity: student.addressCity || studentValues.addressCity,
          postalCode: student.postalCode || studentValues.postalCode,
          nationality: student.nationality || studentValues.nationality,
        });
        if (student.addressCity !== mergedResidence.addressCity) mergeUpdates.addressCity = mergedResidence.addressCity;
        if (student.postalCode !== mergedResidence.postalCode) mergeUpdates.postalCode = mergedResidence.postalCode;
        if (!student.highSchool && studentValues.highSchool) mergeUpdates.highSchool = studentValues.highSchool;
        if (!student.gpa && studentValues.gpa) mergeUpdates.gpa = studentValues.gpa;
        if (!student.languageScore && studentValues.languageScore) mergeUpdates.languageScore = studentValues.languageScore;
        if (!student.graduationYear && studentValues.graduationYear) mergeUpdates.graduationYear = studentValues.graduationYear;
        if (!student.originLeadId) mergeUpdates.originLeadId = lockedLead.id;
        if (student.originType === "direct" && lockedLead.originType !== "direct") {
          mergeUpdates.originType = lockedLead.originType;
          mergeUpdates.originEntityType = lockedLead.originEntityType;
          mergeUpdates.originEntityId = lockedLead.originEntityId;
          mergeUpdates.originDisplayName = lockedLead.originDisplayName;
        }
        if (Object.keys(mergeUpdates).length > 0) {
          [student] = await tx.update(studentsTable).set(mergeUpdates)
            .where(eq(studentsTable.id, student.id)).returning();
        }
      } else {
        [student] = await tx.insert(studentsTable).values({
          ...studentValues,
          email: normalizedLeadEmail || studentValues.email,
        }).returning();
      }
      if (!student) throw new Error("Student could not be resolved during conversion");

      await tx.update(documentsTable).set({ studentId: student.id })
        .where(and(eq(documentsTable.leadId, lockedLead.id), isNull(documentsTable.studentId)));
      const appResult = submission?.programId
        ? await createApplicationFromSubmission(student.id, lockedLead.id, submission, tx)
        : { app: null, created: false };
      if (submission?.programId && !appResult.app) {
        throw new Error("Application could not be created during lead conversion");
      }
      await tx.update(leadsTable).set({ status: "converted", convertedStudentId: student.id })
        .where(eq(leadsTable.id, lockedLead.id));
      await tx.update(externalContactsTable).set({ studentId: student.id })
        .where(eq(externalContactsTable.leadId, lockedLead.id));
      return { studentId: student.id, merged, alreadyConverted: false, app: appResult.app, appCreated: appResult.created };
    });

    await recomputeStudentPhoto(conversion.studentId);
    maybeTriggerAutoEducationExtractForStudent({
      studentId: conversion.studentId,
      actorUserId: req.user?.id ?? null,
      ip: req.ip,
    });
    if (conversion.app && conversion.appCreated) {
      maybeEnqueuePortalSubmission({
        applicationId: conversion.app.id,
        studentId: conversion.app.studentId,
        newStage: String(conversion.app.stage),
        universityName: conversion.app.universityName ?? null,
        universityId: conversion.app.universityId ?? null,
        actorUserId: req.user?.id ?? null,
      }).catch((err) => console.error("[portal-auto] Trigger failed for new app", conversion.app?.id, ":", err));
    }
    if (!conversion.alreadyConverted) enqueueFtcLeadStageAnalytics(lead, lead.status, "converted");
    await logAudit(req.user!.id, "convert_lead", "lead", id, {
      studentId: conversion.studentId,
      merged: conversion.merged,
      alreadyConverted: conversion.alreadyConverted,
      applicationId: conversion.app?.id ?? null,
    }, req.ip);
    const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, conversion.studentId));
    res.json({ student, merged: conversion.merged, alreadyConverted: conversion.alreadyConverted });
  } catch (err: any) {
    if (err?.code === "LEAD_CONVERSION_IDENTITY_AMBIGUOUS") {
      res.status(409).json({
        error: "Multiple active students match this lead email; review duplicates before converting",
        code: err.code,
        candidateStudentIds: err.ids ?? [],
      });
      return;
    }
    if (err?.code === "LEAD_CONVERSION_PASSPORT_CONFLICT") {
      res.status(409).json({
        error: "Passport identity conflicts with an existing student; review the records before converting",
        code: err.code,
      });
      return;
    }
    console.error("[LEAD-CONVERT] atomic conversion failed:", err);
    res.status(500).json({ error: "Lead conversion failed; no partial CRM conversion was committed" });
  }
});

type LeadConversionTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type LeadConversionDb = typeof db | LeadConversionTx;

async function createApplicationFromSubmission(
  studentId: number,
  leadId: number,
  submission: any,
  executor: LeadConversionDb = db,
): Promise<{ app: typeof applicationsTable.$inferSelect | null; created: boolean }> {
    const programId = submission.programId;
    const [program] = await executor.select().from(programsTable).where(eq(programsTable.id, programId));
    if (!program) throw new Error(`Program #${programId} not found during lead conversion`);

    const [university] = await executor.select().from(universitiesTable).where(eq(universitiesTable.id, program.universityId));

    const [existingApp] = await executor.select().from(applicationsTable)
      .where(and(
        eq(applicationsTable.studentId, studentId),
        eq(applicationsTable.programId, programId),
        isNull(applicationsTable.deletedAt),
      ));
    if (existingApp) {
      // This conversion is authoritative for the current lead.  Fill only a
      // missing link; never steal an application already tied to another lead.
      if (existingApp.leadId == null) {
        const [linked] = await executor.update(applicationsTable).set({ leadId })
          .where(and(eq(applicationsTable.id, existingApp.id), isNull(applicationsTable.leadId)))
          .returning();
        return { app: linked ?? existingApp, created: false };
      }
      return { app: existingApp, created: false };
    }

    const [studentRec] = await executor.select({
      assignedToId: studentsTable.assignedToId, agentId: studentsTable.agentId,
      branchId: studentsTable.branchId,
      originType: studentsTable.originType, originEntityType: studentsTable.originEntityType,
      originEntityId: studentsTable.originEntityId, originDisplayName: studentsTable.originDisplayName,
    }).from(studentsTable).where(eq(studentsTable.id, studentId));

    const [app] = await executor.insert(applicationsTable).values({
      studentId,
      // This application is created as part of this exact lead conversion, so
      // the relationship is authoritative. Other creation paths leave leadId
      // null rather than guessing from the student's converted leads.
      leadId,
      // Lead submission (public intake form) → student self-service.
      createdSource: "student",
      programId: program.id,
      universityId: program.universityId,
      programName: program.name,
      universityName: university?.name || submission.universityName || null,
      country: university?.country || null,
      level: program.degree || null,
      instructionLanguage: program.language || null,
      tuitionFee: program.tuitionFee || null,
      discountedFee: program.discountedFee || null,
      scholarship: program.scholarship || null,
      stage: "inquiry",
      season: "2026",
      assignedToId: studentRec?.assignedToId ?? null,
      branchId: studentRec?.branchId ?? null,
      agentId: studentRec?.agentId || null,
      originType: studentRec?.originType || "direct",
      originEntityType: studentRec?.originEntityType || null,
      originEntityId: studentRec?.originEntityId || null,
      originDisplayName: studentRec?.originDisplayName || "Find And Study",
      originStudentId: studentId,
    }).returning();

    return { app: app ?? null, created: true };
}

router.get("/leads/:id/notes", requireAuth, requireRole(...STAFF_ROLES, ...AGENT_ROLES), requireAgentStaffPermission("leads"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { page = "1", limit = "50", internal } = req.query as Record<string, string>;
  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10)));
  const offset = (pageNum - 1) * limitNum;

  // KURAL 1: non-admin staff cannot access notes of agent-sourced leads
  // unless they have records.view_others (Task #494) — within branch scope only
  const [noteLeadRow] = await db.select({ agentId: leadsTable.agentId, branchId: leadsTable.branchId }).from(leadsTable).where(and(eq(leadsTable.id, id), isNull(leadsTable.deletedAt)));
  if (!noteLeadRow) { res.status(404).json({ error: "Lead not found" }); return; }
  if (isAgentSourcedAndBlockedForStaff(req.user!, noteLeadRow.agentId)) {
    const notePerms = await getEffectivePermissionSet(req.user!);
    if (!notePerms.has("records.view_others")) {
      res.status(404).json({ error: "Lead not found" }); return;
    }
    if (!(await isInBranchScope(req.user!.id, req.user!.role, noteLeadRow.branchId, req.user!))) {
      res.status(404).json({ error: "Lead not found" }); return;
    }
  }

  const isStaff = ["super_admin", "admin", "manager", "staff"].includes(req.user!.role);
  const conditions = [eq(notesTable.resourceId, id), eq(notesTable.resourceType, "lead")];

  if (!isStaff || internal !== "true") {
    conditions.push(eq(notesTable.isInternal, false));
  } else {
    conditions.push(eq(notesTable.isInternal, true));
  }

  const notes = await db
    .select({
      id: notesTable.id,
      content: notesTable.content,
      authorId: notesTable.authorId,
      authorName: sql<string | null>`concat(${usersTable.firstName}, ' ', ${usersTable.lastName})`,
      isInternal: notesTable.isInternal,
      createdAt: notesTable.createdAt,
    })
    .from(notesTable)
    .leftJoin(usersTable, eq(notesTable.authorId, usersTable.id))
    .where(and(...conditions))
    .orderBy(notesTable.createdAt)
    .limit(limitNum)
    .offset(offset);
  res.json(notes);
});

router.post("/leads/:id/notes", requireAuth, requireRole(...STAFF_ROLES, ...AGENT_ROLES), requireAgentStaffPermission("leads"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { content, isInternal } = req.body;
  if (!content?.trim()) { res.status(400).json({ error: "content is required" }); return; }

  const isStaff = ["super_admin", "admin", "manager", "staff"].includes(req.user!.role);

  const [note] = await db.insert(notesTable).values({
    content: String(content).slice(0, 5000),
    authorId: req.user!.id,
    resourceType: "lead",
    resourceId: id,
    isInternal: isStaff && isInternal === true,
  }).returning();

  const [lead] = await db.select({
    assignedToId: leadsTable.assignedToId,
    agentId: leadsTable.agentId,
    firstName: leadsTable.firstName,
    lastName: leadsTable.lastName,
  }).from(leadsTable).where(and(eq(leadsTable.id, id), isNull(leadsTable.deletedAt)));

  if (lead) {
    const recipientIds: number[] = [];
    if (lead.assignedToId && lead.assignedToId !== req.user!.id) {
      recipientIds.push(lead.assignedToId);
    }
    if (lead.agentId) {
      const [agent] = await db.select({ userId: agentsTable.userId }).from(agentsTable)
        .where(eq(agentsTable.id, lead.agentId));
      if (agent?.userId && agent.userId !== req.user!.id && !recipientIds.includes(agent.userId)) {
        recipientIds.push(agent.userId);
      }
    }
    if (recipientIds.length > 0) {
      dispatchNotification({
    actorUserId: req.user!.id,
        event: "note.created",
        title: "New Note Added",
        body: `A note was added to lead ${lead.firstName} ${lead.lastName}`,
        actionUrl: `/staff/leads/${id}`,
        recipientUserIds: recipientIds,
        data: { resourceType: "lead", resourceId: id },
      });
    }
  }

  res.status(201).json({ ...note, authorName: `${req.user!.firstName || ""} ${req.user!.lastName || ""}`.trim() });
});

router.delete("/leads/:id/notes/:noteId", requireAuth, requireRole(...STAFF_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const noteId = parseInt(String(req.params.noteId), 10);
  if (isNaN(id) || isNaN(noteId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [note] = await db.select({
    id: notesTable.id,
    content: notesTable.content,
    authorId: notesTable.authorId,
    isInternal: notesTable.isInternal,
  }).from(notesTable).where(and(
    eq(notesTable.id, noteId),
    eq(notesTable.resourceId, id),
    eq(notesTable.resourceType, "lead"),
  ));
  if (!note) { res.status(404).json({ error: "Note not found" }); return; }

  await db.delete(notesTable).where(eq(notesTable.id, noteId));

  await logAudit(req.user!.id, "delete_note", "lead", id, {
    noteId,
    isInternal: note.isInternal,
    authorId: note.authorId,
    contentPreview: (note.content || "").slice(0, 200),
  }, req.ip);

  res.status(204).end();
});

router.get("/leads/:id/follow-ups", requireAuth, requireRole(...STAFF_ROLES, ...AGENT_ROLES), requireAgentStaffPermission("leads"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [lead] = await db.select().from(leadsTable).where(and(eq(leadsTable.id, id), isNull(leadsTable.deletedAt)));
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }
  const user = req.user!;
  if (isAgentRole(user.role)) {
    const visibleIds = await getAgentVisibleIds(user.id, user.role);
    if (!lead.agentId || !visibleIds.includes(lead.agentId)) { res.status(403).json({ error: "Access denied" }); return; }
  } else if (!(ADMIN_ROLES as readonly string[]).includes(user.role)) {
    // KURAL 1: non-admin staff cannot access follow-ups of agent-sourced leads
    if (lead.agentId !== null) { res.status(404).json({ error: "Lead not found" }); return; }
    if (lead.assignedToId !== null && lead.assignedToId !== user.id) { res.status(403).json({ error: "Access denied" }); return; }
  }
  const { page = "1", limit = "50" } = req.query as Record<string, string>;
  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10)));
  const offset = (pageNum - 1) * limitNum;

  const data = await db
    .select({
      id: followUpsTable.id,
      leadId: followUpsTable.leadId,
      title: followUpsTable.title,
      scheduledAt: followUpsTable.scheduledAt,
      completed: followUpsTable.completed,
      completedAt: followUpsTable.completedAt,
      notes: followUpsTable.notes,
      createdById: followUpsTable.createdById,
      createdByName: sql<string | null>`(SELECT NULLIF(CONCAT_WS(' ', cu.first_name, cu.last_name), '') FROM users cu WHERE cu.id = ${followUpsTable.createdById})`,
      updatedById: followUpsTable.updatedById,
      updatedByName: sql<string | null>`(SELECT NULLIF(CONCAT_WS(' ', uu.first_name, uu.last_name), '') FROM users uu WHERE uu.id = ${followUpsTable.updatedById})`,
      createdAt: followUpsTable.createdAt,
      updatedAt: followUpsTable.updatedAt,
    })
    .from(followUpsTable)
    .where(eq(followUpsTable.leadId, id))
    .orderBy(asc(followUpsTable.scheduledAt))
    .limit(limitNum)
    .offset(offset);
  res.json(data);
});

router.post("/leads/:id/follow-ups", requireAuth, requireRole(...STAFF_ROLES, ...AGENT_ROLES), requireAgentStaffPermission("leads"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [lead] = await db.select().from(leadsTable).where(and(eq(leadsTable.id, id), isNull(leadsTable.deletedAt)));
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }
  const user = req.user!;
  if (isAgentRole(user.role)) {
    const visibleIds = await getAgentVisibleIds(user.id, user.role);
    if (!lead.agentId || !visibleIds.includes(lead.agentId)) { res.status(403).json({ error: "Access denied" }); return; }
  } else if (!(ADMIN_ROLES as readonly string[]).includes(user.role)) {
    if (lead.assignedToId !== null && lead.assignedToId !== user.id) { res.status(403).json({ error: "Access denied" }); return; }
  }
  const { title, scheduledAt, notes } = req.body;
  if (!title?.trim() || !scheduledAt) {
    res.status(400).json({ error: "title and scheduledAt are required" });
    return;
  }
  const scheduledDate = new Date(scheduledAt);
  if (isNaN(scheduledDate.getTime())) {
    res.status(400).json({ error: "Invalid date" });
    return;
  }
  if (scheduledDate < new Date()) {
    res.status(400).json({ error: "Cannot schedule follow-ups in the past" });
    return;
  }
  const [followUp] = await db.insert(followUpsTable).values({
    leadId: id,
    resourceType: "lead",
    title: String(title).slice(0, 500),
    scheduledAt: scheduledDate,
    notes: notes ? String(notes).slice(0, 2000) : null,
    createdById: req.user!.id,
    assignedToId: req.user!.id,
  }).returning();
  await logAudit(req.user!.id, "create_follow_up", "lead", id, {
    followUpId: followUp.id,
    title: followUp.title,
    scheduledAt: followUp.scheduledAt instanceof Date ? followUp.scheduledAt.toISOString() : followUp.scheduledAt,
    notes: followUp.notes ? String(followUp.notes).slice(0, 200) : null,
  }, req.ip);
  res.status(201).json(followUp);
});

router.patch("/follow-ups/:id", requireAuth, requireRole(...STAFF_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [existingFu] = await db.select().from(followUpsTable).where(eq(followUpsTable.id, id));
  if (!existingFu) { res.status(404).json({ error: "Follow-up not found" }); return; }
  const fuUser = req.user!;
  if (existingFu.leadId) {
    const [fuLead] = await db.select().from(leadsTable).where(and(eq(leadsTable.id, existingFu.leadId), isNull(leadsTable.deletedAt)));
    if (!fuLead) { res.status(404).json({ error: "Follow-up not found" }); return; }
    if (isAgentRole(fuUser.role)) {
      const visibleIds = await getAgentVisibleIds(fuUser.id, fuUser.role);
      if (!fuLead.agentId || !visibleIds.includes(fuLead.agentId)) { res.status(403).json({ error: "Access denied" }); return; }
    } else if (!(ADMIN_ROLES as readonly string[]).includes(fuUser.role)) {
      if (fuLead.assignedToId !== null && fuLead.assignedToId !== fuUser.id) { res.status(403).json({ error: "Access denied" }); return; }
    }
  } else if (existingFu.studentId) {
    const access = await assertCanAccessStudent(req, existingFu.studentId);
    if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }
  }
  const { completed, title, scheduledAt, notes } = req.body;
  const updates: Record<string, unknown> = {};
  let isContentEdit = false;
  let isCompletionToggle = false;
  if (completed !== undefined) {
    updates.completed = completed;
    updates.completedAt = completed ? new Date() : null;
    isCompletionToggle = true;
  }
  if (title !== undefined) { updates.title = String(title).slice(0, 500); isContentEdit = true; }
  if (scheduledAt !== undefined) {
    const scheduledDate = new Date(scheduledAt);
    if (isNaN(scheduledDate.getTime())) {
      res.status(400).json({ error: "Invalid date" });
      return;
    }
    if (scheduledDate < new Date()) {
      res.status(400).json({ error: "Cannot schedule follow-ups in the past" });
      return;
    }
    updates.scheduledAt = scheduledDate;
    isContentEdit = true;
  }
  if (notes !== undefined) { updates.notes = notes ? String(notes).slice(0, 2000) : null; isContentEdit = true; }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No valid fields" });
    return;
  }
  updates.updatedAt = new Date();
  if (isContentEdit) {
    updates.updatedById = req.user!.id;
  }
  const [followUp] = await db.update(followUpsTable).set(updates).where(eq(followUpsTable.id, id)).returning();
  if (!followUp) { res.status(404).json({ error: "Follow-up not found" }); return; }

  const auditResource = existingFu.leadId ? "lead" : existingFu.studentId ? "student" : "follow_up";
  const auditResourceId = existingFu.leadId ?? existingFu.studentId ?? null;
  if (isContentEdit) {
    const fuDiff: Record<string, any> = { followUpId: id, title: followUp.title };
    if (title !== undefined && existingFu.title !== followUp.title) {
      fuDiff.titleChange = { from: existingFu.title, to: followUp.title };
    }
    if (scheduledAt !== undefined) {
      const oldIso = existingFu.scheduledAt instanceof Date ? existingFu.scheduledAt.toISOString() : existingFu.scheduledAt;
      const newIso = followUp.scheduledAt instanceof Date ? followUp.scheduledAt.toISOString() : followUp.scheduledAt;
      if (oldIso !== newIso) {
        fuDiff.scheduledAtChange = { from: oldIso, to: newIso };
      }
    }
    if (notes !== undefined && existingFu.notes !== followUp.notes) {
      fuDiff.notesChange = {
        from: existingFu.notes ? String(existingFu.notes).slice(0, 200) : null,
        to: followUp.notes ? String(followUp.notes).slice(0, 200) : null,
      };
    }
    await logAudit(req.user!.id, "update_follow_up", auditResource, auditResourceId ?? undefined, fuDiff, req.ip);
  }
  if (isCompletionToggle && completed !== existingFu.completed) {
    await logAudit(req.user!.id, completed ? "complete_follow_up" : "reopen_follow_up", auditResource, auditResourceId ?? undefined, {
      followUpId: id,
      title: followUp.title,
    }, req.ip);
  }
  const [enriched] = await db
    .select({
      id: followUpsTable.id,
      leadId: followUpsTable.leadId,
      studentId: followUpsTable.studentId,
      title: followUpsTable.title,
      scheduledAt: followUpsTable.scheduledAt,
      completed: followUpsTable.completed,
      completedAt: followUpsTable.completedAt,
      notes: followUpsTable.notes,
      createdById: followUpsTable.createdById,
      createdByName: sql<string | null>`(SELECT NULLIF(CONCAT_WS(' ', cu.first_name, cu.last_name), '') FROM users cu WHERE cu.id = ${followUpsTable.createdById})`,
      updatedById: followUpsTable.updatedById,
      updatedByName: sql<string | null>`(SELECT NULLIF(CONCAT_WS(' ', uu.first_name, uu.last_name), '') FROM users uu WHERE uu.id = ${followUpsTable.updatedById})`,
      createdAt: followUpsTable.createdAt,
      updatedAt: followUpsTable.updatedAt,
    })
    .from(followUpsTable)
    .where(eq(followUpsTable.id, id));
  res.json(enriched || followUp);
});

router.get("/follow-ups/upcoming", requireAuth, requireRole(...STAFF_ROLES), async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const userRole = req.user!.role;
  const isAdmin = ADMIN_ROLES.includes(userRole);
  const now = new Date();
  const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const baseConditions = [
    eq(followUpsTable.completed, false),
    lte(followUpsTable.scheduledAt, nextWeek),
    // Hide follow-ups whose linked parents have ALL been soft-deleted.
    // Dual-linked rows stay visible while at least one parent is alive.
    sql`(
      (${followUpsTable.leadId} IS NULL AND ${followUpsTable.studentId} IS NULL)
      OR (${followUpsTable.leadId} IS NOT NULL AND EXISTS (SELECT 1 FROM leads pl WHERE pl.id = ${followUpsTable.leadId} AND pl.deleted_at IS NULL))
      OR (${followUpsTable.studentId} IS NOT NULL AND EXISTS (SELECT 1 FROM students ps WHERE ps.id = ${followUpsTable.studentId} AND ps.deleted_at IS NULL))
    )`,
  ];

  if (isAdmin && req.query.createdById) {
    const filterUserId = parseInt(String(req.query.createdById), 10);
    if (!isNaN(filterUserId)) {
      baseConditions.push(eq(followUpsTable.createdById, filterUserId));
    }
  }

  if (!isAdmin) {
    const leadAssignedOrUnassigned = or(
      sql`(SELECT assigned_to_id FROM leads WHERE leads.id = ${followUpsTable.leadId}) = ${userId}`,
      sql`(SELECT assigned_to_id FROM leads WHERE leads.id = ${followUpsTable.leadId}) IS NULL`
    );

    const studentAssignedOrUnassigned = or(
      sql`(SELECT assigned_to_id FROM students WHERE students.id = ${followUpsTable.studentId}) = ${userId}`,
      sql`(SELECT assigned_to_id FROM students WHERE students.id = ${followUpsTable.studentId}) IS NULL`
    );

    baseConditions.push(
      or(
        and(sql`${followUpsTable.leadId} IS NOT NULL`, leadAssignedOrUnassigned),
        and(sql`${followUpsTable.studentId} IS NOT NULL`, studentAssignedOrUnassigned),
        eq(followUpsTable.assignedToId, userId),
        and(isNull(followUpsTable.leadId), isNull(followUpsTable.studentId), isNull(followUpsTable.assignedToId))
      )!
    );
  }

  const data = await db
    .select({
      id: followUpsTable.id,
      leadId: followUpsTable.leadId,
      studentId: followUpsTable.studentId,
      title: followUpsTable.title,
      scheduledAt: followUpsTable.scheduledAt,
      completed: followUpsTable.completed,
      notes: followUpsTable.notes,
      leadName: sql<string | null>`COALESCE(
        (SELECT concat(first_name, ' ', last_name) FROM leads WHERE leads.id = ${followUpsTable.leadId}),
        (SELECT concat(first_name, ' ', last_name) FROM students WHERE students.id = ${followUpsTable.studentId})
      )`,
      createdByName: sql<string | null>`(SELECT NULLIF(CONCAT_WS(' ', cu.first_name, cu.last_name), '') FROM users cu WHERE cu.id = ${followUpsTable.createdById})`,
      updatedByName: sql<string | null>`(SELECT NULLIF(CONCAT_WS(' ', uu.first_name, uu.last_name), '') FROM users uu WHERE uu.id = ${followUpsTable.updatedById})`,
    })
    .from(followUpsTable)
    .where(and(...baseConditions))
    .orderBy(asc(followUpsTable.scheduledAt))
    .limit(20);
  res.json(data);
});

router.patch("/leads/:id/origin", requireAuth, requireRole("super_admin", "admin"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { originType, originEntityType, originEntityId, originDisplayName } = req.body;
  if (!originType || !["direct", "agent", "sub_agent"].includes(originType)) {
    res.status(400).json({ error: "originType must be direct, agent, or sub_agent" });
    return;
  }
  const [existing] = await db.select().from(leadsTable).where(and(eq(leadsTable.id, id), isNull(leadsTable.deletedAt)));
  if (!existing) { res.status(404).json({ error: "Lead not found" }); return; }

  const oldOrigin = { originType: existing.originType, originEntityType: existing.originEntityType, originEntityId: existing.originEntityId, originDisplayName: existing.originDisplayName };

  const [updated] = await db.update(leadsTable).set({
    originType,
    originEntityType: originEntityType || null,
    originEntityId: originEntityId || null,
    originDisplayName: originDisplayName || null,
    originLocked: true,
  }).where(eq(leadsTable.id, id)).returning();

  await logAudit(req.user!.id, "override_origin", "lead", id, { old: oldOrigin, new: { originType, originEntityType, originEntityId, originDisplayName } }, req.ip);
  res.json(updated);
});

export default router;
