const COURSE_FINDER_LIST_KEYS = [
  "programId",
  "country",
  "city",
  "universityType",
  "universityId",
  "level",
  "language",
  "field",
  "intake",
  "feeMin",
  "feeMax",
  "search",
  "sort",
  "page",
  "limit",
] as const;

/** Stable, bounded key for role-scoped Course Finder list caching. */
export function courseFinderListCacheKey(
  params: Record<string, string | undefined>,
): string {
  return COURSE_FINDER_LIST_KEYS.map((key) => [
    key,
    String(params[key] ?? "").trim().slice(0, 300),
  ])
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
}

/** Keep cached response shapes isolated across every private-field boundary. */
export function courseFinderVisibilityCacheKey(visibility: {
  contacts: boolean;
  internalFees: boolean;
  serviceFee: boolean;
}): string {
  return [
    visibility.contacts,
    visibility.internalFees,
    visibility.serviceFee,
  ].map(value => value ? "1" : "0").join("");
}
