/**
 * Messaging avatar regression tests (photo-doc-avatar bug, messaging surface).
 *
 * The inbox conversation list (GET /api/conversations) and the message thread
 * (GET /api/conversations/:id/messages) decorate student participants/senders
 * with avatarUrl=/api/students/:id/photo when the student has a SERVABLE photo
 * document. "Servable" mirrors the /students/:id/photo endpoint: latest photo
 * doc only, with fileKey OR fileData OR an http(s) fileUrl. A data:/file: only
 * fileUrl is NOT servable (the endpoint 422s), so no avatar URL is mapped.
 *
 * These tests lock in that a student whose ONLY photo is a LEGACY fileData
 * upload still gets an avatar in both messaging payloads, and that a data:-only
 * fileUrl student does not.
 *
 *   MA-1  fileData-only photo → avatarUrl in conversation list participant.
 *   MA-2  fileData-only photo → senderAvatarUrl in message thread.
 *   MA-3  data:-only fileUrl photo → NO avatarUrl in conversation list.
 *   MA-4  data:-only fileUrl photo → senderAvatarUrl null in message thread.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:messaging-avatar
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
  documentsTable,
  conversationsTable,
  conversationParticipantsTable,
  messagesTable,
} from "@workspace/db";

import messagesRouter from "../src/routes/messages.js";

after(() => {
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

const RUN_ID = `ma_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

// The requesting staff user — must be a participant of the conversation.
let staffUser: { id: number; role: string; isActive: boolean } = {
  id: 0,
  role: "super_admin",
  isActive: true,
};

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = staffUser;
    if (!("cookies" in req)) (req as any).cookies = {};
    next();
  });
  app.use("/api", messagesRouter);
  return app;
}

const app = buildApp();

function apiReq(
  method: "GET",
  path: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const opts: http.RequestOptions = {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers: { "Content-Type": "application/json" },
      };
      const req = http.request(opts, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          server.close();
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode!, body: data });
          }
        });
      });
      req.on("error", (err) => { server.close(); reject(err); });
      req.end();
    });
    server.on("error", reject);
  });
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

interface Fixture {
  staffUserId: number;
  studentUserId: number;
  studentId: number;
  conversationId: number;
  messageId: number;
  docId: number;
}

async function setup(photo: Partial<{ fileKey: string | null; fileData: string | null; fileUrl: string | null }>): Promise<Fixture> {
  const [staff] = await db
    .insert(usersTable)
    .values({
      email: `ma_staff_${RUN_ID}@test.invalid`,
      firstName: "Staff",
      lastName: `MA_${RUN_ID}`,
      role: "super_admin",
      isActive: true,
    })
    .returning({ id: usersTable.id });

  const [studentUser] = await db
    .insert(usersTable)
    .values({
      email: `ma_student_${RUN_ID}@test.invalid`,
      firstName: "Student",
      lastName: `MA_${RUN_ID}`,
      role: "student",
      isActive: true,
    })
    .returning({ id: usersTable.id });

  staffUser = { id: staff.id, role: "super_admin", isActive: true };

  const [student] = await db
    .insert(studentsTable)
    .values({
      userId: studentUser.id,
      firstName: "Student",
      lastName: `MA_${RUN_ID}`,
      email: `ma_student_${RUN_ID}@test.invalid`,
    })
    .returning({ id: studentsTable.id });

  const [doc] = await db
    .insert(documentsTable)
    .values({
      studentId: student.id,
      name: `Photo_${RUN_ID}`,
      type: "photo",
      status: "pending",
      fileKey: photo.fileKey ?? null,
      fileData: photo.fileData ?? null,
      fileUrl: photo.fileUrl ?? null,
      mimeType: "image/jpeg",
    })
    .returning({ id: documentsTable.id });

  const [conv] = await db
    .insert(conversationsTable)
    .values({ type: "direct", createdById: staff.id, lastMessageAt: new Date() })
    .returning({ id: conversationsTable.id });

  await db.insert(conversationParticipantsTable).values([
    { conversationId: conv.id, userId: staff.id },
    { conversationId: conv.id, userId: studentUser.id },
  ]);

  const [msg] = await db
    .insert(messagesTable)
    .values({
      conversationId: conv.id,
      senderId: studentUser.id,
      content: `hello from student ${RUN_ID}`,
      channel: "internal",
      status: "sent",
    })
    .returning({ id: messagesTable.id });

  return {
    staffUserId: staff.id,
    studentUserId: studentUser.id,
    studentId: student.id,
    conversationId: conv.id,
    messageId: msg.id,
    docId: doc.id,
  };
}

async function teardown(f: Fixture) {
  await db.delete(messagesTable).where(eq(messagesTable.conversationId, f.conversationId));
  await db.delete(conversationParticipantsTable).where(eq(conversationParticipantsTable.conversationId, f.conversationId));
  await db.delete(conversationsTable).where(eq(conversationsTable.id, f.conversationId));
  await db.delete(documentsTable).where(eq(documentsTable.id, f.docId));
  await db.delete(studentsTable).where(eq(studentsTable.id, f.studentId));
  await db.delete(usersTable).where(inArray(usersTable.id, [f.staffUserId, f.studentUserId]));
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("MA-1: fileData-only photo → conversation list participant gets avatarUrl", async () => {
  const f = await setup({ fileData: "/9j/legacyBase64Photo" });
  try {
    const r = await apiReq("GET", "/api/conversations");
    assert.equal(r.status, 200, `expected 200 got ${r.status}: ${JSON.stringify(r.body)}`);
    const conv = r.body.data.find((c: any) => c.id === f.conversationId);
    assert.ok(conv, "conversation should be in the list");
    const studentP = conv.participants.find((p: any) => p.userId === f.studentUserId);
    assert.ok(studentP, "student participant should be present");
    assert.equal(studentP.avatarUrl, `/api/students/${f.studentId}/photo`);
  } finally {
    await teardown(f);
  }
});

test("MA-2: fileData-only photo → message thread sender gets senderAvatarUrl", async () => {
  const f = await setup({ fileData: "/9j/legacyBase64Photo" });
  try {
    const r = await apiReq("GET", `/api/conversations/${f.conversationId}/messages`);
    assert.equal(r.status, 200, `expected 200 got ${r.status}: ${JSON.stringify(r.body)}`);
    const msg = r.body.data.find((m: any) => m.id === f.messageId);
    assert.ok(msg, "student message should be in the thread");
    assert.equal(msg.senderAvatarUrl, `/api/students/${f.studentId}/photo`);
  } finally {
    await teardown(f);
  }
});

test("MA-3: data:-only fileUrl photo → conversation list participant has NO avatarUrl", async () => {
  const f = await setup({ fileUrl: "data:image/jpeg;base64,/9j/ABC123" });
  try {
    const r = await apiReq("GET", "/api/conversations");
    assert.equal(r.status, 200, `expected 200 got ${r.status}: ${JSON.stringify(r.body)}`);
    const conv = r.body.data.find((c: any) => c.id === f.conversationId);
    assert.ok(conv, "conversation should be in the list");
    const studentP = conv.participants.find((p: any) => p.userId === f.studentUserId);
    assert.ok(studentP, "student participant should be present");
    assert.ok(!studentP.avatarUrl, `expected no avatarUrl, got ${studentP.avatarUrl}`);
  } finally {
    await teardown(f);
  }
});

test("MA-4: data:-only fileUrl photo → message thread senderAvatarUrl is null", async () => {
  const f = await setup({ fileUrl: "data:image/jpeg;base64,/9j/ABC123" });
  try {
    const r = await apiReq("GET", `/api/conversations/${f.conversationId}/messages`);
    assert.equal(r.status, 200, `expected 200 got ${r.status}: ${JSON.stringify(r.body)}`);
    const msg = r.body.data.find((m: any) => m.id === f.messageId);
    assert.ok(msg, "student message should be in the thread");
    assert.ok(!msg.senderAvatarUrl, `expected null senderAvatarUrl, got ${msg.senderAvatarUrl}`);
  } finally {
    await teardown(f);
  }
});
