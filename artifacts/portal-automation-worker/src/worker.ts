/**
 * worker.ts — main polling loop for the portal-automation worker.
 *
 * Start:  pnpm --filter @workspace/portal-automation-worker start
 * PM2:    configured in Faz 5
 *
 * Environment variables:
 *   WORKER_POLL_MS        Polling interval when queue is empty (default: 5000)
 *   WORKER_STALE_MS       Stale lock threshold for crash recovery (default: 300000 = 5 min)
 *   WORKER_GLOBAL_CONCURRENCY       Maximum simultaneous portal jobs (default: 1)
 *   WORKER_DEFAULT_LANE_CONCURRENCY Per-portal-account slots (default: 1)
 *   WORKER_LANE_CONCURRENCY         Overrides, e.g. "sit=2,topkapi=1"
 *   WORKER_HEARTBEAT_MS             Active claim heartbeat interval (default: 30000)
 *   DATABASE_URL          Required — PostgreSQL connection string
 */

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { db, pool, portalUniversitiesTable, portalAutomationSettingsTable } from "@workspace/db";
import { claimNextWithLaneLease, type ClaimedSubmission, type ClaimedSubmissionLease, cancelStaleIneligibleQueued, releaseStale, requeueStuck, buildStudentProfile, runSubmission, writebackResult, handleNeedsFallback, resolveAdapterKey, getNonGraduatedExperimentalAdapterKeys, portalEvidenceFromError, getApplicationMandatoryDocumentStatus } from "@workspace/portal-runner";
import { isSitFamilyKey } from "@workspace/portal-adapters";
import { resolvePortalCreds } from "./credResolver.js";
import { loadPortalLanePolicy } from "./portalLanePolicy.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const POLL_MS = positiveInt(process.env.WORKER_POLL_MS, 5_000);
const STALE_MS = positiveInt(process.env.WORKER_STALE_MS, 300_000);
const LANE_POLICY = loadPortalLanePolicy(process.env, STALE_MS);

const QUEUE_RECONCILE_MS = positiveInt(process.env.WORKER_QUEUE_RECONCILE_MS, 86_400_000);
const QUEUE_RECONCILE_INTERVAL_MS = positiveInt(process.env.WORKER_QUEUE_RECONCILE_INTERVAL_MS, 300_000);
const WORKER_ID = `${os.hostname()}-${process.pid}`;
let nextQueueReconcileAt = 0;
const SHUTDOWN_TIMEOUT_MS = positiveInt(process.env.WORKER_SHUTDOWN_TIMEOUT_MS, 120_000);
let stopping = false;
let shutdownPromise: Promise<void> | null = null;
let schedulerTick: Promise<void> | null = null;
const activeJobs = new Map<number, { laneKey: string; slot: number; promise: Promise<void> }>();
let wakeSleep: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Safety-net /tmp sweeper — removes stale portal temp files left by crashes or
// leaks.  Only touches patterns we own; never touches functional state files
// (topkapi-portal-state.json, sit-login-state.png), DB dumps, or Node caches.
// Called at the top of every tick (cheap — synchronous readdir, no await).
// ---------------------------------------------------------------------------
const SWEEP_PATTERNS = [/^portal-sub-/, /^portal-shot-/, /-step\d*\.png$/i, /^playwright_chromiumdev_profile-/];

