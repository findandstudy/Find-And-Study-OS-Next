import type { Request } from "express";

/**
 * Resolve the real client IP from a request.
 *
 * SECURITY (Rate-Limit IP Bypass):
 * The app is deployed behind exactly one trusted proxy (the Replit edge).
 * `app.set("trust proxy", 1)` in app.ts tells Express to trust one proxy hop.
 * Express then sets `req.ip` to the RIGHTMOST X-Forwarded-For entry added by
 * that trusted proxy — the real client IP.
 *
 * We intentionally use `req.ip` rather than reading `X-Forwarded-For` directly.
 * Direct header parsing would bypass the centralized `trust proxy` configuration
 * and re-introduce the same bypass if the proxy topology changes (e.g., 2 hops).
 * `req.ip` is the single source of truth; `trust proxy = 1` is the security gate.
 *
 * With `trust proxy = 1` and an incoming `X-Forwarded-For: fake, real`:
 *   - Express treats the socket address as the 1 trusted proxy
 *   - Returns `real` (rightmost XFF entry, added by the edge) as `req.ip`
 *   - The client-supplied `fake` entry is ignored by the IP chain
 *
 * Returns `null` — never the literal "unknown" — when no IP can be determined,
 * so rate-limit keys and audit logs do not collapse all anonymous callers into
 * a single bucket.
 */
export function getClientIp(req: Request): string | null {
  const ip = req.ip;
  if (!ip || typeof ip !== "string") return null;
  const trimmed = ip.trim();
  if (!trimmed || trimmed.toLowerCase() === "unknown") return null;
  return trimmed;
}

/**
 * Same as `getClientIp` but returns a stable rate-limit bucket key when no
 * IP can be determined. Falls back to `"anon"` so anonymous requests are
 * still limited rather than ungated.
 */
export function getRateLimitIp(req: Request): string {
  return getClientIp(req) ?? "anon";
}
