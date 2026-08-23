/**
 * Portal Program Mapping — bulk Excel template + import (FAZ 2).
 *
 * E1  GET program-template.xlsx (admin) → 200, an .xlsx workbook whose
 *     ProgramMapping sheet ships every CRM program row + the right headers.
 * E2  POST program-import — happy path: a valid portal_value is UPSERTED into
 *     program_overrides (merge, existing keys preserved).
 * E3  POST program-import — empty portal_value rows are SKIPPED, not written.
 * E4  POST program-import — invalid portal_value / missing crm id are reported
 *     as errors and NOT written.
 * E5  RBAC — non-admin role (staff) → 403 on template and import.
 * E6  POST program-import — corrupt / non-xlsx body → 400.
 * E7  POST program-import — empty live-option cache → 400 NO_LIVE_OPTIONS.
 *
 * The validator accepts a portal_value that matches a live option's `v`
 * (exact) OR its folded label `t`; live options come from portal_program_cache
 * (no headless fetch in the request path).
 *
 * Run:
 *   pnpm --filter @workspace/api-server run test:portal-mapping-excel
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  portalUniversitiesTable,
  portalProgramMappingTable,
  portalProgramCacheTable,
  universitiesTable,
  programsTable,
} from "@workspace/db";
import portalAutomationRouter from "../src/routes/portalAutomation.js";
import {
  buildWorkbookBuffer,
  parseWorkbookBuffer,
  PROGRAM_MAPPING_KIND,
  PROGRAM_MAPPING_SHEET,
  programMappingColumns,
} from "../src/lib/exportImportExcel.js";

const XLSX_CT =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// ---------------------------------------------------------------------------
// Cleanup registry
// ---------------------------------------------------------------------------
const RUN_ID = `pme_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const TEST_UNI_KEY = `test_uni_${RUN_ID}`;
const TEST_UNI_NAME = `Test University ${RUN_ID}`;
const cleanupPortalUniIds: number[] = [];
const cleanupCrmUniIds: number[] = [];
const cleanupProgramIds: number[] = [];

after(async () => {
  await db
    .delete(portalProgramMappingTable)
    .where(eq(portalProgramMappingTable.universityKey, TEST_UNI_KEY))
    .catch(() => {});
  await db
    .delete(portalProgramCacheTable)
    .where(eq(portalProgramCacheTable.universityKey, TEST_UNI_KEY))
    .catch(() => {});
  for (const id of cleanupProgramIds) {
    await db.delete(programsTable).where(eq(programsTable.id, id)).catch(() => {});
  }
  for (const id of cleanupPortalUniIds) {
    await db.delete(portalUniversitiesTable).where(eq(portalUniversitiesTable.id, id)).catch(() => {});
  }
  for (const id of cleanupCrmUniIds) {
    await db.delete(universitiesTable).where(eq(universitiesTable.id, id)).catch(() => {});
  }
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

// ---------------------------------------------------------------------------
// Auth stub
// ---------------------------------------------------------------------------
let currentUser: { id: number; role: string; isActive: boolean; emailVerified?: boolean } = {
  id: 1,
  role: "super_admin",
  isActive: true,
  emailVerified: true,
};

function buildApp(): Express {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = { ...currentUser };
    if (!("cookies" in req)) (req as any).cookies = {};
    next();
  });
  app.use("/api", portalAutomationRouter);
  return app;
}

function listen(app: Express): Promise<http.Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
}

// ---------------------------------------------------------------------------
// HTTP helpers (JSON + raw binary body)
// ---------------------------------------------------------------------------
function sendReq(
  server: http.Server,
  method: "GET" | "POST",
  path: string,
  opts: { body?: Buffer; contentType?: string } = {},
): Promise<{ status: number; body: any; raw: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) {
      headers["Content-Type"] = opts.contentType ?? XLSX_CT;
      headers["Content-Length"] = String(opts.body.length);
    }
    const req = http.request(
      { hostname: "127.0.0.1", port: addr.port, path, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          const ct = String(res.headers["content-type"] ?? "");
          let body: any = raw;
          if (ct.includes("application/json")) {
            try { body = JSON.parse(raw.toString("utf8")); } catch { body = raw.toString("utf8"); }
          }
          resolve({ status: res.statusCode ?? 0, body, raw, contentType: ct });
        });
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Seed: a CRM university + programs, a matching portal university, and a
// live-option cache row.
// ---------------------------------------------------------------------------
const SEEDED_OPTIONS = [
  { v: "166", t: "Computer Engineering" },
  { v: "111", t: "İşletme" }, // Turkish-folded match target
  { v: "100", t: "Medicine" },
];

let crmProgA = 0; // → will map to "166"
let crmProgB = 0; // → will map via folded "İşletme"

async function seedAll(): Promise<void> {
  const [crmUni] = await db
    .insert(universitiesTable)
    .values({ name: TEST_UNI_NAME, country: "Turkey" })
    .returning({ id: universitiesTable.id });
  cleanupCrmUniIds.push(crmUni.id);

  const [pA] = await db
    .insert(programsTable)
    .values({ universityId: crmUni.id, name: "Computer Engineering" })
    .returning({ id: programsTable.id });
  const [pB] = await db
    .insert(programsTable)
    .values({ universityId: crmUni.id, name: "Business Administration" })
    .returning({ id: programsTable.id });
  crmProgA = pA.id;
  crmProgB = pB.id;
  cleanupProgramIds.push(pA.id, pB.id);

  const [pu] = await db
    .insert(portalUniversitiesTable)
    .values({
      universityKey: TEST_UNI_KEY,
      universityName: TEST_UNI_NAME,
      adapterKey: "topkapi",
      crmUniversityId: crmUni.id,
      isActive: true,
    })
    .returning({ id: portalUniversitiesTable.id });
  cleanupPortalUniIds.push(pu.id);
}

async function seedCache(): Promise<void> {
  await db
    .insert(portalProgramCacheTable)
    .values({ universityKey: TEST_UNI_KEY, level: "", options: SEEDED_OPTIONS, fetchedAt: new Date() })
    .onConflictDoUpdate({
      target: [portalProgramCacheTable.universityKey, portalProgramCacheTable.level],
      set: { options: SEEDED_OPTIONS, fetchedAt: new Date() },
    });
}

/** Build an upload workbook with the given ProgramMapping rows. */
async function buildUpload(rows: Array<Record<string, unknown>>): Promise<Buffer> {
  return buildWorkbookBuffer({
    sheets: [{ name: PROGRAM_MAPPING_SHEET, columns: programMappingColumns, rows }],
    meta: { kind: PROGRAM_MAPPING_KIND, version: "1", exportedAt: new Date().toISOString() },
  });
}

