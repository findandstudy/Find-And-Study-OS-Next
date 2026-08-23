import crypto from "node:crypto";
import { getAssetSigningSecret } from "./assetSigningSecret.js";

// ---------------------------------------------------------------------------
// Signed, auth-free student-photo URLs
// ---------------------------------------------------------------------------
// External create webhooks (e.g. SIT n8n) fetch a student's photo by URL but
// cannot present a session cookie. Most photos live as base64 in the DB (no
// public object-storage key), so the only servable source is the API server's
// `GET /api/students/:id/photo` endpoint — which requires auth.
//
// To make that endpoint fetchable without a session we accept an HMAC-signed,
// short-lived query signature (`?exp=<unix-seconds>&sig=<hex>`). The signer
// (portal worker / runner) and the verifier (api-server) share the same secret
// via env, reusing the SESSION_SECRET/EMBED_TOKEN_SECRET pair the embed widget
// already relies on — so no new production env var is required. When no secret
// is configured, signing returns null and the caller simply omits the photo
// (it is always optional; create must never be blocked on it).

/** Shared signing secret. Returns "" when no signing env var is configured. */
function photoSigningSecret(): string {
  return getAssetSigningSecret();
}

/** Default validity window for a signed photo URL (7 days). */
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

function computeSignature(studentId: number, exp: number, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`student-photo:${studentId}:${exp}`)
    .digest("hex");
}

/**
 * Build a signed, auth-free RELATIVE path to a student's photo, e.g.
 * `/api/students/123/photo?exp=...&sig=...`. The caller absolutizes it with the
 * public asset base before sending it to the external webhook.
 *
 * Returns null when no signing secret is configured or the id is invalid — the
 * caller then omits the photo (photos are always optional).
 */
export function buildSignedStudentPhotoPath(
  studentId: number,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): string | null {
  if (!Number.isFinite(studentId) || studentId <= 0) return null;
  const secret = photoSigningSecret();
  if (!secret) return null;
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = computeSignature(studentId, exp, secret);
  return `/api/students/${studentId}/photo?exp=${exp}&sig=${sig}`;
}

/**
 * Build a cache-stable signed photo path for authenticated list views.
 *
 * A fresh expiry timestamp on every list request changes the browser cache key
 * even when the underlying photo is unchanged.  The expiry below is anchored
 * to a short time bucket while retaining the requested TTL, so every response
 * generated in the same bucket receives the same URL.  The default five-minute
 * bucket matches the photo route's private browser-cache lifetime.
 */
export function buildStableSignedStudentPhotoPath(
  studentId: number,
  ttlSeconds: number = 15 * 60,
  bucketSeconds: number = 5 * 60,
): string | null {
  if (!Number.isFinite(studentId) || studentId <= 0) return null;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return null;
  if (!Number.isFinite(bucketSeconds) || bucketSeconds <= 0) return null;
  const secret = photoSigningSecret();
  if (!secret) return null;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const bucketStart = Math.floor(nowSeconds / bucketSeconds) * bucketSeconds;
  const exp = bucketStart + ttlSeconds;
  const sig = computeSignature(studentId, exp, secret);
  return `/api/students/${studentId}/photo?exp=${exp}&sig=${sig}`;
}

export function buildStableSignedStudentPhotoThumbnailPath(
  studentId: number,
  ttlSeconds = 15 * 60,
  bucketSeconds = 5 * 60,
): string | null {
  const path = buildStableSignedStudentPhotoPath(studentId, ttlSeconds, bucketSeconds);
  return path?.replace(`/students/${studentId}/photo?`, `/students/${studentId}/photo/thumbnail?`) ?? null;
}

/**
 * Verify a signed student-photo request. Returns true only when the signature
 * matches and has not expired. Constant-time compare; never throws.
 */
export function verifyStudentPhotoSignature(
  studentId: number,
  exp: number,
  sig: string,
): boolean {
  const secret = photoSigningSecret();
  if (!secret) return false;
  if (!Number.isFinite(studentId) || studentId <= 0) return false;
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  if (typeof sig !== "string" || sig.length === 0) return false;
  const expected = computeSignature(studentId, exp, secret);
  try {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(sig, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
