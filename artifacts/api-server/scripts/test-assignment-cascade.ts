/**
 * Cross-stage assignment cascade regression test.
 *
 * Task #310 made assigning a person at the Student stage propagate the assignee
 * back to the linked Lead and the student's Applications (and the existing
 * Lead -> Student cascade kept working). That behavior had only a one-off manual
 * verification, so this suite locks it down against future regressions by
 * driving the real Express route handlers in-process (no network/auth stack):
 *
 *   (a) Student PATCH assign -> linked lead AND applications get the same
 *       assignee.
 *   (b) Student PATCH unassign (assignedToId: null) -> lead AND applications
 *       are cleared to null.
 *   (c) Student bulk-action "assign" -> lead AND applications get the same
 *       assignee for every affected student.
 *   (d) Permission gate: with `records.cascade_assignment` the cascade runs;
 *       without it the student's own assignment still changes but the linked
 *       lead and applications are left untouched. The only override toggled
 *       between the two cases is `records.cascade_assignment`.
 *   (e) No-op: re-assigning a student to the SAME assignee cascades nothing,
 *       even when downstream records currently point at a different person.
 *   (f) The existing Lead -> Student direction still cascades down to the
 *       converted student and its applications.
 *   (g) Application PATCH assign -> student AND linked lead get the same
 *       assignee (cascadeApplicationAssignment).
 *   (h) Application PATCH assign without cascade permission -> app itself
 *       changes but student and lead are left untouched.
 *   (i) staffCards POST /assigned-students -> lead AND applications cascade.
 *   (j) staffCards DELETE /assigned-students/:id -> lead AND applications
 *       are cleared to null.
 *   (k) Leads bulk-assign with cascade permission -> each lead's converted
 *       student AND that student's applications get the same assignee.
 *   (l) sync-assignment-backfill is idempotent: first run fixes mismatched
 *       records; second run is a no-op (zero updates).
 *   (m) Inbox admin reassignment updates the linked student source before the
 *       lead/application cascade, so detail sync cannot restore the old owner.
 *   (n) Inbox admin reassignment updates a lead-only contact's authoritative
 *       lead row, so detail sync cannot restore the old owner.
 *   (o) Retrying a previously interrupted inbox assignment repairs the CRM
 *       chain even when the conversation row already has the requested owner.
 *
 * Mounts the real students + leads + applications + staffCards routers and
 * injects a fake `req.user` (the same seam used by test-inbox-ai-actions).
 * For the permission-gate cases the injected user id matches a real DB user
 * row whose `permission_overrides` control the effective permission set
 * resolved by `userHasPermission`.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:assignment-cascade
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

// Hard exit after all tests complete — the routers pull in the notification
// dispatcher / db pool which keep live handles open, so node would otherwise
// hang. Matches the pattern used by the other in-process router tests.
after(() => {
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

import http from "http";
import express, { type Express, type Request } from "express";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  leadsTable,
  studentsTable,
  applicationsTable,
  documentsTable,
  conversationsTable,
  externalContactsTable,
  pipelineStagesTable,
  lifecycleCascadeStateTable,
} from "@workspace/db";

import studentsRouter from "../src/routes/students.js";
import leadsRouter from "../src/routes/leads.js";
import applicationsRouter from "../src/routes/applications.js";
import staffCardsRouter from "../src/routes/staffCards.js";
import inboxRouter from "../src/routes/inbox.js";
import { runBackfill } from "./sync-assignment-backfill.js";
import { normalizePhoneForMatch } from "../src/lib/leadAssignment.js";

const RUN_ID = `t326_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

before(async () => {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS lifecycle_cascade_state (
      id SERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      previous_status TEXT NOT NULL,
      cascaded_status TEXT NOT NULL,
      source_application_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_cascade_state_entity_idx ON lifecycle_cascade_state(entity_type, entity_id)`);
});

type FakeUser = { id: number; role: string; isActive: boolean };

// Mutable holder swapped per-request so a single mounted app can act as
// different users (admin vs. permission-scoped consultant).
let currentUser: FakeUser = { id: 0, role: "admin", isActive: true };

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: FakeUser }).user = currentUser;
    next();
  });
  app.use("/api", studentsRouter);
  app.use("/api", leadsRouter);
  app.use("/api", applicationsRouter);
  app.use("/api", staffCardsRouter);
  app.use("/api", inboxRouter);
  return app;
}

const app = buildApp();

test("phone-code assignment normalization accepts phoneE164-style values", () => {
  assert.equal(normalizePhoneForMatch("+92 341-1980649"), "+923411980649");
  assert.equal(normalizePhoneForMatch("0092 341 1980649"), "+923411980649");
  assert.equal(normalizePhoneForMatch(null), null);
});

async function request(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
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
    return { status: res.status, body: parsed };
  } finally {
    // Node/undici keeps the fetch socket alive. server.close() alone waits for
    // that idle connection and makes the suite appear hung for minutes.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// Seeding helpers. All rows are tagged with RUN_ID so reruns never collide and
// cleanup is total.
// ---------------------------------------------------------------------------

const createdUserIds: number[] = [];
const createdLeadIds: number[] = [];
const createdStudentIds: number[] = [];
const createdDocumentIds: number[] = [];

async function createUser(opts: {
  role: string;
  overrides?: Record<string, boolean> | null;
}): Promise<number> {
  const suffix = `${RUN_ID}_${Math.random().toString(36).slice(2, 8)}`;
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `${suffix}@cascade-test.local`,
      firstName: "Cascade",
      lastName: `Test_${suffix}`,
      role: opts.role,
      isActive: true,
      permissionOverrides: opts.overrides ?? null,
    })
    .returning({ id: usersTable.id });
  createdUserIds.push(row.id);
  return row.id;
}

interface Scenario {
  studentId: number;
  leadId: number;
  appIds: number[];
}

/**
 * Create a converted lead -> student chain with two applications, optionally
 * pre-assigned to a given staff user (defaults to unassigned).
 */
