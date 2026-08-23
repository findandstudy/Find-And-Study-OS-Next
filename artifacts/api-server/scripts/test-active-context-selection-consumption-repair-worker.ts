import assert from "node:assert/strict";
import test from "node:test";

import {
  ActiveContextSelectionConsumptionRepairWorker,
  type PendingSelectionConsumptionAttempt,
  type SelectionConsumptionRepairStore,
} from "../src/lib/activeContextSelectionConsumptionRepairWorker.js";
import type { SelectionConsumptionAttemptLedger } from "../src/lib/activeContextSelectionConsumptionAttempt.js";

const ATTEMPT: PendingSelectionConsumptionAttempt = {
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
  status: "PENDING",
  attemptCount: 1,
  maxAttempts: 3,
  leaseToken: "lease-token-00000001",
};

function fixture(outcome: unknown) {
  const events: string[] = [];
  const store: SelectionConsumptionRepairStore = {
    async claimDue() { return ATTEMPT; },
    async loadOutcome() { return outcome as never; },
    async reschedule(_attempt, reason) { events.push(`retry:${reason}`); },
    async resolve() { events.push("resolve"); },
    async escalate(_attempt, reason) { events.push(`escalate:${reason}`); },
  };
  const ledger: SelectionConsumptionAttemptLedger = {
    async start() {},
    async complete() {},
    async reconcile(input) { events.push(`reconcile:${input.resultHash}`); },
    async pending() {},
    async fail(input) { events.push(`fail:${input.reason}`); },
  };
  return { store, ledger, events };
}

test("resolves only from a verified stored result and never reruns business work", async () => {
  const f = fixture({ state: "COMPLETED", resultHash: "c".repeat(64) });
  const result = await new ActiveContextSelectionConsumptionRepairWorker(f).runOnce(ATTEMPT.tenantId);
  assert.deepEqual(result, { kind: "RESOLVED", attemptId: ATTEMPT.attemptId });
  assert.deepEqual(f.events, [`reconcile:${"c".repeat(64)}`, "resolve"]);
});

test("reschedules a not-found outcome while the bounded attempt budget remains", async () => {
  const f = fixture({ state: "NOT_FOUND" });
  const result = await new ActiveContextSelectionConsumptionRepairWorker(f).runOnce(ATTEMPT.tenantId);
  assert.deepEqual(result, { kind: "RETRY", attemptId: ATTEMPT.attemptId, reason: "NOT_FOUND" });
  assert.deepEqual(f.events, ["retry:NOT_FOUND"]);
});

test("escalates invalid or exhausted outcomes through the ledger without replaying mutation", async () => {
  const f = fixture({ state: "INVALID" });
  const result = await new ActiveContextSelectionConsumptionRepairWorker(f).runOnce(ATTEMPT.tenantId);
  assert.deepEqual(result, { kind: "ESCALATED", attemptId: ATTEMPT.attemptId, reason: "INVALID" });
  assert.deepEqual(f.events, ["fail:INTERNAL_ERROR", "escalate:INVALID"]);
});
