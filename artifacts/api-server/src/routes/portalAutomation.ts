import { Router, type IRouter, raw } from "express";
import { dispatchNotification } from "../lib/notificationDispatcher.js";
import { and, asc, count, desc, eq, getTableColumns, gte, ilike, inArray, isNotNull, isNull, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  applicationsTable,
  studentsTable,
  programsTable,
  universitiesTable,
  portalSubmissionsTable,
  portalUniversitiesTable,
  portalProgramMappingTable,
  portalProgramCacheTable,
  portalAdapterSpecsTable,
  portalAccountUniversitiesTable,
  portalAutomationSettingsTable,
} from "@workspace/db";
import {
  buildWorkbookBuffer,
  parseWorkbookBuffer,
  XLSX_CONTENT_TYPE,
  PROGRAM_MAPPING_KIND,
  PROGRAM_MAPPING_SHEET,
  programMappingColumns,
  type WorkbookSpec,
} from "../lib/exportImportExcel";
import { ImportValidationError } from "../lib/exportImport";
import {
  findActivePortalUniversity,
  resolvePortalRouting,
  resolveStudentPortalRouting,
  scanAndEnqueueTriggerStageApplications,
  MAX_AUTO_FAILED_SUBMISSIONS,
} from "../lib/portalAutoTrigger.js";
import { buildPageMeta, parsePaginationParams } from "@workspace/pagination";
import {
  adapterMetadata,
  resolveAdapterByKey,
  setCredsOverride,
  clearCredsOverride,
  parseAdapterSpec,
  specHasJsHook,
  specIsPrivileged,
  invalidateSpecAdapterCache,
  listSpecVersions,
  matchProgram,
  levelGroup,
  isSitMember,
  type ProgramCandidate,
} from "@workspace/portal-adapters";
import { isAgentRole } from "@workspace/roles";
import { logAudit, requireAuth, requireRole } from "../lib/auth";
import { getAgentVisibleIds } from "../lib/agentVisibility";
import { ADMIN_ROLES, STAFF_ROLES } from "../lib/roles";
import { transliterateToLatin } from "../lib/textNormalize";
import { checkMandatoryDocsForApplication, checkMandatoryDocsForStudent } from "../lib/mandatoryDocs.js";
import { getDocLabel } from "../lib/docNaming.js";
import { getValidated, validate } from "../middlewares/validate";
import {
  claimById,
  claimNext,
  releaseStale,
  heartbeat,
  buildStudentProfile,
  runSubmission,
  writebackResult,
  resolveAdapterKey,
  resolveNationalityExclusion,
  getExperimentalExcludedUniversityKeys,
  type ClaimedSubmission,
  getApplicationMandatoryDocumentStatus,
  syncApplicationFinance,
} from "@workspace/portal-runner";
import { batchPortalCredentialKeys, resolvePortalCreds, checkHasPortalCredentials } from "../lib/portalCreds.js";
import { reconcilePortalUniversityCrmLinks } from "../lib/portalUniversityLinker.js";
import { enqueuePortalSubmissions } from "../lib/portalManualEnqueue.js";
import { prepareApplicationPortalPreflight } from "../lib/portalApplicationPreflight.js";
import {
  diagnosePortalSubmission,
  isDiagnosablePortalStatus,
} from "../lib/portalAiGuardian.js";
import { queuePortalLifecycleReview } from "../lib/portalLifecycleGuardian.js";
import { resolveCanonicalPortalUniversity } from "../lib/portalUniversityResolver.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------
const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });
type IdSchemas = { params: typeof idParamsSchema };

// ---------------------------------------------------------------------------
// POST /applications/:appId/portal-submissions — Enqueue
// ---------------------------------------------------------------------------
const enqueueParamsSchema = z.object({ appId: z.coerce.number().int().positive() });
const enqueueBodySchema = z.object({
  universityKey: z.string().min(1),
  mode: z.enum(["dry", "real"]),
  confirm: z.boolean().optional(),
});
type EnqueueSchemas = { params: typeof enqueueParamsSchema; body: typeof enqueueBodySchema };

router.post(
  "/applications/:appId/portal-submissions",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ params: enqueueParamsSchema, body: enqueueBodySchema }),
  async (req, res): Promise<void> => {
    const { appId } = getValidated<EnqueueSchemas>(req).params;
    const { universityKey, mode, confirm } = getValidated<EnqueueSchemas>(req).body;

    if (mode === "real" && !confirm) {
      res.status(422).json({
        error: "CONFIRM_REQUIRED",
        message: "Set confirm:true to submit in real mode",
      });
      return;
    }

    const user = req.user!;

    const [app] = await db
      .select({ id: applicationsTable.id, studentId: applicationsTable.studentId })
      .from(applicationsTable)
      .where(and(eq(applicationsTable.id, appId), isNull(applicationsTable.deletedAt)));

    if (!app) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    const docStatus = await checkMandatoryDocsForApplication(app.id);
    if (docStatus && docStatus.missing.length > 0) {
      res.status(422).json({
        error: "MISSING_MANDATORY_DOCUMENTS",
        message: "Mandatory documents must be uploaded before portal automation can run.",
        missingDocTypes: docStatus.missing,
        missingDocLabels: docStatus.missing.map(getDocLabel),
      });
      return;
    }

    const portalResolution = await resolveCanonicalPortalUniversity(universityKey);
    if (!portalResolution.ok) {
      const status = portalResolution.reason === "unknown" ? 404 : 409;
      const error = portalResolution.reason === "inactive"
        ? "PORTAL_UNIVERSITY_INACTIVE"
        : portalResolution.reason === "ambiguous"
          ? "AMBIGUOUS_PORTAL_ADAPTER"
          : "UNKNOWN_PORTAL_UNIVERSITY";
      res.status(status).json({
        error,
        message: portalResolution.reason === "ambiguous"
          ? "The adapter key matches multiple portals; submit the canonical university key."
          : "No unique active portal university matches the requested key.",
        matches: portalResolution.matches,
      });
      return;
    }

    const selectedPortalUni = portalResolution.portalUniversity;
    let finalUniversityKey = selectedPortalUni.universityKey;
    let finalUniversityName = selectedPortalUni.universityName;

    // Stamp the canonical adapter this row will run on (multi-portal routing
    // aware). Raw adapter aliases never become queue identities.
    let routedAdapterKey = selectedPortalUni.adapterKey;
    let routingMeta:
      | {
          exclusiveNationalityRoute: "multico";
          routedFromUniversityKey: string;
        }
      | undefined;
    const studentRouting = await resolveStudentPortalRouting({
      routing: { portalUni: selectedPortalUni, target: null },
      studentId: app.studentId,
      applicationId: app.id,
    });
    if (!studentRouting) {
      res.status(409).json({
        error: "PORTAL_ROUTE_UNAVAILABLE",
        message: "The required exclusive portal route is not available.",
      });
      return;
    }
    finalUniversityKey = studentRouting.portalUni.universityKey;
    finalUniversityName =
      studentRouting.submissionUniversityName ??
      studentRouting.portalUni.universityName;
    routedAdapterKey = studentRouting.portalUni.adapterKey;
    routingMeta = studentRouting.routingMeta;
    const preflight = await prepareApplicationPortalPreflight({
      applicationId: app.id,
      adapterKey: routedAdapterKey,
      actorUserId: user.id,
      ip: req.ip,
    });
    if (preflight.supported && !preflight.ready) {
      res.status(422).json({
        error: "PORTAL_PREFLIGHT_NOT_READY",
        message: "Application data is incomplete for the selected portal.",
        preflight,
      });
      return;
    }

    const [row] = await db
      .insert(portalSubmissionsTable)
      .values({
        applicationId: app.id,
        studentId: app.studentId,
        universityKey: finalUniversityKey,
        universityName: finalUniversityName,
        adapterKey: routedAdapterKey,
        mode,
        status: "queued",
        enqueuedBy: user.id,
        meta: { manual: true, preflight, ...(routingMeta ?? {}) },
      })
      .returning();

    await logAudit(
      user.id,
      "enqueue_portal_submission",
      "portal_submission",
      row.id,
      {
        requestedUniversityKey: universityKey,
        universityKey: finalUniversityKey,
        mode,
      },
      req.ip,
    );

    res.status(201).json(row);
  },
);

// ---------------------------------------------------------------------------
// Manual submit — in-memory per-user rate limiter (short window).
// Prevents an admin from hammering the queue; counts /submit calls per user.
// ---------------------------------------------------------------------------
const MANUAL_SUBMIT_WINDOW_MS = 10_000;
const MANUAL_SUBMIT_MAX = 20;
const _manualSubmitHits = new Map<number, number[]>();

function manualSubmitRateLimited(userId: number): boolean {
  const now = Date.now();
  const recent = (_manualSubmitHits.get(userId) ?? []).filter(
    (t) => now - t < MANUAL_SUBMIT_WINDOW_MS,
  );
  recent.push(now);
  _manualSubmitHits.set(userId, recent);
  return recent.length > MANUAL_SUBMIT_MAX;
}

// ---------------------------------------------------------------------------
// POST /portal-automation/submit — manual enqueue of one or many applications
//
// Body: { applicationIds: number[], mode: "dry"|"real", confirm?: boolean }
// The university/adapter is resolved from each application's OWN record
// (findActivePortalUniversity); universityKey is never hardcoded. Queuing only
// inserts status='queued' rows — it never enables auto-process (drain-once
// still keys off portal_universities.autoProcess=true only).
// ---------------------------------------------------------------------------
const manualSubmitBodySchema = z.object({
  applicationIds: z.array(z.coerce.number().int().positive()).min(1).max(100),
  mode: z.enum(["dry", "real"]),
  confirm: z.boolean().optional(),
});
type ManualSubmitSchemas = { body: typeof manualSubmitBodySchema };

router.post(
  "/portal-automation/submit",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ body: manualSubmitBodySchema }),
  async (req, res): Promise<void> => {
    const user = req.user!;
    const { applicationIds, mode, confirm } = getValidated<ManualSubmitSchemas>(req).body;

    if (manualSubmitRateLimited(user.id)) {
      res.status(429).json({ error: "RATE_LIMITED", message: "Too many submissions, slow down." });
      return;
    }

    if (mode === "real" && !confirm) {
      res.status(422).json({
        error: "CONFIRM_REQUIRED",
        message: "Set confirm:true to submit in real mode",
      });
      return;
    }

    const uniqueIds = [...new Set(applicationIds)];

    const { queued, skipped } = await enqueuePortalSubmissions({
      applicationIds: uniqueIds,
      mode,
      userId: user.id,
    });

    // Single-application strictness: surface the precise failure instead of an
    // empty 200 so the per-application "Portala Gönder" button can react.
    if (uniqueIds.length === 1 && queued.length === 0) {
      const only = skipped[0];
      if (only?.reason === "NOT_FOUND") {
        res.status(404).json({ error: "NOT_FOUND" });
        return;
      }
      if (only?.reason === "NO_PORTAL") {
        res.status(400).json({
          error: "NO_PORTAL",
          message: "No active portal university matches this application",
        });
        return;
      }
      if (only?.reason === "MISSING_MANDATORY_DOCUMENTS") {
        res.status(422).json({
          error: "MISSING_MANDATORY_DOCUMENTS",
          message: "Mandatory documents must be uploaded before portal automation can run.",
          missingDocTypes: only.missingDocTypes ?? [],
          missingDocLabels: only.missingDocLabels ?? [],
        });
        return;
      }
      if (only?.reason === "PREFLIGHT_NOT_READY") {
        res.status(422).json({
          error: "PORTAL_PREFLIGHT_NOT_READY",
          message: "Application data is incomplete for the selected portal.",
          missingFields: only.missingFields ?? [],
          incompatibleFields: only.incompatibleFields ?? [],
          missingDocTypes: only.missingDocTypes ?? [],
          missingDocLabels: only.missingDocLabels ?? [],
          autoFilledFields: only.autoFilledFields ?? [],
        });
        return;
      }
      // ALREADY_QUEUED → fall through to a 200 idempotent response.
    }

    await logAudit(
      user.id,
      "portal.manualSubmit",
      "portal_submission",
      queued[0]?.submissionId ?? 0,
      { ids: uniqueIds, mode, queued: queued.length, skipped: skipped.length },
      req.ip,
    );

    res.status(queued.length > 0 ? 201 : 200).json({ queued, skipped });
  },
);

// ---------------------------------------------------------------------------
// GET /portal-automation/eligible-applications — searchable, paginated list of
// applications that can be manually submitted (deleted_at IS NULL AND map to an
// active portal_universities row). Optional filters: stage, universityKey, q.
// ---------------------------------------------------------------------------
const eligibleQuerySchema = z.object({
  stage:         z.string().min(1).optional(),
  universityKey: z.string().min(1).optional(),
  q:             z.string().trim().min(1).optional(),
});
type EligibleSchemas = { query: typeof eligibleQuerySchema };

router.get(
  "/portal-automation/eligible-applications",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ query: eligibleQuerySchema }),
  async (req, res): Promise<void> => {
    const { stage, universityKey, q } = getValidated<EligibleSchemas>(req).query;
    const pageParams = parsePaginationParams(req, { defaultLimit: 20, maxLimit: "small" });

    // An application is submittable when an active portal_universities row
    // matches its university by crmUniversityId (exact) OR name (case-insensitive)
    // OR when its catalog university is an enabled member of an aggregator
    // account (portal_account_universities → aggregator portal row).
    const membershipMatch = sql`${portalUniversitiesTable.universityKey} IN (
      SELECT ${portalAccountUniversitiesTable.portalKey}
      FROM ${portalAccountUniversitiesTable}
      WHERE ${portalAccountUniversitiesTable.catalogUniversityId} = ${applicationsTable.universityId}
        AND ${portalAccountUniversitiesTable.enabled} = TRUE
    )`;
    const joinCondition = and(
      isNull(portalUniversitiesTable.deletedAt),
      eq(portalUniversitiesTable.isActive, true),
      or(
        eq(portalUniversitiesTable.crmUniversityId, applicationsTable.universityId),
        sql`LOWER(${portalUniversitiesTable.universityName}) = LOWER(${applicationsTable.universityName})`,
        membershipMatch,
      ),
    );

    const filters = and(
      isNull(applicationsTable.deletedAt),
      stage !== undefined ? eq(applicationsTable.stage, stage) : undefined,
      universityKey !== undefined ? eq(portalUniversitiesTable.universityKey, universityKey) : undefined,
      q !== undefined
        ? or(
            ilike(studentsTable.firstName, `%${q}%`),
            ilike(studentsTable.lastName, `%${q}%`),
            ilike(studentsTable.email, `%${q}%`),
            sql`CAST(${applicationsTable.id} AS TEXT) = ${q}`,
          )
        : undefined,
    );

    const [{ total }] = await db
      .select({ total: count(sql`DISTINCT ${applicationsTable.id}`) })
      .from(applicationsTable)
      .innerJoin(studentsTable, eq(applicationsTable.studentId, studentsTable.id))
      .innerJoin(portalUniversitiesTable, joinCondition)
      .where(filters);

    const rows = await db
      .selectDistinctOn([applicationsTable.id], {
        id:                  applicationsTable.id,
        stage:               applicationsTable.stage,
        universityName:      applicationsTable.universityName,
        studentFirstName:    studentsTable.firstName,
        studentLastName:     studentsTable.lastName,
        studentEmail:        studentsTable.email,
        portalUniversityKey: portalUniversitiesTable.universityKey,
        portalUniversityName: portalUniversitiesTable.universityName,
      })
      .from(applicationsTable)
      .innerJoin(studentsTable, eq(applicationsTable.studentId, studentsTable.id))
      .innerJoin(portalUniversitiesTable, joinCondition)
      .where(filters)
      // When an application matches BOTH its standalone row and an aggregator
      // membership, DISTINCT ON keeps the first per id — prefer the aggregator.
      .orderBy(desc(applicationsTable.id), sql`CASE WHEN ${membershipMatch} THEN 0 ELSE 1 END`)
      .limit(pageParams.limit)
      .offset(pageParams.offset);

    res.json({ data: rows, ...buildPageMeta(total, pageParams) });
  },
);

// ---------------------------------------------------------------------------
// GET /portal-submissions — List with filters + pagination + isolation
// ---------------------------------------------------------------------------
const listQuerySchema = z.object({
  applicationId: z.coerce.number().int().positive().optional(),
  status: z
    .enum([
      "queued", "running", "submitted", "already_exists", "program_missing",
      "failed", "canceled", "dry_run", "program_full", "exclusive_region",
    ])
    .optional(),
  mode: z.enum(["dry", "real"]).optional(),
  // Comma-separated portal university keys — multi-select filter.
  universityKeys: z.string().trim().min(1).optional(),
  // Case-insensitive student full-name search (matches applications' student).
  studentName: z.string().trim().min(1).optional(),
  // Inclusive date range on portal_submissions.updated_at (ISO datetimes).
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  sortField: z.enum(["createdAt", "updatedAt", "status", "universityKey"]).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
});
type ListSchemas = { query: typeof listQuerySchema };

