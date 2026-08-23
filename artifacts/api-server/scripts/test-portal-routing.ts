/**
 * test-portal-routing.ts — Multi-portal routing sprint regression tests
 *
 * MPR1: resolveAdapterKey — NULL routes_via path returns own adapter (legacy
 *       behaviour byte-for-byte, routedVia=null).
 * MPR2: PUT /multi-portals/:key/members sets routes_via on selected members.
 * MPR3: resolveAdapterKey — routed member returns the COMPANY's adapter +
 *       routedVia=company.
 * MPR4: Assigning members does NOT enable auto_process (exclusion preserved).
 * MPR5: GET /multi-portals lists the company with its members.
 * MPR6: PUT with a reduced list clears routes_via on dropped members.
 * MPR7: Double-assign block — assigning a member already routed elsewhere → 409.
 * MPR8: PUT on a non-multi-portal key → 400 NOT_MULTI_PORTAL.
 * MPR9: PUT with an unknown member key → 404 MEMBER_NOT_FOUND.
 * MPR10: RBAC — non-admin role → 403.
 * MPR11: Disabling is_multi_portal (PATCH /portal-universities/:id) cascade-
 *        clears its members' routes_via.
 *
 * Run:
 *   pnpm --filter @workspace/api-server test:portal-routing
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express } from "express";
import { eq, inArray } from "drizzle-orm";
import { db, portalUniversitiesTable } from "@workspace/db";
import { resolveAdapterKey } from "@workspace/portal-runner";
import portalAutomationRouter from "../src/routes/portalAutomation.js";
import portalMgmtRouter from "../src/routes/portalMgmt.js";

// ---------------------------------------------------------------------------
// Run-specific keys (avoid collisions across parallel/leaked runs)
// ---------------------------------------------------------------------------
const RUN = `mpr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
const COMPANY = `${RUN}_company`;
const OTHER = `${RUN}_other`;
const MEMBER_A = `${RUN}_a`;
const MEMBER_B = `${RUN}_b`;
const MEMBER_C = `${RUN}_c`;
const PLAIN = `${RUN}_plain`;
const COMPANY_ADAPTER = `${RUN}_company_adapter`;
const OWN_A_ADAPTER = `${RUN}_own_a_adapter`;

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
  app.use("/api", portalMgmtRouter);
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

const ALL_KEYS = [COMPANY, OTHER, MEMBER_A, MEMBER_B, MEMBER_C, PLAIN];

// ---------------------------------------------------------------------------
// Seed / teardown
// ---------------------------------------------------------------------------
before(async () => {
  await db.insert(portalUniversitiesTable).values([
    { universityKey: COMPANY, universityName: `Company ${RUN}`, adapterKey: COMPANY_ADAPTER, isMultiPortal: true },
    { universityKey: OTHER, universityName: `Other ${RUN}`, adapterKey: `${RUN}_other_adapter`, isMultiPortal: true },
    { universityKey: MEMBER_A, universityName: `Member A ${RUN}`, adapterKey: OWN_A_ADAPTER },
    { universityKey: MEMBER_B, universityName: `Member B ${RUN}`, adapterKey: `${RUN}_own_b_adapter` },
    { universityKey: MEMBER_C, universityName: `Member C ${RUN}`, adapterKey: `${RUN}_own_c_adapter`, routesVia: OTHER },
    { universityKey: PLAIN, universityName: `Plain ${RUN}`, adapterKey: `${RUN}_plain_adapter`, isMultiPortal: false },
  ]);
  const [c] = await db
    .select({ id: portalUniversitiesTable.id })
    .from(portalUniversitiesTable)
    .where(eq(portalUniversitiesTable.universityKey, COMPANY))
    .limit(1);
  companyId = c!.id;
});

after(async () => {
  await db
    .delete(portalUniversitiesTable)
    .where(inArray(portalUniversitiesTable.universityKey, ALL_KEYS))
    .catch(() => {});
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

async function routesViaOf(key: string): Promise<string | null> {
  const [row] = await db
    .select({ routesVia: portalUniversitiesTable.routesVia })
    .from(portalUniversitiesTable)
    .where(eq(portalUniversitiesTable.universityKey, key))
    .limit(1);
  return row?.routesVia ?? null;
}

async function autoProcessOf(key: string): Promise<boolean> {
  const [row] = await db
    .select({ autoProcess: portalUniversitiesTable.autoProcess })
    .from(portalUniversitiesTable)
    .where(eq(portalUniversitiesTable.universityKey, key))
    .limit(1);
  return row?.autoProcess ?? false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test("MPR1: resolveAdapterKey NULL routes_via → own adapter, routedVia=null", async () => {
  const r = await resolveAdapterKey(MEMBER_A);
  assert.equal(r.adapterKey, OWN_A_ADAPTER);
  assert.equal(r.routedVia, null);
});

test("MPR2: PUT members assigns routes_via on selected members", async () => {
  const app = buildApp(ADMIN_USER);
  const server = app.listen(0);
  try {
    const res = await sendReq(
      server,
      "PUT",
      `/api/portal-automation/multi-portals/${COMPANY}/members`,
      { universityKeys: [MEMBER_A, MEMBER_B] },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.portalKey, COMPANY);
    assert.equal(res.body.members.length, 2);
    assert.equal(await routesViaOf(MEMBER_A), COMPANY);
    assert.equal(await routesViaOf(MEMBER_B), COMPANY);
  } finally {
    server.close();
  }
});

test("MPR3: resolveAdapterKey routed member → company adapter + routedVia", async () => {
  const r = await resolveAdapterKey(MEMBER_A);
  assert.equal(r.adapterKey, COMPANY_ADAPTER);
  assert.equal(r.routedVia, COMPANY);
});

test("MPR4: assigning members does NOT enable auto_process", async () => {
  assert.equal(await autoProcessOf(MEMBER_A), false);
  assert.equal(await autoProcessOf(MEMBER_B), false);
  assert.equal(await autoProcessOf(COMPANY), false);
});

test("MPR5: GET /multi-portals lists company with members", async () => {
  const app = buildApp(ADMIN_USER);
  const server = app.listen(0);
  try {
    const res = await sendReq(server, "GET", "/api/portal-automation/multi-portals");
    assert.equal(res.status, 200);
    const entry = res.body.data.find((d: any) => d.universityKey === COMPANY);
    assert.ok(entry, "company should be listed");
    const memberKeys = entry.members.map((m: any) => m.universityKey).sort();
    assert.deepEqual(memberKeys, [MEMBER_A, MEMBER_B].sort());
  } finally {
    server.close();
  }
});

test("MPR6: reduced member list clears routes_via on dropped members", async () => {
  const app = buildApp(ADMIN_USER);
  const server = app.listen(0);
  try {
    const res = await sendReq(
      server,
      "PUT",
      `/api/portal-automation/multi-portals/${COMPANY}/members`,
      { universityKeys: [MEMBER_A] },
    );
    assert.equal(res.status, 200);
    assert.equal(await routesViaOf(MEMBER_A), COMPANY);
    assert.equal(await routesViaOf(MEMBER_B), null);
  } finally {
    server.close();
  }
});

test("MPR7: double-assign block → 409, original routing untouched", async () => {
  const app = buildApp(ADMIN_USER);
  const server = app.listen(0);
  try {
    const res = await sendReq(
      server,
      "PUT",
      `/api/portal-automation/multi-portals/${COMPANY}/members`,
      { universityKeys: [MEMBER_A, MEMBER_C] },
    );
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "ALREADY_ASSIGNED");
    // C still routed to OTHER, A unchanged
    assert.equal(await routesViaOf(MEMBER_C), OTHER);
    assert.equal(await routesViaOf(MEMBER_A), COMPANY);
  } finally {
    server.close();
  }
});

test("MPR8: PUT on non-multi-portal key → 400", async () => {
  const app = buildApp(ADMIN_USER);
  const server = app.listen(0);
  try {
    const res = await sendReq(
      server,
      "PUT",
      `/api/portal-automation/multi-portals/${PLAIN}/members`,
      { universityKeys: [MEMBER_B] },
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "NOT_MULTI_PORTAL");
  } finally {
    server.close();
  }
});

test("MPR9: PUT with unknown member key → 404", async () => {
  const app = buildApp(ADMIN_USER);
  const server = app.listen(0);
  try {
    const res = await sendReq(
      server,
      "PUT",
      `/api/portal-automation/multi-portals/${COMPANY}/members`,
      { universityKeys: [`${RUN}_does_not_exist`] },
    );
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "MEMBER_NOT_FOUND");
  } finally {
    server.close();
  }
});

test("MPR10: non-admin role → 403", async () => {
  const app = buildApp(STUDENT_USER);
  const server = app.listen(0);
  try {
    const res = await sendReq(
      server,
      "PUT",
      `/api/portal-automation/multi-portals/${COMPANY}/members`,
      { universityKeys: [MEMBER_A] },
    );
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test("MPR11b: renaming the company key propagates to members' routes_via", async () => {
  const app = buildApp(ADMIN_USER);
  const server = app.listen(0);
  const NEW_COMPANY = `${COMPANY}_renamed`;
  try {
    // Re-assign A to COMPANY so there's a member to propagate.
    const assign = await sendReq(
      server,
      "PUT",
      `/api/portal-automation/multi-portals/${COMPANY}/members`,
      { universityKeys: [MEMBER_A] },
    );
    assert.equal(assign.status, 200);
    assert.equal(await routesViaOf(MEMBER_A), COMPANY);

    const res = await sendReq(
      server,
      "PATCH",
      `/api/portal-universities/${companyId}`,
      { universityKey: NEW_COMPANY },
    );
    assert.equal(res.status, 200);
    // Member now points at the new key, not the orphaned old one.
    assert.equal(await routesViaOf(MEMBER_A), NEW_COMPANY);
    // resolveAdapterKey still routes to the company's adapter (no orphan).
    const r = await resolveAdapterKey(MEMBER_A);
    assert.equal(r.adapterKey, COMPANY_ADAPTER);
    assert.equal(r.routedVia, NEW_COMPANY);

    // Rename back so the disable-cascade test below operates on COMPANY.
    const back = await sendReq(
      server,
      "PATCH",
      `/api/portal-universities/${companyId}`,
      { universityKey: COMPANY },
    );
    assert.equal(back.status, 200);
    assert.equal(await routesViaOf(MEMBER_A), COMPANY);
  } finally {
    server.close();
  }
});

test("MPR11: disabling is_multi_portal cascade-clears members' routes_via", async () => {
  const app = buildApp(ADMIN_USER);
  const server = app.listen(0);
  try {
    // A is currently routed to COMPANY (from MPR6).
    assert.equal(await routesViaOf(MEMBER_A), COMPANY);
    const res = await sendReq(
      server,
      "PATCH",
      `/api/portal-universities/${companyId}`,
      { isMultiPortal: false },
    );
    assert.equal(res.status, 200);
    assert.equal(await routesViaOf(MEMBER_A), null);
  } finally {
    server.close();
  }
});