async function seedScenario(initialAssignee: number | null = null): Promise<Scenario> {
  const suffix = `${RUN_ID}_${Math.random().toString(36).slice(2, 8)}`;
  const [student] = await db
    .insert(studentsTable)
    .values({
      firstName: "Stu",
      lastName: `Test_${suffix}`,
      email: `stu_${suffix}@cascade-test.local`,
      assignedToId: initialAssignee,
    })
    .returning({ id: studentsTable.id });
  createdStudentIds.push(student.id);

  const [lead] = await db
    .insert(leadsTable)
    .values({
      firstName: "Stu",
      lastName: `Test_${suffix}`,
      email: `lead_${suffix}@cascade-test.local`,
      status: "converted",
      convertedStudentId: student.id,
      assignedToId: initialAssignee,
    })
    .returning({ id: leadsTable.id });
  createdLeadIds.push(lead.id);

  const appRows = await db
    .insert(applicationsTable)
    .values([
      { studentId: student.id, leadId: lead.id, assignedToId: initialAssignee },
      { studentId: student.id, leadId: lead.id, assignedToId: initialAssignee },
    ])
    .returning({ id: applicationsTable.id });

  return { studentId: student.id, leadId: lead.id, appIds: appRows.map(a => a.id) };
}

async function readAssignments(s: Scenario): Promise<{
  student: number | null;
  lead: number | null;
  apps: (number | null)[];
}> {
  const [student] = await db
    .select({ assignedToId: studentsTable.assignedToId })
    .from(studentsTable)
    .where(eq(studentsTable.id, s.studentId));
  const [lead] = await db
    .select({ assignedToId: leadsTable.assignedToId })
    .from(leadsTable)
    .where(eq(leadsTable.id, s.leadId));
  const apps = await db
    .select({ id: applicationsTable.id, assignedToId: applicationsTable.assignedToId })
    .from(applicationsTable)
    .where(inArray(applicationsTable.id, s.appIds))
    .orderBy(applicationsTable.id);
  return {
    student: student?.assignedToId ?? null,
    lead: lead?.assignedToId ?? null,
    apps: apps.map(a => a.assignedToId ?? null),
  };
}

// Cleanup deletes the lead first (it FK-references both the student and the
// assignee users), then the student (cascades its applications), then users.
after(async () => {
  try {
    if (createdDocumentIds.length) await db.delete(documentsTable).where(inArray(documentsTable.id, createdDocumentIds));
    if (createdStudentIds.length) {
      await db.delete(lifecycleCascadeStateTable).where(and(
        eq(lifecycleCascadeStateTable.entityType, "student"),
        inArray(lifecycleCascadeStateTable.entityId, createdStudentIds),
      ));
    }
    if (createdLeadIds.length) {
      await db.delete(lifecycleCascadeStateTable).where(and(
        eq(lifecycleCascadeStateTable.entityType, "lead"),
        inArray(lifecycleCascadeStateTable.entityId, createdLeadIds),
      ));
    }
    if (createdLeadIds.length) await db.delete(leadsTable).where(inArray(leadsTable.id, createdLeadIds));
    if (createdStudentIds.length) await db.delete(studentsTable).where(inArray(studentsTable.id, createdStudentIds));
    if (createdUserIds.length) await db.delete(usersTable).where(inArray(usersTable.id, createdUserIds));
  } catch (err) {
    console.error("[cleanup] failed:", err);
  }
});

// ---------------------------------------------------------------------------
// (a) Student PATCH assign cascades down to lead + applications.
// ---------------------------------------------------------------------------
test("student PATCH assign cascades to linked lead and applications", async () => {
  const admin = await createUser({ role: "admin" });
  const staff = await createUser({ role: "staff" });
  currentUser = { id: admin, role: "admin", isActive: true };

  const s = await seedScenario(null);
  const res = await request("PATCH", `/api/students/${s.studentId}`, { assignedToId: staff });
  assert.equal(res.status, 200, `PATCH should succeed (got ${res.status}: ${JSON.stringify(res.body)})`);

  const after = await readAssignments(s);
  assert.equal(after.student, staff, "student assigned");
  assert.equal(after.lead, staff, "lead cascaded");
  assert.deepEqual(after.apps, [staff, staff], "applications cascaded");
});

// ---------------------------------------------------------------------------
// (b) Student PATCH unassign (null) clears lead + applications.
// ---------------------------------------------------------------------------
test("student PATCH unassign (null) clears lead and applications", async () => {
  const admin = await createUser({ role: "admin" });
  const staff = await createUser({ role: "staff" });
  currentUser = { id: admin, role: "admin", isActive: true };

  const s = await seedScenario(staff);
  const res = await request("PATCH", `/api/students/${s.studentId}`, { assignedToId: null });
  assert.equal(res.status, 200, `PATCH should succeed (got ${res.status}: ${JSON.stringify(res.body)})`);

  const after = await readAssignments(s);
  assert.equal(after.student, null, "student unassigned");
  assert.equal(after.lead, null, "lead cleared");
  assert.deepEqual(after.apps, [null, null], "applications cleared");
});

// ---------------------------------------------------------------------------
// (c) Student bulk-action "assign" cascades for every affected student.
// ---------------------------------------------------------------------------
test("student bulk-assign cascades to each student's lead and applications", async () => {
  const admin = await createUser({ role: "admin" });
  const staff = await createUser({ role: "staff" });
  currentUser = { id: admin, role: "admin", isActive: true };

  const s1 = await seedScenario(null);
  const s2 = await seedScenario(null);
  const res = await request("POST", `/api/students/bulk-action`, {
    ids: [s1.studentId, s2.studentId],
    action: "assign",
    assignedToId: staff,
  });
  assert.equal(res.status, 200, `bulk-action should succeed (got ${res.status}: ${JSON.stringify(res.body)})`);

  for (const s of [s1, s2]) {
    const after = await readAssignments(s);
    assert.equal(after.student, staff, "student assigned");
    assert.equal(after.lead, staff, "lead cascaded");
    assert.deepEqual(after.apps, [staff, staff], "applications cascaded");
  }
});

