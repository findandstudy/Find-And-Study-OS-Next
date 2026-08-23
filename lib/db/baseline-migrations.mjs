#!/usr/bin/env node
import pg from "pg";
import { fileURLToPath } from "node:url";
import { validateMigrationLedger } from "./validate-migrations.mjs";
import { readExpectedMigrations } from "./verify-migration-state.mjs";

function collectExpectedCatalog(migrations) {
  const tables = new Set();
  const columns = new Map();
  const indexes = new Map();
  const enums = new Map();

  for (const migration of migrations) {
    const migrationId = Number(migration.tag.slice(0, 4));
    for (const match of migration.sql.matchAll(
      /CREATE TABLE(?: IF NOT EXISTS)?\s+"([^"]+)"/gi,
    )) {
      tables.add(match[1]);
    }
    for (const match of migration.sql.matchAll(
      /DROP TABLE IF EXISTS\s+"([^"]+)"/gi,
    )) {
      tables.delete(match[1]);
      for (const [indexName, tableName] of indexes) {
        if (tableName === match[1]) indexes.delete(indexName);
      }
    }
    for (const match of migration.sql.matchAll(
      /ALTER TABLE\s+"([^"]+)"\s+ADD COLUMN IF NOT EXISTS\s+"([^"]+)"/gi,
    )) {
      const current = columns.get(match[1]) ?? new Set();
      current.add(match[2]);
      columns.set(match[1], current);
    }
    // Legacy index names drifted while their semantic indexes remained. Only
    // adoption migrations use canonical names and are safe to require exactly.
    if (migrationId >= 38) {
      for (const match of migration.sql.matchAll(
        /CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?\s*"([^"]+)"\s+ON\s+"([^"]+)"/gi,
      )) {
        indexes.set(match[1], match[2]);
      }
    }
    for (const match of migration.sql.matchAll(
      /CREATE TYPE\s+"public"\."([^"]+)"\s+AS ENUM\(([^)]+)\)/gi,
    )) {
      enums.set(
        match[1],
        [...match[2].matchAll(/'([^']+)'/g)].map((value) => value[1]),
      );
    }
    for (const match of migration.sql.matchAll(
      /ALTER TYPE\s+"public"\."([^"]+)"\s+ADD VALUE IF NOT EXISTS\s+'([^']+)'/gi,
    )) {
      const values = enums.get(match[1]) ?? [];
      if (!values.includes(match[2])) values.push(match[2]);
      enums.set(match[1], values);
    }
  }
  return { tables, columns, indexes, enums };
}

async function assertSchemaReady(client, migrations) {
  const expected = collectExpectedCatalog(migrations);
  const tables = await client.query(`
    SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'
  `);
  const actualTables = new Set(tables.rows.map((row) => row.tablename));
  const missingTables = [...expected.tables].filter(
    (name) => !actualTables.has(name),
  );

  const missingColumns = [];
  for (const [table, names] of expected.columns) {
    const result = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    );
    const actual = new Set(result.rows.map((row) => row.column_name));
    for (const name of names)
      if (!actual.has(name)) missingColumns.push(`${table}.${name}`);
  }

  const relationResult = await client.query(`
    SELECT c.relname
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('i', 'I')
  `);
  const actualIndexes = new Set(relationResult.rows.map((row) => row.relname));
  const missingIndexes = [...expected.indexes.keys()].filter(
    (name) => !actualIndexes.has(name),
  );

  const enumResult = await client.query(`
    SELECT t.typname, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS values
    FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
    GROUP BY t.typname
  `);
  const actualEnums = new Map(
    enumResult.rows.map((row) => [row.typname, row.values]),
  );
  const badEnums = [...expected.enums].filter(
    ([name, values]) =>
      JSON.stringify(actualEnums.get(name)) !== JSON.stringify(values),
  );

  const uniqueResult = await client.query(`
    SELECT table_name, bool_or(is_unique) AS is_unique
    FROM (
      SELECT tbl.relname AS table_name,
             idx.indisunique AS is_unique,
             array_agg(att.attname ORDER BY ord.ordinality) AS columns
      FROM pg_catalog.pg_index idx
      JOIN pg_catalog.pg_class tbl ON tbl.oid = idx.indrelid
      JOIN LATERAL unnest(idx.indkey) WITH ORDINALITY ord(attnum, ordinality) ON true
      JOIN pg_catalog.pg_attribute att ON att.attrelid = tbl.oid AND att.attnum = ord.attnum
      WHERE tbl.relname IN ('ai_personas', 'ai_extractors')
      GROUP BY tbl.relname, idx.indexrelid, idx.indisunique
    ) indexes
    WHERE columns = ARRAY['slug']::name[]
    GROUP BY table_name
  `);
  const uniqueByTable = new Map(
    uniqueResult.rows.map((row) => [row.table_name, row.is_unique]),
  );
  const duplicateResult = await client.query(`
    SELECT 'ai_personas' AS table_name, count(*)::integer AS count
      FROM (SELECT slug FROM ai_personas GROUP BY slug HAVING count(*) > 1 OR slug IS NULL) duplicates
    UNION ALL
    SELECT 'ai_extractors', count(*)::integer
      FROM (SELECT slug FROM ai_extractors GROUP BY slug HAVING count(*) > 1 OR slug IS NULL) duplicates
  `);
  const duplicateTables = duplicateResult.rows.filter(
    (row) => Number(row.count) > 0,
  );

  const problems = [];
  if (missingTables.length)
    problems.push(`missing tables: ${missingTables.join(", ")}`);
  if (missingColumns.length)
    problems.push(`missing columns: ${missingColumns.join(", ")}`);
  if (missingIndexes.length)
    problems.push(`missing indexes: ${missingIndexes.join(", ")}`);
  if (badEnums.length)
    problems.push(
      `enum mismatch: ${badEnums.map(([name]) => name).join(", ")}`,
    );
  for (const table of ["ai_personas", "ai_extractors"]) {
    if (uniqueByTable.get(table) !== true)
      problems.push(`${table}.slug is not uniquely constrained`);
  }
  if (duplicateTables.length)
    problems.push(
      `duplicate/null slugs: ${duplicateTables.map((row) => row.table_name).join(", ")}`,
    );
  if (problems.length)
    throw new Error(`[migration-baseline] BLOCKED: ${problems.join(" | ")}`);
}

