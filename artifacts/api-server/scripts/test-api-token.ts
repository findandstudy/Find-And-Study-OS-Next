import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateToken,
  hashToken,
  verifyToken,
  isValidScope,
  validateScopes,
  AVAILABLE_SCOPES,
} from "../src/lib/apiToken";

test("generateToken: format (prefix, length, hex hash)", () => {
  const { plain, prefix, hash } = generateToken();
  assert.ok(plain.startsWith("fas_live_"), "plain must start with fas_live_");
  // "fas_live_" (9) + 32 random = 41 chars.
  assert.equal(plain.length, 41, "plain length must be 41");
  // The random part must be base62 only.
  assert.match(plain.slice(9), /^[0-9A-Za-z]{32}$/, "random part must be 32 base62 chars");
  assert.equal(prefix, plain.slice(0, 12), "prefix is the first 12 chars of plain");
  assert.equal(prefix.length, 12, "prefix length must be 12");
  assert.match(hash, /^[0-9a-f]{64}$/, "hash must be 64-char lowercase hex (SHA-256)");
});

test("hashToken: deterministic — same plain → same hash", () => {
  const plain = "fas_live_abc123";
  assert.equal(hashToken(plain), hashToken(plain));
});

test("generateToken: different plain → different hash", () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a.plain, b.plain, "two generated tokens must differ");
  assert.notEqual(a.hash, b.hash, "two generated hashes must differ");
});

test("verifyToken: correct token verifies, wrong token rejects", () => {
  const { plain, hash } = generateToken();
  assert.equal(verifyToken(plain, hash), true, "correct plain must verify");
  assert.equal(verifyToken(plain + "x", hash), false, "tampered plain must fail");
  assert.equal(verifyToken("fas_live_totallyWrong", hash), false, "wrong plain must fail");
});

test("verifyToken: malformed stored hash never throws, returns false", () => {
  const { plain } = generateToken();
  assert.equal(verifyToken(plain, ""), false, "empty stored hash → false");
  assert.equal(verifyToken(plain, "not-hex"), false, "non-hex stored hash → false");
  assert.equal(verifyToken(plain, "abcd"), false, "short stored hash → false");
});

test("scope validation: known scopes pass, unknown fail", () => {
  for (const s of AVAILABLE_SCOPES) {
    assert.equal(isValidScope(s), true, `${s} must be valid`);
  }
  assert.equal(isValidScope("applications:delete"), false, "unknown action must be invalid");
  assert.equal(isValidScope("finance:read"), false, "unknown resource must be invalid");

  const ok = validateScopes(["applications:read", "students:read"]);
  assert.deepEqual(ok, { valid: true, invalid: [] });

  const bad = validateScopes(["applications:read", "bogus:scope", "x:y"]);
  assert.equal(bad.valid, false);
  assert.deepEqual(bad.invalid, ["bogus:scope", "x:y"]);
});
