import assert from "node:assert/strict";
import test from "node:test";

import {
  runSelectionConsumptionAttempt,
  SelectionConsumptionAttemptCommitOutcomeUnknownError,
  type SelectionConsumptionAttemptIdentity,
  type SelectionConsumptionAttemptLedger,
} from "../src/lib/activeContextSelectionConsumptionAttempt.js";

const ATTEMPT: SelectionConsumptionAttemptIdentity = {
  attemptId: "018fc000-0000-7000-8000-000000000001",
  tenantId: "018fc000-0000-7000-8000-000000000002",
  contextId: "018fc000-0000-7000-8000-000000000003",
  selectionId: "018fc000-0000-7000-8000-000000000004",
  sessionGeneration: 2,
  principalId: "018fc000-0000-7000-8000-000000000005",
  membershipId: "018fc000-0000-7000-8000-000000000006",
  idempotencyKeyHash: "a".repeat(64),
  requestHash: "b".repeat(64),
  environmentId: "test",
  cellId: "test-cell",
};

function ledger() {
  const events: string[] = [];
  const implementation: SelectionConsumptionAttemptLedger = {
    async start(input) {
      events.push(`start:${input.attemptId}`);
    },
    async complete(input) {
      events.push(`complete:${input.tenantId}:${input.attemptId}:${input.resultHash}`);
    },
    async reconcile(input) {
      events.push(`reconcile:${input.tenantId}:${input.attemptId}:${input.resultHash}`);
    },
    async pending(input) {
      events.push(`pending:${input.tenantId}:${input.attemptId}:${input.reason}`);
    },
    async fail(input) {
      events.push(`fail:${input.tenantId}:${input.attemptId}:${input.reason}`);
    },
  };
  return { implementation, events };
}

test("successful operation completes one attempt with only a result hash", async () => {
  const fixture = ledger();
  const result = await runSelectionConsumptionAttempt({
    attempt: ATTEMPT,
    ledger: fixture.implementation,
    operation: async () => ({ ok: true }),
    resultHash: () => "c".repeat(64),
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(fixture.events, [
    `start:${ATTEMPT.attemptId}`,
    `complete:${ATTEMPT.tenantId}:${ATTEMPT.attemptId}:${"c".repeat(64)}`,
  ]);
});

test("commit ambiguity becomes typed PENDING and never records a terminal error", async () => {
  const fixture = ledger();
  await assert.rejects(
    runSelectionConsumptionAttempt({
      attempt: ATTEMPT,
      ledger: fixture.implementation,
      operation: async () => {
        throw Object.assign(new Error("ack_lost"), {
          code: "ACTIVE_CONTEXT_SELECTION_CONSUMPTION_COMMIT_OUTCOME_UNKNOWN",
        });
      },
      resultHash: () => "d".repeat(64),
    }),
    (error: unknown) =>
      error instanceof SelectionConsumptionAttemptCommitOutcomeUnknownError &&
      error.attemptId === ATTEMPT.attemptId,
  );
  assert.deepEqual(fixture.events, [
    `start:${ATTEMPT.attemptId}`,
    `pending:${ATTEMPT.tenantId}:${ATTEMPT.attemptId}:COMMIT_OUTCOME_UNKNOWN`,
  ]);
});

test("ordinary operation failure records a fixed reason and preserves the error", async () => {
  const fixture = ledger();
  await assert.rejects(
    runSelectionConsumptionAttempt({
      attempt: ATTEMPT,
      ledger: fixture.implementation,
      operation: async () => {
        throw new Error("not persisted");
      },
      resultHash: () => "e".repeat(64),
    }),
    /not persisted/,
  );
  assert.deepEqual(fixture.events, [
    `start:${ATTEMPT.attemptId}`,
    `fail:${ATTEMPT.tenantId}:${ATTEMPT.attemptId}:INTERNAL_ERROR`,
  ]);
});

test("ledger start failure prevents the privileged operation", async () => {
  const fixture = ledger();
  fixture.implementation.start = async () => {
    throw new Error("ledger_unavailable");
  };
  let called = false;
  await assert.rejects(
    runSelectionConsumptionAttempt({
      attempt: ATTEMPT,
      ledger: fixture.implementation,
      operation: async () => {
        called = true;
        return "must-not-run";
      },
      resultHash: () => "f".repeat(64),
    }),
    /ledger_unavailable/,
  );
  assert.equal(called, false);
});
