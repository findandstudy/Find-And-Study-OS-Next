const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 24;
const MAX_PAGE = 1_000_000;
const MAX_LIMIT = 500;

function strictPositiveInt(
  raw: unknown,
  fallback: number,
  max: number,
): number {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) return fallback;
  return Math.min(value, max);
}

/**
 * Normalise public/internal Course Finder pagination before values reach SQL.
 * NaN offsets can make the database driver reject or stall a request, which is
 * especially costly on this high-traffic endpoint.
 */
export function parseCourseFinderPagination(
  page: unknown,
  limit: unknown,
): { page: number; limit: number; offset: number } {
  const safePage = strictPositiveInt(page, DEFAULT_PAGE, MAX_PAGE);
  const safeLimit = strictPositiveInt(limit, DEFAULT_LIMIT, MAX_LIMIT);
  return {
    page: safePage,
    limit: safeLimit,
    offset: (safePage - 1) * safeLimit,
  };
}
