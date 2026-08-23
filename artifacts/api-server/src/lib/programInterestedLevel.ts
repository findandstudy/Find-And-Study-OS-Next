import { db, programsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

function cleanLevel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 100) : null;
}

/**
 * A selected catalog program is authoritative. The fallback is used only by
 * intake flows that collect a desired level without a selected program.
 */
export async function resolveProgramInterestedLevel(
  programId: unknown,
  fallback: unknown,
): Promise<string | null> {
  const parsedProgramId = Number.parseInt(String(programId ?? ""), 10);
  if (Number.isFinite(parsedProgramId) && parsedProgramId > 0) {
    const [program] = await db
      .select({ degree: programsTable.degree })
      .from(programsTable)
      .where(eq(programsTable.id, parsedProgramId))
      .limit(1);
    const catalogLevel = cleanLevel(program?.degree);
    if (catalogLevel) return catalogLevel;
  }
  return cleanLevel(fallback);
}
