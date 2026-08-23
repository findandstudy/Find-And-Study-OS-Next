/**
 * test-portal-trigger.ts — Run Now + event-driven enqueue regression tests
 *
 * Lib-level (no draining — exercises the shared eligibility gate directly):
 *   RN1: scanAndEnqueueTriggerStageApplications enqueues an eligible trigger-stage
 *        application (queued >= 1; our app gets a queued submission).
 *   RN2: dedup — a second scan does NOT create a duplicate submission for the
 *        same application × universityKey (reasons.duplicate surfaced).
 *   RN3: deleted applications are skipped by the scan (deletedAt set → no sub).
 *   RN4: no-adapter — enqueueIfEligible skips with no_active_portal_university
 *        when the application's university has no active portal_universities row.
 *   RN5: event-driven stage INTO trigger → maybeEnqueuePortalSubmission enqueues.
 *   RN6: event-driven stage OUT of trigger → no enqueue.
 *   RN7: idempotent hook — calling maybeEnqueuePortalSubmission twice creates
 *        exactly one submission.
 *
 * HTTP-level (POST /portal-automation/run-now):
 *   RN8: 403 when caller lacks an admin role (RBAC).
 *   RN9: 409 AUTOMATION_DISABLED when settings.isEnabled = false.
 *   RN10: 200 + correct response shape when enabled (admin); drains in-process.
 *
 * Run:
 *   pnpm --filter @workspace/api-server run test:portal-trigger
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express } from "express";
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  applicationsTable,
  studentsTable,
  portalAutomationSettingsTable,
  portalUniversitiesTable,
  portalSubmissionsTable,
} from "@workspace/db";
import {
  enqueueIfEligible,
  maybeEnqueuePortalSubmission,
  scanAndEnqueueTriggerStageApplications,
} from "../src/lib/portalAutoTrigger.js";
import portalAutomationRouter from "../src/routes/portalAutomation.js";

// ---------------------------------------------------------------------------
// Run-specific unique keys (avoid cross-run pollution)
// ---------------------------------------------------------------------------
const RUN = `rnt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;

const ADAPTER_KEY   = `test_${RUN}`;
const UNI_KEY       = `uni_${RUN}`;
const UNI_NAME      = `RNT Test University ${RUN}`;
const TRIGGER_STAGE = `rnt_stage_${RUN}`;
const OTHER_STAGE   = `rnt_other_${RUN}`;

// Credential injection — set env vars so checkHasPortalCredentials() returns true
const ENV_PREFIX = ADAPTER_KEY.toUpperCase().replace(/-/g, "_");
process.env[`${ENV_PREFIX}_USER`]     = "rnt-test-user";
process.env[`${ENV_PREFIX}_PASSWORD`] = "rnt-test-pass";

// ---------------------------------------------------------------------------
// Saved originals + cleanup tracking
// ---------------------------------------------------------------------------
let savedSettings: Record<string, unknown> | null = null;
let settingsRowId: number | null = null;

const cleanupStudentIds:   number[] = [];
const cleanupAppIds:       number[] = [];
const cleanupSubIds:       number[] = [];
const cleanupPortalUniIds: number[] = [];

type PortalSettings = typeof portalAutomationSettingsTable.$inferSelect;

/** Returns the (single) settings row — used as the gate input for lib calls. */
async function getSettings(): Promise<PortalSettings> {
  const [row] = await db.select().from(portalAutomationSettingsTable).limit(1);
  assert.ok(row, "settings row exists");
  return row;
}

// ---------------------------------------------------------------------------
// before — create shared fixtures
// ---------------------------------------------------------------------------
before(async () => {
  const [existing] = await db.select().from(portalAutomationSettingsTable).limit(1);
  if (existing) {
    savedSettings = existing as Record<string, unknown>;
    await db
      .update(portalAutomationSettingsTable)
      .set({
        isEnabled:              true,
        triggerStages:          [TRIGGER_STAGE],
        mode:                   "dry",
        scope:                  "only_applied",
        selectedUniversityKeys: [],
      })
      .where(eq(portalAutomationSettingsTable.id, existing.id));
    settingsRowId = existing.id;
  } else {
    const [ins] = await db
      .insert(portalAutomationSettingsTable)
      .values({
        isEnabled:              true,
        triggerStages:          [TRIGGER_STAGE],
        mode:                   "dry",
        scope:                  "only_applied",
        selectedUniversityKeys: [],
      })
      .returning({ id: portalAutomationSettingsTable.id });
    settingsRowId = ins.id;
  }

  const [pu] = await db
    .insert(portalUniversitiesTable)
    .values({
      universityKey:  UNI_KEY,
      universityName: UNI_NAME,
      adapterKey:     ADAPTER_KEY,
      isActive:       true,
    })
    .returning({ id: portalUniversitiesTable.id });
  cleanupPortalUniIds.push(pu.id);
});

