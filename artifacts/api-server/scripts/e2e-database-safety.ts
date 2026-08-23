const SAFE_DATABASE_NAME = /(^|[_-])(e2e|test)([_-]|$)/i;

export function getDatabaseName(databaseUrl: string): string | null {
  try {
    const parsed = new URL(databaseUrl);
    const name = decodeURIComponent(parsed.pathname.replace(/^\/+/, "")).trim();
    return name || null;
  } catch {
    return null;
  }
}

export function isSafeE2eDatabaseUrl(databaseUrl: string): boolean {
  const databaseName = getDatabaseName(databaseUrl);
  return databaseName !== null && SAFE_DATABASE_NAME.test(databaseName);
}

/**
 * E2E fixture scripts create and delete rows. Require both an unmistakably
 * test-only database name and an explicit opt-in so a copied production
 * DATABASE_URL can never be mutated by an accidental Playwright invocation.
 */
export function assertSafeE2eDatabase(): void {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (process.env.E2E_ALLOW_DATABASE_MUTATION !== "1") {
    throw new Error(
      "[e2e safety] E2E_ALLOW_DATABASE_MUTATION=1 is required for DB fixture mutations",
    );
  }
  if (!isSafeE2eDatabaseUrl(databaseUrl)) {
    const databaseName = getDatabaseName(databaseUrl) ?? "invalid-or-missing";
    throw new Error(
      `[e2e safety] Refusing to mutate database "${databaseName}". ` +
      `Use a dedicated database whose name contains an e2e/test segment.`,
    );
  }
}
