/**
 * Shared secret-masking + merge helpers for integration-style config blobs.
 *
 * Extracted from routes/integrations.ts so the per-channel multi-account CRUD
 * (routes/channelAccounts.ts) applies the exact same masking/merge rules. Both
 * surfaces must agree on which keys are secrets so masked values are never
 * re-encrypted and stored back as the literal "abcd••••" placeholder.
 */

const SECRET_KEYS = [
  "password",
  "token",
  "secret",
  "api_key",
  "apiKey",
  "accessToken",
  "access_token",
  "appSecret",
  "app_secret",
];

function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_KEYS.some((s) => lower.includes(s.toLowerCase()));
}

/**
 * Return a copy of `config` with secret string values partially masked
 * (first 4 chars + bullets). Safe to send to the client.
 */
export function maskSecrets(config: Record<string, any>): Record<string, any> {
  const masked: Record<string, any> = {};
  for (const [k, v] of Object.entries(config)) {
    if (typeof v === "string" && isSecretKey(k) && v.length > 0) {
      masked[k] = v.slice(0, 4) + "•".repeat(Math.min(v.length - 4, 20));
    } else {
      masked[k] = v;
    }
  }
  return masked;
}

/**
 * Merge an incoming (client-supplied) config onto an existing one. A secret
 * field whose incoming value still contains a bullet ("•") is treated as the
 * unchanged masked value and is NOT overwritten, so editing a form that was
 * pre-filled with masked secrets preserves the stored secret.
 */
export function mergeConfig(
  existing: Record<string, any>,
  incoming: Record<string, any>,
): Record<string, any> {
  const merged = { ...existing };
  for (const [k, v] of Object.entries(incoming)) {
    if (typeof v === "string" && isSecretKey(k) && v.includes("•")) {
      continue;
    }
    merged[k] = v;
  }
  return merged;
}
