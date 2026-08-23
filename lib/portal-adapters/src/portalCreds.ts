// ---------------------------------------------------------------------------
// portalCreds — read portal login credentials
//
// Convention (env fallback):
//   user field → {KEY}_USER  or  {KEY}_EMAIL  (first defined wins)
//   pass field → {KEY}_PASSWORD
//
// Override mechanism: the worker/runner can inject resolved credentials
// (e.g. from the DB-backed portal_credentials table) via setCredsOverride()
// before calling adapter.login(), then clearCredsOverride() in finally.
// ---------------------------------------------------------------------------

export interface ResolvedCreds {
  user: string;
  password: string;
  extra?: Record<string, unknown>;
}

const _overrides = new Map<string, ResolvedCreds>();
const _sessionCreds = new WeakMap<object, ResolvedCreds>();

export function setCredsOverride(adapterKey: string, creds: ResolvedCreds): void {
  _overrides.set(adapterKey, creds);
}

export function clearCredsOverride(adapterKey: string): void {
  _overrides.delete(adapterKey);
}

/**
 * Bind credentials to one browser session.
 *
 * The process-level override exists for backwards compatibility, but it is not
 * safe as the long-lived source of truth when a worker runs two submissions for
 * the same adapter concurrently: one submission can clear the shared override
 * while the other is still navigating. Session-bound credentials cannot be
 * observed or cleared by a sibling submission and disappear automatically when
 * the session is garbage-collected.
 */
export function bindPortalSessionCreds(
  session: object,
  creds: ResolvedCreds,
): void {
  _sessionCreds.set(session, creds);
}

export function portalSessionCreds(
  session: object,
  adapterKey: string,
): ResolvedCreds {
  return _sessionCreds.get(session) ?? portalCreds(adapterKey);
}

export function portalCreds(adapterKey: string): ResolvedCreds {
  const override = _overrides.get(adapterKey);
  if (override) return override;

  const K = adapterKey.toUpperCase().replace(/-/g, "_");

  const user =
    process.env[`${K}_EMAIL`] ??
    process.env[`${K}_USER`]  ??
    "";

  const password = process.env[`${K}_PASSWORD`] ?? "";

  if (!user || !password) {
    throw new Error(
      `[portal-adapters] Missing credentials for "${adapterKey}". ` +
      `Set ${K}_EMAIL (or ${K}_USER) and ${K}_PASSWORD in .env`,
    );
  }

  return { user, password };
}
