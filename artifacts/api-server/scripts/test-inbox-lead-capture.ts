/**
 * AI Agent FAZ 3 — lead capture, document tracking & re-engagement templates.
 *
 * Verifies the funnel-advancing behavior of the intake bot WITHOUT any live
 * Anthropic call or real WhatsApp send. Every external seam is mocked:
 *   - structured extraction  → __setStructuredExtractionOverrideForTests
 *   - free-form reply        → __setBotReplyOverrideForTests
 *   - text send              → __setBotSendOverrideForTests
 *   - template send          → __setBotTemplateSendOverrideForTests
 *
 * Coverage:
 *   - extractStructuredLead honors the override and nullifies blank fields.
 *   - captureLeadFromConversation creates a lead from extracted fields, links
 *     the contact + clears conversation.unmatched, and advances the stage.
 *   - Idempotency: a second conversation with the SAME email reuses the same
 *     lead — never a duplicate.
 *   - Stage advancement is forward-only: a qualified/converted lead is never
 *     pulled back.
 *   - Document tracking: inbound media → one documents row (idempotent by WA
 *     media id); missing-doc computation reflects what's been provided.
 *   - Outside the 24h window: an approved re-engagement template is sent (text
 *     reply seam untouched); with no template configured the bot defers.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:inbox-lead-capture
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  db,
  conversationsTable,
  messagesTable,
  externalContactsTable,
  channelAccountsTable,
  leadsTable,
  documentsTable,
  messageTemplatesTable,
} from "@workspace/db";
import { and, eq, like } from "drizzle-orm";
import {
  maybeAutoReply,
  __setBotReplyOverrideForTests,
  __setBotSendOverrideForTests,
  __setBotTemplateSendOverrideForTests,
  type BotSendInput,
  type BotTemplateSendInput,
} from "../src/lib/inbox/botAutoReply";
import {
  extractStructuredLead,
  captureLeadFromConversation,
  recordInboundDocuments,
  computeMissingDocGroups,
  detectDocType,
  normalizeLevel,
  advanceStage,
  __setStructuredExtractionOverrideForTests,
  type StructuredLeadFields,
} from "../src/lib/inbox/leadCapture";
import { __setAiAgentConfigOverrideForTests } from "../src/lib/inbox/aiAgentConfig";

const RUN_ID = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------------------
// Mocked external seams
// ---------------------------------------------------------------------------
let textSendCalls: BotSendInput[] = [];
let templateSendCalls: BotTemplateSendInput[] = [];
let sendSeq = 0;
let templateSendOk = true;

const EMPTY: StructuredLeadFields = {
  firstName: null,
  lastName: null,
  email: null,
  motherName: null,
  fatherName: null,
  program: null,
  language: null,
  country: null,
  budget: null,
  level: null,
};
let nextExtraction: StructuredLeadFields = { ...EMPTY };

__setStructuredExtractionOverrideForTests(async () => ({ ...nextExtraction }));
__setBotReplyOverrideForTests(async () => "Mock intake reply");
__setAiAgentConfigOverrideForTests({
  enabled: true,
  externalAutoReplyEnabled: true,
  scheduleEnabled: false,
});
__setBotSendOverrideForTests(async (input) => {
  textSendCalls.push(input);
  return { ok: true, externalMessageId: `mock_txt_${RUN_ID}_${sendSeq++}` };
});
__setBotTemplateSendOverrideForTests(async (input) => {
  templateSendCalls.push(input);
  return templateSendOk
    ? { ok: true, externalMessageId: `mock_tpl_${RUN_ID}_${sendSeq++}` }
    : { ok: false, error: "simulated_template_failure" };
});

function resetMocks(): void {
  textSendCalls = [];
  templateSendCalls = [];
  templateSendOk = true;
  nextExtraction = { ...EMPTY };
}

// ---------------------------------------------------------------------------
// DB seeding
// ---------------------------------------------------------------------------
const createdConvIds: number[] = [];
const createdContactIds: number[] = [];
let channelAccountId = 0;
let seedCounter = 0;

async function ensureChannelAccount(): Promise<number> {
  if (channelAccountId) return channelAccountId;
  const [created] = await db
    .insert(channelAccountsTable)
    .values({
      channel: "whatsapp",
      displayName: "Lead Capture WA",
      externalAccountId: `wa_lc_${RUN_ID}`,
      status: "active",
    })
    .returning({ id: channelAccountsTable.id });
  channelAccountId = created.id;
  return channelAccountId;
}

async function seedConversation(opts: {
  botEnabled?: boolean;
  lastInboundAt?: Date;
  email?: string;
  phone?: string;
  displayName?: string;
}): Promise<{ conversationId: number; contactId: number; phone: string }> {
  const accId = await ensureChannelAccount();
  const n = seedCounter++;
  const suffix = `${RUN_ID}_${n}_${Math.random().toString(36).slice(2, 7)}`;
  const phone = opts.phone ?? `+1556${String(n).padStart(3, "0")}${Math.floor(Math.random() * 9000 + 1000)}`;
  const [contact] = await db
    .insert(externalContactsTable)
    .values({
      channel: "whatsapp",
      externalId: `lc_contact_${suffix}`,
      displayName: opts.displayName ?? `Lead Capture ${suffix}`,
      phone,
      phoneE164: phone,
      email: opts.email ?? null,
    })
    .returning({ id: externalContactsTable.id });
  createdContactIds.push(contact.id);

  const [conv] = await db
    .insert(conversationsTable)
    .values({
      type: "inbox",
      channel: "whatsapp",
      channelAccountId: accId,
      externalContactId: contact.id,
      externalThreadId: `lc_thread_${suffix}`,
      status: "open",
      unmatched: true,
      botEnabled: opts.botEnabled ?? true,
      lastInboundAt: opts.lastInboundAt ?? new Date(),
    })
    .returning({ id: conversationsTable.id });
  createdConvIds.push(conv.id);
  return { conversationId: conv.id, contactId: contact.id, phone };
}

async function seedInbound(
  conversationId: number,
  content: string,
  metadata?: Record<string, unknown>,
): Promise<number> {
  const [msg] = await db
    .insert(messagesTable)
    .values({
      conversationId,
      content,
      channel: "whatsapp",
      direction: "inbound",
      status: "received",
      ...(metadata ? { metadata } : {}),
    })
    .returning({ id: messagesTable.id });
  return msg.id;
}

async function leadCountByEmail(email: string): Promise<number> {
  const rows = await db.select({ id: leadsTable.id }).from(leadsTable).where(eq(leadsTable.email, email));
  return rows.length;
}

async function outboundRows(conversationId: number) {
  return db
    .select()
    .from(messagesTable)
    .where(and(eq(messagesTable.conversationId, conversationId), eq(messagesTable.direction, "outbound")));
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
test("normalizeLevel maps EN/TR study levels to doc-equivalence keys", () => {
  assert.equal(normalizeLevel("master"), "masters");
  assert.equal(normalizeLevel("Yüksek Lisans"), "masters");
  assert.equal(normalizeLevel("bachelor"), "bachelors");
  assert.equal(normalizeLevel("lisans"), "bachelors");
  assert.equal(normalizeLevel("PhD"), "phd");
  assert.equal(normalizeLevel("associate degree"), "pre_bachelors");
  assert.equal(normalizeLevel("something weird"), null);
  assert.equal(normalizeLevel(null), null);
});

test("advanceStage is forward-only and never pulls back terminal stages", () => {
  assert.equal(advanceStage("new", "interested"), "interested");
  assert.equal(advanceStage("qualified", "interested"), "qualified");
  assert.equal(advanceStage("contacted", "qualified"), "qualified");
  assert.equal(advanceStage("converted", "qualified"), "converted");
  assert.equal(advanceStage("lost", "interested"), "lost");
});

test("detectDocType recognizes common documents from filename", () => {
  assert.equal(detectDocType("passport_scan.pdf", null), "passport");
  assert.equal(detectDocType("my-photo.jpg", null), "photo");
  assert.equal(detectDocType(null, "Here is my IELTS result"), "ielts_pte_gre_gmat_toefl_duolingo");
  assert.equal(detectDocType("random.bin", null), "other_certificates_documents");
});

// ---------------------------------------------------------------------------
// Structured extraction
// ---------------------------------------------------------------------------
test("extractStructuredLead honors override and nullifies blank fields", async () => {
  __setStructuredExtractionOverrideForTests(async () => ({
    ...EMPTY,
    firstName: "  Ali  ",
    lastName: "",
    email: "ALI@example.com",
    program: "Computer Engineering",
  }));
  const out = await extractStructuredLead({ transcript: "hi" });
  assert.equal(out.firstName, "Ali");
  assert.equal(out.lastName, null);
  assert.equal(out.email, "ALI@example.com");
  assert.equal(out.program, "Computer Engineering");
  // restore default override for the remaining tests
  __setStructuredExtractionOverrideForTests(async () => ({ ...nextExtraction }));
});

// ---------------------------------------------------------------------------
// Lead upsert
// ---------------------------------------------------------------------------
test("captureLeadFromConversation creates a lead, links contact, advances stage", async () => {
  resetMocks();
  const email = `new.${RUN_ID}@example.com`;
  const { conversationId, contactId } = await seedConversation({});
  await seedInbound(conversationId, "I want to study Computer Engineering in Turkey");
  nextExtraction = {
    ...EMPTY,
    firstName: "Sara",
    lastName: "Khan",
    email,
    program: "Computer Engineering",
    country: "Turkey",
    level: "bachelor",
    language: "English",
  };

  const result = await captureLeadFromConversation({ conversationId });
  assert.equal(result.created, true);
  assert.ok(result.leadId);
  assert.equal(result.stage, "qualified");
  assert.equal(result.level, "bachelors");

  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, result.leadId!));
  assert.equal(lead.email, email);
  assert.equal(lead.interestedProgram, "Computer Engineering");
  assert.equal(lead.interestedLevel, "bachelor");
  assert.equal(lead.preferredLanguage, "English");
  assert.equal(lead.status, "qualified");

  const [contact] = await db
    .select()
    .from(externalContactsTable)
    .where(eq(externalContactsTable.id, contactId));
  assert.equal(contact.leadId, result.leadId);
  const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, conversationId));
  assert.equal(conv.unmatched, false);
});

test("captureLeadFromConversation is idempotent across conversations (same email → one lead)", async () => {
  resetMocks();
  const email = `dup.${RUN_ID}@example.com`;
  nextExtraction = { ...EMPTY, firstName: "Omar", lastName: "Ali", email, program: "Medicine", level: "bachelor" };

  const a = await seedConversation({});
  await seedInbound(a.conversationId, "I want Medicine");
  const first = await captureLeadFromConversation({ conversationId: a.conversationId });
  assert.equal(first.created, true);

  // Second, different conversation + contact, but the extractor returns the SAME email.
  const b = await seedConversation({});
  await seedInbound(b.conversationId, "Medicine please");
  const second = await captureLeadFromConversation({ conversationId: b.conversationId });
  assert.equal(second.created, false, "second capture must NOT create a duplicate lead");
  assert.equal(second.leadId, first.leadId);
  assert.equal(await leadCountByEmail(email), 1);
});

test("captureLeadFromConversation never downgrades a qualified lead", async () => {
  resetMocks();
  const email = `qual.${RUN_ID}@example.com`;
  // Pre-seed a qualified lead matched by email.
  const [seeded] = await db
    .insert(leadsTable)
    .values({ firstName: "PRE", lastName: "QUAL", email, status: "qualified", source: "whatsapp" })
    .returning({ id: leadsTable.id });

  const { conversationId } = await seedConversation({ email });
  await seedInbound(conversationId, "hello");
  // Minimal extraction → would otherwise compute "contacted".
  nextExtraction = { ...EMPTY, email };
  const result = await captureLeadFromConversation({ conversationId });
  assert.equal(result.leadId, seeded.id);
  assert.equal(result.stage, "qualified", "stage must not regress");
});

test("two concurrent captures with mixed identity (email vs phone-only) create ONE lead", async () => {
  resetMocks();
  // maybeAutoReply is fire-and-forget, so two inbound messages for the same
  // person can run captureLeadFromConversation in parallel. They share a phone
  // but only one extracts an email — the advisory lock + recheck must still
  // collapse them into a single lead.
  const sharedPhone = `+90555${RUN_ID.replace(/[^0-9]/g, "").slice(0, 6).padEnd(6, "0")}`;
  const sharedEmail = `race.${RUN_ID}@example.com`;
  const marker = `EMAILMARK_${RUN_ID}`;

  // Custom override: only the conversation whose transcript carries the marker
  // yields an email; the other yields nothing (phone-only identity).
  __setStructuredExtractionOverrideForTests(async ({ transcript }) =>
    transcript.includes(marker)
      ? { ...EMPTY, firstName: "Race", lastName: "Test", email: sharedEmail, level: "bachelor" }
      : { ...EMPTY, level: "bachelor" },
  );

  const a = await seedConversation({ phone: sharedPhone });
  await seedInbound(a.conversationId, `${marker} I want to apply`);
  const b = await seedConversation({ phone: sharedPhone });
  await seedInbound(b.conversationId, "I want to apply too");

  const [ra, rb] = await Promise.all([
    captureLeadFromConversation({ conversationId: a.conversationId }),
    captureLeadFromConversation({ conversationId: b.conversationId }),
  ]);

  // Restore the default extraction override for subsequent tests.
  __setStructuredExtractionOverrideForTests(async () => ({ ...nextExtraction }));

  const rows = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .where(eq(leadsTable.phoneE164, sharedPhone));
  assert.equal(rows.length, 1, "concurrent captures must collapse into exactly one lead");
  // Both captures resolve to the same lead id.
  assert.equal(ra.leadId, rb.leadId);
  assert.equal(ra.leadId, rows[0].id);
  // Exactly one of the two reports created:true.
  assert.equal([ra.created, rb.created].filter(Boolean).length, 1);
});

// ---------------------------------------------------------------------------
// Document tracking
// ---------------------------------------------------------------------------
test("recordInboundDocuments stores a documents row idempotently; missing-doc list reflects it", async () => {
  resetMocks();
  const email = `doc.${RUN_ID}@example.com`;
  const { conversationId } = await seedConversation({});
  await seedInbound(conversationId, "here is my passport");
  nextExtraction = { ...EMPTY, firstName: "Maya", lastName: "Roy", email, level: "bachelor" };
  const capture = await captureLeadFromConversation({ conversationId });
  assert.ok(capture.leadId);

  const mediaId = `wamedia_${RUN_ID}`;
  const metadata = {
    raw: { type: "document", document: { id: mediaId, filename: "passport.pdf", mime_type: "application/pdf" } },
  };
  const created1 = await recordInboundDocuments({ metadata, leadId: capture.leadId, studentId: null });
  assert.equal(created1, 1);
  // Idempotent: same WA media id is not recorded twice.
  const created2 = await recordInboundDocuments({ metadata, leadId: capture.leadId, studentId: null });
  assert.equal(created2, 0);

  const docs = await db
    .select()
    .from(documentsTable)
    .where(eq(documentsTable.fileKey, `wa:${mediaId}`));
  assert.equal(docs.length, 1);
  assert.equal(docs[0].type, "passport");
  assert.equal(docs[0].leadId, capture.leadId);

  const missing = await computeMissingDocGroups({ leadId: capture.leadId, studentId: null, level: "bachelors" });
  assert.ok(!missing.includes("passport"), "passport already provided → not missing");
  assert.ok(missing.length > 0, "other level-appropriate docs are still missing");
});

// ---------------------------------------------------------------------------
// Outside-24h-window re-engagement template
// ---------------------------------------------------------------------------
test("outside 24h window → approved re-engagement template is sent (not a free-form reply)", async () => {
  resetMocks();
  const templateName = `reengage_${RUN_ID}`;
  await db.insert(messageTemplatesTable).values({
    name: `Re-engage ${RUN_ID}`,
    category: "reengagement",
    content: "We'd love to continue helping with your application!",
    channel: "whatsapp",
    language: "en",
    externalTemplateName: templateName,
    isActive: true,
  });

  const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const { conversationId } = await seedConversation({ lastInboundAt: past });
  const msgId = await seedInbound(conversationId, "still interested?");
  nextExtraction = { ...EMPTY, firstName: "Lina", lastName: "Park" };

  const outcome = await maybeAutoReply({ conversationId, inboundMessageId: msgId });
  assert.equal(outcome.reason, "template_sent");
  assert.equal(outcome.acted, true);
  assert.equal(templateSendCalls.length, 1);
  assert.equal(templateSendCalls[0].templateName, templateName);
  assert.equal(textSendCalls.length, 0, "no free-form text send outside the window");

  const out = await outboundRows(conversationId);
  assert.equal(out.length, 1);
  assert.equal(out[0].status, "sent");
  assert.equal((out[0].metadata as Record<string, unknown>)?.botTemplate, true);
});

test("outside 24h window with NO template configured → bot defers", async () => {
  resetMocks();
  // Deactivate any re-engagement template so resolution finds none.
  await db
    .update(messageTemplatesTable)
    .set({ isActive: false })
    .where(eq(messageTemplatesTable.category, "reengagement"));

  const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const { conversationId } = await seedConversation({ lastInboundAt: past });
  const msgId = await seedInbound(conversationId, "hello again");
  nextExtraction = { ...EMPTY };

  const outcome = await maybeAutoReply({ conversationId, inboundMessageId: msgId });
  assert.equal(outcome.reason, "outside_window");
  assert.equal(templateSendCalls.length, 0);
  assert.equal(textSendCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
test("cleanup", async () => {
  for (const id of createdConvIds) {
    await db.delete(messagesTable).where(eq(messagesTable.conversationId, id));
    await db.delete(conversationsTable).where(eq(conversationsTable.id, id));
  }
  for (const id of createdContactIds) {
    await db.delete(externalContactsTable).where(eq(externalContactsTable.id, id));
  }
  await db.delete(documentsTable).where(like(documentsTable.fileKey, `wa:wamedia_${RUN_ID}%`));
  await db.delete(leadsTable).where(like(leadsTable.email, `%${RUN_ID}%`));
  await db.delete(messageTemplatesTable).where(eq(messageTemplatesTable.name, `Re-engage ${RUN_ID}`));
  __setStructuredExtractionOverrideForTests(null);
  __setBotReplyOverrideForTests(null);
  __setBotSendOverrideForTests(null);
  __setBotTemplateSendOverrideForTests(null);
  __setAiAgentConfigOverrideForTests(null);
});

// Force a clean process exit once all tests finish — lingering db pool / inbox
// bus handles otherwise keep node:test alive and the chain hangs (matches the
// teardown pattern in test-inbox-bot.ts / test-meta-dm.ts).
after(() => {
  setImmediate(() => process.exit(process.exitCode ?? 0));
});
