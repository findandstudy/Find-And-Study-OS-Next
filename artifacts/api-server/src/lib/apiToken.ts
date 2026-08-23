import crypto from "crypto";

// Personal API tokens (Authorization: Bearer <token>) for programmatic access.
// Format: "fas_live_" + 32 base62 chars. The plain value is returned exactly
// once at creation; only the SHA-256 hash is persisted. The prefix is a
// non-secret leading slice kept for UI identification.
const TOKEN_PREFIX = "fas_live_";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const RANDOM_LEN = 32;
const PREFIX_PREVIEW_LEN = 12; // "fas_live_" (9) + first 3 random chars

// Scope grammar is resource:action. These are the only scopes a token may hold.
export const AVAILABLE_SCOPES = [
  "applications:read",
  "applications:write",
  "applications:patch",
  "documents:read",
  "documents:write",
  "students:read",
  "universities:read",
] as const;

export type ApiScope = (typeof AVAILABLE_SCOPES)[number];

// Cryptographically secure base62 string via rejection sampling, so the
// character distribution stays uniform regardless of the raw random bytes.
function randomBase62(length: number): string {
  const out: string[] = [];
  const max = 256 - (256 % BASE62.length);
  while (out.length < length) {
    const buf = crypto.randomBytes(length);
    for (let i = 0; i < buf.length && out.length < length; i++) {
      const b = buf[i];
      if (b >= max) continue;
      out.push(BASE62[b % BASE62.length]);
    }
  }
  return out.join("");
}

export function hashToken(plain: string): string {
  return crypto.createHash("sha256").update(plain, "utf8").digest("hex");
}

export function generateToken(): { plain: string; prefix: string; hash: string } {
  const plain = TOKEN_PREFIX + randomBase62(RANDOM_LEN);
  const prefix = plain.slice(0, PREFIX_PREVIEW_LEN);
  const hash = hashToken(plain);
  return { plain, prefix, hash };
}

// Timing-safe comparison of a presented plain token against a stored hash.
// Both sides are 64-char lowercase hex; we decode to buffers and guard against
// length mismatch (timingSafeEqual throws on unequal-length inputs, and an
// invalid/short storedHash decodes to a shorter buffer → false).
export function verifyToken(plain: string, storedHash: string): boolean {
  const computed = Buffer.from(hashToken(plain), "hex");
  const stored = Buffer.from(storedHash, "hex");
  if (computed.length !== stored.length || computed.length === 0) return false;
  return crypto.timingSafeEqual(computed, stored);
}

export function isValidScope(scope: string): scope is ApiScope {
  return (AVAILABLE_SCOPES as readonly string[]).includes(scope);
}

// Validate a requested scope list; returns the set of unknown scopes (if any).
export function validateScopes(scopes: string[]): { valid: boolean; invalid: string[] } {
  const invalid = scopes.filter((s) => !isValidScope(s));
  return { valid: invalid.length === 0, invalid };
}
