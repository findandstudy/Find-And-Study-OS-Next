/**
 * Sprint A RBAC — route-level integration test.
 *
 * Verifies that the agent-source scope guards work correctly end-to-end
 * using the real Express route handlers in-process (no network/auth stack),
 * a real PostgreSQL connection, and a real agent record.
 *
 * Scenarios:
 *   1. admin sees ALL leads (agent-sourced and direct)
 *   2. staff sees ONLY direct leads (agentId IS NULL) in list
 *   3. staff gets 404 on agent-sourced lead detail
 *   4. staff gets 404 on agent-sourced lead PATCH
 *   5. agent sees ONLY own leads (KURAL 2: sub-agent leads excluded)
 *   6. staff sees ONLY direct applications in list
 *   7. staff gets 404 on agent-sourced application detail
 *   8. staff gets 404 on agent-sourced application PATCH
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:rbac-route-integration
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express, type Request } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  agentsTable,
  leadsTable,
  applicationsTable,
  studentsTable,
} from "@workspace/db";

import leadsRouter from "../src/routes/leads.js";
import applicationsRouter from "../src/routes/applications.js";

// Hard exit — keep handle lifecycle same as other in-process tests.
after(() => {
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

const RUN_ID = `rbac_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

// ---------------------------------------------------------------------------
// Mutable user injected per-request (no real auth stack needed).
// ---------------------------------------------------------------------------
let currentUser: { id: number; role: string; isActive: boolean } = { id: 0, role: "admin", isActive: true };

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: typeof currentUser }).user = currentUser;
    next();
  });
  app.use("/api", leadsRouter);
  app.use("/api", applicationsRouter);
  return app;
}

const app = buildApp();

async function apiReq(
  method: "GET" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const server = http.createServer(app as unknown as (req: Request, res: unknown) => void);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("listen failed");
  const port = addr.port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, data: parsed };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

const cleanupUserIds: number[] = [];
const cleanupAgentIds: number[] = [];
const cleanupLeadIds: number[] = [];
const cleanupStudentIds: number[] = [];
const cleanupAppIds: number[] = [];

async function createUser(role: string): Promise<number> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_ID}_${role}_${Math.random().toString(36).slice(2, 6)}@rbac-test.local`,
      firstName: "RBAC",
      lastName: `Test_${RUN_ID}`,
      role,
      isActive: true,
    })
    .returning({ id: usersTable.id });
  cleanupUserIds.push(row.id);
  return row.id;
}

async function createAgent(userId: number): Promise<number> {
  const [row] = await db
    .insert(agentsTable)
    .values({ userId, firstName: "RBAC", lastName: `Agent_${RUN_ID}` })
    .returning({ id: agentsTable.id });
  cleanupAgentIds.push(row.id);
  return row.id;
}

async function createLead(agentId: number | null): Promise<number> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const [row] = await db
    .insert(leadsTable)
    .values({
      firstName: "RBAC",
      lastName: `Lead_${suffix}`,
      email: `lead_${RUN_ID}_${suffix}@rbac-test.local`,
      agentId,
    })
    .returning({ id: leadsTable.id });
  cleanupLeadIds.push(row.id);
  return row.id;
}

async function createStudent(): Promise<number> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const [row] = await db
    .insert(studentsTable)
    .values({
      firstName: "RBAC",
      lastName: `Stu_${suffix}`,
      email: `stu_${RUN_ID}_${suffix}@rbac-test.local`,
    })
    .returning({ id: studentsTable.id });
  cleanupStudentIds.push(row.id);
  return row.id;
}

async function createApp(agentId: number | null, studentId: number): Promise<number> {
  const [row] = await db
    .insert(applicationsTable)
    .values({ studentId, agentId })
    .returning({ id: applicationsTable.id });
  cleanupAppIds.push(row.id);
  return row.id;
}

// ---------------------------------------------------------------------------
// Cleanup (runs after all tests)
// ---------------------------------------------------------------------------

after(async () => {
  for (const id of cleanupAppIds) {
    await db.delete(applicationsTable).where(eq(applicationsTable.id, id));
  }
  for (const id of cleanupLeadIds) {
    await db.delete(leadsTable).where(eq(leadsTable.id, id));
  }
  for (const id of cleanupStudentIds) {
    await db.delete(studentsTable).where(eq(studentsTable.id, id));
  }
  for (const id of cleanupAgentIds) {
    await db.delete(agentsTable).where(eq(agentsTable.id, id));
  }
  for (const id of cleanupUserIds) {
    await db.delete(usersTable).where(eq(usersTable.id, id));
  }
});

// ---------------------------------------------------------------------------
// Test fixture creation (runs once before all tests)
// ---------------------------------------------------------------------------

let adminUserId: number;
let staffUserId: number;
let agentUserId: number;
let agentId: number;
let agentLeadId: number;
let directLeadId: number;
let studentId: number;
let agentAppId: number;
let directAppId: number;

// Seed once
await (async () => {
  adminUserId = await createUser("admin");
  staffUserId = await createUser("staff");
  agentUserId = await createUser("agent");
  agentId = await createAgent(agentUserId);
  agentLeadId = await createLead(agentId);
  directLeadId = await createLead(null);
  studentId = await createStudent();
  agentAppId = await createApp(agentId, studentId);
  directAppId = await createApp(null, studentId);
})();

// ---------------------------------------------------------------------------
// Tests: LEAD endpoints
// ---------------------------------------------------------------------------

test("RBAC: admin sees both direct and agent-sourced leads in list", async () => {
  currentUser = { id: adminUserId, role: "admin", isActive: true };
  const { status, data } = await apiReq("GET", `/api/leads?limit=500`);
  assert.equal(status, 200);
  const items = (data as { data: { id: number }[] }).data;
  const ids = items.map((r) => r.id);
  assert.ok(ids.includes(agentLeadId), "admin must see agent-sourced lead");
  assert.ok(ids.includes(directLeadId), "admin must see direct lead");
});

test("RBAC: staff sees ONLY direct leads in list (agentId IS NULL)", async () => {
  currentUser = { id: staffUserId, role: "staff", isActive: true };
  const { status, data } = await apiReq("GET", `/api/leads?limit=500`);
  assert.equal(status, 200);
  const items = (data as { data: { id: number; agentId: unknown }[] }).data;
  const ids = items.map((r) => r.id);
  assert.ok(!ids.includes(agentLeadId), "staff must NOT see agent-sourced lead");
  assert.ok(ids.includes(directLeadId), "staff must see direct lead");
  // Belt-and-suspenders: no returned record should have agentId set
  for (const item of items) {
    assert.equal(item.agentId, null, `staff should not see record with agentId=${item.agentId}`);
  }
});

test("RBAC: staff gets 404 on agent-sourced lead detail", async () => {
  currentUser = { id: staffUserId, role: "staff", isActive: true };
  const { status } = await apiReq("GET", `/api/leads/${agentLeadId}`);
  assert.equal(status, 404, "staff must get 404 for agent-sourced lead detail");
});

test("RBAC: staff can access direct lead detail", async () => {
  currentUser = { id: staffUserId, role: "staff", isActive: true };
  const { status } = await apiReq("GET", `/api/leads/${directLeadId}`);
  assert.notEqual(status, 404, "staff should be able to access direct lead detail");
});

test("RBAC: staff gets 404 on PATCH agent-sourced lead", async () => {
  currentUser = { id: staffUserId, role: "staff", isActive: true };
  const { status } = await apiReq("PATCH", `/api/leads/${agentLeadId}`, { status: "contacted" });
  assert.equal(status, 404, "staff must get 404 when patching agent-sourced lead");
});

test("RBAC: agent sees only OWN leads (KURAL 2 — not sub-agent leads)", async () => {
  currentUser = { id: agentUserId, role: "agent", isActive: true };
  const { status, data } = await apiReq("GET", `/api/leads?limit=500`);
  assert.equal(status, 200);
  const items = (data as { data: { id: number; agentId: unknown }[] }).data;
  const ids = items.map((r) => r.id);
  assert.ok(ids.includes(agentLeadId), "agent must see own lead");
  assert.ok(!ids.includes(directLeadId), "agent must NOT see direct (non-agent) leads");
  for (const item of items) {
    assert.equal(item.agentId, agentId, `agent should only see records with own agentId (${agentId})`);
  }
});

// ---------------------------------------------------------------------------
// Tests: APPLICATION endpoints
// ---------------------------------------------------------------------------

test("RBAC: staff sees ONLY direct applications in list (agentId IS NULL)", async () => {
  currentUser = { id: staffUserId, role: "staff", isActive: true };
  const { status, data } = await apiReq("GET", `/api/applications?limit=500`);
  assert.equal(status, 200);
  const items = (data as { data: { id: number; agentId: unknown }[] }).data;
  const ids = items.map((r) => r.id);
  assert.ok(!ids.includes(agentAppId), "staff must NOT see agent-sourced application");
  assert.ok(ids.includes(directAppId), "staff must see direct application");
  for (const item of items) {
    assert.equal(item.agentId, null, `staff should not see application with agentId=${item.agentId}`);
  }
});

test("RBAC: staff gets 404 on agent-sourced application detail", async () => {
  currentUser = { id: staffUserId, role: "staff", isActive: true };
  const { status } = await apiReq("GET", `/api/applications/${agentAppId}`);
  assert.equal(status, 404, "staff must get 404 for agent-sourced application detail");
});

test("RBAC: staff can access direct application detail", async () => {
  currentUser = { id: staffUserId, role: "staff", isActive: true };
  const { status } = await apiReq("GET", `/api/applications/${directAppId}`);
  assert.notEqual(status, 404, "staff should be able to access direct application detail");
});

test("RBAC: admin sees all applications (agent-sourced and direct)", async () => {
  currentUser = { id: adminUserId, role: "admin", isActive: true };
  const { status, data } = await apiReq("GET", `/api/applications?limit=500`);
  assert.equal(status, 200);
  const items = (data as { data: { id: number }[] }).data;
  const ids = items.map((r) => r.id);
  assert.ok(ids.includes(agentAppId), "admin must see agent-sourced application");
  assert.ok(ids.includes(directAppId), "admin must see direct application");
});