// ---------------------------------------------------------------------------
// (d) Permission gate — records.cascade_assignment controls OVERWRITE vs null-fill.
//
// Without the permission a "null-fill" cascade still runs: sibling records
// that are currently unassigned (null) are filled with the new assignee, but
// records that already have an assignee are left untouched.
// With the permission the full OVERWRITE cascade runs (existing assignees are
// replaced).
// ---------------------------------------------------------------------------
test("cascade permission controls overwrite vs null-fill behaviour", async () => {
  const staffA = await createUser({ role: "staff" });
  const staffB = await createUser({ role: "staff" });

  // Both consultants can view others' records and change the assignee; only the
  // first additionally holds the cascade permission.
  const withCascade = await createUser({
    role: "consultant",
    overrides: {
      "records.view_others": true,
      "records.change_assigned": true,
      "records.cascade_assignment": true,
    },
  });
  const withoutCascade = await createUser({
    role: "consultant",
    overrides: {
      "records.view_others": true,
      "records.change_assigned": true,
    },
  });

  // With the permission: full OVERWRITE cascade (existing staffB replaced by staffA).
  {
    const s = await seedScenario(staffB);
    currentUser = { id: withCascade, role: "consultant", isActive: true };
    const res = await request("PATCH", `/api/students/${s.studentId}`, { assignedToId: staffA });
    assert.equal(res.status, 200, `PATCH should succeed (got ${res.status}: ${JSON.stringify(res.body)})`);
    const after = await readAssignments(s);
    assert.equal(after.student, staffA, "student assigned (with perm)");
    assert.equal(after.lead, staffA, "lead overwritten (with perm)");
    assert.deepEqual(after.apps, [staffA, staffA], "applications overwritten (with perm)");
  }

  // Without the permission, downstream records ARE null -> null-fill runs and fills them.
  {
    const s = await seedScenario(null);
    currentUser = { id: withoutCascade, role: "consultant", isActive: true };
    const res = await request("PATCH", `/api/students/${s.studentId}`, { assignedToId: staffA });
    assert.equal(res.status, 200, `PATCH should succeed (got ${res.status}: ${JSON.stringify(res.body)})`);
    const after = await readAssignments(s);
    assert.equal(after.student, staffA, "student assigned (no perm, all null)");
    assert.equal(after.lead, staffA, "lead filled by null-fill (no perm, was null)");
    assert.deepEqual(after.apps, [staffA, staffA], "applications filled by null-fill (no perm, were null)");
  }

  // Without the permission, downstream records already have an assignee -> NOT overwritten.
  {
    const s = await seedScenario(staffB);
    currentUser = { id: withoutCascade, role: "consultant", isActive: true };
    const res = await request("PATCH", `/api/students/${s.studentId}`, { assignedToId: staffA });
    assert.equal(res.status, 200, `PATCH should succeed (got ${res.status}: ${JSON.stringify(res.body)})`);
    const after = await readAssignments(s);
    assert.equal(after.student, staffA, "student assigned (no perm, downstream assigned)");
    assert.equal(after.lead, staffB, "lead NOT overwritten (no perm, was staffB)");
    assert.deepEqual(after.apps, [staffB, staffB], "applications NOT overwritten (no perm, were staffB)");
  }
});

// ---------------------------------------------------------------------------
// (e) No-op — re-assigning to the same assignee cascades nothing.
// ---------------------------------------------------------------------------
test("re-assigning a student to the same assignee cascades nothing", async () => {
  const admin = await createUser({ role: "admin" });
  const staffA = await createUser({ role: "staff" });
  const staffB = await createUser({ role: "staff" });
  currentUser = { id: admin, role: "admin", isActive: true };

  // Student already on staffA; downstream deliberately points at staffB so a
  // stray cascade would be observable.
  const s = await seedScenario(staffA);
  await db.update(leadsTable).set({ assignedToId: staffB }).where(eq(leadsTable.id, s.leadId));
  await db.update(applicationsTable).set({ assignedToId: staffB }).where(inArray(applicationsTable.id, s.appIds));

  const res = await request("PATCH", `/api/students/${s.studentId}`, { assignedToId: staffA });
  assert.equal(res.status, 200, `PATCH should succeed (got ${res.status}: ${JSON.stringify(res.body)})`);

  const after = await readAssignments(s);
  assert.equal(after.student, staffA, "student unchanged");
  assert.equal(after.lead, staffB, "lead untouched (no cascade on no-op)");
  assert.deepEqual(after.apps, [staffB, staffB], "applications untouched (no cascade on no-op)");
});

// ---------------------------------------------------------------------------
// (f) Existing Lead -> Student direction still cascades.
// ---------------------------------------------------------------------------
test("lead PATCH assign still cascades down to student and applications", async () => {
  const admin = await createUser({ role: "admin" });
  const staff = await createUser({ role: "staff" });
  currentUser = { id: admin, role: "admin", isActive: true };

  const s = await seedScenario(null);
  // The leads PATCH route accepts the assignee under `assignedTo` and maps it
  // to `assignedToId` internally.
  const res = await request("PATCH", `/api/leads/${s.leadId}`, { assignedTo: staff });
  assert.equal(res.status, 200, `PATCH should succeed (got ${res.status}: ${JSON.stringify(res.body)})`);

  const after = await readAssignments(s);
  assert.equal(after.lead, staff, "lead assigned");
  assert.equal(after.student, staff, "student cascaded");
  assert.deepEqual(after.apps, [staff, staff], "applications cascaded");
});

