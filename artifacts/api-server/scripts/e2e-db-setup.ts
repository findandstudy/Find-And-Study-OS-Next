/**
 * Playwright e2e database setup.
 *
 * Two responsibilities:
 *
 *  1. Ensures the web_form integration is enabled and has NO shared secret so
 *     the inbox-flow.spec.ts test can POST anonymously.  The original
 *     configuration is serialized to `e2e-db-state.json` at the project root
 *     so that e2e-db-teardown can restore it exactly.
 *
 *  2. Idempotently seeds the apply-flows.spec.ts fixtures: a deterministic
 *     test agent (with credentials below) and a test university + program
 *     used by the agent / course-finder apply flows. These are tagged with
 *     stable names so e2e-db-teardown can clean them up unconditionally.
 *
 * Run via playwright globalSetup (see playwright.config.ts).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import {
  db, pool,
  integrationsTable,
  usersTable,
  agentsTable,
  universitiesTable,
  programsTable,
  studentsTable,
  documentsTable,
  degreeDocumentRequirementsTable,
  catalogOptionsTable,
} from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import { encryptConfig, decryptConfig } from "../src/lib/encryption";
import { assertSafeE2eDatabase } from "./e2e-database-safety";

assertSafeE2eDatabase();

const stateFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../e2e-db-state.json",
);

// Deterministic apply-flow fixtures. Teardown removes by these exact strings.
export const E2E_FIXTURE = {
  agentUserEmail: "e2e-agent@test.local",
  agentUserPassword: "e2eAgentPass123!",
  agentName: "E2E Test Agent",
  universityName: "E2E Test University",
  programName: "E2E Test Program",
  fixtureStudentEmail: "e2e-fixture-student@test.local",
  fixtureStudentFirstName: "E2EFixture",
  fixtureStudentLastName: "Student",
} as const;

const fixturesIdsFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../e2e-fixtures.json",
);

async function seedWebFormIntegration() {
  const [existing] = await db
    .select()
    .from(integrationsTable)
    .where(eq(integrationsTable.key, "web_form"));

  fs.writeFileSync(stateFile, JSON.stringify(existing ?? null, null, 2), "utf8");

  if (!existing) {
    await db.insert(integrationsTable).values({
      key: "web_form",
      name: "Web Form",
      category: "communication",
      isEnabled: true,
      config: encryptConfig({}),
    });
    console.log("[e2e-setup] Created web_form integration (no secret, enabled)");
  } else {
    const cfg = decryptConfig((existing.config as Record<string, unknown>) || {});
    const cleanCfg = { ...cfg, secret: undefined };
    await db
      .update(integrationsTable)
      .set({
        isEnabled: true,
        config: encryptConfig(cleanCfg),
      })
      .where(eq(integrationsTable.key, "web_form"));
    console.log(
      "[e2e-setup] Ensured web_form integration is enabled with no secret",
    );
  }
}

async function seedApplyFlowFixtures() {
  // 1. Test university (idempotent by name)
  let [uni] = await db
    .select()
    .from(universitiesTable)
    .where(eq(universitiesTable.name, E2E_FIXTURE.universityName));
  if (!uni) {
    [uni] = await db
      .insert(universitiesTable)
      .values({
        name: E2E_FIXTURE.universityName,
        country: "Turkey",
        universityType: "private",
      })
      .returning();
    console.log(`[e2e-setup] Created test university #${uni.id}`);
  } else {
    console.log(`[e2e-setup] Test university already exists #${uni.id}`);
  }

  // 2. Test program under that university (idempotent by name + universityId)
  let [prog] = await db
    .select()
    .from(programsTable)
    .where(eq(programsTable.name, E2E_FIXTURE.programName));
  if (!prog) {
    [prog] = await db
      .insert(programsTable)
      .values({
        universityId: uni.id,
        name: E2E_FIXTURE.programName,
        tuitionFee: 10000,
        currency: "USD",
        commissionRate: 10,
      })
      .returning();
    console.log(`[e2e-setup] Created test program #${prog.id}`);
  } else {
    console.log(`[e2e-setup] Test program already exists #${prog.id}`);
  }

  // 3. Test agent user (idempotent by email)
  const passwordHash = await bcrypt.hash(E2E_FIXTURE.agentUserPassword, 10);
  let [agentUser] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, E2E_FIXTURE.agentUserEmail));
  if (!agentUser) {
    [agentUser] = await db
      .insert(usersTable)
      .values({
        email: E2E_FIXTURE.agentUserEmail,
        passwordHash,
        firstName: "E2E",
        lastName: "Agent",
        role: "agent",
        isActive: true,
        emailVerified: true,
      })
      .returning();
    console.log(`[e2e-setup] Created test agent user #${agentUser.id}`);
  } else {
    // Ensure password + role are correct in case prior run mutated them.
    await db
      .update(usersTable)
      .set({ passwordHash, role: "agent", isActive: true, emailVerified: true })
      .where(eq(usersTable.id, agentUser.id));
    console.log(`[e2e-setup] Test agent user already exists #${agentUser.id} (refreshed creds)`);
  }

  // 4. Agent record (idempotent by email — agentsTable has no `name` column,
  //    real columns are firstName/lastName/companyName).
  let agentId: number;
  const [agentRow] = await db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.email, E2E_FIXTURE.agentUserEmail));
  if (!agentRow) {
    const [created] = await db
      .insert(agentsTable)
      .values({
        userId: agentUser.id,
        firstName: "E2E",
        lastName: "TestAgent",
        companyName: E2E_FIXTURE.agentName,
        email: E2E_FIXTURE.agentUserEmail,
        country: "Turkey",
        commissionRate: 50,
      })
      .returning();
    console.log(`[e2e-setup] Created test agent record #${created.id}`);
    agentId = created.id;
  } else {
    // Re-bind to current userId in case the user was recreated between runs.
    if (agentRow.userId !== agentUser.id) {
      await db
        .update(agentsTable)
        .set({ userId: agentUser.id })
        .where(eq(agentsTable.id, agentRow.id));
    }
    console.log(`[e2e-setup] Test agent record already exists #${agentRow.id}`);
    agentId = agentRow.id;
  }

  // 5. Fixture student owned by the test agent (idempotent by email). Used by
  //    apply-flows.spec.ts (b) so the agent can POST /api/applications without
  //    failing the "Student not in your scope" check.
  let fixtureStudentId: number;
  const [studentRow] = await db
    .select()
    .from(studentsTable)
    .where(eq(studentsTable.email, E2E_FIXTURE.fixtureStudentEmail));
  if (!studentRow) {
    const [created] = await db
      .insert(studentsTable)
      .values({
        firstName: E2E_FIXTURE.fixtureStudentFirstName,
        lastName: E2E_FIXTURE.fixtureStudentLastName,
        email: E2E_FIXTURE.fixtureStudentEmail,
        phone: "5555550199",
        phoneE164: "+905555550199",
        nationality: "Turkey",
        passportNumber: "PE2EFIXTURE001",
        agentId,
        status: "active",
        originType: "agent",
      })
      .returning();
    console.log(`[e2e-setup] Created fixture student #${created.id} (agentId=${agentId})`);
    fixtureStudentId = created.id;
  } else {
    await db
      .update(studentsTable)
      .set({
        agentId,
        phone: "5555550199",
        phoneE164: "+905555550199",
        nationality: "Turkey",
        passportNumber: "PE2EFIXTURE001",
      })
      .where(eq(studentsTable.id, studentRow.id));
    console.log(`[e2e-setup] Fixture student already exists #${studentRow.id} (refreshed agentId=${agentId} + required fields)`);
    fixtureStudentId = studentRow.id;
  }

  // 6. Seed placeholder documents for the fixture student so that mandatory
  //    degree-level (Bachelor) and program-level document checks in
  //    POST /api/applications do not block the agent-apply E2E smoke test.
  //    We query the live DB for mandatory types so this stays in sync as
  //    requirements evolve; we insert a placeholder stub (no fileKey/fileUrl)
  //    for each missing type.
  const [bachelorOpt] = await db
    .select({ id: catalogOptionsTable.id })
    .from(catalogOptionsTable)
    .where(and(eq(catalogOptionsTable.category, "degree"), eq(catalogOptionsTable.value, "Bachelor")));

  const mandatoryTypes: string[] = [];

  if (bachelorOpt) {
    const degreeReqs = await db
      .select({ documentType: degreeDocumentRequirementsTable.documentType })
      .from(degreeDocumentRequirementsTable)
      .where(and(
        eq(degreeDocumentRequirementsTable.catalogOptionId, bachelorOpt.id),
        eq(degreeDocumentRequirementsTable.mandatory, true),
      ));
    mandatoryTypes.push(...degreeReqs.map(r => r.documentType));
  }

  if (mandatoryTypes.length > 0) {
    const existingDocs = await db
      .select({ type: documentsTable.type })
      .from(documentsTable)
      .where(and(
        eq(documentsTable.studentId, fixtureStudentId),
        isNull(documentsTable.deletedAt),
      ));
    const existingTypes = new Set(existingDocs.map(d => (d.type || "").toLowerCase()));

    for (const docType of mandatoryTypes) {
      if (!existingTypes.has(docType.toLowerCase())) {
        await db.insert(documentsTable).values({
          studentId: fixtureStudentId,
          name: `[E2E Placeholder] ${docType}`,
          type: docType,
          status: "approved",
        });
        console.log(`[e2e-setup] Seeded placeholder document: ${docType} for student #${fixtureStudentId}`);
      }
    }
    if (mandatoryTypes.every(t => existingTypes.has(t.toLowerCase()))) {
      console.log(`[e2e-setup] Fixture student #${fixtureStudentId} already has all ${mandatoryTypes.length} mandatory docs`);
    }
  } else {
    console.log(`[e2e-setup] No mandatory Bachelor degree documents configured — skipping doc seed`);
  }

  fs.writeFileSync(
    fixturesIdsFile,
    JSON.stringify({ agentId, fixtureStudentId, programId: prog.id }, null, 2),
    "utf8",
  );
  console.log(`[e2e-setup] Wrote ${fixturesIdsFile} (agentId=${agentId}, fixtureStudentId=${fixtureStudentId}, programId=${prog.id})`);
}

async function main() {
  await seedWebFormIntegration();
  await seedApplyFlowFixtures();

  try {
    await pool.query(`DELETE FROM rate_limits WHERE key LIKE '%login:%'`);
    console.log("[e2e-setup] Cleared login rate limits");
  } catch {
    console.log("[e2e-setup] rate_limits table not found, skipping clear");
  }

  try {
    await pool.query(`DELETE FROM pg_rate_limits`);
    console.log("[e2e-setup] Cleared pg_rate_limits (public-apply limiter)");
  } catch {
    console.log("[e2e-setup] pg_rate_limits table not found, skipping clear");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[e2e-setup] error:", err);
  process.exit(1);
});
