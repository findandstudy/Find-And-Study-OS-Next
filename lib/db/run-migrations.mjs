#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { validateMigrationLedger } from "./validate-migrations.mjs";
import { verifyDatabaseMigrationState } from "./verify-migration-state.mjs";

if (process.env.ALLOW_REVIEWED_MIGRATIONS !== "true") {
  console.error(
    "[migration] BLOCKED: ALLOW_REVIEWED_MIGRATIONS=true is required",
  );
  process.exit(1);
}

const target = (process.env.MIGRATION_TARGET_ENV ?? "").toLowerCase();
if (
  !["local", "development", "test", "staging", "production"].includes(target)
) {
  throw new Error(
    "[migration] BLOCKED: MIGRATION_TARGET_ENV must be explicit and classified",
  );
}
if (["staging", "production"].includes(target)) {
  throw new Error(
    "[migration] BLOCKED: staging and production require a dedicated long-lived adoption runner with cluster identity and same-executor proof",
  );
}
if (!process.env.DATABASE_URL) {
  throw new Error("[migration] BLOCKED: DATABASE_URL is required");
}

let databaseUrl;
try {
  databaseUrl = new URL(process.env.DATABASE_URL);
} catch {
  throw new Error("[migration] BLOCKED: DATABASE_URL is malformed");
}
if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) {
  throw new Error("[migration] BLOCKED: DATABASE_URL must use PostgreSQL");
}
if ([...databaseUrl.searchParams.keys()].length > 0) {
  throw new Error(
    "[migration] BLOCKED: DATABASE_URL query parameters are forbidden for the reviewed local runner",
  );
}

const identityClient = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 15_000,
  application_name: "fasos-reviewed-migration-preflight",
});
const effectiveConnection = identityClient.connectionParameters;
const effectiveHost = effectiveConnection.host;
const effectivePort = Number(effectiveConnection.port);
const effectiveDatabase = effectiveConnection.database;
const effectiveUser = effectiveConnection.user;
let expectedDatabase;
let expectedUser;
if (target === "test") {
  if (
    !["127.0.0.1", "::1", "[::1]"].includes(effectiveHost) ||
    effectivePort !== 5432 ||
    !/^fas_it_[a-z0-9_]+$/.test(effectiveDatabase) ||
    effectiveUser !== "fas_migrator"
  ) {
    throw new Error(
      "[migration] BLOCKED: test migrations require loopback:5432, fas_it_* database, and fas_migrator",
    );
  }
  expectedDatabase = effectiveDatabase;
  expectedUser = "fas_migrator";
} else {
  if (
    !["127.0.0.1", "::1", "[::1]"].includes(effectiveHost) ||
    !Number.isSafeInteger(effectivePort) ||
    effectivePort < 1 ||
    effectivePort > 65_535 ||
    !/^(?:fasos_apply_local|fas_dev_[a-z0-9_]+)$/.test(effectiveDatabase) ||
    effectiveUser !== "fas_migrator"
  ) {
    throw new Error(
      "[migration] BLOCKED: local/development migrations require loopback, fasos_apply_local or fas_dev_* database, and fas_migrator",
    );
  }
  if (
    process.env.MIGRATION_CONFIRMED_HOST !== effectiveHost ||
    process.env.MIGRATION_CONFIRMED_PORT !== String(effectivePort) ||
    process.env.MIGRATION_CONFIRMED_DATABASE !== effectiveDatabase ||
    process.env.MIGRATION_CONFIRMED_USER !== effectiveUser
  ) {
    throw new Error(
      "[migration] BLOCKED: confirmed host, port, database, and user must match the effective PostgreSQL connection exactly",
    );
  }
  expectedDatabase = effectiveDatabase;
  expectedUser = effectiveUser;
}

validateMigrationLedger();
await identityClient.connect();
try {
  const identity = await identityClient.query(
    "SELECT current_database() AS database_name, current_user AS user_name, inet_server_addr()::text AS server_address, inet_server_port() AS server_port, role_row.rolsuper, role_row.rolcreatedb, role_row.rolcreaterole, role_row.rolinherit, role_row.rolreplication, role_row.rolbypassrls, role_row.rolcanlogin, EXISTS (SELECT 1 FROM pg_auth_members AS role_membership WHERE role_membership.member = role_row.oid) AS has_role_membership FROM pg_roles AS role_row WHERE role_row.rolname = current_user",
  );
  if (
    identity.rows[0]?.database_name !== expectedDatabase ||
    identity.rows[0]?.user_name !== expectedUser
  ) {
    throw new Error(
      "[migration] BLOCKED: connected database identity does not match the confirmed target",
    );
  }
  if (
    typeof identity.rows[0]?.server_address !== "string" ||
    identity.rows[0].server_address.length === 0 ||
    !Number.isSafeInteger(Number(identity.rows[0]?.server_port)) ||
    Number(identity.rows[0]?.server_port) < 1 ||
    Number(identity.rows[0]?.server_port) > 65_535
  ) {
    throw new Error(
      "[migration] BLOCKED: connected server did not expose a valid TCP endpoint",
    );
  }
  if (
    identity.rows[0]?.rolsuper !== false ||
    identity.rows[0]?.rolcreatedb !== false ||
    identity.rows[0]?.rolcreaterole !== false ||
    identity.rows[0]?.rolinherit !== false ||
    identity.rows[0]?.rolreplication !== false ||
    identity.rows[0]?.rolbypassrls !== false ||
    identity.rows[0]?.rolcanlogin !== true ||
    identity.rows[0]?.has_role_membership !== false
  ) {
    throw new Error(
      "[migration] BLOCKED: migrator must be a direct LOGIN with NOINHERIT, NOREPLICATION, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOBYPASSRLS, and no role memberships",
    );
  }
} finally {
  await identityClient.end();
}
const state = await verifyDatabaseMigrationState();
console.log(
  `[migration] Database preflight: ${state.state}; ${state.applied} applied migrations`,
);
const cwd = path.dirname(fileURLToPath(import.meta.url));
const result = spawnSync(
  "pnpm",
  ["exec", "drizzle-kit", "migrate", "--config", "./drizzle.config.ts"],
  {
    cwd,
    stdio: "inherit",
    env: process.env,
  },
);
process.exit(result.status ?? 1);
