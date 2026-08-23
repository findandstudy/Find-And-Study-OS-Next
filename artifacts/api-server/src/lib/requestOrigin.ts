import type { Request } from "express";

/**
 * Origins the application trusts for credentialed/state-changing requests.
 * Derived from the Replit-provided domains plus any explicitly configured
 * ALLOWED_ORIGINS, and localhost in non-production for local dev / e2e tests.
 */
export function getAllowedOrigins(): string[] {
  const origins: string[] = [];
  if (process.env.REPLIT_DEV_DOMAIN) {
    origins.push(`https://${process.env.REPLIT_DEV_DOMAIN}`);
  }
  if (process.env.REPLIT_DOMAINS) {
    process.env.REPLIT_DOMAINS.split(",").forEach((d) => origins.push(`https://${d.trim()}`));
  }
  if (process.env.ALLOWED_ORIGINS) {
    process.env.ALLOWED_ORIGINS.split(",").forEach((d) => origins.push(d.trim()));
  }
  if (process.env.NODE_ENV !== "production") {
    origins.push("http://localhost:25197");
    origins.push("http://localhost:5173");
  }
  return Array.from(new Set(origins.filter(Boolean)));
}

/**
 * Decide whether a browser Origin may make a credentialed CORS request.
 *
 * Fail closed in production: an empty ALLOWED_ORIGINS configuration must not
 * silently turn into "allow every origin". Requests without an Origin header
 * remain allowed because service-to-service and same-origin non-browser
 * clients do not necessarily send one. The request's own origin is accepted
 * explicitly, while localhost is restricted to development/test.
 */
export function isCredentialedCorsOriginAllowed(
  origin: string | undefined,
  requestOrigin: string | null,
  allowedOrigins: readonly string[] = getAllowedOrigins(),
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  if (!origin) return true;
  if (requestOrigin && origin === requestOrigin) return true;
  if (nodeEnv !== "production" && /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
    return true;
  }
  return allowedOrigins.includes(origin);
}

/**
 * Extract the originating origin of a request from the Origin header
 * (preferred) or, failing that, the origin component of the Referer header.
 * Returns null when neither is present or parseable.
 */
export function getRequestOrigin(req: Request): string | null {
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin) return origin;
  const referer = (req.headers.referer || (req.headers as Record<string, unknown>).referrer) as
    | string
    | undefined;
  if (typeof referer === "string" && referer) {
    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Returns true only when the request demonstrably originates from a trusted
 * same-site origin. Used to defend CSRF-exempt, unauthenticated, state-changing
 * endpoints (notably session-minting flows) against login CSRF.
 *
 * Deny-by-default: a request with no Origin and no Referer is NOT trusted, so a
 * cross-site auto-submitting form cannot mint a session by omitting headers.
 * localhost is accepted only in non-production to keep local dev / e2e working.
 */
export function isTrustedOrigin(req: Request): boolean {
  const origin = getRequestOrigin(req);
  if (!origin) return false;
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) {
    return process.env.NODE_ENV !== "production";
  }
  return getAllowedOrigins().includes(origin);
}
