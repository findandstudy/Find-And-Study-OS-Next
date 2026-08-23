/**
 * Resolve an inbox-composer object URL to its canonical storage key.
 *
 * Historical outbound messages contain a malformed double-prefixed URL:
 *   /api/storage/public-objects//objects/inbox/<uuid>
 * New messages use the authenticated object route:
 *   /api/storage/objects/inbox/<uuid>
 *
 * Only same-app hosts and the inbox/ namespace are accepted. This prevents an
 * arbitrary external URL that merely resembles one of our routes from being
 * treated as a local object-storage read.
 */
export function resolveLocalInboxStorageKey(
  rawUrl: string,
  allowedHosts: Iterable<string>,
): string | null {
  const value = String(rawUrl ?? "").trim();
  if (!value) return null;

  let pathname: string;
  if (value.startsWith("/")) {
    try {
      pathname = new URL(value, "https://local.invalid").pathname;
    } catch {
      return null;
    }
  } else {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const hosts = new Set(
      Array.from(allowedHosts, (host) => String(host).trim().toLowerCase()).filter(Boolean),
    );
    if (!hosts.has(parsed.hostname.toLowerCase())) return null;
    pathname = parsed.pathname;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const match = decoded.match(
    /^\/api\/storage\/(?:public-objects|objects)\/(.+)$/,
  );
  if (!match) return null;

  let key = match[1].replace(/^\/+/, "");
  key = key.replace(/^(?:objects\/)+/, "");
  key = key.replace(/\/{2,}/g, "/");

  const segments = key.split("/");
  if (
    segments.length < 2 ||
    segments[0] !== "inbox" ||
    segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"))
  ) {
    return null;
  }

  return key;
}

export function configuredInboxMediaHosts(
  extraHosts: Iterable<string> = [],
): Set<string> {
  const hosts = new Set(
    [
      "apply.findandstudy.com",
      ...Array.from(extraHosts, (host) => String(host).trim().toLowerCase()),
    ].filter(Boolean),
  );
  for (const raw of [
    process.env.BASE_URL,
    process.env.PUBLIC_APP_BASE,
    process.env.APP_BASE_URL,
    process.env.OBJECT_BASE_URL,
  ]) {
    if (!raw) continue;
    try {
      hosts.add(new URL(raw).hostname.toLowerCase());
    } catch {
      // Ignore malformed optional configuration; the explicit request host
      // still authorizes the route-level lookup.
    }
  }
  return hosts;
}

export function isZernioMediaUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "https:" && parsed.hostname === "zernio.com";
  } catch {
    return false;
  }
}

/**
 * Zernio answers with HTTP 400 when an old WhatsApp attachment has expired or
 * was deleted. That is a resource-level condition, not a gateway outage.
 * Preserve 502 for genuine provider, authentication and rate-limit failures.
 */
export function zernioMediaFailureStatus(
  upstreamStatus: number,
  upstreamBody: string,
): 404 | 410 | 502 {
  if (upstreamStatus === 404) return 404;
  if (upstreamStatus === 410) return 410;
  if (upstreamStatus === 400) {
    const body = upstreamBody.toLowerCase();
    if (
      body.includes("expired") ||
      body.includes("deleted") ||
      body.includes("not found") ||
      body.includes("no longer available")
    ) {
      return 410;
    }
  }
  return 502;
}
