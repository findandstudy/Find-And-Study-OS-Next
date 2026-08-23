import { db, leadsTable, studentsTable, agentsTable, usersTable } from "@workspace/db";
import { isNull, sql } from "drizzle-orm";
import type { PgTable, PgColumn } from "drizzle-orm/pg-core";
import { toE164 } from "../src/lib/inbox/phone";

interface PhoneTable extends PgTable {
  id: PgColumn;
  phone: PgColumn;
  phoneE164: PgColumn;
}

interface PhoneRow {
  id: number;
  phone: string | null;
  phoneE164: string | null;
}

async function backfillTable(
  name: string,
  table: PhoneTable,
): Promise<{ scanned: number; updated: number; failed: number }> {
  const rows = (await db.select().from(table).where(isNull(table.phoneE164))) as unknown as PhoneRow[];
  let updated = 0;
  let failed = 0;
  for (const row of rows) {
    if (!row.phone) continue;
    const normalized = toE164(row.phone);
    if (!normalized) {
      failed++;
      continue;
    }
    await db.update(table).set({ phoneE164: normalized }).where(sql`id = ${row.id}`);
    updated++;
  }
  console.log(`[${name}] scanned=${rows.length} updated=${updated} failed=${failed}`);
  return { scanned: rows.length, updated, failed };
}

async function main(): Promise<void> {
  console.log("Backfilling phoneE164...");
  await backfillTable("leads", leadsTable as unknown as PhoneTable);
  await backfillTable("students", studentsTable as unknown as PhoneTable);
  await backfillTable("agents", agentsTable as unknown as PhoneTable);
  await backfillTable("users", usersTable as unknown as PhoneTable);

  console.log("Backfilling conversations.channel='internal' where NULL...");
  const result = await db.execute(sql`UPDATE conversations SET channel = 'internal' WHERE channel IS NULL`);
  const rowCount = (result as { rowCount?: number }).rowCount ?? 0;
  console.log(`conversations channel backfill done. rowCount=${rowCount}`);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
