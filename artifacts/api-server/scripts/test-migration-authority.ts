import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateMigrationLedger } from "../../../lib/db/validate-migrations.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const indexSource = readFileSync(
  path.join(root, "artifacts/api-server/src/index.ts"),
  "utf8",
);
const pipelineSource = readFileSync(
  path.join(root, "artifacts/api-server/src/routes/pipeline.ts"),
  "utf8",
);

test("all legacy boot DDL, seed and backfill calls are unreachable during API boot", () => {
  const bootStart = indexSource.indexOf("(async () => {");
  const disabledStart = indexSource.indexOf("if (false) {", bootStart);
  const backgroundStart = indexSource.indexOf(
    "const { BackgroundJobCoordinator",
    disabledStart,
  );
  assert(
    bootStart > 0 &&
      disabledStart > bootStart &&
      backgroundStart > disabledStart,
  );
  assert.match(
    indexSource.slice(disabledStart, backgroundStart),
    /CREATE\s+TABLE|ALTER\s+TABLE/i,
  );
  const executableBoot =
    indexSource.slice(bootStart, disabledStart) +
    indexSource.slice(backgroundStart);
  assert.doesNotMatch(
    executableBoot,
    /CREATE\s+(?:TABLE|INDEX|TYPE)|ALTER\s+TABLE/i,
  );
  assert.doesNotMatch(
    executableBoot,
    /await\s+(?:runSeedSQL|seedDocumentTypes|seedCurrencies|backfill[A-Z])/,
  );
  assert.doesNotMatch(
    executableBoot,
    /ensureRateLimitsTable|runDataCleanupOnce/,
  );
});

test("route imports do not invoke the legacy pipeline DDL/backfill block", () => {
  assert.match(
    pipelineSource,
    /async function legacyPipelineBootMigration\(\): Promise<void>/,
  );
  assert.doesNotMatch(
    pipelineSource,
    /(?:await|void)\s+legacyPipelineBootMigration\(\)|legacyPipelineBootMigration\(\);/,
  );
});

test("migration validator accepts a coherent disposable ledger fixture", () => {
  const fixture = mkdtempSync(
    path.join(os.tmpdir(), "fasos-migration-ledger-"),
  );
  try {
    const meta = path.join(fixture, "meta");
    mkdirSync(meta);
    writeFileSync(path.join(fixture, "0000_fixture.sql"), "SELECT 1;\n");
    writeFileSync(
      path.join(meta, "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [
          {
            idx: 0,
            version: "7",
            when: 1,
            tag: "0000_fixture",
            breakpoints: true,
          },
        ],
      }),
    );
    assert.deepEqual(
      validateMigrationLedger({
        migrationsDir: fixture,
        journalPath: path.join(meta, "_journal.json"),
      }),
      { files: 1, journalEntries: 1 },
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("repository migration history is complete, ordered and duplicate-free", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "lib/db/validate-migrations.mjs")],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK: (\d+) files, \1 journal entries/);
});

