/**
 * Student Photo Endpoint — regression tests (photo-doc-avatar bug).
 *
 * SP-1  No photo document for student → 404.
 * SP-2  Photo doc with valid http fileUrl and no fileKey → 302 + Location header.
 * SP-3  Photo doc with invalid (data:) fileUrl → 422.
 * SP-4  Photo doc with deleted record (deletedAt set) → 404 (soft-deleted ignored).
 * SP-5  Photo doc with type "photograph" (alias) → also resolved (302 redirect).
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:student-photo
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import { db, studentsTable, documentsTable } from "@workspace/db";

import studentsRouter from "../src/routes/students.js";
import { recomputeStudentPhoto } from "../src/lib/studentPhoto.js";

after(() => {
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

const RUN_ID = `sp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

let currentUser: { id: number; role: string; isActive: boolean } = {
  id: 1,
  role: "super_admin",
  isActive: true,
};

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = currentUser;
    if (!("cookies" in req)) (req as any).cookies = {};
    next();
  });
  app.use("/api", studentsRouter);
  return app;
}

const app = buildApp();

function apiReq(
  method: "GET",
  path: string,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const opts: http.RequestOptions = {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers: { "Content-Type": "application/json", ...extraHeaders },
      };
      const req = http.request(opts, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          server.close();
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(data), headers: res.headers });
          } catch {
            resolve({ status: res.statusCode!, body: data, headers: res.headers });
          }
        });
      });
      req.on("error", (err) => { server.close(); reject(err); });
      req.end();
    });
    server.on("error", reject);
  });
}

// ── DB fixtures ──────────────────────────────────────────────────────────────

let studentId = 0;
let docIds: number[] = [];

async function setup() {
  const [student] = await db
    .insert(studentsTable)
    .values({ firstName: "Photo", lastName: `Test_${RUN_ID}`, email: `phototest_${RUN_ID}@test.invalid` })
    .returning({ id: studentsTable.id });
  studentId = student.id;
}

async function teardown() {
  if (docIds.length) await db.delete(documentsTable).where(eq(documentsTable.studentId, studentId));
  if (studentId) await db.delete(studentsTable).where(eq(studentsTable.id, studentId));
}

async function insertDoc(overrides: Partial<{
  type: string;
  fileKey: string | null;
  fileData: string | null;
  fileUrl: string | null;
  mimeType: string | null;
  deletedAt: Date | null;
  createdAt: Date;
}> = {}) {
  const [doc] = await db
    .insert(documentsTable)
    .values({
      studentId,
      name: `Photo_${RUN_ID}`,
      type: overrides.type ?? "photo",
      status: "pending",
      fileKey: overrides.fileKey ?? null,
      fileData: overrides.fileData ?? null,
      fileUrl: overrides.fileUrl ?? null,
      mimeType: overrides.mimeType ?? null,
      deletedAt: overrides.deletedAt ?? null,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    })
    .returning({ id: documentsTable.id });
  docIds.push(doc.id);
  return doc.id;
}

async function readFlags() {
  const [s] = await db
    .select({ hasPhoto: studentsTable.hasPhoto, photoUrl: studentsTable.photoUrl })
    .from(studentsTable)
    .where(eq(studentsTable.id, studentId));
  return s;
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("SP-1: no photo document → 404", async () => {
  await setup();
  try {
    const r = await apiReq("GET", `/api/students/${studentId}/photo`);
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "No photo");
  } finally {
    await teardown();
  }
});

test("SP-2: photo doc with valid http fileUrl → 302 redirect", async () => {
  await setup();
  try {
    const photoUrl = "https://example.com/student-photo.jpg";
    await insertDoc({ fileUrl: photoUrl, mimeType: "image/jpeg" });

    const r = await apiReq("GET", `/api/students/${studentId}/photo`);
    assert.equal(r.status, 302, `expected 302 got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.headers.location, photoUrl);
  } finally {
    await teardown();
  }
});

test("SP-3: photo doc with data: fileUrl → 422 (SSRF guard)", async () => {
  await setup();
  try {
    await insertDoc({ fileUrl: "data:image/jpeg;base64,/9j/ABC123", mimeType: "image/jpeg" });

    const r = await apiReq("GET", `/api/students/${studentId}/photo`);
    assert.equal(r.status, 422, `expected 422 got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.error, "should have error message");
  } finally {
    await teardown();
  }
});

test("SP-4: soft-deleted photo doc ignored → 404", async () => {
  await setup();
  try {
    await insertDoc({ fileUrl: "https://example.com/photo.jpg", deletedAt: new Date() });

    const r = await apiReq("GET", `/api/students/${studentId}/photo`);
    assert.equal(r.status, 404, `expected 404 got ${r.status}: ${JSON.stringify(r.body)}`);
  } finally {
    await teardown();
  }
});

test("SP-5: type=photograph alias also resolves → 302", async () => {
  await setup();
  try {
    const photoUrl = "https://cdn.example.com/img/photograph.png";
    await insertDoc({ type: "photograph", fileUrl: photoUrl, mimeType: "image/png" });

    const r = await apiReq("GET", `/api/students/${studentId}/photo`);
    assert.equal(r.status, 302, `expected 302 got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.headers.location, photoUrl);
  } finally {
    await teardown();
  }
});

// ── recomputeStudentPhoto — denormalized has_photo/photo_url sync ─────────────
// Guards the self-healing helper that every write path (upload, delete,
// public-apply, embed, lead-convert/merge) calls. Must mirror the endpoint:
// latest doc only, servable = fileKey || fileData || http(s) fileUrl.

test("SP-6: recompute sets has_photo=true + photo_url for an http fileUrl photo", async () => {
  await setup();
  try {
    await insertDoc({ fileUrl: "https://example.com/p.jpg", mimeType: "image/jpeg" });
    await recomputeStudentPhoto(studentId);
    const f = await readFlags();
    assert.equal(f.hasPhoto, true);
    assert.equal(f.photoUrl, `/api/students/${studentId}/photo`);
  } finally {
    await teardown();
  }
});

test("SP-7: recompute sets has_photo=true for a fileData-only photo (legacy upload)", async () => {
  await setup();
  try {
    await insertDoc({ fileData: "/9j/ABCfakebase64", mimeType: "image/jpeg" });
    await recomputeStudentPhoto(studentId);
    const f = await readFlags();
    assert.equal(f.hasPhoto, true);
    assert.equal(f.photoUrl, `/api/students/${studentId}/photo`);
  } finally {
    await teardown();
  }
});

test("SP-8: recompute leaves has_photo=false for a data:-only fileUrl (endpoint 422s)", async () => {
  await setup();
  try {
    await insertDoc({ fileUrl: "data:image/jpeg;base64,/9j/ABC", mimeType: "image/jpeg" });
    await recomputeStudentPhoto(studentId);
    const f = await readFlags();
    assert.equal(f.hasPhoto, false);
    assert.equal(f.photoUrl, null);
  } finally {
    await teardown();
  }
});

test("SP-9: recompute follows LATEST doc — newer unservable data: hides older http photo", async () => {
  await setup();
  try {
    await insertDoc({ fileUrl: "https://example.com/old.jpg", createdAt: new Date(Date.now() - 60_000) });
    await insertDoc({ fileUrl: "data:image/jpeg;base64,/9j/NEW", createdAt: new Date() });
    await recomputeStudentPhoto(studentId);
    const f = await readFlags();
    // Endpoint serves only the latest doc, which is the unservable data: URI.
    assert.equal(f.hasPhoto, false);
    assert.equal(f.photoUrl, null);
  } finally {
    await teardown();
  }
});