router.get(
  "/portal-submissions",
  requireAuth,
  validate({ query: listQuerySchema }),
  async (req, res): Promise<void> => {
    const user = req.user!;
    const { applicationId, status, mode, universityKeys, studentName, dateFrom, dateTo, sortField, sortDir } =
      getValidated<ListSchemas>(req).query;
    const pageParams = parsePaginationParams(req, { defaultLimit: 20, maxLimit: "small" });

    const sortColumnMap = {
      createdAt: portalSubmissionsTable.createdAt,
      updatedAt: portalSubmissionsTable.updatedAt,
      status: portalSubmissionsTable.status,
      universityKey: portalSubmissionsTable.universityKey,
    } as const;
    const sortColumn = sortColumnMap[sortField ?? "createdAt"];
    const sortDirFn = sortDir === "asc" ? asc : desc;

    const universityKeyList = universityKeys
      ? universityKeys.split(",").map((k) => k.trim()).filter(Boolean)
      : [];

    // Student-name filter as an EXISTS subquery so the count query needs no join.
    // TR-fold both sides (İ/I/ı/i, dotted/dotless) for accent-insensitive match.
    const nameFold = (col: string) =>
      sql`lower(translate(${sql.raw(col)}, 'İIıçÇğĞöÖşŞüÜ', 'iiicCgGoOsSuU'))`;
    const studentNameCond = studentName
      ? sql`exists (
          select 1 from ${applicationsTable} a
          join ${studentsTable} s on s.id = a.student_id
          where a.id = ${portalSubmissionsTable.applicationId}
            and ${nameFold("concat_ws(' ', s.first_name, s.last_name)")}
                like ${"%" + studentName.toLocaleLowerCase("tr-TR")
                  .replace(/İ/g, "i").replace(/I/g, "i").replace(/ı/g, "i")
                  .replace(/ç/g, "c").replace(/Ç/g, "c")
                  .replace(/ğ/g, "g").replace(/Ğ/g, "g")
                  .replace(/ö/g, "o").replace(/Ö/g, "o")
                  .replace(/ş/g, "s").replace(/Ş/g, "s")
                  .replace(/ü/g, "u").replace(/Ü/g, "u") + "%"}
        )`
      : undefined;

    // Agent isolation: restrict to applications visible to this user
    let visibleAppIds: number[] | null = null;
    if (isAgentRole(user.role)) {
      const visibleAgentIds = await getAgentVisibleIds(user.id, user.role);
      if (visibleAgentIds.length > 0) {
        const apps = await db
          .select({ id: applicationsTable.id })
          .from(applicationsTable)
          .where(
            and(
              isNull(applicationsTable.deletedAt),
              inArray(applicationsTable.agentId, visibleAgentIds),
            ),
          );
        visibleAppIds = apps.map((a) => a.id);
        if (visibleAppIds.length === 0) {
          res.json({ data: [], ...buildPageMeta(0, pageParams) });
          return;
        }
      }
    }

    const where = and(
      isNull(portalSubmissionsTable.deletedAt),
      applicationId !== undefined ? eq(portalSubmissionsTable.applicationId, applicationId) : undefined,
      status !== undefined ? eq(portalSubmissionsTable.status, status) : undefined,
      mode !== undefined ? eq(portalSubmissionsTable.mode, mode) : undefined,
      universityKeyList.length > 0 ? inArray(portalSubmissionsTable.universityKey, universityKeyList) : undefined,
      dateFrom !== undefined ? gte(portalSubmissionsTable.updatedAt, dateFrom) : undefined,
      dateTo !== undefined ? lte(portalSubmissionsTable.updatedAt, dateTo) : undefined,
      studentNameCond,
      visibleAppIds !== null ? inArray(portalSubmissionsTable.applicationId, visibleAppIds) : undefined,
    );

    const [{ total }] = await db
      .select({ total: count() })
      .from(portalSubmissionsTable)
      .where(where);

    const rows = await db
      .select({
        ...getTableColumns(portalSubmissionsTable),
        supersededByApplicationId: applicationsTable.supersededByApplicationId,
        supersededFromApplicationId: applicationsTable.supersededFromApplicationId,
        mainApplicationId: applicationsTable.mainApplicationId,
        // Student full name + the program the automation actually targeted
        // (application is already the superseded/fallback one when applicable).
        studentName: sql<string | null>`nullif(trim(concat_ws(' ', ${studentsTable.firstName}, ${studentsTable.lastName})), '')`,
        programName: applicationsTable.programName,
        programLanguage: applicationsTable.instructionLanguage,
        programLevel: applicationsTable.level,
        // Program name on the ORIGINAL (parent) application when this row is a
        // fallback child — correlated subquery avoids the drizzle alias import.
        // Null for direct (non-superseded) submissions.
        appliedProgramName: sql<string | null>`(
          SELECT a2.program_name
          FROM applications a2
          WHERE a2.id = ${applicationsTable.supersededFromApplicationId}
        )`,
      })
      .from(portalSubmissionsTable)
      .leftJoin(
        applicationsTable,
        eq(applicationsTable.id, portalSubmissionsTable.applicationId),
      )
      .leftJoin(
        studentsTable,
        eq(studentsTable.id, portalSubmissionsTable.studentId),
      )
      .where(where)
      .orderBy(sortDirFn(sortColumn), desc(portalSubmissionsTable.id))
      .limit(pageParams.limit)
      .offset(pageParams.offset);

    // Every attempt carries a chain step label so the board can surface it:
    //   - Fallback children (superseded from another app) keep their PERSISTED
    //     meta.fallbackStep (X2/X3/Y2/Y3 for the automatic chain; null for the
    //     admin-rule path, which is intentionally unlabeled).
    //   - Step-1 original attempts (no supersession parent) are derived: X1 when
    //     the application is the applied/main app itself (same-university), Y1
    //     when it is a fan-out copy pointing at a different-university root.
    const data = rows.map((r) => {
      const persisted =
        (r.meta as { fallbackStep?: string | null } | null)?.fallbackStep ?? null;
      const isChild = r.supersededFromApplicationId != null;
      const fallbackStep = isChild
        ? persisted
        : persisted ??
          (r.mainApplicationId == null || r.mainApplicationId === r.applicationId
            ? "X1"
            : "Y1");
      return { ...r, fallbackStep };
    });

    res.json({ data, ...buildPageMeta(total, pageParams) });
  },
);

// ---------------------------------------------------------------------------
// GET /portal-submissions/universities — distinct universities that appear in
// this user's submissions, for the multi-select filter. MUST be registered
// before /portal-submissions/:id (static segment beats the :id param route).
// ---------------------------------------------------------------------------
router.get(
  "/portal-submissions/universities",
  requireAuth,
  async (req, res): Promise<void> => {
    const user = req.user!;

    let visibleAppIds: number[] | null = null;
    if (isAgentRole(user.role)) {
      const visibleAgentIds = await getAgentVisibleIds(user.id, user.role);
      if (visibleAgentIds.length > 0) {
        const apps = await db
          .select({ id: applicationsTable.id })
          .from(applicationsTable)
          .where(
            and(
              isNull(applicationsTable.deletedAt),
              inArray(applicationsTable.agentId, visibleAgentIds),
            ),
          );
        visibleAppIds = apps.map((a) => a.id);
        if (visibleAppIds.length === 0) {
          res.json({ data: [] });
          return;
        }
      }
    }

    // Job G: source filter options from the canonical portal_universities
    // table so every school appears exactly ONCE with its clean name. The
    // INNER JOIN drops submissions whose universityKey has no canonical row
    // (raw/unmapped keys), and the label is ALWAYS the canonical
    // university_name — never a raw key or a submission's stored spelling.
    // Dedup is by universityKey.
    const rows = await db
      .selectDistinctOn([portalSubmissionsTable.universityKey], {
        key: portalSubmissionsTable.universityKey,
        label: portalUniversitiesTable.universityName,
      })
      .from(portalSubmissionsTable)
      .innerJoin(
        portalUniversitiesTable,
        eq(portalUniversitiesTable.universityKey, portalSubmissionsTable.universityKey),
      )
      .where(
        and(
          isNull(portalSubmissionsTable.deletedAt),
          visibleAppIds !== null ? inArray(portalSubmissionsTable.applicationId, visibleAppIds) : undefined,
        ),
      )
      .orderBy(portalSubmissionsTable.universityKey, asc(portalUniversitiesTable.universityName));

    res.json({ data: rows });
  },
);

// ---------------------------------------------------------------------------
// GET /portal-submissions/:id
// ---------------------------------------------------------------------------
router.get(
  "/portal-submissions/:id",
  requireAuth,
  validate({ params: idParamsSchema }),
  async (req, res): Promise<void> => {
    const user = req.user!;
    const { id } = getValidated<IdSchemas>(req).params;

    const [row] = await db
      .select()
      .from(portalSubmissionsTable)
      .where(and(eq(portalSubmissionsTable.id, id), isNull(portalSubmissionsTable.deletedAt)));

    if (!row) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    // Isolation check for agent roles
    if (isAgentRole(user.role)) {
      const visibleAgentIds = await getAgentVisibleIds(user.id, user.role);
      if (visibleAgentIds.length > 0) {
        const [app] = await db
          .select({ agentId: applicationsTable.agentId })
          .from(applicationsTable)
          .where(eq(applicationsTable.id, row.applicationId));
        if (!app || app.agentId == null || !visibleAgentIds.includes(app.agentId)) {
          res.status(404).json({ error: "NOT_FOUND" });
          return;
        }
      }
    }

    res.json(row);
  },
);

// ---------------------------------------------------------------------------
// POST /portal-submissions/:id/ai-diagnose
// Admin-only, review-only diagnosis. This can spend AI budget, but it never
// retries a submission or mutates an external university portal.
// ---------------------------------------------------------------------------
router.post(
  "/portal-submissions/:id/ai-diagnose",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: idParamsSchema }),
  async (req, res): Promise<void> => {
    const { id } = getValidated<IdSchemas>(req).params;
    const [row] = await db
      .select({ id: portalSubmissionsTable.id, status: portalSubmissionsTable.status })
      .from(portalSubmissionsTable)
      .where(
        and(
          eq(portalSubmissionsTable.id, id),
          isNull(portalSubmissionsTable.deletedAt),
        ),
      );
    if (!row) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    if (!isDiagnosablePortalStatus(row.status)) {
      res.status(409).json({
        error: "NOT_DIAGNOSABLE",
        message: "Only failed, program-missing, or program-full outcomes can be diagnosed",
      });
      return;
    }
    try {
      const guardian = await diagnosePortalSubmission(id, {
        triggeredBy: "manual",
        triggerActor: req.user!.id,
      });
      await logAudit(
        req.user!.id,
        "diagnose_portal_submission",
        "portal_submission",
        id,
        {
          runId: guardian.runId ?? null,
          actionId: guardian.actionId ?? null,
          reused: guardian.reused,
          executionMode: "review_only",
        },
        req.ip,
      );
      res.json({ guardian });
    } catch (error) {
      const code = (error as Error).message;
      if (code === "PORTAL_AI_GUARDIAN_INACTIVE") {
        res.status(409).json({
          error: code,
          message: "Activate the Portal Automation Guardian persona first",
        });
        return;
      }
      if (code === "PORTAL_AI_GUARDIAN_IN_PROGRESS") {
        res.status(409).json({ error: code, message: "Diagnosis is already in progress" });
        return;
      }
      if (code === "PORTAL_AI_GUARDIAN_DAILY_LIMIT") {
        res.status(429).json({
          error: code,
          message: "Portal AI Guardian daily run limit has been reached",
        });
        return;
      }
      console.error(
        `[portal-ai-guardian] manual diagnosis ${id} failed (${(error as Error).name || "Error"})`,
      );
      res.status(500).json({ error: "PORTAL_AI_DIAGNOSIS_FAILED" });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /portal-submissions/:id/retry
// ---------------------------------------------------------------------------
router.post(
  "/portal-submissions/:id/retry",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ params: idParamsSchema }),
  async (req, res): Promise<void> => {
    const user = req.user!;
    const { id } = getValidated<IdSchemas>(req).params;

    const [row] = await db
      .select({ id: portalSubmissionsTable.id, status: portalSubmissionsTable.status })
      .from(portalSubmissionsTable)
      .where(and(eq(portalSubmissionsTable.id, id), isNull(portalSubmissionsTable.deletedAt)));

    if (!row) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    if (row.status !== "failed" && row.status !== "canceled") {
      res.status(409).json({
        error: "NOT_RETRYABLE",
        message: "Only failed or canceled submissions can be retried",
      });
      return;
    }

    const [retryTarget] = await db
      .select({
        applicationId: portalSubmissionsTable.applicationId,
        adapterKey: portalSubmissionsTable.adapterKey,
      })
      .from(portalSubmissionsTable)
      .where(eq(portalSubmissionsTable.id, id))
      .limit(1);
    const docStatus = retryTarget
      ? await checkMandatoryDocsForApplication(retryTarget.applicationId)
      : null;
    if (docStatus && docStatus.missing.length > 0) {
      res.status(422).json({
        error: "MISSING_MANDATORY_DOCUMENTS",
        message: "Mandatory documents must be uploaded before retrying portal automation.",
        missingDocTypes: docStatus.missing,
        missingDocLabels: docStatus.missing.map(getDocLabel),
      });
      return;
    }
    if (retryTarget) {
      const preflight = await prepareApplicationPortalPreflight({
        applicationId: retryTarget.applicationId,
        adapterKey: retryTarget.adapterKey ?? "",
        actorUserId: user.id,
        ip: req.ip,
      });
      if (preflight.supported && !preflight.ready) {
        res.status(422).json({
          error: "PORTAL_PREFLIGHT_NOT_READY",
          message: "Application data is incomplete for this portal.",
          preflight,
        });
        return;
      }
    }

    await db
      .update(portalSubmissionsTable)
      .set({
        status: "queued",
        lockedAt: null,
        lockedBy: null,
        error: null,
        attempts: 0,
        meta: sql`coalesce(${portalSubmissionsTable.meta}, '{}'::jsonb) || '{"manual":true}'::jsonb`,
        resultJson: sql`coalesce(${portalSubmissionsTable.resultJson}, '{}'::jsonb) - 'aiGuardian'`,
      })
      .where(eq(portalSubmissionsTable.id, id));

    await logAudit(user.id, "retry_portal_submission", "portal_submission", id, {}, req.ip);

    res.json({ ok: true });
  },
);

// ---------------------------------------------------------------------------
// POST /portal-submissions/:id/cancel
// ---------------------------------------------------------------------------
router.post(
  "/portal-submissions/:id/cancel",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ params: idParamsSchema }),
  async (req, res): Promise<void> => {
    const user = req.user!;
    const { id } = getValidated<IdSchemas>(req).params;

    const [row] = await db
      .select({ id: portalSubmissionsTable.id, status: portalSubmissionsTable.status })
      .from(portalSubmissionsTable)
      .where(and(eq(portalSubmissionsTable.id, id), isNull(portalSubmissionsTable.deletedAt)));

    if (!row) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    if (row.status !== "queued" && row.status !== "running") {
      res.status(409).json({
        error: "NOT_CANCELABLE",
        message: "Only queued or running submissions can be canceled",
      });
      return;
    }

    await db
      .update(portalSubmissionsTable)
      .set({ status: "canceled" })
      .where(eq(portalSubmissionsTable.id, id));

    await logAudit(user.id, "cancel_portal_submission", "portal_submission", id, {}, req.ip);

    res.json({ ok: true });
  },
);

// ---------------------------------------------------------------------------
// Process-once helper — sequential, eşzaman 1 guaranteed by mutex flag.
// ---------------------------------------------------------------------------

/** Module-level mutex: prevents concurrent manual process runs. */
let _processMutex = false;

/** Submissions running longer than this are candidates for stuck-reset. */
const STUCK_THRESHOLD_MS = 10 * 60_000; // 10 minutes

/** Inline process timeout: responds early while the claimed work continues. */
const INLINE_TIMEOUT_MS = 50_000; // 50 seconds

interface ProcessSingleResult {
  id: number;
  status: "submitted" | "already_exists" | "program_missing" | "program_full" | "exclusive_region" | "failed" | "dry_run" | "skipped" | "requeued" | "running";
  error?: string;
  message?: string;
}

/**
 * Processes a pre-claimed submission with a heartbeat and hard inline timeout.
 *
 * Heartbeat (every 20s): keeps locked_at fresh so the periodic stuck-reset
 * job never fires while work is in flight.
 *
 * Timeout (INLINE_TIMEOUT_MS): if the run takes longer than the HTTP-friendly
 * inline limit, the caller receives { status: "running" } while the original
 * browser process keeps its lock + heartbeat and finishes normally. NEVER
 * requeue live browser work: doing so can launch overlapping portal mutations
 * for the same student and exhaust Chromium memory on long SIT/United wizards.
 */
async function runWithTimeout(
  sub: ClaimedSubmission,
  workerId: string,
  timeoutMs = INLINE_TIMEOUT_MS,
): Promise<ProcessSingleResult> {
  const mandatoryDocs = await getApplicationMandatoryDocumentStatus(sub.applicationId);
  if (!mandatoryDocs || mandatoryDocs.missing.length > 0) {
    const reason = mandatoryDocs
      ? `MISSING_MANDATORY_DOCUMENTS: ${mandatoryDocs.missing.join(", ")}`
      : `MISSING_MANDATORY_DOCUMENTS: application ${sub.applicationId} not found`;
    await writebackResult(sub.id, null, reason, workerId);
    return { id: sub.id, status: "failed", error: reason };
  }

  const hbInterval = setInterval(() => {
    heartbeat(sub.id, workerId).catch(() => {});
  }, 20_000);

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const rawWorkPromise = (async (): Promise<ProcessSingleResult> => {
    const profileResult = await buildStudentProfile(sub.id);
    // Multi-portal routing: if this university routes_via a multi-portal company,
    // resolveAdapterKey returns the company's adapterKey + the routedVia key.
    // routedVia is null on the legacy path → no adapter override is passed, so
    // behaviour is byte-for-byte identical to before this feature.
    const { adapterKey, routedVia, memberUniversityId } =
      await resolveAdapterKey(sub.universityKey);
    if (routedVia) {
      console.log(
        `[portal-process] #${sub.id} routed via multi-portal "${routedVia}" → adapter "${adapterKey}"` +
          (memberUniversityId != null ? ` (member catalog #${memberUniversityId})` : ""),
      );
    }

    let creds: { user: string; password: string } | undefined;
    try {
      // When routed, credentials belong to the multi-portal company (routedVia).
      creds = await resolvePortalCreds(routedVia ?? sub.universityKey, adapterKey);
    } catch (credsErr) {
      if (sub.mode === "real") throw credsErr;
      // dry mode: missing creds → adapter login will fail and be caught
    }

    const runResult = await runSubmission(
      sub,
      profileResult.profile,
      profileResult.files,
      profileResult.tempDir,
      creds,
      routedVia
        ? {
            adapterKey,
            // Junction-routed → load member-level program overrides keyed by
            // (account portal key, member catalog id). routes_via fallback
            // (memberUniversityId null) keeps Phase 2 mapping behaviour.
            ...(memberUniversityId != null
              ? { programMappingKey: routedVia, memberUniversityId }
              : {}),
          }
        : undefined,
    );
    // Enrich resultJson with doc-slot info so skip reasons are surfaced in the UI
    runResult.meta["filledSlots"]  = profileResult.filledSlots;
    runResult.meta["missingSlots"] = profileResult.missingSlots;
    if (routedVia) {
      runResult.meta["routedVia"]      = routedVia;
      runResult.meta["routedAdapter"]  = adapterKey;
    }
    await writebackResult(sub.id, runResult, undefined, workerId);

    // Structural outcomes (exclusive_region, program_full) take precedence over
    // dry_run so the inline API status matches the DB status written by
    // resolveTarget(), which checks them before dryRun.
    const status: ProcessSingleResult["status"] = runResult.result.exclusiveRegion
      ? "exclusive_region"
      : runResult.result.programFull    ? "program_full"
      : runResult.meta["dryRun"]        ? "dry_run"
      : runResult.result.submitted      ? "submitted"
      : runResult.result.alreadyExists  ? "already_exists"
      : runResult.result.programMissing ? "program_missing"
      : "failed";

    return { id: sub.id, status };
  })();
  // Own error writeback inside the work promise so it remains correct even
  // after the HTTP timeout has returned. Keep the heartbeat alive until this
  // exact browser run settles; the timeout race must not release its lock.
  const workPromise = rawWorkPromise
    .catch(async (err): Promise<ProcessSingleResult> => {
      const msg = err instanceof Error ? err.message : String(err);
      await writebackResult(sub.id, null, msg, workerId);
      return { id: sub.id, status: "failed", error: msg };
    })
    .finally(() => {
      clearInterval(hbInterval);
    });

  const timeoutPromise = new Promise<ProcessSingleResult>((resolve) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      console.log(
        `[portal-process] #${sub.id} still running after ${timeoutMs}ms — original lock retained`,
      );
      resolve({
        id: sub.id,
        status: "running",
        message: `İşlem arka planda aynı kilitle devam ediyor`,
      });
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([workPromise, timeoutPromise]);
    clearTimeout(timeoutHandle);
    return result;
  } catch (err) {
    clearTimeout(timeoutHandle);
    if (timedOut) {
      return { id: sub.id, status: "running" };
    }
    const msg = err instanceof Error ? err.message : String(err);
    await writebackResult(sub.id, null, msg, workerId);
    return { id: sub.id, status: "failed", error: msg };
  }
}

