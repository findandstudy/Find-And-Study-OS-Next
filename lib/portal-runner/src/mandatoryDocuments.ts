import {
  applicationsTable,
  catalogOptionsTable,
  db,
  degreeDocumentRequirementsTable,
  documentsTable,
  programDocumentRequirementsTable,
} from "@workspace/db";
import { findMissingMandatoryTypes } from "@workspace/doc-equivalence";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";

export interface EffectiveDocRequirement {
  documentType: string;
  mandatory: boolean;
  sortOrder: number;
  source: "program" | "degree";
}

export interface ApplicationMandatoryDocumentStatus {
  applicationId: number;
  studentId: number;
  level: string | null;
  mandatory: string[];
  uploaded: string[];
  missing: string[];
}

/**
 * Canonical requirement resolver shared by the API and the production worker.
 * Degree defaults and program-specific rules are merged by document type;
 * either source marking a type Mandatory makes the effective type Mandatory.
 */
export async function getEffectiveDocRequirements(opts: {
  programId?: number | null;
  level?: string | null;
}): Promise<EffectiveDocRequirement[]> {
  const programId =
    opts.programId != null && Number.isFinite(Number(opts.programId))
      ? Number(opts.programId)
      : null;
  const level = (opts.level || "").trim() || null;

  const [programReqs, degreeOptRows] = await Promise.all([
    programId
      ? db
          .select({
            documentType: programDocumentRequirementsTable.documentType,
            mandatory: programDocumentRequirementsTable.mandatory,
            sortOrder: programDocumentRequirementsTable.sortOrder,
          })
          .from(programDocumentRequirementsTable)
          .where(eq(programDocumentRequirementsTable.programId, programId))
      : Promise.resolve(
          [] as {
            documentType: string;
            mandatory: boolean;
            sortOrder: number;
          }[],
        ),
    level
      ? db
          .select({ id: catalogOptionsTable.id })
          .from(catalogOptionsTable)
          .where(
            and(
              eq(catalogOptionsTable.category, "degree"),
              sql`lower(trim(${catalogOptionsTable.value})) = lower(trim(${level}))`,
            ),
          )
      : Promise.resolve([] as { id: number }[]),
  ]);

  const degreeOpt = degreeOptRows[0] ?? null;
  const degreeReqs = degreeOpt
    ? await db
        .select({
          documentType: degreeDocumentRequirementsTable.documentType,
          mandatory: degreeDocumentRequirementsTable.mandatory,
          sortOrder: degreeDocumentRequirementsTable.sortOrder,
        })
        .from(degreeDocumentRequirementsTable)
        .where(
          eq(degreeDocumentRequirementsTable.catalogOptionId, degreeOpt.id),
        )
    : [];

  const merged = new Map<string, EffectiveDocRequirement>();
  for (const requirement of degreeReqs) {
    merged.set(requirement.documentType.toLowerCase(), {
      documentType: requirement.documentType,
      mandatory: requirement.mandatory,
      sortOrder: requirement.sortOrder,
      source: "degree",
    });
  }
  for (const requirement of programReqs) {
    const key = requirement.documentType.toLowerCase();
    const existing = merged.get(key);
    merged.set(
      key,
      existing
        ? {
            ...existing,
            mandatory: existing.mandatory || requirement.mandatory,
            source: "program",
          }
        : {
            documentType: requirement.documentType,
            mandatory: requirement.mandatory,
            sortOrder: 1000 + requirement.sortOrder,
            source: "program",
          },
    );
  }

  return Array.from(merged.values()).sort(
    (a, b) =>
      a.sortOrder - b.sortOrder || a.documentType.localeCompare(b.documentType),
  );
}

export function mandatoryDocTypes(
  requirements: EffectiveDocRequirement[],
): string[] {
  return requirements
    .filter((requirement) => requirement.mandatory)
    .map((requirement) => requirement.documentType);
}

/**
 * Final worker-boundary gate. It is read-only and intentionally performs its
 * own DB read after a queue row is claimed, closing races with document
 * deletion and guarding legacy/stale queued rows.
 */
export async function getApplicationMandatoryDocumentStatus(
  applicationId: number,
): Promise<ApplicationMandatoryDocumentStatus | null> {
  const [application] = await db
    .select({
      id: applicationsTable.id,
      studentId: applicationsTable.studentId,
      programId: applicationsTable.programId,
      level: applicationsTable.level,
    })
    .from(applicationsTable)
    .where(
      and(
        eq(applicationsTable.id, applicationId),
        isNull(applicationsTable.deletedAt),
      ),
    )
    .limit(1);
  if (!application) return null;

  const [requirements, documents] = await Promise.all([
    getEffectiveDocRequirements({
      programId: application.programId,
      level: application.level,
    }),
    db
      .select({ type: documentsTable.type })
      .from(documentsTable)
      .where(
        and(
          eq(documentsTable.studentId, application.studentId),
          isNull(documentsTable.deletedAt),
          or(
            isNull(documentsTable.status),
            ne(documentsTable.status, "rejected"),
          ),
        ),
      ),
  ]);

  const mandatory = mandatoryDocTypes(requirements);
  const uploaded = documents
    .map((document) => String(document.type || "").trim())
    .filter(Boolean);
  const missing = findMissingMandatoryTypes(
    mandatory,
    new Set(uploaded.map((type) => type.toLowerCase())),
  );

  return {
    applicationId: application.id,
    studentId: application.studentId,
    level: application.level,
    mandatory,
    uploaded,
    missing,
  };
}
