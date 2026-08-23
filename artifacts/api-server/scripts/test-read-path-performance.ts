import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import {
  clearPendingReadsForTests,
  coalesceRead,
  getReadPathMetricsSnapshot,
  runWithReadPathMetrics,
} from "../src/lib/readPathCoalescing";
import {
  getDbRequestMetricsSnapshot,
  recordDbAcquire,
  recordDbQuery,
  recordDbRetry,
  runWithDbRequestMetrics,
} from "../../../lib/db/src/requestMetrics";
import { recordRequestSpan } from "../src/lib/requestTelemetry";
import {
  buildScopeFingerprint,
  buildFacetFilterInput,
  clearFacetCacheForTests,
  loadFacetValue,
} from "../src/lib/facetCache";

test.afterEach(() => {
  clearPendingReadsForTests();
  clearFacetCacheForTests();
  delete process.env.READ_PATH_COALESCING_ENABLED;
  delete process.env.FACET_CACHE_ENABLED;
  delete process.env.FACET_CACHE_TTL_MS;
  delete process.env.FACET_CACHE_MAX_ENTRIES;
});

test("scope fingerprints are canonical and permission-sensitive", () => {
  const first = buildScopeFingerprint({
    userId: 12,
    role: "staff",
    permissions: ["records.view_own", "records.view_unassigned"],
    visibleBranchIds: [2, 7],
  });
  const reordered = buildScopeFingerprint({
    visibleBranchIds: [2, 7],
    permissions: ["records.view_own", "records.view_unassigned"],
    role: "staff",
    userId: 12,
  });
  const changedPermission = buildScopeFingerprint({
    userId: 12,
    role: "staff",
    permissions: ["records.view_own", "records.view_others"],
    visibleBranchIds: [2, 7],
  });
  const changedBranch = buildScopeFingerprint({
    userId: 12,
    role: "staff",
    permissions: ["records.view_own", "records.view_unassigned"],
    visibleBranchIds: [2, 8],
  });

  assert.equal(first, reordered);
  assert.notEqual(first, changedPermission);
  assert.notEqual(first, changedBranch);
});

test("facet cache stays disabled unless explicitly enabled", async () => {
  let executions = 0;
  const load = async () => ++executions;

  await loadFacetValue({ namespace: "students", scope: { userId: 1 }, filters: {}, load });
  await loadFacetValue({ namespace: "students", scope: { userId: 1 }, filters: {}, load });

  assert.equal(executions, 2);
});

test("facet cache reuses only an identical fresh scope and filter set", async () => {
  process.env.FACET_CACHE_ENABLED = "true";
  let executions = 0;
  const load = async () => ({ execution: ++executions });
  const base = {
    namespace: "applications",
    scope: {
      userId: 4,
      role: "staff",
      permissions: ["records.view_own"],
      visibleBranchIds: [3],
      agencyAgentIds: [9],
    },
    filters: { season: "2026" },
    load,
  };

  const first = await loadFacetValue(base);
  const second = await loadFacetValue(base);
  const changedAgency = await loadFacetValue({
    ...base,
    scope: { ...base.scope, agencyAgentIds: [10] },
  });

  assert.deepEqual(first, second);
  assert.equal(changedAgency.execution, 2);
  assert.equal(executions, 2);
});

test("facet cache namespaces cannot collide and cached values cannot be mutated", async () => {
  process.env.FACET_CACHE_ENABLED = "true";
  let executions = 0;
  const load = async () => [{ value: ++executions }];
  const common = { scope: { userId: 7 }, filters: { season: "2026" }, load };

  const leads = await loadFacetValue({ namespace: "leads", ...common });
  leads[0]!.value = 999;
  const leadsAgain = await loadFacetValue({ namespace: "leads", ...common });
  const students = await loadFacetValue({ namespace: "students", ...common });

  assert.equal(leadsAgain[0]!.value, 1);
  assert.equal(students[0]!.value, 2);
  assert.equal(executions, 2);
});