/**
 * Claims and processes a single submission by id.
 * Returns "skipped" if the row cannot be claimed (not queued / exhausted / locked).
 */
async function processSingle(
  submissionId: number,
  workerId: string,
): Promise<ProcessSingleResult> {
  const sub = await claimById(submissionId, workerId);
  if (!sub) return { id: submissionId, status: "skipped" };
  return runWithTimeout(sub, workerId);
}

/**
 * Drains the entire queued backlog sequentially (eşzaman 1).  Releases stale
 * locks first, then claims+runs every queued submission with a per-submission
 * inline timeout + heartbeat.  Caller MUST hold _processMutex.  Shared by the
 * manual process-queued endpoint and the Run Now endpoint so the immediate
 * processing path is identical (and interval-independent).
 *
 * When `triggerStages` is provided (Run Now), only submissions whose
 * application is currently in one of those stages are claimed — mirroring the
 * enqueue-time candidate selection. When omitted (manual process-queued), all
 * queued submissions are drained regardless of stage.
 */
async function drainQueue(
  workerId: string,
  triggerStages?: string[],
  excludeUniversityKeys?: string[],
): Promise<ProcessSingleResult[]> {
  const results: ProcessSingleResult[] = [];

  // Release stale locks first (crash recovery: inline requests that died
  // without requeuing leave orphan 'running' rows).
  const staleIds = await releaseStale(STUCK_THRESHOLD_MS);
  if (staleIds.length > 0) {
    console.log(
      `[portal-process] Released ${staleIds.length} stale submission(s): ${staleIds.join(",")}`,
    );
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const sub = await claimNext(workerId, undefined, triggerStages, excludeUniversityKeys);
    if (!sub) break;

    console.log(
      `[portal-process] Processing #${sub.id} uni=${sub.universityKey} mode=${sub.mode} attempt=${sub.attempts}/${sub.maxAttempts}`,
    );
    const result = await runWithTimeout(sub, workerId);
    results.push(result);
    // A timed-out inline run still owns a live browser and heartbeat. Do not
    // claim another row in this API process while it continues in background.
    if (result.status === "running") break;
  }

  return results;
}

// ---------------------------------------------------------------------------
// POST /portal-submissions/process-queued
// Processes ALL queued submissions sequentially; eşzaman 1.
// Runs releaseStale first, then drains with per-submission timeout + heartbeat.
// ---------------------------------------------------------------------------
router.post(
  "/portal-submissions/process-queued",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    if (_processMutex) {
      res.status(409).json({
        error: "ALREADY_RUNNING",
        message: "A portal process run is already in progress on this instance",
      });
      return;
    }

    const user = req.user!;
    const workerId = `api-manual-${user.id}-${Date.now()}`;

    _processMutex = true;
    let results: ProcessSingleResult[] = [];

    try {
      results = await drainQueue(workerId);
    } finally {
      _processMutex = false;
    }

    const processedCount = results.filter(
      (r) => r.status !== "skipped" && r.status !== "requeued",
    ).length;

    await logAudit(
      user.id,
      "process_portal_submissions",
      "portal_submission",
      undefined,
      {
        processed: processedCount,
        results: results.map((r) => ({ id: r.id, status: r.status })),
      },
      req.ip,
    );

    res.json({ processed: processedCount, results });
  },
);

// ---------------------------------------------------------------------------
// POST /portal-automation/run-now
// Admin-only "Run Now": scans every trigger-stage application, enqueues the
// eligible ones (respecting all Automation Rules + dedup), then immediately
// drains the queue in-process — no 10-minute interval wait.
// ---------------------------------------------------------------------------
router.post(
  "/portal-automation/run-now",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const user = req.user!;

    // ----- Gate: global kill-switch -------------------------------------
    const [settings] = await db
      .select()
      .from(portalAutomationSettingsTable)
      .limit(1);

    if (!settings?.isEnabled) {
      res.status(409).json({
        error: "AUTOMATION_DISABLED",
        message: "Portal automation is disabled — enable it before running.",
      });
      return;
    }

    // ----- Enqueue every eligible trigger-stage application -------------
    const summary = await scanAndEnqueueTriggerStageApplications(user.id, settings);

    // ----- Immediately drain the queue (interval-independent) -----------
    // Reuses the exact manual process-queued path (50s inline cap per
    // submission + requeue), guarded by the shared mutex.  If a process run is
    // already in flight we skip draining here — those rows are picked up by the
    // in-flight run (or the always-on worker) within seconds.
    let processed = 0;
    let results: ProcessSingleResult[] = [];
    let drained = false;

    if (!_processMutex) {
      const workerId = `api-runnow-${user.id}-${Date.now()}`;
      _processMutex = true;
      try {
        // Run Now must only process applications currently in a configured
        // trigger stage — same gate as the enqueue scan above.
        results = await drainQueue(workerId, settings.triggerStages ?? []);
        drained = true;
      } finally {
        _processMutex = false;
      }
      processed = results.filter(
        (r) => r.status !== "skipped" && r.status !== "requeued",
      ).length;
    }

    await logAudit(
      user.id,
      "portal.runNow",
      "portal_submission",
      undefined,
      {
        scanned: summary.scanned,
        queued: summary.queued,
        skipped: summary.skipped,
        reasons: summary.reasons,
        processed,
        drained,
      },
      req.ip,
    );

    res.json({
      scanned: summary.scanned,
      queued: summary.queued,
      skipped: summary.skipped,
      reasons: summary.reasons,
      queuedIds: summary.queuedIds,
      processed,
      drained,
      results: results.map((r) => ({ id: r.id, status: r.status })),
    });
  },
);

// ---------------------------------------------------------------------------
// POST /portal-submissions/:id/process
// Processes a SINGLE submission by id; eşzaman 1.
// ---------------------------------------------------------------------------
router.post(
  "/portal-submissions/:id/process",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ params: idParamsSchema }),
  async (req, res): Promise<void> => {
    if (_processMutex) {
      res.status(409).json({
        error: "ALREADY_RUNNING",
        message: "A portal process run is already in progress on this instance",
      });
      return;
    }

    const user = req.user!;
    const { id } = getValidated<IdSchemas>(req).params;
    const workerId = `api-manual-${user.id}-${Date.now()}`;

    // Verify the submission exists and is queued before acquiring mutex
    const [row] = await db
      .select({ id: portalSubmissionsTable.id, status: portalSubmissionsTable.status })
      .from(portalSubmissionsTable)
      .where(and(eq(portalSubmissionsTable.id, id), isNull(portalSubmissionsTable.deletedAt)));

    if (!row) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    if (row.status !== "queued") {
      res.status(409).json({
        error: "NOT_QUEUED",
        message: `Submission #${id} is ${row.status}, not queued`,
      });
      return;
    }

    _processMutex = true;

    try {
      const result = await processSingle(id, workerId);

      await logAudit(
        user.id,
        "process_portal_submission",
        "portal_submission",
        id,
        { status: result.status, error: result.error },
        req.ip,
      );

      res.json({ processed: result.status !== "skipped" && result.status !== "requeued" ? 1 : 0, results: [result] });
    } finally {
      _processMutex = false;
    }
  },
);

// ---------------------------------------------------------------------------
// POST /portal-submissions/reset-stuck
// Resets "running" submissions that have been locked longer than
// thresholdMinutes (default 10) back to "queued".
// Safe to call at any time (idempotent) — used by admin button + startup.
// ---------------------------------------------------------------------------
const resetStuckBodySchema = z.object({
  thresholdMinutes: z.number().int().positive().min(1).max(60).default(10),
});
type ResetStuckSchemas = { body: typeof resetStuckBodySchema };

router.post(
  "/portal-submissions/reset-stuck",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ body: resetStuckBodySchema }),
  async (req, res): Promise<void> => {
    const user = req.user!;
    const { thresholdMinutes } = getValidated<ResetStuckSchemas>(req).body;
    const thresholdMs = thresholdMinutes * 60_000;

    const ids = await releaseStale(thresholdMs);

    if (ids.length > 0) {
      console.log(
        `[portal-stuck-reset] Manual reset: ${ids.length} submission(s) — ids: ${ids.join(",")}`,
      );
    }

    await logAudit(
      user.id,
      "reset_stuck_portal_submissions",
      "portal_submission",
      undefined,
      { thresholdMinutes, reset: ids.length, ids },
      req.ip,
    );

    res.json({ reset: ids.length, ids });
  },
);

// ---------------------------------------------------------------------------
// POST /portal-submissions/bulk-retry — mirrors :id/retry for many rows in
// one UPDATE. Only rows whose current status is retryable are touched;
// everything else is reported back as skipped (no partial-row errors).
// ---------------------------------------------------------------------------
const bulkIdsBodySchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(200),
});
type BulkIdsSchemas = { body: typeof bulkIdsBodySchema };

router.post(
  "/portal-submissions/bulk-retry",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ body: bulkIdsBodySchema }),
  async (req, res): Promise<void> => {
    const user = req.user!;
    const { ids } = getValidated<BulkIdsSchemas>(req).body;

    const eligible = await db
      .select({
        id: portalSubmissionsTable.id,
        applicationId: portalSubmissionsTable.applicationId,
        adapterKey: portalSubmissionsTable.adapterKey,
      })
      .from(portalSubmissionsTable)
      .where(and(
        inArray(portalSubmissionsTable.id, ids),
        isNull(portalSubmissionsTable.deletedAt),
        or(
          eq(portalSubmissionsTable.status, "failed"),
          eq(portalSubmissionsTable.status, "canceled"),
          eq(portalSubmissionsTable.status, "dry_run"),
        ),
      ));
    const docChecks = await Promise.all(
      eligible.map(async (row) => ({
        row,
        status: await checkMandatoryDocsForApplication(row.applicationId),
      })),
    );
    const docReady = docChecks
      .filter(({ status }) => status !== null && status.missing.length === 0)
      .map(({ row }) => row);
    const missingMandatory = docChecks
      .filter(({ status }) => status !== null && status.missing.length > 0)
      .map(({ row, status }) => ({
        id: row.id,
        missingDocTypes: status!.missing,
        missingDocLabels: status!.missing.map(getDocLabel),
      }));
    const preflightReady: number[] = [];
    const preflightBlocked: Array<{
      id: number;
      missingFields: string[];
      incompatibleFields: Array<{ field: string; reason: string }>;
      missingDocuments: string[];
      autoFilledFields: string[];
    }> = [];
    // Deliberately sequential: a bulk retry may contain hundreds of rows and
    // preflight can invoke document extraction. Avoid an uncontrolled burst of
    // AI calls and object-storage downloads.
    for (const row of docReady) {
      const preflight = await prepareApplicationPortalPreflight({
        applicationId: row.applicationId,
        adapterKey: row.adapterKey ?? "",
        actorUserId: user.id,
        ip: req.ip,
      });
      if (preflight.supported && !preflight.ready) {
        preflightBlocked.push({
          id: row.id,
          missingFields: preflight.missingFields,
          incompatibleFields: preflight.incompatibleFields,
          missingDocuments: preflight.missingDocuments,
          autoFilledFields: preflight.autoFilledFields,
        });
      } else {
        preflightReady.push(row.id);
      }
    }
    const eligibleIds = preflightReady;

    if (eligibleIds.length > 0) {
      await db
        .update(portalSubmissionsTable)
        .set({
          status: "queued",
          lockedAt: null,
          lockedBy: null,
          error: null,
          attempts: 0,
          meta: sql`coalesce(${portalSubmissionsTable.meta}, '{}'::jsonb) || '{"manual":true}'::jsonb`,
          resultJson: sql`coalesce(${portalSubmissionsTable.resultJson}, '{}'::jsonb) - 'aiGuardian'`,
        })
        .where(inArray(portalSubmissionsTable.id, eligibleIds));
    }

    await logAudit(
      user.id,
      "bulk_retry_portal_submissions",
      "portal_submission",
      undefined,
      { requested: ids, retried: eligibleIds },
      req.ip,
    );

    res.json({
      retried: eligibleIds.length,
      ids: eligibleIds,
      skipped: ids.filter((id) => !eligibleIds.includes(id)),
      missingMandatory,
      preflightBlocked,
    });
  },
);

// ---------------------------------------------------------------------------
// POST /portal-submissions/bulk-cancel — mirrors :id/cancel for many rows.
// ---------------------------------------------------------------------------
router.post(
  "/portal-submissions/bulk-cancel",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ body: bulkIdsBodySchema }),
  async (req, res): Promise<void> => {
    const user = req.user!;
    const { ids } = getValidated<BulkIdsSchemas>(req).body;

    const eligible = await db
      .select({ id: portalSubmissionsTable.id })
      .from(portalSubmissionsTable)
      .where(and(
        inArray(portalSubmissionsTable.id, ids),
        isNull(portalSubmissionsTable.deletedAt),
        or(
          eq(portalSubmissionsTable.status, "queued"),
          eq(portalSubmissionsTable.status, "running"),
        ),
      ));
    const eligibleIds = eligible.map((r) => r.id);

    if (eligibleIds.length > 0) {
      await db
        .update(portalSubmissionsTable)
        .set({ status: "canceled" })
        .where(inArray(portalSubmissionsTable.id, eligibleIds));
    }

    await logAudit(
      user.id,
      "bulk_cancel_portal_submissions",
      "portal_submission",
      undefined,
      { requested: ids, canceled: eligibleIds },
      req.ip,
    );

    res.json({
      canceled: eligibleIds.length,
      ids: eligibleIds,
      skipped: ids.filter((id) => !eligibleIds.includes(id)),
    });
  },
);

// ---------------------------------------------------------------------------
// POST /portal-submissions/bulk-process — processes only the given (queued)
// ids sequentially, reusing the same eşzaman-1 pipeline as process-queued /
// the single :id/process route. Guarded by the same module-level mutex.
// ---------------------------------------------------------------------------
router.post(
  "/portal-submissions/bulk-process",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ body: bulkIdsBodySchema }),
  async (req, res): Promise<void> => {
    if (_processMutex) {
      res.status(409).json({
        error: "ALREADY_RUNNING",
        message: "A portal process run is already in progress on this instance",
      });
      return;
    }

    const user = req.user!;
    const { ids } = getValidated<BulkIdsSchemas>(req).body;
    const workerId = `api-bulk-${user.id}-${Date.now()}`;

    _processMutex = true;
    const results: ProcessSingleResult[] = [];
    try {
      for (const id of ids) {
        const result = await processSingle(id, workerId);
        results.push(result);
        if (result.status === "running") break;
      }
    } finally {
      _processMutex = false;
    }

    const processedCount = results.filter(
      (r) => r.status !== "skipped" && r.status !== "requeued",
    ).length;

    await logAudit(
      user.id,
      "bulk_process_portal_submissions",
      "portal_submission",
      undefined,
      {
        requested: ids,
        processed: processedCount,
        results: results.map((r) => ({ id: r.id, status: r.status })),
      },
      req.ip,
    );

    res.json({ processed: processedCount, results });
  },
);

// ---------------------------------------------------------------------------
// POST /portal-automation/apply-to-all — fan-out ONE application to ALL active
// portal universities that have an adapter + credentials configured.
//
// Body: { applicationId, mode: "dry"|"real", confirm?: boolean }
//
// Per candidate university:
//   - exclusion (nationality/region)                → outcome "excluded" (skip)
//   - program match at the SAME level (exact-first via matchProgram, then fuzzy;
//     no same-level programme / no confident match) → outcome "no-program"
//   - dedup/reuse the student's existing application at that university, else
//     create one from the matched CATALOG programme (fees/level/language copied
//     from the catalog, never from the source app)
//   - dedup an active (queued/running) submission    → outcome "duplicate"
//   - otherwise enqueue a queued submission          → outcome "queued"
//
// After enqueueing, a background drain is triggered (NON-BLOCKING) so queued
// rows process immediately per the chosen mode — the HTTP response returns the
// per-university result list right away instead of blocking for minutes. REUSES
// the existing queue / matcher / exclusion core (no parallel engine).
// ---------------------------------------------------------------------------
const applyToAllBodySchema = z.object({
  applicationId: z.coerce.number().int().positive(),
  mode: z.enum(["dry", "real"]),
  confirm: z.boolean().optional(),
});
type ApplyToAllSchemas = { body: typeof applyToAllBodySchema };

type ApplyToAllOutcome =
  | "queued"
  | "excluded"
  | "no-program"
  | "missing-docs"
  | "duplicate"
  | "failed";

interface ApplyToAllItem {
  universityKey: string;
  universityName: string;
  outcome: ApplyToAllOutcome;
  message?: string;
  applicationId?: number;
  submissionId?: number;
  programName?: string;
  confidence?: number;
}

// ---------------------------------------------------------------------------
// Shared apply-to-all fan-out core (reused by the single endpoint AND the bulk
// endpoint — no parallel engine / no copy-paste).
// ---------------------------------------------------------------------------

/** Env-var credential fallback — mirrors GET /university-portals exactly. */
function envHasKey(k: string): boolean {
  const K = k.toUpperCase().replace(/-/g, "_");
  return !!(
    (process.env[`${K}_EMAIL`] || process.env[`${K}_USER`]) &&
    process.env[`${K}_PASSWORD`]
  );
}

interface CredentialReadyUniversity {
  universityKey: string;
  universityName: string;
  adapterKey: string;
  crmUniversityId: number;
}

/**
 * Loads the fan-out target universities: active, not deleted, mapped to a CRM
 * university (crm_university_id set so catalog programmes are resolvable) AND
 * credential-ready (DB row or env vars). Credential gate mirrors
 * GET /university-portals exactly. Shared by the single + bulk endpoints so both
 * target the exact same set (and universitiesTargeted counts match).
 */
async function loadCredentialReadyPortalUniversities(): Promise<CredentialReadyUniversity[]> {
  const [dbCredKeys, unis] = await Promise.all([
    batchPortalCredentialKeys(),
    db
      .select({
        universityKey:   portalUniversitiesTable.universityKey,
        universityName:  portalUniversitiesTable.universityName,
        adapterKey:      portalUniversitiesTable.adapterKey,
        crmUniversityId: portalUniversitiesTable.crmUniversityId,
      })
      .from(portalUniversitiesTable)
      .where(
        and(
          eq(portalUniversitiesTable.isActive, true),
          isNull(portalUniversitiesTable.deletedAt),
          isNotNull(portalUniversitiesTable.crmUniversityId),
        ),
      ),
  ]);

  return unis
    .filter(
      (uni) =>
        dbCredKeys.has(uni.adapterKey) ||
        dbCredKeys.has(uni.universityKey) ||
        envHasKey(uni.adapterKey),
    )
    .map((uni) => ({
      universityKey:   uni.universityKey,
      universityName:  uni.universityName,
      adapterKey:      uni.adapterKey,
      crmUniversityId: uni.crmUniversityId as number,
    }));
}

