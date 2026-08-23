/**
 * DASHBOARD FAZ 1 — entity_view_events regression tests.
 *
 * DV-1  POST /v1/activity/view — records a new view event (201).
 * DV-2  POST /v1/activity/view — 5-min dedup: second call returns {ok:true, deduplicated:true} (200).
 * DV-3  POST /v1/activity/view — different entityType for same user is NOT deduplicated (201).
 * DV-4  POST /v1/activity/view — validation: missing entityType → 400.
 * DV-5  GET  /v1/activity/summary?range=daily — returns expected shape with 0-safe numerics.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:dashboard-faz1
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express } from "express";
import { eq, and } from "drizzle-orm";
import { db, entityViewEventsTable, usersTable } from "@workspace/db";

import activityV1Router from "../src/routes/activityV1.js";

after(() => {
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

const RUN_ID = `dv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

let testUserId = 1;

function buildApp(userOverride?: Partial<{ id: number; role: string; isActive: boolean }>): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: testUserId, role: "super_admin", isActive: true, ...userOverride };
    if (!("cookies" in req)) (req as any).cookies = {};
    next();
  });
  app.use("/api", activityV1Router);
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
    const req = http.request(opts, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode!, body: data }); }
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function withServer(app: Express, fn: (s: http.Server) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", async () => {
      try { await fn(s); resolve(); }
      catch (e) { reject(e); }
      finally { s.close(); }
    });
  });
}

async function getFirstUserId(): Promise<number> {
  const [u] = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
  return u?.id ?? 1;
}

async function cleanup(userId: number, entityType: string, entityId: number) {
  await db.delete(entityViewEventsTable).where(
    and(
      eq(entityViewEventsTable.userId, userId),
      eq(entityViewEventsTable.entityType, entityType as any),
      eq(entityViewEventsTable.entityId, entityId),
    )
  );
}

test("DV-1: POST /v1/activity/view records a new view event (201)", async () => {
  testUserId = await getFirstUserId();
  const entityId = 90000 + Math.floor(Math.random() * 9999);
  await cleanup(testUserId, "lead", entityId);

  const app = buildApp({ id: testUserId });
  await withServer(app, async (s) => {
    const r = await sendReq(s, "POST", "/api/v1/activity/view", { entityType: "lead", entityId });
    assert.equal(r.status, 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.deduplicated, false);
  });

  await cleanup(testUserId, "lead", entityId);
});

test("DV-2: POST /v1/activity/view — 5-min dedup returns 200 deduplicated:true", async () => {
  testUserId = await getFirstUserId();
  const entityId = 91000 + Math.floor(Math.random() * 9999);
  await cleanup(testUserId, "student", entityId);

  const app = buildApp({ id: testUserId });
  await withServer(app, async (s) => {
    const r1 = await sendReq(s, "POST", "/api/v1/activity/view", { entityType: "student", entityId });
    assert.equal(r1.status, 201, `First call: Expected 201, got ${r1.status}`);
    assert.equal(r1.body.deduplicated, false);

    const r2 = await sendReq(s, "POST", "/api/v1/activity/view", { entityType: "student", entityId });
    assert.equal(r2.status, 200, `Second call (dedup): Expected 200, got ${r2.status}: ${JSON.stringify(r2.body)}`);
    assert.equal(r2.body.ok, true);
    assert.equal(r2.body.deduplicated, true);
  });

  await cleanup(testUserId, "student", entityId);
});

test("DV-3: POST /v1/activity/view — different entityType NOT deduplicated (201)", async () => {
  testUserId = await getFirstUserId();
  const entityId = 92000 + Math.floor(Math.random() * 9999);
  await cleanup(testUserId, "lead", entityId);
  await cleanup(testUserId, "application", entityId);

  const app = buildApp({ id: testUserId });
  await withServer(app, async (s) => {
    const r1 = await sendReq(s, "POST", "/api/v1/activity/view", { entityType: "lead", entityId });
    assert.equal(r1.status, 201);

    const r2 = await sendReq(s, "POST", "/api/v1/activity/view", { entityType: "application", entityId });
    assert.equal(r2.status, 201, `Different entityType should NOT be deduped: ${JSON.stringify(r2.body)}`);
    assert.equal(r2.body.deduplicated, false);
  });

  await cleanup(testUserId, "lead", entityId);
  await cleanup(testUserId, "application", entityId);
});

test("DV-4: POST /v1/activity/view — missing entityType → 400", async () => {
  const app = buildApp();
  await withServer(app, async (s) => {
    const r = await sendReq(s, "POST", "/api/v1/activity/view", { entityId: 1 });
    assert.equal(r.status, 400, `Expected 400 for missing entityType, got ${r.status}`);
  });
});

test("DV-5: GET /v1/activity/summary?range=daily — returns correct shape", async () => {
  const app = buildApp({ role: "super_admin" });
  await withServer(app, async (s) => {
    const r = await sendReq(s, "GET", "/api/v1/activity/summary?range=daily");
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const b = r.body;
    assert.equal(b.range, "daily");
    assert.ok(typeof b.leadsViewed === "number", "leadsViewed must be a number");
    assert.ok(typeof b.studentsViewed === "number", "studentsViewed must be a number");
    assert.ok(typeof b.applicationsViewed === "number", "applicationsViewed must be a number");
    assert.ok(typeof b.messagesViewed === "number", "messagesViewed must be a number");
    assert.ok(typeof b.activeDurationSeconds === "number", "activeDurationSeconds must be a number");
    assert.ok(typeof b.idleDurationSeconds === "number", "idleDurationSeconds must be a number");
    assert.ok(typeof b.totalDurationSeconds === "number", "totalDurationSeconds must be a number");
    assert.ok(b.leadsViewed >= 0, "leadsViewed must be >= 0");
    assert.ok(b.activeDurationSeconds >= 0, "activeDurationSeconds must be >= 0");
  });
});
