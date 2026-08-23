/**
 * Student education records CRUD — route tests (FAZ 2).
 *
 * SE-1  GET on fresh student → empty records.
 * SE-2  PUT 2 records → both active, ordered.
 * SE-3  PUT again with 3 records → replace-set: old soft-deleted, new set active.
 * SE-4  Duplicate level in body → 400.
 * SE-5  Invalid level → 400.
 * SE-6  PUT empty array → clears all active records.
 * SE-7  high_school record ignores program field.
 * SE-8  Unauthorized agent (no visible students) → 403/404.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:student-education
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express } from "express";
import { eq, and, isNull } from "drizzle-orm";
import { db, studentsTable, studentEducationRecordsTable } from "@workspace/db";

import studentsRouter from "../src/routes/students.js";

after(() => {
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

const RUN_ID = `se_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

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
  method: "GET" | "PUT",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      const opts: http.RequestOptions = {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers: {
          "content-type": "application/json",
          ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}),
        },
      };
      const reqq = http.request(opts, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          server.close();
          let parsed: any = null;
          try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      });
      reqq.on("error", (e) => { server.close(); reject(e); });
      if (payload) reqq.write(payload);
      reqq.end();
    });
  });
}

let studentId: number;

before(async () => {
  const [s] = await db.insert(studentsTable).values({
    firstName: `EDU${RUN_ID}`,
    lastName: "TEST",
    email: `${RUN_ID}@example.test`,
  }).returning();
  studentId = s.id;
});

after(async () => {
  if (studentId) {
    await db.delete(studentEducationRecordsTable).where(eq(studentEducationRecordsTable.studentId, studentId));
    await db.delete(studentsTable).where(eq(studentsTable.id, studentId));
  }
});

test("SE-1 GET fresh student → empty records", async () => {
  const r = await apiReq("GET", `/api/students/${studentId}/education`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.records, []);
});

test("SE-2 PUT 2 records → active + ordered", async () => {
  const r = await apiReq("PUT", `/api/students/${studentId}/education`, {
    records: [
      { level: "high_school", institution: "HS One", graduationYear: 2018, gpa: "85" },
      { level: "bachelor", institution: "Uni One", program: "CS", graduationYear: 2022, gpa: "3.2", gpaRaw: "3.2", gpaScale: 4 },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.records.length, 2);
  assert.equal(r.body.records[0].level, "high_school");
  assert.equal(r.body.records[1].level, "bachelor");
  assert.equal(r.body.records[1].program, "CS");
});

test("SE-3 PUT replace-set: old soft-deleted, new active", async () => {
  const r = await apiReq("PUT", `/api/students/${studentId}/education`, {
    records: [
      { level: "high_school", institution: "HS Two" },
      { level: "bachelor", institution: "Uni Two", program: "EE" },
      { level: "master", institution: "Uni Three", program: "AI" },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.records.length, 3);

  const active = await db.select().from(studentEducationRecordsTable)
    .where(and(eq(studentEducationRecordsTable.studentId, studentId), isNull(studentEducationRecordsTable.deletedAt)));
  assert.equal(active.length, 3);
  assert.ok(active.every((x) => x.institution !== "HS One" && x.institution !== "Uni One"));

  const all = await db.select().from(studentEducationRecordsTable)
    .where(eq(studentEducationRecordsTable.studentId, studentId));
  assert.equal(all.length, 5); // 2 soft-deleted + 3 active

  const g = await apiReq("GET", `/api/students/${studentId}/education`);
  assert.equal(g.body.records.length, 3);
});

test("SE-4 duplicate level → 400", async () => {
  const r = await apiReq("PUT", `/api/students/${studentId}/education`, {
    records: [{ level: "bachelor" }, { level: "bachelor" }],
  });
  assert.equal(r.status, 400);
});

test("SE-5 invalid level → 400", async () => {
  const r = await apiReq("PUT", `/api/students/${studentId}/education`, {
    records: [{ level: "kindergarten" }],
  });
  assert.equal(r.status, 400);
});

test("SE-6 PUT empty array clears active set", async () => {
  const r = await apiReq("PUT", `/api/students/${studentId}/education`, { records: [] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.records, []);
  const g = await apiReq("GET", `/api/students/${studentId}/education`);
  assert.deepEqual(g.body.records, []);
});

test("SE-7 high_school ignores program", async () => {
  const r = await apiReq("PUT", `/api/students/${studentId}/education`, {
    records: [{ level: "high_school", institution: "HS X", program: "ShouldBeDropped" }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.records[0].program, null);
});

test("SE-8 agent without visibility → forbidden", async () => {
  const prev = currentUser;
  currentUser = { id: 999999, role: "agent", isActive: true };
  try {
    const r = await apiReq("PUT", `/api/students/${studentId}/education`, {
      records: [{ level: "bachelor", institution: "Nope" }],
    });
    assert.ok(r.status === 403 || r.status === 404, `expected 403/404, got ${r.status}`);
  } finally {
    currentUser = prev;
  }
});
