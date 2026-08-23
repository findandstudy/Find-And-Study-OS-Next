/**
 * portalCredentials.ts (api-server)
 *
 * DB helper for writing and reading encrypted portal credentials.
 *
 * Rules:
 *  - Credentials are stored ENCRYPTED (AES-256-GCM via lib/encryption.ts).
 *  - Plain-text values are NEVER written to DB or returned via API.
 *  - setPortalCredentials — used by management routes to upsert credentials.
 *  - getPortalCredentials — INTERNAL USE ONLY (worker/process pipeline).
 *    Never call from a route response.
 *  - Unique index is (organizationId, portalKey). PostgreSQL does NOT trigger
 *    unique conflicts when organizationId is NULL, so we do a manual
 *    check-then-insert-or-update instead of onConflictDoUpdate.
 */

import { and, eq, isNull } from "drizzle-orm";
import { db, portalCredentialsTable } from "@workspace/db";
import { encryptString, decryptString } from "./encryption.js";

// ---------------------------------------------------------------------------
// setPortalCredentials — upsert encrypted credentials
// ---------------------------------------------------------------------------

export async function setPortalCredentials(
  organizationId: number | null,
  portalKey: string,
  {
    username,
    password,
    extra,
  }: {
    username: string;
    password: string;
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  const usernameEnc = encryptString(username);
  const passwordEnc = encryptString(password);
  const extraEnc    = extra ? encryptString(JSON.stringify(extra)) : null;

  // Unique index is (organizationId, portalKey) but organizationId is nullable.
  // PostgreSQL does not raise a unique-conflict when orgId is NULL (NULLs are
  // not equal in unique indexes), so we use a manual check-then-update/insert.
  const orgCond = organizationId !== null
    ? eq(portalCredentialsTable.organizationId, organizationId)
    : isNull(portalCredentialsTable.organizationId);

  const [existing] = await db
    .select({ id: portalCredentialsTable.id })
    .from(portalCredentialsTable)
    .where(
      and(orgCond, eq(portalCredentialsTable.portalKey, portalKey), isNull(portalCredentialsTable.deletedAt)),
    )
    .limit(1);

  if (existing) {
    await db
      .update(portalCredentialsTable)
      .set({
        usernameEnc,
        passwordEnc,
        extraEnc:  extraEnc ?? null,
        isActive:  true,
        deletedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(portalCredentialsTable.id, existing.id));
  } else {
    await db.insert(portalCredentialsTable).values({
      organizationId,
      portalKey,
      usernameEnc,
      passwordEnc,
      ...(extraEnc !== null ? { extraEnc } : {}),
      isActive: true,
    });
  }
}

// ---------------------------------------------------------------------------
// getPortalCredentials — INTERNAL USE ONLY (worker/process pipeline)
// Never expose decrypted credentials in route responses.
// ---------------------------------------------------------------------------

export async function getPortalCredentials(
  organizationId: number | null,
  portalKey: string,
): Promise<{ username: string; password: string; extra?: Record<string, unknown> } | null> {
  const orgCond = organizationId !== null
    ? eq(portalCredentialsTable.organizationId, organizationId)
    : isNull(portalCredentialsTable.organizationId);

  const [row] = await db
    .select()
    .from(portalCredentialsTable)
    .where(
      and(
        orgCond,
        eq(portalCredentialsTable.portalKey, portalKey),
        isNull(portalCredentialsTable.deletedAt),
        eq(portalCredentialsTable.isActive, true),
      ),
    )
    .limit(1);

  if (!row) return null;

  const username = decryptString(row.usernameEnc);
  const password = decryptString(row.passwordEnc);
  let extra: Record<string, unknown> | undefined;
  if (row.extraEnc) {
    try { extra = JSON.parse(decryptString(row.extraEnc)); } catch {}
  }
  return { username, password, extra };
}
