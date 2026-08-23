import assert from "node:assert/strict";
import test from "node:test";
import {
  ABSOLUTE_SESSION_TTL,
  getAbsoluteSessionExpiry,
  getBoundedSessionExpiry,
  getRemainingSessionCookieTtl,
  isAbsoluteSessionExpired,
  resolveSessionIssuedAt,
} from "../src/lib/sessionLifetime";

test("valid issued-at values are preserved and legacy values start at first observation", () => {
  const now = 1_000_000;
  assert.equal(resolveSessionIssuedAt(900_000, now), 900_000);
  assert.equal(resolveSessionIssuedAt(undefined, now), now);
  assert.equal(resolveSessionIssuedAt(Number.NaN, now), now);
  assert.equal(resolveSessionIssuedAt(now + 1, now), now);
});

test("absolute lifetime cannot be extended by idle sliding", () => {
  const issuedAt = 1_000;
  const almostAbsolute = getAbsoluteSessionExpiry(issuedAt) - 60_000;
  assert.equal(
    getBoundedSessionExpiry(issuedAt, 8 * 60 * 60 * 1000, almostAbsolute),
    getAbsoluteSessionExpiry(issuedAt),
  );
  assert.equal(
    getRemainingSessionCookieTtl(issuedAt, 8 * 60 * 60 * 1000, almostAbsolute),
    60_000,
  );
});

test("absolute expiry is inclusive and fixed at 24 hours", () => {
  const issuedAt = 10_000;
  assert.equal(ABSOLUTE_SESSION_TTL, 24 * 60 * 60 * 1000);
  assert.equal(isAbsoluteSessionExpired(issuedAt, getAbsoluteSessionExpiry(issuedAt) - 1), false);
  assert.equal(isAbsoluteSessionExpired(issuedAt, getAbsoluteSessionExpiry(issuedAt)), true);
});
