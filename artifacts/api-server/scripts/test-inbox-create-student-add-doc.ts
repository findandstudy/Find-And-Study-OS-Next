/**
 * Task #635 — Unmatched inbox: Create Student + Add Document flow.
 *
 * Verifies the three sequential backend steps (match conversation →
 * save-as-document) and the key invariant: partial failure in the
 * save-as-document step MUST NOT roll back a successfully linked student.
 *
 * Coverage:
 *   1. POST /inbox/conversations/:id/match — happy path clears unmatched flag
 *      and links studentId on the external contact.
 *   2. POST /inbox/conversations/:id/match — 400 when required params missing.
 *   3. POST /inbox/conversations/:id/match — 404 when conversation doesn't exist.
 *   4. POST …/save-as-document — 400 for invalid documentType.
 *   5. POST …/save-as-document — 400 for invalid ownerType.
 *   6. POST …/save-as-document — 404 when message has no attachment metadata.
 *   7. Partial-failure invariant: student row and conversation link survive
 *      when save-as-document fails (404 — no attachment URL in message).
 *   8. Duplicate-attachment guard: second save-as-document with the same
 *      source returns 409, not a second document row.
 *   9. POST /students — modal creates a student with required name fields.
 *  10. Save-as-document conflict: same doc-type on same owner → 200 {conflict:true}
 *      (not an error; frontend uses this to prompt "Add as New Version").
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:inbox-create-student-add-doc
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express, type Request } from "express";
import {
  db,
  usersTable,
  leadsTable,
  studentsTable,
  channelAccountsTable,
  externalContactsTable,
  conversationsTable,
  messagesTable,
  documentsTable,
  catalogOptionsTable,
} from "@workspace/db";
import { and, eq, like } from "drizzle-orm";

import inboxRouter from "../src/routes/inbox.js";
import studentsRouter from "../src/routes/students.js";
import { invalidateDocCatalog } from "../src/lib/docCatalog.js";

// ---------------------------------------------------------------------------
// Per-run unique ID so parallel test runs never collide.
// ---------------------------------------------------------------------------
const RUN_ID = `cad_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

// ---------------------------------------------------------------------------
// Mutable auth injection — no real auth stack needed.
// ---------------------------------------------------------------------------
let currentUser: { id: number; role: string; isActive: boolean; emailVerified: boolean } = {
  id: 0,
  role: "staff",
  isActive: true,
  emailVerified: true,
};

function buildApp(): Express {
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>).user = currentUser;
    next();
  });
  app.use("/api", inboxRouter);
  app.use("/api", studentsRouter);
  return app;
}

const app = buildApp();

// Start a single persistent server on an OS-assigned port.
let port = 0;
let server: http.Server;

before(async () => {
  server = http.createServer(app as unknown as (req: Request, res: unknown) => void);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server.listen failed");
  port = addr.port;
});

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
async function api(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: unknown;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

// ---------------------------------------------------------------------------
// Seeding helpers
// ---------------------------------------------------------------------------
const cleanupStudentIds: number[] = [];
const cleanupLeadIds: number[] = [];
const cleanupContactIds: number[] = [];
const cleanupConvIds: number[] = [];
const cleanupCatalogOptionIds: number[] = [];
let sharedChannelAccountId = 0;
let sharedStaffUserId = 0;
let seedSeq = 0;

async function ensureChannelAccount(): Promise<number> {
  if (sharedChannelAccountId) return sharedChannelAccountId;
  const [row] = await db
    .insert(channelAccountsTable)
    .values({
      channel: "whatsapp",
      displayName: `CAD Test WA ${RUN_ID}`,
      externalAccountId: `wa_cad_${RUN_ID}`,
      status: "active",
    })
    .returning({ id: channelAccountsTable.id });
  sharedChannelAccountId = row.id;
  return row.id;
}

async function ensureStaffUser(): Promise<number> {
  if (sharedStaffUserId) return sharedStaffUserId;
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `cad_staff_${RUN_ID}@test.invalid`,
      firstName: "CAD",
      lastName: "Staff",
      role: "staff",
      isActive: true,
      emailVerified: true,
      passwordHash: "x",
    })
    .returning({ id: usersTable.id });
  sharedStaffUserId = row.id;
  currentUser = { id: row.id, role: "staff", isActive: true, emailVerified: true };
  return row.id;
}

interface SeedResult {
  contactId: number;
  convId: number;
  msgId: number;
}

async function seedUnmatchedConversation(opts: {
  attachmentMeta?: Record<string, unknown>;
} = {}): Promise<SeedResult> {
  const accId = await ensureChannelAccount();
  const n = seedSeq++;
  const suffix = `${RUN_ID}_${n}`;

  const [contact] = await db
    .insert(externalContactsTable)
    .values({
      channel: "whatsapp",
      externalId: `cad_ext_${suffix}`,
      displayName: `CAD Test ${suffix}`,
      phone: `+155${String(Date.now()).slice(-9)}`,
      phoneE164: `+155${String(Date.now()).slice(-9)}`,
    })
    .returning({ id: externalContactsTable.id });
  cleanupContactIds.push(contact.id);

  const [conv] = await db
    .insert(conversationsTable)
    .values({
      type: "inbox",
      channel: "whatsapp",
      channelAccountId: accId,
      externalContactId: contact.id,
      externalThreadId: `cad_thread_${suffix}`,
      status: "open",
      unmatched: true,
    })
    .returning({ id: conversationsTable.id });
  cleanupConvIds.push(conv.id);

  const [msg] = await db
    .insert(messagesTable)
    .values({
      conversationId: conv.id,
      content: "Test attachment message",
      channel: "whatsapp",
      direction: "inbound",
      status: "received",
      metadata: opts.attachmentMeta ?? {},
    })
    .returning({ id: messagesTable.id });

  return { contactId: contact.id, convId: conv.id, msgId: msg.id };
}

async function seedStudent(): Promise<number> {
  const [row] = await db
    .insert(studentsTable)
    .values({
      firstName: `CAD_F_${RUN_ID}_${seedSeq}`,
      lastName: `CAD_L_${RUN_ID}_${seedSeq++}`,
      email: `cad_stu_${RUN_ID}_${seedSeq}@test.invalid`,
      motherName: "Test Mother",
      fatherName: "Test Father",
      status: "active",
      origin: { source: "staff" },
    })
    .returning({ id: studentsTable.id });
  cleanupStudentIds.push(row.id);
  return row.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("match endpoint — happy path: clears unmatched, links studentId", async () => {
  await ensureStaffUser();
  const { contactId, convId } = await seedUnmatchedConversation();
  const studentId = await seedStudent();

  const res = await api("POST", `/api/inbox/conversations/${convId}/match`, {
    type: "student",
    entityId: studentId,
  });

  assert.equal(res.status, 200, `Expected 200 but got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.deepEqual((res.body as Record<string, unknown>).ok, true);

  // Conversation must have unmatched=false
  const [updatedConv] = await db
    .select({ unmatched: conversationsTable.unmatched })
    .from(conversationsTable)
    .where(eq(conversationsTable.id, convId));
  assert.equal(updatedConv.unmatched, false, "conversation.unmatched should be false after match");

  // External contact must have studentId linked
  const [updatedContact] = await db
    .select({ studentId: externalContactsTable.studentId })
    .from(externalContactsTable)
    .where(eq(externalContactsTable.id, contactId));
  assert.equal(updatedContact.studentId, studentId, "externalContact.studentId should be set");
});

test("conversation detail resolves the student from a converted lead", async () => {
  await ensureStaffUser();
  const { contactId, convId } = await seedUnmatchedConversation();
  const studentId = await seedStudent();
  const suffix = `${RUN_ID}_${seedSeq++}`;
  const [lead] = await db
    .insert(leadsTable)
    .values({
      firstName: "Converted",
      lastName: `Lead_${suffix}`,
      email: `converted_lead_${suffix}@test.invalid`,
      status: "converted",
      convertedStudentId: studentId,
      assignedToId: sharedStaffUserId,
    })
    .returning({ id: leadsTable.id });
  cleanupLeadIds.push(lead.id);
  await db
    .update(externalContactsTable)
    .set({ leadId: lead.id, studentId: null })
    .where(eq(externalContactsTable.id, contactId));

  const res = await api("GET", `/api/inbox/conversations/${convId}`);
  assert.equal(res.status, 200, `Expected 200 but got ${res.status}: ${JSON.stringify(res.body)}`);
  const body = res.body as { lead?: { id?: number }; student?: { id?: number } };
  assert.equal(body.lead?.id, lead.id, "converted lead remains available for history");
  assert.equal(body.student?.id, studentId, "canonical student is resolved from lead.convertedStudentId");
});

test("match endpoint — 400 when required params missing", async () => {
  await ensureStaffUser();
  const { convId } = await seedUnmatchedConversation();

  const res = await api("POST", `/api/inbox/conversations/${convId}/match`, {});
  assert.equal(res.status, 400, `Expected 400 but got ${res.status}`);
});

test("match endpoint — 404 when conversation doesn't exist", async () => {
  await ensureStaffUser();
  const res = await api("POST", `/api/inbox/conversations/999999999/match`, {
    type: "student",
    entityId: 1,
  });
  assert.equal(res.status, 404, `Expected 404 but got ${res.status}`);
});

test("save-as-document — 400 for invalid documentType", async () => {
  await ensureStaffUser();
  const { convId, msgId } = await seedUnmatchedConversation();
  const studentId = await seedStudent();

  const res = await api(
    "POST",
    `/api/inbox/conversations/${convId}/messages/${msgId}/attachments/0/save-as-document`,
    { ownerType: "student", ownerId: studentId, documentType: "not_a_valid_type" },
  );
  assert.equal(res.status, 400, `Expected 400 but got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(
    String((res.body as Record<string, unknown>).error).includes("documentType"),
    `Error should mention 'documentType', got: ${JSON.stringify(res.body)}`,
  );
});

test("save-as-document — accepts an active admin-catalog documentType", async () => {
  await ensureStaffUser();
  const dynamicDocumentType = `cad_master_${RUN_ID}`.slice(0, 64);
  const [catalogRow] = await db
    .insert(catalogOptionsTable)
    .values({
      category: "documents",
      value: dynamicDocumentType,
      sortOrder: 9999,
      isActive: true,
      metadata: {
        label: "Dynamic Master Document",
        icon: "📎",
        accept: ".pdf,.jpg,.jpeg,.png",
      },
    })
    .returning({ id: catalogOptionsTable.id });
  cleanupCatalogOptionIds.push(catalogRow.id);
  invalidateDocCatalog();

  const { convId, msgId } = await seedUnmatchedConversation();
  const studentId = await seedStudent();
  const res = await api(
    "POST",
    `/api/inbox/conversations/${convId}/messages/${msgId}/attachments/0/save-as-document`,
    { ownerType: "student", ownerId: studentId, documentType: dynamicDocumentType },
  );

  // No attachment metadata means the request should now reach the attachment
  // lookup (404). The old hardcoded whitelist rejected this valid catalog key
  // earlier with 400 before it could get this far.
  assert.equal(
    res.status,
    404,
    `Active catalog documentType should pass validation, got ${res.status}: ${JSON.stringify(res.body)}`,
  );
});

test("save-as-document — 400 for invalid ownerType", async () => {
  await ensureStaffUser();
  const { convId, msgId } = await seedUnmatchedConversation();
  const studentId = await seedStudent();

  const res = await api(
    "POST",
    `/api/inbox/conversations/${convId}/messages/${msgId}/attachments/0/save-as-document`,
    { ownerType: "unknown_type", ownerId: studentId, documentType: "diploma_certificate" },
  );
  assert.equal(res.status, 400, `Expected 400 but got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(
    String((res.body as Record<string, unknown>).error).includes("ownerType"),
    `Error should mention 'ownerType', got: ${JSON.stringify(res.body)}`,
  );
});

test("save-as-document — 404 when message has no attachment metadata", async () => {
  await ensureStaffUser();
  // Message with empty metadata → no attachment URL and no WA media id
  const { convId, msgId } = await seedUnmatchedConversation({ attachmentMeta: {} });
  const studentId = await seedStudent();

  const res = await api(
    "POST",
    `/api/inbox/conversations/${convId}/messages/${msgId}/attachments/0/save-as-document`,
    { ownerType: "student", ownerId: studentId, documentType: "diploma_certificate" },
  );
  assert.equal(res.status, 404, `Expected 404 but got ${res.status}: ${JSON.stringify(res.body)}`);
});

test("partial-failure invariant: student + conversation link survive save-as-document 404", async () => {
  /**
   * This is the key behavioral invariant of Task #629.
   *
   * The modal orchestrates three sequential steps client-side:
   *   1. POST /api/students → creates the student
   *   2. POST /api/inbox/conversations/:id/match → links the student
   *   3. POST …/save-as-document → saves the attachment as a document
   *
   * Step 3 MUST NOT roll back step 1 or step 2 — they are independent
   * server calls. A failure in step 3 leaves the student created and the
   * conversation linked (the modal shows a "successDocFailed" toast).
   *
   * This test simulates the exact state the system would be in:
   *   - Student row exists after a successful step 1
   *   - Conversation is linked after step 2
   *   - Step 3 fails with 404 (no attachment URL in message)
   *   → Student row STILL EXISTS; conversation STILL LINKED
   */
  await ensureStaffUser();
  const { contactId, convId, msgId } = await seedUnmatchedConversation({ attachmentMeta: {} });
  const studentId = await seedStudent();

  // Step 2: match the conversation (simulates a successful step 1→2)
  const matchRes = await api("POST", `/api/inbox/conversations/${convId}/match`, {
    type: "student",
    entityId: studentId,
  });
  assert.equal(matchRes.status, 200, `Match should succeed, got ${matchRes.status}`);

  // Step 3: save-as-document → FAILS (no attachment URL)
  const saveRes = await api(
    "POST",
    `/api/inbox/conversations/${convId}/messages/${msgId}/attachments/0/save-as-document`,
    { ownerType: "student", ownerId: studentId, documentType: "diploma_transcript" },
  );
  assert.equal(saveRes.status, 404, `save-as-document should return 404 for empty metadata`);

  // INVARIANT: student row still exists
  const [student] = await db
    .select({ id: studentsTable.id })
    .from(studentsTable)
    .where(eq(studentsTable.id, studentId));
  assert.ok(student, "Student row must still exist after save-as-document failure");

  // INVARIANT: conversation is still linked (unmatched=false)
  const [conv] = await db
    .select({ unmatched: conversationsTable.unmatched, studentId: externalContactsTable.studentId })
    .from(conversationsTable)
    .innerJoin(externalContactsTable, eq(externalContactsTable.id, conversationsTable.externalContactId))
    .where(eq(conversationsTable.id, convId));
  assert.equal(conv.unmatched, false, "Conversation must still be matched");
  assert.equal(conv.studentId, studentId, "External contact must still link to the student");

  // INVARIANT: no partial document row was written
  const docs = await db
    .select({ id: documentsTable.id })
    .from(documentsTable)
    .where(and(eq(documentsTable.studentId, studentId)));
  assert.equal(docs.length, 0, "No document row should exist when save-as-document failed");

  // The contact is already in cleanupContactIds via seedUnmatchedConversation.
});