// ---------------------------------------------------------------------------
// after — restore settings + clean test data
// ---------------------------------------------------------------------------
after(async () => {
  if (savedSettings && settingsRowId) {
    const { isEnabled, triggerStages, mode, scope, selectedUniversityKeys } =
      savedSettings as {
        isEnabled: boolean;
        triggerStages: string[];
        mode: "dry" | "real";
        scope: "only_applied" | "selected" | "all";
        selectedUniversityKeys: string[];
      };
    await db
      .update(portalAutomationSettingsTable)
      .set({ isEnabled, triggerStages, mode, scope, selectedUniversityKeys })
      .where(eq(portalAutomationSettingsTable.id, settingsRowId))
      .catch(() => {});
  } else if (settingsRowId && !savedSettings) {
    await db
      .delete(portalAutomationSettingsTable)
      .where(eq(portalAutomationSettingsTable.id, settingsRowId))
      .catch(() => {});
  }

  for (const id of cleanupSubIds) {
    await db.delete(portalSubmissionsTable).where(eq(portalSubmissionsTable.id, id)).catch(() => {});
  }
  // Also clear any submissions auto-created for our apps that we didn't track.
  for (const id of cleanupAppIds) {
    await db.delete(portalSubmissionsTable).where(eq(portalSubmissionsTable.applicationId, id)).catch(() => {});
  }
  for (const id of cleanupPortalUniIds) {
    await db.delete(portalUniversitiesTable).where(eq(portalUniversitiesTable.id, id)).catch(() => {});
  }
  for (const id of cleanupAppIds) {
    await db.delete(applicationsTable).where(eq(applicationsTable.id, id)).catch(() => {});
  }
  for (const id of cleanupStudentIds) {
    await db.delete(studentsTable).where(eq(studentsTable.id, id)).catch(() => {});
  }
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------
async function seedApp(opts?: {
  stage?: string;
  universityName?: string;
  deleted?: boolean;
}): Promise<{ studentId: number; appId: number }> {
  const [student] = await db
    .insert(studentsTable)
    .values({
      firstName: "RNT",
      lastName:  `Test_${RUN}`,
      email:     `rnt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@test.local`,
    })
    .returning({ id: studentsTable.id });
  cleanupStudentIds.push(student.id);

  const [app] = await db
    .insert(applicationsTable)
    .values({
      studentId:      student.id,
      universityName: opts?.universityName ?? UNI_NAME,
      stage:          opts?.stage ?? TRIGGER_STAGE,
      season:         "2026",
      ...(opts?.deleted ? { deletedAt: new Date() } : {}),
    })
    .returning({ id: applicationsTable.id });
  cleanupAppIds.push(app.id);

  return { studentId: student.id, appId: app.id };
}

async function findSub(appId: number): Promise<typeof portalSubmissionsTable.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(portalSubmissionsTable)
    .where(
      and(
        eq(portalSubmissionsTable.applicationId, appId),
        isNull(portalSubmissionsTable.deletedAt),
      ),
    )
    .limit(1);
  if (row) cleanupSubIds.push(row.id);
  return row ?? null;
}

async function countSubs(appId: number): Promise<number> {
  const rows = await db
    .select({ id: portalSubmissionsTable.id })
    .from(portalSubmissionsTable)
    .where(
      and(
        eq(portalSubmissionsTable.applicationId, appId),
        isNull(portalSubmissionsTable.deletedAt),
      ),
    );
  for (const r of rows) cleanupSubIds.push(r.id);
  return rows.length;
}

// ---------------------------------------------------------------------------
// HTTP harness
// ---------------------------------------------------------------------------
function buildApp(role = "super_admin"): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = {
      id: 1,
      role,
      isActive: true,
      emailVerified: true,
    };
    if (!("cookies" in req)) (req as unknown as { cookies: unknown }).cookies = {};
    next();
  });
  app.use("/api", portalAutomationRouter);
  return app;
}

