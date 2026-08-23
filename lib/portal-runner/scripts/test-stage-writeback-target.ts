import { test } from "node:test";
import assert from "node:assert/strict";

import type { SubmitResult } from "@workspace/portal-adapters";
import {
  resolveWritebackError,
  resolveWritebackTarget,
} from "../src/stageWritebackTarget.js";

function result(overrides: Partial<SubmitResult>): SubmitResult {
  return {
    submitted: false,
    alreadyExists: false,
    programMissing: false,
    ...overrides,
  };
}

test("SWT1: verified submit moves to Awaiting Offer", () => {
  assert.deepEqual(
    resolveWritebackTarget(result({ submitted: true }), {
      adapterKey: "altinbas",
    }),
    { submissionStatus: "submitted", stageKey: "awaiting_offer" },
  );
});

test("SWT1B: verified SIT submit moves to Awaiting Offer", () => {
  assert.deepEqual(
    resolveWritebackTarget(result({ submitted: true }), {
      adapterKey: "sit",
    }),
    { submissionStatus: "submitted", stageKey: "awaiting_offer" },
  );
});

test("SWT2: portal duplicate moves to Already Registered", () => {
  assert.deepEqual(
    resolveWritebackTarget(result({ alreadyExists: true }), {
      adapterKey: "altinbas",
    }),
    { submissionStatus: "already_exists", stageKey: "all_registered" },
  );
});

test("SWT3: Altınbaş quota-full moves to Quota Full", () => {
  assert.deepEqual(
    resolveWritebackTarget(result({ programFull: true }), {
      adapterKey: "altinbas",
    }),
    { submissionStatus: "program_full", stageKey: "quota_full" },
  );
});

test("SWT4: other adapters retain their established quota behavior", () => {
  assert.deepEqual(
    resolveWritebackTarget(result({ programFull: true }), {
      adapterKey: "topkapi",
    }),
    { submissionStatus: "program_full", stageKey: null },
  );
});

test("SWT5: structural quota result wins over dry-run status", () => {
  assert.deepEqual(
    resolveWritebackTarget(result({ programFull: true }), {
      adapterKey: "altinbas",
      dryRun: true,
    }),
    { submissionStatus: "program_full", stageKey: "quota_full" },
  );
});

test("SWT6: failed adapter detail is preserved for the operator", () => {
  const failed = result({ detail: "webhook create başarısız" });
  assert.equal(
    resolveWritebackError(failed, "failed"),
    "webhook create başarısız",
  );
});

test("SWT7: thrown worker error takes precedence over adapter detail", () => {
  const failed = result({ detail: "adapter detail" });
  assert.equal(
    resolveWritebackError(failed, "failed", "browser crashed"),
    "browser crashed",
  );
});
