/**
 * Agent Management Scope — route-level integration test (Task #474 / Faz S3).
 *
 * Verifies that all six branch-scope fixes are in place:
 *
 *   A1  PATCH /agents/:id/status          — isAgentInScope guard
 *   A2  POST  /agents/bulk-delete         — cross-branch IDs silently skipped
 *   A3  POST  /agents/:id/impersonate     — isAgentInScope guard
 *   A4  POST  /agents/:id/set-password    — isAgentInScope guard
 *   A5  POST  /agents/:id/resend-credentials — isAgentInScope guard
 *   A6  GET   /agents/contract-alerts     — getVisibleBranchIds branch filter
 *
 * Scenarios:
 *   1.  A1: manager branchA → agentB (branchB) PATCH status → 403
 *   2.  A1: manager branchA → agentA (branchA) PATCH status → 200
 *   3.  A2: manager branchA bulk-delete cross-branch ID → count 0 (skipped, not deleted)
 *   4.  A3: manager branchA → agentB impersonate → 403
 *   5.  A3: manager branchA → agentA impersonate → scope passes (400 = no session cookie, not 403)
 *   6.  A4: manager branchA → agentB set-password → 403
 *   7.  A4: manager branchA → agentA set-password → 200
 *   8.  A5: manager branchA → agentB resend-credentials → 403
 *   9.  A5: manager branchA → agentA resend-credentials → 200
 *  10.  A6: branch-limited manager sees only own-branch contract-alerts
 *  11.  A6: admin sees all branches in contract-alerts
 *  12.  A7: branch-limited agent search returns 200 and only own-branch rows
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:agent-management-scope
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express, type Request } from "express";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  agentsTable,
  branchesTable,
  agentBranchesTable,
} from "@workspace/db";

import agentsRouter from "../src/routes/agents.js";

after(() => {
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

const RUN_ID = `ams_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

// ---------------------------------------------------------------------------
// Mutable user injected per-request — bypasses the real auth stack.
// ---------------------------------------------------------------------------
let currentUser: {
  id: number;
  role: string;
  isActive: boolean;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
} = { id: 0, role: "admin", isActive: true };

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: typeof currentUser }).user = currentUser;
    // Ensure req.cookies exists so impersonate handler doesn't throw before its
    // cookie-check branch when running without cookie-parser middleware.
    if (!("cookies" in req)) {
      (req as unknown as { cookies: Record<string, string> }).cookies = {};
    }
    next();
  });
  app.use("/api", agentsRouter);
  return app;
}

const app = buildApp();

async function apiReq(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const server = http.createServer(
    app as unknown as (req: Request, res: unknown) => void,
  );
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
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, data: parsed };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// Seeding helpers
// ---------------------------------------------------------------------------
const cleanupAgentBranchIds: Array<{ agentId: number; branchId: number }> = [];
const cleanupAgentIds: number[]  = [];
const cleanupUserIds: number[]   = [];
const cleanupBranchIds: number[] = [];

async function createBranch(suffix: string): Promise<number> {
  const [row] = await db
    .insert(branchesTable)
    .values({ name: `AMS_Branch_${RUN_ID}_${suffix}` })
    .returning({ id: branchesTable.id });
  cleanupBranchIds.push(row.id);
  return row.id;
}

async function createUser(
  role: string,
  branchId?: number,
): Promise<number> {
  const suffix = Math.random().toString(36).slice(2, 6);
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_ID}_${role}_${suffix}@ams-test.local`,
      firstName: "AMS",
      lastName: `Test_${RUN_ID}`,
      role,
      isActive: true,
      branchId: branchId ?? null,
    })
    .returning({ id: usersTable.id });
  cleanupUserIds.push(row.id);
  return row.id;
}

async function createAgent(
  userId: number,
  opts?: { contractEndDate?: Date; status?: string },
): Promise<number> {
  const [row] = await db
    .insert(agentsTable)
    .values({
      userId,
      firstName: "AMS",
      lastName: `Agent_${RUN_ID}`,
      status: (opts?.status ?? "active") as "active" | "inactive",
      contractEndDate: opts?.contractEndDate ?? null,
    })
    .returning({ id: agentsTable.id });
  cleanupAgentIds.push(row.id);
  return row.id;
}

async function linkAgentBranch(agentId: number, branchId: number): Promise<void> {
  await db
    .insert(agentBranchesTable)
    .values({ agentId, branchId })
    .onConflictDoNothing();
  cleanupAgentBranchIds.push({ agentId, branchId });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test("Agent Management Scope — Faz S3", async (t) => {

  // ── Create two branches ────────────────────────────────────────────────────
  const branchAId = await createBranch("A");
  const branchBId = await createBranch("B");

  // ── Manager for branchA (MANAGER_ROLES = [super_admin, admin, manager]) ───
  const managerUserId = await createUser("manager", branchAId);

  // ── AgentA: lives in branchA, has a linked user account ───────────────────
  const agentAUserId = await createUser("agent");
  const agentAId = await createAgent(agentAUserId, {
    contractEndDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
  await linkAgentBranch(agentAId, branchAId);

  // ── AgentB: lives in branchB, has a linked user account ───────────────────
  const agentBUserId = await createUser("agent");
  const agentBId = await createAgent(agentBUserId, {
    contractEndDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
  await linkAgentBranch(agentBId, branchBId);

  // ── Extra agent in branchB for bulk-delete test (throwaway) ────────────────
  const agentCUserId = await createUser("agent");
  const agentCId = await createAgent(agentCUserId);
  await linkAgentBranch(agentCId, branchBId);

  // ── Admin user (super_admin sees all branches) ─────────────────────────────
  const adminUserId = await createUser("super_admin");

  // ── A1: PATCH /agents/:id/status ─────────────────────────────────────────

  await t.test("A1 manager branchA → agentB (branchB) PATCH status → 403", async () => {
    currentUser = { id: managerUserId, role: "manager", isActive: true };
    const { status } = await apiReq("PATCH", `/api/agents/${agentBId}/status`, {
      status: "inactive",
    });
    assert.equal(status, 403, `expected 403, got ${status}`);
  });

  await t.test("A1 manager branchA → agentA (branchA) PATCH status → 200", async () => {
    currentUser = { id: managerUserId, role: "manager", isActive: true };
    const { status } = await apiReq("PATCH", `/api/agents/${agentAId}/status`, {
      status: "active",
    });
    assert.equal(status, 200, `expected 200, got ${status}`);
  });

  // ── A2: POST /agents/bulk-delete ──────────────────────────────────────────
  // Cross-branch IDs are silently skipped (count 0), not deleted.

  await t.test(
    "A2 manager branchA bulk-delete cross-branch agentC → count 0 (not deleted)",
    async () => {
      currentUser = { id: managerUserId, role: "manager", isActive: true };
      const { status, data } = await apiReq("POST", "/api/agents/bulk-delete", {
        ids: [agentCId],
      });
      assert.equal(status, 200, `expected 200 with skipped count, got ${status}`);
      const d = data as Record<string, unknown>;
      assert.equal(d.count, 0, `expected count 0 (no cross-branch deletes), got ${d.count}`);
      // Verify agentC is still in DB (not silently deleted)
      const [still] = await db
        .select({ id: agentsTable.id })
        .from(agentsTable)
        .where(eq(agentsTable.id, agentCId));
      assert.ok(still, "agentC must still exist in DB — bulk-delete must not delete cross-branch agents");
    },
  );

  // ── A3: POST /agents/:id/impersonate ─────────────────────────────────────

  await t.test("A3 manager branchA → agentB (branchB) impersonate → 403", async () => {
    currentUser = { id: managerUserId, role: "manager", isActive: true };
    const { status } = await apiReq("POST", `/api/agents/${agentBId}/impersonate`);
    assert.equal(status, 403, `expected 403, got ${status}`);
  });

  await t.test(
    "A3 manager branchA → agentA (branchA) impersonate → scope passes (≠ 403)",
    async () => {
      // Scope check passes → falls through to session-cookie check → 400.
      // Any response other than 403 confirms the scope guard did not block it.
      currentUser = { id: managerUserId, role: "manager", isActive: true };
      const { status } = await apiReq("POST", `/api/agents/${agentAId}/impersonate`);
      assert.notEqual(status, 403, `expected scope to pass (not 403), got ${status}`);
    },
  );

  // ── A4: POST /agents/:id/set-password ─────────────────────────────────────

  await t.test("A4 manager branchA → agentB (branchB) set-password → 403", async () => {
    currentUser = { id: managerUserId, role: "manager", isActive: true };
    const { status } = await apiReq("POST", `/api/agents/${agentBId}/set-password`, {
      password: "TestPwd123",
    });
    assert.equal(status, 403, `expected 403, got ${status}`);
  });

  await t.test("A4 manager branchA → agentA (branchA) set-password → 200", async () => {
    currentUser = { id: managerUserId, role: "manager", isActive: true };
    const { status } = await apiReq("POST", `/api/agents/${agentAId}/set-password`, {
      password: "TestPwd123",
    });
    assert.equal(status, 200, `expected 200, got ${status}`);
  });

  // ── A5: POST /agents/:id/resend-credentials ───────────────────────────────

  await t.test(
    "A5 manager branchA → agentB (branchB) resend-credentials → 403",
    async () => {
      currentUser = { id: managerUserId, role: "manager", isActive: true };
      const { status } = await apiReq(
        "POST",
        `/api/agents/${agentBId}/resend-credentials`,
      );
      assert.equal(status, 403, `expected 403, got ${status}`);
    },
  );

  await t.test(
    "A5 manager branchA → agentA (branchA) resend-credentials → 200",
    async () => {
      // Handler catches email-send failures gracefully → 200 {emailSent: false}.
      currentUser = { id: managerUserId, role: "manager", isActive: true };
      const { status } = await apiReq(
        "POST",
        `/api/agents/${agentAId}/resend-credentials`,
      );
      assert.equal(status, 200, `expected 200 (email may fail silently), got ${status}`);
    },
  );

  // ── A6: GET /agents/contract-alerts ──────────────────────────────────────

  await t.test(
    "A6 branch-limited manager sees only own-branch agents in contract-alerts",
    async () => {
      currentUser = { id: managerUserId, role: "manager", isActive: true };
      const { status, data } = await apiReq("GET", "/api/agents/contract-alerts");
      assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(data)}`);
      const rows = data as Array<{ id: number }>;
      const ids = rows.map((r) => r.id);
      assert.ok(
        ids.includes(agentAId),
        `agentA (branchA) must appear in manager-branchA contract-alerts`,
      );
      assert.ok(
        !ids.includes(agentBId),
        `agentB (branchB) must NOT appear in manager-branchA contract-alerts`,
      );
    },
  );

  await t.test(
    "A6 super_admin (no branch restriction) sees all branches in contract-alerts",
    async () => {
      currentUser = { id: adminUserId, role: "super_admin", isActive: true };
      const { status, data } = await apiReq("GET", "/api/agents/contract-alerts");
      assert.equal(status, 200, `expected 200, got ${status}`);
      const rows = data as Array<{ id: number }>;
      const ids = rows.map((r) => r.id);
      assert.ok(
        ids.includes(agentAId),
        `agentA (branchA) must appear for super_admin`,
      );
      assert.ok(
        ids.includes(agentBId),
        `agentB (branchB) must appear for super_admin`,
      );
    },
  );

  // ── A7: GET /agents search ───────────────────────────────────────────────

  await t.test(
    "A7 branch-limited manager can search own-branch agents without a 500",
    async () => {
      currentUser = { id: managerUserId, role: "manager", isActive: true };
      const { status, data } = await apiReq("GET", "/api/agents?type=agent&search=AMS&page=1&limit=20");
      assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(data)}`);
      const rows = (data as { data: Array<{ id: number }> }).data;
      const ids = rows.map(row => row.id);
      assert.ok(ids.includes(agentAId), "own-branch agent must be returned by search");
      assert.ok(!ids.includes(agentBId), "cross-branch agent must not be returned by search");
    },
  );

  // ── Cleanup — respect FK order ─────────────────────────────────────────────
  // agentBranchesTable cascades from agentId, but explicit cleanup first
  // ensures no orphan branch rows block the final branchesTable delete.
  for (const { agentId } of cleanupAgentBranchIds) {
    await db
      .delete(agentBranchesTable)
      .where(eq(agentBranchesTable.agentId, agentId))
      .catch(() => {});
  }
  if (cleanupAgentIds.length > 0) {
    await db
      .delete(agentsTable)
      .where(inArray(agentsTable.id, cleanupAgentIds));
  }
  if (cleanupUserIds.length > 0) {
    await db
      .delete(usersTable)
      .where(inArray(usersTable.id, cleanupUserIds));
  }
  if (cleanupBranchIds.length > 0) {
    await db
      .delete(branchesTable)
      .where(inArray(branchesTable.id, cleanupBranchIds));
  }
});