test("migration validator rejects duplicate ids and non-monotonic journal timestamps", () => {
  const fixture = mkdtempSync(
    path.join(os.tmpdir(), "fasos-invalid-migration-ledger-"),
  );
  try {
    const meta = path.join(fixture, "meta");
    mkdirSync(meta);
    writeFileSync(path.join(fixture, "0000_first.sql"), "SELECT 1;\n");
    writeFileSync(path.join(fixture, "0000_second.sql"), "SELECT 2;\n");
    writeFileSync(
      path.join(meta, "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [
          {
            idx: 0,
            version: "7",
            when: 2,
            tag: "0000_first",
            breakpoints: true,
          },
          {
            idx: 1,
            version: "7",
            when: 1,
            tag: "0000_second",
            breakpoints: true,
          },
        ],
      }),
    );
    assert.throws(
      () =>
        validateMigrationLedger({
          migrationsDir: fixture,
          journalPath: path.join(meta, "_journal.json"),
        }),
      /duplicate ids: 0000=.*journal timestamps must increase/,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("all drizzle push entrypoints reject production, staging and unclassified targets before DB access", () => {
  for (const entrypoint of ["guard-push.mjs", "retry-push.mjs"]) {
    for (const target of ["production", "staging", ""]) {
      const result = spawnSync(
        process.execPath,
        [path.join(root, "lib/db", entrypoint)],
        {
          cwd: path.join(root, "lib/db"),
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_ENV: "",
            MIGRATION_TARGET_ENV: target,
            ALLOW_LOCAL_DRIZZLE_PUSH: "true",
          },
        },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /unclassified targets are forbidden/);
    }
  }
});

test("legacy pre-migration cleanup is explicit and local-only", () => {
  for (const target of ["production", "staging", ""]) {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "lib/db/pre-migrate.mjs")],
      {
        cwd: path.join(root, "lib/db"),
        encoding: "utf8",
        env: {
          ...process.env,
          MIGRATION_TARGET_ENV: target,
          ALLOW_PRE_MIGRATION_CLEANUP: "true",
        },
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must explicitly be local/);
  }
});

test("db restore helper rejects unclassified and production-like targets before commands", (t) => {
  const bashProbe = spawnSync("bash", ["-c", "exit 0"], {
    encoding: "utf8",
  });
  if (bashProbe.error || bashProbe.status !== 0) {
    t.skip("a working bash runtime is unavailable on this host");
    return;
  }
  const script = path.join(root, "scripts/db-migrate.sh");
  const unclassified = spawnSync("bash", [script], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(unclassified.status, 1);
  assert.match(unclassified.stderr, /MIGRATION_TARGET_ENV/);
  const production = spawnSync("bash", [script], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      MIGRATION_TARGET_ENV: "production",
      ALLOW_LOCAL_DB_MIGRATION: "true",
    },
  });
  assert.equal(production.status, 1);
  assert.match(production.stderr, /forbidden for production\/staging targets/);
});

test("migration command requires explicit approval and has no push fallback", () => {
  const runner = spawnSync(
    process.execPath,
    [path.join(root, "lib/db/run-migrations.mjs")],
    {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    },
  );
  assert.equal(runner.status, 1);
  assert.match(runner.stderr, /ALLOW_REVIEWED_MIGRATIONS=true/);
  const dbMigrate = readFileSync(
    path.join(root, "scripts/db-migrate.sh"),
    "utf8",
  );
  assert.doesNotMatch(dbMigrate, /drizzle-kit\s+push|run push|push-force/);
  assert.match(dbMigrate, /set -eo pipefail/);
  assert.match(
    dbMigrate,
    /Refusing to run migrations against a partial or unverified restore/,
  );
});

