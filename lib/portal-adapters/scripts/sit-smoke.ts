/**
 * sit-smoke.ts — credential-gated live smoke test for the SIT adapter.
 *
 * Runs a real browser flow: login → createStudent (1) → createApplication (1).
 * SKIPS CLEANLY when SIT credentials are absent, so it is safe to run in CI /
 * dev environments without secrets.
 *
 * Required env (all must be present to run):
 *   SIT_EMAIL (or SIT_USER), SIT_PASSWORD
 * Optional (override the built-in placeholder profile):
 *   SIT_SMOKE_UNIVERSITY   default: "Beykoz Üniversitesi"
 *   SIT_SMOKE_PROGRAM      default: "Business Administration"
 *   SIT_SMOKE_LEVEL        default: "Bachelor"
 *   SIT_SMOKE_DRYRUN       "1" (default) = fill but never click final submit;
 *                          "0" = perform the real writes (creates data!)
 *
 * Run with:
 *   pnpm --filter @workspace/portal-adapters run smoke:sit
 */
import { sitAdapter } from "../src/universities/sit/adapter.js";
import type { SubmitProfile, SubmitFiles } from "../src/types.js";

function hasCreds(): boolean {
  return Boolean(
    (process.env.SIT_EMAIL || process.env.SIT_USER) && process.env.SIT_PASSWORD,
  );
}

async function main(): Promise<void> {
  if (!hasCreds()) {
    console.log(
      "[sit-smoke] SKIP — SIT credentials not set (SIT_EMAIL/SIT_USER + SIT_PASSWORD). " +
        "Nothing to do.",
    );
    return;
  }

  const dryRun = (process.env.SIT_SMOKE_DRYRUN ?? "1") !== "0";
  console.log(`[sit-smoke] starting (dryRun=${dryRun})`);

  const profile: SubmitProfile = {
    email: "sit.smoke+test@example.com",
    passportNumber: "SMOKE000000",
    firstName: "Smoke",
    lastName: "Test",
    dateOfBirth: "2000-01-01",
    gender: "Male",
    fatherName: "Father Test",
    motherName: "Mother Test",
    nationality: "Uzbekistan",
    address: "Test Address 1",
    phone: "5551234567",
    level: process.env.SIT_SMOKE_LEVEL ?? "Bachelor",
    programName: process.env.SIT_SMOKE_PROGRAM ?? "Business Administration",
    programId: "",
    universityName: process.env.SIT_SMOKE_UNIVERSITY ?? "Beykoz Üniversitesi",
    schoolName: "Smoke High School",
    gpa: 85,
    graduationYear: 2018,
  };
  const files: SubmitFiles = {};

  const session = await sitAdapter.login({ headless: true });
  try {
    const student = await sitAdapter.createStudent(session, profile, files, !dryRun);
    console.log("[sit-smoke] createStudent:", JSON.stringify(student));

    const app = await sitAdapter.createApplication(
      session,
      profile,
      student.studentId,
      !dryRun,
    );
    console.log("[sit-smoke] createApplication:", JSON.stringify(app));
    console.log("[sit-smoke] DONE");
  } finally {
    await session.close().catch(() => {});
  }
}

main().catch((err: unknown) => {
  console.error(
    "[sit-smoke] FAILED:",
    err instanceof Error ? err.stack ?? err.message : String(err),
  );
  process.exitCode = 1;
});
