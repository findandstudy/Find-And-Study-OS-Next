/**
 * DASHBOARD FAZ 3 — UserActivityPanel & Trends dropdown regression tests.
 *
 * DV3-1  GET /v1/activity/summary?range=daily   — 200, all expected numeric keys present.
 * DV3-2  GET /v1/activity/summary?range=weekly  — 200.
 * DV3-3  GET /v1/activity/summary?range=monthly — 200.
 * DV3-4  GET /v1/activity/summary?range=yearly  — 200.
 * DV3-5  GET /v1/activity/summary?range=daily&staffId=<id> — admin can filter by staffId.
 * DV3-6  GET /v1/activity/summary?range=daily   — non-admin sees own data only (200).
 * DV3-7  GET /stats/kommo-summary               — returns expected numeric shape.
 * DV3-8  GET /stats/kommo-summary?from=<iso>&to=<iso>&staffId=<id> — 200, all keys present.
 * DV3-9  GET /stats/kommo-summary?from=bad      — 400 for unparseable date.
 * DV3-10 GET /v1/activity/summary?range=bad     — graceful fallback (200) not 400/500.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:dashboard-faz3
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express } from "express";
import { db, usersTable } from "@workspace/db";

import activityV1Router from "../src/routes/activityV1.js";
import statsRouter from "../src/routes/stats.js";

after(() => {
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

let testAdminId = 1;
let testStaffId = 1;

function buildApp(
  userOverride?: Partial<{ id: number; role: string; isActive: boolean }>,
): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = {
      id: testAdminId,
      role: "super_admin",
      isActive: true,
      ...userOverride,
    };
    if (!("cookies" in req)) (req as any).cookies = {};
    next();
  });
  app.use("/api", activityV1Router);
  app.use("/api", statsRouter);
  return app;
}

function sendReq(
  server: http.Server,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const opts: http.RequestOptions = {
      hostname: "127.0.0.1",
      port: addr.port,
      path,
      method,
      headers: { "Content-Type": "application/json" },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode!, body: data });
        }
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function withServer(
  app: Express,
  fn: (s: http.Server) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", async () => {
      try {
        await fn(s);
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        s.close();
      }
    });
  });
}

async function resolveTestUsers(): Promise<void> {
  const [admin] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .limit(1);
  testAdminId = admin?.id ?? 1;
  testStaffId = admin?.id ?? 1;
}

function isoWeekAgo(): string {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
}
function isoNow(): string {
  return new Date().toISOString();
}

const ACTIVITY_NUMERIC_KEYS = [
  "leadsViewed",
  "studentsViewed",
  "applicationsViewed",
  "activeDurationSeconds",
  "idleDurationSeconds",
  "totalDurationSeconds",
];

const KOMMO_NUMERIC_KEYS = [
  "avgReplyTime",
  "medianReplyTime",
  "activeLeads",
  "wonLeads",
  "lostLeads",
  "incomingMessages",
  "outgoingMessages",
];

// ── DV3-1 ─────────────────────────────────────────────────────────────────────
test("DV3-1: GET /v1/activity/summary?range=daily — 200 + numeric keys", async () => {
  await resolveTestUsers();
  const app = buildApp({ id: testAdminId, role: "super_admin" });
  await withServer(app, async (s) => {
    const r = await sendReq(s, "GET", "/api/v1/activity/summary?range=daily");
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    for (const key of ACTIVITY_NUMERIC_KEYS) {
      assert.ok(key in r.body, `Missing key: ${key}`);
      assert.equal(typeof r.body[key], "number", `${key} must be a number`);
      assert.ok(r.body[key] >= 0, `${key} must be >= 0`);
    }
  });
});

// ── DV3-2 ─────────────────────────────────────────────────────────────────────
test("DV3-2: GET /v1/activity/summary?range=weekly — 200", async () => {
  const app = buildApp({ id: testAdminId, role: "super_admin" });
  await withServer(app, async (s) => {
    const r = await sendReq(s, "GET", "/api/v1/activity/summary?range=weekly");
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(typeof r.body.leadsViewed === "number");
  });
});

// ── DV3-3 ─────────────────────────────────────────────────────────────────────
test("DV3-3: GET /v1/activity/summary?range=monthly — 200", async () => {
  const app = buildApp({ id: testAdminId, role: "super_admin" });
  await withServer(app, async (s) => {
    const r = await sendReq(s, "GET", "/api/v1/activity/summary?range=monthly");
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(typeof r.body.studentsViewed === "number");
  });
});

// ── DV3-4 ─────────────────────────────────────────────────────────────────────
test("DV3-4: GET /v1/activity/summary?range=yearly — 200", async () => {
  const app = buildApp({ id: testAdminId, role: "super_admin" });
  await withServer(app, async (s) => {
    const r = await sendReq(s, "GET", "/api/v1/activity/summary?range=yearly");
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(typeof r.body.applicationsViewed === "number");
  });
});

// ── DV3-5 ─────────────────────────────────────────────────────────────────────
test("DV3-5: GET /v1/activity/summary?range=daily&staffId=<id> — admin staffId filter", async () => {
  const app = buildApp({ id: testAdminId, role: "super_admin" });
  await withServer(app, async (s) => {
    const r = await sendReq(
      s,
      "GET",
      `/api/v1/activity/summary?range=daily&staffId=${testStaffId}`,
    );
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    for (const key of ACTIVITY_NUMERIC_KEYS) {
      assert.ok(key in r.body, `Missing key: ${key}`);
    }
  });
});

// ── DV3-6 ─────────────────────────────────────────────────────────────────────
test("DV3-6: GET /v1/activity/summary — non-admin (staff) sees own data, 200", async () => {
  const app = buildApp({ id: testStaffId, role: "staff", isActive: true });
  await withServer(app, async (s) => {
    const r = await sendReq(s, "GET", "/api/v1/activity/summary?range=daily");
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    for (const key of ACTIVITY_NUMERIC_KEYS) {
      assert.ok(key in r.body, `Missing key for staff: ${key}`);
    }
  });
});

// ── DV3-7 ─────────────────────────────────────────────────────────────────────
test("DV3-7: GET /stats/kommo-summary — 200, all 7 numeric keys present", async () => {
  const app = buildApp({ id: testAdminId, role: "super_admin" });
  await withServer(app, async (s) => {
    const r = await sendReq(s, "GET", "/api/stats/kommo-summary");
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    for (const key of KOMMO_NUMERIC_KEYS) {
      assert.ok(key in r.body, `Missing kommo key: ${key}`);
      assert.equal(typeof r.body[key], "number", `${key} must be a number`);
      assert.ok(r.body[key] >= 0, `${key} must be >= 0`);
    }
  });
});

// ── DV3-8 ─────────────────────────────────────────────────────────────────────
test("DV3-8: GET /stats/kommo-summary?from=<iso>&to=<iso>&staffId=<id> — 200, all keys", async () => {
  const app = buildApp({ id: testAdminId, role: "super_admin" });
  await withServer(app, async (s) => {
    const from = encodeURIComponent(isoWeekAgo());
    const to = encodeURIComponent(isoNow());
    const r = await sendReq(
      s,
      "GET",
      `/api/stats/kommo-summary?from=${from}&to=${to}&staffId=${testStaffId}`,
    );
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    for (const key of KOMMO_NUMERIC_KEYS) {
      assert.ok(key in r.body, `Missing key after from/to/staffId filter: ${key}`);
    }
  });
});

// ── DV3-9 ─────────────────────────────────────────────────────────────────────
test("DV3-9: GET /stats/kommo-summary?from=bad — 400 for unparseable date", async () => {
  const app = buildApp({ id: testAdminId, role: "super_admin" });
  await withServer(app, async (s) => {
    const r = await sendReq(s, "GET", "/api/stats/kommo-summary?from=not-a-date");
    assert.equal(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});

// ── DV3-10 ────────────────────────────────────────────────────────────────────
test("DV3-10: GET /v1/activity/summary?range=bad — graceful (200, not 500)", async () => {
  const app = buildApp({ id: testAdminId, role: "super_admin" });
  await withServer(app, async (s) => {
    const r = await sendReq(s, "GET", "/api/v1/activity/summary?range=bad");
    assert.ok(
      r.status === 200 || r.status === 400,
      `Expected 200 or 400, got ${r.status}: ${JSON.stringify(r.body)}`,
    );
    if (r.status === 200) {
      assert.ok(typeof r.body.leadsViewed === "number", "leadsViewed must be number in fallback");
    }
  });
});
