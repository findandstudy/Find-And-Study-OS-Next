/**
 * Document Access Control — route-level integration test (Task #473 / Faz S2).
 *
 * Verifies that all four vulnerability fixes are in place:
 *
 *   D1  POST /documents/merge-pdf checks EVERY documentId's ownership,
 *       not just a supplied studentId (IDOR guard).
 *   D2  GET /documents/:id enforces agent_staff "documents" permission
 *       (middleware gate) AND row-level scope (in/out of scope checks).
 *   D3  GET /documents/:id/download enforces agent_staff "documents"
 *       permission (middleware gate).
 *   D4  GET /applications/:id/stage-documents enforces scope via
 *       verifyApplicationAccess (agent cannot read cross-agent apps).
 *
 * Scenarios:
 *   1.  agent merges own student's two PDFs → 200
 *   2.  agent merges one own doc + one cross-agent doc (IDOR) → 403
 *   3.  agent_staff without "documents" perm + GET /documents/:id → 403
 *   4.  agent_staff with "documents" perm + in-scope doc → 200
 *   5.  agent_staff with "documents" perm + out-of-scope doc → 403
 *   6.  agent_staff without "documents" perm + GET /documents/:id/download → 403
 *   7.  agent accesses out-of-scope application stage-docs → 403
 *   8.  agent accesses own application stage-docs → 200
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:doc-access-control
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
  studentsTable,
  documentsTable,
  applicationsTable,
} from "@workspace/db";
import { PDFDocument } from "pdf-lib";

import documentsRouter from "../src/routes/documents.js";
import applicationStageDocumentsRouter from "../src/routes/applicationStageDocuments.js";

after(() => {
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

const RUN_ID = `dac_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

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
    next();
  });
  app.use("/api", documentsRouter);
  app.use("/api", applicationStageDocumentsRouter);
  return app;
}

const app = buildApp();

async function apiReq(
  method: "GET" | "POST" | "DELETE",
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
const cleanupAppIds: number[]     = [];
const cleanupDocIds: number[]     = [];
const cleanupStudentIds: number[] = [];
const cleanupAgentIds: number[]   = [];
const cleanupUserIds: number[]    = [];

async function createUser(
  role: string,
  extra?: { agentStaffPermissions?: string[]; managingAgentId?: number },
): Promise<number> {
  const suffix = Math.random().toString(36).slice(2, 6);
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_ID}_${role}_${suffix}@dac-test.local`,
      firstName: "DAC",
      lastName: `Test_${RUN_ID}`,
      role,
      isActive: true,
      agentStaffPermissions:
        (extra?.agentStaffPermissions ?? null) as unknown as string,
      managingAgentId: extra?.managingAgentId ?? null,
    })
    .returning({ id: usersTable.id });
  cleanupUserIds.push(row.id);
  return row.id;
}

async function createAgent(userId: number): Promise<number> {
  const [row] = await db
    .insert(agentsTable)
    .values({ userId, firstName: "DAC", lastName: `Agent_${RUN_ID}` })
    .returning({ id: agentsTable.id });
  cleanupAgentIds.push(row.id);
  return row.id;
}

async function createStudent(agentId: number): Promise<number> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const [row] = await db
    .insert(studentsTable)
    .values({
      firstName: "DAC",
      lastName:  `Stu_${suffix}`,
      email:     `stu_${RUN_ID}_${suffix}@dac-test.local`,
      agentId,
    })
    .returning({ id: studentsTable.id });
  cleanupStudentIds.push(row.id);
  return row.id;
}

async function createPdfDoc(studentId: number): Promise<number> {
  const pdf = await PDFDocument.create();
  pdf.addPage([100, 100]);
  const bytes = await pdf.save();
  const b64 = Buffer.from(bytes).toString("base64");
  const [row] = await db
    .insert(documentsTable)
    .values({
      name:      `test-doc-${RUN_ID}.pdf`,
      type:      "passport",
      status:    "pending",
      studentId,
      fileData:  b64,
      mimeType:  "application/pdf",
    })
    .returning({ id: documentsTable.id });
  cleanupDocIds.push(row.id);
  return row.id;
}

async function createApp(studentId: number, agentId: number): Promise<number> {
  const [row] = await db
    .insert(applicationsTable)
    .values({ studentId, agentId })
    .returning({ id: applicationsTable.id });
  cleanupAppIds.push(row.id);
  return row.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test("Document Access Control — Faz S2", async (t) => {
  // ── Agent A: parent agent with one student and two PDF docs ────────────────
  const agentAUserId = await createUser("agent");
  const agentAId     = await createAgent(agentAUserId);
  const studentA     = await createStudent(agentAId);
  const docA1        = await createPdfDoc(studentA);
  const docA2        = await createPdfDoc(studentA);

  // ── Agent B: separate parent agent, different student, one PDF doc ─────────
  const agentBUserId = await createUser("agent");
  const agentBId     = await createAgent(agentBUserId);
  const studentB     = await createStudent(agentBId);
  const docB1        = await createPdfDoc(studentB);

  // ── agent_staff belonging to Agent A, with/without "documents" perm ────────
  const agentStaffWithPerm = await createUser("agent_staff", {
    agentStaffPermissions: ["documents"],
    managingAgentId: agentAId,
  });
  const agentStaffNoPerm = await createUser("agent_staff", {
    agentStaffPermissions: [],
    managingAgentId: agentAId,
  });

  // ── Applications for stage-doc scope tests ─────────────────────────────────
  const appA = await createApp(studentA, agentAId);
  const appB = await createApp(studentB, agentBId);

  // ── D1: merge-pdf IDOR guard ────────────────────────────────────────────────

  await t.test("D1 agent can merge own student's PDFs → 200", async () => {
    currentUser = { id: agentAUserId, role: "agent", isActive: true };
    const { status } = await apiReq("POST", "/api/documents/merge-pdf", {
      documentIds: [docA1, docA2],
    });
    assert.equal(status, 200, `expected 200, got ${status}`);
  });

  await t.test(
    "D1 agent cannot merge one own doc + one cross-agent doc (IDOR) → 403",
    async () => {
      currentUser = { id: agentAUserId, role: "agent", isActive: true };
      const { status } = await apiReq("POST", "/api/documents/merge-pdf", {
        documentIds: [docA1, docB1],
      });
      assert.equal(status, 403, `expected 403 for cross-agent merge, got ${status}`);
    },
  );

  // ── D2: agent_staff "documents" perm gate + row-level scope ────────────────

  await t.test(
    "D2 agent_staff without 'documents' perm cannot GET /documents/:id → 403",
    async () => {
      currentUser = { id: agentStaffNoPerm, role: "agent_staff", isActive: true };
      const { status } = await apiReq("GET", `/api/documents/${docA1}`);
      assert.equal(status, 403, `expected 403, got ${status}`);
    },
  );

  await t.test(
    "D2 agent_staff with 'documents' perm + in-scope doc → 200",
    async () => {
      currentUser = { id: agentStaffWithPerm, role: "agent_staff", isActive: true };
      const { status } = await apiReq("GET", `/api/documents/${docA1}`);
      assert.equal(status, 200, `expected 200, got ${status}`);
    },
  );

  await t.test(
    "D2 agent_staff with 'documents' perm cannot access out-of-scope doc → 403",
    async () => {
      currentUser = { id: agentStaffWithPerm, role: "agent_staff", isActive: true };
      const { status } = await apiReq("GET", `/api/documents/${docB1}`);
      assert.equal(status, 403, `expected 403, got ${status}`);
    },
  );

  // ── D3: download endpoint perm gate ────────────────────────────────────────

  await t.test(
    "D3 agent_staff without 'documents' perm cannot GET /documents/:id/download → 403",
    async () => {
      currentUser = { id: agentStaffNoPerm, role: "agent_staff", isActive: true };
      const { status } = await apiReq(
        "GET",
        `/api/documents/${docA1}/download`,
      );
      assert.equal(status, 403, `expected 403, got ${status}`);
    },
  );

  // ── D4: stage-documents scope ───────────────────────────────────────────────

  await t.test(
    "D4 agent cannot access out-of-scope application stage-docs → 403",
    async () => {
      currentUser = { id: agentAUserId, role: "agent", isActive: true };
      const { status } = await apiReq(
        "GET",
        `/api/applications/${appB}/stage-documents`,
      );
      assert.equal(status, 403, `expected 403, got ${status}`);
    },
  );

  await t.test(
    "D4 agent can access own application stage-docs → 200",
    async () => {
      currentUser = { id: agentAUserId, role: "agent", isActive: true };
      const { status } = await apiReq(
        "GET",
        `/api/applications/${appA}/stage-documents`,
      );
      assert.equal(status, 200, `expected 200, got ${status}`);
    },
  );

  // ── Cleanup — order respects FK dependencies ────────────────────────────────
  if (cleanupAppIds.length > 0) {
    await db
      .delete(applicationsTable)
      .where(inArray(applicationsTable.id, cleanupAppIds));
  }
  if (cleanupDocIds.length > 0) {
    await db
      .delete(documentsTable)
      .where(inArray(documentsTable.id, cleanupDocIds));
  }
  if (cleanupStudentIds.length > 0) {
    await db
      .delete(studentsTable)
      .where(inArray(studentsTable.id, cleanupStudentIds));
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
});
