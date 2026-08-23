import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import {
  recordDbAcquire,
  recordDbQuery,
  recordDbRetry,
} from "./requestMetrics";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Pool sizing: the pool is shared by user requests AND ~13 background
// workers. 10 connections exhausted under load, making requests wait the
// full connection timeout and fail ("Connection terminated due to
// connection timeout"). Default raised to 20; connection wait lowered to
// 5s so a saturated pool fails fast instead of hanging requests for 20s.
// On autoscale keep (DB_POOL_MAX × max instances) ≤ the DB's connection
// limit — override per deployment via DB_POOL_MAX when scaling out.
export const pool: pg.Pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parsePositiveInt(process.env.DB_POOL_MAX, 20),
  min: 0,
  idleTimeoutMillis: parsePositiveInt(process.env.DB_IDLE_TIMEOUT_MS, 10_000),
  // 10s: fresh connections to the managed DB can take several seconds to
  // establish (cold start); 5s produced spurious "timeout exceeded when trying
  // to connect" under load even with a mostly-idle pool. Still well below the
  // old 20s default so a truly exhausted pool fails fast-ish.
  connectionTimeoutMillis: parsePositiveInt(process.env.DB_CONNECT_TIMEOUT_MS, 10_000),
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  allowExitOnIdle: false,
  statement_timeout: parsePositiveInt(process.env.DB_STATEMENT_TIMEOUT_MS, 30_000),
  query_timeout: parsePositiveInt(process.env.DB_QUERY_TIMEOUT_MS, 30_000),
});

pool.on("error", (err: Error & { code?: string }) => {
  console.error("[db pool] idle client error", {
    code: err.code,
    message: err.message,
  });
});

pool.on("connect", (client) => {
  client.on("error", (err: Error & { code?: string }) => {
    console.error("[db client] connection error", {
      code: err.code,
      message: err.message,
    });
  });
});

const originalConnect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;

(pool as unknown as { connect: (...args: unknown[]) => unknown }).connect =
  function instrumentedConnect(...args: unknown[]): unknown {
    const startedAt = process.hrtime.bigint();
    const callback = args[0];
    if (typeof callback === "function") {
      return originalConnect((...callbackArgs: unknown[]) => {
        recordDbAcquire(Number(process.hrtime.bigint() - startedAt) / 1_000_000);
        return (callback as (...values: unknown[]) => unknown)(...callbackArgs);
      });
    }
    return (originalConnect() as Promise<unknown>).then((client) => {
      recordDbAcquire(Number(process.hrtime.bigint() - startedAt) / 1_000_000);
      return client;
    });
  };

const RETRYABLE_PG_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENETRESET", "ENETUNREACH",
  "57P01", "57P02", "57P03",
  "08000", "08001", "08003", "08004", "08006", "08007", "08P01",
]);

const RETRYABLE_MESSAGE_FRAGMENTS = [
  "connection terminated",
  "server closed the connection",
  "terminating connection",
  "connection timeout",
  "client has encountered a connection error",
];

type ErrLike = { code?: string; message?: string; cause?: ErrLike } | null | undefined;

function isRetryablePgError(err: ErrLike): boolean {
  if (!err) return false;
  const code = err.code ?? err.cause?.code;
  if (code && RETRYABLE_PG_CODES.has(code)) return true;
  const msg = (err.message ?? "").toLowerCase();
  if (RETRYABLE_MESSAGE_FRAGMENTS.some((f) => msg.includes(f))) return true;
  return err.cause ? isRetryablePgError(err.cause) : false;
}

// Only retry statements that are safe to re-execute. Anything that can mutate
// state (INSERT/UPDATE/DELETE/CALL/etc.) is left to fail so the caller can
// decide — re-running a write whose response was lost in transit could create
// duplicate rows or charge fees twice. Strips leading SQL comments first.
const READ_ONLY_PREFIX_RE =
  /^(select|show|explain|values|table|fetch)\b/i;

