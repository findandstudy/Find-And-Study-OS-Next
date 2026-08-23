/**
 * RBAC E2E setup.
 *
 * Creates the complete, deterministic role matrix required by
 * rbac-functional.spec.ts. IDs are resolved from the database instead of
 * assuming production-specific sequence values. A state file records only
 * rows created by this run so teardown never removes pre-existing audit data.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import { pool } from "@workspace/db";
import { assertSafeE2eDatabase } from "./e2e-database-safety";

assertSafeE2eDatabase();

const PASSWORD = process.env.RBAC_E2E_PASSWORD;
if (!PASSWORD) {
  throw new Error("RBAC_E2E_PASSWORD is required for RBAC E2E setup");
}
const ALL_PERMS = ["leads", "students", "applications", "documents", "course_finder", "messages", "commissions"];

const USERS = [
  ["audit-superadmin@audit.test", "super_admin", "SuperAdmin"],
  ["audit-admin@audit.test", "admin", "Admin"],
  ["audit-manager@audit.test", "manager", "Manager"],
  ["audit-staff@audit.test", "staff", "Staff"],
  ["audit-consultant@audit.test", "consultant", "Consultant"],
  ["audit-editor@audit.test", "editor", "Editor"],
  ["audit-accountant@audit.test", "accountant", "Accountant"],
  ["audit-agent@audit.test", "agent", "Agent"],
  ["audit-subagent@audit.test", "sub_agent", "SubAgent"],
  ["audit-agentstaff@audit.test", "agent_staff", "AgentStaff"],
  ["audit-student@audit.test", "student", "Student"],
] as const;

const stateFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../rbac-e2e-state.json",
);

interface RbacState {
  createdUserEmails: string[];
  createdAgentIds: number[];
}

async function main() {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const client = await pool.connect();
  const state: RbacState = { createdUserEmails: [], createdAgentIds: [] };
  try {
    await client.query("BEGIN");

    const userIds = new Map<string, number>();
    for (const [email, role, lastName] of USERS) {
      const before = await client.query<{ id: number }>(
        `SELECT id FROM users WHERE email = $1`,
        [email],
      );
      if (before.rowCount === 0) state.createdUserEmails.push(email);

      const result = await client.query<{ id: number }>(
        `INSERT INTO users (
           email, password_hash, role, first_name, last_name,
           is_active, email_verified, created_at, updated_at
         )
         VALUES ($1, $2, $3, 'Audit', $4, true, true, NOW(), NOW())
         ON CONFLICT (email) DO UPDATE SET
           password_hash = EXCLUDED.password_hash,
           role = EXCLUDED.role,
           is_active = true,
           email_verified = true,
           updated_at = NOW()
         RETURNING id`,
        [email, passwordHash, role, lastName],
      );
      userIds.set(email, result.rows[0].id);
    }

    const agentUserId = userIds.get("audit-agent@audit.test")!;
    const subAgentUserId = userIds.get("audit-subagent@audit.test")!;
    const agentStaffUserId = userIds.get("audit-agentstaff@audit.test")!;

    const ensureAgent = async (
      userId: number,
      email: string,
      companyName: string,
      lastName: string,
      parentAgentId: number | null,
    ): Promise<number> => {
      const existing = await client.query<{ id: number }>(
        `SELECT id FROM agents WHERE user_id = $1`,
        [userId],
      );
      if (existing.rowCount) return existing.rows[0].id;

      const inserted = await client.query<{ id: number }>(
        `INSERT INTO agents (
           user_id, company_name, first_name, last_name, email,
           parent_agent_id, status, created_at, updated_at
         )
         VALUES ($1, $2, 'Audit', $3, $4, $5, 'active', NOW(), NOW())
         RETURNING id`,
        [userId, companyName, lastName, email, parentAgentId],
      );
      state.createdAgentIds.push(inserted.rows[0].id);
      return inserted.rows[0].id;
    };

    const agentId = await ensureAgent(
      agentUserId,
      "audit-agent@audit.test",
      "Audit Agency",
      "Agent",
      null,
    );
    await ensureAgent(
      subAgentUserId,
      "audit-subagent@audit.test",
      "Audit SubAgency",
      "SubAgent",
      agentId,
    );

    await client.query(
      `UPDATE users
       SET agent_staff_permissions = $1, managing_agent_id = $2, updated_at = NOW()
       WHERE id = $3`,
      [JSON.stringify(ALL_PERMS), agentId, agentStaffUserId],
    );

    await client.query(`DELETE FROM rate_limits WHERE key LIKE '%login:%'`);
    await client.query(`DELETE FROM pg_rate_limits`);
    await client.query("COMMIT");

    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
    console.log(
      `[rbac-e2e-setup] ${USERS.length} users ready; ` +
      `${state.createdUserEmails.length} users and ${state.createdAgentIds.length} agents created`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[rbac-e2e-setup] ERROR:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

void main();
