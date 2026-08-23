import { and, eq, isNull } from "drizzle-orm";
import { db, portalUniversitiesTable } from "@workspace/db";
import {
  selectCanonicalPortalUniversity,
  type PortalIdentityResolution,
} from "./portalUniversityIdentity.js";

export type ActivePortalUniversity = typeof portalUniversitiesTable.$inferSelect;

export type PortalUniversityResolution = PortalIdentityResolution<ActivePortalUniversity>;

/**
 * Resolves a user/API supplied portal identity to exactly one canonical,
 * active portal_universities row.
 *
 * Exact university_key always wins. Adapter aliases are accepted only when
 * they identify one active portal row; shared adapter names fail closed.
 */
export async function resolveCanonicalPortalUniversity(
  requestedKey: string,
): Promise<PortalUniversityResolution> {
  const [exact] = await db
    .select()
    .from(portalUniversitiesTable)
    .where(and(
      eq(portalUniversitiesTable.universityKey, requestedKey),
      isNull(portalUniversitiesTable.deletedAt),
    ))
    .limit(1);

  if (exact) return selectCanonicalPortalUniversity(exact, []);

  const adapterMatches = await db
    .select()
    .from(portalUniversitiesTable)
    .where(and(
      eq(portalUniversitiesTable.adapterKey, requestedKey),
      eq(portalUniversitiesTable.isActive, true),
      isNull(portalUniversitiesTable.deletedAt),
    ))
    .limit(2);

  return selectCanonicalPortalUniversity(undefined, adapterMatches);
}
