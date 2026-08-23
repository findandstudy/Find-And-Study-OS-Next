import { pool } from "@workspace/db";
import type { Store, Options, ClientRateLimitInfo } from "express-rate-limit";

/**
 * Legacy compatibility helper. API boot must not call this; the reviewed
 * migration ledger owns creation of pg_rate_limits.
 */
export async function ensureRateLimitsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pg_rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      reset_at TIMESTAMPTZ NOT NULL
    )
  `);
}

/**
 * Atomic check-and-increment for a named rate-limit bucket.
 * Returns true if the request is allowed, false if the limit is exceeded.
 * Uses an upsert so all PM2 workers share the same state.
 */
export async function checkAndIncrementRateLimit(
  key: string,
  max: number,
  windowMs: number,
): Promise<boolean> {
  const now = Date.now();
  const resetAt = new Date(now + windowMs);

  const result = await pool.query<{ count: number; reset_at: Date }>(
    `INSERT INTO pg_rate_limits (key, count, reset_at)
       VALUES ($1, 1, $2)
     ON CONFLICT (key) DO UPDATE
       SET count    = CASE
                        WHEN pg_rate_limits.reset_at <= NOW() THEN 1
                        ELSE pg_rate_limits.count + 1
                      END,
           reset_at = CASE
                        WHEN pg_rate_limits.reset_at <= NOW() THEN $2
                        ELSE pg_rate_limits.reset_at
                      END
     RETURNING count, reset_at`,
    [key, resetAt],
  );

  const row = result.rows[0];
  return row ? row.count <= max : true;
}

/**
 * express-rate-limit Store backed by PostgreSQL.
 * Compatible with express-rate-limit v7 Store interface.
 */
export class PgRateLimitStore implements Store {
  private windowMs: number;
  localKeys = true;
  prefix: string;

  constructor(windowMs: number, prefix: string = "") {
    this.windowMs = windowMs;
    this.prefix = prefix;
  }

  init(_options: Options): void {}

  private ns(key: string): string {
    return this.prefix ? `${this.prefix}:${key}` : key;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const nsKey = this.ns(key);
    const resetAt = new Date(Date.now() + this.windowMs);

    const result = await pool.query<{ count: number; reset_at: Date }>(
      `INSERT INTO pg_rate_limits (key, count, reset_at)
         VALUES ($1, 1, $2)
       ON CONFLICT (key) DO UPDATE
         SET count    = CASE
                          WHEN pg_rate_limits.reset_at <= NOW() THEN 1
                          ELSE pg_rate_limits.count + 1
                        END,
             reset_at = CASE
                          WHEN pg_rate_limits.reset_at <= NOW() THEN $2
                          ELSE pg_rate_limits.reset_at
                        END
       RETURNING count, reset_at`,
      [nsKey, resetAt],
    );

    const row = result.rows[0];
    return {
      totalHits: row?.count ?? 1,
      resetTime: row?.reset_at ?? resetAt,
    };
  }

  async decrement(key: string): Promise<void> {
    await pool.query(
      `UPDATE pg_rate_limits SET count = GREATEST(count - 1, 0) WHERE key = $1`,
      [this.ns(key)],
    );
  }

  async resetKey(key: string): Promise<void> {
    await pool.query(`DELETE FROM pg_rate_limits WHERE key = $1`, [this.ns(key)]);
  }

  async resetAll(): Promise<void> {
    await pool.query(`DELETE FROM pg_rate_limits`);
  }
}
