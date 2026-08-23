/**
 * test-portal-mgmt.ts — SUB-STEP A regression tests (TAU1–TAU7)
 *
 * TAU1: GET /portal-automation/settings — returns defaults when no row
 * TAU2: PUT /portal-automation/settings → upsert → GET returns updated values
 * TAU3: POST /portal-universities → 201, row in DB
 * TAU4: GET /portal-universities → lists created university (hasCredentials boolean)
 * TAU5: PATCH /portal-universities/:id → fields updated
 * TAU6: PATCH /portal-universities/:id/active → isActive toggled
 * TAU7: DELETE /portal-universities/:id → soft-deleted; not in active list
 *
 * Run:
 *   pnpm --filter @workspace/api-server test:portal-mgmt
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express } from "express";
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  portalAutomationSettingsTable,
  portalUniversitiesTable,
} from "@workspace/db";
import portalMgmtRouter from "../src/routes/portalMgmt.js";

// ---------------------------------------------------------------------------
// Cleanup tracking
// ---------------------------------------------------------------------------
const cleanupUniIds:      number[] = [];
let   savedSettingsId:    number | null = null;
let   savedSettingsRow:   Record<string, unknown> | null = null;

// ---------------------------------------------------------------------------
// Run-specific tag (prevents collisions between parallel runs)
// ---------------------------------------------------------------------------
const RUN = `tau_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
const TEST_KEY = `uni_${RUN}`;

// ---------------------------------------------------------------------------
// after — restore settings, clean universities
// ---------------------------------------------------------------------------
after(async () => {
  if (savedSettingsId && savedSettingsRow) {
    const r = savedSettingsRow as {
      isEnabled: boolean;
      triggerStages: string[];
      mode: "dry" | "real";
      scope: "only_applied" | "selected" | "all";
      selectedUniversityKeys: string[];
    };
    await db
      .update(portalAutomationSettingsTable)
      .set({
        isEnabled:              r.isEnabled,
        triggerStages:          r.triggerStages,
        mode:                   r.mode,
        scope:                  r.scope,
        selectedUniversityKeys: r.selectedUniversityKeys,
      })
      .where(eq(portalAutomationSettingsTable.id, savedSettingsId))
      .catch(() => {});
  }

  for (const id of cleanupUniIds) {
    await db
      .update(portalUniversitiesTable)
      .set({ deletedAt: new Date() })
      .where(and(eq(portalUniversitiesTable.id, id), isNull(portalUniversitiesTable.deletedAt)))
      .catch(() => {});
  }

  setImmediate(() => process.exit(process.exitCode ?? 0));
});

// ---------------------------------------------------------------------------
// Auth stub (super_admin to satisfy requireRole)
// ---------------------------------------------------------------------------
const MOCK_USER = { id: 1, role: "super_admin", isActive: true, emailVerified: true };

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { ...MOCK_USER };
    if (!("cookies" in req)) (req as any).cookies = {};
    next();
  });
  app.use("/api", portalMgmtRouter);
  return app;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
function sendReq(
  server: http.Server,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
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

function close(server: http.Server): Promise<void> {
  return new Promise((r) => server.close(() => r()));
}

// ---------------------------------------------------------------------------
// TAU1 — GET settings returns defaults when no row exists
// ---------------------------------------------------------------------------
test("TAU1: GET /portal-automation/settings returns defaults when table is empty", async () => {
  // Save & temporarily clear settings so we know the table state
  const [existing] = await db.select().from(portalAutomationSettingsTable).limit(1);
  if (existing) {
    savedSettingsId  = existing.id;
    savedSettingsRow = existing as Record<string, unknown>;
    // Delete so GET returns defaults
    await db.delete(portalAutomationSettingsTable).where(eq(portalAutomationSettingsTable.id, existing.id));
  }

  const app    = buildApp();
  const server = await listen(app);
  try {
    const res = await sendReq(server, "GET", "/api/portal-automation/settings");
    assert.equal(res.status, 200, `Expected 200 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.isEnabled, false);
    assert.deepEqual(res.body.triggerStages, []);
    assert.equal(res.body.mode, "dry");
    assert.equal(res.body.scope, "only_applied");
    assert.deepEqual(res.body.selectedUniversityKeys, []);
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// TAU2 — PUT settings upsert → GET returns updated
// ---------------------------------------------------------------------------
test("TAU2: PUT /portal-automation/settings upsert → GET returns updated values", async () => {
  const payload = {
    isEnabled:              true,
    triggerStages:          ["offer", "visa"],
    mode:                   "dry",
    scope:                  "selected",
    selectedUniversityKeys: ["uskudar", "istinye"],
  };

  const app    = buildApp();
  const server = await listen(app);
  try {
    const put = await sendReq(server, "PUT", "/api/portal-automation/settings", payload);
    assert.equal(put.status, 200, `PUT failed: ${JSON.stringify(put.body)}`);
    assert.ok(put.body.id, "PUT should return id");
    if (!savedSettingsId) savedSettingsId = put.body.id;

    const get = await sendReq(server, "GET", "/api/portal-automation/settings");
    assert.equal(get.status, 200);
    assert.equal(get.body.isEnabled, true);
    assert.deepEqual(get.body.triggerStages, ["offer", "visa"]);
    assert.equal(get.body.scope, "selected");
    assert.deepEqual(get.body.selectedUniversityKeys, ["uskudar", "istinye"]);

    // Second PUT (update) should update same row
    const put2 = await sendReq(server, "PUT", "/api/portal-automation/settings", {
      ...payload,
      isEnabled: false,
    });
    assert.equal(put2.status, 200);
    assert.equal(put2.body.id, get.body.id, "Should update same row, not insert new");
    assert.equal(put2.body.isEnabled, false);
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// TAU3 — POST /portal-universities → 201, row in DB
// ---------------------------------------------------------------------------
test("TAU3: POST /portal-universities creates a new university", async () => {
  const app    = buildApp();
  const server = await listen(app);
  try {
    const res = await sendReq(server, "POST", "/api/portal-universities", {
      universityKey:  TEST_KEY,
      universityName: `Haliç University ${RUN}`,
      isActive:       true,
    });
    assert.equal(res.status, 201, `Expected 201 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.universityKey, TEST_KEY);
    assert.equal(res.body.adapterKey, "halic", "adapter must be resolved from the university name");
    assert.equal(res.body.isActive, true);
    assert.ok(res.body.id, "Should return id");
    cleanupUniIds.push(res.body.id);

    // Duplicate key should be 409
    const dup = await sendReq(server, "POST", "/api/portal-universities", {
      universityKey:  TEST_KEY,
      universityName: "Another Name",
      adapterKey:     "some_adapter",
    });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, "DUPLICATE_KEY");
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// TAU4 — GET /portal-universities lists created university with hasCredentials boolean
// ---------------------------------------------------------------------------
test("TAU4: GET /portal-universities lists universities with hasCredentials boolean", async () => {
  // Ensure we have a row (TAU3 may have created it; if not, create one)
  if (cleanupUniIds.length === 0) {
    const [row] = await db
      .insert(portalUniversitiesTable)
      .values({
        universityKey:  TEST_KEY,
        universityName: `TAU Test University ${RUN}`,
        adapterKey:     `test_adapter_${RUN}`,
        isActive:       true,
      })
      .returning({ id: portalUniversitiesTable.id });
    cleanupUniIds.push(row.id);
  }

  const app    = buildApp();
  const server = await listen(app);
  try {
    const res = await sendReq(server, "GET", "/api/portal-universities?isActive=true");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data), "data should be array");

    const found = res.body.data.find((r: any) => r.universityKey === TEST_KEY);
    assert.ok(found, `University ${TEST_KEY} should appear in list`);
    assert.equal(typeof found.hasCredentials, "boolean", "hasCredentials should be boolean");

    // Must not leak any credential values
    const keys = Object.keys(found) as string[];
    const leaked = keys.filter((k) =>
      k.toLowerCase().includes("password") ||
      k.toLowerCase().includes("secret") ||
      k.toLowerCase().includes("token"),
    );
    assert.equal(leaked.length, 0, `Credential values leaked: ${leaked.join(", ")}`);

    // Search filter
    const search = await sendReq(server, "GET", `/api/portal-universities?search=${encodeURIComponent(RUN)}`);
    assert.equal(search.status, 200);
    assert.ok(
      search.body.data.some((r: any) => r.universityKey === TEST_KEY),
      "Search should find our test university",
    );
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// TAU5 — PATCH /portal-universities/:id → fields updated
// ---------------------------------------------------------------------------
test("TAU5: PATCH /portal-universities/:id updates fields", async () => {
  const uniId = cleanupUniIds[0];
  assert.ok(uniId, "Needs a created university from TAU3/TAU4");

  const app    = buildApp();
  const server = await listen(app);
  try {
    const res = await sendReq(server, "PATCH", `/api/portal-universities/${uniId}`, {
      universityName: `TAU Updated ${RUN}`,
      adapterKey:     `updated_adapter_${RUN}`,
      defaults:       { intake: "September" },
    });
    assert.equal(res.status, 200, `Expected 200 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.universityName, `TAU Updated ${RUN}`);
    assert.equal(res.body.adapterKey, `updated_adapter_${RUN}`);
    assert.deepEqual(res.body.defaults, { intake: "September" });

    // Verify no extra fields crept in (req.body guard)
    assert.ok(!res.body.password, "No password field should appear");
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// TAU6 — PATCH /portal-universities/:id/active → isActive toggled
// ---------------------------------------------------------------------------
test("TAU6: PATCH /portal-universities/:id/active toggles isActive", async () => {
  const uniId = cleanupUniIds[0];
  assert.ok(uniId, "Needs a created university");

  const app    = buildApp();
  const server = await listen(app);
  try {
    // Deactivate
    const off = await sendReq(server, "PATCH", `/api/portal-universities/${uniId}/active`, { isActive: false });
    assert.equal(off.status, 200, `Expected 200 got ${off.status}: ${JSON.stringify(off.body)}`);
    assert.equal(off.body.isActive, false);

    // Re-activate
    const on = await sendReq(server, "PATCH", `/api/portal-universities/${uniId}/active`, { isActive: true });
    assert.equal(on.status, 200);
    assert.equal(on.body.isActive, true);

    // 404 for non-existent
    const miss = await sendReq(server, "PATCH", "/api/portal-universities/999999999/active", { isActive: false });
    assert.equal(miss.status, 404);
  } finally {
    await close(server);
  }
});

// ---------------------------------------------------------------------------
// TAU7 — DELETE /portal-universities/:id → soft-deleted; not in active list
// ---------------------------------------------------------------------------
test("TAU7: DELETE /portal-universities/:id soft-deletes; not returned in list", async () => {
  // Create a dedicated row for delete test
  const [toDelete] = await db
    .insert(portalUniversitiesTable)
    .values({
      universityKey:  `${TEST_KEY}_del`,
      universityName: `TAU Delete Test ${RUN}`,
      adapterKey:     `del_adapter_${RUN}`,
      isActive:       true,
    })
    .returning({ id: portalUniversitiesTable.id });

  const app    = buildApp();
  const server = await listen(app);
  try {
    const del = await sendReq(server, "DELETE", `/api/portal-universities/${toDelete.id}`);
    assert.equal(del.status, 200, `Expected 200 got ${del.status}: ${JSON.stringify(del.body)}`);
    assert.equal(del.body.ok, true);

    // Verify not in list
    const list = await sendReq(server, "GET", "/api/portal-universities");
    assert.ok(!list.body.data.some((r: any) => r.id === toDelete.id), "Deleted row must not appear in list");

    // Second DELETE → 404
    const del2 = await sendReq(server, "DELETE", `/api/portal-universities/${toDelete.id}`);
    assert.equal(del2.status, 404);
  } finally {
    await close(server);
  }
});