function extractSqlText(args: unknown[]): string | null {
  const first = args[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && "text" in first) {
    const t = (first as { text?: unknown }).text;
    if (typeof t === "string") return t;
  }
  return null;
}

export function isReadOnlySql(sql: string | null): boolean {
  if (!sql) return false;
  let s = sql.trimStart();
  // Strip leading line and block comments so "-- comment\nSELECT ..." still matches.
  // Loop because comments can repeat.
  let prev = "";
  while (s !== prev) {
    prev = s;
    if (s.startsWith("--")) {
      const nl = s.indexOf("\n");
      s = nl === -1 ? "" : s.slice(nl + 1).trimStart();
    } else if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      s = end === -1 ? "" : s.slice(end + 2).trimStart();
    }
  }
  return READ_ONLY_PREFIX_RE.test(s);
}

const MAX_QUERY_ATTEMPTS = parsePositiveInt(process.env.DB_QUERY_RETRIES, 3);
const RETRY_BASE_DELAY_MS = parsePositiveInt(process.env.DB_RETRY_BASE_MS, 120);

// Pool pressure observability: warn (rate-limited) whenever a query is issued
// while other callers are already waiting for a connection. Includes a short
// SQL prefix so the log identifies WHICH call is hitting the saturated pool.
const POOL_WAIT_WARN_THRESHOLD = parsePositiveInt(process.env.DB_POOL_WAIT_WARN, 3);
const POOL_WAIT_WARN_INTERVAL_MS = 10_000;
let lastPoolWarnAt = 0;

function sqlSnippet(sql: string | null): string {
  if (!sql) return "<non-text query>";
  return sql.replace(/\s+/g, " ").trim().slice(0, 120);
}

function maybeWarnPoolPressure(sql: string | null): void {
  const waiting = pool.waitingCount;
  if (waiting < POOL_WAIT_WARN_THRESHOLD) return;
  const now = Date.now();
  if (now - lastPoolWarnAt < POOL_WAIT_WARN_INTERVAL_MS) return;
  lastPoolWarnAt = now;
  console.warn("[db pool] pressure: queries waiting for a connection", {
    waitingCount: waiting,
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    max: (pool as unknown as { options?: { max?: number } }).options?.max,
    sql: sqlSnippet(sql),
  });
}

const originalQuery = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;

(pool as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query =
  async function retryingQuery(...args: unknown[]): Promise<unknown> {
    const queryStartedAt = process.hrtime.bigint();
    const sql = extractSqlText(args);
    const retryable = isReadOnlySql(sql);
    maybeWarnPoolPressure(sql);
    let lastErr: unknown;
    try {
      for (let attempt = 1; attempt <= MAX_QUERY_ATTEMPTS; attempt++) {
        try {
          return await originalQuery(...args);
        } catch (err) {
          lastErr = err;
          if (
            attempt === MAX_QUERY_ATTEMPTS ||
            !retryable ||
            !isRetryablePgError(err as ErrLike)
          ) {
            throw err;
          }
          recordDbRetry();
          const delay = RETRY_BASE_DELAY_MS * attempt;
          const e = err as ErrLike;
          console.warn("[db] retrying read query after transient error", {
            attempt,
            maxAttempts: MAX_QUERY_ATTEMPTS,
            code: e?.code ?? e?.cause?.code,
            message: e?.message,
            delayMs: delay,
            sql: sqlSnippet(sql),
            poolWaiting: pool.waitingCount,
            poolTotal: pool.totalCount,
          });
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      throw lastErr;
    } finally {
      recordDbQuery(Number(process.hrtime.bigint() - queryStartedAt) / 1_000_000);
    }
  };

export const db = drizzle(pool, { schema });

export * from "./schema";
export * from "./softDelete";
export * from "./academicLevels";
export * from "./requestMetrics";
export * from "./portal/portalFieldSpec";
export * from "./portal/portalNormalize";
export * from "./portal/canonicalCountries";