/**
 * Fan-out ONE application to the given credential-ready universities. Per
 * candidate university: exclusion → "excluded"; same-level program match
 * (exact-first via matchProgram, then fuzzy) → "no-program"; else advisory-
 * locked reuse/create application + dedup/enqueue submission → "duplicate" /
 * "queued". Does NOT trigger the drain, audit, or rate-limit — callers own those
 * so the bulk loop drains/audits once. REUSES the existing queue / matcher /
 * exclusion core.
 */
async function fanOutApplicationToUniversities(
  srcApp: typeof applicationsTable.$inferSelect,
  unis: CredentialReadyUniversity[],
  mode: "dry" | "real",
  userId: number,
  /**
   * Aggregator routing (SIT/United). When set, every submission is enqueued on
   * the aggregator's universityKey (its adapter + credentials) while the
   * candidate's own name/CRM id name the MEMBER school to select inside the
   * portal — written to submission.meta exactly as enqueueIfEligible does. The
   * application row (and its dedup) still keys on the member CRM university.
   * Omitted → identical legacy behavior (apply-to-all / bulk are unchanged).
   */
  routeVia?: { universityKey: string; adapterKey: string },
): Promise<ApplyToAllItem[]> {
  const [student] = await db
    .select({ nationality: studentsTable.nationality })
    .from(studentsTable)
    .where(eq(studentsTable.id, srcApp.studentId))
    .limit(1);
  const nationality = student?.nationality ?? null;

  const sourceProgramName = srcApp.programName ?? "";
  const sourceLevel = levelGroup(srcApp.level);

  const results: ApplyToAllItem[] = [];
  const preflightByAdapter = new Map<
    string,
    Promise<Awaited<ReturnType<typeof prepareApplicationPortalPreflight>>>
  >();

  for (const uni of unis) {
    const crmUniversityId = uni.crmUniversityId;
    // When routing via an aggregator, the submission is keyed on the aggregator
    // key (so dedup/adapter/credentials all resolve to it); otherwise the
    // candidate's own key. Each member still gets its own application row, so
    // (applicationId, submissionKey) stays unique per member.
    const submissionKey = routeVia?.universityKey ?? uni.universityKey;
    // Dedup scope: the legacy manual path treats only in-flight rows
    // (queued/running) as duplicates so a completed run can be retried from the
    // button. The aggregator-routed AUTO path additionally treats a prior
    // "submitted" row as a duplicate, so re-triggering on later stage changes is
    // idempotent (gap-filling only) and never double-submits a member. Failed
    // rows stay retryable in both paths.
    const submissionDedupStatuses: ("queued" | "running" | "submitted")[] =
      routeVia ? ["queued", "running", "submitted"] : ["queued", "running"];
    try {
      const adapterKey = routeVia?.adapterKey ?? uni.adapterKey;
      let preflightPromise = preflightByAdapter.get(adapterKey);
      if (!preflightPromise) {
        // The target programme is guaranteed to be the same level and is
        // resolved below. Readiness fields/documents belong to the same student,
        // so the source application is a safe, mutation-free preflight input.
        // Cache per adapter to avoid repeating AI extraction for every member.
        preflightPromise = prepareApplicationPortalPreflight({
          applicationId: srcApp.id,
          adapterKey,
          actorUserId: userId,
        });
        preflightByAdapter.set(adapterKey, preflightPromise);
      }
      const preflight = await preflightPromise;
      if (preflight.supported && !preflight.ready) {
        results.push({
          universityKey: uni.universityKey,
          universityName: uni.universityName,
          outcome:
            preflight.missingDocuments.length > 0
              ? "missing-docs"
              : "failed",
          message:
            `PORTAL_PREFLIGHT_NOT_READY` +
            ` fields=${preflight.missingFields.join(",") || "-"}` +
            ` documents=${preflight.missingDocuments.join(",") || "-"}`,
        });
        continue;
      }

      // --- Exclusion (nationality / exclusive region) ---
      // Check the SAME key the runner will use at submit time (the submission
      // key), so the preventive pre-filter and the reactive runner agree.
      const excl = await resolveNationalityExclusion(submissionKey, nationality);
      if (excl.excluded) {
        results.push({
          universityKey:  uni.universityKey,
          universityName: uni.universityName,
          outcome:        "excluded",
          message:        excl.agencyName ?? undefined,
        });
        continue;
      }

      // --- Program match at the SAME level ---
      const programs = await db
        .select({
          id:              programsTable.id,
          name:            programsTable.name,
          degree:          programsTable.degree,
          language:        programsTable.language,
          tuitionFee:      programsTable.tuitionFee,
          discountedFee:   programsTable.discountedFee,
          scholarship:     programsTable.scholarship,
          commissionRate:  programsTable.commissionRate,
          serviceFeeAmount: programsTable.serviceFeeAmount,
          applicationFee:  programsTable.applicationFee,
          depositFee:      programsTable.depositFee,
          advancedFee:     programsTable.advancedFee,
          languageFee:     programsTable.languageFee,
          currency:        programsTable.currency,
        })
        .from(programsTable)
        .where(
          and(
            eq(programsTable.universityId, crmUniversityId),
            eq(programsTable.isActive, true),
          ),
        );

      // When the source has a known level, only same-level programmes are
      // eligible (mandatory level match). Unknown source level → match by
      // name across all programmes (best effort).
      const candidatePrograms = sourceLevel
        ? programs.filter((p) => levelGroup(p.degree) === sourceLevel)
        : programs;

      if (candidatePrograms.length === 0) {
        results.push({
          universityKey:  uni.universityKey,
          universityName: uni.universityName,
          outcome:        "no-program",
        });
        continue;
      }

      const candidates: ProgramCandidate[] = candidatePrograms.map((p) => ({
        id:   String(p.id),
        name: p.name,
      }));
      const matched = matchProgram(sourceProgramName, candidates);
      if (!matched) {
        results.push({
          universityKey:  uni.universityKey,
          universityName: uni.universityName,
          outcome:        "no-program",
        });
        continue;
      }
      const program = candidatePrograms.find((p) => String(p.id) === matched.match.id)!;

      const docStatus = await checkMandatoryDocsForStudent(
        program.id,
        srcApp.studentId,
        program.degree,
      );
      if (docStatus.missing.length > 0) {
        results.push({
          universityKey: uni.universityKey,
          universityName: uni.universityName,
          outcome: "missing-docs",
          message: docStatus.missing.map(getDocLabel).join(", "),
        });
        continue;
      }

      // --- Dedup + reuse/create application, then dedup + enqueue submission.
      // Serialize both with transaction-scoped Postgres advisory locks
      // (studentId, crmUniversityId) for the application and
      // (applicationId, universityKey) for the submission — the latter mirrors
      // enqueueIfEligible so all enqueue paths serialize on the same key.
      const now = new Date();
      const txOutcome = await db.transaction(
        async (
          tx,
        ): Promise<
          | { kind: "duplicate"; appId: number; subId: number }
          | { kind: "queued"; appId: number; subId: number }
        > => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(${srcApp.studentId}, ${crmUniversityId})`,
          );

          let appId: number;
          const [existingApp] = await tx
            .select({ id: applicationsTable.id })
            .from(applicationsTable)
            .where(
              and(
                eq(applicationsTable.studentId, srcApp.studentId),
                eq(applicationsTable.universityId, crmUniversityId),
                isNull(applicationsTable.deletedAt),
              ),
            )
            .limit(1);

          if (existingApp) {
            appId = existingApp.id;
          } else {
            const [newApp] = await tx
              .insert(applicationsTable)
              .values({
                studentId:           srcApp.studentId,
                leadId:              srcApp.leadId,
                programId:           program.id,
                universityId:        crmUniversityId,
                agentId:             srcApp.agentId,
                assignedToId:        srcApp.assignedToId,
                season:              srcApp.season,
                stage:               "inquiry",
                level:               program.degree ?? srcApp.level ?? null,
                instructionLanguage: program.language ?? null,
                programName:         program.name,
                universityName:      uni.universityName,
                country:             srcApp.country,
                tuitionFee:          program.tuitionFee ?? null,
                discountedFee:       program.discountedFee ?? null,
                scholarship:         program.scholarship ?? null,
                commissionRate:      program.commissionRate ?? null,
                serviceFeeAmount:    program.serviceFeeAmount ?? null,
                applicationFee:      program.applicationFee ?? null,
                depositFee:          program.depositFee ?? null,
                advancedFee:         program.advancedFee ?? null,
                languageFee:         program.languageFee ?? null,
                currency:            program.currency ?? null,
                // Origin attribution copied verbatim from the source application.
                originType:          srcApp.originType,
                originEntityType:    srcApp.originEntityType,
                originEntityId:      srcApp.originEntityId,
                originDisplayName:   srcApp.originDisplayName,
                originLocked:        srcApp.originLocked,
                originStudentId:     srcApp.originStudentId,
                branchId:            srcApp.branchId,
                // Portal-automation fan-out (apply-to-all / apply-to-all-bulk).
                createdSource:       "automation",
                // Root/main application of the fallback chain: the student's
                // originally-applied app (or its own root if the source is itself
                // a chain member). Lets each fan-out hop recover the applied
                // programme/language/level and detect same-uni (X) vs diff-uni (Y).
                mainApplicationId:   srcApp.mainApplicationId ?? srcApp.id,
                createdAt:           now,
                updatedAt:           now,
              })
              .returning({ id: applicationsTable.id });
            appId = newApp.id;
          }

          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(${appId}, hashtext(${submissionKey}))`,
          );

          const [existingSub] = await tx
            .select({ id: portalSubmissionsTable.id })
            .from(portalSubmissionsTable)
            .where(
              and(
                eq(portalSubmissionsTable.applicationId, appId),
                eq(portalSubmissionsTable.universityKey, submissionKey),
                inArray(portalSubmissionsTable.status, submissionDedupStatuses),
                isNull(portalSubmissionsTable.deletedAt),
              ),
            )
            .limit(1);

          if (existingSub) {
            return { kind: "duplicate", appId, subId: existingSub.id };
          }

          // AUTO (aggregator-routed) fan-out only: cap cross-row retries.
          // Failed rows are outside submissionDedupStatuses, so a repeatedly
          // failing member would otherwise get a fresh queued row on every
          // auto re-trigger — an infinite loop that also blocks the queue.
          // The legacy manual apply-to-all path keeps failed rows retryable
          // (a human clicked, not a loop).
          if (routeVia) {
            const [failedCnt] = await tx
              .select({ n: sql<number>`count(*)::int` })
              .from(portalSubmissionsTable)
              .where(
                and(
                  eq(portalSubmissionsTable.applicationId, appId),
                  eq(portalSubmissionsTable.universityKey, submissionKey),
                  eq(portalSubmissionsTable.status, "failed"),
                  isNull(portalSubmissionsTable.deletedAt),
                ),
              );
            if ((failedCnt?.n ?? 0) >= MAX_AUTO_FAILED_SUBMISSIONS) {
              console.warn(
                `[portal-fanout] app=${appId} uni=${submissionKey}: ` +
                  `${failedCnt!.n} başarısız deneme — otomatik fan-out yeniden kuyruklama durduruldu (max_failures)`,
              );
              return { kind: "duplicate", appId, subId: 0 };
            }
          }

          const [subRow] = await tx
            .insert(portalSubmissionsTable)
            .values({
              applicationId:  appId,
              studentId:      srcApp.studentId,
              universityKey:  submissionKey,
              universityName: uni.universityName,
              // Aggregator-routed rows run on the aggregator's adapter;
              // direct fan-out rows on the candidate's own adapter.
              adapterKey:     routeVia ? routeVia.adapterKey : uni.adapterKey,
              mode,
              status:         "queued",
              enqueuedBy:     userId,
              // Aggregator routing (SIT): name the member school for the runner
              // to select inside the portal — mirrors enqueueIfEligible exactly.
              ...(routeVia
                ? {
                    meta: {
                      targetCatalogUniversityId: crmUniversityId,
                      targetUniversityName:      uni.universityName,
                      routedViaAggregator:       routeVia.universityKey,
                    },
                  }
                : {}),
            })
            .returning({ id: portalSubmissionsTable.id });

          return { kind: "queued", appId, subId: subRow.id };
        },
      );

      // Fan-out application creation bypasses the normal applications route.
      // Reconcile finance here so the new row immediately receives the same
      // commission/service-fee treatment as a manually-created application.
      await syncApplicationFinance(txOutcome.appId);

      results.push({
        universityKey:  uni.universityKey,
        universityName: uni.universityName,
        outcome:        txOutcome.kind === "duplicate" ? "duplicate" : "queued",
        applicationId:  txOutcome.appId,
        submissionId:   txOutcome.subId,
        programName:    program.name,
        confidence:     matched.conf,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[apply-to-all] uni=${uni.universityKey} failed:`, msg);
      results.push({
        universityKey:  uni.universityKey,
        universityName: uni.universityName,
        outcome:        "failed",
        message:        msg,
      });
    }
  }

  return results;
}

/** Tally per-outcome counts for an apply-to-all result list. */
function computeApplyToAllCounts(results: ApplyToAllItem[]) {
  return {
    queued:    results.filter((r) => r.outcome === "queued").length,
    excluded:  results.filter((r) => r.outcome === "excluded").length,
    noProgram: results.filter((r) => r.outcome === "no-program").length,
    duplicate: results.filter((r) => r.outcome === "duplicate").length,
    failed:    results.filter((r) => r.outcome === "failed").length,
  };
}

/**
 * Notify that work is queued for the dedicated portal worker.
 *
 * When `triggerStages` is provided (auto-enqueue immediate drain), only
 * submissions whose application is currently in one of those stages are
 * claimed — same stage-gating convention as Run Now. When omitted (fan-out /
 * manual call sites), all queued submissions are drained regardless of stage.
 *
 * Portal browsers must never run fire-and-forget inside the API process. Long
 * SIT/United wizards exceed the API's inline response window; the historical
 * requeue path then launched overlapping Chromium sessions for one submission.
 * The always-on worker polls every five seconds and is the single owner.
 */
export function triggerBackgroundDrain(label: string, triggerStages?: string[]): void {
  void triggerStages;
  console.log(`[${label}] queued for dedicated portal worker`);
}

// ---------------------------------------------------------------------------
// Portal-agnostic 3-mode fan-out system
//
// Fan-out mode is DB-driven (portal_automation_settings.fan_out_mode for the
// global default; portal_universities.fan_out_mode for per-university overrides).
//
//   'off'    — no fan-out; only submit to the directly applied university (default).
//   'manual' — operator presses the "Fan-out" button to trigger for an application.
//   'auto'   — fan out automatically when a student reaches a trigger stage.
//
// The master kill-switch (settings.isEnabled=false) forces 'off' regardless.
// Legacy SIT_AUTO_FANOUT env is honoured as a fallback for the SIT aggregator
// when the DB does not explicitly set it to a non-default value.
//
// Target universities:
//   • Multi-portal aggregator (SIT, United…): members of that aggregator,
//     routed via the aggregator key (existing behaviour).
//   • Direct portal (Topkapi, etc.): all credential-ready, CRM-linked universities.
// ---------------------------------------------------------------------------

/** The SIT aggregator's portal key / adapter key (kept for routing checks). */
const SIT_AGGREGATOR_KEY = "sit";

/**
 * Resolve the effective fan-out mode for a given portal university key.
 *
 * Priority:
 *   1. Master kill-switch: if settings.isEnabled === false → always 'off'.
 *   2. Per-university override (portal_universities.fan_out_mode, non-null).
 *   3. Legacy SIT_AUTO_FANOUT env (for SIT key only, when DB has not set auto).
 *   4. Global default (portal_automation_settings.fan_out_mode, default 'off').
 *
 * @param universityKey  The resolved portal university key (after routing).
 * @param settings       Pre-fetched settings row (optional, avoids extra query).
 */
async function resolveFanOutMode(
  universityKey: string,
  settings?: typeof portalAutomationSettingsTable.$inferSelect,
): Promise<"off" | "manual" | "auto"> {
  const s = settings ??
    (await db.select().from(portalAutomationSettingsTable).limit(1))[0];

  // Master kill-switch always wins.
  if (!s?.isEnabled) return "off";

  // Per-university override (null = inherit).
  const [uni] = await db
    .select({ fanOutMode: portalUniversitiesTable.fanOutMode })
    .from(portalUniversitiesTable)
    .where(and(
      eq(portalUniversitiesTable.universityKey, universityKey),
      isNull(portalUniversitiesTable.deletedAt),
    ))
    .limit(1);

  const uniMode = uni?.fanOutMode as "off" | "manual" | "auto" | null | undefined;
  if (uniMode) return uniMode;

  // Legacy SIT_AUTO_FANOUT env compatibility: only applies to the SIT key and
  // only when the DB global is still at the default ('off' or unset).
  const globalMode = (s as { fanOutMode?: string }).fanOutMode as "off" | "manual" | "auto" | undefined;
  if (universityKey === SIT_AGGREGATOR_KEY && (!globalMode || globalMode === "off")) {
    const v = (process.env.SIT_AUTO_FANOUT ?? "").trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes" || v === "on") return "auto";
  }

  return globalMode ?? "off";
}

/**
 * Load the fan-out candidate universities for a MULTI-PORTAL aggregator.
 * Returns the aggregator's enabled member universities, each carrying the
 * member's CRM id + name (for program-match + application creation) and the
 * aggregator's key + adapter (for routing + credentials).
 * Returns [] when the aggregator row is missing or inactive.
 */
async function loadAggregatorMemberUniversities(
  aggregatorKey: string,
): Promise<CredentialReadyUniversity[]> {
  const [aggregator] = await db
    .select({
      universityKey: portalUniversitiesTable.universityKey,
      adapterKey:    portalUniversitiesTable.adapterKey,
    })
    .from(portalUniversitiesTable)
    .where(and(
      eq(portalUniversitiesTable.universityKey, aggregatorKey),
      eq(portalUniversitiesTable.isActive, true),
      isNull(portalUniversitiesTable.deletedAt),
    ))
    .limit(1);
  if (!aggregator) return [];

  const members = await db
    .select({
      catalogUniversityId: portalAccountUniversitiesTable.catalogUniversityId,
      name:                universitiesTable.name,
    })
    .from(portalAccountUniversitiesTable)
    .innerJoin(
      universitiesTable,
      eq(universitiesTable.id, portalAccountUniversitiesTable.catalogUniversityId),
    )
    .where(and(
      eq(portalAccountUniversitiesTable.portalKey, aggregatorKey),
      eq(portalAccountUniversitiesTable.enabled, true),
    ));

  // For the SIT aggregator, additionally gate on the agreed membership allowlist.
  const filtered = aggregatorKey === SIT_AGGREGATOR_KEY
    ? members.filter((m) => isSitMember(m.name))
    : members;

  return filtered.map((m) => ({
    universityKey:   aggregator.universityKey,
    universityName:  m.name,
    adapterKey:      aggregator.adapterKey,
    crmUniversityId: m.catalogUniversityId,
  }));
}

/**
 * Fire-and-forget: portal-agnostic automatic fan-out gate.
 *
 * Called from enqueueOnStageChange (stage-change hook) for every application
 * whose university resolves to a portal with fanOutMode='auto'.
 *
 * Steps:
 *   1. Master kill-switch (settings.isEnabled) — early return.
 *   2. Trigger-stage gate — fan-out only when app is at a configured stage.
 *   3. Resolve portal routing for the application's university.
 *   4. resolveFanOutMode — return unless 'auto'.
 *   5. Credential check on the resolved portal.
 *   6. Load target universities (aggregator members OR all credential-ready).
 *   7. fanOutApplicationToUniversities — dedup+enqueue.
 *
 * Idempotent: re-invocation only fills gaps (dedup). Never throws.
 */
export async function maybeFanOutStudentForApplication(
  applicationId: number,
  actorUserId: number,
): Promise<void> {
  try {
    const [settings] = await db
      .select()
      .from(portalAutomationSettingsTable)
      .limit(1);
    if (!settings?.isEnabled) return;

    const [srcApp] = await db
      .select()
      .from(applicationsTable)
      .where(and(eq(applicationsTable.id, applicationId), isNull(applicationsTable.deletedAt)))
      .limit(1);
    if (!srcApp) return;

    // Gate on trigger stage — fan out only when the app is at a stage that
    // would itself be auto-submitted, so auto fan-out and per-app enqueue agree.
    const triggerStages = Array.isArray(settings.triggerStages)
      ? (settings.triggerStages as string[])
      : [];
    if (!triggerStages.includes(String(srcApp.stage))) return;

    // Resolve the portal (and aggregator routing) for this application.
    const routing = await resolvePortalRouting({
      universityId:   srcApp.universityId ?? null,
      universityName: srcApp.universityName ?? null,
    });
    if (!routing) return;

    const portalKey = routing.portalUni.universityKey;

    // Check fan-out mode for the resolved portal key.
    const fanOutMode = await resolveFanOutMode(portalKey, settings);
    if (fanOutMode !== "auto") return;

    // Credential check — mirrors the per-app enqueue gate so we never enqueue
    // rows that can't run.
    if (!await checkHasPortalCredentials(portalKey, routing.portalUni.adapterKey)) {
      console.warn(`[portal-fanout] skipped app=${applicationId}: credentials missing for ${portalKey}`);
      return;
    }

    // Target university selection:
    //   Multi-portal aggregator → load its member universities (routeVia set).
    //   Direct portal           → all credential-ready unis except the source.
    let unis: CredentialReadyUniversity[];
    let routeVia: { universityKey: string; adapterKey: string } | undefined;

    if (routing.portalUni.isMultiPortal) {
      unis    = await loadAggregatorMemberUniversities(portalKey);
      routeVia = { universityKey: portalKey, adapterKey: routing.portalUni.adapterKey };
    } else {
      unis = (await loadCredentialReadyPortalUniversities())
        .filter((u) => u.universityKey !== portalKey);
    }

    if (unis.length === 0) return;

    const mode = settings.mode === "real" ? "real" : "dry";
    const results = await fanOutApplicationToUniversities(srcApp, unis, mode, actorUserId, routeVia);
    const counts  = computeApplyToAllCounts(results);

    if (counts.queued > 0) triggerBackgroundDrain(`fanout-${actorUserId}`);

    await logAudit(
      actorUserId,
      "portal.autoFanOut",
      "student",
      srcApp.studentId,
      {
        applicationId,
        portalKey,
        mode,
        unis: unis.length,
        ...counts,
        total: results.length,
      },
    );

    console.log(
      `[portal-fanout] app=${applicationId} student=${srcApp.studentId}` +
      ` portal=${portalKey} mode=${mode} unis=${unis.length}` +
      ` queued=${counts.queued} excluded=${counts.excluded}` +
      ` noProgram=${counts.noProgram} duplicate=${counts.duplicate} failed=${counts.failed}`,
    );
  } catch (err) {
    console.error(`[portal-fanout] failed for app=${applicationId}:`, err);
  }
}

/**
 * Backward-compat alias — applications.ts still imports this name.
 * Delegates to the portal-agnostic maybeFanOutStudentForApplication.
 */
export const maybeFanOutSitStudentForApplication = maybeFanOutStudentForApplication;

// ---------------------------------------------------------------------------
// POST /portal-automation/applications/:id/fanout — Manual fan-out for one app
//
// Fans out a single application to all credential-ready universities right now,
// regardless of the fan-out mode (operator decision). The only hard gate is the
// master kill-switch (settings.isEnabled=false → 409). Idempotent: re-triggering
// only fills gaps (dedup). Submission Mode (settings.mode) decides dry vs real.
// ---------------------------------------------------------------------------
const fanoutParamsSchema = z.object({ id: z.coerce.number().int().positive() });
type FanoutSchemas = { params: typeof fanoutParamsSchema };

router.post(
  "/portal-automation/applications/:id/fanout",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  validate({ params: fanoutParamsSchema }),
  async (req, res): Promise<void> => {
    const user = req.user!;
    const { id: applicationId } = getValidated<FanoutSchemas>(req).params;

    // Master kill-switch: isEnabled=false → manual fan-out also blocked.
    const [settings] = await db.select().from(portalAutomationSettingsTable).limit(1);
    if (!settings?.isEnabled) {
      res.status(409).json({
        error: "PORTAL_DISABLED",
        message: "Portal automation is disabled. Enable it in settings before fanning out.",
      });
      return;
    }

    const [srcApp] = await db
      .select()
      .from(applicationsTable)
      .where(and(eq(applicationsTable.id, applicationId), isNull(applicationsTable.deletedAt)))
      .limit(1);
    if (!srcApp) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    // Fan out to all credential-ready universities (same pool as apply-to-all).
    const unis  = await loadCredentialReadyPortalUniversities();
    const mode  = settings.mode === "real" ? "real" : "dry";
    const results = await fanOutApplicationToUniversities(srcApp, unis, mode, user.id);
    const counts  = computeApplyToAllCounts(results);

    if (counts.queued > 0) triggerBackgroundDrain(`manual-fanout-${user.id}`);

    await logAudit(
      user.id,
      "portal.manualFanOut",
      "application",
      applicationId,
      { mode, unis: unis.length, ...counts, total: results.length },
      req.ip,
    );

    res.json({
      created:  counts.queued,
      excluded: counts.excluded,
      noProgram: counts.noProgram,
      duplicate: counts.duplicate,
      failed:   counts.failed,
      total:    results.length,
    });
  },
);

router.post(
  "/portal-automation/apply-to-all",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ body: applyToAllBodySchema }),
  async (req, res): Promise<void> => {
    const user = req.user!;
    const { applicationId, mode, confirm } = getValidated<ApplyToAllSchemas>(req).body;

    if (manualSubmitRateLimited(user.id)) {
      res.status(429).json({ error: "RATE_LIMITED", message: "Too many submissions, slow down." });
      return;
    }
    if (mode === "real" && !confirm) {
      res.status(422).json({
        error: "CONFIRM_REQUIRED",
        message: "Set confirm:true to submit in real mode",
      });
      return;
    }

    // ----- Source application ----------------------------------------------
    const [srcApp] = await db
      .select()
      .from(applicationsTable)
      .where(and(eq(applicationsTable.id, applicationId), isNull(applicationsTable.deletedAt)))
      .limit(1);
    if (!srcApp) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    // Fan-out via the shared core (credential-ready, CRM-linked universities).
    const unis = await loadCredentialReadyPortalUniversities();
    const results = await fanOutApplicationToUniversities(srcApp, unis, mode, user.id);
    const counts = computeApplyToAllCounts(results);

    // ----- Trigger a background drain (non-blocking) -----------------------
    if (counts.queued > 0) triggerBackgroundDrain(`applyall-${user.id}`);

    await logAudit(
      user.id,
      "portal.applyToAll",
      "application",
      applicationId,
      { mode, ...counts, total: results.length },
      req.ip,
    );

    res.status(counts.queued > 0 ? 201 : 200).json({ mode, results, counts });
  },
);

// ---------------------------------------------------------------------------
// GET /portal-automation/apply-to-all-bulk/count — preview for the bulk confirm
// dialog: how many trigger-stage applications would fan out, and how many
// credential-ready universities they'd target. Read-only, no side effects.
// ---------------------------------------------------------------------------
router.get(
  "/portal-automation/apply-to-all-bulk/count",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (_req, res): Promise<void> => {
    const [settings] = await db
      .select()
      .from(portalAutomationSettingsTable)
      .limit(1);
    const triggerStages = Array.isArray(settings?.triggerStages)
      ? (settings.triggerStages as string[])
      : [];

    if (triggerStages.length === 0) {
      res.json({ applications: 0, universities: 0, triggerStages: [] });
      return;
    }

    const [row] = await db
      .select({ n: count() })
      .from(applicationsTable)
      .where(and(
        inArray(applicationsTable.stage, triggerStages),
        isNull(applicationsTable.deletedAt),
      ));

    const unis = await loadCredentialReadyPortalUniversities();
    res.json({
      applications: Number(row?.n ?? 0),
      universities: unis.length,
      triggerStages,
    });
  },
);

// ---------------------------------------------------------------------------
// POST /portal-automation/apply-to-all-bulk — fan out EVERY application that is
// currently in a configured trigger stage to ALL credential-ready portal
// universities. Thin wrapper over the SAME shared fan-out core used by the
// single apply-to-all endpoint (no parallel engine). Existing per-university
// dedup means already-submitted (student+university) pairs are skipped, so
// re-runs never double-submit. Terminal stages are excluded automatically
// because they are never configured as trigger stages.
//
// Body: { mode: "dry"|"real", confirm?: boolean }
// ---------------------------------------------------------------------------
const applyToAllBulkBodySchema = z.object({
  mode: z.enum(["dry", "real"]),
  confirm: z.boolean().optional(),
});
type ApplyToAllBulkSchemas = { body: typeof applyToAllBulkBodySchema };

router.post(
  "/portal-automation/apply-to-all-bulk",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ body: applyToAllBulkBodySchema }),
  async (req, res): Promise<void> => {
    const user = req.user!;
    const { mode, confirm } = getValidated<ApplyToAllBulkSchemas>(req).body;

    if (manualSubmitRateLimited(user.id)) {
      res.status(429).json({ error: "RATE_LIMITED", message: "Too many submissions, slow down." });
      return;
    }
    if (mode === "real" && !confirm) {
      res.status(422).json({
        error: "CONFIRM_REQUIRED",
        message: "Set confirm:true to submit in real mode",
      });
      return;
    }

    // ----- Resolve trigger stages from settings ----------------------------
    const [settings] = await db
      .select()
      .from(portalAutomationSettingsTable)
      .limit(1);
    const triggerStages = Array.isArray(settings?.triggerStages)
      ? (settings.triggerStages as string[])
      : [];
    if (triggerStages.length === 0) {
      res.status(409).json({
        error: "NO_TRIGGER_STAGES",
        message: "No trigger stages configured — select at least one before bulk submitting.",
      });
      return;
    }

    // ----- Source applications (trigger-stage, non-deleted) ----------------
    const srcApps = await db
      .select()
      .from(applicationsTable)
      .where(and(
        inArray(applicationsTable.stage, triggerStages),
        isNull(applicationsTable.deletedAt),
      ))
      .orderBy(asc(applicationsTable.id));

    // ----- Fan out each application via the shared core --------------------
    const unis = await loadCredentialReadyPortalUniversities();
    const allResults: ApplyToAllItem[] = [];
    for (const srcApp of srcApps) {
      const results = await fanOutApplicationToUniversities(srcApp, unis, mode, user.id);
      allResults.push(...results);
    }
    const counts = computeApplyToAllCounts(allResults);

    // ----- Trigger a background drain (non-blocking) -----------------------
    if (counts.queued > 0) triggerBackgroundDrain(`applyallbulk-${user.id}`);

    await logAudit(
      user.id,
      "portal.applyToAllBulk",
      "application",
      undefined,
      {
        mode,
        applications: srcApps.length,
        universities: unis.length,
        ...counts,
        total: allResults.length,
      },
      req.ip,
    );

    res.status(counts.queued > 0 ? 201 : 200).json({
      mode,
      applications: srcApps.length,
      universities: unis.length,
      counts,
    });
  },
);

// ---------------------------------------------------------------------------
// GET /university-portals
// Returns active portal universities that have credentials configured.
// Used by app-detail Submit dropdown — shows only credential-ready entries.
// ---------------------------------------------------------------------------
router.get("/university-portals", requireAuth, async (_req, res): Promise<void> => {
  const [dbCredKeys, unis] = await Promise.all([
    batchPortalCredentialKeys(),
    db
      .select({
        universityKey: portalUniversitiesTable.universityKey,
        universityName: portalUniversitiesTable.universityName,
        adapterKey: portalUniversitiesTable.adapterKey,
      })
      .from(portalUniversitiesTable)
      .where(
        and(
          eq(portalUniversitiesTable.isActive, true),
          isNull(portalUniversitiesTable.deletedAt),
        ),
      ),
  ]);

  function envHasKey(k: string): boolean {
    const K = k.toUpperCase().replace(/-/g, "_");
    return !!(
      (process.env[`${K}_EMAIL`] || process.env[`${K}_USER`]) &&
      process.env[`${K}_PASSWORD`]
    );
  }

  // --- Step 1: DB-registered universities with credentials ---
  const seenAdapterKeys = new Set<string>();
  const result: { key: string; label: string; adapterKey: string; hasCredentials: boolean }[] = [];

  for (const { universityKey, universityName, adapterKey } of unis) {
    const hasCredentials =
      dbCredKeys.has(adapterKey) || dbCredKeys.has(universityKey) || envHasKey(adapterKey);
    if (hasCredentials) {
      result.push({ key: universityKey, label: universityName, adapterKey, hasCredentials: true });
      seenAdapterKeys.add(adapterKey);
    }
  }

  // --- Step 2: Registry adapters with credentials NOT yet in the DB list ---
  // Covers the case where portal_credentials has the key but portal_universities
  // hasn't been seeded yet (e.g. fresh PROD deploy).
  for (const { key: aKey, label } of adapterMetadata()) {
    if (seenAdapterKeys.has(aKey)) continue;
    const hasCredentials = dbCredKeys.has(aKey) || envHasKey(aKey);
    if (hasCredentials) {
      result.push({ key: aKey, label, adapterKey: aKey, hasCredentials: true });
    }
  }

  res.json(result);
});

// ---------------------------------------------------------------------------
// POST /portal-automation/relink-universities
//
// Manually triggers the portal ⇄ CRM university auto-linker. Fills
// portal_universities.crm_university_id by Turkish-aware name matching so
// fan-out can see each portal university's CRM program catalog. Never
// wrong-links: ambiguous names are left NULL and surfaced as `unmatched`.
// `force` recomputes even already-linked rows (still safe).
// ---------------------------------------------------------------------------
const relinkUniversitiesBodySchema = z.object({
  force: z.boolean().optional(),
});
type RelinkUniversitiesSchemas = { body: typeof relinkUniversitiesBodySchema };

router.post(
  "/portal-automation/relink-universities",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ body: relinkUniversitiesBodySchema }),
  async (req, res): Promise<void> => {
    const { force } = getValidated<RelinkUniversitiesSchemas>(req).body;
    const result = await reconcilePortalUniversityCrmLinks({ force: !!force });
    logAudit(
      req.user!.id,
      "relink_portal_universities",
      "portal_universities",
      undefined,
      {
        force: !!force,
        linked: result.linked.length,
        alreadyLinked: result.alreadyLinked,
        unmatched: result.unmatched.length,
        stale: result.stale.length,
      },
      req.ip,
    );
    res.json(result);
  },
);

// ---------------------------------------------------------------------------
// Background job: periodic stuck-reset
// ---------------------------------------------------------------------------

/**
 * Starts a setInterval that periodically resets stuck portal_submissions.
 * Call once at api-server startup (safe on every instance — releaseStale is
 * idempotent and the DB UPDATE is atomic).
 */
let portalStuckResetTimer: ReturnType<typeof setInterval> | null = null;

export function startPortalStuckReset(intervalMs = 5 * 60_000): () => void {
  if (portalStuckResetTimer) return stopPortalStuckReset;
  const run = (): void => {
    releaseStale(STUCK_THRESHOLD_MS)
      .then((ids) => {
        if (ids.length > 0) {
          console.log(
            `[portal-stuck-reset] Auto-reset ${ids.length} submission(s): ${ids.join(",")}`,
          );
        }
      })
      .catch((err) => {
        console.error("[portal-stuck-reset] Error:", err);
      });
  };
  portalStuckResetTimer = setInterval(run, intervalMs);
  console.log(
    `[portal-stuck-reset] Started — interval=${intervalMs}ms threshold=${STUCK_THRESHOLD_MS}ms`,
  );
  return stopPortalStuckReset;
}

export function stopPortalStuckReset(): void {
  if (portalStuckResetTimer) clearInterval(portalStuckResetTimer);
  portalStuckResetTimer = null;
}

// ---------------------------------------------------------------------------
// Background job: scheduled auto-drain (Scheduled Auto-Process ON)
// ---------------------------------------------------------------------------

/** How often the scheduler checks whether a scheduled drain is due. */
const AUTO_DRAIN_TICK_MS = 60_000; // 1 minute

/** Fallback drain interval when the settings column is unset. */
const DEFAULT_AUTO_PROCESS_INTERVAL_MIN = 20;

/** Outcome of one scheduler tick — exported shape for the test script. */
export type AutoDrainTickResult =
  | { ran: false; reason: "disabled" | "scheduled_off" | "interval_not_elapsed" | "already_running" }
  | { ran: true; claimed: number; processed: number };

/**
 * One scheduled-drain tick. Loads settings fresh each tick so toggling the
 * Scheduled Auto-Process switch (or the kill-switch) takes effect without a
 * restart. Drains only when:
 *
 *   1. isEnabled (global kill-switch — single gate, nothing runs when off)
 *   2. autoProcessEnabled (Scheduled Auto-Process toggle)
 *   3. `auto_process_interval_minutes` have elapsed since last_auto_drain_at
 *      (never-drained → due immediately)
 *   4. no drain currently in flight (_processMutex)
 *
 * The drain passes settings.triggerStages so scheduled drains respect the
 * configured stage filter (same claimNext gating convention as Run Now).
 * last_auto_drain_at is updated only after a completed drain, so a failed
 * drain is retried on the next tick.
 *
 * Exported separately from startPortalAutoDrain so the test script can drive
 * ticks deterministically without timers.
 */
export async function runPortalAutoDrainTick(): Promise<AutoDrainTickResult> {
  const [settings] = await db
    .select()
    .from(portalAutomationSettingsTable)
    .limit(1);

  if (!settings?.isEnabled)       return { ran: false, reason: "disabled" };
  if (!settings.autoProcessEnabled) return { ran: false, reason: "scheduled_off" };

  const intervalMin =
    settings.autoProcessIntervalMinutes ?? DEFAULT_AUTO_PROCESS_INTERVAL_MIN;
  const lastMs = settings.lastAutoDrainAt
    ? new Date(settings.lastAutoDrainAt).getTime()
    : 0;
  if (Date.now() - lastMs < intervalMin * 60_000) {
    return { ran: false, reason: "interval_not_elapsed" };
  }

  if (_processMutex) return { ran: false, reason: "already_running" };

  const workerId = `api-autodrain-${Date.now()}`;

  // Adapter auto-graduation: scheduled drains never process submissions whose
  // portal adapter is still experimental (non-graduated). Manual (meta.manual)
  // rows bypass the exclusion inside claimNext, like every other gate.
  const excludeUniversityKeys = await getExperimentalExcludedUniversityKeys();

  _processMutex = true;
  let results: ProcessSingleResult[] = [];
  try {
    results = await drainQueue(workerId, settings.triggerStages ?? [], excludeUniversityKeys);
  } finally {
    _processMutex = false;
  }

  await db
    .update(portalAutomationSettingsTable)
    .set({ lastAutoDrainAt: new Date() })
    .where(eq(portalAutomationSettingsTable.id, settings.id));

  const processed = results.filter(
    (r) => r.status !== "skipped" && r.status !== "requeued",
  ).length;
  if (results.length > 0) {
    console.log(
      `[portal-auto-drain] Scheduled drain done — claimed=${results.length} processed=${processed}`,
    );
  }
  return { ran: true, claimed: results.length, processed };
}

/**
 * Starts the periodic scheduled-drain checker. Call once at api-server
 * startup, next to startPortalStuckReset. Errors are caught and logged per
 * tick — the interval never crashes the process.
 */
export function startPortalAutoDrain(intervalMs = AUTO_DRAIN_TICK_MS): void {
  const run = (): void => {
    runPortalAutoDrainTick().catch((err) => {
      console.error("[portal-auto-drain] Tick error:", err);
    });
  };
  setInterval(run, intervalMs);
  console.log(`[portal-auto-drain] Started — tick=${intervalMs}ms`);
}

// ---------------------------------------------------------------------------
// Background job: periodic multico status sync
// ---------------------------------------------------------------------------

/**
 * Map a raw Multico portal status string to an internal portal_submission_status
 * enum value. Returns null when the status is not yet terminal (i.e. the
 * canonical row status should remain "submitted" while only result_json is
 * updated).
 *
 * Terminal → internal mapping:
 *   Accepted / Approved  → "accepted"
 *   Rejected / Declined  → "rejected"
 *   anything else        → null  (keep "submitted", just update result_json)
 */
function mapMulticoPortalStatus(
  raw: string,
): "accepted" | "rejected" | null {
  const lower = raw.toLowerCase().trim();
  if (lower.includes("accept") || lower.includes("approv")) return "accepted";
  if (lower.includes("reject") || lower.includes("declin")) return "rejected";
  return null;
}

/**
 * One status-sync sweep: queries portal_submissions rows that were submitted
 * to the Multico adapter (status="submitted", adapter_key="multico") and for
 * each row calls the adapter's checkStatus() method to refresh the remote
 * application status.
 *
 * For every changed status the sweep:
 *   1. Writes result_json.portalStatus + portalStatusCheckedAt (always).
 *   2. Writes portal_submissions.status to "accepted"/"rejected" when the
 *      Multico portal signals a terminal decision.
 *   3. Emits a dispatchNotification for accepted/rejected transitions so
 *      staff are informed without manually checking the portal.
 *
 * Exported so a run-now API endpoint can invoke it on demand.
 */
export async function runPortalStatusSync(): Promise<{ checked: number; updated: number }> {
  const rows = await db
    .select({
      id:            portalSubmissionsTable.id,
      applicationId: portalSubmissionsTable.applicationId,
      studentId:     portalSubmissionsTable.studentId,
      externalRef:   portalSubmissionsTable.externalRef,
      resultJson:    portalSubmissionsTable.resultJson,
    })
    .from(portalSubmissionsTable)
    .where(
      and(
        eq(portalSubmissionsTable.status, "submitted"),
        eq(portalSubmissionsTable.adapterKey, "multico"),
        isNotNull(portalSubmissionsTable.externalRef),
      ),
    )
    .limit(20);

  if (rows.length === 0) return { checked: 0, updated: 0 };

  const adapter = await resolveAdapterByKey("multico");
  if (!adapter?.checkStatus) return { checked: rows.length, updated: 0 };

  let session: Awaited<ReturnType<typeof adapter.login>> | undefined;
  let updated = 0;
  try {
    const creds = await resolvePortalCreds("multico").catch(() => null);
    if (!creds) {
      console.warn("[portal-status-sync] multico credentials not configured — skipping sweep");
      return { checked: rows.length, updated: 0 };
    }
    session = await adapter.login({ credentials: creds, headless: true });

    for (const row of rows) {
      if (!row.externalRef) continue;
      try {
        const result = await adapter.checkStatus!(session, row.externalRef);
        if (!result) continue;

        const prevPortalStatus = (row.resultJson as Record<string, unknown> | null)?.portalStatus as string | undefined;
        if (result.status === prevPortalStatus) continue;  // nothing changed

        const internalStatus = mapMulticoPortalStatus(result.status);
        const newResultJson = {
          ...(row.resultJson as Record<string, unknown> ?? {}),
          portalStatus:          result.status,
          portalStatusCheckedAt: new Date().toISOString(),
        };

        if (internalStatus) {
          // Terminal decision — transition portal_submissions.status too.
          await db
            .update(portalSubmissionsTable)
            .set({
              status:     internalStatus,
              resultJson: newResultJson,
              updatedAt:  new Date(),
            })
            .where(eq(portalSubmissionsTable.id, row.id));

          // Look up student name + university for the notification body.
          const [appRow] = await db
            .select({
              universityName: applicationsTable.universityName,
              programName:    applicationsTable.programName,
              assignedToId:   applicationsTable.assignedToId,
            })
            .from(applicationsTable)
            .where(eq(applicationsTable.id, row.applicationId))
            .limit(1);

          let studentName = "student";
          if (row.studentId) {
            const [sRow] = await db
              .select({ firstName: studentsTable.firstName, lastName: studentsTable.lastName })
              .from(studentsTable)
              .where(eq(studentsTable.id, row.studentId))
              .limit(1);
            if (sRow) studentName = `${sRow.firstName ?? ""} ${sRow.lastName ?? ""}`.trim() || studentName;
          }

          const uniName = appRow?.universityName ?? "Multico University";
          const progName = appRow?.programName ?? "";
          const isAccepted = internalStatus === "accepted";
          const eventLabel = isAccepted ? "Accepted" : "Rejected";

          const recipientUserIds: number[] = [];
          if (appRow?.assignedToId) recipientUserIds.push(appRow.assignedToId);

          dispatchNotification({
            event:    `portal.application_${internalStatus}`,
            title:    `Portal Application ${eventLabel}`,
            body:     `${studentName}'s application to ${uniName}${progName ? ` / ${progName}` : ""} was ${eventLabel.toLowerCase()} on the Multico portal.`,
            actionUrl: `/staff/applications/${row.applicationId}`,
            icon:     isAccepted ? "CheckCircle" : "XCircle",
            recipientUserIds: recipientUserIds.length > 0 ? recipientUserIds : undefined,
            templateVars: {
              studentName,
              universityName: uniName,
              programName: progName,
              portalStatus: result.status,
            },
          }).catch(() => {});

          console.log(
            `[portal-status-sync] multico submission #${row.id} (app #${row.applicationId}): ` +
            `portalStatus ${prevPortalStatus ?? "?"} → ${result.status} (internal: ${internalStatus})`,
          );
        } else {
          // Non-terminal status change — update result_json only.
          await db
            .update(portalSubmissionsTable)
            .set({ resultJson: newResultJson, updatedAt: new Date() })
            .where(eq(portalSubmissionsTable.id, row.id));

          console.log(
            `[portal-status-sync] multico submission #${row.id}: portalStatus ` +
            `${prevPortalStatus ?? "?"} → ${result.status} (non-terminal, keeping status=submitted)`,
          );
        }

        await queuePortalLifecycleReview({
          submissionId: row.id,
          applicationId: row.applicationId,
          rawStatus: result.status,
        }).catch((error) => {
          console.warn(
            `[portal-lifecycle] submission #${row.id} proposal failed:`,
            error,
          );
        });

        updated++;
      } catch (err) {
        console.warn(`[portal-status-sync] multico #${row.id} check failed:`, err);
      }
    }
  } finally {
    await session?.close().catch(() => {});
  }

  return { checked: rows.length, updated };
}

