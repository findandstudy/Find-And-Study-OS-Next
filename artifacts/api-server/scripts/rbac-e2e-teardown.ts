/**
 * RBAC E2E teardown — removes only rows that the matching setup run created.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@workspace/db";
import { assertSafeE2eDatabase } from "./e2e-database-safety";

assertSafeE2eDatabase();

const stateFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../rbac-e2e-state.json",
);

interface RbacState {
  createdUserEmails: string[];
  createdAgentIds: number[];
}

async function main() {
  if (!fs.existsSync(stateFile)) {
    console.log("[rbac-e2e-teardown] No saved state — skipping");
    await pool.end();
    return;
  }

  const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as RbacState;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (state.createdAgentIds.length > 0) {
      await client.query(`DELETE FROM agents WHERE id = ANY($1::int[])`, [
        state.createdAgentIds,
      ]);
    }
    if (state.createdUserEmails.length > 0) {
      await client.query(`DELETE FROM users WHERE email = ANY($1::text[])`, [
        state.createdUserEmails,
      ]);
    }
    await client.query("COMMIT");
    fs.rmSync(stateFile, { force: true });
    console.log(
      `[rbac-e2e-teardown] Removed ${state.createdUserEmails.length} users and ` +
      `${state.createdAgentIds.length} agents created by setup`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[rbac-e2e-teardown] ERROR:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

void main();