// ---------------------------------------------------------------------------
// (g) Application PATCH assign cascades UP to student and linked lead.
// ---------------------------------------------------------------------------
test("application PATCH assign cascades to student and linked lead", async () => {
  const admin = await createUser({ role: "admin" });
  const staff = await createUser({ role: "staff" });
  currentUser = { id: admin, role: "admin", isActive: true };

  const s = await seedScenario(null);
  // Patch the first application — only that app's assignedToId changes
  // explicitly; the cascade writes student + lead.
  const targetAppId = s.appIds[0];
  const res = await request("PATCH", `/api/applications/${targetAppId}`, { assignedToId: staff });
  assert.equal(res.status, 200, `PATCH should succeed (got ${res.status}: ${JSON.stringify(res.body)})`);

  const [patchedApp] = await db
    .select({ assignedToId: applicationsTable.assignedToId })
    .from(applicationsTable)
    .where(eq(applicationsTable.id, targetAppId));
  assert.equal(patchedApp?.assignedToId, staff, "patched application updated");

  const [studentRow] = await db
    .select({ assignedToId: studentsTable.assignedToId })
    .from(studentsTable)
    .where(eq(studentsTable.id, s.studentId));
  assert.equal(studentRow?.assignedToId, staff, "student cascaded from application");

  const [leadRow] = await db
    .select({ assignedToId: leadsTable.assignedToId })
    .from(leadsTable)
    .where(eq(leadsTable.id, s.leadId));
  assert.equal(leadRow?.assignedToId, staff, "lead cascaded from application");
});

// ---------------------------------------------------------------------------
// (h) Application PATCH assign without cascade permission:
//     - Null sibling records ARE filled (null-fill cascade).
//     - Already-assigned sibling records are NOT overwritten.
// ---------------------------------------------------------------------------
test("application PATCH assign without cascade permission: null-fill but no overwrite", async () => {
  const staffA = await createUser({ role: "staff" });
  const staffB = await createUser({ role: "staff" });

  // A consultant with the ability to change application assignment but without
  // the cascade permission.
  const withoutCascade = await createUser({
    role: "consultant",
    overrides: {
      "records.view_others": true,
      "records.change_assigned": true,
      "applications.change_assigned": true,
    },
  });

  // Sub-case 1: student and lead are null → null-fill fills them.
  {
    currentUser = { id: withoutCascade, role: "consultant", isActive: true };
    const s = await seedScenario(null);
    const targetAppId = s.appIds[0];
    const res = await request("PATCH", `/api/applications/${targetAppId}`, { assignedToId: staffA });
    assert.equal(res.status, 200, `PATCH should succeed (got ${res.status}: ${JSON.stringify(res.body)})`);

    const [patchedApp] = await db
      .select({ assignedToId: applicationsTable.assignedToId })
      .from(applicationsTable)
      .where(eq(applicationsTable.id, targetAppId));
    assert.equal(patchedApp?.assignedToId, staffA, "patched application updated");

    const [studentRow] = await db
      .select({ assignedToId: studentsTable.assignedToId })
      .from(studentsTable)
      .where(eq(studentsTable.id, s.studentId));
    assert.equal(studentRow?.assignedToId, staffA, "student filled by null-fill (was null)");

    const [leadRow] = await db
      .select({ assignedToId: leadsTable.assignedToId })
      .from(leadsTable)
      .where(eq(leadsTable.id, s.leadId));
    assert.equal(leadRow?.assignedToId, staffA, "lead filled by null-fill (was null)");
  }

  // Sub-case 2: student and lead already assigned to staffB → NOT overwritten (no cascade perm).
  {
    currentUser = { id: withoutCascade, role: "consultant", isActive: true };
    const s = await seedScenario(staffB);
    const targetAppId = s.appIds[0];
    const res = await request("PATCH", `/api/applications/${targetAppId}`, { assignedToId: staffA });
    assert.equal(res.status, 200, `PATCH should succeed (got ${res.status}: ${JSON.stringify(res.body)})`);

    const [patchedApp] = await db
      .select({ assignedToId: applicationsTable.assignedToId })
      .from(applicationsTable)
      .where(eq(applicationsTable.id, targetAppId));
    assert.equal(patchedApp?.assignedToId, staffA, "patched application updated");

    const [studentRow] = await db
      .select({ assignedToId: studentsTable.assignedToId })
      .from(studentsTable)
      .where(eq(studentsTable.id, s.studentId));
    assert.equal(studentRow?.assignedToId, staffB, "student NOT overwritten (no perm, was staffB)");

    const [leadRow] = await db
      .select({ assignedToId: leadsTable.assignedToId })
      .from(leadsTable)
      .where(eq(leadsTable.id, s.leadId));
    assert.equal(leadRow?.assignedToId, staffB, "lead NOT overwritten (no perm, was staffB)");
  }
});

// ---------------------------------------------------------------------------
// (i) staffCards POST /assigned-students cascades to lead + applications.
// ---------------------------------------------------------------------------
test("staffCards assign student cascades to linked lead and applications", async () => {
  const admin = await createUser({ role: "admin" });
  const staff = await createUser({ role: "staff" });
  currentUser = { id: admin, role: "admin", isActive: true };

  const s = await seedScenario(null);
  const res = await request("POST", `/api/staff-cards/${staff}/assigned-students`, { studentId: s.studentId });
  assert.equal(res.status, 200, `POST should succeed (got ${res.status}: ${JSON.stringify(res.body)})`);

  // Give the fire-and-forget cascade a moment to complete (it runs with .catch()).
  await new Promise(r => setTimeout(r, 200));

  const after = await readAssignments(s);
  assert.equal(after.student, staff, "student assigned via staffCards");
  assert.equal(after.lead, staff, "lead cascaded via staffCards");
  assert.deepEqual(after.apps, [staff, staff], "applications cascaded via staffCards");
});

// ---------------------------------------------------------------------------
// (j) staffCards DELETE /assigned-students/:id cascades null.
// ---------------------------------------------------------------------------
test("staffCards unassign student cascades null to lead and applications", async () => {
  const admin = await createUser({ role: "admin" });
  const staff = await createUser({ role: "staff" });
  currentUser = { id: admin, role: "admin", isActive: true };

  const s = await seedScenario(staff);
  const res = await request("DELETE", `/api/staff-cards/${staff}/assigned-students/${s.studentId}`);
  assert.equal(res.status, 204, `DELETE should succeed (got ${res.status}: ${JSON.stringify(res.body)})`);

  // Give the fire-and-forget cascade a moment to complete.
  await new Promise(r => setTimeout(r, 200));

  const after = await readAssignments(s);
  assert.equal(after.student, null, "student unassigned via staffCards");
  assert.equal(after.lead, null, "lead cleared via staffCards");
  assert.deepEqual(after.apps, [null, null], "applications cleared via staffCards");
});