function sweepTmp(maxAgeMin = 180): void {
  const dir = os.tmpdir();
  const cutoff = Date.now() - maxAgeMin * 60_000;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!SWEEP_PATTERNS.some((p) => p.test(name))) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoff) {
          fs.rmSync(full, { recursive: true, force: true });
          console.log(`[portal-worker] sweepTmp: removed stale ${name}`);
        }
      } catch {
        // Ignore per-entry errors (file disappeared, permission, etc.)
      }
    }
  } catch {
    // Non-fatal — tmpdir unreadable
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

console.log(`[portal-worker] Starting — id=${WORKER_ID} poll=${POLL_MS}ms stale=${STALE_MS}ms` + ` globalConcurrency=${LANE_POLICY.globalConcurrency}` + ` defaultLaneConcurrency=${LANE_POLICY.defaultLaneConcurrency}` + ` laneOverrides=${[...LANE_POLICY.laneConcurrency.entries()].map(([key, slots]) => `${key}=${slots}`).join(",") || "none"}` + ` heartbeat=${LANE_POLICY.heartbeatMs}ms`);

/**
 * Loads the allowlist of university keys eligible for auto-processing:
 * autoProcess=true AND isActive=true AND not soft-deleted.
 *
 * Aggregator families (salesforce/sit/united/emu) are NO LONGER hard-excluded
 * here — each aggregator now opts in/out through its OWN portal_universities
 * row's `autoProcess` toggle (panel-managed), same as any standalone portal.
 * That toggle is condition 1 of the 3-condition gate for aggregator auto-drain
 * (see worker.ts module doc / tick()): (1) this toggle, (2) the application's
 * university is an active DB member (portal_account_universities — already
 * enforced upstream at enqueue time by enqueueIfEligible/resolvePortalRouting,
 * which only ever queues a member submission under the AGGREGATOR's own
 * universityKey), (3) trigger stage (loadTriggerStages() below). Today the
 * United row's autoProcess is OFF in production, so removing this exclusion
 * changes nothing until an operator explicitly flips that toggle — and even
 * then the existing one-claim-per-tick cadence drains the queue gradually,
 * never in a burst. This mirrors the identical fix in
 * api-server/scripts/drain-once.ts.
 */
async function loadAutoProcessTargets(): Promise<{
  claimKeys: string[];
  reconcileKeys: string[];
}> {
  const unis = await db
    .select({
      universityKey: portalUniversitiesTable.universityKey,
      adapterKey: portalUniversitiesTable.adapterKey,
    })
    .from(portalUniversitiesTable)
    .where(and(eq(portalUniversitiesTable.autoProcess, true), eq(portalUniversitiesTable.isActive, true), isNull(portalUniversitiesTable.deletedAt)));

  // Adapter auto-graduation: exclude universities whose adapter is still
  // experimental (non-graduated). Belt-and-suspenders — the panel's
  // auto-process toggle is already 409-guarded, but a graduation can be
  // "un-earned" (submissions soft-deleted) after the toggle was enabled.
  const nonGraduated = await getNonGraduatedExperimentalAdapterKeys(unis.map((u) => u.adapterKey));

  const eligible = unis.filter((u) => !nonGraduated.has(u.adapterKey));
  return {
    claimKeys: eligible.map((u) => u.universityKey),
    // Legacy queue rows sometimes stored the adapter alias as university_key.
    // Reconciliation may retire those rows, but claimNext stays canonical.
    reconcileKeys: [...new Set(eligible.flatMap((u) => [u.universityKey, u.adapterKey]))],
  };
}

/**
 * Loads the configured trigger stages. Only applications currently in one of
 * these stages are eligible for auto-processing (mirrors the enqueue-time
 * candidate selection). An empty array means nothing is auto-processed.
 */
async function loadTriggerStages(): Promise<string[]> {
  const [settings] = await db.select({ triggerStages: portalAutomationSettingsTable.triggerStages }).from(portalAutomationSettingsTable).limit(1);
  return settings?.triggerStages ?? [];
}

async function processClaimedSubmission(sub: ClaimedSubmission): Promise<void> {
  console.log(`[portal-worker] Claimed submission #${sub.id} (attempt ${sub.attempts}/${sub.maxAttempts})` + ` app=${sub.applicationId} uni=${sub.universityKey} mode=${sub.mode}`);

  let runResult = null;

  try {
    const mandatoryDocs = await getApplicationMandatoryDocumentStatus(sub.applicationId);
    if (!mandatoryDocs || mandatoryDocs.missing.length > 0) {
      const reason = mandatoryDocs ? `MISSING_MANDATORY_DOCUMENTS: ${mandatoryDocs.missing.join(", ")}` : `MISSING_MANDATORY_DOCUMENTS: application ${sub.applicationId} not found`;
      console.error(`[portal-worker] Submission #${sub.id} blocked before portal access: ${reason}`);
      await writebackResult(sub.id, null, reason, WORKER_ID);
      return;
    }

    const profileResult = await buildStudentProfile(sub.id);

    // Resolve credentials (DB-first, env fallback) — worker-specific resolver.
    // Both dry AND real modes need credentials because dry mode still performs
    // a real browser login to smoke-test the full form-fill flow; only the
    // final submit click is skipped (doSubmit=false).
    //
    // Multi-portal / aggregator routing: a member university (e.g. "aydin")
    // routed to an aggregator (SIT=study_in_turkey→adapter "sit") must log in
    // with the AGGREGATOR's credentials, not its own. resolveAdapterKey returns
    // routedVia (the aggregator's portal key) when a redirect applies; passing
    // it + the adapter key lets resolvePortalCreds find the aggregator's row
    // instead of the member's own credentials. For direct portals routedVia is
    // null and adapterKey === universityKey, so behaviour is unchanged.
    const { adapterKey, routedVia } = await resolveAdapterKey(sub.universityKey);
    const creds = await resolvePortalCreds(routedVia ?? sub.universityKey, adapterKey);

    // Guard: browser-upload adapters (everything except "sit", which submits
    // via a create-webhook + URL references, not a local-file upload widget)
    // must never proceed with zero filled document slots when the student
    // genuinely has CRM documents — that means the download pipeline broke
    // (e.g. a raw fileKey path resolving to the SPA shell instead of the real
    // file) and a browser submit would go through with empty upload fields.
    // Students who truly have zero CRM documents are NOT blocked here — that
    // is separate, pre-existing behaviour (including SIT's own zero-doc
    // guard, which this does not touch).
    if (!isSitFamilyKey(adapterKey) && profileResult.hasContentBearingDocs && profileResult.filledSlots.length === 0) {
      const reason = `document-bearing student has 0 filled upload slots for adapter=${adapterKey}` + ` (uni=${sub.universityKey}) — refusing to submit with empty document fields;` + ` missing=[${profileResult.missingSlots.join(", ")}]`;
      console.error(`[portal-worker] Submission #${sub.id} blocked: ${reason}`);
      await writebackResult(sub.id, null, reason);
      return;
    }

    runResult = await runSubmission(sub, profileResult.profile, profileResult.files, profileResult.tempDir, creds);

    console.log(`[portal-worker] Submission #${sub.id} run complete —` + ` submitted=${runResult.result.submitted}` + ` alreadyExists=${runResult.result.alreadyExists}` + ` programMissing=${runResult.result.programMissing}` + ` programFull=${runResult.result.programFull ?? false}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[portal-worker] Submission #${sub.id} failed: ${msg}`);
    await writebackResult(sub.id, null, msg, undefined, portalEvidenceFromError(err));
    return;
  }

  await writebackResult(sub.id, runResult);

  // Program-fallback orchestrator: when the portal reports the requested
  // programme is full ("Kontenjan Dolu") OR the programme is not found in the
  // portal dropdown (but the dropdown WAS reached, so alternatives are known),
  // try to supersede it with a configured fallback. Fully self-gating
  // (kill-switch, mode=real, idempotency, loop guard) and best-effort — a
  // failure here must never break the worker loop.
  const needsFallback = runResult?.result?.programFull === true || (runResult?.result?.programMissing === true && runResult?.result?.resolution === "not_in_dropdown" && (runResult?.result?.availablePrograms?.length ?? 0) > 0);
  if (needsFallback) {
    try {
      const outcome = await handleNeedsFallback(sub.id);
      const trigger = runResult?.result?.programFull ? "program_full" : "program_missing";
      console.log(`[portal-worker] Submission #${sub.id} ${trigger} → fallback outcome=${outcome.status}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[portal-worker] Submission #${sub.id} fallback orchestrator failed (non-fatal): ${msg}`);
    }
  }
}

async function processLease(lease: ClaimedSubmissionLease): Promise<void> {
  let processing = true;
  let heartbeatChain = Promise.resolve();
  const heartbeatTimer = setInterval(() => {
    if (!processing) return;
    heartbeatChain = heartbeatChain.then(async () => {
      try {
        const stillOwned = await lease.heartbeat();
        if (!stillOwned && processing) {
          console.error(`[portal-worker] Lost claim ownership for submission #${lease.submission.id}` + ` lane=${lease.laneKey} slot=${lease.slot}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[portal-worker] Heartbeat failed for submission #${lease.submission.id}` + ` lane=${lease.laneKey} slot=${lease.slot}: ${message}`);
      }
    });
  }, LANE_POLICY.heartbeatMs);
  heartbeatTimer.unref?.();

  try {
    await processClaimedSubmission(lease.submission);
  } finally {
    processing = false;
    clearInterval(heartbeatTimer);
    await heartbeatChain;
    await lease.release();
  }
}

function startLease(lease: ClaimedSubmissionLease): void {
  const submissionId = lease.submission.id;
  console.log(`[portal-worker] Starting lane=${lease.laneKey} slot=${lease.slot}` + ` submission #${submissionId}`);
  const promise = processLease(lease)
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[portal-worker] Lane execution failed for submission #${submissionId}` + ` lane=${lease.laneKey} slot=${lease.slot}: ${message}`);
    })
    .finally(() => {
      activeJobs.delete(submissionId);
      wakeSleep?.();
      console.log(`[portal-worker] Released lane=${lease.laneKey} slot=${lease.slot}` + ` submission #${submissionId}`);
    });
  activeJobs.set(submissionId, {
    laneKey: lease.laneKey,
    slot: lease.slot,
    promise,
  });
}

