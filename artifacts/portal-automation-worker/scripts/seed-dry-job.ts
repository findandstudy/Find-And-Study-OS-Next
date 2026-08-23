/**
 * seed-dry-job.ts — dev-only helper: enqueue a dry portal submission.
 *
 * Usage:
 *   pnpm --filter @workspace/portal-automation-worker run-once -- --id <submissionId>
 *   # or first seed, then process:
 *   tsx scripts/seed-dry-job.ts <applicationId> <universityKey>
 *   pnpm --filter @workspace/portal-automation-worker run-once -- --next --dry
 *
 * Example:
 *   tsx scripts/seed-dry-job.ts 42 topkapi
 *
 * ⚠️  DEV ONLY — do NOT run against production with mode='real'.
 *     This script always inserts mode='dry'.
 */

import { db, portalSubmissionsTable, applicationsTable, studentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const [appIdRaw, universityKey] = process.argv.slice(2);

if (!appIdRaw || !universityKey) {
  console.error("Usage: tsx scripts/seed-dry-job.ts <applicationId> <universityKey>");
  console.error("Example: tsx scripts/seed-dry-job.ts 42 topkapi");
  process.exit(1);
}

const applicationId = parseInt(appIdRaw, 10);
if (isNaN(applicationId)) {
  console.error(`Invalid applicationId: "${appIdRaw}"`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Verify application exists and get studentId
  const [app] = await db
    .select({
      id:             applicationsTable.id,
      studentId:      applicationsTable.studentId,
      universityName: applicationsTable.universityName,
      stage:          applicationsTable.stage,
      level:          applicationsTable.level,
    })
    .from(applicationsTable)
    .where(eq(applicationsTable.id, applicationId));

  if (!app) {
    console.error(`Application #${applicationId} not found`);
    process.exit(1);
  }

  console.log(`[seed-dry-job] Application #${app.id}`);
  console.log(`  university : ${app.universityName}`);
  console.log(`  level      : ${app.level}`);
  console.log(`  stage      : ${app.stage}`);

  // Verify student exists
  const [student] = await db
    .select({ id: studentsTable.id, email: studentsTable.email })
    .from(studentsTable)
    .where(eq(studentsTable.id, app.studentId!));

  if (!student) {
    console.error(`Student not found for application #${applicationId}`);
    process.exit(1);
  }

  // Insert dry submission
  const [sub] = await db
    .insert(portalSubmissionsTable)
    .values({
      applicationId: app.id,
      studentId:     student.id,
      universityKey,
      universityName: app.universityName ?? universityKey,
      mode:   "dry",
      status: "queued",
    })
    .returning({
      id:     portalSubmissionsTable.id,
      status: portalSubmissionsTable.status,
      mode:   portalSubmissionsTable.mode,
    });

  console.log(`[seed-dry-job] Created portal_submission:`);
  console.log(`  id            : ${sub.id}`);
  console.log(`  status        : ${sub.status}`);
  console.log(`  mode          : ${sub.mode}`);
  console.log(`  universityKey : ${universityKey}`);
  console.log(``);
  console.log(`[seed-dry-job] Run next:`);
  console.log(`  pnpm --filter @workspace/portal-automation-worker run-once -- --id ${sub.id} --dry`);
  console.log(`  # or claim from queue:`);
  console.log(`  pnpm --filter @workspace/portal-automation-worker run-once -- --next --dry`);
}

main().catch((err) => {
  console.error("[seed-dry-job] Fatal:", err);
  process.exit(1);
});
