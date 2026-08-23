import { execSync } from "child_process";

export default async function globalTeardown() {
  try {
    execSync(
      "pnpm --filter @workspace/api-server exec tsx ./scripts/rbac-e2e-teardown.ts",
      { stdio: "inherit" },
    );
  } catch (err) {
    console.warn("[playwright teardown] RBAC fixtures teardown failed (non-fatal):", err);
  }

  try {
    execSync(
      "pnpm --filter @workspace/api-server exec tsx ./scripts/e2e-db-teardown.ts",
      { stdio: "inherit" },
    );
  } catch (err) {
    console.warn("[playwright teardown] restore failed (non-fatal):", err);
  }

  try {
    execSync(
      "pnpm --filter @workspace/api-server exec tsx ./scripts/e2e-embed-fixtures-teardown.ts",
      { stdio: "inherit" },
    );
  } catch (err) {
    console.warn("[playwright teardown] embed fixtures teardown failed (non-fatal):", err);
  }
}
