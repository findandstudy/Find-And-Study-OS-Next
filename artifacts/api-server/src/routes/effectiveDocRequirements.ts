import { Router, type IRouter } from "express";
import { db, documentsTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { findMissingMandatoryTypes } from "@workspace/doc-equivalence";
import { requireAuth } from "../lib/auth";
import {
  getEffectiveDocRequirements,
  mandatoryDocTypes,
} from "../lib/effectiveDocRequirements";
import { getAdoptableLeadDocTypes } from "../lib/leadDocAdoption";
import { getDocLabel } from "../lib/docNaming";
import { assertCanAccessStudent } from "../lib/studentAccess";

const router: IRouter = Router();

/**
 * GET /document-requirements/effective?programId=&level=
 *
 * The merged (program + degree) document-requirement list — the exact set the
 * POST /applications mandatory-doc gate enforces. UI lists must use this.
 */
router.get(
  "/document-requirements/effective",
  requireAuth,
  async (req, res): Promise<void> => {
    const programIdRaw = req.query.programId ? String(req.query.programId) : "";
    const programId = programIdRaw ? parseInt(programIdRaw, 10) : null;
    if (programIdRaw && (programId === null || isNaN(programId))) {
      res.status(400).json({ error: "Invalid programId" });
      return;
    }
    const level = req.query.level ? String(req.query.level) : null;
    if (!programId && !level) {
      res.status(400).json({ error: "programId or level is required" });
      return;
    }

    const reqs = await getEffectiveDocRequirements({ programId, level });
    const requirements = reqs.map((r) => ({ ...r, label: getDocLabel(r.documentType) }));
    res.json({
      programId: programId ?? null,
      level: level ?? null,
      programSpecific: reqs.some((r) => r.source === "program"),
      requirements,
    });
  },
);

/**
 * GET /students/:id/application-doc-preflight?programId=&level=
 *
 * Dry-run of the POST /applications mandatory-doc gate: which mandatory
 * document types would be reported missing. Counts student-owned docs PLUS
 * lead docs that the gate would adopt automatically, so the warning matches
 * what actually happens at submit time. Read-only, never mutates.
 */
router.get(
  "/students/:id/application-doc-preflight",
  requireAuth,
  async (req, res): Promise<void> => {
    const studentId = parseInt(String(req.params.id), 10);
    if (isNaN(studentId)) {
      res.status(400).json({ error: "Invalid student id" });
      return;
    }
    // Same record-level authorization as GET /students/:id — prevents
    // ID-enumeration of student existence / doc gaps (IDOR).
    const access = await assertCanAccessStudent(req, studentId);
    if (!access.ok) {
      res.status(access.status).json({ error: access.error });
      return;
    }

    const programIdRaw = req.query.programId ? String(req.query.programId) : "";
    const programId = programIdRaw ? parseInt(programIdRaw, 10) : null;
    if (programIdRaw && (programId === null || isNaN(programId))) {
      res.status(400).json({ error: "Invalid programId" });
      return;
    }
    const level = req.query.level ? String(req.query.level) : null;

    const reqs = await getEffectiveDocRequirements({ programId, level });
    const allMandatoryTypes = mandatoryDocTypes(reqs);
    if (allMandatoryTypes.length === 0) {
      res.json({ missingDocTypes: [], missingDocs: [], mandatoryCount: 0 });
      return;
    }

    const [studentDocs, adoptableTypes] = await Promise.all([
      db
        .select({ type: documentsTable.type })
        .from(documentsTable)
        .where(and(
          eq(documentsTable.studentId, studentId),
          isNull(documentsTable.deletedAt),
        )),
      getAdoptableLeadDocTypes(studentId),
    ]);
    const uploadedTypes = new Set<string>([
      ...studentDocs.map((d) => (d.type || "").toLowerCase()),
      ...adoptableTypes.map((t) => t.toLowerCase()),
    ]);
    uploadedTypes.delete("");

    const missingDocTypes = findMissingMandatoryTypes(allMandatoryTypes, uploadedTypes);
    const missingDocs = missingDocTypes.map((type) => ({ type, label: getDocLabel(type) }));
    res.json({
      missingDocTypes,
      missingDocs,
      mandatoryCount: allMandatoryTypes.length,
    });
  },
);

export default router;