test("facet filter input keeps future filters but ignores response-shaping parameters", () => {
  assert.deepEqual(buildFacetFilterInput({
    page: "4",
    limit: "25",
    sortKey: "name",
    includeFacets: "1",
    season: "2026",
    futureFilter: "enabled",
  }), {
    season: "2026",
    futureFilter: "enabled",
  });
});

test("facet cache honors TTL and LRU bounds", async () => {
  process.env.FACET_CACHE_ENABLED = "true";
  process.env.FACET_CACHE_TTL_MS = "1";
  process.env.FACET_CACHE_MAX_ENTRIES = "1";
  let executions = 0;
  const load = async () => ++executions;

  await loadFacetValue({ namespace: "leads", scope: { userId: 1 }, filters: {}, load });
  await loadFacetValue({ namespace: "leads", scope: { userId: 2 }, filters: {}, load });
  await loadFacetValue({ namespace: "leads", scope: { userId: 1 }, filters: {}, load });
  await new Promise((resolve) => setTimeout(resolve, 3));
  await loadFacetValue({ namespace: "leads", scope: { userId: 1 }, filters: {}, load });

  assert.equal(executions, 4);
});

test("rejected facet loads are never cached", async () => {
  process.env.FACET_CACHE_ENABLED = "true";
  let executions = 0;
  const load = async () => {
    executions += 1;
    if (executions === 1) throw new Error("facet failure");
    return "ok";
  };

  await assert.rejects(
    loadFacetValue({ namespace: "leads", scope: { userId: 3 }, filters: {}, load }),
    /facet failure/,
  );
  const result = await loadFacetValue({ namespace: "leads", scope: { userId: 3 }, filters: {}, load });

  assert.equal(result, "ok");
  assert.equal(executions, 2);
});

test("request DB metrics stay isolated across async request contexts", async () => {
  const [first, second] = await Promise.all([
    runWithDbRequestMetrics(async () => {
      recordDbAcquire(4);
      recordDbQuery(11);
      recordDbRetry();
      await Promise.resolve();
      return getDbRequestMetricsSnapshot();
    }),
    runWithDbRequestMetrics(async () => {
      recordDbAcquire(2);
      recordDbQuery(7);
      await Promise.resolve();
      return getDbRequestMetricsSnapshot();
    }),
  ]);

  assert.deepEqual(first, {
    queryCount: 1,
    queryDurationMs: 11,
    acquireCount: 1,
    acquireWaitMs: 4,
    retryCount: 1,
  });
  assert.deepEqual(second, {
    queryCount: 1,
    queryDurationMs: 7,
    acquireCount: 1,
    acquireWaitMs: 2,
    retryCount: 0,
  });
  assert.equal(getDbRequestMetricsSnapshot(), null);
});

test("identical opted-in reads share one in-flight promise", async () => {
  process.env.READ_PATH_COALESCING_ENABLED = "true";
  let executions = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const execute = async () => {
    executions += 1;
    await gate;
    return { ok: true };
  };

  const { firstResult, secondResult, metrics } = await runWithReadPathMetrics(async () => {
    const first = coalesceRead({ namespace: "facet", key: "same-scope", execute });
    const second = coalesceRead({ namespace: "facet", key: "same-scope", execute });
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    return { firstResult, secondResult, metrics: getReadPathMetricsSnapshot() };
  });
  assert.equal(executions, 1);
  assert.equal(firstResult.coalesced, false);
  assert.equal(secondResult.coalesced, true);
  assert.deepEqual(firstResult.value, secondResult.value);
  assert.deepEqual(metrics, { started: 1, merged: 1 });
});