/**
 * Starts the periodic multico status-sync sweep. Call once at api-server
 * startup. Default interval is 10 minutes — deliberately generous to avoid
 * hammering the portal.
 */
let portalStatusSyncTimer: ReturnType<typeof setInterval> | null = null;

export function startPortalStatusSync(intervalMs = 10 * 60_000): () => void {
  if (portalStatusSyncTimer) return stopPortalStatusSync;
  const run = (): void => {
    runPortalStatusSync().catch((err) => {
      console.error("[portal-status-sync] Sweep error:", err);
    });
  };
  portalStatusSyncTimer = setInterval(run, intervalMs);
  console.log(`[portal-status-sync] Started — interval=${intervalMs}ms`);
  return stopPortalStatusSync;
}

export function stopPortalStatusSync(): void {
  if (portalStatusSyncTimer) clearInterval(portalStatusSyncTimer);
  portalStatusSyncTimer = null;
}

// ===========================================================================
// PROGRAM EŞLEME (FAZ 1) — LIVE program options + CRM→portal program mapping
// ===========================================================================

/** Live portal login timeout for listPrograms (mirrors test-login). */
const PROGRAM_LOGIN_TIMEOUT_MS = 90_000;
/** Program option cache TTL — entries older than this are refetched. */
const PROGRAM_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** Races a promise against a timeout, rejecting with `msg` if it elapses. */
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
  ]);
}

