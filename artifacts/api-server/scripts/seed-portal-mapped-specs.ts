/**
 * Idempotently uploads the six live-mapped Adapter Spec v2 artifacts as
 * DISABLED versions. It never enables, approves or rolls back a spec.
 *
 * Production:
 *   pnpm --filter @workspace/api-server seed:portal-mapped-specs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { desc, eq, sql } from "drizzle-orm";
import { db, pool, portalAdapterSpecsTable } from "@workspace/db";
import { parseAdapterSpec } from "@workspace/portal-adapters";
import { canonicalJson } from "../src/lib/jsonCanonical.js";

const specDir = fileURLToPath(
  new URL("../../../docs/portal-specs/", import.meta.url),
);
const expectedKeys = new Set([
  "united",
  "multico",
  "uskudar",
  "okan",
  "beykent",
  "isik",
]);

async function main(): Promise<void> {
  const files = (await fs.readdir(specDir))
    .filter((file) => file.endsWith(".v2.json"))
    .sort();
  const seen = new Set<string>();

  for (const file of files) {
    const raw = JSON.parse(
      await fs.readFile(path.join(specDir, file), "utf8"),
    );
    const parsed = parseAdapterSpec(raw);
    if (!parsed.ok) {
      throw new Error(`${file}: ${parsed.error}`);
    }
    const spec = parsed.spec;
    if (!expectedKeys.has(spec.meta.key)) continue;
    seen.add(spec.meta.key);
    if (
      spec.specVersion !== 2 ||
      spec.meta.dryRunPolicy !== "strict" ||
      spec.meta.resolution !== "fallback"
    ) {
      throw new Error(
        `${file}: production seed accepts only strict fallback v2 specs`,
      );
    }

    const outcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`portal_adapter_spec:${spec.meta.key}`}))`,
      );
      const [latest] = await tx
        .select()
        .from(portalAdapterSpecsTable)
        .where(eq(portalAdapterSpecsTable.key, spec.meta.key))
        .orderBy(desc(portalAdapterSpecsTable.version))
        .limit(1);
      if (
        latest &&
        canonicalJson(latest.spec) === canonicalJson(spec)
      ) {
        return {
          status: "unchanged" as const,
          version: latest.version,
        };
      }
      const version = (latest?.version ?? 0) + 1;
      await tx.insert(portalAdapterSpecsTable).values({
        key: spec.meta.key,
        name: spec.meta.name,
        spec,
        version,
        enabled: false,
        source: "uploaded",
        jsHookApproved: false,
        privilegedApproved: false,
        createdBy: null,
      });
      return { status: "inserted" as const, version };
    });
    console.log(
      `[portal-spec-seed] ${spec.meta.key}: ${outcome.status} v${outcome.version} enabled=false`,
    );
  }

  const missing = [...expectedKeys].filter((key) => !seen.has(key));
  if (missing.length > 0) {
    throw new Error(`Missing mapped specs: ${missing.join(", ")}`);
  }
}

main()
  .catch((error) => {
    console.error("[portal-spec-seed]", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
