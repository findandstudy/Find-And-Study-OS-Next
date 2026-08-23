#!/usr/bin/env node
/**
 * One-shot database cleanup.
 *
 * Wipes all student/lead/application/document/message/etc. data and
 * trims the users table down to one user per privileged role
 * (plus an optional explicit allow-list of emails).
 *
 * Idempotent: records `cleanup_data_v1_done` in `system_flags` and
 * exits early on subsequent runs. Bump the version constant + add a
 * new flag key when you want to re-run.
 *
 * Manual-only safety contract:
 *   ALLOW_DESTRUCTIVE_DATA_CLEANUP=true node lib/db/cleanup-data.mjs
 *
 * This script must never be called from deploy or application startup paths.
 */
import pg from "pg";

const VERSION_FLAG = "cleanup_data_v1_done";
const CLEANUP_FLAG = "ALLOW_DESTRUCTIVE_DATA_CLEANUP";

if (process.env[CLEANUP_FLAG] !== "true") {
  console.error(
    `[cleanup-data] BLOCKED: ${CLEANUP_FLAG}=true is required for this destructive manual operation.`,
  );
  process.exit(1);
}

// Privileged users that must NEVER be deleted, identified by email.
// On dev these resolve to: en@findandstudy.com (super_admin),
// findandstudy@gmail.com (super_admin), staff@educons.com (staff),
// omar@agent.com (agent), ali@sub.agent.com (sub_agent).
const KEEP_EMAILS = [
  "en@findandstudy.com",
  "findandstudy@gmail.com",
  "staff@educons.com",
  "omar@agent.com",
  "ali@sub.agent.com",
];

// For each of these roles, we ensure at least one user is kept.
// If no email-allow-listed user already covers the role, the
// oldest (lowest id) user in that role is kept as a placeholder.
const ROLES_REQUIRE_ONE = [
  "super_admin",
  "admin",
  "agent",
  "sub_agent",
  "staff",
];

// Tables that contain student / lead / application / messaging /
// audit / activity data. Wiped via TRUNCATE ... CASCADE.
// Catalog, CMS, settings, integrations, pipeline definitions and
// embed widget configs are intentionally preserved.
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

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[cleanup-data] DATABASE_URL not set; skipping.");
  process.exit(0);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function tableExists(client, table) {
  const r = await client.query("SELECT to_regclass($1) AS oid", [`public.${table}`]);
  return r.rows[0]?.oid != null;
}

async function ensureSystemFlagsTable(client) {
  // The schema defines system_flags; this is just a guard for
  // very early environments where the table may not yet exist.
  await client.query(`
    CREATE TABLE IF NOT EXISTS system_flags (
      key text PRIMARY KEY,
      created_at timestamptz DEFAULT now()
    )
  `);
}

async function alreadyRan(client) {
  const r = await client.query("SELECT 1 FROM system_flags WHERE key = $1", [VERSION_FLAG]);
  return r.rowCount > 0;
}

async function main() {
  const client = await pool.connect();
  try {
    await ensureSystemFlagsTable(client);
    if (await alreadyRan(client)) {
      console.log(`[cleanup-data] flag '${VERSION_FLAG}' already set — skipping.`);
      return;
    }

    console.log("[cleanup-data] starting cleanup...");

    // 1) Compute the set of user ids to keep.
    const byEmail = await client.query(
      `SELECT id, role FROM users WHERE lower(email) = ANY($1::text[])`,
      [KEEP_EMAILS.map((e) => e.toLowerCase())],
    );
    const keepIds = new Set(byEmail.rows.map((r) => r.id));
    const coveredRoles = new Set(byEmail.rows.map((r) => r.role));

    for (const role of ROLES_REQUIRE_ONE) {
      if (coveredRoles.has(role)) continue;
      const r = await client.query(
        `SELECT id FROM users WHERE role = $1 ORDER BY id ASC LIMIT 1`,
        [role],
      );
      if (r.rowCount > 0) {
        keepIds.add(r.rows[0].id);
        console.log(`[cleanup-data] role '${role}' has no allow-listed user — keeping oldest id=${r.rows[0].id}`);
      } else {
        console.log(`[cleanup-data] role '${role}' has no users; nothing to keep.`);
      }
    }

    if (keepIds.size === 0) {
      console.error("[cleanup-data] refusing to run: would delete ALL users. Aborting.");
      return;
    }

    const keepIdsArr = [...keepIds];
    console.log(`[cleanup-data] keeping ${keepIdsArr.length} user(s): ${keepIdsArr.join(", ")}`);

    // 2) Wipe all student/lead/application/etc. data inside a transaction.
    await client.query("BEGIN");
    try {
      const present = [];
      for (const t of DATA_TABLES) {
        if (await tableExists(client, t)) present.push(t);
      }
      if (present.length > 0) {
        const list = present.map((t) => `"${t}"`).join(", ");
        await client.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
        console.log(`[cleanup-data] truncated ${present.length} data table(s).`);
      }

      // 3) Delete agent rows that don't belong to a kept user.
      // (Catalog tables that FK into agents use ON DELETE SET NULL.)
      if (await tableExists(client, "agents")) {
        await client.query(
          `DELETE FROM agents WHERE user_id IS NULL OR user_id <> ALL($1::int[])`,
          [keepIdsArr],
        );
      }

      // 4) Trim users to the keep set.
      const del = await client.query(
        `DELETE FROM users WHERE id <> ALL($1::int[]) RETURNING id, email, role`,
        [keepIdsArr],
      );
      console.log(`[cleanup-data] deleted ${del.rowCount} user(s).`);

      // 5) Mark done.
      await client.query(
        `INSERT INTO system_flags(key) VALUES ($1)
         ON CONFLICT(key) DO NOTHING`,
        [VERSION_FLAG],
      );

      await client.query("COMMIT");
      console.log("[cleanup-data] done.");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error("[cleanup-data] FAILED:", e);
  process.exit(1);
});
