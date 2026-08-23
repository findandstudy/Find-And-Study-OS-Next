/**
 * One-time migration: normalize existing phone values to E.164 format.
 * Reads the raw `phone` column from leads, students, and agents tables,
 * parses each value with libphonenumber-js (default country: TR), and
 * writes the result to the `phone_e164` column. Rows that cannot be
 * parsed are left as NULL and counted in the summary report.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx scripts/migrations/normalize-phones.ts
 */

import { db, leadsTable, studentsTable, agentsTable } from "@workspace/db";
import { isNull, isNotNull, sql } from "drizzle-orm";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

const DEFAULT_COUNTRY: CountryCode = "TR";

function toE164(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  try {
    const parsed = parsePhoneNumberFromString(raw, DEFAULT_COUNTRY);
    if (!parsed || !parsed.isValid()) return null;
    return parsed.number;
  } catch {
    return null;
  }
}

interface TableResult {
  table: string;
  total: number;
  normalized: number;
  failed: number;
  skipped: number;
}

async function normalizeTable<T extends { id: number; phone: string | null }>(
  tableName: string,
  rows: T[],
  updateFn: (id: number, e164: string | null) => Promise<void>,
): Promise<TableResult> {
  let normalized = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!row.phone) {
      skipped++;
      continue;
    }
    const e164 = toE164(row.phone);
    if (e164) {
      await updateFn(row.id, e164);
      normalized++;
    } else {
      await updateFn(row.id, null);
      failed++;
      console.warn(`  [${tableName}] id=${row.id} phone="${row.phone}" -> could not parse`);
    }
  }

  return { table: tableName, total: rows.length, normalized, failed, skipped };
}

async function main() {
  console.log("[normalize-phones] Starting phone E.164 normalization…");
  console.log(`  Default country: ${DEFAULT_COUNTRY}`);
  console.log("");

  const results: TableResult[] = [];

  const leads = await db
    .select({ id: leadsTable.id, phone: leadsTable.phone })
    .from(leadsTable)
    .where(isNull(leadsTable.phoneE164));

  console.log(`[leads] ${leads.length} rows to process (phone_e164 IS NULL)`);
  const leadsResult = await normalizeTable("leads", leads, async (id, e164) => {
    await db.execute(sql`UPDATE leads SET phone_e164 = ${e164} WHERE id = ${id}`);
  });
  results.push(leadsResult);

  const students = await db
    .select({ id: studentsTable.id, phone: studentsTable.phone })
    .from(studentsTable)
    .where(isNull(studentsTable.phoneE164));

  console.log(`[students] ${students.length} rows to process (phone_e164 IS NULL)`);
  const studentsResult = await normalizeTable("students", students, async (id, e164) => {
    await db.execute(sql`UPDATE students SET phone_e164 = ${e164} WHERE id = ${id}`);
  });
  results.push(studentsResult);

  const agents = await db
    .select({ id: agentsTable.id, phone: agentsTable.phone })
    .from(agentsTable)
    .where(isNull(agentsTable.phoneE164));

  console.log(`[agents] ${agents.length} rows to process (phone_e164 IS NULL)`);
  const agentsResult = await normalizeTable("agents", agents, async (id, e164) => {
    await db.execute(sql`UPDATE agents SET phone_e164 = ${e164} WHERE id = ${id}`);
  });
  results.push(agentsResult);

  console.log("\n[normalize-phones] Summary:");
  console.log("─".repeat(60));
  for (const r of results) {
    console.log(
      `  ${r.table.padEnd(12)} total=${r.total}  normalized=${r.normalized}  failed=${r.failed}  skipped=${r.skipped}`,
    );
  }
  console.log("─".repeat(60));
  const totalNormalized = results.reduce((s, r) => s + r.normalized, 0);
  const totalFailed = results.reduce((s, r) => s + r.failed, 0);
  console.log(
    `  TOTAL         normalized=${totalNormalized}  failed=${totalFailed}`,
  );

  if (totalFailed > 0) {
    console.warn(
      `\n  ⚠  ${totalFailed} phone value(s) could not be parsed and were set to NULL.`,
    );
    console.warn("     These rows will not be matched by phone in identity resolution.");
  }

  console.log("\n[normalize-phones] Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[normalize-phones] Fatal error:", err);
  process.exit(1);
});