const adminUser = () => ({ id: 1, role: "super_admin", isActive: true, emailVerified: true });

// ---------------------------------------------------------------------------
// E1 — template download
// ---------------------------------------------------------------------------
test("E1: GET program-template.xlsx ships CRM program rows + correct headers", async () => {
  await seedAll();
  await seedCache();
  currentUser = adminUser();
  const server = await listen(buildApp());
  try {
    const res = await sendReq(
      server,
      "GET",
      `/api/portal-automation/universities/${TEST_UNI_KEY}/program-template.xlsx`,
    );
    assert.equal(res.status, 200, `Expected 200 got ${res.status}: ${res.raw.toString("utf8").slice(0, 200)}`);
    assert.ok(res.contentType.includes("spreadsheetml"), `content-type was ${res.contentType}`);

    const parsed = await parseWorkbookBuffer(
      res.raw,
      { expectedKind: PROGRAM_MAPPING_KIND },
      { [PROGRAM_MAPPING_SHEET]: programMappingColumns },
    );
    const sheet = parsed.sheets.get(PROGRAM_MAPPING_SHEET);
    assert.ok(sheet, "ProgramMapping sheet must exist");
    const ids = sheet!.rows.map((r) => String(r.crm_program_id)).sort();
    assert.deepEqual(ids, [String(crmProgA), String(crmProgB)].sort(), "one row per CRM program");
    // portal_value column must ship empty for the admin to fill.
    for (const r of sheet!.rows) assert.equal(String(r.portal_value ?? ""), "");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// E2 — happy-path upsert (exact value + folded label), preserves existing keys
// ---------------------------------------------------------------------------
test("E2: import upserts valid rows and preserves existing overrides", async () => {
  currentUser = adminUser();
  // Pre-existing override that must survive the merge.
  await db
    .insert(portalProgramMappingTable)
    .values({ universityKey: TEST_UNI_KEY, programOverrides: { "999": "100" } })
    .onConflictDoUpdate({
      target: portalProgramMappingTable.universityKey,
      set: { programOverrides: { "999": "100" } },
    });

  const buf = await buildUpload([
    { crm_program_id: String(crmProgA), portal_value: "166" }, // exact v match
    { crm_program_id: String(crmProgB), portal_value: "isletme" }, // folded t match (İşletme)
  ]);
  const server = await listen(buildApp());
  try {
    const res = await sendReq(
      server,
      "POST",
      `/api/portal-automation/universities/${TEST_UNI_KEY}/program-import`,
      { body: buf },
    );
    assert.equal(res.status, 200, `Expected 200 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.applied, 2);
    assert.equal(res.body.skipped, 0);
    assert.deepEqual(res.body.errors, []);

    const [row] = await db
      .select()
      .from(portalProgramMappingTable)
      .where(eq(portalProgramMappingTable.universityKey, TEST_UNI_KEY))
      .limit(1);
    assert.equal(row.programOverrides[String(crmProgA)], "166");
    assert.equal(
      row.programOverrides[String(crmProgB)],
      "111",
      "folded label is canonicalized to the option value (İşletme → 111), not stored verbatim",
    );
    assert.equal(row.programOverrides["999"], "100", "existing override preserved (merge, no delete)");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// E3 — empty portal_value rows are skipped
// ---------------------------------------------------------------------------
test("E3: empty portal_value rows are skipped, not written", async () => {
  currentUser = adminUser();
  const buf = await buildUpload([
    { crm_program_id: String(crmProgA), portal_value: "" },
    { crm_program_id: String(crmProgB), portal_value: "   " },
  ]);
  const server = await listen(buildApp());
  try {
    const res = await sendReq(
      server,
      "POST",
      `/api/portal-automation/universities/${TEST_UNI_KEY}/program-import`,
      { body: buf },
    );
    assert.equal(res.status, 200, `Expected 200 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.applied, 0);
    assert.equal(res.body.skipped, 2);
    assert.deepEqual(res.body.errors, []);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// E4 — invalid portal_value + missing crm id are reported as errors
// ---------------------------------------------------------------------------
test("E4: invalid value and missing crm id are reported, not written", async () => {
  currentUser = adminUser();
  const buf = await buildUpload([
    { crm_program_id: String(crmProgA), portal_value: "not-a-real-option" },
    { crm_program_id: "", portal_value: "166" },
  ]);
  const server = await listen(buildApp());
  try {
    const res = await sendReq(
      server,
      "POST",
      `/api/portal-automation/universities/${TEST_UNI_KEY}/program-import`,
      { body: buf },
    );
    assert.equal(res.status, 200, `Expected 200 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.applied, 0);
    assert.equal(res.body.skipped, 0);
    assert.equal(res.body.errors.length, 2);
    const reasons = res.body.errors.map((e: { reason: string }) => e.reason).sort();
    assert.deepEqual(reasons, ["INVALID_PORTAL_VALUE", "MISSING_CRM_ID"]);
    // Row numbers are 1-based incl. header.
    assert.ok(res.body.errors.every((e: { row: number }) => e.row >= 2));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// E5 — RBAC: non-admin forbidden on template and import
// ---------------------------------------------------------------------------
test("E5: non-admin role is forbidden on template and import", async () => {
  currentUser = { id: 2, role: "staff", isActive: true, emailVerified: true };
  const server = await listen(buildApp());
  try {
    const tpl = await sendReq(
      server,
      "GET",
      `/api/portal-automation/universities/${TEST_UNI_KEY}/program-template.xlsx`,
    );
    assert.equal(tpl.status, 403, `Expected 403 got ${tpl.status}`);

    const buf = await buildUpload([{ crm_program_id: String(crmProgA), portal_value: "166" }]);
    const imp = await sendReq(
      server,
      "POST",
      `/api/portal-automation/universities/${TEST_UNI_KEY}/program-import`,
      { body: buf },
    );
    assert.equal(imp.status, 403, `Expected 403 got ${imp.status}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// E6 — corrupt / non-xlsx body → 400
// ---------------------------------------------------------------------------
test("E6: corrupt body returns 400", async () => {
  currentUser = adminUser();
  const server = await listen(buildApp());
  try {
    const res = await sendReq(
      server,
      "POST",
      `/api/portal-automation/universities/${TEST_UNI_KEY}/program-import`,
      { body: Buffer.from("this is not an xlsx file"), contentType: XLSX_CT },
    );
    assert.equal(res.status, 400, `Expected 400 got ${res.status}: ${JSON.stringify(res.body)}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// E7 — empty live-option cache → 400 NO_LIVE_OPTIONS
// ---------------------------------------------------------------------------
test("E7: empty live-option cache returns 400 NO_LIVE_OPTIONS", async () => {
  currentUser = adminUser();
  // Drop the cache to simulate a university with no cached options.
  await db
    .delete(portalProgramCacheTable)
    .where(eq(portalProgramCacheTable.universityKey, TEST_UNI_KEY));
  const buf = await buildUpload([{ crm_program_id: String(crmProgA), portal_value: "166" }]);
  const server = await listen(buildApp());
  try {
    const res = await sendReq(
      server,
      "POST",
      `/api/portal-automation/universities/${TEST_UNI_KEY}/program-import`,
      { body: buf },
    );
    assert.equal(res.status, 400, `Expected 400 got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "NO_LIVE_OPTIONS");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
