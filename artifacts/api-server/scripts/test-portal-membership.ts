/**
 * test-portal-membership.ts — Phase 3 multi-portal membership regression tests
 *
 * PM1:  resolveAdapterKey — no junction → own adapter (routedVia/memberUniversityId
 *       null), legacy NULL path byte-for-byte.
 * PM2:  GET /catalog-universities — searchable catalog list (NOT capped at 100).
 * PM3:  PUT /accounts/:key/members — sets the junction for the given catalog ids.
 * PM4:  GET /accounts/:key/members — lists the account's members.
 * PM5:  resolveAdapterKey — junction member → company adapter + routedVia + the
 *       member catalog id (so the runner can load member-level overrides).
 * PM6:  loadProgramMapping — member-scoped row wins for (company, memberId); the
 *       1:1 row (member NULL) is isolated (Topkapı 1:1 must NOT regress).
 * PM7:  PUT with a reduced list removes dropped members from the junction.
 * PM8:  Cross-account conflict → 409 ALREADY_ASSIGNED; force=true moves it.
 * PM9:  PUT on a non-multi-portal key → 400 NOT_MULTI_PORTAL.
 * PM10: PUT with an unknown catalog id → 404 MEMBER_NOT_FOUND.
 * PM11: RBAC — non-admin role → 403.
 * PM12: routes_via → junction boot migration (idempotent).
 *
 * Run:
 *   pnpm --filter @workspace/api-server test:portal-membership
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express } from "express";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  universitiesTable,
  portalUniversitiesTable,
  portalAccountUniversitiesTable,
  portalProgramMappingTable,
} from "@workspace/db";
import { resolveAdapterKey, loadProgramMapping } from "@workspace/portal-runner";
import portalAutomationRouter from "../src/routes/portalAutomation.js";

// ---------------------------------------------------------------------------
// Run-specific keys (avoid collisions across parallel/leaked runs)
// ---------------------------------------------------------------------------
const RUN = `pm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
const COMPANY = `${RUN}_company`;
const OTHER = `${RUN}_other`;
const MEMBER_A_KEY = `${RUN}_member_a`;
const MEMBER_B_KEY = `${RUN}_member_b`;
const MIGRATE_KEY = `${RUN}_migrate`;
const ROUTES_VIA_KEY = `${RUN}_routesvia`;
const PLAIN = `${RUN}_plain`;
const COMPANY_ADAPTER = `${RUN}_company_adapter`;
const OTHER_ADAPTER = `${RUN}_other_adapter`;
const OWN_A_ADAPTER = `${RUN}_own_a_adapter`;

const ALL_PORTAL_KEYS = [COMPANY, OTHER, MEMBER_A_KEY, MEMBER_B_KEY, MIGRATE_KEY, ROUTES_VIA_KEY, PLAIN];
const ALL_JUNCTION_KEYS = [COMPANY, OTHER, MIGRATE_KEY];

let catA = 0;
let catB = 0;
let catC = 0;
let companyId = 0;

// ---------------------------------------------------------------------------
// Auth stubs
// ---------------------------------------------------------------------------
const ADMIN_USER = { id: 1, role: "super_admin", isActive: true, emailVerified: true };
const STUDENT_USER = { id: 2, role: "student", isActive: true, emailVerified: true };

function buildApp(user: Record<string, unknown>): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { ...user };
    if (!("cookies" in req)) (req as any).cookies = {};
    next();
  });
  app.use("/api", portalAutomationRouter);
  return app;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
function sendReq(
  server: http.Server,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const json = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(json !== undefined ? { "Content-Length": Buffer.byteLength(json) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let parsed: unknown = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (json !== undefined) req.write(json);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Seed / teardown
// ---------------------------------------------------------------------------
before(async () => {
  const cats = await db
    .insert(universitiesTable)
    .values([
      { name: `Cat A ${RUN}`, country: `Country ${RUN}` },
      { name: `Cat B ${RUN}`, country: `Country ${RUN}` },
      { name: `Cat C ${RUN}`, country: `Country ${RUN}` },
    ])
    .returning({ id: universitiesTable.id });
  catA = cats[0]!.id;
  catB = cats[1]!.id;
  catC = cats[2]!.id;

  await db.insert(portalUniversitiesTable).values([
    { universityKey: COMPANY, universityName: `Company ${RUN}`, adapterKey: COMPANY_ADAPTER, isMultiPortal: true },
    { universityKey: OTHER, universityName: `Other ${RUN}`, adapterKey: OTHER_ADAPTER, isMultiPortal: true },
    { universityKey: MEMBER_A_KEY, universityName: `Member A ${RUN}`, adapterKey: OWN_A_ADAPTER, crmUniversityId: catA },
    { universityKey: MEMBER_B_KEY, universityName: `Member B ${RUN}`, adapterKey: `${RUN}_own_b_adapter`, crmUniversityId: catB },
    // MIGRATE member: Phase 2 routes_via set + a catalog id, used by PM12.
    { universityKey: MIGRATE_KEY, universityName: `Migrate ${RUN}`, adapterKey: `${RUN}_migrate_adapter`, routesVia: COMPANY, crmUniversityId: catC },
    // ROUTES_VIA member: Phase 2 routes_via with NO catalog id → can never enter
    // the junction, so it locks the pure routes_via fallback path (PM14).
    { universityKey: ROUTES_VIA_KEY, universityName: `RoutesVia ${RUN}`, adapterKey: `${RUN}_routesvia_adapter`, routesVia: COMPANY, crmUniversityId: null },
    { universityKey: PLAIN, universityName: `Plain ${RUN}`, adapterKey: `${RUN}_plain_adapter`, isMultiPortal: false },
  ]);

  const [c] = await db
    .select({ id: portalUniversitiesTable.id })
    .from(portalUniversitiesTable)
    .where(eq(portalUniversitiesTable.universityKey, COMPANY))
    .limit(1);
  companyId = c!.id;

  // Program mapping rows for PM6: a member-scoped override for (COMPANY, catA)
  // and an isolated 1:1 row for the member's own key (member NULL).
  await db.insert(portalProgramMappingTable).values([
    { universityKey: COMPANY, memberUniversityId: catA, programOverrides: { "101": "company-value" } },
    { universityKey: MEMBER_A_KEY, memberUniversityId: null, programOverrides: { "101": "own-1to1-value" } },
  ]);
});

after(async () => {
  await db.delete(portalAccountUniversitiesTable)
    .where(inArray(portalAccountUniversitiesTable.portalKey, ALL_JUNCTION_KEYS)).catch(() => {});
  await db.delete(portalProgramMappingTable)
    .where(inArray(portalProgramMappingTable.universityKey, [COMPANY, MEMBER_A_KEY])).catch(() => {});
  await db.delete(portalUniversitiesTable)
    .where(inArray(portalUniversitiesTable.universityKey, ALL_PORTAL_KEYS)).catch(() => {});
  await db.delete(universitiesTable)
    .where(inArray(universitiesTable.id, [catA, catB, catC].filter((x) => x > 0))).catch(() => {});
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

async function memberCatalogIds(portalKey: string): Promise<number[]> {
  const rows = await db
    .select({ id: portalAccountUniversitiesTable.catalogUniversityId })
    .from(portalAccountUniversitiesTable)
    .where(eq(portalAccountUniversitiesTable.portalKey, portalKey));
  return rows.map((r) => r.id).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test("PM1: resolveAdapterKey with no junction → own adapter, nulls", async () => {
  const r = await resolveAdapterKey(MEMBER_A_KEY);
  assert.equal(r.adapterKey, OWN_A_ADAPTER);
  assert.equal(r.routedVia, null);
  assert.equal(r.memberUniversityId, null);
});

test("PM2: GET /catalog-universities returns matching catalog rows", async () => {
  const app = buildApp(ADMIN_USER);
  const server = app.listen(0);
  try {
    const res = await sendReq(
      server,
      "GET",
      `/api/portal-automation/catalog-universities?q=${encodeURIComponent(RUN)}&pageSize=50`,
    );
    assert.equal(res.status, 200);
    const ids = (res.body.data as Array<{ id: number }>).map((d) => d.id);
    for (const id of [catA, catB, catC]) assert.ok(ids.includes(id), `catalog ${id} listed`);
    assert.ok(res.body.meta.total >= 3);
  } finally {
    server.close();
  }
});

test("PM3: PUT members sets the junction for catalog ids", async () => {
  const app = buildApp(ADMIN_USER);
  const server = app.listen(0);
  try {
    const res = await sendReq(
      server,
      "PUT",
      `/api/portal-automation/accounts/${COMPANY}/members`,
      { catalogUniversityIds: [catA, catB] },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.portalKey, COMPANY);
    assert.equal(res.body.members.length, 2);
    assert.deepEqual(await memberCatalogIds(COMPANY), [catA, catB].sort((a, b) => a - b));
  } finally {
    server.close();
  }
});

test("PM4: GET members lists the account's members", async () => {
  const app = buildApp(ADMIN_USER);
  const server = app.listen(0);
  try {
    const res = await sendReq(server, "GET", `/api/portal-automation/accounts/${COMPANY}/members`);
    assert.equal(res.status, 200);
    const ids = (res.body.members as Array<{ catalogUniversityId: number }>)
      .map((m) => m.catalogUniversityId).sort((a, b) => a - b);
    assert.deepEqual(ids, [catA, catB].sort((a, b) => a - b));
  } finally {
    server.close();
  }
});

test("PM5: resolveAdapterKey junction member → company adapter + member id", async () => {
  const r = await resolveAdapterKey(MEMBER_A_KEY);
  assert.equal(r.adapterKey, COMPANY_ADAPTER);
  assert.equal(r.routedVia, COMPANY);
  assert.equal(r.memberUniversityId, catA);
});

test("PM6: loadProgramMapping member row wins; 1:1 row isolated", async () => {
  const member = await loadProgramMapping(COMPANY, catA);
  assert.equal(member.programIdOverrides?.["101"], "company-value");

  // The company's 1:1 slot may contain unrelated live mappings, but must not
  // leak the member-specific test key.
  const company1to1 = await loadProgramMapping(COMPANY, null);
  assert.equal(company1to1.programIdOverrides?.["101"], undefined);

  // Topkapı-style 1:1 university keeps its own row, untouched by membership.
  const own = await loadProgramMapping(MEMBER_A_KEY, null);
  assert.equal(own.programIdOverrides?.["101"], "own-1to1-value");
});

test("PM7: reduced member list removes dropped members from junction", async () => {
  const app = buildApp(ADMIN_USER);
  const server = app.listen(0);
  try {
    const res = await sendReq(
      server,
      "PUT",
      `/api/portal-automation/accounts/${COMPANY}/members`,
      { catalogUniversityIds: [catA] },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await memberCatalogIds(COMPANY), [catA]);
  } finally {
    server.close();
  }
});

test("PM8: cross-account conflict → 409; force=true moves it", async () => {
  const app = buildApp(ADMIN_USER);
  const server = app.listen(0);
  try {
    // catA is owned by COMPANY (from PM7). Assigning to OTHER without force → 409.
    const conflict = await sendReq(
      server,
      "PUT",
      `/api/portal-automation/accounts/${OTHER}/members`,
      { catalogUniversityIds: [catA] },
    );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, "ALREADY_ASSIGNED");
    assert.deepEqual(await memberCatalogIds(COMPANY), [catA]);
    assert.deepEqual(await memberCatalogIds(OTHER), []);

    // With force=true the membership moves to OTHER (UNIQUE(catalog id) holds).
    const moved = await sendReq(
      server,
      "PUT",
      `/api/portal-automation/accounts/${OTHER}/members`,
      { catalogUniversityIds: [catA], force: true },
    );
    assert.equal(moved.status, 200);
    assert.deepEqual(await memberCatalogIds(OTHER), [catA]);
    assert.deepEqual(await memberCatalogIds(COMPANY), []);
  } finally {
    server.close();
  }
});

test("PM9: PUT on a non-multi-portal key → 400 NOT_MULTI_PORTAL", async () => {
  const app = buildApp(ADMIN_USER);
  const server = app.listen(0);
  try {
    const res = await sendReq(
      server,
      "PUT",
      `/api/portal-automation/accounts/${PLAIN}/members`,
      { catalogUniversityIds: [catB] },
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "NOT_MULTI_PORTAL");
  } finally {
    server.close();
  }
});

test("PM10: PUT with an unknown catalog id → 404 MEMBER_NOT_FOUND", async () => {
  const app = buildApp(ADMIN_USER);
  const server = app.listen(0);
  try {
    const res = await sendReq(
      server,
      "PUT",
      `/api/portal-automation/accounts/${COMPANY}/members`,
      { catalogUniversityIds: [2_000_000_000] },
    );
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "MEMBER_NOT_FOUND");
  } finally {
    server.close();
  }
});

test("PM11: non-admin role → 403", async () => {
  const app = buildApp(STUDENT_USER);
  const server = app.listen(0);
  try {
    const res = await sendReq(
      server,
      "PUT",
      `/api/portal-automation/accounts/${COMPANY}/members`,
      { catalogUniversityIds: [catB] },
    );
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test("PM12: routes_via → junction boot migration is idempotent", async () => {
  // Mirrors api-server boot DDL Step 2b2b3: routed members with a catalog id are
  // expressed in the catalog-keyed junction. MIGRATE_KEY has routesVia=COMPANY +
  // crmUniversityId=catC; catC is not yet a member of anyone.
  const migrateSql = `
    INSERT INTO portal_account_universities (portal_key, catalog_university_id, enabled)
    SELECT routes_via, crm_university_id, true
      FROM portal_universities
     WHERE routes_via IS NOT NULL
       AND crm_university_id IS NOT NULL
       AND deleted_at IS NULL
       AND university_key = $1
    ON CONFLICT (catalog_university_id) DO NOTHING
  `;
  await pool.query(migrateSql, [MIGRATE_KEY]);
  await pool.query(migrateSql, [MIGRATE_KEY]); // idempotent — second run is a no-op.

  const rows = await db
    .select({ portalKey: portalAccountUniversitiesTable.portalKey })
    .from(portalAccountUniversitiesTable)
    .where(eq(portalAccountUniversitiesTable.catalogUniversityId, catC));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.portalKey, COMPANY);
});

test("PM13: disabled junction row is ignored (no reroute, no member id)", async () => {
  // A membership exists but is suspended (enabled=false): the resolver must NOT
  // route through it and must behave exactly like the legacy own-adapter path.
  await db.insert(portalAccountUniversitiesTable).values({
    portalKey: OTHER,
    catalogUniversityId: catB,
    enabled: false,
  });
  try {
    const r = await resolveAdapterKey(MEMBER_B_KEY);
    assert.equal(r.adapterKey, `${RUN}_own_b_adapter`);
    assert.equal(r.routedVia, null);
    assert.equal(r.memberUniversityId, null);
  } finally {
    await db
      .delete(portalAccountUniversitiesTable)
      .where(eq(portalAccountUniversitiesTable.catalogUniversityId, catB))
      .catch(() => {});
  }
});

test("PM14: pure routes_via fallback keeps memberUniversityId null (Phase 2)", async () => {
  // ROUTES_VIA_KEY has routes_via=COMPANY but no catalog id, so it can never
  // match the junction — it must use the Phase 2 routes_via path: company
  // adapter + routedVia, with memberUniversityId left null (no member overrides).
  const r = await resolveAdapterKey(ROUTES_VIA_KEY);
  assert.equal(r.adapterKey, COMPANY_ADAPTER);
  assert.equal(r.routedVia, COMPANY);
  assert.equal(r.memberUniversityId, null);
});