/**
 * Resolves an active (non-deleted) portal_universities row by universityKey.
 * Returns null when the key is unknown — callers respond 404.
 */
async function getPortalUniversity(
  universityKey: string,
): Promise<typeof portalUniversitiesTable.$inferSelect | null> {
  const [uni] = await db
    .select()
    .from(portalUniversitiesTable)
    .where(
      and(
        eq(portalUniversitiesTable.universityKey, universityKey),
        isNull(portalUniversitiesTable.deletedAt),
      ),
    )
    .limit(1);
  return uni ?? null;
}

const uniKeyParamsSchema = z.object({ key: z.string().min(1) });
type UniKeyParams = { params: typeof uniKeyParamsSchema };

// ---------------------------------------------------------------------------
// GET /portal-automation/universities/:key/program-options?level=&refresh=0|1
//
// Returns the portal's LIVE program option list ({ v, t }[]). Served from the
// portal_program_cache table; on cache miss / stale (>TTL) / refresh=1 the
// adapter is driven headless to fetch fresh options, which are then cached.
// ---------------------------------------------------------------------------
const programOptionsQuerySchema = z.object({
  level: z.string().optional(),
  refresh: z.coerce.number().int().optional(),
});
type ProgramOptionsSchemas = {
  params: typeof uniKeyParamsSchema;
  query: typeof programOptionsQuerySchema;
};

router.get(
  "/portal-automation/universities/:key/program-options",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: uniKeyParamsSchema, query: programOptionsQuerySchema }),
  async (req, res): Promise<void> => {
    const { key } = getValidated<ProgramOptionsSchemas>(req).params;
    const { level: levelRaw, refresh } = getValidated<ProgramOptionsSchemas>(req).query;
    const level = (levelRaw ?? "").trim();
    const forceRefresh = refresh === 1;

    const uni = await getPortalUniversity(key);
    if (!uni) {
      res.status(404).json({ error: "UNIVERSITY_NOT_FOUND" });
      return;
    }

    // Cache read (keyed by universityKey + normalized level).
    const [cached] = await db
      .select()
      .from(portalProgramCacheTable)
      .where(
        and(
          eq(portalProgramCacheTable.universityKey, key),
          eq(portalProgramCacheTable.level, level),
        ),
      )
      .limit(1);

    const isStale =
      !cached || Date.now() - cached.fetchedAt.getTime() > PROGRAM_CACHE_TTL_MS;

    if (cached && !isStale && !forceRefresh) {
      res.json({
        options: cached.options,
        cached: true,
        stale: false,
        fetchedAt: cached.fetchedAt,
      });
      return;
    }

    // Live fetch via the adapter.
    const adapter = await resolveAdapterByKey(uni.adapterKey);
    if (!adapter) {
      res.status(404).json({
        error: "ADAPTER_NOT_FOUND",
        message: `Adapter bulunamadı: '${uni.adapterKey}'`,
      });
      return;
    }
    if (typeof adapter.listPrograms !== "function") {
      res.status(400).json({
        error: "NOT_SUPPORTED",
        message: `Adapter '${uni.adapterKey}' program listelemeyi desteklemiyor`,
      });
      return;
    }

    let session: Awaited<ReturnType<typeof adapter.login>> | null = null;
    try {
      const creds = await resolvePortalCreds(key, uni.adapterKey);
      setCredsOverride(adapter.key, { user: creds.user, password: creds.password });
      session = await withTimeout(
        adapter.login({ headless: true }),
        PROGRAM_LOGIN_TIMEOUT_MS,
        "Login zaman aşımına uğradı",
      );
      const options = await withTimeout(
        adapter.listPrograms(session, level || undefined),
        PROGRAM_LOGIN_TIMEOUT_MS,
        "Program listesi zaman aşımına uğradı",
      );

      // Upsert cache (university_key, level) — refresh options + fetchedAt.
      const [row] = await db
        .insert(portalProgramCacheTable)
        .values({ universityKey: key, level, options })
        .onConflictDoUpdate({
          target: [
            portalProgramCacheTable.universityKey,
            portalProgramCacheTable.level,
          ],
          set: { options, fetchedAt: new Date() },
        })
        .returning();

      res.json({
        options: row.options,
        cached: false,
        stale: false,
        fetchedAt: row.fetchedAt,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const safe = msg
        .replace(/password[^\s]*/gi, "***")
        .replace(/token[^\s]*/gi, "***");
      res.status(502).json({ error: "PORTAL_ERROR", message: safe });
    } finally {
      clearCredsOverride(adapter.key);
      session?.close().catch(() => {});
    }
  },
);

// ---------------------------------------------------------------------------
// GET /portal-automation/universities/:key/mapping
// Returns the CRM→portal program mapping data for the university.
// ---------------------------------------------------------------------------
router.get(
  "/portal-automation/universities/:key/mapping",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: uniKeyParamsSchema }),
  async (req, res): Promise<void> => {
    const { key } = getValidated<UniKeyParams>(req).params;

    const uni = await getPortalUniversity(key);
    if (!uni) {
      res.status(404).json({ error: "UNIVERSITY_NOT_FOUND" });
      return;
    }

    const [row] = await db
      .select()
      .from(portalProgramMappingTable)
      .where(eq(portalProgramMappingTable.universityKey, key))
      .limit(1);

    res.json({
      universityKey: key,
      programOverrides: row?.programOverrides ?? {},
      synonyms: row?.synonyms ?? [],
      countryOverrides: row?.countryOverrides ?? {},
      updatedAt: row?.updatedAt ?? null,
    });
  },
);

// ---------------------------------------------------------------------------
// PUT /portal-automation/universities/:key/mapping
// Replaces the program_overrides object wholesale. Other mapping columns
// (synonyms, country_overrides) are left untouched. Audited.
// ---------------------------------------------------------------------------
const putMappingBodySchema = z.object({
  programOverrides: z.record(z.string()),
});
type PutMappingSchemas = {
  params: typeof uniKeyParamsSchema;
  body: typeof putMappingBodySchema;
};

router.put(
  "/portal-automation/universities/:key/mapping",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: uniKeyParamsSchema, body: putMappingBodySchema }),
  async (req, res): Promise<void> => {
    const { key } = getValidated<PutMappingSchemas>(req).params;
    const { programOverrides } = getValidated<PutMappingSchemas>(req).body;
    const user = req.user!;

    const uni = await getPortalUniversity(key);
    if (!uni) {
      res.status(404).json({ error: "UNIVERSITY_NOT_FOUND" });
      return;
    }

    const [existing] = await db
      .select()
      .from(portalProgramMappingTable)
      .where(eq(portalProgramMappingTable.universityKey, key))
      .limit(1);

    let row;
    if (existing) {
      [row] = await db
        .update(portalProgramMappingTable)
        .set({ programOverrides, updatedAt: new Date() })
        .where(eq(portalProgramMappingTable.id, existing.id))
        .returning();
    } else {
      [row] = await db
        .insert(portalProgramMappingTable)
        .values({ universityKey: key, programOverrides })
        .returning();
    }

    logAudit(
      user.id,
      "update_portal_program_mapping",
      "portal_program_mapping",
      row.id,
      { universityKey: key, programOverrides: Object.keys(programOverrides).length },
      req.ip,
    );

    res.json({
      universityKey: key,
      programOverrides: row.programOverrides,
      synonyms: row.synonyms,
      countryOverrides: row.countryOverrides,
      updatedAt: row.updatedAt,
    });
  },
);

// ===========================================================================
// PROGRAM EŞLEME (FAZ 2) — Bulk Excel template export + import
// ===========================================================================

/**
 * Folds a value for tolerant matching: lowercase, Turkish letters → ASCII,
 * strip diacritics, drop everything except [a-z0-9]. Mirrors the matcher's
 * intent (override resolves by exact option value OR folded option text).
 */
function foldProgramValue(s: string): string {
  return s
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/i̇/g, "i")
    .replace(/ş/g, "s")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Resolves the CRM university id for a portal university (id, then name). */
async function resolveCrmUniversityId(
  uni: typeof portalUniversitiesTable.$inferSelect,
): Promise<number | null> {
  if (uni.crmUniversityId != null) return uni.crmUniversityId;
  const [u] = await db
    .select({ id: universitiesTable.id })
    .from(universitiesTable)
    .where(sql`LOWER(${universitiesTable.name}) = LOWER(${uni.universityName})`)
    .limit(1);
  return u?.id ?? null;
}

/**
 * Loads the deduped LIVE portal option list for a university from the Faz-1
 * cache (all cached levels merged). No headless fetch in the request path —
 * the cache is populated by the program-options endpoint.
 */
async function loadCachedPortalOptions(
  universityKey: string,
): Promise<Array<{ v: string; t: string }>> {
  const rows = await db
    .select({ options: portalProgramCacheTable.options })
    .from(portalProgramCacheTable)
    .where(eq(portalProgramCacheTable.universityKey, universityKey));
  const seen = new Set<string>();
  const out: Array<{ v: string; t: string }> = [];
  for (const r of rows) {
    for (const o of (r.options ?? []) as Array<{ v: unknown; t: unknown }>) {
      const v = String(o.v ?? "");
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push({ v, t: String(o.t ?? "") });
    }
  }
  return out;
}

/** Suggests a live portal option for a CRM program name (exact fold, then substring). */
function suggestPortalHint(
  programName: string,
  options: Array<{ v: string; t: string }>,
): string {
  if (options.length === 0) return "";
  const folded = foldProgramValue(programName);
  if (!folded) return "";
  const exact = options.find((o) => foldProgramValue(o.t) === folded);
  const hit =
    exact ??
    options.find((o) => {
      const ft = foldProgramValue(o.t);
      return ft.includes(folded) || folded.includes(ft);
    });
  return hit ? `${hit.t} (${hit.v})` : "";
}

