/**
 * Portal Program Mapping API — regression tests (FAZ 1).
 *
 * M1  GET mapping (admin) → 200, default-empty shape for a fresh university
 * M2  PUT replace programOverrides → GET reflects the new object exactly
 * M3  PUT with empty programOverrides → 200, GET returns {}
 * M4  RBAC — non-admin role (staff) → 403 on GET and PUT
 * M5  unknown university key → 404 on GET and PUT
 *
 * NOTE: the live program-options endpoint drives a headless browser and is NOT
 * exercised here (no portal network in CI); it is covered manually.
 *
 * Run:
 *   pnpm --filter @workspace/api-server run test:portal-mapping
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  portalUniversitiesTable,
  portalProgramMappingTable,
  portalProgramCacheTable,
} from "@workspace/db";
import portalAutomationRouter from "../src/routes/portalAutomation.js";

// ---------------------------------------------------------------------------
// Cleanup registry
// ---------------------------------------------------------------------------
const RUN_ID = `pm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const TEST_UNI_KEY = `test_uni_${RUN_ID}`;
const cleanupUniIds: number[] = [];

after(async () => {
  await db
    .delete(portalProgramMappingTable)
    .where(eq(portalProgramMappingTable.universityKey, TEST_UNI_KEY))
    .catch(() => {});
  await db
    .delete(portalProgramCacheTable)
    .where(eq(portalProgramCacheTable.universityKey, TEST_UNI_KEY))
    .catch(() => {});
  for (const id of cleanupUniIds) {
    await db
      .delete(portalUniversitiesTable)
      .where(eq(portalUniversitiesTable.id, id))
      .catch(() => {});
  }
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

// ---------------------------------------------------------------------------
// Auth stub — role is swapped per test via currentUser
// ---------------------------------------------------------------------------
let currentUser: { id: number; role: string; isActive: boolean; emailVerified?: boolean } = {
  id: 1,
  role: "super_admin",
  isActive: true,
  emailVerified: true,
};

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { ...currentUser };
    if (!("cookies" in req)) (req as any).cookies = {};
    next();
  });
  app.use("/api", portalAutomationRouter);
  return app;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
function sendReq(
  server: http.Server,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const json = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(json !== undefined ? { "Content-Length": Buffer.byteLength(json) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: raw }); }
        });
      },
    );
    req.on("error", reject);
    if (json !== undefined) req.write(json);
    req.end();
  });
}

function listen(app: Express): Promise<http.Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
}

// ---------------------------------------------------------------------------
// Seed: a test portal university
// ---------------------------------------------------------------------------
async function ensureTestUniversity(): Promise<void> {
  const [u] = await db
    .insert(portalUniversitiesTable)
    .values({
      universityKey: TEST_UNI_KEY,
      universityName: `Test University ${RUN_ID}`,
      adapterKey: "topkapi",
      isActive: true,
    })
    .returning({ id: portalUniversitiesTable.id });
  cleanupUniIds.push(u.id);
}

// ---------------------------------------------------------------------------
// M1 — GET mapping for a fresh university returns default-empty shape
// ---------------------------------------------------------------------------
test("M1: GET mapping returns default-empty shape for a fresh university", async () => {
  await ensureTestUniversity();
  currentUser = { id: 1, role: "super_admin", isActive: true, emailVerified: true };
  const server = await listen(buildApp());
  try {
    const res = await sendReq(
      server,
      "GET",
      `/api/portal-automation/universities/${TEST_UNI_KEY}/mapping`,
    );
    assert.equal(res.status, 200, `Expected 200 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.universityKey, TEST_UNI_KEY);
    assert.deepEqual(res.body.programOverrides, {});
    assert.ok(Array.isArray(res.body.synonyms), "synonyms must be an array");
    assert.deepEqual(res.body.countryOverrides, {});
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// M2 — PUT replaces programOverrides; GET reflects it exactly
// ---------------------------------------------------------------------------
test("M2: PUT replaces programOverrides and GET reflects it", async () => {
  currentUser = { id: 1, role: "super_admin", isActive: true, emailVerified: true };
  const server = await listen(buildApp());
  try {
    const first = { "9338": "166", "9303": "111" };
    const put1 = await sendReq(
      server,
      "PUT",
      `/api/portal-automation/universities/${TEST_UNI_KEY}/mapping`,
      { programOverrides: first },
    );
    assert.equal(put1.status, 200, `Expected 200 got ${put1.status}: ${JSON.stringify(put1.body)}`);
    assert.deepEqual(put1.body.programOverrides, first);

    const get1 = await sendReq(
      server,
      "GET",
      `/api/portal-automation/universities/${TEST_UNI_KEY}/mapping`,
    );
    assert.deepEqual(get1.body.programOverrides, first);

    // Replace wholesale — old keys must be gone.
    const second = { "13607": "107" };
    const put2 = await sendReq(
      server,
      "PUT",
      `/api/portal-automation/universities/${TEST_UNI_KEY}/mapping`,
      { programOverrides: second },
    );
    assert.equal(put2.status, 200);
    assert.deepEqual(put2.body.programOverrides, second);

    const get2 = await sendReq(
      server,
      "GET",
      `/api/portal-automation/universities/${TEST_UNI_KEY}/mapping`,
    );
    assert.deepEqual(get2.body.programOverrides, second, "PUT must replace, not merge");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// M3 — PUT with empty programOverrides is accepted, GET returns {}
// ---------------------------------------------------------------------------
test("M3: PUT empty programOverrides clears the map", async () => {
  currentUser = { id: 1, role: "super_admin", isActive: true, emailVerified: true };
  const server = await listen(buildApp());
  try {
    const put = await sendReq(
      server,
      "PUT",
      `/api/portal-automation/universities/${TEST_UNI_KEY}/mapping`,
      { programOverrides: {} },
    );
    assert.equal(put.status, 200, `Expected 200 got ${put.status}: ${JSON.stringify(put.body)}`);
    assert.deepEqual(put.body.programOverrides, {});

    const get = await sendReq(
      server,
      "GET",
      `/api/portal-automation/universities/${TEST_UNI_KEY}/mapping`,
    );
    assert.deepEqual(get.body.programOverrides, {});
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// M4 — RBAC: non-admin (staff) is rejected on GET and PUT
// ---------------------------------------------------------------------------
test("M4: non-admin role is forbidden on GET and PUT", async () => {
  currentUser = { id: 2, role: "staff", isActive: true, emailVerified: true };
  const server = await listen(buildApp());
  try {
    const get = await sendReq(
      server,
      "GET",
      `/api/portal-automation/universities/${TEST_UNI_KEY}/mapping`,
    );
    assert.equal(get.status, 403, `Expected 403 got ${get.status}: ${JSON.stringify(get.body)}`);

    const put = await sendReq(
      server,
      "PUT",
      `/api/portal-automation/universities/${TEST_UNI_KEY}/mapping`,
      { programOverrides: { "1": "2" } },
    );
    assert.equal(put.status, 403, `Expected 403 got ${put.status}: ${JSON.stringify(put.body)}`);

    // Program-options endpoint is admin-only too.
    const opts = await sendReq(
      server,
      "GET",
      `/api/portal-automation/universities/${TEST_UNI_KEY}/program-options`,
    );
    assert.equal(opts.status, 403, `Expected 403 got ${opts.status}: ${JSON.stringify(opts.body)}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// M5 — unknown university key → 404 on GET and PUT
// ---------------------------------------------------------------------------
test("M5: unknown university key returns 404", async () => {
  currentUser = { id: 1, role: "super_admin", isActive: true, emailVerified: true };
  const server = await listen(buildApp());
  try {
    const unknown = `nope_${RUN_ID}`;
    const get = await sendReq(
      server,
      "GET",
      `/api/portal-automation/universities/${unknown}/mapping`,
    );
    assert.equal(get.status, 404, `Expected 404 got ${get.status}: ${JSON.stringify(get.body)}`);
    assert.equal(get.body.error, "UNIVERSITY_NOT_FOUND");

    const put = await sendReq(
      server,
      "PUT",
      `/api/portal-automation/universities/${unknown}/mapping`,
      { programOverrides: {} },
    );
    assert.equal(put.status, 404, `Expected 404 got ${put.status}: ${JSON.stringify(put.body)}`);
    assert.equal(put.body.error, "UNIVERSITY_NOT_FOUND");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// M6 — program-options served from cache (no live portal fetch)
// ---------------------------------------------------------------------------
test("M6: program-options returns fresh cache without a live fetch", async () => {
  currentUser = { id: 1, role: "super_admin", isActive: true, emailVerified: true };
  const seeded = [
    { v: "166", t: "Computer Engineering" },
    { v: "111", t: "Business Administration" },
  ];
  // Seed a fresh cache row for the default (empty) level.
  await db
    .insert(portalProgramCacheTable)
    .values({ universityKey: TEST_UNI_KEY, level: "", options: seeded, fetchedAt: new Date() })
    .onConflictDoUpdate({
      target: [portalProgramCacheTable.universityKey, portalProgramCacheTable.level],
      set: { options: seeded, fetchedAt: new Date() },
    });

  const server = await listen(buildApp());
  try {
    const res = await sendReq(
      server,
      "GET",
      `/api/portal-automation/universities/${TEST_UNI_KEY}/program-options`,
    );
    assert.equal(res.status, 200, `Expected 200 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.cached, true, "fresh cache must be served as cached");
    assert.equal(res.body.stale, false);
    assert.deepEqual(res.body.options, seeded);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// M7 — program-options unknown university key → 404
// ---------------------------------------------------------------------------
test("M7: program-options unknown university key returns 404", async () => {
  currentUser = { id: 1, role: "super_admin", isActive: true, emailVerified: true };
  const server = await listen(buildApp());
  try {
    const res = await sendReq(
      server,
      "GET",
      `/api/portal-automation/universities/nope_${RUN_ID}/program-options`,
    );
    assert.equal(res.status, 404, `Expected 404 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "UNIVERSITY_NOT_FOUND");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
