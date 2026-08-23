/**
 * test-portal-schema.ts
 *
 * Integration test for portal_credentials and portal_submissions DB tables.
 *
 * Tests:
 *  SC1: portal_credentials — insert + select happy path
 *  SC2: portal_credentials — soft delete filter (deletedAt IS NULL)
 *  SC3: portal_credentials — unique(organizationId, portalKey) violation throws
 *  SC4: portal_submissions — insert + select happy path (studentId nullable)
 *  SC5: portal_submissions — soft delete filter (deletedAt IS NULL)
 *  SC6: portal_submissions — organizationId stored and retrieved correctly
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx scripts/test-portal-schema.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  portalCredentialsTable,
  portalSubmissionsTable,
} from "@workspace/db";

// ---------------------------------------------------------------------------
// Unique test run tag — prevents cross-run collisions
// ---------------------------------------------------------------------------
const RUN_ID = `__schema_test_${Date.now()}__`;
const ORG_ID = 999_001; // synthetic org ID reserved for tests

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getTestApplicationId(): Promise<number> {
  const result = await db.execute<{ id: number }>(
    sql`SELECT id FROM applications LIMIT 1`,
  );
  const row = (result as unknown as { rows: { id: number }[] }).rows?.[0]
    ?? (Array.isArray(result) ? (result as { id: number }[])[0] : undefined);
  if (!row) throw new Error("No applications in DB — seed data required");
  return row.id;
}

async function cleanup() {
  await db.execute(
    `DELETE FROM portal_credentials WHERE portal_key LIKE '${RUN_ID}%'`,
  );
  await db.execute(
    `DELETE FROM portal_submissions
     WHERE university_key LIKE '${RUN_ID}%'`,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

await test("SC1: portal_credentials — insert + select happy path", async () => {
  const portalKey = `${RUN_ID}_sc1`;
  await db.insert(portalCredentialsTable).values({
    organizationId: ORG_ID,
    portalKey,
    label:       "Test Credential SC1",
    usernameEnc: "enc::v1::dGVzdA==",
    passwordEnc: "enc::v1::cGFzcw==",
    isActive:    true,
  });

  const [row] = await db
    .select()
    .from(portalCredentialsTable)
    .where(
      and(
        eq(portalCredentialsTable.portalKey, portalKey),
        isNull(portalCredentialsTable.deletedAt),
      ),
    )
    .limit(1);

  assert.ok(row, "Row should be found");
  assert.equal(row.organizationId, ORG_ID,       "organizationId stored correctly");
  assert.equal(row.label,          "Test Credential SC1", "label stored correctly");
  assert.equal(row.usernameEnc,    "enc::v1::dGVzdA==",  "usernameEnc stored correctly");
  assert.equal(row.isActive,       true,          "isActive defaults to true");
  assert.equal(row.createdBy,      null,          "createdBy is nullable");
});

await test("SC2: portal_credentials — soft delete filter", async () => {
  const portalKey = `${RUN_ID}_sc2`;
  await db.insert(portalCredentialsTable).values({
    organizationId: ORG_ID,
    portalKey,
    label:       "SC2 to soft-delete",
    usernameEnc: "enc::v1::dGVzdA==",
    passwordEnc: "enc::v1::cGFzcw==",
    isActive:    true,
  });

  // Soft-delete it
  await db
    .update(portalCredentialsTable)
    .set({ deletedAt: new Date() })
    .where(eq(portalCredentialsTable.portalKey, portalKey));

  // Must NOT appear when filtering with isNull(deletedAt)
  const [row] = await db
    .select()
    .from(portalCredentialsTable)
    .where(
      and(
        eq(portalCredentialsTable.portalKey, portalKey),
        isNull(portalCredentialsTable.deletedAt),
      ),
    )
    .limit(1);

  assert.equal(row, undefined, "Soft-deleted row must not appear with isNull(deletedAt) filter");

  // But the row itself still exists (physical row not deleted)
  const [rawRow] = await db
    .select()
    .from(portalCredentialsTable)
    .where(eq(portalCredentialsTable.portalKey, portalKey))
    .limit(1);

  assert.ok(rawRow,              "Physical row must still exist");
  assert.ok(rawRow.deletedAt,    "deletedAt must be set on soft-deleted row");
});

await test("SC3: portal_credentials — unique(organizationId, portalKey) violation throws", async () => {
  const portalKey = `${RUN_ID}_sc3`;
  const base = {
    organizationId: ORG_ID,
    portalKey,
    label:       "SC3 original",
    usernameEnc: "enc::v1::dGVzdA==",
    passwordEnc: "enc::v1::cGFzcw==",
    isActive:    true,
  };

  await db.insert(portalCredentialsTable).values(base);

  await assert.rejects(
    () => db.insert(portalCredentialsTable).values({ ...base, label: "SC3 duplicate" }),
    (err: unknown) => {
      // DrizzleQueryError wraps the pg error in .message and/or .cause.message
      const parts = [
        String(err),
        (err as { message?: string }).message ?? "",
        (err as { cause?: { message?: string } }).cause?.message ?? "",
      ].join(" ").toLowerCase();
      return (
        parts.includes("portal_creds_org_key_uniq") ||
        parts.includes("unique") ||
        parts.includes("duplicate key")
      );
    },
    "Duplicate (organizationId, portalKey) must throw a unique-constraint error",
  );
});

await test("SC4: portal_submissions — insert + select happy path (studentId nullable)", async () => {
  const appId = await getTestApplicationId();
  const universityKey = `${RUN_ID}_sc4`;

  const [inserted] = await db
    .insert(portalSubmissionsTable)
    .values({
      organizationId: ORG_ID,
      applicationId:  appId,
      studentId:      null,   // spec: nullable (set null on student delete)
      universityKey,
      universityName: "Test University SC4",
      mode:           "dry",
      status:         "queued",
      attempts:       0,
      maxAttempts:    3,
    })
    .returning();

  assert.ok(inserted,                          "Row should be inserted");
  assert.equal(inserted.organizationId, ORG_ID, "organizationId stored correctly");
  assert.equal(inserted.studentId,      null,    "studentId is nullable");
  assert.equal(inserted.mode,           "dry",   "mode defaults to dry");
  assert.equal(inserted.status,         "queued","status defaults to queued");
  assert.equal(inserted.attempts,       0,       "attempts defaults to 0");

  // Select it back
  const [row] = await db
    .select()
    .from(portalSubmissionsTable)
    .where(
      and(
        eq(portalSubmissionsTable.id, inserted.id),
        isNull(portalSubmissionsTable.deletedAt),
      ),
    )
    .limit(1);

  assert.ok(row,                              "Row found by select");
  assert.equal(row.universityKey, universityKey, "universityKey round-trips correctly");
});

await test("SC5: portal_submissions — soft delete filter", async () => {
  const appId = await getTestApplicationId();
  const universityKey = `${RUN_ID}_sc5`;

  const [inserted] = await db
    .insert(portalSubmissionsTable)
    .values({
      organizationId: ORG_ID,
      applicationId:  appId,
      universityKey,
      universityName: "Test University SC5",
      mode:           "dry",
      status:         "queued",
    })
    .returning();

  // Soft-delete
  await db
    .update(portalSubmissionsTable)
    .set({ deletedAt: new Date() })
    .where(eq(portalSubmissionsTable.id, inserted.id));

  // Must NOT appear with isNull filter
  const [row] = await db
    .select()
    .from(portalSubmissionsTable)
    .where(
      and(
        eq(portalSubmissionsTable.id, inserted.id),
        isNull(portalSubmissionsTable.deletedAt),
      ),
    )
    .limit(1);

  assert.equal(row, undefined, "Soft-deleted submission must not appear with isNull(deletedAt) filter");
});

await test("SC6: portal_submissions — organizationId stored and retrieved", async () => {
  const appId = await getTestApplicationId();
  const universityKey = `${RUN_ID}_sc6`;
  const customOrgId   = 999_002;

  const [inserted] = await db
    .insert(portalSubmissionsTable)
    .values({
      organizationId: customOrgId,
      applicationId:  appId,
      universityKey,
      universityName: "Test University SC6",
      mode:           "real",
      status:         "running",
    })
    .returning();

  assert.equal(inserted.organizationId, customOrgId, "organizationId round-trips correctly");
  assert.equal(inserted.mode,           "real",       "mode=real stored correctly");
  assert.equal(inserted.status,         "running",    "status=running stored correctly");
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
await cleanup();
console.log("All portal-schema tests passed.");
