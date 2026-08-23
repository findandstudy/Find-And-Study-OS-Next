/**
 * @workspace/pagination — shared pagination/listing helpers.
 *
 * Replaces 60+ copy-pasted variants of:
 *   const pageNum = Math.max(1, parseInt(page, 10));
 *   const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10)));
 *
 * Source-of-truth max-limit policy:
 *  - "small"  =>  100  (lookup/dropdown style endpoints)
 *  - "default"=>  200  (typical CRUD listings)
 *  - "large"  =>  500  (export-friendly listings, eg. /students, /leads)
 */

export type PageSize = "small" | "default" | "large";

export const MAX_LIMIT_BY_SIZE: Record<PageSize, number> = {
  small: 100,
  default: 200,
  large: 500,
};

export interface PaginationParams {
  /** 1-based page number (always >= 1). */
  page: number;
  /** Effective page size (capped to maxLimit). */
  limit: number;
  /** SQL OFFSET, equal to (page - 1) * limit. */
  offset: number;
}

export interface PaginationOptions {
  /** Default page size when client omits `limit`. Default 20. */
  defaultLimit?: number;
  /**
   * Hard cap on page size. Either a numeric override or one of the named
   * sizes ("small" | "default" | "large"). Defaults to "default" (200).
   */
  maxLimit?: number | PageSize;
}

interface ReqLike {
  query?: Record<string, unknown>;
}

function toInt(v: unknown, fallback: number): number {
  if (v == null) return fallback;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

function resolveMaxLimit(maxLimit: PaginationOptions["maxLimit"]): number {
  if (typeof maxLimit === "number") return maxLimit;
  return MAX_LIMIT_BY_SIZE[maxLimit ?? "default"];
}

/**
 * Parse `page` and `limit` from `req.query`, applying defaults and clamps.
 * Always returns sane values — never throws.
 */
export function parsePaginationParams(
  req: ReqLike,
  options: PaginationOptions = {},
): PaginationParams {
  const defaultLimit = options.defaultLimit ?? 20;
  const maxLimit = resolveMaxLimit(options.maxLimit);
  const page = Math.max(1, toInt(req.query?.page, 1));
  const limitRaw = toInt(req.query?.limit, defaultLimit);
  const limit = Math.min(maxLimit, Math.max(1, limitRaw));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

/** Build a standard `meta` block for paginated list responses. */
export function buildPageMeta(total: number, params: PaginationParams) {
  return {
    total,
    page: params.page,
    limit: params.limit,
    totalPages: params.limit > 0 ? Math.ceil(total / params.limit) : 0,
  };
}