export async function baselineMigrationLedger({
  connectionString = process.env.DATABASE_URL,
} = {}) {
  const target = (process.env.MIGRATION_TARGET_ENV ?? "").toLowerCase();
  if (!connectionString)
    throw new Error("[migration-baseline] BLOCKED: DATABASE_URL is required");
  if (
    !["local", "development", "test", "staging", "production"].includes(target)
  ) {
    throw new Error(
      "[migration-baseline] BLOCKED: MIGRATION_TARGET_ENV must be explicit",
    );
  }
  if (
    process.env.ALLOW_MIGRATION_BASELINE !== "true" ||
    process.env.MIGRATION_SCHEMA_AUDIT_CONFIRMED !== "true"
  ) {
    throw new Error(
      "[migration-baseline] BLOCKED: ALLOW_MIGRATION_BASELINE=true and MIGRATION_SCHEMA_AUDIT_CONFIRMED=true are required",
    );
  }
  validateMigrationLedger();
  const expectedMigrations = readExpectedMigrations();
  const throughTag = (process.env.MIGRATION_BASELINE_THROUGH_TAG ?? "").trim();
  let migrations = expectedMigrations;
  if (throughTag) {
    const throughIndex = expectedMigrations.findIndex(
      (migration) => migration.tag === throughTag,
    );
    if (throughIndex < 0) {
      throw new Error(
        `[migration-baseline] BLOCKED: unknown MIGRATION_BASELINE_THROUGH_TAG "${throughTag}"`,
      );
    }
    migrations = expectedMigrations.slice(0, throughIndex + 1);
  }
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
    application_name: "fasos-migration-baseline",
  });
  await client.connect();
  try {
    const databaseResult = await client.query(
      "SELECT current_database() AS name",
    );
    const databaseName = databaseResult.rows[0]?.name;
    if (
      !databaseName ||
      process.env.MIGRATION_BASELINE_CONFIRMED_DB !== databaseName
    ) {
      throw new Error(
        "[migration-baseline] BLOCKED: MIGRATION_BASELINE_CONFIRMED_DB must match current_database() exactly",
      );
    }
    const ledgerResult = await client.query(
      `SELECT to_regclass('drizzle.__drizzle_migrations') AS ledger`,
    );
    if (ledgerResult.rows[0]?.ledger) {
      throw new Error(
        "[migration-baseline] BLOCKED: migration ledger already exists; baseline is a one-time operation",
      );
    }
    await client.query("BEGIN READ ONLY");
    await assertSchemaReady(client, migrations);
    await client.query("ROLLBACK");

    await client.query("BEGIN");
    await client.query("CREATE SCHEMA drizzle");
    await client.query(`
      CREATE TABLE drizzle.__drizzle_migrations (
        id serial PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);
    for (const migration of migrations) {
      await client.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2::bigint)`,
        [migration.hash, migration.createdAt],
      );
    }
    await client.query("COMMIT");
    return {
      databaseName,
      entries: migrations.length,
      throughTag: migrations.at(-1)?.tag ?? null,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await baselineMigrationLedger();
    console.log(
      `[migration-baseline] OK: ${result.entries} entries through ${result.throughTag} recorded for ${result.databaseName}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
