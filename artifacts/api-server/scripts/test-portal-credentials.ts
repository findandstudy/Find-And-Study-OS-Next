/**
 * test-portal-credentials.ts
 *
 * Integration test for the portal credentials management system.
 *
 * Tests:
 *  T1: Encrypt / decrypt round-trip (AES-256-GCM, random IV)
 *  T2: Upsert — row stored encrypted, no plaintext in DB
 *  T3: checkHasPortalCredentials → true after upsert
 *  T4: resolvePortalCreds → decrypts and returns correct plaintext
 *  T5: Soft-delete → hasCredentials=false, row still in table
 *  T6: Env fallback — resolver reads from process.env when no DB row
 *  T7: resolvePortalCreds throws when nothing configured
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx scripts/test-portal-credentials.ts
 */

import assert from "node:assert/strict";
import { and, eq, isNull } from "drizzle-orm";
import { db, portalCredentialsTable } from "@workspace/db";
import { encryptString, decryptString } from "../src/lib/encryption.js";
import { resolvePortalCreds, checkHasPortalCredentials } from "../src/lib/portalCreds.js";

const TEST_PORTAL_KEY = "__test_creds_e2e__";

// ---------------------------------------------------------------------------
// Setup / teardown helpers
// ---------------------------------------------------------------------------

async function ensureTestUniversity(): Promise<void> {
  await db.execute(`
    INSERT INTO portal_universities
      (university_key, university_name, adapter_key, is_active, created_at, updated_at)
    VALUES
      ('${TEST_PORTAL_KEY}', 'Test Portal Uni E2E', 'test_adapter', true, NOW(), NOW())
    ON CONFLICT (university_key) DO NOTHING
  `);
}

async function cleanupTestData(): Promise<void> {
  await db
    .update(portalCredentialsTable)
    .set({ deletedAt: new Date() })
    .where(eq(portalCredentialsTable.portalKey, TEST_PORTAL_KEY));
  await db.execute(
    `DELETE FROM portal_credentials WHERE portal_key = '${TEST_PORTAL_KEY}'`,
  );
  await db.execute(
    `DELETE FROM portal_universities WHERE university_key = '${TEST_PORTAL_KEY}'`,
  );
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function pass(msg: string): void {
  console.log(`  ✅ PASS  ${msg}`);
}

function fail(msg: string, err?: unknown): void {
  console.error(`  ❌ FAIL  ${msg}`, err ?? "");
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// T1: Encrypt / decrypt round-trip
// ---------------------------------------------------------------------------
async function t1RoundTrip(): Promise<void> {
  console.log("\nT1: Encrypt / decrypt round-trip");
  try {
    const plain = "super-secret-password-123!@#";
    const enc   = encryptString(plain);
    assert(enc.startsWith("enc::v1::"), "encrypted must have prefix enc::v1::");
    const dec   = decryptString(enc);
    assert.equal(dec, plain, "decrypted value must match original");
    const enc2  = encryptString(plain);
    assert.notEqual(enc, enc2, "same plaintext should produce different ciphertexts (random IV)");
    pass("round-trip OK; IVs are randomised");
  } catch (err) {
    fail("round-trip", err);
  }
}

// ---------------------------------------------------------------------------
// T2: Upsert — encrypted row, no plaintext in DB
// ---------------------------------------------------------------------------
async function t2UpsertCreds(): Promise<void> {
  console.log("\nT2: Upsert encrypted credentials");
  try {
    const usernameEnc = encryptString("portal_user@example.com");
    const passwordEnc = encryptString("S3cr3tPa$$w0rd!");

    await db
      .insert(portalCredentialsTable)
      .values({ portalKey: TEST_PORTAL_KEY, usernameEnc, passwordEnc, isActive: true })
      .onConflictDoUpdate({
        target: portalCredentialsTable.portalKey,
        set: { usernameEnc, passwordEnc, isActive: true, deletedAt: null, updatedAt: new Date() },
      });

    const [row] = await db
      .select()
      .from(portalCredentialsTable)
      .where(
        and(
          eq(portalCredentialsTable.portalKey, TEST_PORTAL_KEY),
          isNull(portalCredentialsTable.deletedAt),
        ),
      );

    assert(row, "row must exist after upsert");
    assert(row.usernameEnc.startsWith("enc::v1::"), "usernameEnc must be encrypted");
    assert(row.passwordEnc.startsWith("enc::v1::"), "passwordEnc must be encrypted");
    assert(
      !row.usernameEnc.includes("portal_user"),
      "plaintext username must not appear in DB column",
    );
    assert(
      !row.passwordEnc.includes("S3cr3t"),
      "plaintext password must not appear in DB column",
    );
    pass("row stored encrypted; no plaintext in DB");
  } catch (err) {
    fail("upsert", err);
  }
}

// ---------------------------------------------------------------------------
// T3: checkHasPortalCredentials → true after upsert
// ---------------------------------------------------------------------------
async function t3HasCredentials(): Promise<void> {
  console.log("\nT3: checkHasPortalCredentials returns true");
  try {
    const has = await checkHasPortalCredentials(TEST_PORTAL_KEY);
    assert.equal(has, true, "must return true after upsert");
    pass("hasCredentials=true");
  } catch (err) {
    fail("hasCredentials after upsert", err);
  }
}

// ---------------------------------------------------------------------------
// T4: resolvePortalCreds → correct plaintext
// ---------------------------------------------------------------------------
async function t4ResolveCreds(): Promise<void> {
  console.log("\nT4: resolvePortalCreds decrypts correctly");
  try {
    const creds = await resolvePortalCreds(TEST_PORTAL_KEY);
    assert.equal(creds.user,     "portal_user@example.com", "user must match");
    assert.equal(creds.password, "S3cr3tPa$$w0rd!",         "password must match");
    pass("decrypted creds match original plaintext");
  } catch (err) {
    fail("resolve creds", err);
  }
}

// ---------------------------------------------------------------------------
// T5: Soft-delete → hasCredentials=false, row still in table
// ---------------------------------------------------------------------------
async function t5SoftDelete(): Promise<void> {
  console.log("\nT5: Soft-delete → hasCredentials=false");
  try {
    await db
      .update(portalCredentialsTable)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(portalCredentialsTable.portalKey, TEST_PORTAL_KEY),
          isNull(portalCredentialsTable.deletedAt),
        ),
      );

    const has = await checkHasPortalCredentials(TEST_PORTAL_KEY);
    assert.equal(has, false, "must be false after soft-delete");

    const [row] = await db
      .select({ deletedAt: portalCredentialsTable.deletedAt })
      .from(portalCredentialsTable)
      .where(eq(portalCredentialsTable.portalKey, TEST_PORTAL_KEY));

    assert(row?.deletedAt instanceof Date, "deletedAt must be set (soft-delete, not hard-delete)");
    pass("soft-deleted; hasCredentials=false; row still in table");
  } catch (err) {
    fail("soft-delete", err);
  }
}

