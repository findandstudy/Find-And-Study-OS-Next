/**
 * test-adapter-graduation.ts — adapter auto-graduation regression tests (G1–G7).
 *
 * Rule under test:
 *   experimental(key) = staticExperimentalFamily(key)
 *                       && successCount(key) < GRADUATION_THRESHOLD
 * where successCount = live COUNT of portal_submissions rows with
 * status='submitted', deleted_at IS NULL and durable portal proof per key.
 *
 * G1  GRADUATION_THRESHOLD === 3, consistently re-exported
 * G2  getAdapterSuccessCounts — counts only submitted+non-deleted, 0 for unknown
 * G3  getNonGraduatedExperimentalAdapterKeys — never returns non-experimental
 * G4  graduation flip — seeding >= threshold 'submitted' rows removes the key
 * G5  isExperimentalDynamic wrapper mirrors the shared core
 * G6  getExperimentalExcludedUniversityKeys — includes uni of non-graduated
 *     experimental adapter, drops it after graduation
 * G7  claimNext(excludeUniversityKeys) — gated exclusion; meta.manual bypass
 *
 * Uses the REAL experimental adapter keys ("united", "emu") because family
 * resolution is exact-key based. Baselines are read first so assertions stay
 * correct regardless of pre-existing dev rows; all seeded rows are deleted in
 * after().
 *
 * Run:
 *   pnpm --filter @workspace/api-server run test:adapter-graduation
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  applicationsTable,
  portalSubmissionsTable,
  portalUniversitiesTable,
  studentsTable,
} from "@workspace/db";
import {
  GRADUATION_THRESHOLD as REGISTRY_THRESHOLD,
  isExperimentalAdapterKey,
} from "@workspace/portal-adapters";
import {
  GRADUATION_THRESHOLD,
  getAdapterSuccessCounts,
  getNonGraduatedExperimentalAdapterKeys,
  getExperimentalExcludedUniversityKeys,
  hasDurableGraduationProof,
  claimNext,
} from "@workspace/portal-runner";
import {
  GRADUATION_THRESHOLD as WRAPPER_THRESHOLD,
  getSuccessCounts,
  isExperimentalDynamic,
  getNonGraduatedExperimentalKeys,
} from "../src/lib/adapterGraduation.js";

// ---------------------------------------------------------------------------
// Run-specific tag + cleanup registry
// ---------------------------------------------------------------------------
const RUN_ID = `grad_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

const EXP_KEY     = "united"; // experimental family (exact-key resolution)
const EXP_KEY_2   = "emu";    // second experimental family
const NON_EXP_KEY = "okan";   // production family — never experimental

const cleanupSubmissionIds: number[] = [];
const cleanupAppIds:        number[] = [];
const cleanupStudentIds:    number[] = [];
const cleanupUniIds:        number[] = [];

after(async () => {
  if (cleanupSubmissionIds.length) {
    await db
      .delete(portalSubmissionsTable)
      .where(inArray(portalSubmissionsTable.id, cleanupSubmissionIds))
      .catch(() => {});
  }
  if (cleanupAppIds.length) {
    await db
      .delete(applicationsTable)
      .where(inArray(applicationsTable.id, cleanupAppIds))
      .catch(() => {});
  }
  if (cleanupStudentIds.length) {
    await db
      .delete(studentsTable)
      .where(inArray(studentsTable.id, cleanupStudentIds))
      .catch(() => {});
  }
  if (cleanupUniIds.length) {
    await db
      .delete(portalUniversitiesTable)
      .where(inArray(portalUniversitiesTable.id, cleanupUniIds))
      .catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------
async function createAppId(): Promise<number> {
  const [s] = await db
    .insert(studentsTable)
    .values({ firstName: `G_${RUN_ID}`, lastName: "Test" })
    .returning({ id: studentsTable.id });
  cleanupStudentIds.push(s.id);
  const [a] = await db
    .insert(applicationsTable)
    .values({ studentId: s.id })
    .returning({ id: applicationsTable.id });
  cleanupAppIds.push(a.id);
  return a.id;
}

async function seedSubmission(opts: {
  appId: number;
  adapterKey: string | null;
  status: "queued" | "submitted" | "failed";
  universityKey?: string;
  deleted?: boolean;
  manual?: boolean;
  externalRef?: string;
  successProof?: boolean;
}): Promise<number> {
  const [row] = await db
    .insert(portalSubmissionsTable)
    .values({
      applicationId:  opts.appId,
      universityKey:  opts.universityKey ?? `uni_${RUN_ID}`,
      universityName: `Grad Test Uni ${RUN_ID}`,
      adapterKey:     opts.adapterKey,
      mode:           "dry",
      status:         opts.status,
      externalRef:    opts.externalRef,
      resultJson:     opts.successProof
        ? {
            result: {
              meta: {
                successProof: {
                  verified: true,
                  kind: "test_proof",
                  schemaVersion: 1,
                },
              },
            },
          }
        : null,
      deletedAt:      opts.deleted ? new Date() : null,
      meta:           opts.manual ? { manual: true } : null,
    })
    .returning({ id: portalSubmissionsTable.id });
  cleanupSubmissionIds.push(row.id);
  return row.id;
}

// ---------------------------------------------------------------------------
// G1 — threshold constant consistency
// ---------------------------------------------------------------------------
test("G1: GRADUATION_THRESHOLD is 3 and consistently re-exported", () => {
  assert.equal(REGISTRY_THRESHOLD, 3);
  assert.equal(GRADUATION_THRESHOLD, REGISTRY_THRESHOLD);
  assert.equal(WRAPPER_THRESHOLD, REGISTRY_THRESHOLD);
  assert.ok(isExperimentalAdapterKey(EXP_KEY),   `${EXP_KEY} must be experimental family`);
  assert.ok(isExperimentalAdapterKey(EXP_KEY_2), `${EXP_KEY_2} must be experimental family`);
  assert.ok(!isExperimentalAdapterKey(NON_EXP_KEY), `${NON_EXP_KEY} must NOT be experimental`);
});

test("G1b: durable proof rejects submitted-only and accepts ref/verified marker", () => {
  assert.equal(hasDurableGraduationProof({}), false);
  assert.equal(hasDurableGraduationProof({ externalRef: "   " }), false);
  assert.equal(
    hasDurableGraduationProof({
      resultJson: { result: { meta: { successProof: { verified: false } } } },
    }),
    false,
  );
  assert.equal(hasDurableGraduationProof({ externalRef: "APP-123" }), true);
  assert.equal(
    hasDurableGraduationProof({
      resultJson: {
        result: { meta: { successProof: { verified: true } } },
      },
    }),
    true,
  );
  assert.equal(
    hasDurableGraduationProof({
      resultJson: { successProof: { verified: true } },
    }),
    true,
  );
});

// ---------------------------------------------------------------------------
// G2 — success counting semantics
// ---------------------------------------------------------------------------
test("G2: getAdapterSuccessCounts requires durable proof", async () => {
  const appId = await createAppId();
  const before = (await getAdapterSuccessCounts([EXP_KEY])).get(EXP_KEY) ?? 0;

  await seedSubmission({ appId, adapterKey: EXP_KEY, status: "submitted" }); // no proof
  await seedSubmission({ appId, adapterKey: EXP_KEY, status: "submitted", externalRef: "APP-G2" });
  await seedSubmission({ appId, adapterKey: EXP_KEY, status: "submitted", successProof: true });
  await seedSubmission({ appId, adapterKey: EXP_KEY, status: "queued" });                 // not counted
  await seedSubmission({ appId, adapterKey: EXP_KEY, status: "failed" });                 // not counted
  await seedSubmission({ appId, adapterKey: EXP_KEY, status: "submitted", externalRef: "DELETED", deleted: true }); // not counted
  await seedSubmission({ appId, adapterKey: null,    status: "submitted" });              // null key ignored

  const after1 = (await getAdapterSuccessCounts([EXP_KEY])).get(EXP_KEY) ?? 0;
  assert.equal(after1, before + 2, "only the 2 live, proven submitted rows count");

  // Unknown key still present in the map with 0.
  const unknown = await getAdapterSuccessCounts([`nope_${RUN_ID}`]);
  assert.equal(unknown.get(`nope_${RUN_ID}`), 0);

  // Wrapper delegates to the same core.
  const viaWrapper = (await getSuccessCounts([EXP_KEY])).get(EXP_KEY) ?? 0;
  assert.equal(viaWrapper, after1);
});

// ---------------------------------------------------------------------------
// G3 — non-experimental families never returned
// ---------------------------------------------------------------------------
test("G3: non-experimental adapter never in non-graduated set", async () => {
  const set = await getNonGraduatedExperimentalAdapterKeys([
    NON_EXP_KEY,
    "topkapi",
    `random_${RUN_ID}`,
  ]);
  assert.equal(set.size, 0, "no experimental families among inputs → empty set");
});

// ---------------------------------------------------------------------------
// G4 — graduation flip at the threshold
// ---------------------------------------------------------------------------
test("G4: experimental key graduates at >= threshold submitted rows", async () => {
  const appId = await createAppId();
  const count = (await getAdapterSuccessCounts([EXP_KEY_2])).get(EXP_KEY_2) ?? 0;

  const setBefore = await getNonGraduatedExperimentalAdapterKeys([EXP_KEY_2]);
  assert.equal(
    setBefore.has(EXP_KEY_2),
    count < GRADUATION_THRESHOLD,
    `pre-seed inclusion must match live count ${count} vs threshold`,
  );

  // Top up to exactly the threshold.
  for (let i = count; i < GRADUATION_THRESHOLD; i++) {
    await seedSubmission({
      appId,
      adapterKey: EXP_KEY_2,
      status: "submitted",
      externalRef: `${RUN_ID}_${i}`,
    });
  }

  const setAfter = await getNonGraduatedExperimentalAdapterKeys([EXP_KEY_2]);
  assert.ok(!setAfter.has(EXP_KEY_2), "key at threshold is graduated (excluded)");

  // Array-shaped wrapper agrees.
  const viaWrapper = await getNonGraduatedExperimentalKeys([EXP_KEY_2]);
  assert.ok(!viaWrapper.includes(EXP_KEY_2));
});

// ---------------------------------------------------------------------------
// G5 — isExperimentalDynamic wrapper
// ---------------------------------------------------------------------------
test("G5: isExperimentalDynamic mirrors the shared rule", async () => {
  // Non-experimental family: false without any DB dependence.
  assert.equal(await isExperimentalDynamic(NON_EXP_KEY), false);

  // EXP_KEY_2 was graduated in G4 (node:test runs tests sequentially).
  assert.equal(await isExperimentalDynamic(EXP_KEY_2), false);

  const count = (await getAdapterSuccessCounts([EXP_KEY])).get(EXP_KEY) ?? 0;
  assert.equal(await isExperimentalDynamic(EXP_KEY), count < GRADUATION_THRESHOLD);
});

// ---------------------------------------------------------------------------
// G6 — excluded university keys
// ---------------------------------------------------------------------------
test("G6: getExperimentalExcludedUniversityKeys tracks graduation", async () => {
  const uniKey = `uni_${RUN_ID}_g6`;
  const [uni] = await db
    .insert(portalUniversitiesTable)
    .values({
      universityKey:  uniKey,
      universityName: `Grad G6 Uni ${RUN_ID}`,
      adapterKey:     EXP_KEY_2, // graduated in G4
      isActive:       true,
    })
    .returning({ id: portalUniversitiesTable.id });
  cleanupUniIds.push(uni.id);

  const excluded1 = await getExperimentalExcludedUniversityKeys();
  assert.ok(
    !excluded1.includes(uniKey),
    "uni of a GRADUATED adapter must not be excluded",
  );

  // Point the uni at a definitely-non-graduated key: a fresh submitted-count-0
  // experimental key is impossible (exact-key families), so instead un-graduate
  // EXP_KEY_2 virtually by checking the still-experimental case via EXP_KEY if
  // it is below threshold; otherwise assert the graduated invariant only.
  const expCount = (await getAdapterSuccessCounts([EXP_KEY])).get(EXP_KEY) ?? 0;
  if (expCount < GRADUATION_THRESHOLD) {
    await db
      .update(portalUniversitiesTable)
      .set({ adapterKey: EXP_KEY })
      .where(eq(portalUniversitiesTable.id, uni.id));
    const excluded2 = await getExperimentalExcludedUniversityKeys();
    assert.ok(
      excluded2.includes(uniKey),
      "uni of a non-graduated experimental adapter must be excluded",
    );
  }
});

// ---------------------------------------------------------------------------
// G7 — claimNext exclusion gate + meta.manual bypass
// ---------------------------------------------------------------------------
test("G7: claimNext excludes gated universities but manual rows bypass", async () => {
  const appId = await createAppId();
  const uniKey = `uni_${RUN_ID}_g7`;
  const workerId = `w_${RUN_ID}`;

  const autoId = await seedSubmission({
    appId,
    adapterKey: EXP_KEY,
    status: "queued",
    universityKey: uniKey,
  });

  // Excluded → automatic row must NOT be claimed.
  const c1 = await claimNext(workerId, [uniKey], undefined, [uniKey]);
  assert.equal(c1, null, "excluded university must not be claimable");

  // meta.manual row bypasses ALL gated conditions including the exclusion.
  const manualId = await seedSubmission({
    appId,
    adapterKey: EXP_KEY,
    status: "queued",
    universityKey: uniKey,
    manual: true,
  });
  const c2 = await claimNext(workerId, [uniKey], undefined, [uniKey]);
  assert.ok(c2, "manual row must bypass the exclusion");
  assert.equal(c2!.id, manualId);

  // Without the exclusion the automatic row is claimable.
  const c3 = await claimNext(workerId, [uniKey], undefined, []);
  assert.ok(c3, "automatic row claimable when no exclusion given");
  assert.equal(c3!.id, autoId);
});
