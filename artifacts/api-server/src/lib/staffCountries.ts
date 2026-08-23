import { db, staffCountriesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// Sistem geneli yardımcı: personelin "ilgilendiği ülkeler" listesini okur.
// Faz 2 (assignStuckConversation) ülke eşleştirme önceliği için bu modülü
// kullanacak — burada tanımlı, henüz otomatik atama akışında çağrılmıyor.

export async function getStaffCountries(userId: number): Promise<string[]> {
  const rows = await db.select({ country: staffCountriesTable.country })
    .from(staffCountriesTable)
    .where(eq(staffCountriesTable.userId, userId));
  return rows.map(r => r.country);
}

export async function getStaffCountriesForUsers(userIds: number[]): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  if (userIds.length === 0) return map;
  const rows = await db.select({ userId: staffCountriesTable.userId, country: staffCountriesTable.country })
    .from(staffCountriesTable)
    .where(inArray(staffCountriesTable.userId, userIds));
  for (const row of rows) {
    const list = map.get(row.userId) || [];
    list.push(row.country);
    map.set(row.userId, list);
  }
  return map;
}
