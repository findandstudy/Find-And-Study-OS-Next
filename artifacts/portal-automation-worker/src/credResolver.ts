/**
 * credResolver.ts — portal-automation-worker
 *
 * DB-first credential resolver (mirrors api-server/lib/portalCreds.ts logic).
 * Uses inline AES-256-GCM decrypt (same algorithm as lib/encryption.ts in
 * api-server) to avoid cross-package coupling.
 *
 * Resolution order:
 *  1. portal_credentials DB row (decrypted)
 *  2. env vars: ${portalKey}_EMAIL/_USER + _PASSWORD
 *  3. env vars: ${adapterKey}_EMAIL/_USER + _PASSWORD  (legacy fallback)
 */

import crypto from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, pool, portalCredentialsTable } from "@workspace/db";

// ---------------------------------------------------------------------------
// Inline decrypt — same AES-256-GCM scheme as api-server/lib/encryption.ts
// ---------------------------------------------------------------------------
const ALGO    = "aes-256-gcm";
const IV_LEN  = 12;
const TAG_LEN = 16;
const PREFIX  = "enc::v1::";

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY ?? process.env.SESSION_SECRET ?? "";
  if (!raw) throw new Error("[credResolver] ENCRYPTION_KEY is required for decrypting portal credentials");
  return crypto.createHash("sha256").update(raw).digest();
}

function decrypt(value: string): string {
  if (!value.startsWith(PREFIX)) return value;
  const key = getKey();
  const buf  = Buffer.from(value.slice(PREFIX.length), "base64");
  const iv   = buf.subarray(0, IV_LEN);
  const tag  = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct   = buf.subarray(IV_LEN + TAG_LEN);
  const d    = crypto.createDecipheriv(ALGO, key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface ResolvedCreds {
  user: string;
  password: string;
  extra?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Internal: env-based lookup
// ---------------------------------------------------------------------------
function envCreds(key: string): ResolvedCreds | null {
  const K    = key.toUpperCase().replace(/-/g, "_");
  const user = process.env[`${K}_EMAIL`] ?? process.env[`${K}_USER`] ?? "";
  const pass = process.env[`${K}_PASSWORD`] ?? "";
  return user && pass ? { user, password: pass } : null;
}

// ---------------------------------------------------------------------------
// resolvePortalCreds — DB-first, env fallback, throws when nothing found
// ---------------------------------------------------------------------------
export async function resolvePortalCreds(
  portalKey: string,
  adapterKey?: string,
): Promise<ResolvedCreds> {
  let [row] = await db
    .select()
    .from(portalCredentialsTable)
    .where(
      and(
        eq(portalCredentialsTable.portalKey, portalKey),
        isNull(portalCredentialsTable.deletedAt),
        eq(portalCredentialsTable.isActive, true),
      ),
    )
    .limit(1);

  if (!row && adapterKey && adapterKey !== portalKey) {
    [row] = await db.select().from(portalCredentialsTable).where(and(eq(portalCredentialsTable.portalKey, adapterKey), isNull(portalCredentialsTable.deletedAt), eq(portalCredentialsTable.isActive, true))).limit(1);
  }
  if (!row) {
    try {
      const ru = await pool.query(
        "select adapter_key from portal_universities where university_key = $1 and deleted_at is null limit 1",
        [portalKey],
      );
      const ak = ru.rows && ru.rows[0] && ru.rows[0].adapter_key;
      if (ak && ak !== portalKey && ak !== adapterKey) {
        [row] = await db.select().from(portalCredentialsTable).where(and(eq(portalCredentialsTable.portalKey, ak), isNull(portalCredentialsTable.deletedAt), eq(portalCredentialsTable.isActive, true))).limit(1);
      }
    } catch (e) { /* ignore */ }
  }
  if (row) {
    const user     = decrypt(row.usernameEnc);
    const password = decrypt(row.passwordEnc);
    let extra: Record<string, unknown> | undefined;
    if (row.extraEnc) {
      try { extra = JSON.parse(decrypt(row.extraEnc)); } catch {}
    }
    return { user, password, extra };
  }

  const c = envCreds(portalKey) ?? (adapterKey ? envCreds(adapterKey) : null);
  if (c) return c;

  throw new Error(
    `[credResolver] No credentials for portal key "${portalKey}". ` +
    `Configure via the admin panel or set ${portalKey.toUpperCase()}_EMAIL + _PASSWORD in .env`,
  );
}