// ---------------------------------------------------------------------------
// (k) Leads bulk-assign cascades to converted student + their applications.
// ---------------------------------------------------------------------------
test("leads bulk-assign cascades to each lead's student and applications", async () => {
  const admin = await createUser({ role: "admin" });
  const staff = await createUser({ role: "staff" });
  currentUser = { id: admin, role: "admin", isActive: true };

  const s1 = await seedScenario(null);
  const s2 = await seedScenario(null);

  const res = await request("POST", `/api/leads/bulk-action`, {
    ids: [s1.leadId, s2.leadId],
    action: "assign",
    assignedToId: staff,
  });
  assert.equal(res.status, 200, `bulk-action should succeed (got ${res.status}: ${JSON.stringify(res.body)})`);

  for (const s of [s1, s2]) {
    const after = await readAssignments(s);
    assert.equal(after.lead, staff, "lead assigned via bulk-action");
    assert.equal(after.student, staff, "student cascaded via leads bulk-assign");
    assert.deepEqual(after.apps, [staff, staff], "applications cascaded via leads bulk-assign");
  }
});

// ---------------------------------------------------------------------------
// (l) sync-assignment-backfill is idempotent.
//
// Arrange: student assigned to staffA; linked lead and apps deliberately point
// at staffB (simulating drift). First run should fix lead + apps; second run
// should touch nothing.
// ---------------------------------------------------------------------------
test("sync-assignment-backfill is idempotent", async () => {
  const staffA = await createUser({ role: "staff" });
  const staffB = await createUser({ role: "staff" });

  const s = await seedScenario(staffA);

  // Introduce drift: lead + apps point at staffB while student stays on staffA.
  await db.update(leadsTable).set({ assignedToId: staffB }).where(eq(leadsTable.id, s.leadId));
  await db.update(applicationsTable).set({ assignedToId: staffB }).where(inArray(applicationsTable.id, s.appIds));

  // First run — scoped to this specific student so the count is deterministic.
  const first = await runBackfill({ studentIds: [s.studentId] });
  assert.equal(first.studentsScanned, 1, "exactly one student scanned on first run");
  assert.equal(first.leadsUpdated, 1, "one lead fixed on first run");
  assert.equal(first.appsUpdated, 2, "two apps fixed on first run");

  // Verify DB state is now consistent.
  const afterFirst = await readAssignments(s);
  assert.equal(afterFirst.student, staffA, "student still on staffA");
  assert.equal(afterFirst.lead, staffA, "lead corrected to staffA");
  assert.deepEqual(afterFirst.apps, [staffA, staffA], "apps corrected to staffA");

  // Second run — everything is already in sync, so zero updates.
  const second = await runBackfill({ studentIds: [s.studentId] });
  assert.equal(second.studentsScanned, 1, "exactly one student scanned on second run");
  assert.equal(second.leadsUpdated, 0, "no lead updates on second run (idempotent)");
  assert.equal(second.appsUpdated, 0, "no app updates on second run (idempotent)");

  // DB state should be unchanged.
  const afterSecond = await readAssignments(s);
  assert.equal(afterSecond.lead, staffA, "lead unchanged after second run");
  assert.deepEqual(afterSecond.apps, [staffA, staffA], "apps unchanged after second run");
});

// ---------------------------------------------------------------------------
// (m) Inbox admin reassignment must patch the authoritative student itself.
// ---------------------------------------------------------------------------
test("inbox admin reassignment persists across the student-authoritative chain", async (t) => {
  const admin = await createUser({ role: "admin" });
  const staffA = await createUser({ role: "staff" });
  const staffB = await createUser({ role: "staff" });
  currentUser = { id: admin, role: "admin", isActive: true };

  const s = await seedScenario(staffA);
  const suffix = `${RUN_ID}_${Math.random().toString(36).slice(2, 8)}`;
  const [contact] = await db
    .insert(externalContactsTable)
    .values({
      channel: "whatsapp",
      externalId: `assignment-${suffix}`,
      displayName: "Inbox assignment test",
      leadId: s.leadId,
      studentId: s.studentId,
    })
    .returning({ id: externalContactsTable.id });
  const [conversation] = await db
    .insert(conversationsTable)
    .values({
      type: "external",
      channel: "whatsapp",
      externalContactId: contact.id,
      externalThreadId: `assignment-thread-${suffix}`,
      assignedToId: staffA,
    })
    .returning({ id: conversationsTable.id });

  t.after(async () => {
    await db.delete(conversationsTable).where(eq(conversationsTable.id, conversation.id));
    await db.delete(externalContactsTable).where(eq(externalContactsTable.id, contact.id));
  });

  const assigned = await request(
    "PATCH",
    `/api/inbox/conversations/${conversation.id}/assign`,
    { userId: staffB },
  );
  assert.equal(assigned.status, 200, `assignment should succeed: ${JSON.stringify(assigned.body)}`);

  const after = await readAssignments(s);
  assert.equal(after.student, staffB, "linked student owner changed");
  assert.equal(after.lead, staffB, "converted lead followed student owner");
  assert.deepEqual(after.apps, [staffB, staffB], "applications followed student owner");

  const [conversationAfter] = await db
    .select({ assignedToId: conversationsTable.assignedToId })
    .from(conversationsTable)
    .where(eq(conversationsTable.id, conversation.id));
  assert.equal(conversationAfter?.assignedToId, staffB, "conversation remains on the selected owner");
});

