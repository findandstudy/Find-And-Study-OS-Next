const COURSE_FINDER_FILTER_KEYS = [
  "country",
  "city",
  "universityType",
  "universityId",
  "level",
  "language",
  "field",
  "feeMin",
  "feeMax",
  "search",
] as const;

export function courseFinderFilterCacheKey(
  params: Record<string, string | undefined>,
): string {
  return COURSE_FINDER_FILTER_KEYS.map((key) => [
    key,
    String(params[key] ?? "").trim().slice(0, 300),
  ])
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
}
