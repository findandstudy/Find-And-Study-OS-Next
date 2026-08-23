/**
 * Portal University Exclusions API — regression tests (Phase 2).
 *
 * E1  POST create → 201, serialized shape (enabled defaults true)
 * E2  GET list by universityKey → includes the created rule
 * E3  POST duplicate (same universityKey + nationality, case-insensitive) → 409
 * E4  PATCH update agency/note + toggle enabled → 200
 * E5  RBAC — non-admin role (agent) → 403 on GET/POST/PATCH/DELETE
 * E6  DELETE soft-delete → 200, then GET omits it; same nationality recreatable
 * E7  GET nationality-suggestions → 200 array
 *
 * Run:
 *   pnpm --filter @workspace/api-server exec tsx scripts/test-university-exclusions.ts
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import { db, portalUniversityExclusionsTable } from "@workspace/db";
import exclusionsRouter from "../src/routes/portalUniversityExclusions.js";

// ---------------------------------------------------------------------------
// Cleanup registry
// ---------------------------------------------------------------------------
const RUN_ID = `ux_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const TEST_UNI_KEY = `test_uni_${RUN_ID}`;
const NATIONALITY = `Testland_${RUN_ID}`;

after(async () => {
  await db
    .delete(portalUniversityExclusionsTable)
    .where(eq(portalUniversityExclusionsTable.universityKey, TEST_UNI_KEY))
    .catch(() => {});
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

// ---------------------------------------------------------------------------
// Auth stub — role swapped per test via currentUser
// ---------------------------------------------------------------------------
let currentUser: {
  id: number;
  role: string;
  isActive: boolean;
  emailVerified?: boolean;
} = { id: 1, role: "super_admin", isActive: true, emailVerified: true };

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { ...currentUser };
    if (!("cookies" in req)) (req as any).cookies = {};
    next();
  });
  app.use("/api", exclusionsRouter);
  return app;
}

function sendReq(
  server: http.Server,
  method: "GET" | "POST" | "PATCH" | "DELETE",
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
          ...(json !== undefined
            ? { "Content-Length": Buffer.byteLength(json) }
            : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => {
          raw += c;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: raw });
          }
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

const admin = () => {
  currentUser = { id: 1, role: "super_admin", isActive: true, emailVerified: true };
};
const agent = () => {
  currentUser = { id: 2, role: "agent", isActive: true, emailVerified: true };
};

let createdId = 0;

// ---------------------------------------------------------------------------
// E1 — POST create
// ---------------------------------------------------------------------------
test("E1: POST create returns 201 with enabled default true", async () => {
  admin();
  const server = await listen(buildApp());
  try {
    const res = await sendReq(server, "POST", "/api/portal-automation/university-exclusions", {
      universityKey: TEST_UNI_KEY,
      nationality: NATIONALITY,
      agencyName: "Acme Agency",
      note: "phase-2 test",
    });
    assert.equal(res.status, 201, `Expected 201 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.universityKey, TEST_UNI_KEY);
    assert.equal(res.body.nationality, NATIONALITY);
    assert.equal(res.body.agencyName, "Acme Agency");
    assert.equal(res.body.note, "phase-2 test");
    assert.equal(res.body.enabled, true);
    createdId = res.body.id;
    assert.ok(createdId > 0, "created id must be positive");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// E2 — GET list
// ---------------------------------------------------------------------------
test("E2: GET list by universityKey includes the rule", async () => {
  admin();
  const server = await listen(buildApp());
  try {
    const res = await sendReq(
      server,
      "GET",
      `/api/portal-automation/university-exclusions?universityKey=${TEST_UNI_KEY}`,
    );
    assert.equal(res.status, 200, `Expected 200 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(Array.isArray(res.body), "list response must be an array");
    const found = res.body.find((r: any) => r.id === createdId);
    assert.ok(found, "created rule must appear in the list");
    assert.equal(found.nationality, NATIONALITY);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// E3 — duplicate nationality (case-insensitive) → 409
// ---------------------------------------------------------------------------
test("E3: POST duplicate nationality returns 409 DUPLICATE_NATIONALITY", async () => {
  admin();
  const server = await listen(buildApp());
  try {
    const res = await sendReq(server, "POST", "/api/portal-automation/university-exclusions", {
      universityKey: TEST_UNI_KEY,
      nationality: NATIONALITY.toUpperCase(),
    });
    assert.equal(res.status, 409, `Expected 409 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "DUPLICATE_NATIONALITY");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// E4 — PATCH update + toggle
// ---------------------------------------------------------------------------
test("E4: PATCH updates agency/note and toggles enabled", async () => {
  admin();
  const server = await listen(buildApp());
  try {
    const res = await sendReq(
      server,
      "PATCH",
      `/api/portal-automation/university-exclusions/${createdId}`,
      { agencyName: "Beta Agency", note: null, enabled: false },
    );
    assert.equal(res.status, 200, `Expected 200 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.agencyName, "Beta Agency");
    assert.equal(res.body.note, null);
    assert.equal(res.body.enabled, false);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// E5 — RBAC: non-admin → 403
// ---------------------------------------------------------------------------
test("E5: non-admin role is denied on every verb", async () => {
  agent();
  const server = await listen(buildApp());
  try {
    const get = await sendReq(
      server,
      "GET",
      `/api/portal-automation/university-exclusions?universityKey=${TEST_UNI_KEY}`,
    );
    assert.equal(get.status, 403, `GET expected 403 got ${get.status}`);

    const post = await sendReq(server, "POST", "/api/portal-automation/university-exclusions", {
      universityKey: TEST_UNI_KEY,
      nationality: `Other_${RUN_ID}`,
    });
    assert.equal(post.status, 403, `POST expected 403 got ${post.status}`);

    const patch = await sendReq(
      server,
      "PATCH",
      `/api/portal-automation/university-exclusions/${createdId}`,
      { enabled: true },
    );
    assert.equal(patch.status, 403, `PATCH expected 403 got ${patch.status}`);

    const del = await sendReq(
      server,
      "DELETE",
      `/api/portal-automation/university-exclusions/${createdId}`,
    );
    assert.equal(del.status, 403, `DELETE expected 403 got ${del.status}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// E6 — soft delete then list omits it; partial unique index frees nationality
// ---------------------------------------------------------------------------
test("E6: DELETE soft-deletes, GET omits, nationality recreatable", async () => {
  admin();
  const server = await listen(buildApp());
  try {
    const del = await sendReq(
      server,
      "DELETE",
      `/api/portal-automation/university-exclusions/${createdId}`,
    );
    assert.equal(del.status, 200, `Expected 200 got ${del.status}: ${JSON.stringify(del.body)}`);
    assert.equal(del.body.ok, true);

    const list = await sendReq(
      server,
      "GET",
      `/api/portal-automation/university-exclusions?universityKey=${TEST_UNI_KEY}`,
    );
    assert.equal(list.status, 200);
    const found = list.body.find((r: any) => r.id === createdId);
    assert.equal(found, undefined, "soft-deleted rule must not appear in the list");

    const recreate = await sendReq(server, "POST", "/api/portal-automation/university-exclusions", {
      universityKey: TEST_UNI_KEY,
      nationality: NATIONALITY,
    });
    assert.equal(recreate.status, 201, `Re-create expected 201 got ${recreate.status}: ${JSON.stringify(recreate.body)}`);
    assert.notEqual(recreate.body.id, createdId, "recreate must produce a new row id");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// E7 — nationality suggestions
// ---------------------------------------------------------------------------
test("E7: GET nationality-suggestions returns an array", async () => {
  admin();
  const server = await listen(buildApp());
  try {
    const res = await sendReq(
      server,
      "GET",
      "/api/portal-automation/university-exclusions/nationality-suggestions",
    );
    assert.equal(res.status, 200, `Expected 200 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(Array.isArray(res.body), "suggestions response must be an array");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
