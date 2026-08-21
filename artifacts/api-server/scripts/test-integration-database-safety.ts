import assert from "node:assert/strict";
import { test } from "node:test";

import { assertSafeSignedContractAuthzDatabase } from "./integration-database-safety.js";

const base = {
  allowLiveIntegrations: "false",
  allowMutation: "1",
  githubActions: "true",
  githubRunAttempt: "1",
  githubRunId: "123",
};

test("allows the disposable CI database contract", () => {
  assert.doesNotThrow(() =>
    assertSafeSignedContractAuthzDatabase({
      ...base,
      ci: "true",
      databaseUrl: "postgresql://postgres:test@127.0.0.1:5432/fas_it_123_1",
    }),
  );
});

test("allows only the named local development database outside CI", () => {
  assert.doesNotThrow(() =>
    assertSafeSignedContractAuthzDatabase({
      ...base,
      ci: "false",
      databaseUrl: "postgresql://test:test@127.0.0.1:5433/fasos_apply_local",
    }),
  );
});

const deniedInputs = [
  {
    label: "missing mutation opt-in",
    input: { ...base, allowMutation: undefined, ci: "true", databaseUrl: "postgresql://postgres:test@127.0.0.1:5432/fas_it_1" },
  },
  {
    label: "live integrations enabled",
    input: { ...base, allowLiveIntegrations: "true", ci: "true", databaseUrl: "postgresql://postgres:test@127.0.0.1:5432/fas_it_1" },
  },
  {
    label: "CI without a GitHub Actions run identity",
    input: { ...base, githubActions: undefined, ci: "true", databaseUrl: "postgresql://postgres:test@127.0.0.1:5432/fas_it_123_1" },
  },
  {
    label: "non-numeric GitHub run identity",
    input: { ...base, githubRunId: "production", ci: "true", databaseUrl: "postgresql://postgres:test@127.0.0.1:5432/fas_it_production_1" },
  },
  {
    label: "CI database name that does not match the run identity",
    input: { ...base, ci: "true", databaseUrl: "postgresql://postgres:test@127.0.0.1:5432/fas_it_124_1" },
  },
  {
    label: "remote database host",
    input: { ...base, ci: "true", databaseUrl: "postgresql://postgres:test@db.example.test:5432/fas_it_123_1" },
  },
  {
    label: "query-parameter host override",
    input: { ...base, ci: "true", databaseUrl: "postgresql://postgres:test@127.0.0.1:5432/fas_it_123_1?host=db.example.test" },
  },
  {
    label: "production-like database name",
    input: { ...base, ci: "true", databaseUrl: "postgresql://postgres:test@127.0.0.1:5432/findandstudy" },
  },
  {
    label: "local database on the wrong port",
    input: { ...base, ci: "false", databaseUrl: "postgresql://test:test@127.0.0.1:5432/fasos_apply_local" },
  },
] as const;

for (const { label, input } of deniedInputs) {
  test(`denies ${label}`, () => {
    assert.throws(() => assertSafeSignedContractAuthzDatabase(input));
  });
}
