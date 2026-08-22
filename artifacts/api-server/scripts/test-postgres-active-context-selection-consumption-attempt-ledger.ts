import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresActiveContextSelectionConsumptionAttemptLedger,
} from "../src/lib/postgresActiveContextSelectionConsumptionAttemptLedger.js";

const ID = {
  attemptId: "018fc000-0000-7000-8000-000000000001",
  tenantId: "018fc000-0000-7000-8000-000000000002",
  contextId: "018fc000-0000-7000-8000-000000000003",
  selectionId: "018fc000-0000-7000-8000-000000000004",
  principalId: "018fc000-0000-7000-8000-000000000005",
  membershipId: "018fc000-0000-7000-8000-000000000006",
};

function fakePool() {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  let released: unknown;
  const client = {
    async query<T extends Record<string, unknown>>(text: string, values?: unknown[]) {
      queries.push({ text, values });
      if (text.includes("current_user")) {
        return {
          rows: [{ current_user: "fas_selection_attempt_writer", tenant_setting: null }],
          rowCount: 1,
        } as unknown as { rows: T[]; rowCount: number };
      }
      if (text.includes("start_selection_consumption_attempt")) {
        return {
          rows: [{ result: { attemptId: ID.attemptId, status: "STARTED", replayed: false } }],
          rowCount: 1,
        } as unknown as { rows: T[]; rowCount: number };
      }
      if (text.includes("finish_selection_consumption_attempt")) {
        return {
          rows: [{ result: { attemptId: ID.attemptId, status: "TERMINAL", replayed: false } }],
          rowCount: 1,
        } as unknown as { rows: T[]; rowCount: number };
      }
      return { rows: [], rowCount: 0 } as { rows: T[]; rowCount: number };
    },
    release(error?: unknown) {
      released = error;
    },
  };
  return {
    pool: { connect: async () => client } as never,
    queries,
    get released() {
      return released;
    },
  };
}

function ledgerFixture() {
  return {
    ...ID,
    sessionGeneration: 2,
    idempotencyKeyHash: "a".repeat(64),
    requestHash: "b".repeat(64),
    environmentId: "test",
    cellId: "test-cell",
  } as const;
}

test("writes start, terminal completion and fixed tenant-local transactions", async () => {
  const fixture = fakePool();
  const ledger = new PostgresActiveContextSelectionConsumptionAttemptLedger({
    pool: fixture.pool,
    expectedRole: "fas_selection_attempt_writer",
  });
  await ledger.start(ledgerFixture());
  await ledger.complete({
    tenantId: ID.tenantId,
    attemptId: ID.attemptId,
    resultHash: "c".repeat(64),
  });
  await ledger.reconcile({
    tenantId: ID.tenantId,
    attemptId: ID.attemptId,
    resultHash: "d".repeat(64),
  });
  assert.equal(fixture.released, undefined);
  assert.equal(fixture.queries.filter((query) => query.text === "BEGIN ISOLATION LEVEL SERIALIZABLE").length, 3);
  assert.ok(fixture.queries.some((query) => query.text.includes("app.tenant_id")));
  assert.equal(fixture.queries.filter((query) => query.text === "COMMIT").length, 3);
});

test("rejects malformed identity before opening a transaction", async () => {
  const fixture = fakePool();
  const ledger = new PostgresActiveContextSelectionConsumptionAttemptLedger({
    pool: fixture.pool,
    expectedRole: "fas_selection_attempt_writer",
  });
  await assert.rejects(
    ledger.start({ ...ledgerFixture(), sessionGeneration: 0 }),
    /identity_invalid/,
  );
  assert.equal(fixture.queries.some((query) => query.text.startsWith("BEGIN")), false);
});
