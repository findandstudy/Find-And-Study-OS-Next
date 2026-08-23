/**
 * Meta DM reply — RBAC matrix + good-path integration test (Faz 6).
 *
 * Exercises the REAL inbox router in-process (no network auth stack) against a
 * real PostgreSQL connection, asserting the permission matrix and the
 * messenger/instagram outbound branches of
 *   POST /api/inbox/conversations/:id/messages
 *
 * The endpoint is shared with WhatsApp and is gated by
 *   requireAuth + requireRole(...STAFF_ROLES, ...ADMIN_ROLES)
 * STAFF_ROLES = [super_admin, admin, manager, staff, consultant, editor, accountant].
 * agent_staff lives in AGENT_ROLES and is intentionally NOT changed here (doing
 * so would alter WhatsApp authorization on the same shared route — out of scope).
 *
 * Matrix:
 *   - unauthenticated                      -> 401
 *   - admin (ADMIN_ROLES)                  -> passes gate (404 on missing conv)
 *   - staff (STAFF_ROLES)                  -> good messenger/instagram conv -> 201 simulated
 *   - staff, conv outside 24h window       -> 409 outside_24h_window
 *   - student / agent / agent_staff        -> 403 (not on this shared endpoint)
 *
 * Run:
 *   pnpm --filter @workspace/api-server run test:meta-reply-rbac
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express, type Request } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  conversationsTable,
  externalContactsTable,
  messagesTable,
} from "@workspace/db";

import inboxRouter from "../src/routes/inbox.js";

// Pin simulated outbound deterministically (mirror test-meta-dm.ts env isolation):
// isLiveIntegrationsEnabled() => NODE_ENV==="production" || ALLOW_LIVE_INTEGRATIONS==="true".
delete process.env.ALLOW_LIVE_INTEGRATIONS;
if (process.env.NODE_ENV === "production") process.env.NODE_ENV = "test";

after(() => {
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

type ReplyResponse = {
  simulated?: boolean;
  error?: string;
  message?: { channel?: string; direction?: string; status?: string };
};

const RUN_ID = `metarbac_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

// Mutable user injected per-request. null => no req.user (unauthenticated 401).
let currentUser: { id: number; role: string; isActive: boolean } | null = null;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (currentUser) (req as unknown as { user: typeof currentUser }).user = currentUser;
    next();
  });
  app.use("/api", inboxRouter);
  return app;
}

const app = buildApp();

async function post(path: string, body: unknown): Promise<{ status: number; data: ReplyResponse }> {
  const server = http.createServer(app as unknown as (req: Request, res: unknown) => void);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("listen failed");
  const port = addr.port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: ReplyResponse = {};
    try { parsed = text ? (JSON.parse(text) as ReplyResponse) : {}; } catch { parsed = {}; }
    return { status: res.status, data: parsed };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// Seeding + cleanup
// ---------------------------------------------------------------------------

const cleanupUserIds: number[] = [];
const cleanupConvIds: number[] = [];
const cleanupContactIds: number[] = [];

async function createUser(role: string): Promise<number> {
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_ID}_${role}_${Math.random().toString(36).slice(2, 6)}@meta-rbac.local`,
      firstName: "Meta",
      lastName: `RBAC_${RUN_ID}`,
      role,
      isActive: true,
    })
    .returning({ id: usersTable.id });
  cleanupUserIds.push(row.id);
  return row.id;
}

async function createContact(channel: "messenger" | "instagram"): Promise<number> {
  const [row] = await db
    .insert(externalContactsTable)
    .values({
      channel,
      externalId: `${channel}_${RUN_ID}_${Math.random().toString(36).slice(2, 8)}`,
      displayName: "Meta RBAC Tester",
    })
    .returning({ id: externalContactsTable.id });
  cleanupContactIds.push(row.id);
  return row.id;
}

async function createConversation(opts: {
  channel: "messenger" | "instagram";
  externalContactId: number;
  lastInboundAt: Date;
}): Promise<number> {
  const [row] = await db
    .insert(conversationsTable)
    .values({
      type: "external",
      channel: opts.channel,
      externalContactId: opts.externalContactId,
      lastInboundAt: opts.lastInboundAt,
      botEnabled: false,
      status: "open",
    })
    .returning({ id: conversationsTable.id });
  cleanupConvIds.push(row.id);
  return row.id;
}

after(async () => {
  for (const id of cleanupConvIds) {
    await db.delete(messagesTable).where(eq(messagesTable.conversationId, id));
    await db.delete(conversationsTable).where(eq(conversationsTable.id, id));
  }
  for (const id of cleanupContactIds) {
    await db.delete(externalContactsTable).where(eq(externalContactsTable.id, id));
  }
  for (const id of cleanupUserIds) {
    await db.delete(usersTable).where(eq(usersTable.id, id));
  }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let adminId: number;
let staffId: number;
let studentId: number;
let agentId: number;
let agentStaffId: number;

let messengerConvId: number;
let instagramConvId: number;
let staleConvId: number;

await (async () => {
  adminId = await createUser("admin");
  staffId = await createUser("staff");
  studentId = await createUser("student");
  agentId = await createUser("agent");
  agentStaffId = await createUser("agent_staff");

  const recent = new Date(Date.now() - 5 * 60_000);
  const stale = new Date(Date.now() - 25 * 60 * 60_000);

  const msgrContact = await createContact("messenger");
  const igContact = await createContact("instagram");
  const staleContact = await createContact("messenger");

  messengerConvId = await createConversation({ channel: "messenger", externalContactId: msgrContact, lastInboundAt: recent });
  instagramConvId = await createConversation({ channel: "instagram", externalContactId: igContact, lastInboundAt: recent });
  staleConvId = await createConversation({ channel: "messenger", externalContactId: staleContact, lastInboundAt: stale });
})();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("unauthenticated request is rejected with 401", async () => {
  currentUser = null;
  const { status } = await post(`/api/inbox/conversations/${messengerConvId}/messages`, { content: "hi" });
  assert.equal(status, 401);
});

test("admin passes the RBAC gate (404 on a missing conversation)", async () => {
  currentUser = { id: adminId, role: "admin", isActive: true };
  const { status } = await post(`/api/inbox/conversations/99999999/messages`, { content: "hi" });
  assert.equal(status, 404);
});

test("staff can reply to a Messenger conversation within the 24h window (simulated send)", async () => {
  currentUser = { id: staffId, role: "staff", isActive: true };
  const { status, data } = await post(`/api/inbox/conversations/${messengerConvId}/messages`, { content: "messenger reply" });
  assert.equal(status, 201, JSON.stringify(data));
  assert.equal(data.simulated, true);
  assert.equal(data.message?.channel, "messenger");
  assert.equal(data.message?.direction, "outbound");
  assert.equal(data.message?.status, "sent");
});

test("staff can reply to an Instagram conversation within the 24h window (simulated send)", async () => {
  currentUser = { id: staffId, role: "staff", isActive: true };
  const { status, data } = await post(`/api/inbox/conversations/${instagramConvId}/messages`, { content: "instagram reply" });
  assert.equal(status, 201, JSON.stringify(data));
  assert.equal(data.simulated, true);
  assert.equal(data.message?.channel, "instagram");
});

test("reply outside the 24h window returns 409 outside_24h_window", async () => {
  currentUser = { id: staffId, role: "staff", isActive: true };
  const { status, data } = await post(`/api/inbox/conversations/${staleConvId}/messages`, { content: "too late" });
  assert.equal(status, 409);
  assert.equal(data.error, "outside_24h_window");
});

test("student is forbidden (403) on the Meta reply endpoint", async () => {
  currentUser = { id: studentId, role: "student", isActive: true };
  const { status } = await post(`/api/inbox/conversations/${messengerConvId}/messages`, { content: "nope" });
  assert.equal(status, 403);
});

test("agent is forbidden (403) on the Meta reply endpoint", async () => {
  currentUser = { id: agentId, role: "agent", isActive: true };
  const { status } = await post(`/api/inbox/conversations/${messengerConvId}/messages`, { content: "nope" });
  assert.equal(status, 403);
});

test("agent_staff is forbidden (403) on this shared reply endpoint (not in STAFF_ROLES)", async () => {
  currentUser = { id: agentStaffId, role: "agent_staff", isActive: true };
  const { status } = await post(`/api/inbox/conversations/${messengerConvId}/messages`, { content: "nope" });
  assert.equal(status, 403);
});
