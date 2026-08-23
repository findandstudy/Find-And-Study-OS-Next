/**
 * test-portal-writeback.ts — TW1 / TW2 / TW3 / TW4
 *
 * TW1: writebackResult(submitted=true)      → status='submitted',       stage='awaiting_offer'
 * TW2: writebackResult(programMissing=true) → status='program_missing', stage='documents_collected'
 * TW3: writebackResult(alreadyExists=true)  → status='already_exists',  stage='all_registered'
 * TW4: writebackResult(null / error)        → status='failed', application stage unchanged
 * TW5: writebackResult(programFull=true)     → status='program_full', meta jsonb written, stage unchanged
 * TW6: Altınbaş programFull=true             → status='program_full', stage='quota_full'
 *
 * Run:
 *   pnpm --filter @workspace/portal-automation-worker test:writeback
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  db,
  portalSubmissionsTable,
  applicationsTable,
  studentsTable,
  pipelineStagesTable,
  commissionsTable,
  serviceFeesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { writebackResult, type RunResult } from "@workspace/portal-runner";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RUN = `tw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;

const cleanupSubIds: number[] = [];
const cleanupAppIds: number[] = [];
const cleanupStudentIds: number[] = [];

after(async () => {
  for (const id of cleanupSubIds)     await db.delete(portalSubmissionsTable).where(eq(portalSubmissionsTable.id, id)).catch(() => {});
  for (const id of cleanupAppIds)     await db.delete(commissionsTable).where(eq(commissionsTable.applicationId, id)).catch(() => {});
  for (const id of cleanupAppIds)     await db.delete(serviceFeesTable).where(eq(serviceFeesTable.applicationId, id)).catch(() => {});
  for (const id of cleanupAppIds)     await db.delete(applicationsTable).where(eq(applicationsTable.id, id)).catch(() => {});
  for (const id of cleanupStudentIds) await db.delete(studentsTable).where(eq(studentsTable.id, id)).catch(() => {});
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

async function seedRunningSubmission(): Promise<{ subId: number; appId: number }> {
  const [student] = await db.insert(studentsTable).values({
    firstName: "TW",
    lastName:  `Test_${RUN}`,
    email:     `tw_${Date.now()}@test.local`,
  }).returning({ id: studentsTable.id });
  cleanupStudentIds.push(student.id);

  const [app] = await db.insert(applicationsTable).values({
    studentId:     student.id,
    stage:         "inquiry",
    country:       "Turkey",
    level:         "bachelor",
    season:        new Date().getFullYear().toString(),
    universityName: `TW_Uni_${RUN}`,
    discountedFee: 3250,
    commissionRate: 13,
    currency: "USD",
  }).returning({ id: applicationsTable.id });
  cleanupAppIds.push(app.id);

  const [sub] = await db.insert(portalSubmissionsTable).values({
    applicationId: app.id,
    studentId:     student.id,
    universityKey: `tw_uni_${RUN}`,
    universityName: `TW_Uni_${RUN}`,
    mode:          "dry",
    status:        "running",
    attempts:      1,
    lockedBy:      `worker-tw-${RUN}`,
    lockedAt:      new Date(),
  }).returning({ id: portalSubmissionsTable.id });
  cleanupSubIds.push(sub.id);

  return { subId: sub.id, appId: app.id };
}

function makeRunResult(result: {
  submitted?: boolean;
  alreadyExists?: boolean;
  programMissing?: boolean;
  programFull?: boolean;
  requestedProgram?: { value?: string; name: string };
  openPrograms?: Array<{ value: string; name: string; enabled: boolean }>;
  /** Opt-in dryRun meta flag — only set it for cases that exercise the dry_run
   *  branch (default real mode so the submitted/programMissing/alreadyExists
   *  branches are reachable). */
  dryRun?: boolean;
  adapterKey?: string;
}): RunResult {
  return {
    result: {
      submitted:      result.submitted      ?? false,
      alreadyExists:  result.alreadyExists  ?? false,
      programMissing: result.programMissing ?? false,
      ...(result.programFull      ? { programFull: true }                       : {}),
      ...(result.requestedProgram ? { requestedProgram: result.requestedProgram } : {}),
      ...(result.openPrograms     ? { openPrograms: result.openPrograms }       : {}),
    },
    screenshotUrls: [],
    meta: {
      adapterKey: result.adapterKey ?? "test",
      ...(result.dryRun ? { dryRun: true } : {}),
    },
  };
}