test("different scope keys never share an in-flight read", async () => {
  process.env.READ_PATH_COALESCING_ENABLED = "true";
  let executions = 0;
  const execute = async () => ++executions;

  const [first, second] = await Promise.all([
    coalesceRead({ namespace: "facet", key: "staff-1", execute }),
    coalesceRead({ namespace: "facet", key: "staff-2", execute }),
  ]);

  assert.equal(executions, 2);
  assert.notEqual(first.value, second.value);
});

test("a rejected read is removed and can be retried", async () => {
  process.env.READ_PATH_COALESCING_ENABLED = "true";
  let executions = 0;
  const execute = async () => {
    executions += 1;
    if (executions === 1) throw new Error("temporary failure");
    return "ok";
  };

  await assert.rejects(
    coalesceRead({ namespace: "facet", key: "retry", execute }),
    /temporary failure/,
  );
  const retried = await coalesceRead({ namespace: "facet", key: "retry", execute });
  assert.equal(retried.value, "ok");
  assert.equal(executions, 2);
});

test("request middleware emits timing headers and a PII-safe metric record", async () => {
  process.env.DATABASE_URL = "postgres://test:test@127.0.0.1:1/test";
  process.env.REQUEST_PERF_TELEMETRY_ENABLED = "true";
  const [{ default: express }, { requestPerformanceMiddleware }] = await Promise.all([
    import("express"),
    import("../src/lib/requestPerformance"),
  ]);

  const app = express();
  app.use((req, res, next) => {
    res.locals.requestId = "request-test";
    requestPerformanceMiddleware(req, res, next);
  });
  app.get("/api/test", (_req, res) => {
    recordRequestSpan("scopeResolve", 3.25);
    res.json({ ok: true });
  });
  app.head("/api/head-test", (_req, res) => res.json({ hidden: true }));
  app.get("/api/not-modified", (_req, res) => res.status(304).end());

  const records: unknown[][] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => { records.push(args); };
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/test?secret=ignored`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("server-timing") || "", /app;dur=/);
    assert.match(response.headers.get("server-timing") || "", /sql;desc="0"/);
    await response.arrayBuffer();
    const headResponse = await fetch(`http://127.0.0.1:${address.port}/api/head-test`, { method: "HEAD" });
    assert.equal(headResponse.status, 200);
    await headResponse.arrayBuffer();
    const notModifiedResponse = await fetch(`http://127.0.0.1:${address.port}/api/not-modified`);
    assert.equal(notModifiedResponse.status, 304);
    await notModifiedResponse.arrayBuffer();
    await new Promise((resolve) => setImmediate(resolve));

    const metricLine = records.find((entry) => entry[0] === "[request-performance]");
    assert.ok(metricLine);
    const metric = JSON.parse(String(metricLine[1]));
    assert.equal(metric.path, "/api/test");
    assert.equal(metric.requestId, "request-test");
    assert.equal(metric.dbQueryCount, 0);
    assert.equal(metric.scopeResolveMs, 3.3);
    assert.ok(metric.responseBytes > 0);
    assert.ok(metric.unattributedMs >= 0);
    assert.equal(metric.coalescedReadStartedCount, 0);
    assert.equal(metric.coalescedReadMergedCount, 0);
    assert.equal(String(metricLine[1]).includes("secret"), false);
    const headMetricLine = records.find((entry) => {
      if (entry[0] !== "[request-performance]") return false;
      return JSON.parse(String(entry[1])).path === "/api/head-test";
    });
    const notModifiedMetricLine = records.find((entry) => {
      if (entry[0] !== "[request-performance]") return false;
      return JSON.parse(String(entry[1])).path === "/api/not-modified";
    });
    assert.equal(JSON.parse(String(headMetricLine?.[1])).responseBytes, 0);
    assert.equal(JSON.parse(String(notModifiedMetricLine?.[1])).responseBytes, 0);
  } finally {
    console.info = originalInfo;
    delete process.env.REQUEST_PERF_TELEMETRY_ENABLED;
    server.close();
    await once(server, "close");
  }
});