async function tick(): Promise<void> {
  sweepTmp();

  const released = await releaseStale(STALE_MS);
  if (released.length > 0) {
    console.log(`[portal-worker] Released ${released.length} stale submission(s)`);
  }

  const autoProcessTargets = await loadAutoProcessTargets();
  if (autoProcessTargets.claimKeys.length === 0 || stopping) return;
  const triggerStages = await loadTriggerStages();

  if (Date.now() >= nextQueueReconcileAt) {
    nextQueueReconcileAt = Date.now() + Math.max(POLL_MS, QUEUE_RECONCILE_INTERVAL_MS);
    const reconciled = await cancelStaleIneligibleQueued(autoProcessTargets.reconcileKeys, triggerStages, QUEUE_RECONCILE_MS);
    if (reconciled.length > 0) {
      console.log(`[portal-worker] Reconciled ${reconciled.length} stale automatic queue row(s)` + ` as canceled (stage no longer eligible)`);
    }
  }

  while (!stopping && activeJobs.size < LANE_POLICY.globalConcurrency) {
    const lease = await claimNextWithLaneLease(WORKER_ID, {
      universityKeys: autoProcessTargets.claimKeys,
      triggerStages,
      defaultLaneConcurrency: LANE_POLICY.defaultLaneConcurrency,
      laneConcurrency: LANE_POLICY.laneConcurrency,
    });
    if (!lease) break;
    if (stopping) {
      await requeueStuck(lease.submission.id, WORKER_ID);
      await lease.release();
      break;
    }
    startLease(lease);
  }
}

