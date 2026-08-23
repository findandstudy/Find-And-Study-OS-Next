import crypto from "node:crypto";
import { getAssetSigningSecret } from "./assetSigningSecret.js";

// ---------------------------------------------------------------------------
// Signed, auth-free student-document URLs
// ---------------------------------------------------------------------------
// Mirrors studentPhotoSigning.ts. External create webhooks (e.g. SIT n8n) fetch
// a student's documents by URL but cannot present a session cookie. Many CRM
// documents live as base64 in the DB (`documents.file_data`) with no public
// object-storage key, so the only servable source is the API server's
// `GET /api/documents/:id/file` endpoint — which normally requires auth.
//
// To make that endpoint fetchable without a session we accept an HMAC-signed,
// short-lived query signature (`?exp=<unix-seconds>&sig=<hex>`). The signer
// (portal worker / runner) and the verifier (api-server) share the same secret
// via env, reusing the SESSION_SECRET/EMBED_TOKEN_SECRET pair the embed widget
// already relies on — so no new production env var is required. When no secret
// is configured, signing returns null and the caller simply omits the document.

/** Shared signing secret. Returns "" when no signing env var is configured. */
function documentSigningSecret(): string {
  return getAssetSigningSecret();
}

/** Default validity window for a signed document URL (7 days). */
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

function computeSignature(documentId: number, exp: number, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`document:${documentId}:${exp}`)
    .digest("hex");
}

/**
 * Build a signed, auth-free RELATIVE path to a document's file, e.g.
 * `/api/documents/6008/file?exp=...&sig=...`. The caller absolutizes it with the
 * public asset base before sending it to the external webhook.
 *
 * Returns null when no signing secret is configured or the id is invalid — the
 * caller then omits the document.
 */
export function buildSignedDocumentPath(
  documentId: number,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): string | null {
  if (!Number.isFinite(documentId) || documentId <= 0) return null;
  const secret = documentSigningSecret();
  if (!secret) return null;
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = computeSignature(documentId, exp, secret);
  return `/api/documents/${documentId}/file?exp=${exp}&sig=${sig}`;
}

/**
 * Verify a signed document request. Returns true only when the signature
 * matches and has not expired. Constant-time compare; never throws.
 */
export function verifyDocumentSignature(
  documentId: number,
  exp: number,
  sig: string,
): boolean {
  const secret = documentSigningSecret();
  if (!secret) return false;
  if (!Number.isFinite(documentId) || documentId <= 0) return false;
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  if (typeof sig !== "string" || sig.length === 0) return false;
  const expected = computeSignature(documentId, exp, secret);
  try {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(sig, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
