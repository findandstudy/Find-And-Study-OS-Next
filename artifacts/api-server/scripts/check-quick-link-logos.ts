/**
 * check-quick-link-logos.ts
 *
 * Reports quick_links rows whose referenced logo object is missing or
 * unreachable in the ACTIVE storage backend (whatever STORAGE_DRIVER is set to).
 * Admins can use this to find which quick links need their logo re-uploaded —
 * e.g. after a database was migrated between environments but the stored object
 * files were not copied along with it.
 *
 * Usage (from workspace root, on the target environment / VPS):
 *   pnpm --filter @workspace/api-server tsx scripts/check-quick-link-logos.ts
 *
 * Honors the existing STORAGE_DRIVER / STORAGE_LOCAL_DIR env vars. Read-only:
 * it never modifies the database or storage. Exits with code 1 if any missing
 * logos are found (handy for CI/cron), 0 otherwise.
 */

import { ObjectStorageService, ObjectNotFoundError } from "../src/lib/objectStorage.js";

const { db } = await import("@workspace/db");
const { quickLinksTable } = await import("@workspace/db");
const { isNotNull } = await import("drizzle-orm");

const driver = process.env.STORAGE_DRIVER || "replit";
console.log(`Storage driver: ${driver}`);
console.log("Querying quick_links with a logo_url...\n");

const rows = await db
  .select({
    id: quickLinksTable.id,
    title: quickLinksTable.title,
    logoUrl: quickLinksTable.logoUrl,
    isActive: quickLinksTable.isActive,
  })
  .from(quickLinksTable)
  .where(isNotNull(quickLinksTable.logoUrl));

const svc = new ObjectStorageService();

let okCount = 0;
const missing: Array<{ id: number; title: string; logoUrl: string; reason: string }> = [];

for (const row of rows) {
  const logoUrl = (row.logoUrl || "").trim();
  if (!logoUrl) continue;

  // The stored logoUrl is a serve path like `/api/storage/objects/<key>`.
  // Convert it back to the `/objects/<key>` form getObjectEntityFile expects.
  const key = logoUrl.replace(/^.*\/api\/storage\/objects\//, "").replace(/^\/objects\//, "");
  const objectPath = `/objects/${key.replace(/^\//, "")}`;

  try {
    const file = await svc.getObjectEntityFile(objectPath);
    // getMetadata throws if the underlying object does not physically exist.
    await file.getMetadata();
    okCount++;
    process.stdout.write(`  ✓ #${row.id} ${row.title}\n`);
  } catch (err) {
    const reason =
      err instanceof ObjectNotFoundError
        ? "object not found in storage backend"
        : err instanceof Error
          ? err.message
          : String(err);
    missing.push({ id: row.id, title: row.title, logoUrl, reason });
    process.stderr.write(`  ✗ #${row.id} ${row.title}  —  ${reason}\n`);
  }
}

console.log("\n─────────────────────────────────────────");
console.log(`Quick links with a logo : ${rows.length}`);
console.log(`Reachable               : ${okCount}`);
console.log(`Missing / unreachable   : ${missing.length}`);

if (missing.length > 0) {
  console.log("\nRe-upload the logo for these quick links:");
  for (const m of missing) {
    console.log(`  #${m.id}  ${m.title}\n       logoUrl: ${m.logoUrl}\n       reason : ${m.reason}`);
  }
  process.exit(1);
}

console.log("\nAll quick-link logos are reachable in the active storage backend.");
