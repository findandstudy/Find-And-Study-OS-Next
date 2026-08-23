import { aiBotsTable, db } from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";

/** Resolve an explicit bot, or the canonical default bot when none is supplied. */
export async function resolveAiBotId(
  aiBotId?: number | null,
  options: { activeOnly?: boolean } = {},
): Promise<number | null> {
  const activeOnly = options.activeOnly === true;
  if (aiBotId != null) {
    const [row] = await db
      .select({ id: aiBotsTable.id })
      .from(aiBotsTable)
      .where(and(
        eq(aiBotsTable.id, aiBotId),
        activeOnly ? eq(aiBotsTable.isActive, true) : undefined,
      ))
      .limit(1);
    return row?.id ?? null;
  }

  const [row] = await db
    .select({ id: aiBotsTable.id })
    .from(aiBotsTable)
    .where(and(
      eq(aiBotsTable.isDefault, true),
      activeOnly ? eq(aiBotsTable.isActive, true) : undefined,
    ))
    .orderBy(asc(aiBotsTable.id))
    .limit(1);
  return row?.id ?? null;
}

export async function requireAiBotId(
  aiBotId?: number | null,
  options: { activeOnly?: boolean } = {},
): Promise<number> {
  const resolved = await resolveAiBotId(aiBotId, options);
  if (resolved == null) throw new Error("AI bot not found");
  return resolved;
}

export async function listActiveAiBotIds(): Promise<number[]> {
  const rows = await db
    .select({ id: aiBotsTable.id })
    .from(aiBotsTable)
    .where(eq(aiBotsTable.isActive, true))
    .orderBy(asc(aiBotsTable.id));
  return rows.map((row) => row.id);
}