// ---------------------------------------------------------------------------
// T6: Env fallback when no active DB row
// ---------------------------------------------------------------------------
async function t6EnvFallback(): Promise<void> {
  console.log("\nT6: Env fallback when no active DB row");
  try {
    const fallbackKey = "__test_env_fallback_xyz__";
    const K           = fallbackKey.toUpperCase().replace(/-/g, "_");
    process.env[`${K}_EMAIL`]    = "envuser@example.com";
    process.env[`${K}_PASSWORD`] = "envpassword";

    const creds = await resolvePortalCreds(fallbackKey);
    assert.equal(creds.user,     "envuser@example.com", "env user must be returned");
    assert.equal(creds.password, "envpassword",          "env password must be returned");

    const has = await checkHasPortalCredentials(fallbackKey);
    assert.equal(has, true, "hasCredentials must be true via env");

    delete process.env[`${K}_EMAIL`];
    delete process.env[`${K}_PASSWORD`];

    pass("resolver falls back to process.env correctly");
  } catch (err) {
    fail("env fallback", err);
  }
}

// ---------------------------------------------------------------------------
// T7: resolvePortalCreds throws when nothing configured
// ---------------------------------------------------------------------------
async function t7NoCredsThrows(): Promise<void> {
  console.log("\nT7: resolvePortalCreds throws when nothing configured");
  try {
    const missing = "__definitely_missing_creds_key_xyz__";
    await assert.rejects(
      () => resolvePortalCreds(missing),
      /No credentials/,
      "should throw with 'No credentials' message",
    );
    pass("throws with clear message when no creds found");
  } catch (err) {
    fail("no-creds throws", err);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("=== Portal Credentials Test Suite ===");

  await ensureTestUniversity();

  try {
    await t1RoundTrip();
    await t2UpsertCreds();
    await t3HasCredentials();
    await t4ResolveCreds();
    await t5SoftDelete();
    await t6EnvFallback();
    await t7NoCredsThrows();
  } finally {
    await cleanupTestData();
  }

  if (process.exitCode) {
    console.error("\n❌ Some tests FAILED");
  } else {
    console.log("\n✅ All tests PASSED");
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