/** Returns the stage key if it exists for entityType='application', or null. */
async function lookupStageKey(key: string): Promise<string | null> {
  const [row] = await db
    .select({ key: pipelineStagesTable.key })
    .from(pipelineStagesTable)
    .where(
      and(
        eq(pipelineStagesTable.entityType, "application"),
        eq(pipelineStagesTable.key, key),
      ),
    );
  return row?.key ?? null;
}

// ---------------------------------------------------------------------------
// TW1 — submitted
// ---------------------------------------------------------------------------

test("TW1: submitted=true → status=submitted, stage=awaiting_offer (if stage exists)", async () => {
  const { subId, appId } = await seedRunningSubmission();

  await writebackResult(subId, makeRunResult({ submitted: true }));

  const [sub] = await db.select().from(portalSubmissionsTable).where(eq(portalSubmissionsTable.id, subId));
  assert.equal(sub.status, "submitted", "submission status=submitted");
  assert.equal(sub.lockedAt, null,      "lockedAt cleared");
  assert.equal(sub.lockedBy, null,      "lockedBy cleared");

  // Stage update is best-effort; verify state is consistent
  const [app] = await db.select({ stage: applicationsTable.stage }).from(applicationsTable).where(eq(applicationsTable.id, appId));
  const stageExists = await lookupStageKey("awaiting_offer");
  if (stageExists) {
    assert.equal(app.stage, "awaiting_offer", "app stage → awaiting_offer");
    const [commission] = await db.select().from(commissionsTable)
      .where(eq(commissionsTable.applicationId, appId));
    assert.equal(commission?.status, "potential", "portal stage writeback creates potential commission");
    assert.equal(commission?.universityCommissionAmount, "422.50", "commission uses discounted fee × rate");
  } else {
    // Stage not in pipeline → app stays at inquiry (best-effort)
    assert.equal(app.stage, "inquiry", "app stage unchanged (stage not in pipeline)");
  }
});

// ---------------------------------------------------------------------------
// TW2 — programMissing
// ---------------------------------------------------------------------------

test("TW2: programMissing=true → status=program_missing, stage=documents_collected (if stage exists)", async () => {
  const { subId, appId } = await seedRunningSubmission();

  await writebackResult(subId, makeRunResult({ programMissing: true }));

  const [sub] = await db.select().from(portalSubmissionsTable).where(eq(portalSubmissionsTable.id, subId));
  assert.equal(sub.status, "program_missing", "submission status=program_missing");

  const [app] = await db.select({ stage: applicationsTable.stage }).from(applicationsTable).where(eq(applicationsTable.id, appId));
  const stageExists = await lookupStageKey("documents_collected");
  if (stageExists) {
    assert.equal(app.stage, "documents_collected", "app stage → documents_collected");
  } else {
    assert.equal(app.stage, "inquiry", "app stage unchanged (stage not in pipeline)");
  }
});

// ---------------------------------------------------------------------------
// TW3 — alreadyExists
// ---------------------------------------------------------------------------

test("TW3: alreadyExists=true → status=already_exists, stage=all_registered (if stage exists)", async () => {
  const { subId, appId } = await seedRunningSubmission();

  await writebackResult(subId, makeRunResult({ alreadyExists: true }));

  const [sub] = await db.select().from(portalSubmissionsTable).where(eq(portalSubmissionsTable.id, subId));
  assert.equal(sub.status, "already_exists", "submission status=already_exists");

  const [app] = await db.select({ stage: applicationsTable.stage }).from(applicationsTable).where(eq(applicationsTable.id, appId));
  const stageExists = await lookupStageKey("all_registered");
  if (stageExists) {
    assert.equal(app.stage, "all_registered", "app stage → all_registered");
    const [commission] = await db.select().from(commissionsTable)
      .where(eq(commissionsTable.applicationId, appId));
    assert.equal(commission, undefined, "lost stage does not create a commission row");
  } else {
    assert.equal(app.stage, "inquiry", "app stage unchanged (stage not in pipeline)");
  }
});