async function loop(): Promise<void> {
  while (!stopping) {
    try {
      schedulerTick = tick();
      await schedulerTick;
    } catch (err) {
      console.error("[portal-worker] Unexpected tick error:", err);
    } finally {
      schedulerTick = null;
    }
    if (!stopping) await sleep(POLL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeSleep = null;
      resolve();
    }, ms);
    wakeSleep = () => {
      clearTimeout(timer);
      wakeSleep = null;
      resolve();
    };
  });
}

async function beginShutdown(signal: string, exitCode: number): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    stopping = true;
    wakeSleep?.();
    const activeIds = [...activeJobs.keys()];
    console.log(`[portal-worker] ${signal} received — polling stopped; draining` + (activeIds.length > 0 ? ` submissions [${activeIds.join(", ")}]` : " current scheduler tick"));

    let timedOut = false;
    if (schedulerTick || activeJobs.size > 0) {
      let drainTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          (async () => {
            await schedulerTick?.catch(() => undefined);
            await Promise.allSettled([...activeJobs.values()].map((job) => job.promise));
          })(),
          new Promise<void>((resolve) => {
            drainTimer = setTimeout(() => {
              timedOut = true;
              resolve();
            }, SHUTDOWN_TIMEOUT_MS);
            drainTimer.unref?.();
          }),
        ]);
      } finally {
        if (drainTimer) clearTimeout(drainTimer);
      }
    }

    if (timedOut) {
      console.error(`[portal-worker] Drain timed out after ${SHUTDOWN_TIMEOUT_MS}ms` + (activeIds.length > 0 ? ` for submissions [${activeIds.join(", ")}]` : "") + "; claim remains for stale-recovery review");
      exitCode = 1;
    }
    await pool.end().catch((error) => {
      console.error("[portal-worker] PostgreSQL pool shutdown failed:", error);
      exitCode = 1;
    });
    process.exit(exitCode);
  })();
  return shutdownPromise;
}

process.once("SIGTERM", () => {
  void beginShutdown("SIGTERM", 0);
});
process.once("SIGINT", () => {
  void beginShutdown("SIGINT", 0);
});
process.once("unhandledRejection", (reason) => {
  console.error("[portal-worker] Fatal unhandled promise rejection:", reason);
  void beginShutdown("unhandledRejection", 1);
});
process.once("uncaughtException", (err) => {
  console.error("[portal-worker] Fatal uncaught exception:", err);
  void beginShutdown("uncaughtException", 1);
});

loop().catch((err) => {
  console.error("[portal-worker] Fatal loop error:", err);
  void beginShutdown("fatalLoopError", 1);
});