test("reviewed migration runner pins target class, endpoint, database, and role", () => {
  const runner = path.join(root, "lib/db/run-migrations.mjs");
  const remoteTest = spawnSync(process.execPath, [runner], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      ALLOW_REVIEWED_MIGRATIONS: "true",
      MIGRATION_TARGET_ENV: "test",
      DATABASE_URL:
        "postgresql://fas_migrator:blocked@db.example.test:5432/fas_it_blocked",
    },
  });
  assert.equal(remoteTest.status, 1);
  assert.match(remoteTest.stderr, /test migrations require loopback:5432/);

  const namedLoopback = spawnSync(process.execPath, [runner], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      ALLOW_REVIEWED_MIGRATIONS: "true",
      MIGRATION_TARGET_ENV: "test",
      DATABASE_URL:
        "postgresql://fas_migrator:blocked@localhost:5432/fas_it_blocked",
    },
  });
  assert.equal(namedLoopback.status, 1);
  assert.match(namedLoopback.stderr, /test migrations require loopback:5432/);

  const queryOverride = spawnSync(process.execPath, [runner], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      ALLOW_REVIEWED_MIGRATIONS: "true",
      MIGRATION_TARGET_ENV: "test",
      DATABASE_URL:
        "postgresql://fas_migrator:blocked@localhost:5432/fas_it_blocked?host=db.example.test&port=6543&user=other",
    },
  });
  assert.equal(queryOverride.status, 1);
  assert.match(
    queryOverride.stderr,
    /DATABASE_URL query parameters are forbidden/,
  );

  const relabeledRemote = spawnSync(process.execPath, [runner], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      ALLOW_REVIEWED_MIGRATIONS: "true",
      MIGRATION_TARGET_ENV: "development",
      DATABASE_URL:
        "postgresql://fas_migrator:blocked@db.example.test:5432/fas_dev_blocked",
      MIGRATION_CONFIRMED_HOST: "db.example.test",
      MIGRATION_CONFIRMED_PORT: "5432",
      MIGRATION_CONFIRMED_DATABASE: "fas_dev_blocked",
      MIGRATION_CONFIRMED_USER: "fas_migrator",
    },
  });
  assert.equal(relabeledRemote.status, 1);
  assert.match(
    relabeledRemote.stderr,
    /local\/development migrations require loopback/,
  );

  const production = spawnSync(process.execPath, [runner], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      ALLOW_REVIEWED_MIGRATIONS: "true",
      MIGRATION_TARGET_ENV: "production",
      DATABASE_URL:
        "postgresql://fas_migrator:blocked@db.example.test:5432/fasos",
    },
  });
  assert.equal(production.status, 1);
  assert.match(
    production.stderr,
    /dedicated long-lived adoption runner/,
  );

  const malformed = spawnSync(process.execPath, [runner], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      ALLOW_REVIEWED_MIGRATIONS: "true",
      MIGRATION_TARGET_ENV: "test",
      DATABASE_URL: "postgresql://do-not-print-this@[",
    },
  });
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /DATABASE_URL is malformed/);
  assert.doesNotMatch(malformed.stderr, /do-not-print-this/);

  const source = readFileSync(runner, "utf8");
  assert.match(source, /current_database\(\) AS database_name/);
  assert.match(source, /current_user AS user_name/);
  assert.match(source, /identityClient\.connectionParameters/);
  assert.match(source, /inet_server_addr\(\)/);
  assert.match(source, /rolinherit/);
  assert.match(source, /rolreplication/);
  assert.match(source, /rolbypassrls/);
  assert.match(source, /pg_auth_members/);
  assert.match(source, /MIGRATION_CONFIRMED_PORT/);
  assert.match(source, /MIGRATION_CONFIRMED_DATABASE/);
  assert.match(source, /fas_it_\[a-z0-9_\]/);
  assert.match(
    source,
    /staging and production require a dedicated long-lived adoption runner/,
  );
});

test("ledger baseline requires explicit audit and exact database confirmation before DB access", () => {
  const baseline = spawnSync(
    process.execPath,
    [path.join(root, "lib/db/baseline-migrations.mjs")],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        DATABASE_URL: "postgresql://invalid.example/blocked",
        MIGRATION_TARGET_ENV: "test",
      },
    },
  );
  assert.equal(baseline.status, 1);
  assert.match(
    baseline.stderr,
    /ALLOW_MIGRATION_BASELINE=true and MIGRATION_SCHEMA_AUDIT_CONFIRMED=true/,
  );

  const source = readFileSync(
    path.join(root, "lib/db/baseline-migrations.mjs"),
    "utf8",
  );
  assert.match(source, /MIGRATION_BASELINE_CONFIRMED_DB/);
  assert.match(source, /MIGRATION_BASELINE_THROUGH_TAG/);
  assert.match(source, /unknown MIGRATION_BASELINE_THROUGH_TAG/);
  assert.match(source, /expectedMigrations\.slice\(0, throughIndex \+ 1\)/);
  assert.match(source, /BEGIN READ ONLY/);
  assert.doesNotMatch(
    source,
    /(?:DELETE|UPDATE|TRUNCATE)\s+(?:FROM\s+)?(?:public\.)?(?:students|leads|applications|documents)/i,
  );
});
