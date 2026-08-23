/**
 * test-exclusions.ts — university-based nationality exclusions ("exclusive region")
 *
 * Unit (resolveNationalityExclusion — real DB):
 *   EX-U1 exact match → excluded + agency
 *   EX-U2 case-insensitive + trimmed match (nationality AND university key)
 *   EX-U3 different nationality → not excluded
 *   EX-U4 no rule for the university → not excluded
 *   EX-U5 disabled rule (enabled=false) → not excluded
 *   EX-U6 soft-deleted rule (deleted_at set) → not excluded
 *   EX-U7 empty / missing nationality → not excluded
 *
 * Reactive (detectExclusiveRegion — pure, no DB):
 *   EX-R1 "Exclusive bölge" body → true
 *   EX-R2 "acenta üzerinden" body → true
 *   EX-R3 success body → false
 *   EX-R4 empty / null body → false
 *
 * Integration (writebackResult — real DB, dry-safe):
 *   EX-I1 result.exclusiveRegion → status='exclusive_region', agency error text,
 *         meta reason, terminal (NOT requeued)
 *
 * Real submission is NEVER triggered — the integration path only exercises the
 * writeback with a synthesised exclusiveRegion result.
 *
 * Run:
 *   pnpm --filter @workspace/portal-runner test:exclusions
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  db,
  studentsTable,
  usersTable,
  universitiesTable,
  programsTable,
  applicationsTable,
  portalSubmissionsTable,
  portalUniversityExclusionsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { resolveNationalityExclusion, writebackResult } from "@workspace/portal-runner";
import { detectExclusiveRegion } from "@workspace/portal-adapters";

// ---------------------------------------------------------------------------
// Per-run unique key prefix (test-fragment uniqueness — avoid leaked rows)
// ---------------------------------------------------------------------------

const RUN = `ex_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;

const cleanupExclusionIds: number[] = [];
const cleanupSubIds: number[] = [];
const cleanupAppIds: number[] = [];
const cleanupStudentIds: number[] = [];
const cleanupProgramIds: number[] = [];
const cleanupUniversityIds: number[] = [];
const cleanupUserIds: number[] = [];

after(async () => {
  for (const id of cleanupSubIds)        await db.delete(portalSubmissionsTable).where(eq(portalSubmissionsTable.id, id)).catch(() => {});
  for (const id of cleanupAppIds)        await db.delete(applicationsTable).where(eq(applicationsTable.id, id)).catch(() => {});
  for (const id of cleanupProgramIds)    await db.delete(programsTable).where(eq(programsTable.id, id)).catch(() => {});
  for (const id of cleanupUniversityIds) await db.delete(universitiesTable).where(eq(universitiesTable.id, id)).catch(() => {});
  for (const id of cleanupStudentIds)    await db.delete(studentsTable).where(eq(studentsTable.id, id)).catch(() => {});
  for (const id of cleanupUserIds)       await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  for (const id of cleanupExclusionIds)  await db.delete(portalUniversityExclusionsTable).where(eq(portalUniversityExclusionsTable.id, id)).catch(() => {});
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

async function seedExclusion(opts: {
  universityKey: string;
  nationality: string;
  agencyName?: string | null;
  enabled?: boolean;
  softDeleted?: boolean;
}): Promise<number> {
  const [row] = await db
    .insert(portalUniversityExclusionsTable)
    .values({
      universityKey: opts.universityKey,
      nationality:   opts.nationality,
      agencyName:    opts.agencyName ?? null,
      enabled:       opts.enabled ?? true,
      deletedAt:     opts.softDeleted ? new Date() : null,
    })
    .returning({ id: portalUniversityExclusionsTable.id });
  cleanupExclusionIds.push(row.id);
  return row.id;
}

// ---------------------------------------------------------------------------
// Unit — resolveNationalityExclusion
// ---------------------------------------------------------------------------

test("EX-U1: exact match → excluded + agency", async () => {
  const key = `${RUN}_u1`;
  await seedExclusion({ universityKey: key, nationality: "Azerbaijan", agencyName: "Multico" });
  const out = await resolveNationalityExclusion(key, "Azerbaijan");
  assert.equal(out.excluded, true);
  assert.equal(out.agencyName, "Multico");
});

test("EX-U2: case-insensitive + trimmed match (nationality AND key)", async () => {
  const key = `${RUN}_u2`;
  await seedExclusion({ universityKey: key, nationality: "Azerbaijan", agencyName: "Multico" });
  const out = await resolveNationalityExclusion(`  ${key.toUpperCase()} `, "  azERBaijan ");
  assert.equal(out.excluded, true);
  assert.equal(out.agencyName, "Multico");
});

test("EX-U3: different nationality → not excluded", async () => {
  const key = `${RUN}_u3`;
  await seedExclusion({ universityKey: key, nationality: "Azerbaijan", agencyName: "Multico" });
  const out = await resolveNationalityExclusion(key, "Germany");
  assert.equal(out.excluded, false);
  assert.equal(out.agencyName, null);
});

test("EX-U4: no rule for the university → not excluded", async () => {
  const out = await resolveNationalityExclusion(`${RUN}_no_such_key`, "Azerbaijan");
  assert.equal(out.excluded, false);
});

test("EX-U5: disabled rule → not excluded", async () => {
  const key = `${RUN}_u5`;
  await seedExclusion({ universityKey: key, nationality: "Russia", agencyName: "X", enabled: false });
  const out = await resolveNationalityExclusion(key, "Russia");
  assert.equal(out.excluded, false);
});

test("EX-U6: soft-deleted rule → not excluded", async () => {
  const key = `${RUN}_u6`;
  await seedExclusion({ universityKey: key, nationality: "Iran", agencyName: "X", softDeleted: true });
  const out = await resolveNationalityExclusion(key, "Iran");
  assert.equal(out.excluded, false);
});

test("EX-U7: empty / missing nationality → not excluded", async () => {
  const key = `${RUN}_u7`;
  await seedExclusion({ universityKey: key, nationality: "Azerbaijan", agencyName: "Multico" });
  assert.equal((await resolveNationalityExclusion(key, "")).excluded, false);
  assert.equal((await resolveNationalityExclusion(key, undefined)).excluded, false);
  assert.equal((await resolveNationalityExclusion("", "Azerbaijan")).excluded, false);
});

// ---------------------------------------------------------------------------
// Reactive — detectExclusiveRegion (pure)
// ---------------------------------------------------------------------------

test("EX-R1: 'Exclusive bölge' body → true", () => {
  assert.equal(detectExclusiveRegion('{"status":"error","message":"Exclusive bölge"}'), true);
});

test("EX-R2: 'acenta üzerinden' body → true", () => {
  assert.equal(detectExclusiveRegion("Lütfen acenta üzerinden başvurun"), true);
  assert.equal(detectExclusiveRegion("Lütfen acente üzerinden başvurun"), true);
});

test("EX-R3: success body → false", () => {
  assert.equal(detectExclusiveRegion('{"status":"success","applicationId":42}'), false);
});

test("EX-R4: empty / null body → false", () => {
  assert.equal(detectExclusiveRegion(""), false);
  assert.equal(detectExclusiveRegion(null), false);
  assert.equal(detectExclusiveRegion(undefined), false);
});

// ---------------------------------------------------------------------------
// Integration — writebackResult maps exclusiveRegion to status (real DB)
// ---------------------------------------------------------------------------

test("EX-I1: exclusiveRegion result → status='exclusive_region', terminal, agency error", async () => {
  const key = `${RUN}_i1`;
  const [user] = await db.insert(usersTable).values({
    email: `ex_${key}@test.local`,
    role:  "consultant",
  }).returning({ id: usersTable.id });
  cleanupUserIds.push(user.id);

  const uniName = `EX Uni ${key}`;
  const [uni] = await db.insert(universitiesTable).values({
    name:    uniName,
    country: "Turkey",
  }).returning({ id: universitiesTable.id });
  cleanupUniversityIds.push(uni.id);

  const [prog] = await db.insert(programsTable).values({
    universityId: uni.id,
    name:         `EX Program ${key}`,
    degree:       "bachelor",
    language:     "English",
  }).returning({ id: programsTable.id });
  cleanupProgramIds.push(prog.id);

  const [student] = await db.insert(studentsTable).values({
    firstName:   "EX",
    lastName:    `Student_${key}`,
    email:       `ex_student_${key}@test.local`,
    nationality: "Azerbaijan",
  }).returning({ id: studentsTable.id });
  cleanupStudentIds.push(student.id);

  const [app] = await db.insert(applicationsTable).values({
    studentId:      student.id,
    programId:      prog.id,
    universityId:   uni.id,
    assignedToId:   user.id,
    stage:          "inquiry",
    season:         "2026",
    programName:    prog.name,
    universityName: uniName,
    country:        "Turkey",
  }).returning({ id: applicationsTable.id });
  cleanupAppIds.push(app.id);

  const [sub] = await db.insert(portalSubmissionsTable).values({
    applicationId:  app.id,
    studentId:      student.id,
    universityKey:  key,
    universityName: uniName,
    mode:           "real",
    status:         "running",
  }).returning({ id: portalSubmissionsTable.id });
  cleanupSubIds.push(sub.id);

  await writebackResult(sub.id, {
    result: {
      submitted:       false,
      alreadyExists:   false,
      programMissing:  false,
      exclusiveRegion: true,
      exclusiveAgency: "Multico",
      detail:          "Exclusive bölge — Multico üzerinden başvurulmalı",
    },
    screenshotUrls: [],
    meta: { exclusionSkipped: true },
  });

  const [after] = await db
    .select({
      status: portalSubmissionsTable.status,
      error:  portalSubmissionsTable.error,
      meta:   portalSubmissionsTable.meta,
    })
    .from(portalSubmissionsTable)
    .where(eq(portalSubmissionsTable.id, sub.id));

  assert.equal(after.status, "exclusive_region");
  // Terminal — not requeued (claimNext only picks 'queued').
  assert.notEqual(after.status, "queued");
  assert.ok(after.error?.includes("Multico"), "error text names the agency");
  const meta = after.meta as Record<string, unknown> | null;
  assert.equal(meta?.["reason"], "Exclusive bölge");
  assert.equal(meta?.["exclusiveAgency"], "Multico");

  // Application stage is unchanged (no stage key for exclusive_region).
  const [appAfter] = await db
    .select({ stage: applicationsTable.stage })
    .from(applicationsTable)
    .where(eq(applicationsTable.id, app.id));
  assert.equal(appAfter.stage, "inquiry");
});
