export type PortalIdentityRow = {
  universityKey: string;
  isActive: boolean;
};

export type PortalIdentityResolution<T extends PortalIdentityRow> =
  | { ok: true; portalUniversity: T; matchedBy: "university_key" | "adapter_alias" }
  | { ok: false; reason: "inactive" | "unknown" | "ambiguous"; matches: string[] };

/**
 * Applies the fail-closed portal identity policy without performing I/O.
 *
 * An exact university key is authoritative, including when that exact row is
 * inactive. Adapter aliases are accepted only when they resolve to one active
 * portal row; a shared alias is never guessed.
 */
export function selectCanonicalPortalUniversity<T extends PortalIdentityRow>(
  exact: T | undefined,
  adapterMatches: T[],
): PortalIdentityResolution<T> {
  if (exact) {
    return exact.isActive
      ? { ok: true, portalUniversity: exact, matchedBy: "university_key" }
      : { ok: false, reason: "inactive", matches: [exact.universityKey] };
  }

  if (adapterMatches.length === 1) {
    return {
      ok: true,
      portalUniversity: adapterMatches[0],
      matchedBy: "adapter_alias",
    };
  }

  return {
    ok: false,
    reason: adapterMatches.length === 0 ? "unknown" : "ambiguous",
    matches: adapterMatches.map((row) => row.universityKey),
  };
}
