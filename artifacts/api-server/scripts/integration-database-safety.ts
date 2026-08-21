export interface IntegrationDatabaseSafetyInput {
  allowLiveIntegrations?: string;
  allowMutation?: string;
  ci?: string;
  databaseUrl?: string;
  githubActions?: string;
  githubRunAttempt?: string;
  githubRunId?: string;
}

function parseDatabaseUrl(databaseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("[integration DB safety] DATABASE_URL is missing or invalid");
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error("[integration DB safety] DATABASE_URL must use PostgreSQL");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("[integration DB safety] connection query parameters and fragments are forbidden");
  }
  if (parsed.hostname !== "127.0.0.1") {
    throw new Error("[integration DB safety] only literal 127.0.0.1 is allowed");
  }

  return parsed;
}

export function assertSafeSignedContractAuthzDatabase({
  allowLiveIntegrations = process.env.ALLOW_LIVE_INTEGRATIONS,
  allowMutation = process.env.OBJECT_AUTHZ_TEST_ALLOW_DATABASE_MUTATION,
  ci = process.env.CI,
  databaseUrl = process.env.DATABASE_URL,
  githubActions = process.env.GITHUB_ACTIONS,
  githubRunAttempt = process.env.GITHUB_RUN_ATTEMPT,
  githubRunId = process.env.GITHUB_RUN_ID,
}: IntegrationDatabaseSafetyInput = {}): void {
  if (allowLiveIntegrations !== "false") {
    throw new Error("[integration DB safety] ALLOW_LIVE_INTEGRATIONS must be false");
  }
  if (allowMutation !== "1") {
    throw new Error(
      "[integration DB safety] OBJECT_AUTHZ_TEST_ALLOW_DATABASE_MUTATION=1 is required",
    );
  }

  const parsed = parseDatabaseUrl(databaseUrl ?? "");
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  const port = parsed.port || "5432";

  if (ci === "true") {
    if (
      githubActions !== "true" ||
      !/^[1-9]\d*$/.test(githubRunId ?? "") ||
      !/^[1-9]\d*$/.test(githubRunAttempt ?? "")
    ) {
      throw new Error(
        "[integration DB safety] CI mutations require a numeric GitHub Actions run identity",
      );
    }

    const expectedDatabaseName = `fas_it_${githubRunId}_${githubRunAttempt}`;
    if (port !== "5432" || databaseName !== expectedDatabaseName) {
      throw new Error(
        `[integration DB safety] CI mutations require 127.0.0.1:5432/${expectedDatabaseName}`,
      );
    }
    return;
  }

  if (port !== "5433" || databaseName !== "fasos_apply_local") {
    throw new Error(
      "[integration DB safety] local mutations require 127.0.0.1:5433/fasos_apply_local",
    );
  }
}
