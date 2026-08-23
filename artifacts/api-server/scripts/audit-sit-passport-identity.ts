/**
 * Audit historical real SIT submissions against the student's latest passport.
 *
 * The report never prints passport numbers or extracted document contents.
 * It may persist a fresh high-confidence extraction and an audit-log record,
 * using the same verification path as production preflight.
 *
 * Usage (DATABASE_URL + AI provider configuration required):
 *   pnpm --filter @workspace/api-server exec tsx scripts/audit-sit-passport-identity.ts
 */

import {
  db,
  portalSubmissionsTable,
  studentsTable,
} from "@workspace/db";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { verifyStudentIdentityAgainstPassport } from "../src/lib/portalProfileAutoExtract.js";

const FINAL_PORTAL_STATUSES = ["submitted", "already_exists"] as const;

type AuditRow = {
  studentId: number;
  studentName: string;
  submissionIds: number[];
  applicationIds: number[];
  externalRefs: string[];
  status: Awaited<ReturnType<typeof verifyStudentIdentityAgainstPassport>>["status"];
  fields: string[];
  documentId?: number;
};

async function main(): Promise<void> {
  const rows = await db
    .select({
      submissionId: portalSubmissionsTable.id,
      applicationId: portalSubmissionsTable.applicationId,
      studentId: portalSubmissionsTable.studentId,
      externalRef: portalSubmissionsTable.externalRef,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
    })
    .from(portalSubmissionsTable)
    .innerJoin(studentsTable, eq(studentsTable.id, portalSubmissionsTable.studentId))
    .where(and(
      eq(portalSubmissionsTable.mode, "real"),
      or(
        eq(portalSubmissionsTable.adapterKey, "sit"),
        eq(portalSubmissionsTable.universityKey, "sit"),
      ),
      inArray(portalSubmissionsTable.status, [...FINAL_PORTAL_STATUSES]),
      isNull(portalSubmissionsTable.deletedAt),
      isNull(studentsTable.deletedAt),
    ))
    .orderBy(asc(portalSubmissionsTable.studentId), asc(portalSubmissionsTable.id));

  const grouped = new Map<number, typeof rows>();
  for (const row of rows) {
    if (row.studentId == null) continue;
    const current = grouped.get(row.studentId) ?? [];
    current.push(row);
    grouped.set(row.studentId, current);
  }

  const report: AuditRow[] = [];
  for (const [studentId, submissions] of grouped) {
    const verification = await verifyStudentIdentityAgainstPassport({
      studentId,
      actorUserId: null,
      ip: "sit-passport-identity-audit",
    });
    const first = submissions[0];
    report.push({
      studentId,
      studentName: `${first.firstName ?? ""} ${first.lastName ?? ""}`.trim(),
      submissionIds: submissions.map((row) => row.submissionId),
      applicationIds: submissions.map((row) => row.applicationId),
      externalRefs: [...new Set(
        submissions
          .map((row) => row.externalRef)
          .filter((value): value is string => Boolean(value)),
      )],
      status: verification.status,
      fields: verification.fields,
      ...(verification.documentId != null
        ? { documentId: verification.documentId }
        : {}),
    });
  }

  const mismatches = report.filter((row) => row.status === "mismatch");
  const manualReview = report.filter((row) =>
    row.status !== "verified" && row.status !== "mismatch"
  );
  const verified = report.filter((row) => row.status === "verified");

  console.log(JSON.stringify({
    summary: {
      studentsAudited: report.length,
      verified: verified.length,
      mismatches: mismatches.length,
      manualReview: manualReview.length,
    },
    mismatches,
    manualReview,
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("SIT identity audit failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