// ---------------------------------------------------------------------------
// GET /portal-automation/universities/:key/program-template.xlsx
// Per-university bulk program-mapping template: one row per CRM program with
// id + name + the current override (if any) + a live portal option hint, plus
// an empty portal_value column to fill in. Optionally includes a read-only
// "PortalOptions" reference sheet listing every live portal option.
// ---------------------------------------------------------------------------
router.get(
  "/portal-automation/universities/:key/program-template.xlsx",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: uniKeyParamsSchema }),
  async (req, res): Promise<void> => {
    const { key } = getValidated<UniKeyParams>(req).params;

    const uni = await getPortalUniversity(key);
    if (!uni) {
      res.status(404).json({ error: "UNIVERSITY_NOT_FOUND" });
      return;
    }

    const crmUniversityId = await resolveCrmUniversityId(uni);
    const programs = crmUniversityId
      ? await db
          .select({ id: programsTable.id, name: programsTable.name })
          .from(programsTable)
          .where(eq(programsTable.universityId, crmUniversityId))
          .orderBy(asc(programsTable.name))
      : [];

    const [mappingRow] = await db
      .select({ programOverrides: portalProgramMappingTable.programOverrides })
      .from(portalProgramMappingTable)
      .where(eq(portalProgramMappingTable.universityKey, key))
      .limit(1);
    const overrides = mappingRow?.programOverrides ?? {};

    const options = await loadCachedPortalOptions(key);

    const rows = programs.map((p) => {
      const id = String(p.id);
      return {
        crm_program_id: id,
        crm_program_name: p.name,
        current_portal_value: overrides[id] ?? "",
        portal_value: "",
        portal_option_hint: suggestPortalHint(p.name, options),
      };
    });

    const sheets: WorkbookSpec["sheets"] = [
      { name: PROGRAM_MAPPING_SHEET, columns: programMappingColumns, rows },
    ];
    if (options.length > 0) {
      sheets.push({
        name: "PortalOptions",
        columns: [
          { key: "v", header: "portal_value", kind: "string" as const, width: 28 },
          { key: "t", header: "portal_label", kind: "string" as const, width: 44 },
        ],
        rows: options.map((o) => ({ v: o.v, t: o.t })),
      });
    }

    const buf = await buildWorkbookBuffer({
      sheets,
      meta: {
        kind: PROGRAM_MAPPING_KIND,
        version: "1",
        universityKey: key,
        exportedAt: new Date().toISOString(),
      },
    });

    res.setHeader("Content-Type", XLSX_CONTENT_TYPE);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${key}-program-mapping-template.xlsx"`,
    );
    res.send(buf);
  },
);

// ---------------------------------------------------------------------------
// POST /portal-automation/universities/:key/program-import  (raw .xlsx body)
// Reads the filled template; skips empty portal_value rows; validates the rest
// against the LIVE portal option list (cache); UPSERTS valid rows into
// program_overrides (merge, never deletes). Returns { applied, skipped, errors }.
// ---------------------------------------------------------------------------
router.post(
  "/portal-automation/universities/:key/program-import",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  raw({ type: XLSX_CONTENT_TYPE, limit: "2mb" }),
  validate({ params: uniKeyParamsSchema }),
  async (req, res): Promise<void> => {
    const { key } = getValidated<UniKeyParams>(req).params;
    const user = req.user!;

    const uni = await getPortalUniversity(key);
    if (!uni) {
      res.status(404).json({ error: "UNIVERSITY_NOT_FOUND" });
      return;
    }

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({
        error: "Upload an .xlsx file with Content-Type " + XLSX_CONTENT_TYPE,
      });
      return;
    }

    let parsed;
    try {
      parsed = await parseWorkbookBuffer(
        req.body,
        { expectedKind: PROGRAM_MAPPING_KIND },
        { [PROGRAM_MAPPING_SHEET]: programMappingColumns },
      );
    } catch (err) {
      const e = err as ImportValidationError;
      res.status(e.status || 400).json({ error: e.message });
      return;
    }

    const options = await loadCachedPortalOptions(key);
    if (options.length === 0) {
      res.status(400).json({
        error: "NO_LIVE_OPTIONS",
        message:
          "No live portal options cached for this university. Open Program Mapping and refresh the live options first.",
      });
      return;
    }

    const validValues = new Set(options.map((o) => o.v));
    // Map a folded label → canonical option value, so a label match is stored
    // as the portal `v` (keeps the "CRM id → portal value" contract intact).
    const foldedToValue = new Map<string, string>();
    for (const o of options) {
      const f = foldProgramValue(o.t);
      if (f && !foldedToValue.has(f)) foldedToValue.set(f, o.v);
    }

    const rawRows = parsed.sheets.get(PROGRAM_MAPPING_SHEET)?.rows ?? [];
    const errors: Array<{ row: number; reason: string }> = [];
    const toApply: Record<string, string> = {};
    let applied = 0;
    let skipped = 0;

    rawRows.forEach((r, i) => {
      const rowNo = i + 2; // +1 header, +1 to 1-base
      const id = String(r.crm_program_id ?? "").trim();
      const value = String(r.portal_value ?? "").trim();
      if (!value) {
        skipped++;
        return;
      }
      if (!id) {
        errors.push({ row: rowNo, reason: "MISSING_CRM_ID" });
        return;
      }
      // Resolve to the canonical portal `v`: exact value wins, else a folded
      // label match maps to its option value.
      const canonical = validValues.has(value)
        ? value
        : foldedToValue.get(foldProgramValue(value));
      if (!canonical) {
        errors.push({ row: rowNo, reason: "INVALID_PORTAL_VALUE" });
        return;
      }
      if (!(id in toApply)) applied++;
      toApply[id] = canonical;
    });

    // Resolve the applied CRM ids → program names so we can ALSO write the
    // name-based mappings { portalValue → crmProgramName } that the matcher now
    // consumes. programOverrides is kept in lockstep as a historical column.
    const appliedIds = [...new Set(Object.keys(toApply).map(Number))].filter(
      (n) => Number.isInteger(n) && n > 0,
    );
    const idToName = new Map<number, string>();
    if (appliedIds.length > 0) {
      const progs = await db
        .select({ id: programsTable.id, name: programsTable.name })
        .from(programsTable)
        .where(inArray(programsTable.id, appliedIds));
      for (const p of progs) idToName.set(p.id, p.name);
    }
    const nameToApply: Record<string, string> = {};
    for (const [idStr, portalValue] of Object.entries(toApply)) {
      const crmName = idToName.get(Number(idStr));
      if (crmName) nameToApply[portalValue] = crmName;
    }

    let rowId = 0;
    if (Object.keys(toApply).length > 0) {
      const [existing] = await db
        .select()
        .from(portalProgramMappingTable)
        .where(eq(portalProgramMappingTable.universityKey, key))
        .limit(1);
      const merged = { ...(existing?.programOverrides ?? {}), ...toApply };
      const mergedNames = { ...(existing?.mappings ?? {}), ...nameToApply };
      if (existing) {
        const [row] = await db
          .update(portalProgramMappingTable)
          .set({ programOverrides: merged, mappings: mergedNames, updatedAt: new Date() })
          .where(eq(portalProgramMappingTable.id, existing.id))
          .returning({ id: portalProgramMappingTable.id });
        rowId = row.id;
      } else {
        const [row] = await db
          .insert(portalProgramMappingTable)
          .values({ universityKey: key, programOverrides: merged, mappings: mergedNames })
          .returning({ id: portalProgramMappingTable.id });
        rowId = row.id;
      }
    }

    await logAudit(
      user.id,
      "portal.mapping.import",
      "portal_program_mapping",
      rowId,
      { universityKey: key, applied, skipped, errors: errors.length },
      req.ip,
    );

    res.json({ applied, skipped, errors });
  },
);

// ---------------------------------------------------------------------------
// GET /portal-automation/multi-portals
//
// Lists every multi-portal company (is_multi_portal=true) together with its
// member universities (rows whose routes_via points at the company's key).
// ---------------------------------------------------------------------------
router.get(
  "/portal-automation/multi-portals",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (_req, res): Promise<void> => {
    const portals = await db
      .select({
        universityKey: portalUniversitiesTable.universityKey,
        universityName: portalUniversitiesTable.universityName,
        adapterKey: portalUniversitiesTable.adapterKey,
        isActive: portalUniversitiesTable.isActive,
      })
      .from(portalUniversitiesTable)
      .where(
        and(
          eq(portalUniversitiesTable.isMultiPortal, true),
          isNull(portalUniversitiesTable.deletedAt),
        ),
      )
      .orderBy(asc(portalUniversitiesTable.universityName));

    const portalKeys = portals.map((p) => p.universityKey);
    const memberRows =
      portalKeys.length > 0
        ? await db
            .select({
              universityKey: portalUniversitiesTable.universityKey,
              universityName: portalUniversitiesTable.universityName,
              adapterKey: portalUniversitiesTable.adapterKey,
              routesVia: portalUniversitiesTable.routesVia,
            })
            .from(portalUniversitiesTable)
            .where(
              and(
                inArray(portalUniversitiesTable.routesVia, portalKeys),
                isNull(portalUniversitiesTable.deletedAt),
              ),
            )
            .orderBy(asc(portalUniversitiesTable.universityName))
        : [];

    const data = portals.map((p) => ({
      ...p,
      members: memberRows
        .filter((m) => m.routesVia === p.universityKey)
        .map((m) => ({
          universityKey: m.universityKey,
          universityName: m.universityName,
          adapterKey: m.adapterKey,
        })),
    }));

    res.json({ data });
  },
);

// ---------------------------------------------------------------------------
// PUT /portal-automation/multi-portals/:key/members
//
// Sets the full member list for a multi-portal company. Selected universities
// get routes_via=:key; universities previously routed here but omitted are
// reset to NULL (own adapter). Routing assignment does NOT enable auto-process.
// ---------------------------------------------------------------------------
const putMembersBodySchema = z.object({
  universityKeys: z.array(z.string().min(1)).max(1000),
});
type PutMembersSchemas = {
  params: typeof uniKeyParamsSchema;
  body: typeof putMembersBodySchema;
};

router.put(
  "/portal-automation/multi-portals/:key/members",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: uniKeyParamsSchema, body: putMembersBodySchema }),
  async (req, res): Promise<void> => {
    const { key } = getValidated<PutMembersSchemas>(req).params;
    const { universityKeys } = getValidated<PutMembersSchemas>(req).body;
    const user = req.user!;

    const portal = await getPortalUniversity(key);
    if (!portal) {
      res.status(404).json({ error: "PORTAL_NOT_FOUND" });
      return;
    }
    if (!portal.isMultiPortal) {
      res.status(400).json({
        error: "NOT_MULTI_PORTAL",
        message: `'${key}' is not a multi-portal company`,
      });
      return;
    }

    const requested = Array.from(new Set(universityKeys));

    if (requested.includes(key)) {
      res.status(400).json({
        error: "INVALID_MEMBER",
        message: "A multi-portal company cannot be its own member",
      });
      return;
    }

    if (requested.length > 0) {
      const rows = await db
        .select({
          universityKey: portalUniversitiesTable.universityKey,
          isMultiPortal: portalUniversitiesTable.isMultiPortal,
          routesVia: portalUniversitiesTable.routesVia,
        })
        .from(portalUniversitiesTable)
        .where(
          and(
            inArray(portalUniversitiesTable.universityKey, requested),
            isNull(portalUniversitiesTable.deletedAt),
          ),
        );

      const foundKeys = new Set(rows.map((r) => r.universityKey));
      const missing = requested.filter((k) => !foundKeys.has(k));
      if (missing.length > 0) {
        res.status(404).json({
          error: "MEMBER_NOT_FOUND",
          message: `Unknown university key(s): ${missing.join(", ")}`,
        });
        return;
      }

      const portalsAmongMembers = rows
        .filter((r) => r.isMultiPortal)
        .map((r) => r.universityKey);
      if (portalsAmongMembers.length > 0) {
        res.status(400).json({
          error: "INVALID_MEMBER",
          message: `Cannot route a multi-portal company through another: ${portalsAmongMembers.join(", ")}`,
        });
        return;
      }

      // Double-assign block: a university already routed to a DIFFERENT portal.
      const conflicts = rows
        .filter((r) => r.routesVia && r.routesVia !== key)
        .map((r) => r.universityKey);
      if (conflicts.length > 0) {
        res.status(409).json({
          error: "ALREADY_ASSIGNED",
          message: `Already assigned to another multi-portal: ${conflicts.join(", ")}`,
        });
        return;
      }
    }

    await db.transaction(async (tx) => {
      // Detach removed members (previously routed here, now omitted).
      const clearCondition =
        requested.length > 0
          ? and(
              eq(portalUniversitiesTable.routesVia, key),
              notInArray(portalUniversitiesTable.universityKey, requested),
              isNull(portalUniversitiesTable.deletedAt),
            )
          : and(
              eq(portalUniversitiesTable.routesVia, key),
              isNull(portalUniversitiesTable.deletedAt),
            );
      await tx
        .update(portalUniversitiesTable)
        .set({ routesVia: null, updatedAt: new Date() })
        .where(clearCondition);

      // Attach selected members. Note: only routes_via changes — auto_process
      // is intentionally left untouched so routing never enables auto-process.
      if (requested.length > 0) {
        await tx
          .update(portalUniversitiesTable)
          .set({ routesVia: key, updatedAt: new Date() })
          .where(
            and(
              inArray(portalUniversitiesTable.universityKey, requested),
              isNull(portalUniversitiesTable.deletedAt),
            ),
          );
      }
    });

    logAudit(
      user.id,
      "portal.routing.update",
      "portal_university",
      portal.id,
      { portalKey: key, universityKeys: requested },
      req.ip,
    );

    const members = await db
      .select({
        universityKey: portalUniversitiesTable.universityKey,
        universityName: portalUniversitiesTable.universityName,
        adapterKey: portalUniversitiesTable.adapterKey,
      })
      .from(portalUniversitiesTable)
      .where(
        and(
          eq(portalUniversitiesTable.routesVia, key),
          isNull(portalUniversitiesTable.deletedAt),
        ),
      )
      .orderBy(asc(portalUniversitiesTable.universityName));

    res.json({ portalKey: key, members });
  },
);

// ===========================================================================
// Phase 3 — multi-portal MEMBERSHIP (catalog-id keyed junction)
// ---------------------------------------------------------------------------
// The Phase 2 endpoints above route members by universityKey (portal_universities
// rows). Phase 3 manages members of a multi-portal ACCOUNT directly from the
// FAS-OS catalog (universities table), keyed by catalog id, via the
// portal_account_universities junction. UNIQUE(catalog_university_id) guarantees
// one school maps to at most one account; reassigning requires force.
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /portal-automation/catalog-universities?q=&page=&pageSize=
// Searchable, paginated catalog list (id/name/country) for the member picker.
// Does NOT reuse /api/universities (that endpoint silently caps limit at 100).
// ---------------------------------------------------------------------------
const catalogUniversitiesQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  country: z.string().trim().max(120).optional(),
  type: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});
type CatalogUniversitiesSchemas = { query: typeof catalogUniversitiesQuerySchema };

router.get(
  "/portal-automation/catalog-universities",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ query: catalogUniversitiesQuerySchema }),
  async (req, res): Promise<void> => {
    const { q, country, type, page, pageSize } = getValidated<CatalogUniversitiesSchemas>(req).query;
    const limit = pageSize ?? 20;
    const offset = ((page ?? 1) - 1) * limit;

    // Only active (non-soft-deleted) catalog universities. The filter-options
    // endpoint below applies this identical base filter, so a country/type can
    // only surface as an option when at least one matching university exists.
    const conditions = [];
    conditions.push(eq(universitiesTable.isActive, true));
    if (q) {
      // Turkish-aware, diacritic-folded substring match. Catalog names are
      // stored ASCII ("Kultur", "Gelisim") but admins type natural Turkish
      // ("Kültür", "Gelişim"), so fold ç/ğ/ı/İ/ö/ş/ü (+ common accents) and
      // lowercase BOTH sides before comparing. The query is folded in JS via
      // the shared normalizer; the column is folded in-SQL via translate() so
      // the match stays a plain case/diacritic-insensitive substring (includes).
      const foldedQuery = `%${transliterateToLatin(q).toLowerCase()}%`;
      const trFrom = "çÇğĞıİöÖşŞüÜâÂîÎûÛ";
      const trTo = "cCgGiIoOsSuUaAiIuU";
      conditions.push(
        or(
          sql`LOWER(translate(${universitiesTable.name}, ${trFrom}, ${trTo})) LIKE ${foldedQuery}`,
          sql`LOWER(translate(${universitiesTable.country}, ${trFrom}, ${trTo})) LIKE ${foldedQuery}`,
        ),
      );
    }
    if (country) conditions.push(ilike(universitiesTable.country, country));
    if (type) conditions.push(ilike(universitiesTable.universityType, type));
    const where = and(...conditions);

    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          id: universitiesTable.id,
          name: universitiesTable.name,
          country: universitiesTable.country,
          universityType: universitiesTable.universityType,
        })
        .from(universitiesTable)
        .where(where)
        .orderBy(asc(universitiesTable.name))
        .limit(limit)
        .offset(offset),
      db
        .select({ total: count() })
        .from(universitiesTable)
        .where(where),
    ]);

    res.json({
      data: rows,
      meta: buildPageMeta(total, { page: page ?? 1, limit, offset }),
    });
  },
);

// ---------------------------------------------------------------------------
// GET /portal-automation/catalog-university-filters
// Distinct non-empty country + university-type values, for the member picker's
// filter dropdowns. Keeps the picker's filter options in sync with the catalog.
// ---------------------------------------------------------------------------
router.get(
  "/portal-automation/catalog-university-filters",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (_req, res): Promise<void> => {
    const [countryRows, typeRows] = await Promise.all([
      db
        .selectDistinct({ country: universitiesTable.country })
        .from(universitiesTable)
        .where(and(
          eq(universitiesTable.isActive, true),
          isNotNull(universitiesTable.country),
          ne(universitiesTable.country, ""),
        ))
        .orderBy(asc(universitiesTable.country)),
      db
        .selectDistinct({ universityType: universitiesTable.universityType })
        .from(universitiesTable)
        .where(and(
          eq(universitiesTable.isActive, true),
          isNotNull(universitiesTable.universityType),
          ne(universitiesTable.universityType, ""),
        ))
        .orderBy(asc(universitiesTable.universityType)),
    ]);

    res.json({
      countries: countryRows.map((r) => r.country).filter((c): c is string => !!c),
      types: typeRows.map((r) => r.universityType).filter((t): t is string => !!t),
    });
  },
);

