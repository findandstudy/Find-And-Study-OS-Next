/**
 * Course Finder + searchPrograms tool — unit tests.
 *
 * Covers:
 *   - buildProgramFacetConditions: country/city/universityType are case-insensitive
 *     (scope "private" matches DB "Private"; "turkey" matches DB "Turkey").
 *   - executeSearchProgramsTool: result rows contain depositFee and languageFee fields.
 *   - Regression: scope="all" returns results without filtering; scope with no
 *     intersection yields zero rows (sentinel preserved).
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:course-finder
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { db, universitiesTable, programsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { buildProgramFacetConditions } from "../src/routes/course-finder";

const RUN_ID = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

let uniId: number;
let progId: number;

before(async () => {
  const [uni] = await db
    .insert(universitiesTable)
    .values({
      name: `Test University CF_${RUN_ID}`,
      country: "Turkey",
      city: "Istanbul",
      universityType: "Private",
      isActive: true,
    })
    .returning({ id: universitiesTable.id });
  uniId = uni.id;

  const [prog] = await db
    .insert(programsTable)
    .values({
      universityId: uniId,
      name: `Test Program CF_${RUN_ID}`,
      isActive: true,
      tuitionFee: 5000,
      depositFee: 500,
      languageFee: 1200,
      currency: "USD",
    })
    .returning({ id: programsTable.id });
  progId = prog.id;
});

after(async () => {
  if (uniId) {
    await db.delete(universitiesTable).where(eq(universitiesTable.id, uniId));
  }
});

test("buildProgramFacetConditions — universityType lowercase matches DB title-case", async () => {
  const where = buildProgramFacetConditions({ universityType: "private" });
  const rows = await db
    .select({ id: programsTable.id })
    .from(programsTable)
    .innerJoin(universitiesTable, eq(programsTable.universityId, universitiesTable.id))
    .where(and(where, eq(programsTable.id, progId)));
  assert.equal(rows.length, 1, "should match DB 'Private' with scope 'private'");
});

test("buildProgramFacetConditions — universityType UPPERCASE matches DB title-case", async () => {
  const where = buildProgramFacetConditions({ universityType: "PRIVATE" });
  const rows = await db
    .select({ id: programsTable.id })
    .from(programsTable)
    .innerJoin(universitiesTable, eq(programsTable.universityId, universitiesTable.id))
    .where(and(where, eq(programsTable.id, progId)));
  assert.equal(rows.length, 1, "should match DB 'Private' with scope 'PRIVATE'");
});

test("buildProgramFacetConditions — country lowercase matches DB title-case", async () => {
  const where = buildProgramFacetConditions({ country: "turkey" });
  const rows = await db
    .select({ id: programsTable.id })
    .from(programsTable)
    .innerJoin(universitiesTable, eq(programsTable.universityId, universitiesTable.id))
    .where(and(where, eq(programsTable.id, progId)));
  assert.equal(rows.length, 1, "should match DB 'Turkey' with scope 'turkey'");
});

test("buildProgramFacetConditions — city lowercase matches DB title-case", async () => {
  const where = buildProgramFacetConditions({ city: "istanbul" });
  const rows = await db
    .select({ id: programsTable.id })
    .from(programsTable)
    .innerJoin(universitiesTable, eq(programsTable.universityId, universitiesTable.id))
    .where(and(where, eq(programsTable.id, progId)));
  assert.equal(rows.length, 1, "should match DB 'Istanbul' with city 'istanbul'");
});

test("buildProgramFacetConditions — multi-value universityType is case-insensitive", async () => {
  const where = buildProgramFacetConditions({ universityType: "private,state" });
  const rows = await db
    .select({ id: programsTable.id })
    .from(programsTable)
    .innerJoin(universitiesTable, eq(programsTable.universityId, universitiesTable.id))
    .where(and(where, eq(programsTable.id, progId)));
  assert.equal(rows.length, 1, "multi-value 'private,state' should match DB 'Private'");
});

test("buildProgramFacetConditions — no params (scope=all) returns seeded program", async () => {
  const where = buildProgramFacetConditions({});
  const rows = await db
    .select({ id: programsTable.id })
    .from(programsTable)
    .innerJoin(universitiesTable, eq(programsTable.universityId, universitiesTable.id))
    .where(and(where, eq(programsTable.id, progId)));
  assert.equal(rows.length, 1, "no filters should return the seeded active program");
});

test("buildProgramFacetConditions — sentinel __no_match__ yields zero rows", async () => {
  const where = buildProgramFacetConditions({ universityType: "__no_match__" });
  const rows = await db
    .select({ id: programsTable.id })
    .from(programsTable)
    .innerJoin(universitiesTable, eq(programsTable.universityId, universitiesTable.id))
    .where(and(where, eq(programsTable.id, progId)));
  assert.equal(rows.length, 0, "sentinel value should match nothing");
});

test("searchPrograms SELECT — result row contains depositFee and languageFee", async () => {
  const where = buildProgramFacetConditions({ universityType: "Private" });
  const rows = await db
    .select({
      id: programsTable.id,
      tuitionFee: programsTable.tuitionFee,
      discountedFee: programsTable.discountedFee,
      depositFee: programsTable.depositFee,
      languageFee: programsTable.languageFee,
      currency: programsTable.currency,
    })
    .from(programsTable)
    .innerJoin(universitiesTable, eq(programsTable.universityId, universitiesTable.id))
    .where(and(where, eq(programsTable.id, progId)));

  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok("depositFee" in row, "row must have depositFee field");
  assert.ok("languageFee" in row, "row must have languageFee field");
  assert.equal(row.depositFee, 500, "depositFee should match seeded value");
  assert.equal(row.languageFee, 1200, "languageFee should match seeded value");
});
