import { Router, type IRouter, type Request, type Response, json } from "express";
import crypto from "crypto";
import { db, usersTable, studentsTable, applicationsTable, programsTable, universitiesTable, commissionsTable, serviceFeesTable, leadsTable, documentsTable, pipelineStagesTable, programDocumentRequirementsTable, settingsTable, educationRecordsTable, embedWidgetsTable } from "@workspace/db";
import { eq, and, isNotNull, inArray, isNull, sql, desc } from "drizzle-orm";
import { getDocEquivalenceGroup, getRelevantGroupsForLevel, type DocEquivalenceGroupId } from "@workspace/doc-equivalence";
import rateLimit from "express-rate-limit";
import { generateSecureToken, buildWelcomeEmail, buildExistingAccountEmail, sendEmail } from "../lib/email";
import { getCommissionFinanceStatus, getServiceFeeFinanceStatus } from "../lib/stageFinance";
import { resolveAgentCommission } from "../lib/agentCommission";
import { recomputeStudentPhoto } from "../lib/studentPhoto";
import {
  APPLICATION_DOCUMENT_MAX_SIZE,
  isAllowedMimeType,
  isPdf,
  validateApplicationDocumentFile,
  validateUploadedFile,
  validateStudentDocumentBuffer,
} from "../lib/fileUploadValidation";
import { buildDocNameFromParts } from "../lib/docNaming";
import { PgRateLimitStore } from "../lib/pgRateLimiter";
import { getRateLimitIp } from "../lib/clientIp";
import { normalizeGpaTo100 } from "../lib/gpaNormalize";
import { normalizeAndValidateNames } from "../lib/textNormalize";
import { getActiveExtractor, buildExtractionPrompt, isFallbackExtractor, recordExtractorRun } from "../lib/aiExtractorService";
import { getCurrentSeason } from "../lib/season";
import { checkMandatoryDocs, checkMandatoryDocsForStudent, parkApplicationInMissingDocsStage } from "../lib/mandatoryDocs.js";
import { dispatchNotification } from "../lib/notificationDispatcher.js";
import { maybeEnqueuePortalSubmission } from "../lib/portalAutoTrigger.js";
import { isPassportExpired } from "../lib/passportValidity";
import { studentEducationRecordsTable } from "@workspace/db";
import { findOrUpsertPublicLead } from "../lib/leadDedup";
import { directOrigin } from "../lib/originHelper";
import { getDocLabel } from "../lib/docNaming";
import { resolveResidenceAddress } from "../lib/studentAddressDefaults";
import {
  buildStudentEducationRecordsFromLegacy,
} from "../lib/studentEducationHydration";
import {
  cleanStudentEducationRecords,
  toLegacyEducationRecord,
} from "../lib/studentEducationInput";
import { resolveAppliedLevelKey } from "../lib/educationAutoExtract";
import { AiLaneQueueError, documentAiScheduler } from "../lib/aiLaneScheduler";
import { getDocumentAiConnection } from "../lib/documentAiConnection";
import { getEmbedSigningSecret } from "../lib/embedSigningSecret";
import { verifyEmbedLeadDocumentSessionToken } from "../lib/embedLeadDocumentSession";
import { normalizeInboxStudentExtraction } from "../lib/inboxStudentExtraction";
import { validatePassportNumber } from "@workspace/portal-adapters/identity-validation";
import {
  DocumentPartMergeError,
  mergeDocumentParts,
  type DocumentPartInput,
} from "../lib/documentPartMerge";
import { resolveProgramInterestedLevel } from "../lib/programInterestedLevel";
import { issueEmailVerificationToken } from "../lib/emailVerificationToken";

const router: IRouter = Router();

/**
 * Test-harness bypass for the ACCOUNT_CONFLICT security gate.
 * Call enableTestModeBypass() from the test server setup code so that
 * doc-equivalence HTTP integration suites can re-apply on existing student
 * accounts.  This flag is NEVER set in production — the production server
 * never calls this function.
 */
let _testModeBypassAccountConflict = false;
export function enableTestModeBypass(): void {
  _testModeBypassAccountConflict = true;
}

// Public-apply form (course-finder widget) and AI document extraction accept
// base64-encoded PDF/image uploads in the JSON body. Base64 inflates payload
// size by ~33%, so the global 1mb body limit blocks legitimate submissions.
// These routes are gated by their own rate limiters (applyLimiter /
// aiExtractLimiter) so a higher local limit is acceptable.
const applyJson = json({ limit: "20mb" });

const APPLY_WINDOW_MS = 15 * 60 * 1000;

