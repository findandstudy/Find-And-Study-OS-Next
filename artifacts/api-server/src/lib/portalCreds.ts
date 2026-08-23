/**
 * portalCreds.ts (api-server)
 *
 * DB-first credential resolver for portal universities.
 * Falls back to process.env when no DB row exists (backward compat).
 *
 * Rules:
 *  - Credentials are stored ENCRYPTED (AES-256-GCM via lib/encryption.ts).
 *  - Plain-text values are NEVER written to the DB or returned via API.
 *  - DB lookup key = portalKey (= portal_universities.universityKey).
 *  - Env fallback tries: ${portalKey}_* then ${adapterKey}_* (legacy).
 */

import { and, eq, isNull } from "drizzle-orm";
import { db, portalCredentialsTable } from "@workspace/db";
import { decryptString } from "./encryption.js";

export interface ResolvedPortalCreds {
  user: string;
  password: string;
  extra?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Internal: env-based lookup
// ---------------------------------------------------------------------------
function envCreds(key: string): ResolvedPortalCreds | null {
  const K = key.toUpperCase().replace(/-/g, "_");
  const user = process.env[`${K}_EMAIL`] ?? process.env[`${K}_USER`] ?? "";
  const pass  = process.env[`${K}_PASSWORD`] ?? "";
  return user && pass ? { user, password: pass } : null;
}

// ---------------------------------------------------------------------------
// resolvePortalCreds — throws when no credentials found anywhere
// ---------------------------------------------------------------------------
export async function resolvePortalCreds(
  portalKey: string,
  adapterKey?: string,
): Promise<ResolvedPortalCreds> {
  // DB lookup: try adapterKey first (canonical), then portalKey (universityKey) as fallback.
  const dbKeys = adapterKey && adapterKey !== portalKey
    ? [adapterKey, portalKey]
    : [portalKey];

  for (const key of dbKeys) {
    const [row] = await db
      .select()
      .from(portalCredentialsTable)
      .where(
        and(
          eq(portalCredentialsTable.portalKey, key),
          isNull(portalCredentialsTable.deletedAt),
          eq(portalCredentialsTable.isActive, true),
        ),
      )
      .limit(1);

    if (row) {
      const user     = decryptString(row.usernameEnc);
      const password = decryptString(row.passwordEnc);
      let extra: Record<string, unknown> | undefined;
      if (row.extraEnc) {
        try { extra = JSON.parse(decryptString(row.extraEnc)); } catch {}
      }
      return { user, password, extra };
    }
  }

  const c = envCreds(adapterKey ?? portalKey) ?? envCreds(portalKey);
  if (c) return c;

  throw new Error(
    `[portalCreds] No credentials configured for portal key "${portalKey}". ` +
    `Add them via the panel or set ${(adapterKey ?? portalKey).toUpperCase()}_EMAIL + _PASSWORD in .env`,
  );
}

// ---------------------------------------------------------------------------
// checkHasPortalCredentials — safe boolean check (never throws)
// ---------------------------------------------------------------------------
export async function checkHasPortalCredentials(
  portalKey: string,
  adapterKey?: string,
): Promise<boolean> {
  // DB: try adapterKey first (canonical), then portalKey (universityKey) as fallback.
  const dbKeys = adapterKey && adapterKey !== portalKey
    ? [adapterKey, portalKey]
    : [portalKey];

  try {
    for (const key of dbKeys) {
      const [row] = await db
        .select({ id: portalCredentialsTable.id })
        .from(portalCredentialsTable)
        .where(
          and(
            eq(portalCredentialsTable.portalKey, key),
            isNull(portalCredentialsTable.deletedAt),
            eq(portalCredentialsTable.isActive, true),
          ),
        )
        .limit(1);
      if (row) return true;
    }
  } catch { /* DB unreachable — fall through to env */ }

  if (adapterKey && envCreds(adapterKey)) return true;
  if (envCreds(portalKey)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// batchHasPortalCredentials — efficient for list endpoints (no N+1)
// Returns a Set of portalKeys that have DB credentials.
// Caller must separately check env for keys NOT in this set.
// ---------------------------------------------------------------------------
export async function batchPortalCredentialKeys(): Promise<Set<string>> {
  try {
    const rows = await db
      .select({ portalKey: portalCredentialsTable.portalKey })
      .from(portalCredentialsTable)
      .where(
        and(
          isNull(portalCredentialsTable.deletedAt),
          eq(portalCredentialsTable.isActive, true),
        ),
      );
    return new Set(rows.map((r) => r.portalKey));
  } catch {
    return new Set();
  }
}
