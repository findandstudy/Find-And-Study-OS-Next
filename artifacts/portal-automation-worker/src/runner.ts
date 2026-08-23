/**
 * runner.ts — orchestrates the adapter login + submit flow for a single
 * portal submission.
 *
 * Dry mode  — skips login/submit entirely; returns a synthetic result with
 *             resultJson.dryRun:true so the writeback can record the attempt
 *             without touching the external portal.
 *
 * Real mode — resolves credentials (DB-first, env fallback) via credResolver,
 *             injects them into the adapter via setCredsOverride() before
 *             calling adapter.login(), then clears the override in finally.
 */

import fs from "node:fs/promises";
import {
  resolveAdapterByKey,
  resolveAdapterForUniversity,
  setCredsOverride,
  clearCredsOverride,
  validateIdentityFields,
  formatIdentityErrors,
  evaluateSitSubmissionIdentityGate,
} from "@workspace/portal-adapters";
import type {
  SubmitResult,
  SubmitProfile,
  SubmitFiles,
} from "@workspace/portal-adapters";
import type { ClaimedSubmission } from "./queue.js";
import { resolvePortalCreds } from "./credResolver.js";

// ---------------------------------------------------------------------------
// Result shape returned to stageWriteback
// ---------------------------------------------------------------------------

export interface RunResult {
  result: SubmitResult;
  screenshotUrls: string[];
  /** Extra metadata (dryRun flag, adapter key used, etc.) */
  meta: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// runSubmission
// ---------------------------------------------------------------------------

/**
 * Runs the adapter flow for a claimed submission.
 * `tempDir` is cleaned up inside this function (in the finally block).
 */
export async function runSubmission(
  submission: Pick<
    ClaimedSubmission,
    "id" | "universityKey" | "universityName" | "mode"
  >,
  profile: SubmitProfile,
  files: SubmitFiles,
  tempDir: string,
): Promise<RunResult> {
  // ----- 1. Resolve adapter (code adapters + DB declarative adapters) ------
  const adapter =
    (await resolveAdapterByKey(submission.universityKey)) ??
    (await resolveAdapterForUniversity(submission.universityName));

  if (!adapter) {
    await cleanup(tempDir);
    throw new Error(
      `NO_ADAPTER: no adapter found for key="${submission.universityKey}" / name="${submission.universityName}"`,
    );
  }

  // ----- 2. Dry mode — no real browser interaction ------------------------
  if (submission.mode !== "real") {
    await cleanup(tempDir);
    return {
      result: {
        submitted: false,
        alreadyExists: false,
        programMissing: false,
      },
      screenshotUrls: [],
      meta: { dryRun: true, adapterKey: adapter.key },
    };
  }

  // ----- 2.5. Identity field guard (real mode, defence-in-depth) ----------
  // The enqueue gate (api-server portalAutoTrigger) already blocks invalid
  // data from entering the queue, but submissions may have been created
  // before this guard existed, or the student record may have been edited
  // after enqueueing.  Better to abort here than to fill a university form
  // with a placeholder passport number and create a real-but-wrong application
  // that harms the student.
  const idErrors = validateIdentityFields({
    passportNumber: profile.passportNumber,
    firstName: profile.firstName,
    lastName: profile.lastName,
    dateOfBirth: profile.dateOfBirth || undefined,
    passportIssueDate: profile.passportIssueDate,
    passportExpiryDate: profile.passportExpiryDate,
  });
  if (idErrors.length > 0) {
    await cleanup(tempDir);
    throw new Error(
      `IDENTITY_VALIDATION_FAILED: ${formatIdentityErrors(idErrors)}`,
    );
  }

  if (adapter.key === "sit") {
    const identity = evaluateSitSubmissionIdentityGate(
      profile,
      profile.passportIdentityProof,
    );
    if (!identity.allowed) {
      await cleanup(tempDir);
      throw new Error(
        `SIT_IDENTITY_PROOF_FAILED: fields=${identity.fields.join(",") || "passportIdentityProof"}`,
      );
    }
    if (identity.verification === "unavailable") {
      console.warn(
        `[portal-worker] SIT passport proof unavailable for submission #${submission.id}; ` +
          "continuing after deterministic identity and document validation",
      );
    }
  }

  // ----- 3. Real mode — resolve credentials (DB-first, env fallback) ------
  // resolvePortalCreds() throws when no credentials are found anywhere;
  // let the error propagate so the submission lands in "failed" with a clear message.
  const creds = await resolvePortalCreds(submission.universityKey, adapter.key);

  // ----- 4. Login + submit -------------------------------------------------
  const screenshotUrls: string[] = [];
  let session: Awaited<ReturnType<typeof adapter.login>> | null = null;

  // Inject resolved creds so the adapter's internal portalCreds() call
  // picks them up without relying on env vars.
  setCredsOverride(adapter.key, {
    user: creds.user,
    password: creds.password,
    extra: creds.extra,
  });

  try {
    session = await adapter.login({
      headless: true,
      credentials: {
        user: creds.user,
        password: creds.password,
        extra: creds.extra,
      },
    });

    const result = await adapter.submit(session, profile, files);

    // Capture post-submit screenshot (debug only — gate behind PORTAL_DEBUG=1)
    if (process.env.PORTAL_DEBUG === "1") {
      try {
        const buf = await (
          session as unknown as { page: { screenshot(): Promise<Buffer> } }
        ).page.screenshot();
        screenshotUrls.push(
          `data:image/png;base64,${buf.toString("base64").slice(0, 64)}…`,
        );
      } catch {
        // Screenshot failure is non-fatal
      }
    }

    return {
      result,
      screenshotUrls,
      meta: { adapterKey: adapter.key },
    };
  } finally {
    clearCredsOverride(adapter.key);
    await session?.close().catch(() => {});
    await cleanup(tempDir);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function cleanup(tempDir: string): Promise<void> {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
}
