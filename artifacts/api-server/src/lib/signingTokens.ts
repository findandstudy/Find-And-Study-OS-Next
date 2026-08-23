import crypto from "crypto";

const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const TOKEN_LENGTH = 32;

function generateRawToken(): string {
  // Use rejection sampling against the alphabet length so the distribution
  // stays uniform regardless of the byte values pulled from /dev/urandom.
  const out: string[] = [];
  while (out.length < TOKEN_LENGTH) {
    const buf = crypto.randomBytes(TOKEN_LENGTH);
    for (let i = 0; i < buf.length && out.length < TOKEN_LENGTH; i++) {
      const b = buf[i];
      const max = 256 - (256 % TOKEN_ALPHABET.length);
      if (b >= max) continue;
      out.push(TOKEN_ALPHABET[b % TOKEN_ALPHABET.length]);
    }
  }
  return out.join("");
}

export function createSigningToken(): { rawToken: string; tokenHash: string } {
  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  return { rawToken, tokenHash };
}

export function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}