test("save-as-document duplicate guard: second call returns 409", async () => {
  /**
   * The endpoint tracks source_attachment_id = `${msgId}:${attachIdx}`.
   * If the same attachment is saved twice for the same owner, the second
   * call returns 409 — not a second document row.
   *
   * The dup guard fires BEFORE the media download step, so using a
   * non-reachable URL in attachment metadata is sufficient to reach it.
   * We insert a documents row with the same sourceAttachmentId directly
   * so no actual download or upload ever happens.
   */
  await ensureStaffUser();
  // Message needs an attachment URL so the endpoint reaches the dup-guard
  // (the "Attachment not found" check fires before the dup check).
  const { convId, msgId } = await seedUnmatchedConversation({
    attachmentMeta: { attachment: { url: "https://example.invalid/fake.jpg", name: "test.jpg" } },
  });
  const studentId = await seedStudent();

  const sourceAttachmentId = `${msgId}:0`;

  await db.insert(documentsTable).values({
    studentId,
    type: "diploma_certificate",
    name: `Dup guard test ${RUN_ID}`,
    fileKey: `test/cad_dup_${RUN_ID}.pdf`,
    sourceAttachmentId,
  });

  // Now hit the endpoint — even before media download, the dup check fires
  const res = await api(
    "POST",
    `/api/inbox/conversations/${convId}/messages/${msgId}/attachments/0/save-as-document`,
    { ownerType: "student", ownerId: studentId, documentType: "diploma_certificate" },
  );
  assert.equal(res.status, 409, `Expected 409 for duplicate attachment, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(
    (res.body as Record<string, unknown>).existingDocumentId,
    "Response must include existingDocumentId",
  );
});

test("save-as-document conflict guard: same doc-type returns {conflict:true}", async () => {
  /**
   * When a student already has a diploma and force=false, the endpoint
   * returns 200 {conflict:true, existingDocumentId} so the frontend can
   * prompt "Replace or Add New Version". This is not an error code — the
   * modal must handle it as a confirmation step (not a thrown error).
   *
   * The conflict check fires BEFORE the media download step, so using a
   * non-reachable URL in attachment metadata is sufficient to reach it.
   */
  await ensureStaffUser();
  // Message needs an attachment URL so the endpoint reaches the conflict check
  // (the "Attachment not found" check fires before the conflict check).
  const { convId, msgId } = await seedUnmatchedConversation({
    attachmentMeta: { attachment: { url: "https://example.invalid/diploma.pdf", name: "diploma.pdf" } },
  });
  const studentId = await seedStudent();

  // Pre-existing diploma_certificate (no sourceAttachmentId so the dup-guard doesn't fire first)
  const [existingDoc] = await db
    .insert(documentsTable)
    .values({
      studentId,
      type: "diploma_certificate",
      name: `Existing diploma_certificate ${RUN_ID}`,
      fileKey: `test/cad_existing_${RUN_ID}.pdf`,
    })
    .returning({ id: documentsTable.id });

  const res = await api(
    "POST",
    `/api/inbox/conversations/${convId}/messages/${msgId}/attachments/0/save-as-document`,
    { ownerType: "student", ownerId: studentId, documentType: "diploma_certificate", force: false },
  );
  assert.equal(res.status, 200, `Expected 200 {conflict:true}, got ${res.status}: ${JSON.stringify(res.body)}`);
  const body = res.body as Record<string, unknown>;
  assert.equal(body.conflict, true, "Expected conflict:true in response body");
  assert.equal(body.existingDocumentId, existingDoc.id, "existingDocumentId must reference the pre-existing doc");
});

test("POST /students — creates a student with required fields (modal entry point)", async () => {
  /**
   * The modal calls POST /api/students with firstName, lastName, motherName,
   * fatherName as required fields. Verify the endpoint accepts those fields
   * and returns the created student id (used in the subsequent match call).
   *
   * NOTE: We use the super_admin role here because the branch guard
   * (`resolveCreateBranchId`) returns null for branch-less users and blocks
   * staff without a branch with 403. In production all staff users have a
   * branch; tests don't replicate that setup. super_admin bypasses the branch
   * scope check (returns null branchId which is valid — students without a
   * branch are visible to super_admin everywhere).
   */
  const staffUserId = await ensureStaffUser();
  // Temporarily elevate to super_admin so the branch guard passes.
  const savedUser = { ...currentUser };
  currentUser = { id: staffUserId, role: "super_admin", isActive: true, emailVerified: true };

  try {
    const payload = {
      firstName: `ModalTest_F_${RUN_ID}`,
      lastName: `ModalTest_L_${RUN_ID}`,
      motherName: "Test Mother Name",
      fatherName: "Test Father Name",
      email: `modal_test_${RUN_ID}@test.invalid`,
      status: "active",
    };

    const res = await api("POST", `/api/students`, payload);
    assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    const body = res.body as Record<string, unknown>;
    assert.ok(typeof body.id === "number", `Expected numeric id, got ${JSON.stringify(body)}`);
    // Students route normalizes names via normalizeAndValidateNames (toLatinUpper → ALL CAPS).
    assert.equal(
      String(body.firstName).toUpperCase(),
      payload.firstName.toUpperCase(),
      "firstName should match (case-normalized)",
    );
    assert.equal(
      String(body.lastName).toUpperCase(),
      payload.lastName.toUpperCase(),
      "lastName should match (case-normalized)",
    );

    // Track for cleanup
    if (typeof body.id === "number") cleanupStudentIds.push(body.id);
  } finally {
    currentUser = savedUser;
  }
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
test("cleanup", async () => {
  // Delete documents linked to test students
  for (const id of cleanupStudentIds) {
    await db.delete(documentsTable).where(eq(documentsTable.studentId, id));
  }
  // Delete messages + conversations
  for (const id of cleanupConvIds) {
    await db.delete(messagesTable).where(eq(messagesTable.conversationId, id));
    await db.delete(conversationsTable).where(eq(conversationsTable.id, id));
  }
  // External contacts
  for (const id of cleanupContactIds) {
    await db.delete(externalContactsTable).where(eq(externalContactsTable.id, id));
  }
  // Converted leads reference their student and must be removed first.
  for (const id of cleanupLeadIds) {
    await db.delete(leadsTable).where(eq(leadsTable.id, id));
  }
  // Students (must come after docs deleted above)
  for (const id of cleanupStudentIds) {
    await db.delete(studentsTable).where(eq(studentsTable.id, id));
  }
  // Staff user
  if (sharedStaffUserId) {
    await db.delete(usersTable).where(eq(usersTable.id, sharedStaffUserId));
  }
  // Channel account
  if (sharedChannelAccountId) {
    await db.delete(channelAccountsTable).where(eq(channelAccountsTable.id, sharedChannelAccountId));
  }
  for (const id of cleanupCatalogOptionIds) {
    await db.delete(catalogOptionsTable).where(eq(catalogOptionsTable.id, id));
  }
  invalidateDocCatalog();
});

after(() => {
  server?.close();
  setImmediate(() => process.exit(process.exitCode ?? 0));
});
