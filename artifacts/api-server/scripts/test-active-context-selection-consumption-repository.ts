import assert from "node:assert/strict";
import test from "node:test";

import {
  ActiveContextSelectionConsumptionCommitOutcomeUnknownError,
  PostgresActiveContextSelectionConsumptionRepository,
} from "../src/lib/postgresActiveContextSelectionConsumptionRepository.js";

const INPUT = {
  tenantId: "018fc000-0000-7000-8000-000000000001",
  selectionId: "018fc000-0000-7000-8000-000000000002",
  sessionGeneration: 1,
  principalId: "018fc000-0000-7000-8000-000000000003",
  membershipId: "018fc000-0000-7000-8000-000000000004",
  organizationId: null,
  legacyBranchId: null,
  observedAt: Date.now(),
} as const;

const STATE = {
  selectionId: INPUT.selectionId,
  tenantId: INPUT.tenantId,
  sessionGeneration: INPUT.sessionGeneration,
  principalId: INPUT.principalId,
  membershipId: INPUT.membershipId,
  organizationId: null,
  legacyBranchId: null,
  status: "ACTIVE",
};

function fakePool(options: {
  commitError?: Error;
  identity?: { current_user: string; tenant_setting: string | null };
}) {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  let released: unknown;
  const client = {
    async query<T extends Record<string, unknown>>(text: string, values?: unknown[]) {
      queries.push({ text, values });
      if (text.includes("current_user")) {
        return {
          rows: [options.identity ?? { current_user: "fas_selection_consumer", tenant_setting: null }],
          rowCount: 1,
        } as unknown as { rows: T[]; rowCount: number };
      }
      if (text === "BEGIN ISOLATION LEVEL SERIALIZABLE") {
        return { rows: [], rowCount: 0 } as { rows: T[]; rowCount: number };
      }
      if (text.includes("lock_selection_for_consumption")) {
        return { rows: [{ result: STATE }], rowCount: 1 } as unknown as { rows: T[]; rowCount: number };
      }
      if (text === "COMMIT" && options.commitError) throw options.commitError;
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

test("locks authoritative selection and exposes the same transaction to the operation", async () => {
  const fixture = fakePool({});
  const repository = new PostgresActiveContextSelectionConsumptionRepository({
    pool: fixture.pool,
    expectedRole: "fas_selection_consumer",
  });
  const result = await repository.withLockedSelection(INPUT, async (state, tx) => {
    assert.deepEqual(state, STATE);
    assert.ok(tx);
    await tx.query("SELECT 1");
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(fixture.released, undefined);
  assert.ok(fixture.queries.some((query) => query.text.includes("BEGIN ISOLATION LEVEL SERIALIZABLE")));
  assert.ok(fixture.queries.some((query) => query.text.includes("lock_selection_for_consumption")));
  const settings = fixture.queries.find((query) => query.text.includes("set_config('app.tenant_id'"));
  assert.deepEqual(settings?.values?.slice(-1), [INPUT.tenantId]);
  assert.equal(fixture.queries.at(-1)?.text, "COMMIT");
});

test("operation failure rolls back and releases a clean connection", async () => {
  const fixture = fakePool({});
  const repository = new PostgresActiveContextSelectionConsumptionRepository({
    pool: fixture.pool,
    expectedRole: "fas_selection_consumer",
  });
  await assert.rejects(
    repository.withLockedSelection(INPUT, async () => {
      throw new Error("operation_failed");
    }),
    /operation_failed/,
  );
  assert.equal(fixture.released, undefined);
  assert.equal(fixture.queries.at(-1)?.text, "ROLLBACK");
});

test("commit acknowledgement loss is never converted into a rollback success", async () => {
  const commitError = new Error("ack_lost");
  const fixture = fakePool({ commitError });
  const repository = new PostgresActiveContextSelectionConsumptionRepository({
    pool: fixture.pool,
    expectedRole: "fas_selection_consumer",
  });
  await assert.rejects(
    repository.withLockedSelection(INPUT, async () => "ok"),
    (error: unknown) => error instanceof ActiveContextSelectionConsumptionCommitOutcomeUnknownError,
  );
  assert.equal(fixture.released, commitError);
  assert.equal(fixture.queries.filter((query) => query.text === "ROLLBACK").length, 0);
});

test("wrong role and malformed binding fail before opening a transaction", async () => {
  const fixture = fakePool({
    identity: { current_user: "fas_other_role", tenant_setting: null },
  });
  const repository = new PostgresActiveContextSelectionConsumptionRepository({
    pool: fixture.pool,
    expectedRole: "fas_selection_consumer",
  });
  await assert.rejects(
    repository.withLockedSelection(INPUT, async () => "never"),
    /identity_invalid/,
  );
  assert.equal(fixture.queries.some((query) => query.text.startsWith("BEGIN")), false);
  await assert.rejects(
    repository.withLockedSelection({ ...INPUT, sessionGeneration: 0 }, async () => "never"),
    /input_invalid/,
  );
});