function listen(app: Express): Promise<http.Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
}

function sendReq(
  server: http.Server,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const json = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(json !== undefined ? { "Content-Length": Buffer.byteLength(json) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          try   { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: raw }); }
        });
      },
    );
    req.on("error", reject);
    if (json !== undefined) req.write(json);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// RN1 — scan enqueues an eligible trigger-stage application
// ---------------------------------------------------------------------------
test("RN1: scanAndEnqueueTriggerStageApplications enqueues an eligible application", async () => {
  const { appId } = await seedApp();

  const summary = await scanAndEnqueueTriggerStageApplications(1, await getSettings());

  assert.ok(summary.scanned >= 1, "scanned at least our app");
  assert.ok(summary.queued >= 1, "queued at least one");
  assert.ok(summary.queuedIds.length >= 1, "queuedIds populated");

  const sub = await findSub(appId);
  assert.ok(sub !== null, "our application got a queued submission");
  assert.equal(sub!.status, "queued", "status=queued");
  assert.equal(sub!.mode, "dry", "mode=dry from settings");
  assert.equal(sub!.universityKey, UNI_KEY, "universityKey resolved from app's own university");
});

// ---------------------------------------------------------------------------
// RN2 — dedup: a second scan does not duplicate an active submission
// ---------------------------------------------------------------------------
test("RN2: dedup — re-scanning does not create a duplicate submission", async () => {
  const { appId } = await seedApp();

  await scanAndEnqueueTriggerStageApplications(1, await getSettings());
  assert.equal(await countSubs(appId), 1, "first scan created exactly one submission");

  const second = await scanAndEnqueueTriggerStageApplications(1, await getSettings());
  assert.ok((second.reasons.duplicate ?? 0) >= 1, "duplicate reason surfaced on re-scan");
  assert.equal(await countSubs(appId), 1, "no duplicate submission after re-scan");
});

// ---------------------------------------------------------------------------
// RN3 — deleted applications are skipped by the scan
// ---------------------------------------------------------------------------
test("RN3: deleted applications are not enqueued by the scan", async () => {
  const { appId } = await seedApp({ deleted: true });

  await scanAndEnqueueTriggerStageApplications(1, await getSettings());

  const sub = await findSub(appId);
  assert.equal(sub, null, "deleted application got no submission");
});

// ---------------------------------------------------------------------------
// RN4 — no active portal university → skip with no_active_portal_university
// ---------------------------------------------------------------------------
test("RN4: enqueueIfEligible skips when no active portal university matches", async () => {
  const { studentId, appId } = await seedApp({
    universityName: `Unmapped University ${RUN}`,
  });

  const outcome = await enqueueIfEligible(
    {
      applicationId:  appId,
      studentId,
      newStage:       TRIGGER_STAGE,
      universityName: `Unmapped University ${RUN}`,
      universityId:   null,
      actorUserId:    1,
    },
    await getSettings(),
  );

  assert.equal(outcome.status, "skipped", "skipped");
  assert.equal(
    outcome.status === "skipped" ? outcome.reason : null,
    "no_active_portal_university",
    "reason=no_active_portal_university",
  );
  assert.equal(await findSub(appId), null, "no submission created");
});

// ---------------------------------------------------------------------------
// RN5 — event-driven: stage INTO trigger enqueues
// ---------------------------------------------------------------------------
test("RN5: maybeEnqueuePortalSubmission enqueues when stage enters a trigger stage", async () => {
  const { studentId, appId } = await seedApp();

  await maybeEnqueuePortalSubmission({
    applicationId:  appId,
    studentId,
    newStage:       TRIGGER_STAGE,
    universityName: UNI_NAME,
    universityId:   null,
    actorUserId:    1,
  });

  const sub = await findSub(appId);
  assert.ok(sub !== null, "submission enqueued on stage-into-trigger");
  assert.equal(sub!.universityKey, UNI_KEY, "universityKey correct");
});

