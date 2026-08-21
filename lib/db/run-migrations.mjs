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
if (!process.env.DATABASE_URL) {
  throw new Error("[migration] BLOCKED: DATABASE_URL is required");
}

const databaseUrl = new URL(process.env.DATABASE_URL);
if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) {
  throw new Error("[migration] BLOCKED: DATABASE_URL must use PostgreSQL");
}
const urlDatabase = decodeURIComponent(databaseUrl.pathname.replace(/^\//, ""));
const urlUser = decodeURIComponent(databaseUrl.username);
let expectedDatabase;
let expectedUser;
if (target === "test") {
  if (
    !["127.0.0.1", "localhost"].includes(databaseUrl.hostname) ||
    databaseUrl.port !== "5432" ||
    !/^fas_it_[a-z0-9_]+$/.test(urlDatabase) ||
    urlUser !== "fas_migrator"
  ) {
    throw new Error(
      "[migration] BLOCKED: test migrations require loopback:5432, fas_it_* database, and fas_migrator",
    );
  }
  expectedDatabase = urlDatabase;
  expectedUser = "fas_migrator";
} else {
  if (
    process.env.MIGRATION_CONFIRMED_HOST !== databaseUrl.hostname ||
    process.env.MIGRATION_CONFIRMED_DATABASE !== urlDatabase ||
    process.env.MIGRATION_CONFIRMED_USER !== urlUser
  ) {
    throw new Error(
      "[migration] BLOCKED: confirmed host, database, and user must match DATABASE_URL exactly",
    );
  }
  if (
    ["staging", "production"].includes(target) &&
    process.env.ALLOW_LONG_LIVED_MIGRATIONS !== "true"
  ) {
    throw new Error(
      "[migration] BLOCKED: ALLOW_LONG_LIVED_MIGRATIONS=true is required for staging or production",
    );
  }
  expectedDatabase = urlDatabase;
  expectedUser = urlUser;
}

validateMigrationLedger();
const identityClient = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 15_000,
  application_name: "fasos-reviewed-migration-preflight",
});
await identityClient.connect();
try {
  const identity = await identityClient.query(
    "SELECT current_database() AS database_name, current_user AS user_name",
  );
  if (
    identity.rows[0]?.database_name !== expectedDatabase ||
    identity.rows[0]?.user_name !== expectedUser
  ) {
    throw new Error(
      "[migration] BLOCKED: connected database identity does not match the confirmed target",
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
