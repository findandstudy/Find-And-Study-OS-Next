/**
 * Signed-contract object-authorization regression test.
 *
 * The generic GET /api/storage/objects/*path endpoint authorizes via
 * canAccessGenericObject(). Signed-contract PDFs are server-generated and
 * referenced by signed_contracts.pdf_object_key. Previously this route only
 * reached them through the agents.contractUrl reference (section 2), which points
 * at the agent's CURRENT contract and goes stale after a re-sign/resend — so an
 * agent who re-signed got a 403 on their newest (or older) signed PDF even though
 * it is legitimately theirs.
 *
 * This suite locks in the dedicated signed_contracts rule (section 2b):
 *   (a) The owning agent can download a signed PDF resolved purely via
 *       signed_contracts.pdf_object_key, EVEN WHEN agents.contractUrl points at a
 *       different (stale) key — the exact resend regression.
 *   (b) An unrelated agent is denied.
 *   (c) An admin can download it.
 *   (d) An unbound/unknown key is denied (no accidental allow-all).
 *
 * Calls the real canAccessGenericObject() against the dev DB with throwaway
 * rows that are torn down in a finally block.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:object-authz-signed-contract
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { eq, inArray } from "drizzle-orm";
import { assertSafeSignedContractAuthzDatabase } from "./integration-database-safety.js";

assertSafeSignedContractAuthzDatabase();

const databaseModule = await import("@workspace/db");
const {
  db,
  pool,
  usersTable,
  agentsTable,
  signedContractsTable,
} = databaseModule;
let canAccessGenericObject: typeof import("../src/lib/objectAuthz.js").canAccessGenericObject;
try {
  ({ canAccessGenericObject } = await import("../src/lib/objectAuthz.js"));
} catch (error) {
  await pool.end();
  throw error;
}

const tag = `authztest_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
const pdfUuid = crypto.randomUUID();
// The canonical stored key (matches how the signing flow records it).
const pdfObjectKey = `/objects/signed-contracts/${pdfUuid}-contract-authz-test.pdf`;
// The wildcard path as it arrives at GET /api/storage/objects/*path (no /objects/
// prefix, no leading slash).
const requestPath = `signed-contracts/${pdfUuid}-contract-authz-test.pdf`;
// A different key, to simulate a stale agents.contractUrl after a resend.
const staleContractUrl = `https://example.test/api/storage/objects/signed-contracts/${crypto.randomUUID()}-contract-OLD.pdf`;

const created = { userIds: [] as number[], agentIds: [] as number[], signedIds: [] as number[] };

// Register cleanup before seeding so a partial fixture is still removed when a
// later INSERT fails. Close the pool explicitly and let node:test preserve the
// natural non-zero exit code for assertion or cleanup failures.
after(async () => {
  try {
    await cleanup();
  } finally {
    await pool.end();
  }
});

async function seed() {
  const [ownerUser] = await db.insert(usersTable).values({
    email: `${tag}_owner@example.test`, role: "agent", firstName: "Owner", lastName: "Agent",
  }).returning({ id: usersTable.id });
  created.userIds.push(ownerUser.id);
  const [otherUser] = await db.insert(usersTable).values({
    email: `${tag}_other@example.test`, role: "agent", firstName: "Other", lastName: "Agent",
  }).returning({ id: usersTable.id });
  created.userIds.push(otherUser.id);
  const [adminUser] = await db.insert(usersTable).values({
    email: `${tag}_admin@example.test`, role: "super_admin", firstName: "Admin", lastName: "User",
  }).returning({ id: usersTable.id });
  created.userIds.push(adminUser.id);

  const [ownerAgent] = await db.insert(agentsTable).values({
    firstName: "Owner", lastName: "Agent", userId: ownerUser.id,
    // Intentionally stale: points at a DIFFERENT key than the signed PDF below.
    contractUrl: staleContractUrl,
  }).returning({ id: agentsTable.id });
  created.agentIds.push(ownerAgent.id);
  const [otherAgent] = await db.insert(agentsTable).values({
    firstName: "Other", lastName: "Agent", userId: otherUser.id,
  }).returning({ id: agentsTable.id });
  created.agentIds.push(otherAgent.id);

  const [signed] = await db.insert(signedContractsTable).values({
    signingSessionId: 2_000_000_000 + Math.floor(Math.random() * 1_000_000),
    agentId: ownerAgent.id,
    templateId: 1,
    pdfObjectKey,
    signerEmail: `${tag}_owner@example.test`,
  }).returning({ id: signedContractsTable.id });
  created.signedIds.push(signed.id);

  return { ownerUser, otherUser, adminUser, ownerAgent };
}

async function cleanup() {
  const errors: unknown[] = [];

  try {
    if (created.signedIds.length) await db.delete(signedContractsTable).where(inArray(signedContractsTable.id, created.signedIds));
  } catch (error) {
    errors.push(error);
  }
  try {
    if (created.agentIds.length) await db.delete(agentsTable).where(inArray(agentsTable.id, created.agentIds));
  } catch (error) {
    errors.push(error);
  }
  try {
    if (created.userIds.length) await db.delete(usersTable).where(inArray(usersTable.id, created.userIds));
  } catch (error) {
    errors.push(error);
  }

  if (errors.length) {
    throw new AggregateError(errors, "signed-contract authz fixture cleanup failed");
  }
}

const seeded = await seed();

test("owning agent can download signed PDF via signed_contracts even when agents.contractUrl is stale", async () => {
  // Sanity: the agent's contractUrl really does NOT reference this key.
  const [agentRow] = await db.select({ contractUrl: agentsTable.contractUrl }).from(agentsTable).where(eq(agentsTable.id, seeded.ownerAgent.id));
  assert.equal(agentRow.contractUrl, staleContractUrl);
  assert.ok(!staleContractUrl.includes(pdfUuid), "stale url must not contain the signed pdf uuid");

  const ok = await canAccessGenericObject({ id: seeded.ownerUser.id, role: "agent" }, requestPath);
  assert.equal(ok, true);
});

test("unrelated agent is denied the signed PDF", async () => {
  const ok = await canAccessGenericObject({ id: seeded.otherUser.id, role: "agent" }, requestPath);
  assert.equal(ok, false);
});

test("admin can download the signed PDF", async () => {
  const ok = await canAccessGenericObject({ id: seeded.adminUser.id, role: "super_admin" }, requestPath);
  assert.equal(ok, true);
});

test("an unbound/unknown key is denied", async () => {
  const ok = await canAccessGenericObject({ id: seeded.ownerUser.id, role: "agent" }, `signed-contracts/${crypto.randomUUID()}-nope.pdf`);
  assert.equal(ok, false);
});