// ---------------------------------------------------------------------------
// RN6 — event-driven: stage OUT of trigger does not enqueue
// ---------------------------------------------------------------------------
test("RN6: maybeEnqueuePortalSubmission does not enqueue for a non-trigger stage", async () => {
  const { studentId, appId } = await seedApp({ stage: OTHER_STAGE });

  await maybeEnqueuePortalSubmission({
    applicationId:  appId,
    studentId,
    newStage:       OTHER_STAGE,
    universityName: UNI_NAME,
    universityId:   null,
    actorUserId:    1,
  });

  assert.equal(await findSub(appId), null, "no submission for non-trigger stage");
});

// ---------------------------------------------------------------------------
// RN7 — idempotent hook: two calls create exactly one submission
// ---------------------------------------------------------------------------
test("RN7: maybeEnqueuePortalSubmission is idempotent (dedup on second call)", async () => {
  const { studentId, appId } = await seedApp();

  const params = {
    applicationId:  appId,
    studentId,
    newStage:       TRIGGER_STAGE,
    universityName: UNI_NAME,
    universityId:   null,
    actorUserId:    1,
  };
  await maybeEnqueuePortalSubmission(params);
  await maybeEnqueuePortalSubmission(params);

  assert.equal(await countSubs(appId), 1, "exactly one submission after two calls");
});

// ---------------------------------------------------------------------------
// RN7b — concurrency: two parallel enqueue attempts create exactly one row
//        (advisory-lock dedup must hold under a real race, not just sequential)
// ---------------------------------------------------------------------------
test("RN7b: parallel enqueue attempts create exactly one submission (no race dup)", async () => {
  const { studentId, appId } = await seedApp();

  const params = {
    applicationId:  appId,
    studentId,
    newStage:       TRIGGER_STAGE,
    universityName: UNI_NAME,
    universityId:   null,
    actorUserId:    1,
  };
  await Promise.all([
    maybeEnqueuePortalSubmission(params),
    maybeEnqueuePortalSubmission(params),
    maybeEnqueuePortalSubmission(params),
  ]);

  assert.equal(await countSubs(appId), 1, "exactly one submission despite parallel attempts");
});

// ---------------------------------------------------------------------------
// RN8 — RBAC: non-admin caller gets 403
// ---------------------------------------------------------------------------
test("RN8: POST /portal-automation/run-now returns 403 for non-admin role", async () => {
  const server = await listen(buildApp("student"));
  try {
    const res = await sendReq(server, "POST", "/api/portal-automation/run-now");
    assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// RN9 — 409 AUTOMATION_DISABLED when automation is turned off
// ---------------------------------------------------------------------------
test("RN9: POST /portal-automation/run-now returns 409 when disabled", async () => {
  await db
    .update(portalAutomationSettingsTable)
    .set({ isEnabled: false })
    .where(eq(portalAutomationSettingsTable.id, settingsRowId!));

  const server = await listen(buildApp("super_admin"));
  try {
    const res = await sendReq(server, "POST", "/api/portal-automation/run-now");
    assert.equal(res.status, 409, `expected 409, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "AUTOMATION_DISABLED", "error=AUTOMATION_DISABLED");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await db
      .update(portalAutomationSettingsTable)
      .set({ isEnabled: true })
      .where(eq(portalAutomationSettingsTable.id, settingsRowId!));
  }
});

// ---------------------------------------------------------------------------
// RN10 — happy path over HTTP: 200 + correct response shape (admin)
// ---------------------------------------------------------------------------
test("RN10: POST /portal-automation/run-now returns 200 with the expected shape", async () => {
  await seedApp();

  const server = await listen(buildApp("super_admin"));
  try {
    const res = await sendReq(server, "POST", "/api/portal-automation/run-now");
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(typeof res.body.scanned === "number", "scanned is a number");
    assert.ok(typeof res.body.queued === "number", "queued is a number");
    assert.ok(typeof res.body.skipped === "number", "skipped is a number");
    assert.ok(res.body.reasons !== null && typeof res.body.reasons === "object", "reasons object");
    assert.ok(Array.isArray(res.body.queuedIds), "queuedIds array");
    assert.ok(typeof res.body.processed === "number", "processed is a number");
    assert.ok(typeof res.body.drained === "boolean", "drained is a boolean");
    assert.ok(Array.isArray(res.body.results), "results array");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
