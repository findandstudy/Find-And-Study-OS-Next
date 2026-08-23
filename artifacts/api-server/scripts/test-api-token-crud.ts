import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq, isNull } from "drizzle-orm";
import { db, apiTokensTable, usersTable } from "@workspace/db";
import { generateToken, validateScopes } from "../src/lib/apiToken";
import { lookupApiToken } from "../src/lib/apiTokenAuth";

// Integration test against the real (dev) DB. Exercises the exact persistence +
// lookup paths the management routes use: generate → insert → lookup → revoke →
// expiry. Every row created here is cleaned up in the finally block.
test("api-token CRUD lifecycle (real DB)", async () => {
  // Pick any existing active, non-deleted user to satisfy the FK.
  const [owner] = await db
    .select()
    .from(usersTable)
    .where(and(eq(usersTable.isActive, true), isNull(usersTable.deletedAt)))
    .limit(1);
  assert.ok(owner, "expected at least one active user to own the token");

  const createdIds: number[] = [];
  try {
    // 1) Create a token (mirrors POST /api-tokens).
    const scopes = ["applications:read", "students:read"];
    const { valid } = validateScopes(scopes);
    assert.equal(valid, true, "test scopes must be valid");

    const { plain, prefix, hash } = generateToken();
    const [row] = await db
      .insert(apiTokensTable)
      .values({
        userId: owner.id,
        name: "crud-test-token",
        tokenHash: hash,
        tokenPrefix: prefix,
        scopes,
        createdBy: owner.id,
      })
      .returning();
    createdIds.push(row.id);

    assert.equal(row.tokenPrefix, prefix);
    assert.equal(row.tokenHash, hash);
    assert.notEqual(row.tokenHash, plain, "hash must never equal the plain token");
    assert.deepEqual((row.scopes as string[]) ?? [], scopes, "scopes round-trip through text[]");
    assert.equal(row.revokedAt, null);

    // 2) The freshly created token resolves through the auth lookup path.
    const ok = await lookupApiToken(plain);
    assert.ok(ok, "active token must resolve");
    assert.equal(ok!.token.id, row.id);
    assert.equal(ok!.dbUser.id, owner.id);
    assert.deepEqual(ok!.scopes, scopes);

    // 3) Revoke (mirrors POST /api-tokens/:id/revoke) — lookup now fails.
    await db.update(apiTokensTable).set({ revokedAt: new Date() }).where(eq(apiTokensTable.id, row.id));
    const afterRevoke = await lookupApiToken(plain);
    assert.equal(afterRevoke, null, "revoked token must not resolve");

    // 4) An expired (but not revoked) token also fails to resolve.
    const t2 = generateToken();
    const [expiredRow] = await db
      .insert(apiTokensTable)
      .values({
        userId: owner.id,
        name: "crud-test-expired",
        tokenHash: t2.hash,
        tokenPrefix: t2.prefix,
        scopes: ["universities:read"],
        expiresAt: new Date(Date.now() - 60_000),
        createdBy: owner.id,
      })
      .returning();
    createdIds.push(expiredRow.id);
    const expiredLookup = await lookupApiToken(t2.plain);
    assert.equal(expiredLookup, null, "expired token must not resolve");
  } finally {
    for (const id of createdIds) {
      await db.delete(apiTokensTable).where(eq(apiTokensTable.id, id));
    }
  }
});
