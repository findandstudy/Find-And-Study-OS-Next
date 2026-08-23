import { execSync } from "child_process";

export default async function globalSetup() {
  const missingCreds: string[] = [];
  if (!process.env.PLAYWRIGHT_STAFF_EMAIL) missingCreds.push("PLAYWRIGHT_STAFF_EMAIL");
  if (!process.env.PLAYWRIGHT_STAFF_PASS) missingCreds.push("PLAYWRIGHT_STAFF_PASS");
  if (missingCreds.length > 0) {
    throw new Error(
      `[e2e] Required environment variables are not set: ${missingCreds.join(", ")}. ` +
      `The inbox e2e suite cannot run without staff credentials.`,
    );
  }

  execSync(
    "pnpm --filter @workspace/api-server exec tsx ./scripts/e2e-db-setup.ts",
    { stdio: "inherit" },
  );

  execSync(
    "pnpm --filter @workspace/api-server exec tsx ./scripts/e2e-embed-fixtures.ts",
    { stdio: "inherit" },
  );

  execSync(
    "pnpm --filter @workspace/api-server exec tsx ./scripts/rbac-e2e-setup.ts",
    { stdio: "inherit" },
  );
}
