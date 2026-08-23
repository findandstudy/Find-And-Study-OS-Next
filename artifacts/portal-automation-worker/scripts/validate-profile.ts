/**
 * validate-profile.ts — smoke-test buildStudentProfile without claiming/running.
 *
 * Usage:
 *   pnpm --filter @workspace/portal-automation-worker run validate-profile -- --id <submission_id>
 *
 * Exit codes:
 *   0 — all 4 doc slots filled (photo, passport, transcript, diploma)
 *   2 — one or more slots missing (check output for detail)
 *   1 — error (submission not found, profile build threw, etc.)
 */

import { buildStudentProfile } from "../src/profile.js";

const args = process.argv.slice(2);
const idArg = args.findIndex((a) => a === "--id");
const submissionId = idArg !== -1 ? parseInt(args[idArg + 1] ?? "", 10) : NaN;

if (isNaN(submissionId)) {
  console.error("Usage: validate-profile -- --id <submission_id>");
  process.exit(1);
}

console.log(`[validate-profile] Testing buildStudentProfile for submission #${submissionId} …\n`);

try {
  const result = await buildStudentProfile(submissionId);

  console.log("Profile fields:");
  console.log("  email      :", result.profile.email);
  console.log("  name       :", result.profile.firstName, result.profile.lastName);
  console.log("  program    :", result.profile.programName);
  console.log("  programId  :", result.profile.programId);
  console.log("  level      :", result.profile.level);
  console.log("");
  console.log("Document slots:");
  console.log("  filled     :", result.filledSlots.join(", ") || "(none)");
  console.log("  missing    :", result.missingSlots.join(", ") || "(none — all 4 filled ✓)");

  if (Object.keys(result.downloadErrors).length > 0) {
    console.log("\nDownload errors:");
    for (const [slot, err] of Object.entries(result.downloadErrors)) {
      console.log(`  ${slot}: ${err}`);
    }
  }

  if (result.missingSlots.length === 0) {
    console.log("\n✅ PASS — all 4 document slots resolved");
    process.exit(0);
  } else {
    console.log(`\n❌ FAIL — ${result.missingSlots.length} slot(s) missing`);
    process.exit(2);
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[validate-profile] Error: ${msg}`);
  process.exit(1);
}
