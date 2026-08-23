/**
 * Dev test: Smart lead creation from inbox conversation (Faz 1 — AI pre-fill + duplicate guard).
 *
 * Tests four things end-to-end WITHOUT a real WhatsApp connection:
 *   (1) Fake inbound unmatched conversation via processInboundMessage
 *   (2) GET /inbox/conversations/:id/lead-suggestion → phone/displayName from
 *       external_contacts + AI fields (fullName, email, lowConfidence flags)
 *       via stub override — no API key needed.
 *   (3) POST /inbox/conversations/:id/create-lead → lead created, external_contacts.leadId
 *       linked, conversation.unmatched = false
 *   (4) Second POST with same phone/email → 409 LEAD_EXISTS duplicate guard
 *
 * Run with:
 *   pnpm --filter @workspace/api-server exec tsx ./scripts/test-inbox-create-lead.ts
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  conversationsTable,
  messagesTable,
  externalContactsTable,
  leadsTable,
  usersTable,
} from "@workspace/db";

import inboxRouter, {
  __setAiLeadSuggestionOverrideForTests,
  type LeadExtractionResult,
} from "../src/routes/inbox.js";
import { processInboundMessage } from "../src/lib/inbox/processInbound.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RUN_ID = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
// Unique per-run email/phone so parallel or back-to-back runs never collide on the lead dedup guard.
const TEST_LEAD_EMAIL = `ayse.demir.${RUN_ID}@example.com`;
const TEST_LEAD_PHONE = `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;

// Real DB user seeded before tests so logAudit FK constraint is satisfied.
let ACTOR_USER_ID = 0;
before(async () => {
  const [u] = await db
    .insert(usersTable)
    .values({ email: `test-inbox-lead-actor-${RUN_ID}@test.internal` })
    .returning({ id: usersTable.id });
  ACTOR_USER_ID = u.id;
});

after(async () => {
  if (ACTOR_USER_ID) {
    await db.delete(usersTable).where(eq(usersTable.id, ACTOR_USER_ID));
  }
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
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
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

interface CreatedConv {
  conversationId: number;
  externalContactId: number;
  cleanup: () => Promise<void>;
}

async function createFakeInbound(): Promise<CreatedConv> {
  const result = await processInboundMessage({
    channel: "whatsapp",
    channelAccountId: null,
    contact: {
      externalId: `dev_test_ayse_${RUN_ID}`,
      displayName: "Ayse Demir",
      phone: "+90 532 111 2233",
    },
    message: {
      externalMessageId: `msg_ayse_${RUN_ID}`,
      text: "Merhaba, ben Ayse Demir, ayse.demir@example.com, +90 532 111 2233, Ingiltere'de yuksek lisans istiyorum",
    },
  });

  return {
    conversationId: result.conversationId,
    externalContactId: result.externalContactId,
    cleanup: async () => {
      // Clean up lead if created
      const [contact] = await db
        .select({ leadId: externalContactsTable.leadId })
        .from(externalContactsTable)
        .where(eq(externalContactsTable.id, result.externalContactId));
      if (contact?.leadId) {
        await db.delete(leadsTable).where(eq(leadsTable.id, contact.leadId));
      }
      await db.delete(messagesTable).where(eq(messagesTable.conversationId, result.conversationId));
      await db.delete(conversationsTable).where(eq(conversationsTable.id, result.conversationId));
      await db
        .delete(externalContactsTable)
        .where(eq(externalContactsTable.id, result.externalContactId));
    },
  };
}

// ---------------------------------------------------------------------------
// Test (1+2): Fake inbound conversation + lead-suggestion
// ---------------------------------------------------------------------------

test("(1) processInboundMessage creates unmatched conversation with correct external contact", async (t) => {
  const conv = await createFakeInbound();
  t.after(() => conv.cleanup());

  // Verify conversation is unmatched
  const [row] = await db
    .select({
      id: conversationsTable.id,
      unmatched: conversationsTable.unmatched,
      channel: conversationsTable.channel,
      externalContactId: conversationsTable.externalContactId,
    })
    .from(conversationsTable)
    .where(eq(conversationsTable.id, conv.conversationId));

  assert.ok(row, "conversation row must exist");
  assert.equal(row.channel, "whatsapp");
  assert.equal(row.unmatched, true, "fresh conversation from unknown number must be unmatched");
  assert.equal(row.externalContactId, conv.externalContactId);

  // Verify external contact
  const [contact] = await db
    .select()
    .from(externalContactsTable)
    .where(eq(externalContactsTable.id, conv.externalContactId));

  assert.ok(contact, "external contact must exist");
  assert.equal(contact.displayName, "Ayse Demir");
  assert.ok(contact.phone, "phone must be stored");
  assert.equal(contact.leadId, null, "contact must not be auto-linked (no matching lead)");

  // Verify message was stored
  const msgs = await db
    .select({ direction: messagesTable.direction, content: messagesTable.content })
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, conv.conversationId));

  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].direction, "inbound");
  assert.ok(msgs[0].content.includes("Ayse Demir"), "message must contain the test text");

  console.log(`  ✓ conversationId=${conv.conversationId}  externalContactId=${conv.externalContactId}`);
  console.log(`  ✓ channel=whatsapp  unmatched=true  leadId=null`);
  console.log(`  ✓ 1 inbound message stored`);
});

test("(2) GET lead-suggestion returns phone+displayName from contact and AI-extracted fullName+email", async (t) => {
  const conv = await createFakeInbound();
  t.after(() => {
    __setAiLeadSuggestionOverrideForTests(null);
    return conv.cleanup();
  });

  // Stub AI — simulates high-confidence extraction from "Merhaba, ben Ayse Demir, ayse.demir@example.com"
  const AI_STUB: LeadExtractionResult = {
    fullName: "Ayse Demir",
    email: "ayse.demir@example.com",
    fullNameConfidence: "high",
    emailConfidence: "high",
  };
  __setAiLeadSuggestionOverrideForTests(async (_input) => AI_STUB);

  const app = buildApp();
  const res = await request(app, "GET", `/api/inbox/conversations/${conv.conversationId}/lead-suggestion`);

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  const body = res.body as { suggestion: Record<string, unknown> };
  const s = body.suggestion;

  // From external_contacts
  assert.ok(s.phone, "phone must come from external_contacts");
  assert.equal(s.displayName, "Ayse Demir", "displayName must come from external_contacts");

  // From AI stub
  assert.equal(s.fullName, "Ayse Demir", "fullName must come from AI extraction");
  assert.equal(s.email, "ayse.demir@example.com", "email must come from AI extraction");

  // No lowConfidence flags (both were "high")
  assert.equal(s.fullNameLowConfidence, undefined, "fullNameLowConfidence must be absent for high-confidence result");
  assert.equal(s.emailLowConfidence, undefined, "emailLowConfidence must be absent for high-confidence result");

  console.log(`  ✓ suggestion.phone=${s.phone}`);
  console.log(`  ✓ suggestion.displayName=${s.displayName}`);
  console.log(`  ✓ suggestion.fullName=${s.fullName}  (AI, high confidence)`);
  console.log(`  ✓ suggestion.email=${s.email}  (AI, high confidence)`);
  console.log(`  ✓ fullNameLowConfidence=undefined  emailLowConfidence=undefined`);
});

test("(2b) lead-suggestion sets lowConfidence flags when AI confidence is low", async (t) => {
  const conv = await createFakeInbound();
  t.after(() => {
    __setAiLeadSuggestionOverrideForTests(null);
    return conv.cleanup();
  });

  __setAiLeadSuggestionOverrideForTests(async (_input) => ({
    fullName: "Ayse?",
    email: "maybe@example.com",
    fullNameConfidence: "low",
    emailConfidence: "low",
  }));

  const app = buildApp();
  const res = await request(app, "GET", `/api/inbox/conversations/${conv.conversationId}/lead-suggestion`);
  assert.equal(res.status, 200);
  const s = (res.body as { suggestion: Record<string, unknown> }).suggestion;

  assert.equal(s.fullNameLowConfidence, true, "fullNameLowConfidence must be true when AI says low");
  assert.equal(s.emailLowConfidence, true, "emailLowConfidence must be true when AI says low");

  console.log(`  ✓ fullNameLowConfidence=true  emailLowConfidence=true  (low confidence stub)`);
});

// ---------------------------------------------------------------------------
// Test (3): POST create-lead → DB state verification
// ---------------------------------------------------------------------------

test("(3) POST create-lead creates lead, links external_contacts.leadId, marks conversation matched", async (t) => {
  const conv = await createFakeInbound();
  t.after(() => conv.cleanup());

  const app = buildApp();
  const res = await request(app, "POST", `/api/inbox/conversations/${conv.conversationId}/create-lead`, {
    fullName: "Ayse Demir",
    email: TEST_LEAD_EMAIL,
    phone: TEST_LEAD_PHONE,
  });

  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  const body = res.body as { ok: boolean; leadId: number };
  assert.equal(body.ok, true);
  assert.ok(body.leadId, "leadId must be returned");

  // Verify external_contacts.leadId is linked
  const [contact] = await db
    .select({ leadId: externalContactsTable.leadId })
    .from(externalContactsTable)
    .where(eq(externalContactsTable.id, conv.externalContactId));
  assert.equal(contact.leadId, body.leadId, "external_contacts.leadId must point to the new lead");

  // Verify conversation.unmatched = false
  const [convRow] = await db
    .select({ unmatched: conversationsTable.unmatched })
    .from(conversationsTable)
    .where(eq(conversationsTable.id, conv.conversationId));
  assert.equal(convRow.unmatched, false, "conversation.unmatched must be false after lead creation");

  // Verify lead in DB
  const [lead] = await db
    .select({ id: leadsTable.id, firstName: leadsTable.firstName, lastName: leadsTable.lastName, email: leadsTable.email })
    .from(leadsTable)
    .where(eq(leadsTable.id, body.leadId));
  assert.ok(lead, "lead row must exist in DB");
  assert.equal(lead.firstName, "AYSE", "firstName must be uppercased (toLatinUpper)");
  assert.equal(lead.lastName, "DEMIR", "lastName must be uppercased");
  assert.equal(lead.email, TEST_LEAD_EMAIL);

  console.log(`  ✓ leadId=${body.leadId}  firstName=${lead.firstName}  lastName=${lead.lastName}`);
  console.log(`  ✓ external_contacts.leadId=${contact.leadId}  (linked)`);
  console.log(`  ✓ conversation.unmatched=false  (marked matched)`);
});

// ---------------------------------------------------------------------------
// Test (4): 409 duplicate guard
// ---------------------------------------------------------------------------

test("(4) second POST create-lead with same phone/email returns 409 LEAD_EXISTS", async (t) => {
  const conv = await createFakeInbound();
  let leadId: number | null = null;
  t.after(async () => {
    // cleanup lead separately since cleanup() reads leadId from DB
    if (leadId) await db.delete(leadsTable).where(eq(leadsTable.id, leadId));
    // zero out leadId on contact so cleanup() doesn't try to delete it again
    await db
      .update(externalContactsTable)
      .set({ leadId: null })
      .where(eq(externalContactsTable.id, conv.externalContactId));
    await conv.cleanup();
  });

  const app = buildApp();
  const body = {
    fullName: "Ayse Demir",
    email: TEST_LEAD_EMAIL,
    phone: TEST_LEAD_PHONE,
  };

  // First call — must succeed
  const first = await request(app, "POST", `/api/inbox/conversations/${conv.conversationId}/create-lead`, body);
  assert.equal(first.status, 201, `first call must return 201, got ${first.status}`);
  leadId = (first.body as { leadId: number }).leadId;

  // Create a second conversation for the same contact (same phone/email, new externalId)
  const conv2 = await processInboundMessage({
    channel: "whatsapp",
    channelAccountId: null,
    contact: {
      externalId: `dev_test_ayse2_${RUN_ID}`,
      displayName: "Ayse Demir",
      phone: "+90 532 111 2233",
    },
    message: {
      externalMessageId: `msg_ayse2_${RUN_ID}`,
      text: "Tekrar merhaba, ayse.demir@example.com hakkinda bilgi almak istiyorum",
    },
  });

  t.after(async () => {
    await db.delete(messagesTable).where(eq(messagesTable.conversationId, conv2.conversationId));
    await db.delete(conversationsTable).where(eq(conversationsTable.id, conv2.conversationId));
    await db
      .delete(externalContactsTable)
      .where(eq(externalContactsTable.id, conv2.externalContactId));
  });

  // Second call — must return 409
  const second = await request(app, "POST", `/api/inbox/conversations/${conv2.conversationId}/create-lead`, body);

  assert.equal(second.status, 409, `second call must return 409, got ${second.status}: ${JSON.stringify(second.body)}`);
  const err = second.body as { error: string; candidate: { id: number } };
  assert.equal(err.error, "LEAD_EXISTS", "error code must be LEAD_EXISTS");
  assert.ok(err.candidate, "candidate lead must be included in 409 response");
  assert.equal(err.candidate.id, leadId, "candidate must point to the lead we just created");

  console.log(`  ✓ first POST → 201  leadId=${leadId}`);
  console.log(`  ✓ second POST (same phone+email) → 409 LEAD_EXISTS`);
  console.log(`  ✓ candidate.id=${err.candidate.id}  (correctly identifies existing lead)`);
});
