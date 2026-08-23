/**
 * Sprint B — Notification equality: lead.created source-scope test.
 *
 * Verifies that when a lead is agent-sourced (agentId IS NOT NULL),
 * the lead.created notification is NOT delivered to staff/consultant users.
 * When a lead is direct (agentId IS NULL), staff/consultant SHOULD receive it.
 *
 * Uses the real Express router in-process + real DB (same pattern as
 * test-assignment-cascade.ts). dispatchNotification is fire-and-forget so a
 * short sleep is used before checking the notifications table.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:notification-lead-source-scope
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express, type Request } from "express";
import { eq, and, inArray, isNull, gt } from "drizzle-orm";
import {
  db,
  usersTable,
  agentsTable,
  leadsTable,
  notificationsTable,
  notificationRulesTable,
} from "@workspace/db";

import leadsRouter from "../src/routes/leads.js";

after(() => {
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

const RUN_ID = `nspb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

let currentUser: { id: number; role: string; isActive: boolean } = { id: 0, role: "admin", isActive: true };

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: typeof currentUser }).user = currentUser;
    next();
  });
  app.use("/api", leadsRouter);
  return app;
}

const app = buildApp();

async function apiReq(
  method: "POST" | "GET",
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

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Cleanup tracking
// ---------------------------------------------------------------------------
const cleanupUserIds: number[] = [];
const cleanupAgentIds: number[] = [];
const cleanupLeadIds: number[] = [];
const cleanupNotificationIds: number[] = [];

after(async () => {
  if (cleanupNotificationIds.length) {
    for (const id of cleanupNotificationIds) {
      await db.delete(notificationsTable).where(eq(notificationsTable.id, id));
    }
  }
  for (const id of cleanupLeadIds) {
    await db.delete(leadsTable).where(eq(leadsTable.id, id));
  }
  for (const id of cleanupAgentIds) {
    await db.delete(agentsTable).where(eq(agentsTable.id, id));
  }
  for (const id of cleanupUserIds) {
    await db.delete(usersTable).where(eq(usersTable.id, id));
  }
});

// ---------------------------------------------------------------------------
// Seeding helpers
// ---------------------------------------------------------------------------

async function createUser(role: string): Promise<number> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_ID}_${role}_${Math.random().toString(36).slice(2, 6)}@notify-test.local`,
      firstName: "NotifyTest",
      lastName: `${RUN_ID}_${role}`,
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
    .values({ userId, firstName: "NotifyAgent", lastName: `${RUN_ID}` })
    .returning({ id: agentsTable.id });
  cleanupAgentIds.push(row.id);
  return row.id;
}

/** Fetch notification rows written AFTER a given timestamp for specific userIds. */
async function fetchNotificationsSince(userIds: number[], since: Date): Promise<{ id: number; userId: number; type: string }[]> {
  if (userIds.length === 0) return [];
  return db
    .select({ id: notificationsTable.id, userId: notificationsTable.userId, type: notificationsTable.type })
    .from(notificationsTable)
    .where(
      and(
        inArray(notificationsTable.userId, userIds),
        gt(notificationsTable.createdAt, since),
        eq(notificationsTable.type, "lead.created"),
      ),
    );
}

// ---------------------------------------------------------------------------
// Ensure lead.created rule is active (test environment may be clean DB)
// ---------------------------------------------------------------------------