// ---------------------------------------------------------------------------
// TW4 — error / null result → failed, no stage change
// ---------------------------------------------------------------------------

test("TW4: null result (error) → status=failed, application stage unchanged", async () => {
  const { subId, appId } = await seedRunningSubmission();

  await writebackResult(subId, null, "ADAPTER_CRASH: connection refused");

  const [sub] = await db.select().from(portalSubmissionsTable).where(eq(portalSubmissionsTable.id, subId));
  assert.equal(sub.status, "failed",                               "submission status=failed");
  assert.ok(sub.error?.includes("ADAPTER_CRASH"),                  "error message stored");

  const [app] = await db.select({ stage: applicationsTable.stage }).from(applicationsTable).where(eq(applicationsTable.id, appId));
  assert.equal(app.stage, "inquiry", "application stage unchanged (stays inquiry)");
});

// ---------------------------------------------------------------------------
// TW5 — programFull (dry run) → program_full, meta written, no stage change
// ---------------------------------------------------------------------------

test("TW5: programFull=true (dry) → status=program_full, meta written, stage unchanged", async () => {
  const { subId, appId } = await seedRunningSubmission();

  await writebackResult(
    subId,
    makeRunResult({
      programFull:      true,
      dryRun:           true, // program_full must win even when dry_run is set
      requestedProgram: { value: "111", name: "Tıp" },
      openPrograms: [
        { value: "82",  name: "Bilgisayar Mühendisliği", enabled: true },
        { value: "111", name: "Tıp",                      enabled: false },
      ],
    }),
  );

  const [sub] = await db.select().from(portalSubmissionsTable).where(eq(portalSubmissionsTable.id, subId));
  // program_full takes priority over dry_run — it is a structural finding.
  assert.equal(sub.status, "program_full", "submission status=program_full (even in dry mode)");

  const meta = sub.meta as {
    requestedProgram?: { value?: string; name: string };
    openPrograms?: Array<{ value: string; name: string; enabled: boolean }>;
    reason?: string;
    detectedAt?: string;
  } | null;
  assert.ok(meta, "meta jsonb written");
  assert.equal(meta?.reason, "Kontenjan dolu",      "meta.reason set");
  assert.equal(meta?.requestedProgram?.value, "111", "meta.requestedProgram.value set");
  assert.equal(meta?.requestedProgram?.name,  "Tıp", "meta.requestedProgram.name set");
  assert.equal(meta?.openPrograms?.length, 2,         "meta.openPrograms populated");
  assert.equal(meta?.openPrograms?.find((p) => p.value === "82")?.enabled,  true,  "open program enabled=true");
  assert.equal(meta?.openPrograms?.find((p) => p.value === "111")?.enabled, false, "full program enabled=false");
  assert.ok(meta?.detectedAt, "meta.detectedAt set");

  const [app] = await db.select({ stage: applicationsTable.stage }).from(applicationsTable).where(eq(applicationsTable.id, appId));
  assert.equal(app.stage, "inquiry", "application stage unchanged (no stage change)");
});

test("TW6: Altınbaş programFull=true → status=program_full, stage=quota_full (if stage exists)", async () => {
  const { subId, appId } = await seedRunningSubmission();

  await writebackResult(
    subId,
    makeRunResult({
      adapterKey: "altinbas",
      programFull: true,
      requestedProgram: { value: "a0A_FULL", name: "Data Analytics (With Thesis)" },
      openPrograms: [
        { value: "a0A_OPEN", name: "Biomedical Sciences (With Thesis)", enabled: true },
        { value: "a0A_FULL", name: "Data Analytics (With Thesis)", enabled: false },
      ],
    }),
  );

  const [sub] = await db
    .select()
    .from(portalSubmissionsTable)
    .where(eq(portalSubmissionsTable.id, subId));
  assert.equal(sub.status, "program_full", "submission status=program_full");

  const [app] = await db
    .select({ stage: applicationsTable.stage })
    .from(applicationsTable)
    .where(eq(applicationsTable.id, appId));
  const stageExists = await lookupStageKey("quota_full");
  if (stageExists) {
    assert.equal(app.stage, "quota_full", "Altınbaş app stage → quota_full");
  } else {
    assert.equal(app.stage, "inquiry", "stage absent → application unchanged");
  }
});
