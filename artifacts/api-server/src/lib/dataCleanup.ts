import { pool } from "@workspace/db";

/**
 * Destructive one-shot data cleanup retained for explicit manual tooling only.
 *
 * It is intentionally not called from API boot or deployment. The explicit
 * environment gate below is a second line of defence in case a future caller
 * imports this function directly.
 *
 * Wipes student/lead/application/document/message/audit data and
 * trims the users table to one user per privileged role (plus an
 * email allow-list of seed accounts).
 */

const VERSION_FLAG = "cleanup_data_v1_done";
const CLEANUP_FLAG = "ALLOW_DESTRUCTIVE_DATA_CLEANUP";

const KEEP_EMAILS = [
  "en@findandstudy.com",
  "findandstudy@gmail.com",
  "staff@educons.com",
  "omar@agent.com",
  "ali@sub.agent.com",
];

const ROLES_REQUIRE_ONE = [
  "super_admin",
  "admin",
  "agent",
  "sub_agent",
  "staff",
];

const DATA_TABLES = [
  "students",
  "leads",
  "applications",
  "application_stage_documents",
  "documents",
  "follow_ups",
  "tasks",
  "notes",
  "messages",
  "conversations",
  "conversation_participants",
  "broadcasts",
  "notifications",
  "email_queue",
  "email_verification_codes",
  "embed_submissions",
  "external_contacts",
  "financial_transactions",
  "commissions",
  "invoices",
  "audit_logs",
  "user_activity_events",
  "user_page_visits",
  "user_presence",
  "user_sessions_activity",
  "wishlists",
  "website_form_submissions",
  "announcements",
];

export async function runDataCleanupOnce(): Promise<void> {
  if (process.env[CLEANUP_FLAG] !== "true") {
    const message = `[cleanup-data] BLOCKED: ${CLEANUP_FLAG}=true is required for this destructive manual operation.`;
    if (process.env.NODE_ENV === "production") {
      throw new Error(message);
    }
    console.warn(message);
    return;
  }

  const client = await pool.connect();
  try {
    const flag = await client.query("SELECT 1 FROM system_flags WHERE key = $1", [VERSION_FLAG]);
    if ((flag.rowCount ?? 0) > 0) {
      return;
    }

    console.log("[cleanup-data] starting one-shot cleanup...");

    const byEmail = await client.query(
      `SELECT id, role FROM users WHERE lower(email) = ANY($1::text[])`,
      [KEEP_EMAILS.map((e) => e.toLowerCase())],
    );
    const keepIds = new Set<number>(byEmail.rows.map((r: any) => r.id));
    const coveredRoles = new Set<string>(byEmail.rows.map((r: any) => r.role));

    for (const role of ROLES_REQUIRE_ONE) {
      if (coveredRoles.has(role)) continue;
      const r = await client.query(
        `SELECT id FROM users WHERE role = $1 ORDER BY id ASC LIMIT 1`,
        [role],
      );
      if ((r.rowCount ?? 0) > 0) {
        keepIds.add(r.rows[0].id);
        console.log(`[cleanup-data] role '${role}' has no allow-listed user — keeping oldest id=${r.rows[0].id}`);
      }
    }

    if (keepIds.size === 0) {
      console.error("[cleanup-data] refusing to run: would delete ALL users. Aborting.");
      return;
    }

    const keepIdsArr = [...keepIds];
    console.log(`[cleanup-data] keeping ${keepIdsArr.length} user(s): ${keepIdsArr.join(", ")}`);

    await client.query("BEGIN");
    try {
      const present: string[] = [];
      for (const t of DATA_TABLES) {
        const r = await client.query("SELECT to_regclass($1) AS oid", [`public.${t}`]);
        if (r.rows[0]?.oid != null) present.push(t);
      }
      if (present.length > 0) {
        const list = present.map((t) => `"${t}"`).join(", ");
        await client.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
        console.log(`[cleanup-data] truncated ${present.length} data table(s).`);
      }

      const agentsExists = await client.query("SELECT to_regclass('public.agents') AS oid");
      if (agentsExists.rows[0]?.oid != null) {
        await client.query(
          `DELETE FROM agents WHERE user_id IS NULL OR user_id <> ALL($1::int[])`,
          [keepIdsArr],
        );
      }

      const del = await client.query(
        `DELETE FROM users WHERE id <> ALL($1::int[])`,
        [keepIdsArr],
      );
      console.log(`[cleanup-data] deleted ${del.rowCount} user(s).`);

      await client.query(
        `INSERT INTO system_flags(key) VALUES ($1) ON CONFLICT(key) DO NOTHING`,
        [VERSION_FLAG],
      );

      await client.query("COMMIT");
      console.log("[cleanup-data] done.");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  } catch (err) {
    console.error("[cleanup-data] FAILED:", err);
  } finally {
    client.release();
  }
}
