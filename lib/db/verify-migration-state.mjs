#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(root, "drizzle");
const journalPath = path.join(migrationsDir, "meta", "_journal.json");

export function readExpectedMigrations() {
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  return journal.entries.map((entry) => {
    const sql = fs.readFileSync(path.join(migrationsDir, `${entry.tag}.sql`));
    return {
      tag: entry.tag,
      createdAt: String(entry.when),
      hash: crypto.createHash("sha256").update(sql).digest("hex"),
      sql: sql.toString("utf8"),
    };
  });
}

export async function verifyDatabaseMigrationState({
  connectionString = process.env.DATABASE_URL,
} = {}) {
  if (!connectionString)
    throw new Error("[migration-state] BLOCKED: DATABASE_URL is required");
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    application_name: "fasos-migration-preflight",
  });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const tableResult = await client.query(`
      SELECT count(*)::integer AS count
      FROM pg_catalog.pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'drizzle')
    `);
    const tableCount = Number(tableResult.rows[0]?.count ?? 0);
    const ledgerResult = await client.query(`
      SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists
    `);
    const ledgerExists = ledgerResult.rows[0]?.exists === true;
    if (!ledgerExists) {
      if (tableCount === 0) return { state: "fresh", tableCount, applied: 0 };
      throw new Error(
        `[migration-state] BLOCKED: non-empty database (${tableCount} tables) has no Drizzle ledger; perform a reviewed schema audit and explicit baseline instead of replaying migrations`,
      );
    }

    const appliedResult = await client.query(`
      SELECT hash, created_at::text AS created_at
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at, id
    `);
    const expected = readExpectedMigrations();
    if (appliedResult.rows.length > expected.length) {
      throw new Error(
        "[migration-state] BLOCKED: database ledger contains more entries than the repository",
      );
    }
    for (const [index, row] of appliedResult.rows.entries()) {
      const migration = expected[index];
      if (
        !migration ||
        row.created_at !== migration.createdAt ||
        row.hash !== migration.hash
      ) {
        throw new Error(
          `[migration-state] BLOCKED: ledger entry ${index} does not match repository history; do not rewrite or replay it automatically`,
        );
      }
    }
    return {
      state: "compatible",
      tableCount,
      applied: appliedResult.rows.length,
    };
  } finally {
    try {
      await client.query("ROLLBACK");
    } catch {}
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyDatabaseMigrationState();
    console.log(
      `[migration-state] OK: ${result.state}; ${result.applied} applied migrations`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
