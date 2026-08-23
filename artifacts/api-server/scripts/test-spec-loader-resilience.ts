/**
 * specLoader resilience tests — Faz 1.
 *
 * Tests:
 *   SLR1 — empty table (no enabled rows) → loadSpecAdaptersFromDb returns [].
 *   SLR2 — DB select throws → loadSpecAdaptersFromDb returns [] (never throws).
 *   SLR3 — valid spec row → adapter is built and returned.
 *   SLR4 — malformed spec row skipped; valid row still returned.
 *   SLR5 — after a throw, re-enabling normal override → subsequent call succeeds.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:spec-loader-resilience
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import type { PortalAdapterSpec } from "@workspace/db";
import {
  loadSpecAdaptersFromDb,
  buildSpecAdaptersFromRows,
  __setDbSelectOverrideForTests,
  resolveOverrideSpecAdapterByKey,
  resolveOverrideSpecAdapterForUniversity,
} from "../../../lib/portal-adapters/src/specLoader.js";

// ---------------------------------------------------------------------------
// Minimal fully-valid declarative spec (mirrors test-declarative-adapter.ts)
// ---------------------------------------------------------------------------
function validRawSpec(): unknown {
  return {
    specVersion: 1,
    meta: {
      key: "test_uni_slr",
      name: "Test University SLR",
      baseUrl: "https://apply.test-slr.example.com",
      matches: ["Test University SLR"],
    },
    auth: {
      loginUrl: "https://apply.test-slr.example.com/login",
      loginSteps: [
        { action: "fill", selector: "#email", valueFrom: "profile.email" },
        { action: "click", selector: "button[type=submit]" },
        { action: "waitFor", selector: ".dashboard" },
      ],
    },
    steps: [
      { action: "navigate", url: "https://apply.test-slr.example.com/apply" },
      { action: "fill", selector: "#firstName", valueFrom: "profile.firstName" },
      { action: "click", selector: "#submitBtn", final: true },
    ],
    success: { successText: "submitted" },
  };
}

function makeRow(overrides: Partial<PortalAdapterSpec> = {}): PortalAdapterSpec {
  return {
    id: 1,
    key: "test_uni_slr",
    name: "Test University SLR",
    version: 1,
    enabled: true,
    source: "builtin",
    jsHookApproved: false,
    privilegedApproved: false,
    spec: validRawSpec() as PortalAdapterSpec["spec"],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

before(() => {
  __setDbSelectOverrideForTests(null);
});

after(() => {
  __setDbSelectOverrideForTests(null);
});

test("SLR1 — empty table (no enabled rows) → returns []", async () => {
  __setDbSelectOverrideForTests(async () => []);
  try {
    const adapters = await loadSpecAdaptersFromDb(true);
    assert.deepEqual(adapters, [], "expected empty array when table has no enabled rows");
  } finally {
    __setDbSelectOverrideForTests(null);
  }
});

test("SLR2 — DB select throws → returns [] without re-throwing", async () => {
  __setDbSelectOverrideForTests(async () => {
    throw new Error('relation "portal_adapter_specs" does not exist');
  });
  try {
    // Must NOT throw — resilience is the key contract here.
    const adapters = await loadSpecAdaptersFromDb(true);
    assert.deepEqual(adapters, [], "expected [] when select throws");
  } finally {
    __setDbSelectOverrideForTests(null);
  }
});

test("SLR3 — valid enabled spec row → adapter built and returned", async () => {
  __setDbSelectOverrideForTests(async () => [makeRow()]);
  try {
    const adapters = await loadSpecAdaptersFromDb(true);
    assert.equal(adapters.length, 1, "expected one adapter from one valid enabled row");
    assert.equal(adapters[0].key, "test_uni_slr");
  } finally {
    __setDbSelectOverrideForTests(null);
  }
});

test("SLR4 — malformed spec row skipped; valid row still returned", () => {
  const badRow = makeRow({
    key: "bad_key",
    name: "Bad",
    spec: "not-a-valid-spec" as unknown as PortalAdapterSpec["spec"],
  });
  const goodRow = makeRow();
  const adapters = buildSpecAdaptersFromRows([badRow, goodRow]);
  assert.equal(adapters.length, 1, "malformed row should be skipped");
  assert.equal(adapters[0].key, "test_uni_slr");
});

test("SLR5 — after throw, restoring normal override → subsequent call returns adapters", async () => {
  // First call: throw
  __setDbSelectOverrideForTests(async () => { throw new Error("transient"); });
  const first = await loadSpecAdaptersFromDb(true);
  assert.deepEqual(first, [], "first call should return [] on error");

  // Second call: normal
  __setDbSelectOverrideForTests(async () => [makeRow()]);
  const second = await loadSpecAdaptersFromDb(true);
  assert.equal(second.length, 1, "should recover and return adapter on next successful call");

  __setDbSelectOverrideForTests(null);
});

test("SLR6 — v2 override resolves only with explicit privileged approval", async () => {
  const spec = validRawSpec() as Record<string, unknown>;
  spec.specVersion = 2;
  spec.meta = {
    ...(spec.meta as Record<string, unknown>),
    resolution: "override",
    dryRunPolicy: "strict",
  };
  const approved = makeRow({
    spec,
    enabled: true,
    privilegedApproved: true,
  });
  __setDbSelectOverrideForTests(async () => [approved]);
  try {
    await loadSpecAdaptersFromDb(true);
    assert.equal((await resolveOverrideSpecAdapterByKey("test_uni_slr"))?.key, "test_uni_slr");
    assert.equal(
      (await resolveOverrideSpecAdapterForUniversity("Test University SLR"))?.key,
      "test_uni_slr",
    );
  } finally {
    __setDbSelectOverrideForTests(null);
  }

  __setDbSelectOverrideForTests(async () => [
    { ...approved, privilegedApproved: false },
  ]);
  try {
    await loadSpecAdaptersFromDb(true);
    assert.equal(await resolveOverrideSpecAdapterByKey("test_uni_slr"), null);
  } finally {
    __setDbSelectOverrideForTests(null);
  }
});
