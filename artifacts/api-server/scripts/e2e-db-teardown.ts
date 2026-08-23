/**
 * Playwright e2e database teardown.
 *
 * Two responsibilities:
 *
 *  1. Restores the web_form integration to the state that was saved by
 *     e2e-db-setup.ts.  If the integration did not exist before the test run
 *     it is deleted; otherwise its previous config/isEnabled are restored.
 *
 *  2. Cleans up apply-flow fixtures (deterministic test agent / university /
 *     program) seeded by e2e-db-setup.ts, plus any residual rows produced by
 *     apply-flows.spec.ts (applications / commissions / service_fees /
 *     students / users with the e2e prefix). Cleanup is best-effort and
 *     guards against missing tables.
 *
 * Run via playwright globalTeardown (see playwright.config.ts).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  db, pool,
  integrationsTable,
  usersTable,
  agentsTable,
  universitiesTable,
  programsTable,
} from "@workspace/db";
import { eq, like } from "drizzle-orm";
import { assertSafeE2eDatabase } from "./e2e-database-safety";

assertSafeE2eDatabase();

const stateFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../e2e-db-state.json",
);

const E2E_FIXTURE = {
  agentUserEmail: "e2e-agent@test.local",
  agentName: "E2E Test Agent",
  universityName: "E2E Test University",
  programName: "E2E Test Program",
  fixtureStudentEmail: "e2e-fixture-student@test.local",
};

const fixturesIdsFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../e2e-fixtures.json",
);

async function restoreWebFormIntegration() {
  if (!fs.existsSync(stateFile)) {
    console.log("[e2e-teardown] No saved state found — skipping web_form restore");
    return;
  }

  const raw = fs.readFileSync(stateFile, "utf8");
  const original = JSON.parse(raw);
  fs.unlinkSync(stateFile);

  if (original === null) {
    await db
      .delete(integrationsTable)
      .where(eq(integrationsTable.key, "web_form"));
    console.log("[e2e-teardown] Removed web_form integration (it did not exist before the test)");
  } else {
    await db
      .update(integrationsTable)
      .set({
        isEnabled: original.isEnabled,
        config: original.config,
      })
      .where(eq(integrationsTable.key, "web_form"));
    console.log("[e2e-teardown] Restored web_form integration to pre-test state");
  }
}

async function cleanupApplyFlowFixtures() {
  // 1. Remove residual rows produced by apply-flows.spec.ts (RUN_ID-tagged).
  //    These reference fixture rows so they must be deleted first.
  try {
    await pool.query(
      `DELETE FROM commissions WHERE student_name LIKE 'E2E%' OR student_name LIKE 'apply_e2e_%'`,
    );
    await pool.query(
      `DELETE FROM service_fees WHERE student_name LIKE 'E2E%' OR student_name LIKE 'apply_e2e_%'`,
    );
    await pool.query(
      `DELETE FROM applications WHERE student_id IN (SELECT id FROM students WHERE email LIKE '%apply_e2e_%@e2e.test' OR email = $1)`,
      [E2E_FIXTURE.fixtureStudentEmail],
    );
    await pool.query(
      `DELETE FROM students WHERE email LIKE '%apply_e2e_%@e2e.test' OR email = $1`,
      [E2E_FIXTURE.fixtureStudentEmail],
    );
  } catch (err) {
    console.warn("[e2e-teardown] residual cleanup skipped:", (err as Error).message);
  }

  // 2. Delete users created by apply-flows (public-apply path) — RUN_ID tagged.
  try {
    await db
      .delete(usersTable)
      .where(like(usersTable.email, "%apply_e2e_%@e2e.test"));
  } catch (err) {
    console.warn("[e2e-teardown] e2e users cleanup skipped:", (err as Error).message);
  }

  // 3. Drop the deterministic agent fixture (also drops applications referencing it via FK rules).
  //    agentsTable has no `name` column — match by email (set on the fixture row).
  try {
    await pool.query(
      `DELETE FROM applications WHERE agent_id IN (SELECT id FROM agents WHERE email = $1)`,
      [E2E_FIXTURE.agentUserEmail],
    );
    await db.delete(agentsTable).where(eq(agentsTable.email, E2E_FIXTURE.agentUserEmail));
    await db.delete(usersTable).where(eq(usersTable.email, E2E_FIXTURE.agentUserEmail));
  } catch (err) {
    console.warn("[e2e-teardown] agent fixture cleanup skipped:", (err as Error).message);
  }

  // 4. Drop the deterministic program + university (program first due to FK).
  try {
    await db.delete(programsTable).where(eq(programsTable.name, E2E_FIXTURE.programName));
    await db.delete(universitiesTable).where(eq(universitiesTable.name, E2E_FIXTURE.universityName));
  } catch (err) {
    console.warn("[e2e-teardown] program/university cleanup skipped:", (err as Error).message);
  }

  try {
    if (fs.existsSync(fixturesIdsFile)) fs.unlinkSync(fixturesIdsFile);
  } catch (err) {
    console.warn("[e2e-teardown] fixtures id file cleanup skipped:", (err as Error).message);
  }

  console.log("[e2e-teardown] Apply-flow fixtures cleaned up");
}

async function cleanupInboxFlowFixtures() {
  // Rows produced by inbox-flow.spec.ts. The webhook posts a RUN_ID-tagged
  // web_form submission (name "Playwright Inbox <run>", email
  // "inbox_<run>@e2e.test"), which creates: an external_contacts row keyed by
  // that email, a conversation pointing at it (messages cascade via FK), and
  // inbox notifications fanned out to staff. Match on the e2e email prefix so
  // every prior run's residue is swept up too (idempotent). The `_` in LIKE is
  // escaped so it matches the literal underscore rather than any single char.
  try {
    // 1. Notifications have no FK to conversations — the link lives in the
    //    jsonb `data.conversationId` — so they must be deleted explicitly
    //    before the conversation rows go away.
    await pool.query(
      `DELETE FROM notifications
        WHERE type LIKE 'inbox.%'
          AND (data->>'conversationId') ~ '^[0-9]+$'
          AND (data->>'conversationId')::int IN (
            SELECT c.id FROM conversations c
            JOIN external_contacts ec ON ec.id = c.external_contact_id
            WHERE ec.channel = 'web_form'
              AND ec.email LIKE 'inbox\\_%@e2e.test'
          )`,
    );

    // 2. Delete the conversations (messages cascade via ON DELETE CASCADE).
    await pool.query(
      `DELETE FROM conversations c
        USING external_contacts ec
        WHERE c.external_contact_id = ec.id
          AND ec.channel = 'web_form'
          AND ec.email LIKE 'inbox\\_%@e2e.test'`,
    );

    // 3. Delete the external contacts themselves.
    await pool.query(
      `DELETE FROM external_contacts
        WHERE channel = 'web_form'
          AND email LIKE 'inbox\\_%@e2e.test'`,
    );

    console.log("[e2e-teardown] Inbox flow fixtures cleaned up");
  } catch (err) {
    console.warn("[e2e-teardown] inbox flow cleanup skipped:", (err as Error).message);
  }
}

async function main() {
  await restoreWebFormIntegration();
  await cleanupApplyFlowFixtures();
  await cleanupInboxFlowFixtures();
  process.exit(0);
}

main().catch((err) => {
  console.error("[e2e-teardown] error:", err);
  process.exit(1);
});