// ---------------------------------------------------------------------------
// (n) Inbox admin reassignment must patch the authoritative lead itself.
// ---------------------------------------------------------------------------
test("inbox admin reassignment persists for a lead-only conversation", async (t) => {
  const admin = await createUser({ role: "admin" });
  const staffA = await createUser({ role: "staff" });
  const staffB = await createUser({ role: "staff" });
  currentUser = { id: admin, role: "admin", isActive: true };

  const suffix = `${RUN_ID}_${Math.random().toString(36).slice(2, 8)}`;
  const [lead] = await db
    .insert(leadsTable)
    .values({
      firstName: "Lead",
      lastName: `Only_${suffix}`,
      email: `lead_only_${suffix}@cascade-test.local`,
      assignedToId: staffA,
    })
    .returning({ id: leadsTable.id });
  createdLeadIds.push(lead.id);
  const [contact] = await db
    .insert(externalContactsTable)
    .values({
      channel: "whatsapp",
      externalId: `lead-only-assignment-${suffix}`,
      displayName: "Lead-only inbox assignment test",
      leadId: lead.id,
    })
    .returning({ id: externalContactsTable.id });
  const [conversation] = await db
    .insert(conversationsTable)
    .values({
      type: "external",
      channel: "whatsapp",
      externalContactId: contact.id,
      externalThreadId: `lead-only-assignment-thread-${suffix}`,
      assignedToId: staffA,
    })
    .returning({ id: conversationsTable.id });

  t.after(async () => {
    await db.delete(conversationsTable).where(eq(conversationsTable.id, conversation.id));
    await db.delete(externalContactsTable).where(eq(externalContactsTable.id, contact.id));
  });

  const assigned = await request(
    "PATCH",
    `/api/inbox/conversations/${conversation.id}/assign`,
    { userId: staffB },
  );
  assert.equal(assigned.status, 200, `assignment should succeed: ${JSON.stringify(assigned.body)}`);

  const [leadAfter] = await db
    .select({ assignedToId: leadsTable.assignedToId })
    .from(leadsTable)
    .where(eq(leadsTable.id, lead.id));
  assert.equal(leadAfter?.assignedToId, staffB, "linked lead owner changed");

  const [conversationAfter] = await db
    .select({ assignedToId: conversationsTable.assignedToId })
    .from(conversationsTable)
    .where(eq(conversationsTable.id, conversation.id));
  assert.equal(conversationAfter?.assignedToId, staffB, "conversation remains on the selected owner");
});

// ---------------------------------------------------------------------------
// (o) A retry repairs a half-completed conversation/CRM assignment.
// ---------------------------------------------------------------------------
test("inbox assignment retry repairs a mismatched CRM chain", async (t) => {
  const admin = await createUser({ role: "admin" });
  const staffA = await createUser({ role: "staff" });
  const staffB = await createUser({ role: "staff" });
  currentUser = { id: admin, role: "admin", isActive: true };

  const s = await seedScenario(staffA);
  const suffix = `${RUN_ID}_${Math.random().toString(36).slice(2, 8)}`;
  const [contact] = await db
    .insert(externalContactsTable)
    .values({
      channel: "whatsapp",
      externalId: `assignment-retry-${suffix}`,
      displayName: "Inbox assignment retry test",
      leadId: s.leadId,
      studentId: s.studentId,
    })
    .returning({ id: externalContactsTable.id });
  // Simulate a previous interrupted attempt: conversation changed to staffB,
  // while its authoritative student/lead/application chain stayed on staffA.
  const [conversation] = await db
    .insert(conversationsTable)
    .values({
      type: "external",
      channel: "whatsapp",
      externalContactId: contact.id,
      externalThreadId: `assignment-retry-thread-${suffix}`,
      assignedToId: staffB,
    })
    .returning({ id: conversationsTable.id });

  t.after(async () => {
    await db.delete(conversationsTable).where(eq(conversationsTable.id, conversation.id));
    await db.delete(externalContactsTable).where(eq(externalContactsTable.id, contact.id));
  });

  const assigned = await request(
    "PATCH",
    `/api/inbox/conversations/${conversation.id}/assign`,
    { userId: staffB },
  );
  assert.equal(assigned.status, 200, `assignment retry should succeed: ${JSON.stringify(assigned.body)}`);

  const after = await readAssignments(s);
  assert.equal(after.student, staffB, "retry repaired student owner");
  assert.equal(after.lead, staffB, "retry repaired lead owner");
  assert.deepEqual(after.apps, [staffB, staffB], "retry repaired application owners");
});

// ---------------------------------------------------------------------------
// (p) LOST is aggregate and relationship-safe: sibling applications are never
//     modified; student/lead only become LOST when all applications in their
//     respective scope are LOST, and unlinked applications never guess a lead.
// ---------------------------------------------------------------------------
async function lostStageKeys() {
  const [applicationLost] = await db.select({ key: pipelineStagesTable.key })
    .from(pipelineStagesTable)
    .where(and(
      eq(pipelineStagesTable.entityType, "application"),
      eq(pipelineStagesTable.variant, "lost"),
    ))
    .orderBy(asc(pipelineStagesTable.sortOrder), asc(pipelineStagesTable.id))
    .limit(1);
  const [studentLost] = await db.select({ key: pipelineStagesTable.key })
    .from(pipelineStagesTable)
    .where(and(
      eq(pipelineStagesTable.entityType, "student"),
      eq(pipelineStagesTable.variant, "lost"),
    ))
    .orderBy(asc(pipelineStagesTable.sortOrder), asc(pipelineStagesTable.id))
    .limit(1);
  const [leadLost] = await db.select({ key: pipelineStagesTable.key })
    .from(pipelineStagesTable)
    .where(and(
      eq(pipelineStagesTable.entityType, "lead"),
      eq(pipelineStagesTable.variant, "lost"),
    ))
    .orderBy(asc(pipelineStagesTable.sortOrder), asc(pipelineStagesTable.id))
    .limit(1);
  const [applicationWon] = await db.select({ key: pipelineStagesTable.key })
    .from(pipelineStagesTable)
    .where(and(
      eq(pipelineStagesTable.entityType, "application"),
      eq(pipelineStagesTable.variant, "won"),
    ))
    .orderBy(asc(pipelineStagesTable.sortOrder), asc(pipelineStagesTable.id))
    .limit(1);

  assert.ok(applicationLost?.key, "application pipeline must define a lost stage");
  assert.ok(studentLost?.key, "student pipeline must define a lost stage");
  assert.ok(leadLost?.key, "lead pipeline must define a lost stage");
  assert.ok(applicationWon?.key, "application pipeline must define a won stage");
  return {
    applicationLost: applicationLost.key,
    applicationWon: applicationWon.key,
    studentLost: studentLost.key,
    leadLost: leadLost.key,
  };
}