async function ensureLeadCreatedRule(): Promise<void> {
  const [existing] = await db
    .select({ id: notificationRulesTable.id })
    .from(notificationRulesTable)
    .where(eq(notificationRulesTable.event, "lead.created"));
  if (!existing) {
    await db.insert(notificationRulesTable).values({
      event: "lead.created",
      name: "New Lead Created",
      category: "leads",
      channels: ["in_app"],
      recipientType: "role",
      recipientRoles: ["super_admin", "admin", "manager", "staff", "consultant"],
      isActive: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Test fixture creation
// ---------------------------------------------------------------------------

// superAdminUserId is used as the HTTP actor for tests 1 & 2 (bypasses branch check).
// adminUserId is a recipient-under-test (admin role should receive notifications).
let superAdminUserId: number;
let adminUserId: number;
let staffUserId: number;
let consultantUserId: number;
let agentUserId: number;
let agentId: number;

await (async () => {
  await ensureLeadCreatedRule();
  superAdminUserId = await createUser("super_admin");
  adminUserId = await createUser("admin");
  staffUserId = await createUser("staff");
  consultantUserId = await createUser("consultant");
  agentUserId = await createUser("agent");
  agentId = await createAgent(agentUserId);
})();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("lead.created (agent-sourced): staff and consultant do NOT receive notification", async () => {
  const before = new Date();
  // Use super_admin as actor — bypasses branch requirement (no branch in test DB).
  currentUser = { id: superAdminUserId, role: "super_admin", isActive: true };

  const suffix = Math.random().toString(36).slice(2, 8);
  const { status, data } = await apiReq("POST", "/api/leads", {
    firstName: "AgentLead",
    lastName: `Test_${suffix}`,
    email: `agentlead_${RUN_ID}_${suffix}@notify-test.local`,
    phone: "+905001112233",
    agentId,
  });

  assert.equal(status, 201, `expected 201 got ${status}: ${JSON.stringify(data)}`);
  const leadId = (data as { id: number }).id;
  cleanupLeadIds.push(leadId);

  // Wait for fire-and-forget dispatch to complete
  await sleep(600);

  const staffNotifs = await fetchNotificationsSince([staffUserId, consultantUserId], before);
  for (const n of staffNotifs) cleanupNotificationIds.push(n.id);

  assert.equal(
    staffNotifs.length,
    0,
    `staff/consultant should NOT receive lead.created for agent-sourced lead, got: ${JSON.stringify(staffNotifs)}`,
  );

  // adminUserId is a regular admin (not the actor), should receive
  const adminNotifs = await fetchNotificationsSince([adminUserId], before);
  for (const n of adminNotifs) cleanupNotificationIds.push(n.id);
  assert.ok(
    adminNotifs.length > 0,
    "admin should receive lead.created for agent-sourced lead",
  );
});

test("lead.created (direct): staff and consultant DO receive notification", async () => {
  const before = new Date();
  // Use super_admin as actor — bypasses branch requirement (no branch in test DB).
  currentUser = { id: superAdminUserId, role: "super_admin", isActive: true };

  const suffix = Math.random().toString(36).slice(2, 8);
  const { status, data } = await apiReq("POST", "/api/leads", {
    firstName: "DirectLead",
    lastName: `Test_${suffix}`,
    email: `directlead_${RUN_ID}_${suffix}@notify-test.local`,
    phone: "+905002223344",
    // No agentId — direct lead
  });

  assert.equal(status, 201, `expected 201 got ${status}: ${JSON.stringify(data)}`);
  const leadId = (data as { id: number }).id;
  cleanupLeadIds.push(leadId);

  await sleep(600);

  const staffNotifs = await fetchNotificationsSince([staffUserId, consultantUserId], before);
  for (const n of staffNotifs) cleanupNotificationIds.push(n.id);

  assert.ok(
    staffNotifs.length >= 1,
    `staff/consultant should receive lead.created for direct lead, got 0 notifications`,
  );

  // actor (adminUserId) is filtered out by dispatchNotification
  // staff and consultant should each get one
  const recipientIds = staffNotifs.map(n => n.userId);
  assert.ok(
    recipientIds.includes(staffUserId),
    "staff user must receive lead.created for direct lead",
  );
  assert.ok(
    recipientIds.includes(consultantUserId),
    "consultant user must receive lead.created for direct lead",
  );
});

test("lead.created (agent-sourced via agent actor): admin receives, actor (agent) is excluded", async () => {
  const before = new Date();
  currentUser = { id: agentUserId, role: "agent", isActive: true };

  const suffix = Math.random().toString(36).slice(2, 8);
  const { status, data } = await apiReq("POST", "/api/leads", {
    firstName: "AgentActorLead",
    lastName: `Test_${suffix}`,
    email: `agentactor_${RUN_ID}_${suffix}@notify-test.local`,
    phone: "+905003334455",
  });

  assert.equal(status, 201, `expected 201 got ${status}: ${JSON.stringify(data)}`);
  const leadId = (data as { id: number }).id;
  cleanupLeadIds.push(leadId);

  await sleep(600);

  // staff/consultant should NOT receive
  const staffNotifs = await fetchNotificationsSince([staffUserId, consultantUserId], before);
  for (const n of staffNotifs) cleanupNotificationIds.push(n.id);
  assert.equal(staffNotifs.length, 0, "staff must NOT receive for agent-actor lead");

  // agent actor should NOT receive own notification (actorUserId filter)
  const agentActorNotifs = await fetchNotificationsSince([agentUserId], before);
  for (const n of agentActorNotifs) cleanupNotificationIds.push(n.id);
  assert.equal(agentActorNotifs.length, 0, "agent actor must NOT receive own lead.created notification");

  // admin should receive (agentUserId is the actor, not adminUserId)
  const adminNotifs = await fetchNotificationsSince([adminUserId], before);
  for (const n of adminNotifs) cleanupNotificationIds.push(n.id);
  assert.ok(adminNotifs.length > 0, "admin should receive lead.created when agent creates lead");
});
