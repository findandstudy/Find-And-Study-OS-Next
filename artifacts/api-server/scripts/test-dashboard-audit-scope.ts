import { after, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  applicationsTable,
  db,
  documentsTable,
  leadsTable,
  studentsTable,
  usersTable,
} from "@workspace/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import auditRouter from "../src/routes/audit.js";

after(() => {
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

let currentUser = { id: 0, role: "staff", isActive: true };

const app = express();
app.use((req, _res, next) => {
  (req as any).user = currentUser;
  next();
});
app.use("/api", auditRouter);

async function request(path: string): Promise<{ status: number; body: any }> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function eventBelongsToStaff(event: any, userId: number): Promise<boolean> {
  if (event.resource === "lead") {
    const [row] = await db.select({ assignedToId: leadsTable.assignedToId })
      .from(leadsTable)
      .where(and(eq(leadsTable.id, event.resourceId), isNull(leadsTable.deletedAt)));
    return row?.assignedToId === userId;
  }
  if (event.resource === "student") {
    const [row] = await db.select({ assignedToId: studentsTable.assignedToId })
      .from(studentsTable)
      .where(and(eq(studentsTable.id, event.resourceId), isNull(studentsTable.deletedAt)));
    return row?.assignedToId === userId;
  }
  if (event.resource === "application") {
    const [row] = await db.select({ assignedToId: applicationsTable.assignedToId })
      .from(applicationsTable)
      .where(and(eq(applicationsTable.id, event.resourceId), isNull(applicationsTable.deletedAt)));
    return row?.assignedToId === userId;
  }
  if (event.resource === "document") {
    const [document] = await db.select({
      studentId: documentsTable.studentId,
      leadId: documentsTable.leadId,
      applicationId: documentsTable.applicationId,
    }).from(documentsTable).where(and(
      eq(documentsTable.id, event.resourceId),
      isNull(documentsTable.deletedAt),
    ));
    if (!document) return false;

    const ownershipChecks: Promise<boolean>[] = [];
    if (document.studentId) ownershipChecks.push(
      db.select({ assignedToId: studentsTable.assignedToId }).from(studentsTable)
        .where(and(eq(studentsTable.id, document.studentId), isNull(studentsTable.deletedAt)))
        .then(([row]) => row?.assignedToId === userId),
    );
    if (document.leadId) ownershipChecks.push(
      db.select({ assignedToId: leadsTable.assignedToId }).from(leadsTable)
        .where(and(eq(leadsTable.id, document.leadId), isNull(leadsTable.deletedAt)))
        .then(([row]) => row?.assignedToId === userId),
    );
    if (document.applicationId) ownershipChecks.push(
      db.select({ assignedToId: applicationsTable.assignedToId }).from(applicationsTable)
        .where(and(eq(applicationsTable.id, document.applicationId), isNull(applicationsTable.deletedAt)))
        .then(([row]) => row?.assignedToId === userId),
    );
    return (await Promise.all(ownershipChecks)).some(Boolean);
  }
  return false;
}

test("staff dashboard audit returns only events for records assigned to that staff user", async () => {
  const candidates = await db.select({ id: usersTable.id, role: usersTable.role })
    .from(usersTable)
    .where(inArray(usersTable.role, ["staff", "consultant", "editor", "accountant"]))
    .limit(100);

  let selected: { id: number; role: string } | null = null;
  let response: { status: number; body: any } | null = null;
  for (const candidate of candidates) {
    currentUser = { id: candidate.id, role: candidate.role, isActive: true };
    const result = await request("/api/audit/dashboard?limit=20");
    if (result.status === 200 && Array.isArray(result.body?.data) && result.body.data.length > 0) {
      selected = candidate;
      response = result;
      break;
    }
  }

  assert.ok(selected, "Expected at least one local staff user with assigned audit activity");
  assert.ok(response);
  assert.equal(response.status, 200);
  assert.ok(response.body.data.length <= 20);
  for (const event of response.body.data) {
    assert.equal(
      await eventBelongsToStaff(event, selected.id),
      true,
      `Leaked out-of-scope event ${event.resource}#${event.resourceId}`,
    );
  }
});

test("staff identity with no assignments receives an empty feed and cannot access global audit", async () => {
  currentUser = { id: 2_147_483_647, role: "staff", isActive: true };

  const dashboard = await request("/api/audit/dashboard?limit=20");
  assert.equal(dashboard.status, 200);
  assert.deepEqual(dashboard.body.data, []);

  const globalAudit = await request("/api/audit?limit=20&page=1");
  assert.equal(globalAudit.status, 403);
});
