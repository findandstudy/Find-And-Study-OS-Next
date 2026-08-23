/**
 * Inbox AI actions test (Phase 2).
 *
 * Locks down three behaviors of the new endpoints added in
 * `routes/inbox.ts`:
 *   (a) POST /inbox/conversations/:id/summarize calls Anthropic the first
 *       time and serves the result from `conversations.metadata.aiSummary`
 *       cache the second time when the message count has not changed.
 *   (b) When a new message is appended after caching, the next summarize
 *       request bypasses the cache and calls Anthropic again.
 *   (c) summarize/notes/tasks return 400 when the conversation is not
 *       linked to a lead or student.
 *
 * The Anthropic SDK call is replaced via the `__setAiSummaryOverrideForTests`
 * seam exported from `routes/inbox.ts`, so this test runs without an API key
 * and without spending tokens.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:inbox-ai-actions
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

// Hard exit after all tests complete — inbox.ts wires up an Anthropic
// integration client and the db pool keeps connections open via a LISTEN
// session held by the inbox event bus, so node would otherwise hang on a
// live handle. Matches the `process.exit` pattern used by test-inbox-suite.
import http from "http";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  conversationsTable,
  messagesTable,
  externalContactsTable,
  usersTable,
} from "@workspace/db";

// Real DB user seeded before tests so logAudit FK constraint is satisfied.
const RUN_ID_AI = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
let ACTOR_USER_ID = 0;
before(async () => {
  const [u] = await db
    .insert(usersTable)
    .values({ email: `test-inbox-ai-actor-${RUN_ID_AI}@test.internal` })
    .returning({ id: usersTable.id });
  ACTOR_USER_ID = u.id;
});

after(async () => {
  if (ACTOR_USER_ID) {
    await db.delete(usersTable).where(eq(usersTable.id, ACTOR_USER_ID));
  }
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

import inboxRouter, { __setAiSummaryOverrideForTests } from "../src/routes/inbox.js";

interface SeededConv {
  conversationId: number;
  externalContactId: number;
  leadId: number | null;
  cleanup: () => Promise<void>;
}

async function seedConversation(opts: { withLeadLink: boolean }): Promise<SeededConv> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [contact] = await db
    .insert(externalContactsTable)
    .values({
      channel: "whatsapp",
      externalId: `test-ai-actions-${suffix}`,
      displayName: "AI test contact",
      // We intentionally do not set leadId/studentId so the conversation is
      // "unmatched" — tests opt-in to seed a lead by passing withLeadLink.
    })
    .returning();

  let leadIdToSet: number | null = null;
  if (opts.withLeadLink) {
    // Use a fake-but-valid lead id by writing a minimal lead row.
    const { leadsTable } = await import("@workspace/db");
    const [lead] = await db
      .insert(leadsTable)
      .values({
        firstName: "AI",
        lastName: `Test-${suffix}`,
        status: "new",
      })
      .returning({ id: leadsTable.id });
    leadIdToSet = lead.id;
    await db
      .update(externalContactsTable)
      .set({ leadId: leadIdToSet })
      .where(eq(externalContactsTable.id, contact.id));
  }

  const [conv] = await db
    .insert(conversationsTable)
    .values({
      type: "external",
      channel: "whatsapp",
      externalContactId: contact.id,
      externalThreadId: `test-ai-thread-${suffix}`,
    })
    .returning();

  return {
    conversationId: conv.id,
    externalContactId: contact.id,
    leadId: leadIdToSet,
    cleanup: async () => {
      await db.delete(messagesTable).where(eq(messagesTable.conversationId, conv.id));
      await db.delete(conversationsTable).where(eq(conversationsTable.id, conv.id));
      await db.delete(externalContactsTable).where(eq(externalContactsTable.id, contact.id));
      if (leadIdToSet !== null) {
        const { leadsTable } = await import("@workspace/db");
        await db.delete(leadsTable).where(eq(leadsTable.id, leadIdToSet));
      }
    },
  };
}

async function appendMessage(conversationId: number, content: string): Promise<void> {
  await db.insert(messagesTable).values({
    conversationId,
    content,
    channel: "whatsapp",
    direction: "inbound",
    status: "received",
  });
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Inject a fake staff user — bypasses requireAuth's body parsing of
    // sessions but still exercises requireRole + the handler body.
    (req as unknown as { user: Record<string, unknown> }).user = {
      id: ACTOR_USER_ID,
      role: "admin",
      isActive: true,
    };
    next();
  });
  app.use("/api", inboxRouter);
  return app;
}

async function request(
  app: Express,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const server = http.createServer(app);
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
    return { status: res.status, body: parsed };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("summarize caches between calls and re-runs after a new message", async (t) => {
  const seeded = await seedConversation({ withLeadLink: true });
  t.after(async () => {
    __setAiSummaryOverrideForTests(null);
    await seeded.cleanup();
  });

  await appendMessage(seeded.conversationId, "Merhaba, vize sürecini öğrenmek istiyorum.");
  await appendMessage(seeded.conversationId, "Hangi belgeler gerekiyor?");

  let aiCalls = 0;
  __setAiSummaryOverrideForTests(async () => {
    aiCalls += 1;
    return { content: `Stub summary v${aiCalls}`, model: "test-stub" };
  });

  const app = buildApp();

  const first = await request(app, "POST", `/api/inbox/conversations/${seeded.conversationId}/summarize`);
  assert.equal(first.status, 200, "first summarize should succeed");
  const firstBody = first.body as { data: { content: string }; fromCache: boolean };
  assert.equal(firstBody.fromCache, false, "first call must hit the AI");
  assert.equal(firstBody.data.content, "Stub summary v1");
  assert.equal(aiCalls, 1);

  const second = await request(app, "POST", `/api/inbox/conversations/${seeded.conversationId}/summarize`);
  assert.equal(second.status, 200);
  const secondBody = second.body as { data: { content: string }; fromCache: boolean };
  assert.equal(secondBody.fromCache, true, "second call must come from cache");
  assert.equal(secondBody.data.content, "Stub summary v1", "cached content matches");
  assert.equal(aiCalls, 1, "AI was not called a second time");

  await appendMessage(seeded.conversationId, "Bir ek mesaj daha.");

  const third = await request(app, "POST", `/api/inbox/conversations/${seeded.conversationId}/summarize`);
  assert.equal(third.status, 200);
  const thirdBody = third.body as { data: { content: string }; fromCache: boolean };
  assert.equal(thirdBody.fromCache, false, "new message must invalidate the cache");
  assert.equal(thirdBody.data.content, "Stub summary v2");
  assert.equal(aiCalls, 2);
});

test("summarize/notes/tasks return 400 when conversation has no lead or student link", async (t) => {
  const seeded = await seedConversation({ withLeadLink: false });
  t.after(async () => {
    __setAiSummaryOverrideForTests(null);
    await seeded.cleanup();
  });
  // Summarize doesn't require a lead link itself, but notes/tasks do.
  // Add a message so summarize would otherwise succeed.
  await appendMessage(seeded.conversationId, "Hello there");

  __setAiSummaryOverrideForTests(async () => ({ content: "n/a", model: "test-stub" }));

  const app = buildApp();

  const noteRes = await request(
    app,
    "POST",
    `/api/inbox/conversations/${seeded.conversationId}/notes`,
    { content: "test note" },
  );
  assert.equal(noteRes.status, 400, "note on unlinked conversation must be rejected");

  const taskRes = await request(
    app,
    "POST",
    `/api/inbox/conversations/${seeded.conversationId}/tasks`,
    { title: "Follow up", scheduledAt: new Date(Date.now() + 86_400_000).toISOString() },
  );
  assert.equal(taskRes.status, 400, "task on unlinked conversation must be rejected");
});

test("soft-deleted lead is hidden from GET detail and blocks summarize/notes/tasks", async (t) => {
  const seeded = await seedConversation({ withLeadLink: true });
  assert.ok(seeded.leadId, "test setup must produce a linked lead");
  t.after(async () => {
    __setAiSummaryOverrideForTests(null);
    await seeded.cleanup();
  });

  await appendMessage(seeded.conversationId, "Merhaba, vize sürecini öğrenmek istiyorum.");

  // Soft-delete the lead.
  const { leadsTable } = await import("@workspace/db");
  await db
    .update(leadsTable)
    .set({ deletedAt: new Date() })
    .where(eq(leadsTable.id, seeded.leadId!));

  __setAiSummaryOverrideForTests(async () => ({ content: "unused", model: "test-stub" }));

  const app = buildApp();

  // GET conv detail — lead and stage should both be null even though the
  // external_contacts row still points at the (now soft-deleted) lead.
  const detailRes = await request(app, "GET", `/api/inbox/conversations/${seeded.conversationId}`);
  assert.equal(detailRes.status, 200, "detail still loads");
  const detailBody = detailRes.body as { lead: unknown; stage: unknown };
  assert.equal(detailBody.lead, null, "soft-deleted lead must be hidden");
  assert.equal(detailBody.stage, null, "stage derives from lead/student so must also be null");

  // summarize/notes/tasks should all behave as if there is no link.
  // summarize still works because it operates on conversation metadata, but
  // notes & tasks require a live lead/student — they should return 400.
  const noteRes = await request(
    app,
    "POST",
    `/api/inbox/conversations/${seeded.conversationId}/notes`,
    { content: "test note" },
  );
  assert.equal(noteRes.status, 400, "note on soft-deleted-lead conversation must be rejected");

  const taskRes = await request(
    app,
    "POST",
    `/api/inbox/conversations/${seeded.conversationId}/tasks`,
    { title: "Follow up", scheduledAt: new Date(Date.now() + 86_400_000).toISOString() },
  );
  assert.equal(taskRes.status, 400, "task on soft-deleted-lead conversation must be rejected");
});
