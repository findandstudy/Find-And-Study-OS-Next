/**
 * Finance Sprint Faz 3 — regression tests.
 *
 * F3-1  POST /commissions with staffUserId + staffCommissionAmount
 *        persists both fields and returns them on the created row.
 *
 * F3-2  GET /finance/student-search
 *        • q shorter than 2 chars → empty data array
 *        • q matches a seeded student → row with id/name/email
 *
 * F3-3  GET /finance/student-applications/:studentId
 *        • valid studentId → array (may be empty, no crash)
 *        • NaN studentId  → empty array, 200
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:finance-faz3
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express } from "express";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  studentsTable,
  applicationsTable,
  commissionsTable,
} from "@workspace/db";

import financeRouter from "../src/routes/finance.js";

after(() => {
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

const RUN_ID = `faz3_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const SEASON = `2099-FAZ3-${RUN_ID}`;

// ---------------------------------------------------------------------------
// Auth stub
// ---------------------------------------------------------------------------
let currentUser: { id: number; role: string; isActive: boolean; branchId?: number | null } =
  { id: 0, role: "super_admin", isActive: true };

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = currentUser;
    if (!("cookies" in req)) (req as any).cookies = {};
    next();
  });
  app.use("/api", financeRouter);
  return app;
}

function sendReq(
  server: http.Server,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const json = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(json ? { "Content-Length": Buffer.byteLength(json) } : {}),
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
    if (json) req.write(json);
    req.end();
  });
}

async function withServer(app: Express, fn: (s: http.Server) => Promise<void>): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try { await fn(server); }
  finally { server.close(); }
}

// ---------------------------------------------------------------------------
// Cleanup tracking
// ---------------------------------------------------------------------------
const createdCommissionIds: number[] = [];
const createdStudentIds: number[] = [];
const createdApplicationIds: number[] = [];
const createdUserIds: number[] = [];

after(async () => {
  if (createdApplicationIds.length > 0)
    await db.delete(applicationsTable).where(inArray(applicationsTable.id, createdApplicationIds));
  if (createdStudentIds.length > 0)
    await db.delete(studentsTable).where(inArray(studentsTable.id, createdStudentIds));
  if (createdCommissionIds.length > 0)
    await db.delete(commissionsTable).where(inArray(commissionsTable.id, createdCommissionIds));
  if (createdUserIds.length > 0)
    await db.delete(usersTable).where(inArray(usersTable.id, createdUserIds));
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------
async function seedStaffUser() {
  const [u] = await db.insert(usersTable).values({
    email: `staff_faz3_${RUN_ID}@test.local`,
    passwordHash: "x",
    role: "staff",
    firstName: "StaffFaz3",
    lastName: RUN_ID,
    isActive: true,
    isEmailVerified: true,
  } as any).returning({ id: usersTable.id });
  createdUserIds.push(u.id);
  return u.id;
}

async function seedStudent(suffix: string) {
  const [s] = await db.insert(studentsTable).values({
    firstName: `SearchStudent${suffix}`,
    lastName: RUN_ID,
    email: `srchstud_${suffix}_${RUN_ID}@test.local`,
  } as any).returning({ id: studentsTable.id });
  createdStudentIds.push(s.id);
  return s.id;
}

async function seedApplication(studentId: number) {
  const [a] = await db.insert(applicationsTable).values({
    studentId,
    season: SEASON,
    stage: "inquiry",
    universityName: `TestUni_${RUN_ID}`,
    programName: `TestProg_${RUN_ID}`,
  } as any).returning({ id: applicationsTable.id });
  createdApplicationIds.push(a.id);
  return a.id;
}

// ---------------------------------------------------------------------------
// F3-1: POST /commissions persists staffUserId + staffCommissionAmount
// ---------------------------------------------------------------------------
test("F3-1: POST /commissions with staffUserId+staffCommissionAmount saves both fields", async () => {
  const staffId = await seedStaffUser();

  const payload = {
    season: SEASON,
    status: "potential",
    studentName: `FAZ3_Student_${RUN_ID}`,
    universityName: `FAZ3_Uni_${RUN_ID}`,
    currency: "USD",
    universityCommissionAmount: 1000,
    agentCommissionAmount: 200,
    staffUserId: staffId,
    staffCommissionAmount: 75.5,
    staffCommissionCurrency: "USD",
  };

  const app = buildApp();
  await withServer(app, async (server) => {
    const r = await sendReq(server, "POST", "/api/commissions", payload);
    assert.equal(r.status, 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);

    const row = r.body;
    assert.ok(row && typeof row === "object" && !Array.isArray(row), "Response must be the created commission object");
    assert.ok(row.id, "Created row must have id");
    createdCommissionIds.push(row.id);

    assert.equal(
      row.staffUserId,
      staffId,
      `staffUserId mismatch: expected ${staffId}, got ${row.staffUserId}`,
    );

    const saved = parseFloat(row.staffCommissionAmount ?? "0");
    assert.ok(
      Math.abs(saved - 75.5) < 0.01,
      `staffCommissionAmount expected ~75.5, got ${row.staffCommissionAmount}`,
    );

    assert.equal(
      row.staffCommissionCurrency,
      "USD",
      `staffCommissionCurrency mismatch: got ${row.staffCommissionCurrency}`,
    );
  });
});

// ---------------------------------------------------------------------------
// F3-2a: GET /finance/student-search with q shorter than 2 chars → empty
// ---------------------------------------------------------------------------
test("F3-2a: GET /finance/student-search with q='a' returns empty data array (min-length guard)", async () => {
  const app = buildApp();
  await withServer(app, async (server) => {
    const r = await sendReq(server, "GET", "/api/finance/student-search?q=a");
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const data = r.body?.data;
    assert.ok(Array.isArray(data), "Response.data must be an array");
    assert.equal(data.length, 0, `Expected empty array for q shorter than 2, got ${data.length} rows`);
  });
});

// ---------------------------------------------------------------------------
// F3-2b: GET /finance/student-search with q matching seeded student → row returned
// ---------------------------------------------------------------------------
test("F3-2b: GET /finance/student-search returns seeded student by name fragment", async () => {
  const studentId = await seedStudent("Alpha");
  const uniqueFragment = `SearchStudentAlpha ${RUN_ID}`;

  const app = buildApp();
  await withServer(app, async (server) => {
    const r = await sendReq(server, "GET", `/api/finance/student-search?q=${encodeURIComponent(uniqueFragment)}`);
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const data: any[] = r.body?.data ?? [];
    assert.ok(Array.isArray(data), "Response.data must be an array");

    const found = data.find((d) => d.id === studentId);
    assert.ok(found, `Seeded student (id=${studentId}) not found in results; got ids: ${data.map((d: any) => d.id).join(",")}`);

    assert.ok("id" in found, "Row must have id");
    assert.ok("name" in found, "Row must have name");
    assert.ok("email" in found, "Row must have email");
  });
});

// ---------------------------------------------------------------------------
// F3-2c: GET /finance/student-search by email fragment
// ---------------------------------------------------------------------------
test("F3-2c: GET /finance/student-search returns seeded student by email fragment", async () => {
  const studentId = await seedStudent("Beta");
  const emailFragment = `srchstud_Beta_${RUN_ID}`;

  const app = buildApp();
  await withServer(app, async (server) => {
    const r = await sendReq(server, "GET", `/api/finance/student-search?q=${encodeURIComponent(emailFragment)}`);
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const data: any[] = r.body?.data ?? [];
    const found = data.find((d: any) => d.id === studentId);
    assert.ok(found, `Seeded student by email not found; got ids: ${data.map((d: any) => d.id).join(",")}`);
  });
});

// ---------------------------------------------------------------------------
// F3-3a: GET /finance/student-applications/:studentId → returns app list
// ---------------------------------------------------------------------------
test("F3-3a: GET /finance/student-applications/:studentId returns applications for seeded student", async () => {
  const studentId = await seedStudent("Gamma");
  const appId = await seedApplication(studentId);

  const app = buildApp();
  await withServer(app, async (server) => {
    const r = await sendReq(server, "GET", `/api/finance/student-applications/${studentId}`);
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const data: any[] = r.body?.data ?? [];
    assert.ok(Array.isArray(data), "Response.data must be an array");

    const found = data.find((d: any) => d.id === appId);
    assert.ok(found, `Seeded application (id=${appId}) not found in results; got ids: ${data.map((d: any) => d.id).join(",")}`);

    assert.ok("id" in found, "App row must have id");
    assert.ok("universityName" in found, "App row must have universityName");
    assert.ok("stage" in found, "App row must have stage");
    assert.ok("season" in found, "App row must have season");
  });
});

// ---------------------------------------------------------------------------
// F3-3b: GET /finance/student-applications/NaN → 200 + empty array
// ---------------------------------------------------------------------------
test("F3-3b: GET /finance/student-applications/notanumber returns 200 with empty array", async () => {
  const app = buildApp();
  await withServer(app, async (server) => {
    const r = await sendReq(server, "GET", "/api/finance/student-applications/notanumber");
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const data = r.body?.data;
    assert.ok(Array.isArray(data), "Response.data must be an array");
    assert.equal(data.length, 0, `Expected empty array for NaN studentId, got ${data.length}`);
  });
});

// ---------------------------------------------------------------------------
// F3-4: Net Income formula — summary deducts staffCommissionAmount
//        totalNetAgency = uni − agent − subAgent − staff  (confirmed rows only)
//        1200 − 300 − 80 − 120 = 700
// ---------------------------------------------------------------------------
test("F3-4: GET /commissions summary.byCurrency.totalNetAgency deducts staffCommissionAmount", async () => {
  const NI_SEASON = `${SEASON}-ni`;
  const [row] = await db.insert(commissionsTable).values({
    season: NI_SEASON,
    status: "confirmed",
    studentName: `NI_Student_${RUN_ID}`,
    universityName: `NI_Uni_${RUN_ID}`,
    universityCommissionAmount: "1200.00",
    agentCommissionAmount: "300.00",
    subAgentCommissionAmount: "80.00",
    staffCommissionAmount: "120.00",
    currency: "USD",
  } as any).returning({ id: commissionsTable.id });
  createdCommissionIds.push(row.id);

  const app = buildApp();
  await withServer(app, async (server) => {
    const r = await sendReq(server, "GET", `/api/commissions?season=${encodeURIComponent(NI_SEASON)}&limit=50`);
    assert.equal(r.status, 200);
    const byCurrency: Record<string, any> = r.body?.summary?.byCurrency ?? {};
    const usd = byCurrency["USD"];
    assert.ok(usd, `No USD bucket; got keys: ${Object.keys(byCurrency).join(",")}`);
    const net = parseFloat(usd.totalNetAgency ?? "NaN");
    assert.ok(!isNaN(net), `totalNetAgency is NaN: ${usd.totalNetAgency}`);
    assert.equal(net, 700,
      `Net Income wrong: got ${net}, expected 700 (1200−300−80−120; staff must be deducted)`);
  });
});

// ---------------------------------------------------------------------------
// F3-5: Student → application chain
//        Search for student by name → get their applications → shape check
// ---------------------------------------------------------------------------
test("F3-5: student-search then student-applications chain returns consistent studentId", async () => {
  const studentId = await seedStudent("Delta");
  const appId = await seedApplication(studentId);
  const fragment = `SearchStudentDelta ${RUN_ID}`;

  const app = buildApp();
  await withServer(app, async (server) => {
    // Step 1: search
    const search = await sendReq(server, "GET", `/api/finance/student-search?q=${encodeURIComponent(fragment)}`);
    assert.equal(search.status, 200, `search step: expected 200, got ${search.status}`);
    const students: any[] = search.body?.data ?? [];
    const found = students.find((s: any) => s.id === studentId);
    assert.ok(found, `Student (id=${studentId}) not found in search results`);
    assert.ok(found.name, "Student row must have non-empty name");
    assert.ok("email" in found, "Student row must have email field");

    // Step 2: get applications for that student
    const apps = await sendReq(server, "GET", `/api/finance/student-applications/${found.id}`);
    assert.equal(apps.status, 200, `apps step: expected 200, got ${apps.status}`);
    const appList: any[] = apps.body?.data ?? [];
    const foundApp = appList.find((a: any) => a.id === appId);
    assert.ok(foundApp, `Application (id=${appId}) not found for student ${found.id}`);
    assert.ok(foundApp.universityName, "App row must have universityName");
    assert.ok(foundApp.stage, "App row must have stage");
    assert.ok(foundApp.season, "App row must have season");
  });
});
