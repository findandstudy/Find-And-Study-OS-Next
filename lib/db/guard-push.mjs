#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function assertLocalPushAllowed(env = process.env) {
  const selectedTarget = (env.MIGRATION_TARGET_ENV ?? env.NODE_ENV ?? "").toLowerCase();
  if (!["local", "development", "test"].includes(selectedTarget)) {
    throw new Error("[drizzle-push] BLOCKED: MIGRATION_TARGET_ENV must explicitly be local, development or test; production/staging-like and unclassified targets are forbidden");
  }
  if (env.ALLOW_LOCAL_DRIZZLE_PUSH !== "true") {
    throw new Error("[drizzle-push] BLOCKED: ALLOW_LOCAL_DRIZZLE_PUSH=true is required for a disposable local database");
  }
}

export function executeLocalPush() {
  assertLocalPushAllowed();
  const cwd = path.dirname(fileURLToPath(import.meta.url));
  return spawnSync("pnpm", ["exec", "drizzle-kit", "push", "--config", "./drizzle.config.ts"], {
    cwd, stdio: "inherit", env: process.env,
  }).status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exit(executeLocalPush());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
