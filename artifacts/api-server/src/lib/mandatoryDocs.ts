import {
  db,
  applicationsTable,
  documentsTable,
  programsTable,
} from "@workspace/db";
import { eq, and, isNull, ne, or } from "drizzle-orm";
import { findMissingMandatoryTypes } from "@workspace/doc-equivalence";
import { adoptLeadDocsForStudent } from "./leadDocAdoption";
import {
  getEffectiveDocRequirements,
  mandatoryDocTypes,
} from "./effectiveDocRequirements";

export interface MandatoryDocCheckResult {
  missing: string[];
  mandatory: string[];
  level: string | null;
}

/**
 * Returns mandatory document types for a program that the given upload set
 * does NOT yet cover (equivalence-aware).
 *
 * Pass `uploadedDocTypes` as the doc types already provided by the student
 * (apply-key short names OR canonical type names — both are handled by
 * `findMissingMandatoryTypes`).
 *
 * Returns `{ missing: [] }` when the program has no mandatory requirements or
 * all requirements are satisfied.
 */
export async function checkMandatoryDocs(
  programId: number | null,
  uploadedDocTypes: string[],
  level?: string | null,
): Promise<MandatoryDocCheckResult> {
  let resolvedLevel = (level || "").trim() || null;
  if (!resolvedLevel && programId) {
    const [program] = await db
      .select({ degree: programsTable.degree })
      .from(programsTable)
      .where(eq(programsTable.id, programId))
      .limit(1);
    resolvedLevel = (program?.degree || "").trim() || null;
  }

  if (!programId && !resolvedLevel) {
    return { missing: [], mandatory: [], level: null };
  }

  const requirements = await getEffectiveDocRequirements({
    programId,
    level: resolvedLevel,
  });
  const effectiveMandatoryTypes = mandatoryDocTypes(requirements);
  if (effectiveMandatoryTypes.length === 0) {
    return { missing: [], mandatory: [], level: resolvedLevel };
  }

  const uploadedSet = new Set(uploadedDocTypes.map((t) => t.toLowerCase()));
  const missing = findMissingMandatoryTypes(
    effectiveMandatoryTypes,
    uploadedSet,
  );

  return { missing, mandatory: effectiveMandatoryTypes, level: resolvedLevel };
}

/**
 * Convenience: fetch all non-rejected documents for a student from
 * `documentsTable` and check whether the program's mandatory requirements
 * are met. Used after document auto-linking in apply flows.
 */
export async function checkMandatoryDocsForStudent(
  programId: number | null,
  studentId: number,
  level?: string | null,
): Promise<MandatoryDocCheckResult> {
  const fetchTypes = async () => {
    const rows = await db
      .select({ type: documentsTable.type })
      .from(documentsTable)
      .where(
        and(
          eq(documentsTable.studentId, studentId),
          isNull(documentsTable.deletedAt),
          // Rejected documents do not satisfy mandatory requirements — the student
          // must upload a replacement before the application can advance.
          or(
            isNull(documentsTable.status),
            ne(documentsTable.status, "rejected"),
          ),
        ),
      );
    return rows.map((r) => String(r.type || "")).filter(Boolean);
  };

  let result = await checkMandatoryDocs(programId, await fetchTypes(), level);
  if (result.missing.length > 0) {
    // Docs may still be staged on a linked lead (inbox flows). Adopt them
    // onto the student, then re-check before reporting them missing.
    const adopted = await adoptLeadDocsForStudent(studentId);
    if (adopted > 0) {
      result = await checkMandatoryDocs(programId, await fetchTypes(), level);
    }
  }
  return result;
}

/**
 * Defense-in-depth gate for portal automation and other application-centric
 * flows. It derives program, level and student from the persisted application,
 * then applies the exact same effective program+degree requirements used by
 * the creation forms.
 */
export async function checkMandatoryDocsForApplication(
  applicationId: number,
): Promise<MandatoryDocCheckResult | null> {
  const [app] = await db
    .select({
      programId: applicationsTable.programId,
      level: applicationsTable.level,
      studentId: applicationsTable.studentId,
    })
    .from(applicationsTable)
    .where(
      and(
        eq(applicationsTable.id, applicationId),
        isNull(applicationsTable.deletedAt),
      ),
    )
    .limit(1);

  if (!app) return null;
  return checkMandatoryDocsForStudent(app.programId, app.studentId, app.level);
}

/**
 * Move a newly-created application to the built-in "missing_docs" pipeline
 * stage so it sits in a visible, actionable state rather than polluting the
 * inquiry queue.
 */
export async function parkApplicationInMissingDocsStage(
  applicationId: number,
): Promise<boolean> {
  const rows = await db
    .update(applicationsTable)
    .set({ stage: "missing_docs", updatedAt: new Date() })
    .where(and(
      eq(applicationsTable.id, applicationId),
      eq(applicationsTable.stage, "inquiry"),
      isNull(applicationsTable.deletedAt),
    ))
    .returning({ id: applicationsTable.id });
  return rows.length > 0;
}

/**
 * Re-evaluate a "missing_docs"-parked application after a new document is
 * uploaded. If all mandatory docs for the program are now present in the
 * student's document library, advance the application back to "inquiry".
 *
 * Returns `true` when the application was advanced, `false` otherwise.
 * No-op (returns false) when the application is not in the "missing_docs" stage.
 */
export async function reEvaluateMandatoryDocs(
  applicationId: number,
): Promise<boolean> {
  const [app] = await db
    .select({
      id: applicationsTable.id,
      stage: applicationsTable.stage,
      programId: applicationsTable.programId,
      level: applicationsTable.level,
      studentId: applicationsTable.studentId,
    })
    .from(applicationsTable)
    .where(eq(applicationsTable.id, applicationId));

  if (!app || app.stage !== "missing_docs") return false;

  const { missing } = await checkMandatoryDocsForStudent(
    app.programId,
    app.studentId,
    app.level,
  );
  if (missing.length > 0) return false;

  await db
    .update(applicationsTable)
    .set({ stage: "inquiry", updatedAt: new Date() })
    .where(eq(applicationsTable.id, applicationId));

  return true;
}

/**
 * Re-evaluate every active application that is waiting for profile-level
 * documents for the same student.
 *
 * A passport/diploma uploaded from the student or converted-lead profile is a
 * shared student document, not an application-only upload. Consequently all
 * of the student's `missing_docs` applications must see the new evidence.
 * Application-scoped uploads still call `reEvaluateMandatoryDocs()` for only
 * their explicit application and do not use this helper.
 */
export async function reEvaluateMandatoryDocsForStudent(
  studentId: number,
): Promise<number[]> {
  const applications = await db
    .select({ id: applicationsTable.id })
    .from(applicationsTable)
    .where(and(
      eq(applicationsTable.studentId, studentId),
      eq(applicationsTable.stage, "missing_docs"),
      isNull(applicationsTable.deletedAt),
    ));

  const advanced: number[] = [];
  for (const application of applications) {
    if (await reEvaluateMandatoryDocs(application.id)) {
      advanced.push(application.id);
    }
  }
  return advanced;
}