async function readLostStatuses(s: Scenario) {
  const [student] = await db.select({ status: studentsTable.status })
    .from(studentsTable)
    .where(eq(studentsTable.id, s.studentId));
  const [lead] = await db.select({ status: leadsTable.status })
    .from(leadsTable)
    .where(eq(leadsTable.id, s.leadId));
  const apps = await db.select({ id: applicationsTable.id, stage: applicationsTable.stage })
    .from(applicationsTable)
    .where(inArray(applicationsTable.id, s.appIds))
    .orderBy(applicationsTable.id);
  return { student: student?.status, lead: lead?.status, apps };
}

test("LOST patch leaves student and lead unchanged while a sibling application is active", async () => {
  const admin = await createUser({ role: "admin" });
  currentUser = { id: admin, role: "admin", isActive: true };
  const stages = await lostStageKeys();
  const s = await seedScenario(null);

  const targetAppId = s.appIds[0];
  const res = await request("PATCH", `/api/applications/${targetAppId}`, {
    stage: stages.applicationLost,
  });
  assert.equal(res.status, 200, `PATCH should succeed (got ${res.status}: ${JSON.stringify(res.body)})`);
  const state = await readLostStatuses(s);
  assert.notEqual(state.student, stages.studentLost, "active sibling protects student status");
  assert.notEqual(state.lead, stages.leadLost, "active sibling linked to lead protects lead status");
  assert.notEqual(state.apps[1]?.stage, stages.applicationLost, "sibling application is untouched");
});

test("LOST patch leaves student and lead unchanged while a sibling application is WON", async () => {
  const admin = await createUser({ role: "admin" });
  currentUser = { id: admin, role: "admin", isActive: true };
  const stages = await lostStageKeys();
  const s = await seedScenario(null);
  await db.update(applicationsTable).set({ stage: stages.applicationWon }).where(eq(applicationsTable.id, s.appIds[1]));
  const res = await request("PATCH", `/api/applications/${s.appIds[0]}`, { stage: stages.applicationLost });
  assert.equal(res.status, 200, `PATCH should succeed (got ${res.status}: ${JSON.stringify(res.body)})`);
  const state = await readLostStatuses(s);
  assert.notEqual(state.student, stages.studentLost, "WON sibling protects student status");
  assert.notEqual(state.lead, stages.leadLost, "WON sibling protects lead status");
  assert.equal(state.apps[1]?.stage, stages.applicationWon, "WON sibling is untouched");
});

test("LOST patch cascades when every student and lead application is LOST", async () => {
  const admin = await createUser({ role: "admin" });
  currentUser = { id: admin, role: "admin", isActive: true };
  const stages = await lostStageKeys();
  const s = await seedScenario(null);
  await db.update(applicationsTable).set({ stage: stages.applicationLost }).where(eq(applicationsTable.id, s.appIds[1]));
  const res = await request("PATCH", `/api/applications/${s.appIds[0]}`, { stage: stages.applicationLost });
  assert.equal(res.status, 200, `PATCH should succeed (got ${res.status}: ${JSON.stringify(res.body)})`);
  const state = await readLostStatuses(s);
  assert.equal(state.student, stages.studentLost, "all applications LOST moves student");
  assert.equal(state.lead, stages.leadLost, "all lead-linked applications LOST moves lead");
});

test("leadless LOST application never guesses a lead", async () => {
  const admin = await createUser({ role: "admin" });
  currentUser = { id: admin, role: "admin", isActive: true };
  const stages = await lostStageKeys();
  const s = await seedScenario(null);
  await db.update(applicationsTable)
    .set({ leadId: null })
    .where(eq(applicationsTable.id, s.appIds[0]));
  await db.update(applicationsTable)
    .set({ deletedAt: new Date() })
    .where(eq(applicationsTable.id, s.appIds[1]));
  const res = await request("PATCH", `/api/applications/${s.appIds[0]}`, { stage: stages.applicationLost });
  assert.equal(res.status, 200, `PATCH should succeed (got ${res.status}: ${JSON.stringify(res.body)})`);
  const state = await readLostStatuses(s);
  assert.equal(state.student, stages.studentLost, "single live application controls student aggregate");
  assert.notEqual(state.lead, stages.leadLost, "unlinked application does not mutate converted lead");
});

test("bulk LOST move uses the same aggregate safety rules", async () => {
  const admin = await createUser({ role: "admin" });
  currentUser = { id: admin, role: "admin", isActive: true };
  const stages = await lostStageKeys();
  const s = await seedScenario(null);
  const res = await request("POST", "/api/applications/bulk-action", {
    ids: [s.appIds[0]],
    action: "move",
    stage: stages.applicationLost,
  });
  assert.equal(res.status, 200, `bulk move should succeed (got ${res.status}: ${JSON.stringify(res.body)})`);
  const state = await readLostStatuses(s);
  assert.notEqual(state.student, stages.studentLost, "active sibling protects student in bulk move");
  assert.notEqual(state.lead, stages.leadLost, "active sibling protects lead in bulk move");
  assert.notEqual(state.apps[1]?.stage, stages.applicationLost, "bulk move does not touch sibling");
});

test("moving an application out of LOST restores only automation-owned parent statuses", async () => {
  const admin = await createUser({ role: "admin" });
  currentUser = { id: admin, role: "admin", isActive: true };
  const stages = await lostStageKeys();
  const s = await seedScenario(null);
  const beforeState = await readLostStatuses(s);

  await db.update(applicationsTable).set({ stage: stages.applicationLost }).where(eq(applicationsTable.id, s.appIds[1]));
  const lost = await request("PATCH", `/api/applications/${s.appIds[0]}`, { stage: stages.applicationLost });
  assert.equal(lost.status, 200, `LOST patch should succeed: ${JSON.stringify(lost.body)}`);
  const cascaded = await readLostStatuses(s);
  assert.equal(cascaded.student, stages.studentLost);
  assert.equal(cascaded.lead, stages.leadLost);

  const reopened = await request("PATCH", `/api/applications/${s.appIds[0]}`, { stage: stages.applicationWon });
  assert.equal(reopened.status, 200, `reopen patch should succeed: ${JSON.stringify(reopened.body)}`);
  const restored = await readLostStatuses(s);
  assert.equal(restored.student, beforeState.student, "student returns to its pre-cascade status");
  assert.equal(restored.lead, beforeState.lead, "lead returns to its pre-cascade status");
});

