import { executeLocalPush } from "./guard-push.mjs";

try {
  process.exit(executeLocalPush());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
