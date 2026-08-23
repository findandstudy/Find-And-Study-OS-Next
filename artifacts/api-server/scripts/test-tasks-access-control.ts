/**
 * Tasks Access Control — route-level integration test (Task #472 / Faz S1).
 *
 * Verifies that GET /tasks and POST /tasks/:id/notes are restricted to
 * STAFF_ROLES and agent_staff users who have the "tasks" permission.
 *
 * Scenarios:
 *   1. student   + GET /tasks              → 403
 *   2. agent     + GET /tasks              → 403
 *   3. sub_agent + GET /tasks              → 403
 *   4. staff     + GET /tasks              → 200
 *   5. admin     + GET /tasks              → 200
 *   6. agent_staff (tasks perm)  + GET /tasks → 200
 *   7. agent_staff (no tasks)    + GET /tasks → 403
 *   8. agent     + POST /tasks/:id/notes   → 403
 *   9. staff     + POST /tasks/:id/notes   → 201
 *  10. admin     + POST /tasks/:id/notes   → 201
 *  11. agent_staff (tasks perm)  + POST /tasks/:id/notes → 201
 *  12. agent_staff (no tasks)    + POST /tasks/:id/notes → 403
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:tasks-access-control
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express, type Request } from "express";
import { eq, inArray } from "drizzle-orm";
import { db, usersTable, tasksTable } from "@workspace/db";

import tasksRouter from "../src/routes/tasks.js";

after(() => {
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

const RUN_ID = `tac_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

// ---------------------------------------------------------------------------
// Mutable user injected per-request (no real auth stack).
// ---------------------------------------------------------------------------
let currentUser: { id: number; role: string; isActive: boolean } = {
  id: 0,
  role: "admin",
  isActive: true,
};

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: typeof currentUser }).user = currentUser;
    next();
  });
  app.use("/api", tasksRouter);
  return app;
}

const app = buildApp();

async function apiReq(
  method: "GET" | "POST",
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
// Seeding helpers
// ---------------------------------------------------------------------------
const cleanupUserIds: number[] = [];
const cleanupTaskIds: number[] = [];

async function createUser(
  role: string,
  agentStaffPermissions?: string[],
): Promise<number> {
  const suffix = Math.random().toString(36).slice(2, 6);
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_ID}_${role}_${suffix}@tac-test.local`,
      firstName: "TAC",
      lastName: `Test_${RUN_ID}`,
      role,
      isActive: true,
      agentStaffPermissions: (agentStaffPermissions ?? null) as unknown as string,
    })
    .returning({ id: usersTable.id });
  cleanupUserIds.push(row.id);
  return row.id;
}

async function seedTask(createdBy: number): Promise<number> {
  const [row] = await db
    .insert(tasksTable)
    .values({
      title: `TAC test task ${RUN_ID}`,
      taskNotes: [],
      priority: "medium",
      status: "todo",
      createdBy,
    })
    .returning({ id: tasksTable.id });
  cleanupTaskIds.push(row.id);
  return row.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("Tasks Access Control", async (t) => {
  // ── Seed ──────────────────────────────────────────────────────────────────
  const studentId = await createUser("student");
  const agentId   = await createUser("agent");
  const subAgentId = await createUser("sub_agent");
  const staffId   = await createUser("staff");
  const adminId   = await createUser("admin");
  const agentStaffWithPermsId = await createUser("agent_staff", ["leads", "tasks"]);
  const agentStaffNoTasksId   = await createUser("agent_staff", ["leads"]);

  // Need a real creator for the task (staff role).
  const taskId = await seedTask(staffId);

  // ── GET /tasks ─────────────────────────────────────────────────────────────

  await t.test("student cannot GET /tasks → 403", async () => {
    currentUser = { id: studentId, role: "student", isActive: true };
    const { status } = await apiReq("GET", "/api/tasks");
    assert.equal(status, 403, `expected 403, got ${status}`);
  });

  await t.test("agent cannot GET /tasks → 403", async () => {
    currentUser = { id: agentId, role: "agent", isActive: true };
    const { status } = await apiReq("GET", "/api/tasks");
    assert.equal(status, 403, `expected 403, got ${status}`);
  });

  await t.test("sub_agent cannot GET /tasks → 403", async () => {
    currentUser = { id: subAgentId, role: "sub_agent", isActive: true };
    const { status } = await apiReq("GET", "/api/tasks");
    assert.equal(status, 403, `expected 403, got ${status}`);
  });

  await t.test("staff can GET /tasks → 200", async () => {
    currentUser = { id: staffId, role: "staff", isActive: true };
    const { status } = await apiReq("GET", "/api/tasks");
    assert.equal(status, 200, `expected 200, got ${status}`);
  });

  await t.test("admin can GET /tasks → 200", async () => {
    currentUser = { id: adminId, role: "admin", isActive: true };
    const { status } = await apiReq("GET", "/api/tasks");
    assert.equal(status, 200, `expected 200, got ${status}`);
  });

  await t.test("agent_staff with tasks perm can GET /tasks → 200", async () => {
    currentUser = { id: agentStaffWithPermsId, role: "agent_staff", isActive: true };
    const { status } = await apiReq("GET", "/api/tasks");
    assert.equal(status, 200, `expected 200, got ${status}`);
  });

  await t.test("agent_staff without tasks perm cannot GET /tasks → 403", async () => {
    currentUser = { id: agentStaffNoTasksId, role: "agent_staff", isActive: true };
    const { status } = await apiReq("GET", "/api/tasks");
    assert.equal(status, 403, `expected 403, got ${status}`);
  });

  // ── POST /tasks/:id/notes ───────────────────────────────────────────────────

  await t.test("agent cannot POST /tasks/:id/notes → 403", async () => {
    currentUser = { id: agentId, role: "agent", isActive: true };
    const { status } = await apiReq("POST", `/api/tasks/${taskId}/notes`, { text: "note from agent" });
    assert.equal(status, 403, `expected 403, got ${status}`);
  });

  await t.test("staff can POST /tasks/:id/notes → 201", async () => {
    currentUser = { id: staffId, role: "staff", isActive: true };
    const { status } = await apiReq("POST", `/api/tasks/${taskId}/notes`, { text: "note from staff" });
    assert.equal(status, 201, `expected 201, got ${status}`);
  });

  await t.test("admin can POST /tasks/:id/notes → 201", async () => {
    currentUser = { id: adminId, role: "admin", isActive: true };
    const { status } = await apiReq("POST", `/api/tasks/${taskId}/notes`, { text: "note from admin" });
    assert.equal(status, 201, `expected 201, got ${status}`);
  });

  await t.test("agent_staff with tasks perm can POST /tasks/:id/notes → 201", async () => {
    currentUser = { id: agentStaffWithPermsId, role: "agent_staff", isActive: true };
    const { status } = await apiReq("POST", `/api/tasks/${taskId}/notes`, { text: "note from agent_staff+tasks" });
    assert.equal(status, 201, `expected 201, got ${status}`);
  });

  await t.test("agent_staff without tasks perm cannot POST /tasks/:id/notes → 403", async () => {
    currentUser = { id: agentStaffNoTasksId, role: "agent_staff", isActive: true };
    const { status } = await apiReq("POST", `/api/tasks/${taskId}/notes`, { text: "note from agent_staff-no-tasks" });
    assert.equal(status, 403, `expected 403, got ${status}`);
  });

  // ── Cleanup ────────────────────────────────────────────────────────────────
  if (cleanupTaskIds.length > 0) {
    await db.delete(tasksTable).where(inArray(tasksTable.id, cleanupTaskIds));
  }
  if (cleanupUserIds.length > 0) {
    await db.delete(usersTable).where(inArray(usersTable.id, cleanupUserIds));
  }
});