test("legacy or manually-set LOST parent statuses are never guessed on reopen", async () => {
  const admin = await createUser({ role: "admin" });
  currentUser = { id: admin, role: "admin", isActive: true };
  const stages = await lostStageKeys();
  const s = await seedScenario(null);

  await db.update(studentsTable).set({ status: stages.studentLost }).where(eq(studentsTable.id, s.studentId));
  await db.update(leadsTable).set({ status: stages.leadLost }).where(eq(leadsTable.id, s.leadId));
  await db.update(applicationsTable).set({ stage: stages.applicationLost }).where(eq(applicationsTable.id, s.appIds[1]));
  const reopened = await request("PATCH", `/api/applications/${s.appIds[0]}`, { stage: stages.applicationWon });
  assert.equal(reopened.status, 200, `reopen patch should succeed: ${JSON.stringify(reopened.body)}`);
  const state = await readLostStatuses(s);
  assert.equal(state.student, stages.studentLost, "manual student LOST is preserved without provenance");
  assert.equal(state.lead, stages.leadLost, "manual lead LOST is preserved without provenance");
});

test("a direct LOST stage mapping cannot bypass sibling aggregate protection", async (t) => {
  const admin = await createUser({ role: "admin" });
  currentUser = { id: admin, role: "admin", isActive: true };
  const stages = await lostStageKeys();
  const s = await seedScenario(null);
  const [original] = await db.select({ mappedStudentStageKey: pipelineStagesTable.mappedStudentStageKey })
    .from(pipelineStagesTable)
    .where(and(eq(pipelineStagesTable.entityType, "application"), eq(pipelineStagesTable.key, stages.applicationLost)));
  t.after(async () => {
    await db.update(pipelineStagesTable).set({ mappedStudentStageKey: original?.mappedStudentStageKey ?? null })
      .where(and(eq(pipelineStagesTable.entityType, "application"), eq(pipelineStagesTable.key, stages.applicationLost)));
  });
  await db.update(pipelineStagesTable).set({ mappedStudentStageKey: stages.studentLost })
    .where(and(eq(pipelineStagesTable.entityType, "application"), eq(pipelineStagesTable.key, stages.applicationLost)));

  const moved = await request("PATCH", `/api/applications/${s.appIds[0]}`, { stage: stages.applicationLost });
  assert.equal(moved.status, 200, `LOST patch should succeed: ${JSON.stringify(moved.body)}`);
  const state = await readLostStatuses(s);
  assert.notEqual(state.student, stages.studentLost, "active sibling still protects student despite direct mapping");
});

test("student archive and restore preserve the journey without reviving older deletions", async () => {
  const admin = await createUser({ role: "admin" });
  currentUser = { id: admin, role: "admin", isActive: true };
  const s = await seedScenario(null);
  const previouslyDeletedAt = new Date(Date.now() - 60_000);
  await db.update(applicationsTable).set({ deletedAt: previouslyDeletedAt })
    .where(eq(applicationsTable.id, s.appIds[1]));
  const [doc] = await db.insert(documentsTable).values({
    studentId: s.studentId,
    applicationId: s.appIds[0],
    leadId: s.leadId,
    name: `${RUN_ID}-passport.pdf`,
    type: "passport",
    status: "approved",
  }).returning({ id: documentsTable.id });
  createdDocumentIds.push(doc.id);

  const archived = await request("DELETE", `/api/students/${s.studentId}`);
  assert.equal(archived.status, 204, `archive should succeed: ${JSON.stringify(archived.body)}`);
  const [studentArchived] = await db.select({ deletedAt: studentsTable.deletedAt }).from(studentsTable).where(eq(studentsTable.id, s.studentId));
  const [leadArchived] = await db.select({ deletedAt: leadsTable.deletedAt }).from(leadsTable).where(eq(leadsTable.id, s.leadId));
  const [appArchived] = await db.select({ deletedAt: applicationsTable.deletedAt }).from(applicationsTable).where(eq(applicationsTable.id, s.appIds[0]));
  assert.ok(studentArchived?.deletedAt, "student archived");
  assert.equal(leadArchived?.deletedAt?.getTime(), studentArchived.deletedAt.getTime(), "lead shares archive transaction timestamp");
  assert.equal(appArchived?.deletedAt?.getTime(), studentArchived.deletedAt.getTime(), "application shares archive transaction timestamp");

  const restored = await request("POST", `/api/students/${s.studentId}/restore`);
  assert.equal(restored.status, 200, `restore should succeed: ${JSON.stringify(restored.body)}`);
  const [studentAfter] = await db.select({ deletedAt: studentsTable.deletedAt }).from(studentsTable).where(eq(studentsTable.id, s.studentId));
  const [leadAfter] = await db.select({ deletedAt: leadsTable.deletedAt }).from(leadsTable).where(eq(leadsTable.id, s.leadId));
  const appsAfter = await db.select({ id: applicationsTable.id, deletedAt: applicationsTable.deletedAt })
    .from(applicationsTable).where(inArray(applicationsTable.id, s.appIds));
  const [docAfter] = await db.select({ deletedAt: documentsTable.deletedAt }).from(documentsTable).where(eq(documentsTable.id, doc.id));
  assert.equal(studentAfter?.deletedAt, null, "student restored");
  assert.equal(leadAfter?.deletedAt, null, "lead restored");
  assert.equal(appsAfter.find((row) => row.id === s.appIds[0])?.deletedAt, null, "journey application restored");
  assert.equal(appsAfter.find((row) => row.id === s.appIds[1])?.deletedAt?.getTime(), previouslyDeletedAt.getTime(), "older deletion preserved");
  assert.equal(docAfter?.deletedAt, null, "journey document restored");
});
