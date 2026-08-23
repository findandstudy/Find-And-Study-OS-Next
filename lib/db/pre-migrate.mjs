import pg from "pg";

const target = (process.env.MIGRATION_TARGET_ENV ?? "").toLowerCase();
if (!["local", "development", "test"].includes(target)) {
  console.error("[pre-migrate] BLOCKED: MIGRATION_TARGET_ENV must explicitly be local, development or test");
  process.exit(1);
}
if (process.env.ALLOW_PRE_MIGRATION_CLEANUP !== "true") {
  console.error("[pre-migrate] BLOCKED: ALLOW_PRE_MIGRATION_CLEANUP=true is required");
  process.exit(1);
}

async function run(attempt = 1) {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10000,
    statement_timeout: 15000,
  });
  try {
    await client.connect();
    const res = await client.query(`
      DELETE FROM pipeline_stages
      WHERE id NOT IN (
        SELECT MIN(id)
        FROM pipeline_stages
        GROUP BY entity_type, key
      )
    `);
    console.log(`Pre-migration: removed ${res.rowCount} duplicate pipeline_stages rows`);
    await client.end();
  } catch (err) {
    try { await client.end(); } catch {}
    if (attempt < 3 && err.code && (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND' || err.code === '57P03')) {
      console.log(`Pre-migration: connection attempt ${attempt} failed, retrying in 3s...`);
      await new Promise(r => setTimeout(r, 3000));
      return run(attempt + 1);
    }
    console.log("Pre-migration: skipped (table may not exist yet)");
  }
}

await run();
