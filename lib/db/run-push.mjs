import { executeLocalPush } from "./guard-push.mjs";

export async function runDbPush() {
  const status = executeLocalPush();
  if (status !== 0) {
    throw new Error(`[db] Local drizzle push failed with exit code ${status}`);
  }
}