// ---------------------------------------------------------------------------
// GET /portal-automation/accounts/:key/members
// Current member universities (catalog ids) of a multi-portal account.
// ---------------------------------------------------------------------------
router.get(
  "/portal-automation/accounts/:key/members",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: uniKeyParamsSchema }),
  async (req, res): Promise<void> => {
    const { key } = getValidated<UniKeyParams>(req).params;

    const portal = await getPortalUniversity(key);
    if (!portal) {
      res.status(404).json({ error: "PORTAL_NOT_FOUND" });
      return;
    }
    if (!portal.isMultiPortal) {
      res.status(400).json({
        error: "NOT_MULTI_PORTAL",
        message: `'${key}' is not a multi-portal company`,
      });
      return;
    }

    const members = await db
      .select({
        catalogUniversityId: portalAccountUniversitiesTable.catalogUniversityId,
        enabled: portalAccountUniversitiesTable.enabled,
        universityName: universitiesTable.name,
        country: universitiesTable.country,
      })
      .from(portalAccountUniversitiesTable)
      .innerJoin(
        universitiesTable,
        eq(portalAccountUniversitiesTable.catalogUniversityId, universitiesTable.id),
      )
      .where(eq(portalAccountUniversitiesTable.portalKey, key))
      .orderBy(asc(universitiesTable.name));

    res.json({ portalKey: key, members });
  },
);

// ---------------------------------------------------------------------------
// PUT /portal-automation/accounts/:key/members
// Replace the account's member set with the given catalog ids. A catalog id
// already owned by a DIFFERENT account → 409 ALREADY_ASSIGNED unless force=true
// (then it is moved to this account). Members omitted from the set are removed.
// ---------------------------------------------------------------------------
const putAccountMembersBodySchema = z.object({
  catalogUniversityIds: z.array(z.number().int().positive()).max(2000),
  force: z.boolean().optional(),
});
type PutAccountMembersSchemas = {
  params: typeof uniKeyParamsSchema;
  body: typeof putAccountMembersBodySchema;
};

router.put(
  "/portal-automation/accounts/:key/members",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: uniKeyParamsSchema, body: putAccountMembersBodySchema }),
  async (req, res): Promise<void> => {
    const { key } = getValidated<PutAccountMembersSchemas>(req).params;
    const { catalogUniversityIds, force } = getValidated<PutAccountMembersSchemas>(req).body;
    const user = req.user!;

    const portal = await getPortalUniversity(key);
    if (!portal) {
      res.status(404).json({ error: "PORTAL_NOT_FOUND" });
      return;
    }
    if (!portal.isMultiPortal) {
      res.status(400).json({
        error: "NOT_MULTI_PORTAL",
        message: `'${key}' is not a multi-portal company`,
      });
      return;
    }

    const requested = Array.from(new Set(catalogUniversityIds));

    if (requested.length > 0) {
      // Validate every catalog id exists.
      const existing = await db
        .select({ id: universitiesTable.id })
        .from(universitiesTable)
        .where(inArray(universitiesTable.id, requested));
      const foundIds = new Set(existing.map((r) => r.id));
      const missing = requested.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        res.status(404).json({
          error: "MEMBER_NOT_FOUND",
          message: `Unknown catalog university id(s): ${missing.join(", ")}`,
        });
        return;
      }

      // Conflict: a catalog id already owned by a DIFFERENT account.
      const conflicts = await db
        .select({
          catalogUniversityId: portalAccountUniversitiesTable.catalogUniversityId,
          portalKey: portalAccountUniversitiesTable.portalKey,
        })
        .from(portalAccountUniversitiesTable)
        .where(
          and(
            inArray(portalAccountUniversitiesTable.catalogUniversityId, requested),
            sql`${portalAccountUniversitiesTable.portalKey} <> ${key}`,
          ),
        );
      if (conflicts.length > 0 && !force) {
        res.status(409).json({
          error: "ALREADY_ASSIGNED",
          message: `Already assigned to another portal account: ${conflicts
            .map((c) => `${c.catalogUniversityId}→${c.portalKey}`)
            .join(", ")}`,
          conflicts,
        });
        return;
      }
    }

    await db.transaction(async (tx) => {
      // Remove members of THIS account omitted from the new set.
      const removeCondition =
        requested.length > 0
          ? and(
              eq(portalAccountUniversitiesTable.portalKey, key),
              notInArray(portalAccountUniversitiesTable.catalogUniversityId, requested),
            )
          : eq(portalAccountUniversitiesTable.portalKey, key);
      await tx.delete(portalAccountUniversitiesTable).where(removeCondition);

      // Upsert requested. ON CONFLICT(catalog_university_id) → move to this
      // account (force path already validated above; without force there were
      // no cross-account conflicts so this only re-affirms same-account rows).
      if (requested.length > 0) {
        await tx
          .insert(portalAccountUniversitiesTable)
          .values(
            requested.map((catalogUniversityId) => ({
              portalKey: key,
              catalogUniversityId,
            })),
          )
          .onConflictDoUpdate({
            target: portalAccountUniversitiesTable.catalogUniversityId,
            set: { portalKey: key, updatedAt: new Date() },
          });
      }
    });

    logAudit(
      user.id,
      "portal.membership.update",
      "portal_university",
      portal.id,
      { portalKey: key, catalogUniversityIds: requested, force: force ?? false },
      req.ip,
    );

    const members = await db
      .select({
        catalogUniversityId: portalAccountUniversitiesTable.catalogUniversityId,
        enabled: portalAccountUniversitiesTable.enabled,
        universityName: universitiesTable.name,
        country: universitiesTable.country,
      })
      .from(portalAccountUniversitiesTable)
      .innerJoin(
        universitiesTable,
        eq(portalAccountUniversitiesTable.catalogUniversityId, universitiesTable.id),
      )
      .where(eq(portalAccountUniversitiesTable.portalKey, key))
      .orderBy(asc(universitiesTable.name));

    res.json({ portalKey: key, members });
  },
);

// ---------------------------------------------------------------------------
// GET /portal-automation/resolve?applicationId=
// Resolves the submission target for an application's university so the UI can
// show "Gönderim hedefi: <portal>". Mirrors runner resolution: own portal row →
// resolveAdapterKey → portalKey = routedVia ?? own universityKey.
// ---------------------------------------------------------------------------
const resolveQuerySchema = z.object({
  applicationId: z.coerce.number().int().positive(),
});
type ResolveSchemas = { query: typeof resolveQuerySchema };

router.get(
  "/portal-automation/resolve",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ query: resolveQuerySchema }),
  async (req, res): Promise<void> => {
    const { applicationId } = getValidated<ResolveSchemas>(req).query;

    const [app] = await db
      .select({
        universityId: applicationsTable.universityId,
        universityName: universitiesTable.name,
      })
      .from(applicationsTable)
      .leftJoin(universitiesTable, eq(applicationsTable.universityId, universitiesTable.id))
      .where(eq(applicationsTable.id, applicationId))
      .limit(1);
    if (!app) {
      res.status(404).json({ error: "APPLICATION_NOT_FOUND" });
      return;
    }

    const routing = await resolvePortalRouting({
      universityId: app.universityId,
      universityName: app.universityName,
    });
    if (!routing) {
      res.json({ resolved: false });
      return;
    }
    const { portalUni, target } = routing;

    const { adapterKey, routedVia, memberUniversityId } = await resolveAdapterKey(
      portalUni.universityKey,
    );

    res.json({
      resolved: true,
      ownUniversityKey: portalUni.universityKey,
      ownUniversityName: target ? target.universityName : portalUni.universityName,
      portalKey: routedVia ?? portalUni.universityKey,
      routed: routedVia != null || target != null,
      adapterKey,
      memberUniversityId: memberUniversityId ?? target?.catalogUniversityId ?? null,
    });
  },
);

// ===========================================================================
// Declarative adapter SPECs (opt-in, versioned parallel engine)
// ---------------------------------------------------------------------------
// CRUD/validate/version/rollback over portal_adapter_specs. The flat
// portal_adapters table is unchanged; these endpoints manage the richer,
// versioned spec format. jsHook execution is a separate, super_admin-gated
// trust decision (jsHookApproved); uploading a jsHook spec is super_admin-only.
// ===========================================================================

const specKeyParamsSchema = z.object({ key: z.string().min(1).max(100) });
const rawSpecObjectSchema = z.record(z.string(), z.unknown());

const validateSpecBodySchema = z.object({ spec: rawSpecObjectSchema });
const upsertSpecBodySchema = z.object({
  spec: rawSpecObjectSchema,
  enable: z.boolean().optional(),
  approveJsHook: z.boolean().optional(),
  /** super_admin approval to allow enabling this privileged spec. */
  approvePrivileged: z.boolean().optional(),
});
const patchSpecBodySchema = z
  .object({
    enableVersion: z.number().int().positive().optional(),
    disable: z.boolean().optional(),
    rollbackTo: z.number().int().positive().optional(),
    jsHookApproved: z.boolean().optional(),
    privilegedApproved: z.boolean().optional(),
  })
  .strict();

function isSuperAdmin(role: string): boolean {
  return role === "super_admin";
}

/**
 * Atomically makes a single version the enabled one for a key (disabling all
 * others). Pass version=null to disable all versions for the key.
 */
// Serialize all enable/rollback/version-creation for a given key. A transaction
// scoped advisory lock keyed by the adapter key prevents interleaving updates
// from leaving two enabled rows (which the partial unique index would otherwise
// reject with a 500) or from racing on the next version number.
type SpecTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockSpecKey(tx: SpecTx, key: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
}

// Enable exactly one version for a key (or disable all when version is null),
// inside an already-locked transaction.
async function setEnabledSpecVersionTx(
  tx: SpecTx,
  key: string,
  version: number | null,
): Promise<void> {
  await tx
    .update(portalAdapterSpecsTable)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(portalAdapterSpecsTable.key, key));
  if (version !== null) {
    await tx
      .update(portalAdapterSpecsTable)
      .set({ enabled: true, updatedAt: new Date() })
      .where(
        and(
          eq(portalAdapterSpecsTable.key, key),
          eq(portalAdapterSpecsTable.version, version),
        ),
      );
  }
}

async function setEnabledSpecVersion(
  key: string,
  version: number | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockSpecKey(tx, key);
    await setEnabledSpecVersionTx(tx, key, version);
  });
  invalidateSpecAdapterCache();
}

// GET /portal-automation/adapter-specs — one entry per key (enabled + latest).
router.get(
  "/adapter-specs",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (_req, res) => {
    let rows: (typeof portalAdapterSpecsTable.$inferSelect)[];
    try {
      rows = await db
        .select()
        .from(portalAdapterSpecsTable)
        .orderBy(
          asc(portalAdapterSpecsTable.key),
          desc(portalAdapterSpecsTable.version),
        );
    } catch (err) {
      console.warn(`[portalAutomation] failed to load adapter specs: ${String(err)}`);
      res.json({ specs: [] });
      return;
    }

    const byKey = new Map<
      string,
      {
        key: string;
        name: string;
        latestVersion: number;
        enabledVersion: number | null;
        versionCount: number;
        source: string;
        jsHookApproved: boolean;
        privilegedApproved: boolean;
        hasJsHook: boolean;
        privileged: boolean;
        updatedAt: Date;
      }
    >();
    for (const row of rows) {
      const existing = byKey.get(row.key);
      if (!existing) {
        byKey.set(row.key, {
          key: row.key,
          name: row.name,
          latestVersion: row.version,
          enabledVersion: row.enabled ? row.version : null,
          versionCount: 1,
          source: row.source,
          jsHookApproved: row.jsHookApproved,
          privilegedApproved: row.privilegedApproved,
          hasJsHook: specHasJsHook(row.spec),
          privileged: specIsPrivileged(row.spec),
          updatedAt: row.updatedAt,
        });
      } else {
        existing.versionCount += 1;
        if (row.enabled) existing.enabledVersion = row.version;
      }
    }

    res.json({ specs: Array.from(byKey.values()) });
  },
);

// GET /portal-automation/adapter-specs/:key/versions — full version history.
router.get(
  "/adapter-specs/:key/versions",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: specKeyParamsSchema }),
  async (req, res) => {
    const { key } = getValidated<{ params: typeof specKeyParamsSchema }>(req).params;
    const rows = await listSpecVersions(key);
    res.json({
      key,
      versions: rows.map((row) => ({
        version: row.version,
        name: row.name,
        enabled: row.enabled,
        source: row.source,
        jsHookApproved: row.jsHookApproved,
        privilegedApproved: row.privilegedApproved,
        hasJsHook: specHasJsHook(row.spec),
        privileged: specIsPrivileged(row.spec),
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    });
  },
);

// POST /portal-automation/adapter-specs/validate — validate without persisting.
router.post(
  "/adapter-specs/validate",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ body: validateSpecBodySchema }),
  async (req, res) => {
    const { spec } = getValidated<{ body: typeof validateSpecBodySchema }>(req).body;
    const parsed = parseAdapterSpec(spec);
    if (!parsed.ok) {
      res.json({ ok: false, error: parsed.error, issues: parsed.issues ?? [] });
      return;
    }
    res.json({
      ok: true,
      key: parsed.spec.meta.key,
      name: parsed.spec.meta.name,
      hasJsHook: specHasJsHook(spec),
      privileged: specIsPrivileged(spec),
    });
  },
);

// POST /portal-automation/adapter-specs — create a new version (optionally enable).
router.post(
  "/adapter-specs",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ body: upsertSpecBodySchema }),
  async (req, res) => {
    const user = req.user!;
    const { spec, enable, approveJsHook, approvePrivileged } = getValidated<{
      body: typeof upsertSpecBodySchema;
    }>(req).body;

    const parsed = parseAdapterSpec(spec);
    if (!parsed.ok) {
      res.status(400).json({ error: "INVALID_SPEC", message: parsed.error, issues: parsed.issues ?? [] });
      return;
    }

    const hasJsHook = specHasJsHook(spec);
    // Uploading a spec that contains jsHook steps is super_admin-only.
    if (hasJsHook && !isSuperAdmin(user.role)) {
      res.status(403).json({ error: "JSHOOK_FORBIDDEN", message: "Only super_admin may upload specs containing jsHook steps." });
      return;
    }
    // Approving jsHook execution is likewise super_admin-only.
    const jsHookApproved = approveJsHook === true && isSuperAdmin(user.role);
    // Approving privileged-spec enabling is super_admin-only and independent of jsHookApproved.
    const privilegedApproved = approvePrivileged === true && isSuperAdmin(user.role);

    const key = parsed.spec.meta.key;

    // Privileged specs (http/graphql/jsHook steps) require explicit super_admin
    // approval (approvePrivileged=true in the request body) before they may be
    // enabled. Gate this before entering the transaction so we never return an
    // undefined from db.transaction() and break destructuring below.
    if (enable && specIsPrivileged(spec) && !privilegedApproved) {
      res.status(403).json({
        error: "PRIVILEGED_APPROVAL_REQUIRED",
        message:
          "This spec contains privileged steps (http, graphql, or jsHook). " +
          "A super_admin must pass approvePrivileged=true to enable it.",
      });
      return;
    }

    // Lock the key so the next-version computation, the insert, and the optional
    // enable all happen atomically — concurrent uploads can't collide on the
    // (key, version) unique index or leave two enabled rows.
    const { created, nextVersion } = await db.transaction(async (tx) => {
      await lockSpecKey(tx, key);
      const [maxRow] = await tx
        .select({ version: portalAdapterSpecsTable.version })
        .from(portalAdapterSpecsTable)
        .where(eq(portalAdapterSpecsTable.key, key))
        .orderBy(desc(portalAdapterSpecsTable.version))
        .limit(1);
      const next = (maxRow?.version ?? 0) + 1;
      const [row] = await tx
        .insert(portalAdapterSpecsTable)
        .values({
          key,
          name: parsed.spec.meta.name,
          spec,
          version: next,
          enabled: false,
          source: "uploaded",
          jsHookApproved,
          privilegedApproved,
          createdBy: user.id,
        })
        .returning();
      if (enable) {
        await setEnabledSpecVersionTx(tx, key, next);
      }
      return { created: row, nextVersion: next };
    });
    if (enable) invalidateSpecAdapterCache();

    await logAudit(
      user.id,
      "upsert_adapter_spec",
      "portal_adapter_spec",
      created.id,
      { key, version: nextVersion, enabled: enable === true, hasJsHook, jsHookApproved, privilegedApproved },
      req.ip,
    );

    res.status(201).json({
      key,
      version: nextVersion,
      enabled: enable === true,
      jsHookApproved,
      privilegedApproved,
      hasJsHook,
    });
  },
);

// PATCH /portal-automation/adapter-specs/:key — enable/disable/rollback/approve.
router.patch(
  "/adapter-specs/:key",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: specKeyParamsSchema, body: patchSpecBodySchema }),
  async (req, res) => {
    const user = req.user!;
    const { key } = getValidated<{ params: typeof specKeyParamsSchema }>(req).params;
    const body = getValidated<{ body: typeof patchSpecBodySchema }>(req).body;

    const versions = await listSpecVersions(key);
    if (versions.length === 0) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    // jsHook approval toggle (super_admin only).
    if (body.jsHookApproved !== undefined) {
      if (!isSuperAdmin(user.role)) {
        res.status(403).json({ error: "JSHOOK_FORBIDDEN", message: "Only super_admin may approve jsHook execution." });
        return;
      }
      await db
        .update(portalAdapterSpecsTable)
        .set({ jsHookApproved: body.jsHookApproved, updatedAt: new Date() })
        .where(eq(portalAdapterSpecsTable.key, key));
      invalidateSpecAdapterCache();
    }

    // privilegedApproved toggle (super_admin only).
    if (body.privilegedApproved !== undefined) {
      if (!isSuperAdmin(user.role)) {
        res.status(403).json({ error: "PRIVILEGED_APPROVAL_FORBIDDEN", message: "Only super_admin may approve privileged spec enabling." });
        return;
      }
      await db
        .update(portalAdapterSpecsTable)
        .set({ privilegedApproved: body.privilegedApproved, updatedAt: new Date() })
        .where(eq(portalAdapterSpecsTable.key, key));
      invalidateSpecAdapterCache();
    }

    const targetVersion = body.enableVersion ?? body.rollbackTo;
    if (body.disable) {
      await setEnabledSpecVersion(key, null);
    } else if (targetVersion !== undefined) {
      if (!versions.some((v) => v.version === targetVersion)) {
        res.status(404).json({ error: "VERSION_NOT_FOUND", message: `Version ${targetVersion} does not exist for ${key}.` });
        return;
      }
      // Privileged specs require super_admin approval before they can be enabled.
      const targetRow = versions.find((v) => v.version === targetVersion);
      if (targetRow && specIsPrivileged(targetRow.spec) && !targetRow.privilegedApproved) {
        res.status(403).json({
          error: "PRIVILEGED_APPROVAL_REQUIRED",
          message:
            "This spec version contains privileged steps (http, graphql, or jsHook). " +
            "A super_admin must set privilegedApproved=true before it can be enabled.",
        });
        return;
      }
      await setEnabledSpecVersion(key, targetVersion);
    }

    await logAudit(
      user.id,
      "patch_adapter_spec",
      "portal_adapter_spec",
      versions[0].id,
      {
        key,
        enableVersion: body.enableVersion,
        rollbackTo: body.rollbackTo,
        disable: body.disable === true,
        jsHookApproved: body.jsHookApproved,
      },
      req.ip,
    );

    const refreshed = await listSpecVersions(key);
    const enabled = refreshed.find((v) => v.enabled) ?? null;
    res.json({
      key,
      enabledVersion: enabled?.version ?? null,
      jsHookApproved: refreshed[0]?.jsHookApproved ?? false,
      privilegedApproved: refreshed[0]?.privilegedApproved ?? false,
    });
  },
);

export default router;