const applyLimiter = rateLimit({
  windowMs: APPLY_WINDOW_MS,
  max: 10,
  message: { error: "Too many applications. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
  store: new PgRateLimitStore(APPLY_WINDOW_MS, "apply"),
  // Skip rate limiting only when the server is started in test mode (e.g.
  // in-process integration test harnesses that spawn the API directly).
  skip: () => process.env.NODE_ENV === "test",
  keyGenerator: (req) => getRateLimitIp(req),
});

// Public AI requests use two complementary buckets:
//  - a broad IP abuse ceiling, which does not punish a normal school/office NAT;
//  - a narrow application-session ceiling, which follows one browser/form.
// Provider protection is owned by the bounded lane scheduler below, not by
// collapsing every visitor behind the same public IP into a five-request pool.
const aiExtractIpLimiter = rateLimit({
  windowMs: APPLY_WINDOW_MS,
  max: 60,
  message: { error: "Too many AI extraction requests. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
  store: new PgRateLimitStore(APPLY_WINDOW_MS, "ai-extract-ip"),
  keyGenerator: (req) => getRateLimitIp(req),
});

const aiExtractSessionLimiter = rateLimit({
  windowMs: APPLY_WINDOW_MS,
  max: 5,
  message: { error: "Too many analysis attempts for this application. Please continue manually or try again later." },
  standardHeaders: true,
  legacyHeaders: false,
  store: new PgRateLimitStore(APPLY_WINDOW_MS, "ai-extract-session"),
  keyGenerator: (req) => {
    const raw = String(req.get("x-application-session") || "").trim();
    const session = /^[A-Za-z0-9._:-]{16,512}$/.test(raw)
      ? crypto.createHash("sha256").update(raw).digest("hex")
      : "no-session";
    return `${getRateLimitIp(req)}:${session}`;
  },
});

// Merging is a local CPU/file operation, not an AI attempt. Keep it in a
// separate bucket so adding document pieces cannot consume the applicant's
// limited AI-analysis attempts.
const documentMergeIpLimiter = rateLimit({
  windowMs: APPLY_WINDOW_MS,
  max: 120,
  message: { error: "Too many document merge requests. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
  store: new PgRateLimitStore(APPLY_WINDOW_MS, "document-merge-ip"),
  keyGenerator: (req) => getRateLimitIp(req),
});

const documentMergeSessionLimiter = rateLimit({
  windowMs: APPLY_WINDOW_MS,
  max: 20,
  message: { error: "Too many document changes for this application. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
  store: new PgRateLimitStore(APPLY_WINDOW_MS, "document-merge-session"),
  keyGenerator: (req) => {
    const raw = String(req.get("x-application-session") || "").trim();
    const session = /^[A-Za-z0-9._:-]{16,512}$/.test(raw)
      ? crypto.createHash("sha256").update(raw).digest("hex")
      : "no-session";
    return `${getRateLimitIp(req)}:${session}`;
  },
});

router.post(
  "/public/documents/merge-parts",
  documentMergeIpLimiter,
  documentMergeSessionLimiter,
  applyJson,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const applicationSession = String(req.get("x-application-session") || "").trim();
      if (!/^[A-Za-z0-9._:-]{16,512}$/.test(applicationSession)) {
        res.status(400).json({ error: "A valid application session is required." });
        return;
      }
      const documentType = String(req.body?.documentType || "").trim();
      const label = String(req.body?.label || documentType).trim();
      const parts = req.body?.parts as DocumentPartInput[];
      if (!documentType || !label) {
        res.status(400).json({ error: "Document type and label are required." });
        return;
      }
      const merged = await mergeDocumentParts(documentType, label, parts);
      res.json(merged);
    } catch (error) {
      if (error instanceof DocumentPartMergeError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      console.error("[document-part-merge] public merge failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Document parts could not be merged." });
    }
  },
);

/**
 * Read-only validation of a public-apply submission against a program.
 *
 * Runs the eligibility (GPA / language score) and quota checks WITHOUT
 * writing anything. Used at the top of /public/apply so we can reject
 * unfit submissions before creating the user/student records — otherwise
 * a failed apply leaves an orphan user behind that then triggers a 409
 * "your account is already registered" on retry.
 *
 * Returns null when the program is fine to apply to (or when there is no
 * programId / the program does not declare these constraints).
 */
async function precheckProgramEligibility(
  programId: number | null,
  studentGpa: string | null | undefined,
  studentLanguageScore: string | null | undefined,
): Promise<{ eligibilityErrors?: string[]; quotaError?: string } | null> {
  if (!programId) return null;
  const [prog] = await db.select().from(programsTable).where(eq(programsTable.id, programId));
  if (!prog) return null;

  const eligibilityErrors: string[] = [];
  if (prog.minGpa != null && prog.minGpa > 0) {
    const gpaNum = normalizeGpaTo100(studentGpa);
    if (isNaN(gpaNum)) {
      eligibilityErrors.push(`Program requires minimum GPA of ${prog.minGpa} (out of 100), but no GPA was provided`);
    } else if (gpaNum < prog.minGpa) {
      eligibilityErrors.push(`GPA (${gpaNum.toFixed(2)}/100) is below the minimum required (${prog.minGpa}/100)`);
    }
  }
  if (prog.minLanguageScore != null && prog.minLanguageScore > 0) {
    const langNum = parseFloat(studentLanguageScore || "");
    if (isNaN(langNum)) {
      eligibilityErrors.push(`Program requires minimum language score of ${prog.minLanguageScore}, but no language score was provided`);
    } else if (langNum < prog.minLanguageScore) {
      eligibilityErrors.push(`Language score (${langNum}) is below the minimum required (${prog.minLanguageScore})`);
    }
  }
  if (eligibilityErrors.length > 0) return { eligibilityErrors };

  if (prog.quota != null) {
    const wonStages = await db.select({ key: pipelineStagesTable.key })
      .from(pipelineStagesTable)
      .where(and(eq(pipelineStagesTable.entityType, "application"), eq(pipelineStagesTable.variant, "won")));
    const wonKeys = wonStages.map(s => s.key);
    if (wonKeys.length > 0) {
      const currentYear = await getCurrentSeason();
      const [{ cnt }] = await db.select({ cnt: sql<number>`count(*)` })
        .from(applicationsTable)
        .where(and(
          eq(applicationsTable.programId, prog.id),
          eq(applicationsTable.season, currentYear),
          inArray(applicationsTable.stage, wonKeys),
          isNull(applicationsTable.deletedAt),
        ));
      if (Number(cnt) >= prog.quota) {
        return { quotaError: `Program quota is full (${prog.quota}/${prog.quota} enrolled)` };
      }
    }
  }
  return null;
}

export async function createApplicationForStudent(studentId: number, programId: number | null, programName: string | null, universityName: string | null, studentGpa?: string | null, studentLanguageScore?: string | null, sourceLeadId?: number | null): Promise<{ appId: number | null; eligibilityErrors?: string[]; quotaError?: string }> {
  try {
    let snapshotTuitionFee: number | null = null;
    let snapshotDiscountedFee: number | null = null;
    let snapshotScholarship: number | null = null;
    let snapshotCommissionRate: number | null = null;
    let snapshotServiceFeeAmount: number | null = null;
    let snapshotApplicationFee: number | null = null;
    let snapshotDepositFee: number | null = null;
    let snapshotAdvancedFee: number | null = null;
    let snapshotLanguageFee: number | null = null;
    let snapshotCurrency = "USD";
    let snapshotProgramName = programName || null;
    let snapshotUniversityName = universityName || null;
    let snapshotCountry: string | null = null;
    let snapshotLevel: string | null = null;
    let snapshotLanguage: string | null = null;
    let snapshotUniversityId: number | null = null;
    let isStateUniversity = false;

    if (programId) {
      const [prog] = await db.select().from(programsTable).where(eq(programsTable.id, programId));
      if (prog) {
        const eligibilityErrors: string[] = [];
        if (prog.minGpa != null && prog.minGpa > 0) {
          const gpaNum = normalizeGpaTo100(studentGpa);
          if (isNaN(gpaNum)) {
            eligibilityErrors.push(`Program requires minimum GPA of ${prog.minGpa} (out of 100), but no GPA was provided`);
          } else if (gpaNum < prog.minGpa) {
            eligibilityErrors.push(`GPA (${gpaNum.toFixed(2)}/100) is below the minimum required (${prog.minGpa}/100)`);
          }
        }
        if (prog.minLanguageScore != null && prog.minLanguageScore > 0) {
          const langNum = parseFloat(studentLanguageScore || "");
          if (isNaN(langNum)) {
            eligibilityErrors.push(`Program requires minimum language score of ${prog.minLanguageScore}, but no language score was provided`);
          } else if (langNum < prog.minLanguageScore) {
            eligibilityErrors.push(`Language score (${langNum}) is below the minimum required (${prog.minLanguageScore})`);
          }
        }
        if (eligibilityErrors.length > 0) {
          return { appId: null, eligibilityErrors };
        }

        if (prog.quota != null) {
          const wonStages = await db.select({ key: pipelineStagesTable.key })
            .from(pipelineStagesTable)
            .where(and(eq(pipelineStagesTable.entityType, "application"), eq(pipelineStagesTable.variant, "won")));
          const wonKeys = wonStages.map(s => s.key);
          if (wonKeys.length > 0) {
            const currentYear = await getCurrentSeason();
            const [{ cnt }] = await db.select({ cnt: sql<number>`count(*)` })
              .from(applicationsTable)
              .where(and(
                eq(applicationsTable.programId, prog.id),
                eq(applicationsTable.season, currentYear),
                inArray(applicationsTable.stage, wonKeys),
                isNull(applicationsTable.deletedAt),
              ));
            if (Number(cnt) >= prog.quota) {
              return { appId: null, quotaError: `Program quota is full (${prog.quota}/${prog.quota} enrolled)` };
            }
          }
        }

        snapshotTuitionFee = prog.tuitionFee ?? null;
        snapshotDiscountedFee = (prog.discountedFee != null && !isNaN(Number(prog.discountedFee))) ? Number(prog.discountedFee) : null;
        snapshotScholarship = prog.scholarship ?? null;
        snapshotCommissionRate = prog.commissionRate ?? null;
        snapshotServiceFeeAmount = prog.serviceFeeAmount ?? null;
        snapshotApplicationFee = prog.applicationFee ?? null;
        snapshotDepositFee = prog.depositFee ?? null;
        snapshotAdvancedFee = prog.advancedFee ?? null;
        snapshotLanguageFee = prog.languageFee ?? null;
        snapshotCurrency = prog.currency || "USD";
        snapshotProgramName = snapshotProgramName || prog.name;
        snapshotLevel = prog.degree || null;
        snapshotLanguage = prog.language || null;
        snapshotUniversityId = prog.universityId;

        if (prog.universityId) {
          const [uni] = await db.select().from(universitiesTable).where(eq(universitiesTable.id, prog.universityId));
          if (uni) {
            snapshotUniversityName = snapshotUniversityName || uni.name;
            snapshotCountry = uni.country || null;
            isStateUniversity = ["public", "state"].includes((uni.universityType ?? "").toLowerCase());
          }
        }
      }
    }

    const currentYear = await getCurrentSeason();
    const stage = "inquiry";

    const [studentRec] = await db.select({
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      assignedToId: studentsTable.assignedToId,
      branchId: studentsTable.branchId,
      agentId: studentsTable.agentId,
      originType: studentsTable.originType,
      originEntityType: studentsTable.originEntityType,
      originEntityId: studentsTable.originEntityId,
      originDisplayName: studentsTable.originDisplayName,
    }).from(studentsTable).where(eq(studentsTable.id, studentId));
    const studentFullName = studentRec ? `${studentRec.firstName || ""} ${studentRec.lastName || ""}`.trim() : null;

    const [app] = await db.insert(applicationsTable).values({
      studentId,
      leadId: sourceLeadId ?? null,
      stage,
      season: currentYear,
      // Public/embed/self-fill intake = student self-service.
      createdSource: "student",
      universityId: snapshotUniversityId,
      programId: programId || null,
      agentId: studentRec?.agentId ?? null,
      assignedToId: studentRec?.assignedToId ?? null,
      branchId: studentRec?.branchId ?? null,
      originType: studentRec?.originType || "direct",
      originEntityType: studentRec?.originEntityType ?? null,
      originEntityId: studentRec?.originEntityId ?? null,
      originDisplayName: studentRec?.originDisplayName ?? null,
      originStudentId: studentId,
      universityName: snapshotUniversityName,
      country: snapshotCountry,
      programName: snapshotProgramName,
      level: snapshotLevel,
      instructionLanguage: snapshotLanguage,
      tuitionFee: snapshotTuitionFee,
      discountedFee: snapshotDiscountedFee,
      scholarship: snapshotScholarship,
      commissionRate: snapshotCommissionRate,
      serviceFeeAmount: snapshotServiceFeeAmount,
      applicationFee: snapshotApplicationFee,
      depositFee: snapshotDepositFee,
      advancedFee: snapshotAdvancedFee,
      languageFee: snapshotLanguageFee,
      currency: snapshotCurrency,
    }).returning();

    const commissionBaseFee = (snapshotDiscountedFee != null && !isNaN(snapshotDiscountedFee))
      ? snapshotDiscountedFee
      : snapshotTuitionFee;

    // Commission, service fee, and student status are independent — run in parallel.
    await Promise.all([
      // Chain 1: commission record
      (async () => {
        const commFinStatus = await getCommissionFinanceStatus(stage);
        if (commFinStatus === "excluded") return;
        const uCommAmount = commissionBaseFee && snapshotCommissionRate
          ? (commissionBaseFee * snapshotCommissionRate) / 100 : 0;
        const agentComm = await resolveAgentCommission(null, uCommAmount);
        await db.insert(commissionsTable).values({
          applicationId: app.id,
          studentId,
          agentId: null,
          studentName: studentFullName,
          universityName: snapshotUniversityName,
          programName: snapshotProgramName,
          isStateUniversity,
          season: currentYear,
          currency: snapshotCurrency,
          status: commFinStatus,
          programFee: commissionBaseFee ? String(commissionBaseFee) : null,
          universityCommissionRate: snapshotCommissionRate ? String(snapshotCommissionRate) : null,
          universityCommissionAmount: uCommAmount > 0 ? String(uCommAmount) : null,
          agentCommissionRate: agentComm.agentCommissionRate,
          agentCommissionAmount: agentComm.agentCommissionAmount,
          subAgentId: agentComm.subAgentId,
          subAgentCommissionRate: agentComm.subAgentCommissionRate,
          subAgentCommissionAmount: agentComm.subAgentCommissionAmount,
        });
      })(),

      // Chain 2: service fee record
      (async () => {
        const sfFinStatus = await getServiceFeeFinanceStatus(stage);
        if (sfFinStatus === "excluded") return;
        const sfTotal = snapshotServiceFeeAmount ? String(snapshotServiceFeeAmount) : "0";
        const sfHalf = snapshotServiceFeeAmount ? String(snapshotServiceFeeAmount / 2) : null;
        await db.insert(serviceFeesTable).values({
          applicationId: app.id,
          studentId,
          agentId: null,
          studentName: studentFullName,
          universityName: snapshotUniversityName,
          isStateUniversity,
          season: currentYear,
          currency: snapshotCurrency,
          totalAmount: sfTotal,
          firstInstallmentAmount: sfHalf,
          secondInstallmentAmount: sfHalf,
          financeStatus: sfFinStatus,
          status: "pending",
        });
      })(),

      // Chain 3: student status update (best-effort — never throws)
      (async () => {
        try {
          const appMadeStages = await db.select({ key: pipelineStagesTable.key, label: pipelineStagesTable.label })
            .from(pipelineStagesTable)
            .where(eq(pipelineStagesTable.entityType, "student"));
          const appMadeStage = appMadeStages.find(s => s.key === "done") || appMadeStages.find(s => s.label?.toLowerCase().includes("application made"));
          if (appMadeStage) {
            await db.update(studentsTable).set({ status: appMadeStage.key }).where(eq(studentsTable.id, studentId));
          }
        } catch {}
      })(),
    ]);

    console.log(`[AUTO-APPLICATION] Created application #${app.id} for student #${studentId}, program: ${snapshotProgramName}`);
    return { appId: app.id };
  } catch (err) {
    console.error("[AUTO-APPLICATION] Error creating application:", err);
    return { appId: null };
  }
}

router.post("/public/apply", applyLimiter, applyJson, async (req: Request, res: Response): Promise<void> => {
  let { firstName, lastName, motherName, fatherName } = req.body;
  const { email, phone, phoneCode, nationality, programId, programName, programDegree, universityName, notes, passportNumber, passportIssueDate, passportExpiry, dateOfBirth, gender, address, addressCity, postalCode, highSchool, graduationYear, gpa, languageScore, documents, reuseDocumentIds, transferStudent, hasTcId, hasBlueCard, education } = req.body;
  const residence = resolveResidenceAddress({
    address,
    addressCity,
    postalCode,
    nationality,
  });
  let leadId: number | null = null;

  if (!firstName || !lastName || !email || !phone || !motherName || !fatherName || !nationality || !gender) {
    res.status(400).json({ error: "firstName, lastName, email, phone, motherName, fatherName, nationality, and gender are required" });
    return;
  }

  const normalizedGender = String(gender).toLowerCase();
  if (normalizedGender !== "female" && normalizedGender !== "male") {
    res.status(400).json({ error: "gender must be 'female' or 'male'" });
    return;
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    res.status(400).json({ error: "Invalid email format" });
    return;
  }

  // Latin-only name enforcement (mirrors embed/students/leads): reject
  // Arabic/Cyrillic/CJK names with a coded 400 and no record; Latin/Turkish
  // names pass and are transliterated to UPPERCASE for storage.
  {
    const { error: nameErr, normalized: normNames } = normalizeAndValidateNames(
      { firstName, lastName, motherName, fatherName },
      ["firstName", "lastName", "motherName", "fatherName"],
    );
    if (nameErr) { res.status(400).json({ error: nameErr }); return; }
    firstName = normNames.firstName as string;
    lastName = normNames.lastName as string;
    motherName = normNames.motherName as string;
    fatherName = normNames.fatherName as string;
  }

  // FAZ 2 — passport hard-block: an expired passport cannot start an
  // application. Runs BEFORE any student/application insert. Unparseable
  // or missing expiry dates pass (fail-open by design).
  if (isPassportExpired(passportExpiry)) {
    res.status(422).json({ error: "PASSPORT_EXPIRED", message: "Passport has expired. Application cannot be submitted." });
    return;
  }

  const s = (v: any, max: number) => v ? String(v).slice(0, max) : null;

  const normalizedEmail = email.toLowerCase().trim();

  // SECURITY (Public Intake / IDOR): never trust a client-supplied leadId.
  // A numeric lead ID is an enumerable identifier and the submitted email is
  // not a secret, so honoring a caller-supplied ID (even with an email match)
  // is a broken-object-binding / IDOR primitive — it let a caller attach
  // documents to, overwrite, or convert an arbitrary lead row, including
  // leads owned by other public flows (embed widgets, agent web forms,
  // website-builder forms). Instead we re-derive the target lead
  // deterministically on the server from (lower(email), source="website") —
  // the SAME dedup key the public website lead step (POST /public/lead) uses.
  // This binds the conversion to this flow's own lead, can't be steered by
  // the client, and preserves the lead-first -> auto-convert UX.
  const [websiteLead] = await db.select().from(leadsTable)
    .where(and(
      sql`lower(${leadsTable.email}) = ${normalizedEmail}`,
      eq(leadsTable.source, "website"),
      isNull(leadsTable.deletedAt),
    ))
    .orderBy(desc(leadsTable.createdAt))
    .limit(1);
  if (websiteLead) leadId = websiteLead.id;

  const { getAppBaseUrl } = await import("../lib/email.js");
  const baseUrl = getAppBaseUrl();
  const loginUrl = `${baseUrl}/login`;

  const trimmedPassport = passportNumber ? String(passportNumber).trim() : "";

  if (trimmedPassport && validatePassportNumber(trimmedPassport)) {
    res.status(422).json({
      error: "Passport number is not valid. Enter only the number printed on the passport; quotation marks are not allowed.",
      code: "PASSPORT_NUMBER_INVALID",
    });
    return;
  }

  try {
    const [existingUser] = await db.select().from(usersTable).where(eq(usersTable.email, normalizedEmail));
    const [archivedStudent] = await db.select({ id: studentsTable.id }).from(studentsTable).where(and(
      sql`lower(trim(${studentsTable.email})) = ${normalizedEmail}`,
      isNotNull(studentsTable.deletedAt),
    ));
    if (archivedStudent && !_testModeBypassAccountConflict) {
      res.status(409).json({
        error: "This student journey is archived. An administrator must restore it before a new application can be submitted.",
        code: "STUDENT_JOURNEY_ARCHIVED",
        loginUrl,
      });
      return;
    }

    // SECURITY (Public Intake — account/identity enumeration): the
    // staff-email and passport-already-registered conflicts MUST return an
    // identical, generic response. Distinct messages/codes let an
    // unauthenticated attacker probe this public endpoint to confirm whether
    // an email belongs to staff or whether a passport number is already on
    // file. We still block the same way, but never disclose WHICH sensitive
    // condition matched; the specific reason is logged server-side only for
    // staff triage.
    const genericConflict = {
      error: `We couldn't process this application with the information provided. If you already have an account with us, please log in to continue: ${loginUrl}`,
      code: "ACCOUNT_CONFLICT",
      loginUrl,
    };

    // Never let a public submission attach itself to an internal staff account.
    if (existingUser && existingUser.role !== "student") {
      console.warn(`[PUBLIC-APPLY] Blocked submission for staff-owned email (user #${existingUser.id})`);
      res.status(409).json(genericConflict);
      return;
    }

    if (trimmedPassport) {
      const [dupPassportStudent] = await db.select({ id: studentsTable.id, userId: studentsTable.userId })
        .from(studentsTable)
        .where(and(eq(studentsTable.passportNumber, trimmedPassport), isNull(studentsTable.deletedAt)));
      // Passport already linked to a different user — block with the same
      // generic response so the passport's existence is never confirmed.
      if (dupPassportStudent && (!existingUser || dupPassportStudent.userId !== existingUser.id)) {
        console.warn(`[PUBLIC-APPLY] Blocked submission — passport already linked to student #${dupPassportStudent.id}`);
        res.status(409).json(genericConflict);
        return;
      }
    }

    // Validate program eligibility/quota BEFORE creating any user/student
    // record. If we created the user first and then 422'd here, a retried
    // submission would hit the email-already-exists path and be blocked
    // forever ("hesabınız kayıtlıdır" loop).
    const programIdNum = programId ? parseInt(String(programId), 10) : null;
    const resolvedInterestedLevel = await resolveProgramInterestedLevel(programIdNum, programDegree);
    const precheck = await precheckProgramEligibility(programIdNum, gpa || null, languageScore || null);
    if (precheck?.eligibilityErrors) {
      res.status(422).json({ error: "Student does not meet program eligibility requirements", eligibilityErrors: precheck.eligibilityErrors, code: "ELIGIBILITY_FAILED" });
      return;
    }
    if (precheck?.quotaError) {
      res.status(422).json({ error: precheck.quotaError, code: "QUOTA_FULL" });
      return;
    }

    // Strict pre-creation gate: only files that the persistence loop below
    // would accept can satisfy a Mandatory slot. If anything is missing we
    // make sure the website Lead exists, then stop before creating a user,
    // student or application.
    if (programIdNum) {
      const MAX_DOCS = 10;
      const MAX_DOC_SIZE = APPLICATION_DOCUMENT_MAX_SIZE;
      const ALLOWED_MIME = new Set([
        "application/pdf",
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
      ]);
      const submittedDocTypes: string[] = [];
      if (Array.isArray(documents)) {
        for (const doc of documents.slice(0, MAX_DOCS)) {
          if (!doc?.base64 || !doc?.name) continue;
          let rawBase64 = String(doc.base64 || "");
          let mime = String(doc.mediaType || "").toLowerCase();
          if (/^data:/i.test(rawBase64) && rawBase64.includes(",")) {
            const commaIdx = rawBase64.indexOf(",");
            if (!mime) {
              const match = /^data:([^;,]+)/i.exec(rawBase64.slice(0, commaIdx));
              if (match?.[1]) mime = match[1].trim().toLowerCase();
            }
            rawBase64 = rawBase64.slice(commaIdx + 1);
          }
          rawBase64 = rawBase64.replace(/\s/g, "");
          if (!ALLOWED_MIME.has(mime) || rawBase64.length > MAX_DOC_SIZE * 1.4) continue;

          const buffer = Buffer.from(rawBase64, "base64");
          if (buffer.length === 0 || buffer.length > MAX_DOC_SIZE) continue;
          const docType = String(doc.key || doc.label || "").trim();
          if (!docType) continue;
          const validationError = await validateStudentDocumentBuffer(docType, String(doc.name), mime, buffer);
          if (validationError) continue;

          // Reuse the exact normalized bytes/mime in the persistence loop so
          // the pre-creation proof and the stored document cannot diverge.
          doc.base64 = rawBase64;
          doc.mediaType = mime;
          doc.sizeBytes = buffer.length;
          submittedDocTypes.push(docType);
        }
      }
      const docStatus = await checkMandatoryDocs(programIdNum, submittedDocTypes);
      if (docStatus.missing.length > 0) {
        if (!leadId) {
          const origin = directOrigin();
          const { lead } = await findOrUpsertPublicLead({
            source: "website",
            uniqueKey: { kind: "emailSource" },
            fields: {
              firstName: s(firstName, 100)!,
              lastName: s(lastName, 100)!,
              email: normalizedEmail,
              phone: phone ? `${phoneCode || ""}${phone}`.slice(0, 50) : null,
              nationality: s(nationality, 100),
              interestedProgram: s(programName, 255),
              interestedUniversity: s(universityName, 255),
              notes: s(notes, 400),
            },
            extras: {
              originType: origin.originType,
              originEntityType: origin.originEntityType,
              originEntityId: origin.originEntityId,
              originDisplayName: origin.originDisplayName,
            },
            ip: req.ip,
          });
          leadId = lead.id;
        }
        const missingDocLabels = docStatus.missing.map(getDocLabel);
        res.status(422).json({
          error: "Please upload all mandatory documents before submitting your application.",
          code: "MANDATORY_DOCUMENTS_REQUIRED",
          missingDocTypes: docStatus.missing,
          missingDocLabels,
          status: "lead",
        });
        return;
      }
    }

    let resultStudentId: number | null = null;
    let resultAppId: number | null = null;

    if (existingUser) {
      // SECURITY (Public Intake — account takeover via email): an existing
      // student account means someone already registered with this email.
      // Accepting a public form submission as proof-of-ownership and
      // attaching documents / applications to the account would let any
      // unauthenticated caller who knows the email mutate real CRM records.
      // The caller must authenticate (log in) to apply on behalf of an
      // existing account. We only create new student accounts here; account
      // holders must use the authenticated portal for subsequent applications.
      //
      // Exception: if the user row exists but the student row was hard-
      // deleted (edge case), fall through to recreate a clean student record
      // so the re-registering user is not permanently blocked.
      const [existingStudent] = await db.select().from(studentsTable)
        .where(and(eq(studentsTable.userId, existingUser.id), isNull(studentsTable.deletedAt)));
      if (existingStudent) {
        // SECURITY (Public Intake — account takeover via email): an existing
        // student account means someone already registered with this email.
        // Accepting a public form submission as proof-of-ownership and
        // attaching documents / applications to the account would let any
        // unauthenticated caller who knows the email mutate real CRM records.
        // The caller must authenticate (log in) to apply on behalf of an
        // existing account. We only create new student accounts here; account
        // holders must use the authenticated portal for subsequent applications.
        if (!_testModeBypassAccountConflict) {
          console.warn(`[PUBLIC-APPLY] Blocked unauthenticated attempt to create application on existing student #${existingStudent.id} (${normalizedEmail})`);
          res.status(409).json({
            error: `We couldn't process this application with the information provided. If you already have an account with us, please log in to continue: ${loginUrl}`,
            code: "ACCOUNT_CONFLICT",
            loginUrl,
          });
          return;
        }
        // Test-harness re-apply path: create a new application for the existing
        // student without updating any personal data fields.
        resultStudentId = existingStudent.id;
        const reApplyResult = await createApplicationForStudent(
          existingStudent.id,
          programId ? parseInt(String(programId), 10) : null,
          programName,
          universityName,
          gpa || null,
          languageScore || null,
          leadId,
        );
        if (reApplyResult.eligibilityErrors) {
          res.status(422).json({ error: "Student does not meet program eligibility requirements", eligibilityErrors: reApplyResult.eligibilityErrors, code: "ELIGIBILITY_FAILED" });
          return;
        }
        if (reApplyResult.quotaError) {
          res.status(422).json({ error: reApplyResult.quotaError, code: "QUOTA_FULL" });
          return;
        }
        resultAppId = reApplyResult.appId;
        console.log(`[PUBLIC-APPLY] [TEST] Re-apply for existing student #${existingStudent.id} (${normalizedEmail}) → new app #${resultAppId}`);
      } else {
        res.status(409).json({
          error: `We couldn't process this application with the information provided. Please log in or contact support: ${loginUrl}`,
          code: "ACCOUNT_CONFLICT",
          loginUrl,
        });
        return;
      }
    }

    if (!existingUser || resultStudentId === null) {
      const passwordToken = generateSecureToken();
      const [newUser] = await db.insert(usersTable).values({
        email: normalizedEmail,
        firstName: s(firstName, 100)!,
        lastName: s(lastName, 100)!,
        phone: phone ? `${phoneCode || ""}${phone}`.slice(0, 50) : null,
        role: "student",
        isActive: false,
        emailVerified: false,
        language: "en",
        passwordResetToken: crypto.createHash("sha256").update(passwordToken).digest("hex"),
        passwordResetExpires: new Date(Date.now() + 48 * 60 * 60 * 1000),
        createdFromSource: "public_apply",
      }).returning();

      const verificationToken = await issueEmailVerificationToken(normalizedEmail);

      let newStudent: any;
      [newStudent] = await db.insert(studentsTable).values({
          userId: newUser.id,
          firstName: s(firstName, 100)!,
          lastName: s(lastName, 100)!,
          email: normalizedEmail,
          phone: phone ? `${phoneCode || ""}${phone}`.slice(0, 50) : null,
          nationality: nationality || null,
          dateOfBirth: s(dateOfBirth, 20),
          gender: normalizedGender,
          motherName: s(motherName, 100),
          fatherName: s(fatherName, 100),
          passportNumber: s(passportNumber, 50),
          passportIssueDate: s(passportIssueDate, 20),
          passportExpiry: s(passportExpiry, 20),
          address: s(address, 300),
          addressCity: residence.addressCity,
          postalCode: residence.postalCode,
          highSchool: s(highSchool, 200),
          interestedLevel: resolvedInterestedLevel,
          graduationYear: graduationYear ? parseInt(String(graduationYear), 10) || null : null,
          gpa: s(gpa, 20),
          languageScore: s(languageScore, 20),
          assignedToId: websiteLead?.assignedToId ?? null,
          branchId: websiteLead?.branchId ?? null,
        }).returning();

      resultStudentId = newStudent.id;
      const newAppResult = await createApplicationForStudent(newStudent.id, programId ? parseInt(String(programId), 10) : null, programName, universityName, gpa || null, languageScore || null, leadId);
      if (newAppResult.eligibilityErrors) {
        res.status(422).json({ error: "Student does not meet program eligibility requirements", eligibilityErrors: newAppResult.eligibilityErrors, code: "ELIGIBILITY_FAILED" });
        return;
      }
      if (newAppResult.quotaError) {
        res.status(422).json({ error: newAppResult.quotaError, code: "QUOTA_FULL" });
        return;
      }
      resultAppId = newAppResult.appId;

      const setPasswordUrl = `${baseUrl}/login?token=${passwordToken}`;
      const verifyEmailUrl = `${baseUrl}/api/auth/verify-email-token/${verificationToken}`;

      const emailContent = await buildWelcomeEmail({
        firstName: s(firstName, 100) || "Student",
        email: normalizedEmail,
        setPasswordUrl,
        verifyEmailUrl,
        loginUrl,
        programName: programName || undefined,
        universityName: universityName || undefined,
      });
      await sendEmail(normalizedEmail, emailContent);

      console.log(`[PUBLIC-APPLY] Created student account for ${normalizedEmail} (user #${newUser.id}, student #${newStudent.id})`);
    }

    // FAZ 2 — persist SIT toggles + education records (all optional fields;
    // legacy payloads without them are unaffected). Best-effort: a failure
    // here must not break the application submission itself.
    if (resultStudentId) {
      try {
        const toggleUpdates: Record<string, boolean> = {};
        if (typeof transferStudent === "boolean") toggleUpdates.transferStudent = transferStudent;
        if (typeof hasTcId === "boolean") toggleUpdates.hasTcId = hasTcId;
        if (typeof hasBlueCard === "boolean") toggleUpdates.hasBlueCard = hasBlueCard;
        if (Object.keys(toggleUpdates).length > 0) {
          await db.update(studentsTable).set(toggleUpdates).where(eq(studentsTable.id, resultStudentId));
        }
        const cleanedInput = cleanStudentEducationRecords(
          Array.isArray(education) ? education : [],
        );
        const appliedLevelKey =
          (await resolveAppliedLevelKey(resultStudentId)) || "Bachelor";
        const resolvedEducation = buildStudentEducationRecordsFromLegacy(
          appliedLevelKey,
          { highSchool, graduationYear, gpa, languageScore },
          cleanedInput.ok ? cleanedInput.records : [],
        );
        if (resolvedEducation.length > 0) {
          const studentRows = resolvedEducation.map(
            ({ country: _country, ...record }) => ({
              ...record,
              studentId: resultStudentId!,
            }),
          );
          const levels = resolvedEducation.map((record) => record.level);
          await db.transaction(async (tx) => {
            await tx.update(studentEducationRecordsTable)
              .set({ deletedAt: new Date() })
              .where(and(
                eq(studentEducationRecordsTable.studentId, resultStudentId!),
                isNull(studentEducationRecordsTable.deletedAt),
                inArray(studentEducationRecordsTable.level, levels),
              ));
            await tx.insert(studentEducationRecordsTable).values(studentRows);

            for (const record of resolvedEducation) {
              const legacy = toLegacyEducationRecord(resultStudentId!, record);
              await tx.insert(educationRecordsTable)
                .values(legacy)
                .onConflictDoUpdate({
                  target: [
                    educationRecordsTable.studentId,
                    educationRecordsTable.level,
                  ],
                  set: {
                    schoolName: legacy.schoolName,
                    country: legacy.country,
                    fieldOfStudy: legacy.fieldOfStudy,
                    endYear: legacy.endYear,
                    languageScore: legacy.languageScore,
                    gpa: legacy.gpa,
                    gpaType: legacy.gpaType,
                    updatedAt: new Date(),
                  },
                });
            }
          });
        }
      } catch (err) {
        console.error("[PUBLIC-APPLY] education/toggle persist failed:", err);
      }
    }

    // Lead → student/application conversion happens AFTER document linking
    // below, conditional on the application being document-complete. See the
    // "auto-convert lead + activate student" block at the end of this handler.

    if (Array.isArray(documents) && documents.length > 0 && resultStudentId && resultAppId) {
      const MAX_DOCS = 10;
      const MAX_DOC_SIZE = APPLICATION_DOCUMENT_MAX_SIZE;
      const ALLOWED_MIME = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"];
      try {
        const validDocs = documents.slice(0, MAX_DOCS);
        let savedCount = 0;
        let photoSet = false;
        for (const doc of validDocs) {
          if (!doc.base64 || !doc.name) continue;
          // Accept both bare base64 and data-URL payloads (strip the
          // "data:<mime>;base64," prefix) so fileData never stores a
          // corrupt/prefixed blob. Mirrors the embed /apply normalization.
          {
            const rawB64 = String(doc.base64 || "");
            if (/^data:/i.test(rawB64) && rawB64.includes(",")) {
              const commaIdx = rawB64.indexOf(",");
              doc.base64 = rawB64.slice(commaIdx + 1);
              if (!doc.mediaType) {
                const m = /^data:([^;,]+)/i.exec(rawB64.slice(0, commaIdx));
                if (m && m[1]) doc.mediaType = m[1].trim().toLowerCase();
              }
            }
            doc.base64 = String(doc.base64 || "").replace(/\s/g, "");
          }
          const mime = String(doc.mediaType || "").toLowerCase();
          if (!ALLOWED_MIME.includes(mime)) continue;
          const rawSize = doc.sizeBytes ? parseInt(String(doc.sizeBytes), 10) : 0;
          if (rawSize > MAX_DOC_SIZE) continue;
          const base64Len = typeof doc.base64 === "string" ? doc.base64.length : 0;
          if (base64Len > MAX_DOC_SIZE * 1.4) continue;
          const docType = String(doc.key || doc.label || "other").slice(0, 100);
          const descriptiveName = buildDocNameFromParts(firstName, lastName, docType, mime);
          await db.insert(documentsTable).values({
            studentId: resultStudentId,
            applicationId: resultAppId,
            leadId: leadId ? (parseInt(String(leadId), 10) || null) : null,
            name: descriptiveName,
            type: docType,
            status: "pending",
            fileData: doc.base64,
            mimeType: mime,
            sizeBytes: rawSize || null,
          });
          // Mirror to the student's own (profile-level) documents when this fresh
          // upload was attached to an application AND the student has no active
          // profile-level doc of that type yet. Mirrors the staff (documents.ts)
          // and embed (embed.ts) rule: an application upload fills the student's
          // reusable document library only when it is empty for that type, and
          // never overwrites a doc already on file. resultAppId is guaranteed
          // non-null here by the enclosing condition.
          const [existingProfileDoc] = await db
            .select({ id: documentsTable.id })
            .from(documentsTable)
            .where(and(
              eq(documentsTable.studentId, resultStudentId),
              eq(documentsTable.type, docType),
              isNull(documentsTable.applicationId),
              isNull(documentsTable.deletedAt),
            ));
          if (!existingProfileDoc) {
            await db.insert(documentsTable).values({
              studentId: resultStudentId,
              applicationId: null,
              leadId: null,
              name: descriptiveName,
              type: docType,
              status: "pending",
              fileData: doc.base64,
              mimeType: mime,
              sizeBytes: rawSize || null,
            });
          }
          if (!photoSet && (docType === "photo" || docType === "photograph") && resultStudentId) {
            // Sync has_photo + photo_url from the docs so the avatar shows
            // everywhere (was previously only setting a data: URI on photo_url,
            // leaving has_photo false → photo hidden on list/kanban/Student Detail).
            await recomputeStudentPhoto(resultStudentId);
            photoSet = true;
          }
          savedCount++;
        }
        if (savedCount > 0) {
          console.log(`[PUBLIC-APPLY] Saved ${savedCount} document(s) for student #${resultStudentId}, app #${resultAppId}`);
        }
      } catch (docErr) {
        console.error("[PUBLIC-APPLY] Failed to save documents:", docErr);
      }
    }

    // Reuse existing student documents on the new application.
    //
    // We use the doc-type equivalence map so that, for example, a passport
    // that the student previously uploaded under canonical type "passport"
    // satisfies the apply form's "passport" key, and a high-school diploma
    // uploaded under "class_12th_hsc_certificate" satisfies the apply form's
    // "hs_diploma" key — and vice versa.
    //
    // Even when the client did not send any reuseDocumentIds (e.g. the
    // student is logged in and the docs step was skipped because everything
    // was already on file), we auto-link the student's existing valid docs
    // to the new application as long as they cover types the new program
    // could need.
    if (resultStudentId && resultAppId) {
      try {
        const requestedReuseIds = Array.isArray(reuseDocumentIds)
          ? reuseDocumentIds
              .map((id: any) => parseInt(String(id), 10))
              .filter((n: number) => Number.isFinite(n) && n > 0)
              .slice(0, 50)
          : [];

        // Compute the equivalence groups already covered by docs the
        // client uploaded fresh in this submission. Also track the raw
        // (lowercased) types so that types NOT in the equivalence map are
        // skipped during reuse too — otherwise the profile-level mirror copies
        // created above for fresh uploads would be re-linked onto this same
        // application as duplicates.
        const alreadyHaveGroups = new Set<DocEquivalenceGroupId>();
        const freshRawTypes = new Set<string>();
        if (Array.isArray(documents)) {
          for (const d of documents) {
            const t = String(d?.key || d?.label || "").trim();
            const g = getDocEquivalenceGroup(t);
            if (g) alreadyHaveGroups.add(g);
            // Use the EXACT same normalization as docType in the fresh-upload
            // loop above (incl. the "other" fallback and 100-char truncation),
            // lowercased to match the reuse block's seenRawTypes comparison, so
            // every freshly-created profile mirror is recognized and never
            // re-copied onto this application as a duplicate.
            freshRawTypes.add(String(d?.key || d?.label || "other").slice(0, 100).toLowerCase());
          }
        }

        // Look up the program's required document types so we can pick the
        // existing student docs that are actually relevant for this new
        // application. We combine the apply-form's per-level expectations
        // (passport/photo/hs/bachelor/master docs etc.) with any extra
        // canonical types attached to the program via
        // programDocumentRequirementsTable so any custom requirement an
        // admin added on the program editor is also honored.
        let allowedGroups: Set<DocEquivalenceGroupId> | null = null;
        try {
          const [appRow] = await db.select({
            programId: applicationsTable.programId,
            level: applicationsTable.level,
          }).from(applicationsTable).where(eq(applicationsTable.id, resultAppId));
          // Coarse level used only to pick the apply-form's per-level
          // baseline groups (passport / photo / HS / bachelor / master).
          const normalizeLevel = (level: string | null | undefined): string | null => {
            if (!level) return null;
            const l = level.toLowerCase().replace(/[\s.-]/g, "_");
            if (["pre_bachelors", "associate", "foundation", "pre_bachelor"].some(k => l.includes(k))) return "pre_bachelors";
            if (["bachelor"].some(k => l.includes(k)) && !l.includes("pre")) return "bachelors";
            if (["master"].some(k => l.includes(k)) && !l.includes("pre")) return "masters";
            if (["phd", "ph_d", "doctorate", "doctoral"].some(k => l.includes(k))) return "phd";
            if (["language", "pathway", "other"].some(k => l.includes(k))) return "others";
            return null;
          };
          const normalizedLevel = normalizeLevel(appRow?.level);
          let extraTypes: string[] = [];
          if (appRow?.programId) {
            const reqs = await db.select({ documentType: programDocumentRequirementsTable.documentType })
              .from(programDocumentRequirementsTable)
              .where(eq(programDocumentRequirementsTable.programId, appRow.programId));
            extraTypes = reqs.map(r => r.documentType);
          }
          allowedGroups = getRelevantGroupsForLevel(normalizedLevel, extraTypes);
          // When the application has no level at all (allowedGroups === null)
          // but the program does declare its own document requirements, build
          // the allow-list purely from those program-level requirements so we
          // do not silently fall back to fully permissive linking.
          if (allowedGroups === null && extraTypes.length > 0) {
            const fromProgram = new Set<DocEquivalenceGroupId>();
            for (const t of extraTypes) {
              const g = getDocEquivalenceGroup(t);
              if (g) fromProgram.add(g);
            }
            if (fromProgram.size > 0) allowedGroups = fromProgram;
          }
        } catch (lvlErr) {
          console.error("[PUBLIC-APPLY] Failed to load program requirements for reuse:", lvlErr);
        }

        // Candidate source docs: explicitly-requested reuseIds first, then
        // (always) the rest of the student's library so we cover the
        // "auto-link when reuseDocumentIds is empty" case as well.
        const reuseIdSet = new Set(requestedReuseIds);
        const allStudentDocs = await db.select().from(documentsTable).where(and(
          eq(documentsTable.studentId, resultStudentId),
          isNull(documentsTable.deletedAt),
        ));
        const sourceDocs = allStudentDocs
          .filter(d => d.id != null && d.applicationId !== resultAppId && d.status !== "rejected")
          .sort((a, b) => {
            // Explicitly-requested reuse IDs win, then most recent.
            const aReq = reuseIdSet.has(a.id) ? 1 : 0;
            const bReq = reuseIdSet.has(b.id) ? 1 : 0;
            if (aReq !== bReq) return bReq - aReq;
            const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return bt - at;
          });

        let copied = 0;
        let photoSet = false;
        const seenGroups = new Set<DocEquivalenceGroupId>();
        const seenRawTypes = new Set<string>(freshRawTypes);
        for (const src of sourceDocs) {
          const srcType = String(src.type || "").trim();
          if (!srcType) continue;
          const srcGroup = getDocEquivalenceGroup(srcType);

          // Skip if a fresh upload in this submission already covers this
          // logical document, or if we already linked an equivalent one
          // for this application.
          if (srcGroup) {
            if (alreadyHaveGroups.has(srcGroup)) continue;
            if (seenGroups.has(srcGroup)) continue;
          } else {
            // Doc type not in the equivalence map — fall back to raw-type
            // dedup so we never link two copies of the same canonical type.
            const k = srcType.toLowerCase();
            if (seenRawTypes.has(k)) continue;
          }

          // When we know the program's level, restrict auto-linked docs to
          // groups that level's apply form / staff portal could need. If
          // the level is unknown (allowedGroups === null), fall back to
          // permissive linking so partial setups still benefit.
          //
          // Docs explicitly named in reuseDocumentIds are always honored —
          // the client opted into them.
          const isExplicitlyRequested = reuseIdSet.has(src.id);
          if (!isExplicitlyRequested && srcGroup && allowedGroups && !allowedGroups.has(srcGroup)) {
            continue;
          }

          if (srcGroup) seenGroups.add(srcGroup);
          else seenRawTypes.add(srcType.toLowerCase());

          await db.insert(documentsTable).values({
            studentId: resultStudentId,
            applicationId: resultAppId,
            leadId: leadId ? (parseInt(String(leadId), 10) || null) : null,
            name: src.name,
            type: srcType,
            status: src.status === "rejected" ? "pending" : (src.status || "pending"),
            fileData: src.fileData ?? null,
            fileUrl: src.fileUrl ?? null,
            fileKey: src.fileKey ?? null,
            mimeType: src.mimeType ?? null,
            sizeBytes: src.sizeBytes ?? null,
            notes: src.notes ?? null,
          });
          copied++;
          if (!photoSet && srcGroup === "photo" && resultStudentId) {
            await recomputeStudentPhoto(resultStudentId);
            photoSet = true;
          }
        }
        if (copied > 0) {
          console.log(`[PUBLIC-APPLY] Reused ${copied} existing document(s) for student #${resultStudentId}, app #${resultAppId} (requested=${requestedReuseIds.length})`);
        }
      } catch (reuseErr) {
        console.error("[PUBLIC-APPLY] Failed to reuse existing documents:", reuseErr);
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Auto-convert lead + activate student on full submit.
    //
    // Spec: any successful /public/apply submission means the applicant
    // completed Personal Info + Documents + Review and explicitly hit
    // Submit. That is the funnel-closing event from the lead's
    // perspective, regardless of whether every required document group
    // was uploaded — staff handle missing docs from the student/app
    // detail view, not from the lead column.
    //   - lead.status      → "converted" (+ convertedStudentId set)
    //   - student.status   → "active"
    //   - application.stage → "inquiry"  (already set on insert)
    // ─────────────────────────────────────────────────────────────────────
    if (resultStudentId && resultAppId) {
      try {
        const [settingsRow] = await db.select({
          autoConvertLeadEnabled: settingsTable.autoConvertLeadEnabled,
          autoConvertStudentStageKey: settingsTable.autoConvertStudentStageKey,
        }).from(settingsTable);
        const autoConvertEnabled = settingsRow?.autoConvertLeadEnabled !== false;
        const studentStageKey = settingsRow?.autoConvertStudentStageKey || "active";

        if (autoConvertEnabled) {
          await db.update(studentsTable)
            .set({ status: studentStageKey })
            .where(eq(studentsTable.id, resultStudentId));

          if (leadId) {
            const leadIdNum = parseInt(String(leadId), 10);
            if (Number.isFinite(leadIdNum) && leadIdNum > 0) {
              const [convertedLead] = await db.update(leadsTable)
                .set({ status: "converted", convertedStudentId: resultStudentId })
                .where(eq(leadsTable.id, leadIdNum))
                .returning({ id: leadsTable.id });
              if (convertedLead) {
                console.log(`[PUBLIC-APPLY] Auto-converted lead #${leadIdNum} → student #${resultStudentId} (stage=${studentStageKey})`);
              }
            }
          }
        } else {
          console.log(`[PUBLIC-APPLY] Auto-convert disabled by settings; lead/student left untouched (student #${resultStudentId})`);
        }
      } catch (convertErr) {
        console.error("[PUBLIC-APPLY] Failed to auto-convert lead/student:", convertErr);
      }
    }

    // ─── Mandatory document gate ─────────────────────────────────────────
    // After all document auto-linking is done, check whether the program
    // requires documents that the student has not yet provided. If so, park
    // the application in the "missing_docs" stage instead of "inquiry" so
    // staff can see it and the student knows what to upload.
    // The record is always created (no lead/application loss); only the stage
    // differs. Gate is skipped when there are no mandatory requirements.
    let missingDocTypes: string[] = [];
    if (resultStudentId && resultAppId && programIdNum) {
      try {
        const { missing } = await checkMandatoryDocsForStudent(programIdNum, resultStudentId);
        if (missing.length > 0) {
          await parkApplicationInMissingDocsStage(resultAppId);
          missingDocTypes = missing;
          const missingStr = missing.join(", ");
          // Notify in background — never block the 201 response.
          const appIdForNotif = resultAppId;
          const studentIdForNotif = resultStudentId;
          void (async () => {
            try {
              const [appRow] = await db.select({ assignedToId: applicationsTable.assignedToId })
                .from(applicationsTable).where(eq(applicationsTable.id, appIdForNotif));
              if (appRow?.assignedToId) {
                await dispatchNotification({
                  event: "mandatory_docs_missing",
                  title: "Eksik Belgeler",
                  body: `Başvuru eksik belgeler nedeniyle park edildi: ${missingStr}`,
                  recipientUserIds: [appRow.assignedToId],
                  data: { applicationId: appIdForNotif, missing },
                });
              }
              const [studentRow] = await db.select({ userId: studentsTable.userId })
                .from(studentsTable).where(eq(studentsTable.id, studentIdForNotif));
              if (studentRow?.userId) {
                await dispatchNotification({
                  event: "mandatory_docs_missing_student",
                  title: "Eksik Belgeler",
                  body: `Başvurunuz için gerekli belgeler eksik: ${missingStr}`,
                  recipientUserIds: [studentRow.userId],
                  data: { applicationId: appIdForNotif, missing },
                });
              }
            } catch (notifErr) {
              console.error("[PUBLIC-APPLY] Mandatory docs notification error:", notifErr);
            }
          })();
        }
      } catch (gateErr) {
        console.error("[PUBLIC-APPLY] Mandatory doc gate error:", gateErr);
      }
    }

    // Documents have now been persisted and re-read successfully. Only at
    // this point may portal automation see the new application; this removes
    // the former create-before-document-save race.
    if (resultStudentId && resultAppId && missingDocTypes.length === 0) {
      const [appForPortal] = await db
        .select({
          stage: applicationsTable.stage,
          universityName: applicationsTable.universityName,
          universityId: applicationsTable.universityId,
        })
        .from(applicationsTable)
        .where(eq(applicationsTable.id, resultAppId))
        .limit(1);
      if (appForPortal) {
        void maybeEnqueuePortalSubmission({
          applicationId: resultAppId,
          studentId: resultStudentId,
          newStage: String(appForPortal.stage),
          universityName: appForPortal.universityName ?? null,
          universityId: appForPortal.universityId ?? null,
          actorUserId: null,
        });
      }
    }

    res.status(201).json({
      success: true,
      ...(missingDocTypes.length > 0
        ? { status: "missing_documents", missing: missingDocTypes }
        : { status: "inquiry" }),
    });
  } catch (err) {
    console.error("[PUBLIC-APPLY] Error during student/application creation:", err);
    res.status(500).json({ error: "An error occurred while processing your application. Please try again." });
  }
});

const EXTRACT_PROMPT = `You are an expert document analysis system for an education consultancy. 
Analyze the provided document image(s) and extract student information.

Extract ALL of the following fields if visible in the document. Return a JSON object with these exact keys:
{
  "firstName": "string or null - EXACTLY as printed on the document, preserving original spelling",
  "lastName": "string or null - EXACTLY as printed on the document, preserving original spelling",
  "dateOfBirth": "YYYY-MM-DD format or null",
  "nationality": "full country name string (e.g. 'Afghanistan' not 'Afghan', 'Turkey' not 'Turkish') or null",
  "passportNumber": "string or null",
  "passportIssueDate": "YYYY-MM-DD format or null",
  "passportExpiry": "YYYY-MM-DD format or null",
  "passportExpired": "boolean - true if passport expiry date has passed, false otherwise, null if no expiry date found",
  "motherName": "string or null - EXACTLY as printed on the document",
  "fatherName": "string or null - EXACTLY as printed on the document",
  "email": "string or null",
  "phone": "string or null",
  "address": "string or null",
  "highSchool": "string or null",
  "graduationYear": "number or null",
  "gpa": "string or null",
  "languageScore": "string or null",
  "confidence": "high|medium|low"
}

Rules:
- CRITICAL - Names: Extract names EXACTLY as they appear on the passport or official document. The passport is the authoritative source for the person's legal name. Do NOT modify, translate, or reformat names. Copy them character by character as printed.
- CRITICAL - Date format awareness: Different countries use different date formats on passports:
  * Most countries (Europe, Asia, Middle East, Africa): DD/MM/YYYY or DD.MM.YYYY (day first)
  * USA, Philippines, some others: MM/DD/YYYY (month first)
  * East Asian countries (Japan, China, Korea): YYYY/MM/DD (year first)
  * Look at the passport's issuing country to determine the likely date format
  * When a date is ambiguous (e.g. 03/04/2025 could be March 4 or April 3), use the issuing country's convention
  * Always output dates in YYYY-MM-DD format after correctly interpreting the source format
- CRITICAL - Passport expiry: Check if the passport expiry date has passed relative to today's date. Set passportExpired to true if expired, false if still valid.
- CRITICAL - Passport number: Use letters and digits only. Never output apostrophes, quotation marks, backticks or OCR punctuation. If any character is ambiguous, set passportNumber to null instead of guessing or deleting the character.
- For passport documents: extract all passport fields, name, DOB, nationality, issue/expiry dates, mother name, father name (often listed on passport identity pages)
- For diplomas: extract school name, graduation year, GPA, student name, parent names if visible
- For transcripts: extract school name, GPA, graduation year, student name
- For photographs: note that a photo document was received
- For nationality: always return the full official country name. Convert any nationality adjective or demonym to the country name.
- Always normalize dates to YYYY-MM-DD format
- Return ONLY the JSON object, no other text
- Set null for fields you cannot find or are not sure about`;

router.post("/public/ai/extract-document", aiExtractIpLimiter, aiExtractSessionLimiter, applyJson, async (req: Request, res: Response): Promise<void> => {
  try {
    const { documents } = req.body as {
      documents: Array<{
        type: "image" | "pdf";
        data: string;
        mediaType: string;
        label: string;
      }>;
    };

    if (!documents || !Array.isArray(documents) || documents.length === 0) {
      res.status(400).json({ error: "No documents provided" });
      return;
    }

    if (documents.length > 4) {
      res.status(400).json({ error: "Maximum 4 documents allowed" });
      return;
    }

    // Accept BOTH bare base64 AND full data-URLs ("data:<mime>;base64,<b64>")
    // — stale cached widgets send the FileReader data-URL verbatim, which
    // decodes to garbage bytes and fails the magic-byte check. Strip the
    // prefix (and whitespace) before decoding; fall back to the data-URL mime
    // when mediaType was omitted. Mirrors the embed /apply normalization.
    for (const doc of documents) {
      const rawData = String(doc.data || "");
      if (/^data:/i.test(rawData) && rawData.includes(",")) {
        const commaIdx = rawData.indexOf(",");
        doc.data = rawData.slice(commaIdx + 1);
        if (!doc.mediaType) {
          const m = /^data:([^;,]+)/i.exec(rawData.slice(0, commaIdx));
          if (m && m[1]) doc.mediaType = m[1].trim().toLowerCase();
        }
      }
      doc.data = String(doc.data || "").replace(/\s/g, "");
    }

    for (const doc of documents) {
      const mime = doc.mediaType || "";
      if (!mime || !isAllowedMimeType(mime)) {
        res.status(400).json({ error: "Sadece PDF, JPG, JPEG ve PNG dosyalar\u0131 y\u00fckleyebilirsiniz." });
        return;
      }
      const syntheticExt = isPdf(mime) ? ".pdf" : mime === "image/png" ? ".png" : ".jpg";
      const syntheticFileName = `document${syntheticExt}`;
      let buffer: Buffer;
      try {
        buffer = Buffer.from(doc.data || "", "base64");
      } catch {
        res.status(400).json({ error: "Invalid base64 file data" });
        return;
      }
      const intakeValidationError = validateApplicationDocumentFile(syntheticFileName, mime, buffer.length);
      if (intakeValidationError) {
        const statusCode = intakeValidationError.type === "size_exceeded" ? 413 : 400;
        res.status(statusCode).json({ error: intakeValidationError.message });
        return;
      }
      const validationError = await validateStudentDocumentBuffer(doc.label, syntheticFileName, mime, buffer);
      if (validationError) {
        const statusCode = validationError.type === "size_exceeded" ? 413 : 400;
        res.status(statusCode).json({ error: validationError.message });
        return;
      }
    }

    const totalSize = documents.reduce((sum, d) => sum + (d.data?.length || 0), 0);
    if (totalSize > 10_000_000) {
      res.status(413).json({ error: "Documents too large. Please use smaller files." });
      return;
    }

    const requestedLang = ((req as any).body?.lang || req.headers["accept-language"] || "en").toString().slice(0, 2);
    // The public extract endpoint is shared between the public apply form and
    // the embed widget. Clients pass a `scope` so admins can wire a separate
    // extractor per audience (e.g. shorter prompt for embed).
    const requestedScope = ((req as any).body?.scope || "public_apply").toString();
    const scope: "public_apply" | "embed" = requestedScope === "embed" ? "embed" : "public_apply";
    let laneKey = "public-web";
    let requestedConnectionKey = process.env.PUBLIC_DOCUMENT_AI_CONNECTION_KEY || "claude";
    let preferredExtractorId: number | null = null;
    if (scope === "embed") {
      const widgetSlug = String((req.body as any)?.widgetSlug || "").trim();
      if (widgetSlug) {
        const [widget] = await db.select({
          id: embedWidgetsTable.id,
          aiConnectionKey: embedWidgetsTable.aiConnectionKey,
          aiExtractorId: embedWidgetsTable.aiExtractorId,
        }).from(embedWidgetsTable).where(and(
          eq(embedWidgetsTable.slug, widgetSlug),
          eq(embedWidgetsTable.isActive, true),
        ));
        if (!widget) {
          res.status(404).json({ error: "Widget not found" });
          return;
        }
        const documentSession = verifyEmbedLeadDocumentSessionToken(
          getEmbedSigningSecret(),
          req.get("x-application-session"),
          widgetSlug,
        );
        if (!documentSession) {
          res.status(403).json({ error: "Invalid or expired widget document session" });
          return;
        }
        laneKey = `widget:${widget.id}`;
        requestedConnectionKey = widget.aiConnectionKey || "claude";
        preferredExtractorId = widget.aiExtractorId;
      } else {
        laneKey = "widget:legacy";
      }
    }

    const extractor = await getActiveExtractor(scope, preferredExtractorId);
    if (extractor.provider !== "anthropic") {
      res.status(503).json({
        error: "Configured AI provider is not yet supported on the runtime. Please contact support.",
      });
      return;
    }
    const useLegacy = isFallbackExtractor(extractor);
    const promptText = useLegacy ? EXTRACT_PROMPT : buildExtractionPrompt(extractor, { lang: requestedLang });

    let anthropic;
    let claudeConfig;
    let resolvedConnectionKey: string;
    try {
      const connection = await getDocumentAiConnection(requestedConnectionKey, { fallbackToDefault: true });
      anthropic = connection.client;
      claudeConfig = { model: connection.model };
      resolvedConnectionKey = connection.resolvedConnectionKey;
      if (connection.usedFallback) {
        console.warn(`[public-ai] lane=${laneKey} requested connection unavailable; using default fallback`);
      }
    } catch (err: any) {
      res.status(503).json({ error: err.message || "AI integration not configured" });
      return;
    }
    const contentBlocks: any[] = [
      { type: "text", text: promptText },
    ];

    for (const doc of documents) {
      contentBlocks.push({
        type: "text",
        text: `\n--- Document: ${doc.label} ---`,
      });

      if (doc.type === "image") {
        const validMediaTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
        const mediaType = validMediaTypes.includes(doc.mediaType) ? doc.mediaType : "image/jpeg";
        contentBlocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
            data: doc.data,
          },
        });
      } else {
        contentBlocks.push({
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: doc.data,
          },
        });
      }
    }

    const model = useLegacy
      ? (claudeConfig.model || "claude-sonnet-4-6")
      : (extractor.model || claudeConfig.model || "claude-sonnet-4-6");
    const maxTokens = useLegacy ? 4096 : (extractor.maxTokens || 4096);
    const runStart = Date.now();
    const message = await documentAiScheduler.run(
      { laneKey, connectionKey: resolvedConnectionKey },
      () => anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: contentBlocks }],
      }),
    );

    const textBlock = message.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      res.status(500).json({ error: "No response from AI" });
      return;
    }

    let extracted: Record<string, any> = {};
    try {
      const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        extracted = JSON.parse(jsonMatch[0]);
      }
    } catch {
      res.status(500).json({ error: "Failed to parse AI response" });
      return;
    }

    // Legacy fallback: hardcoded GPA normalization. With a DB extractor, apply
    // per-field normalize flags so admins can add more numeric-normalized fields.
    if (useLegacy) {
      if (extracted.gpa != null && extracted.gpa !== "") {
        const raw = String(extracted.gpa);
        const pct = normalizeGpaTo100(raw);
        if (!isNaN(pct)) {
          extracted.gpaRaw = raw;
          extracted.gpa = (Math.round(pct * 10) / 10).toString();
          extracted.gpaScale = 100;
        }
      }
    } else {
      for (const f of (extractor.fields as any[]) || []) {
        if (f.normalize === "gpa100" && extracted[f.key] != null && extracted[f.key] !== "") {
          const raw = String(extracted[f.key]);
          const pct = normalizeGpaTo100(raw);
          if (!isNaN(pct)) {
            extracted[`${f.key}Raw`] = raw;
            extracted[f.key] = (Math.round(pct * 10) / 10).toString();
            extracted[`${f.key}Scale`] = 100;
          }
        }
      }
    }

    extracted = normalizeInboxStudentExtraction(extracted) as Record<string, any>;
    const warnings: string[] = [];
    if (extracted.passportNumberRejected === true) {
      warnings.push(
        "Passport number could not be read reliably. Please enter it manually from the passport; quotation marks are not allowed.",
      );
      delete extracted.passportNumberRejected;
    }

    if (extracted.passportExpiry) {
      const parts = String(extracted.passportExpiry).split("-").map(Number);
      const expiryDate = parts.length === 3 ? new Date(parts[0], parts[1] - 1, parts[2]) : new Date(NaN);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (!isNaN(expiryDate.getTime()) && expiryDate < today) {
        extracted.passportExpired = true;
        warnings.push(`Passport has expired on ${extracted.passportExpiry}. This passport cannot be used for applications.`);
      } else if (!isNaN(expiryDate.getTime())) {
        extracted.passportExpired = false;
      }
    }

    res.json({ extracted, warnings });
    await recordExtractorRun({
      extractorId: extractor.id,
      scope,
      documentCount: documents.length,
      documentTypes: [extracted.documentType].filter(Boolean) as string[],
      model,
      promptTokens: (message as any).usage?.input_tokens ?? null,
      completionTokens: (message as any).usage?.output_tokens ?? null,
      latencyMs: Date.now() - runStart,
      status: "success",
    });
  } catch (err: any) {
    console.error("Public AI extraction error:", err);
    if (err instanceof AiLaneQueueError) {
      res.status(503).json({
        error: "AI analysis is busy. Your documents are safe; please continue manually or try again shortly.",
        code: err.code,
      });
      return;
    }
    res.status(500).json({ error: "AI extraction failed. Please try again." });
  }
});

export default router;
