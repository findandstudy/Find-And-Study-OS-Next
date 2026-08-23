// Backfill phone_e164 for students, leads, users and agents from the legacy
// free-form `phone` column. Dry-run by default (prints what WOULD change);
// pass --apply to write. Rows whose phone cannot be parsed into a valid
// number are reported, never guessed.
//
//   pnpm --filter @workspace/api-server exec tsx scripts/backfill-phone-e164.ts
//   pnpm --filter @workspace/api-server exec tsx scripts/backfill-phone-e164.ts --apply
import { db, leadsTable, studentsTable, agentsTable, usersTable } from "@workspace/db";
import { isNull, isNotNull, and, ne, sql } from "drizzle-orm";
import type { PgTable, PgColumn } from "drizzle-orm/pg-core";
import { toValidE164 } from "@workspace/phone";

const APPLY = process.argv.includes("--apply");

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

async function backfillTable(name: string, table: PhoneTable) {
  const rows = (await db
    .select()
    .from(table)
    .where(and(isNull(table.phoneE164), isNotNull(table.phone), ne(table.phone, "")))) as unknown as PhoneRow[];

  let updated = 0;
  let unparseable = 0;
  for (const row of rows) {
    if (!row.phone) continue;
    const normalized = toValidE164(row.phone, "TR");
    if (!normalized) {
      unparseable++;
      if (!APPLY) console.log(`  [${name}] id=${row.id} UNPARSEABLE phone=${JSON.stringify(row.phone)}`);
      continue;
    }
    if (APPLY) {
      await db.update(table).set({ phoneE164: normalized }).where(sql`id = ${row.id}`);
    } else {
      console.log(`  [${name}] id=${row.id} ${JSON.stringify(row.phone)} -> ${normalized}`);
    }
    updated++;
  }
  console.log(
    `[${name}] scanned=${rows.length} ${APPLY ? "updated" : "would-update"}=${updated} unparseable=${unparseable}`,
  );
}

async function main(): Promise<void> {
  console.log(`Backfilling phone_e164 (${APPLY ? "APPLY" : "DRY RUN — pass --apply to write"})...`);
  await backfillTable("students", studentsTable as unknown as PhoneTable);
  await backfillTable("leads", leadsTable as unknown as PhoneTable);
  await backfillTable("users", usersTable as unknown as PhoneTable);
  await backfillTable("agents", agentsTable as unknown as PhoneTable);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
