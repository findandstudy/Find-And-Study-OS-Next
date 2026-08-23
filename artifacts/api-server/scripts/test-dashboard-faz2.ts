/**
 * DASHBOARD FAZ 2 — activity summary + kommo summary endpoint tests.
 *
 * DV2-1  GET /v1/activity/summary?range=weekly  — returns expected numeric shape.
 * DV2-2  GET /v1/activity/summary?range=monthly — returns 200.
 * DV2-3  GET /v1/activity/summary?range=daily&staffId=<id> — admin can filter by staffId.
 * DV2-4  GET /stats/kommo-summary — returns all 7 expected numeric fields.
 * DV2-5  GET /stats/kommo-summary?staffId=<id> — staffId accepted, 200 with numerics.
 * DV2-6  GET /v1/activity/summary — non-admin user sees own data only (200).
 * DV2-7  GET /v1/activity/summary — invalid range falls back gracefully (200, daily).
 * DV2-8  GET /stats/kommo-summary?from=<invalid> — 400 for unparseable date.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:dashboard-faz2
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

async function getFirstUserId(): Promise<number> {
  const [u] = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
  return u?.id ?? 1;
}

function isoWeekAgo() {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
}
function isoNow() {
  return new Date().toISOString();
}

// ── DV2-1 ─────────────────────────────────────────────────────────────────────
test("DV2-1: GET /v1/activity/summary?range=weekly — expected numeric shape", async () => {
  testAdminId = await getFirstUserId();
  const app = buildApp({ id: testAdminId, role: "super_admin" });
  await withServer(app, async (s) => {
    const r = await sendReq(s, "GET", "/api/v1/activity/summary?range=weekly");
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(typeof r.body.leadsViewed === "number", "leadsViewed must be number");
    assert.ok(typeof r.body.studentsViewed === "number", "studentsViewed must be number");
    assert.ok(typeof r.body.applicationsViewed === "number", "applicationsViewed must be number");
    assert.ok(typeof r.body.messagesViewed === "number", "messagesViewed must be number");
    assert.ok(typeof r.body.activeDurationSeconds === "number", "activeDurationSeconds must be number");
  });
});

// ── DV2-2 ─────────────────────────────────────────────────────────────────────
test("DV2-2: GET /v1/activity/summary?range=monthly — returns 200", async () => {
  testAdminId = await getFirstUserId();
  const app = buildApp({ id: testAdminId, role: "super_admin" });
  await withServer(app, async (s) => {
    const r = await sendReq(s, "GET", "/api/v1/activity/summary?range=monthly");
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});

// ── DV2-3 ─────────────────────────────────────────────────────────────────────
test("DV2-3: GET /v1/activity/summary?staffId=<id> — admin staffId filter accepted", async () => {
  testAdminId = await getFirstUserId();
  const app = buildApp({ id: testAdminId, role: "super_admin" });
  await withServer(app, async (s) => {
    const r = await sendReq(
      s,
      "GET",
      `/api/v1/activity/summary?range=daily&staffId=${testAdminId}`,
    );
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(typeof r.body.leadsViewed === "number");
  });
});

// ── DV2-4 ─────────────────────────────────────────────────────────────────────
test("DV2-4: GET /stats/kommo-summary — returns all 7 numeric fields", async () => {
  testAdminId = await getFirstUserId();
  const app = buildApp({ id: testAdminId, role: "super_admin" });
  const from = encodeURIComponent(isoWeekAgo());
  const to = encodeURIComponent(isoNow());
  await withServer(app, async (s) => {
    const r = await sendReq(s, "GET", `/api/stats/kommo-summary?from=${from}&to=${to}`);
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(typeof r.body.avgReplyTime === "number", "avgReplyTime must be number");
    assert.ok(typeof r.body.medianReplyTime === "number", "medianReplyTime must be number");
    assert.ok(typeof r.body.activeLeads === "number", "activeLeads must be number");
    assert.ok(typeof r.body.wonLeads === "number", "wonLeads must be number");
    assert.ok(typeof r.body.lostLeads === "number", "lostLeads must be number");
    assert.ok(typeof r.body.incomingMessages === "number", "incomingMessages must be number");
    assert.ok(typeof r.body.outgoingMessages === "number", "outgoingMessages must be number");
  });
});

// ── DV2-5 ─────────────────────────────────────────────────────────────────────
test("DV2-5: GET /stats/kommo-summary?staffId=<id> — staffId filter accepted", async () => {
  testAdminId = await getFirstUserId();
  const app = buildApp({ id: testAdminId, role: "super_admin" });
  const from = encodeURIComponent(isoWeekAgo());
  const to = encodeURIComponent(isoNow());
  await withServer(app, async (s) => {
    const r = await sendReq(
      s,
      "GET",
      `/api/stats/kommo-summary?from=${from}&to=${to}&staffId=${testAdminId}`,
    );
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(typeof r.body.avgReplyTime === "number");
  });
});

// ── DV2-6 ─────────────────────────────────────────────────────────────────────
test("DV2-6: GET /v1/activity/summary — non-admin staff sees own data (200)", async () => {
  testStaffId = await getFirstUserId();
  const app = buildApp({ id: testStaffId, role: "staff" });
  await withServer(app, async (s) => {
    const r = await sendReq(s, "GET", "/api/v1/activity/summary?range=daily");
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(typeof r.body.leadsViewed === "number");
  });
});

// ── DV2-7 ─────────────────────────────────────────────────────────────────────
test("DV2-7: GET /v1/activity/summary — range=invalid rejected with 400", async () => {
  testAdminId = await getFirstUserId();
  const app = buildApp({ id: testAdminId, role: "super_admin" });
  await withServer(app, async (s) => {
    const r = await sendReq(s, "GET", "/api/v1/activity/summary?range=invalid");
    assert.equal(r.status, 400, `Expected 400 for invalid range, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});

// ── DV2-8 ─────────────────────────────────────────────────────────────────────
test("DV2-8: GET /stats/kommo-summary?from=garbage — 400 for unparseable date", async () => {
  testAdminId = await getFirstUserId();
  const app = buildApp({ id: testAdminId, role: "super_admin" });
  await withServer(app, async (s) => {
    const r = await sendReq(
      s,
      "GET",
      "/api/stats/kommo-summary?from=not-a-date&to=also-not",
    );
    assert.equal(r.status, 400, `Expected 400 for invalid date, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});
