/**
 * export-object-storage.ts
 *
 * Downloads all active document fileKeys from Replit Object Storage and writes
 * them to ./object-export/<fileKey> preserving the key's path structure.
 *
 * Usage (from workspace root):
 *   pnpm --filter @workspace/api-server tsx scripts/export-object-storage.ts
 *
 * Requires Replit Object Storage env vars to be set (runs on Replit only).
 * After completion it prints a summary and creates object-export.tar.gz.
 */

import * as fsPromises from "node:fs/promises";
import * as nodePath from "node:path";
import { execSync } from "node:child_process";

// Always use replit driver for export (we are reading FROM Replit Object Storage)
process.env.STORAGE_DRIVER = "replit";

const { db } = await import("@workspace/db");
const { documentsTable } = await import("@workspace/db");
const { isNotNull, isNull, and } = await import("drizzle-orm");
const { ObjectStorageService } = await import("../src/lib/objectStorage.js");

// ── 1. Query all active documents with a fileKey ──────────────────────────────

console.log("Querying database for active documents with fileKey...");

const activeRows = await db
  .select({ fileKey: documentsTable.fileKey })
  .from(documentsTable)
  .where(
    and(
      isNotNull(documentsTable.fileKey),
      isNull(documentsTable.deletedAt),
    )
  );

const fileKeys = activeRows
  .map((r) => r.fileKey)
  .filter((k): k is string => typeof k === "string" && k.length > 0);

console.log(`Found ${fileKeys.length} active documents with fileKeys.\n`);

// ── 2. Download each file ─────────────────────────────────────────────────────

const OUT_DIR = nodePath.resolve(process.cwd(), "object-export");
const svc = new ObjectStorageService();

let ok = 0;
let fail = 0;
const failures: Array<{ key: string; error: string }> = [];

for (const fileKey of fileKeys) {
  // Ensure key starts with /objects/
  const normalizedKey = fileKey.startsWith("/objects/")
    ? fileKey
    : `/objects/${fileKey.replace(/^\//, "")}`;

  // Output path: object-export/objects/subdir/uuid-file.ext
  const relPath = normalizedKey.replace(/^\//, "");
  const outPath = nodePath.join(OUT_DIR, relPath);

  try {
    const file = await svc.getObjectEntityFile(normalizedKey);
    const [buf] = await file.download();

    await fsPromises.mkdir(nodePath.dirname(outPath), { recursive: true });
    await fsPromises.writeFile(outPath, buf);

    ok++;
    process.stdout.write(`  ✓ [${ok}/${fileKeys.length}] ${fileKey}\n`);
  } catch (err) {
    fail++;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push({ key: fileKey, error: msg });
    process.stderr.write(`  ✗ FAILED  ${fileKey}  —  ${msg}\n`);
  }
}

// ── 3. Summary ────────────────────────────────────────────────────────────────

console.log("\n─────────────────────────────────────────");
console.log(`Downloaded : ${ok} / ${fileKeys.length}`);
console.log(`Failed     : ${fail}`);
if (failures.length > 0) {
  console.log("\nFailed keys:");
  for (const f of failures) {
    console.log(`  ${f.key}  →  ${f.error}`);
  }
}

// ── 4. Manifest ───────────────────────────────────────────────────────────────

const manifest = {
  exportedAt: new Date().toISOString(),
  total: fileKeys.length,
  downloaded: ok,
  failed: fail,
  failures,
};
await fsPromises.mkdir(OUT_DIR, { recursive: true });
await fsPromises.writeFile(
  nodePath.join(OUT_DIR, "manifest.json"),
  JSON.stringify(manifest, null, 2),
);
console.log(`\nManifest written to ${OUT_DIR}/manifest.json`);

// ── 5. Tarball ────────────────────────────────────────────────────────────────

if (ok > 0) {
  const tarPath = nodePath.resolve(process.cwd(), "object-export.tar.gz");
  console.log(`\nCreating ${tarPath} ...`);
  execSync(
    `tar -czf "${tarPath}" -C "${nodePath.dirname(OUT_DIR)}" "${nodePath.basename(OUT_DIR)}"`,
    { stdio: "inherit" },
  );
  const stat = await fsPromises.stat(tarPath);
  const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
  console.log(`Tarball created: ${tarPath} (${sizeMB} MB)`);
}

if (fail > 0) {
  process.exit(1);
}
