import crypto from "crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const PREFIX = "enc::v1::";

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.ENCRYPTION_KEY || process.env.SESSION_SECRET || "";
  if (!raw) {
    throw new Error("ENCRYPTION_KEY (or SESSION_SECRET fallback) is required for encrypting integration secrets");
  }
  cachedKey = crypto.createHash("sha256").update(raw).digest();
  return cachedKey;
}

export function isEncrypted(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function encryptString(plaintext: string): string {
  if (!plaintext) return plaintext;
  if (isEncrypted(plaintext)) return plaintext;
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, ct]).toString("base64");
  return PREFIX + payload;
}

export function decryptString(value: string): string {
  if (!isEncrypted(value)) return value;
  const key = getKey();
  const buf = Buffer.from(value.slice(PREFIX.length), "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  return pt;
}

const SECRET_KEYS = new Set([
  "password",
  "token",
  "secret",
  "api_key",
  "apiKey",
  "accessToken",
  "access_token",
  "appSecret",
  "app_secret",
  "webhookVerifyToken",
  "webhook_verify_token",
  "secretKey",
  "secret_key",
  "clientSecret",
  "client_secret",
]);

function isSecretKey(key: string): boolean {
  if (SECRET_KEYS.has(key)) return true;
  const lower = key.toLowerCase();
  return /token|secret|password|apikey|api_key/.test(lower);
}

export function encryptConfig<T extends Record<string, any>>(config: T | null | undefined): T {
  if (!config || typeof config !== "object") return (config ?? {}) as T;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(config)) {
    if (typeof v === "string" && v && isSecretKey(k)) {
      out[k] = encryptString(v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export function decryptConfig<T extends Record<string, any>>(config: T | null | undefined): T {
  if (!config || typeof config !== "object") return (config ?? {}) as T;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(config)) {
    if (typeof v === "string" && isEncrypted(v)) {
      try {
        out[k] = decryptString(v);
      } catch {
        out[k] = v;
      }
    } else {
      out[k] = v;
    }
  }
  return out as T;
}
