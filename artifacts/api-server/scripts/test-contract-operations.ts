import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express, { type Express, type Request } from "express";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  universitiesTable,
  universityContractsTable,
  companyContractsTable,
  getUniversityContractStatus,
  getCompanyContractStatus,
} from "@workspace/db";
import universityContractsRouter from "../src/routes/universityContracts";
import companyContractsRouter from "../src/routes/companyContracts";

const RUN_ID = `contract_ops_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
let userId = 0;
let universityId = 0;
const universityContractIds: number[] = [];
const companyContractIds: number[] = [];

const currentUser = {
  id: 0,
  role: "super_admin",
  isActive: true,
  permissions: [
    "university_contracts.view",
    "university_contracts.manage",
    "company_contracts.view",
    "company_contracts.manage",
  ],
};

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = currentUser;
    if (!("cookies" in req)) (req as any).cookies = {};
    next();
  });
  app.use("/api", universityContractsRouter);
  app.use("/api", companyContractsRouter);
  return app;
}

const app = buildApp();

async function apiReq(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown) {
  const server = http.createServer(app as unknown as (req: Request, res: unknown) => void);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen failed");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: response.status, data };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

before(async () => {
  const [user] = await db.insert(usersTable).values({
    email: `${RUN_ID}@contract-test.local`,
    firstName: "Contract",
    lastName: "Operations",
    role: "super_admin",
    isActive: true,
  }).returning({ id: usersTable.id });
  userId = user.id;
  currentUser.id = userId;

  const [university] = await db.insert(universitiesTable).values({
    name: `Contract Test University ${RUN_ID}`,
    country: "Testland",
    city: "Test City",
    isActive: true,
  }).returning({ id: universitiesTable.id });
  universityId = university.id;
});

after(async () => {
  if (universityContractIds.length) {
    await db.delete(universityContractsTable).where(inArray(universityContractsTable.id, universityContractIds));
  }
  if (companyContractIds.length) {
    await db.delete(companyContractsTable).where(inArray(companyContractsTable.id, companyContractIds));
  }
  if (universityId) await db.delete(universitiesTable).where(eq(universitiesTable.id, universityId));
  if (userId) await db.delete(usersTable).where(eq(usersTable.id, userId));
});

test("university contract supports create, update, list, and soft delete", async () => {
  const created = await apiReq("POST", "/api/university-contracts", {
    universityId,
    effectiveDate: "2026-01-01",
    expiryDate: "2027-01-01",
    notes: "initial",
    assignedUserIds: [userId, userId],
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = Number((created.data as any)?.data?.id);
  assert.ok(id > 0);
  universityContractIds.push(id);
  assert.deepEqual((created.data as any).data.assignedUserIds, [userId]);

  const updated = await apiReq("PATCH", `/api/university-contracts/${id}`, {
    expiryDate: "2027-06-01",
    notes: "updated",
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal((updated.data as any).data.notes, "updated");

  const listed = await apiReq("GET", `/api/university-contracts?search=${encodeURIComponent(RUN_ID)}`);
  assert.equal(listed.status, 200);
  assert.ok((listed.data as any).data.some((row: any) => row.id === id));

  const removed = await apiReq("DELETE", `/api/university-contracts/${id}`);
  assert.equal(removed.status, 204);
  const [row] = await db.select().from(universityContractsTable).where(eq(universityContractsTable.id, id));
  assert.ok(row.deletedAt instanceof Date);
});

test("company contract supports create, update, list, and soft delete", async () => {
  const companyName = `Contract Test Company ${RUN_ID}`;
  const created = await apiReq("POST", "/api/company-contracts", {
    companyName,
    country: "Testland",
    effectiveDate: "2026-02-01",
    expiryDate: "2027-02-01",
    notes: "initial",
    assignedUserIds: [userId, userId],
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = Number((created.data as any)?.data?.id);
  assert.ok(id > 0);
  companyContractIds.push(id);
  assert.deepEqual((created.data as any).data.assignedUserIds, [userId]);

  const updated = await apiReq("PATCH", `/api/company-contracts/${id}`, {
    companyName: `${companyName} Updated`,
    expiryDate: "2027-07-01",
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.match((updated.data as any).data.companyName, /Updated$/);

  const listed = await apiReq("GET", `/api/company-contracts?search=${encodeURIComponent(RUN_ID)}`);
  assert.equal(listed.status, 200);
  assert.ok((listed.data as any).data.some((row: any) => row.id === id));

  const removed = await apiReq("DELETE", `/api/company-contracts/${id}`);
  assert.equal(removed.status, 204);
  const [row] = await db.select().from(companyContractsTable).where(eq(companyContractsTable.id, id));
  assert.ok(row.deletedAt instanceof Date);
});

test("contract file inputs reject unsafe object keys and unsupported files", async () => {
  const response = await apiReq("POST", "/api/company-contracts", {
    companyName: `Unsafe File ${RUN_ID}`,
    fileObjectKey: "/objects/uploads/test.exe",
    fileName: "test.exe",
    fileMime: "application/octet-stream",
  });
  assert.equal(response.status, 400);
  assert.match(String((response.data as any)?.error), /PDF or DOCX/i);
});

test("university and company status boundaries stay aligned", () => {
  const now = new Date("2026-08-11T12:00:00.000Z");
  const in14Days = new Date(now.getTime() + 14 * 86_400_000);
  const in31Days = new Date(now.getTime() + 31 * 86_400_000);
  const yesterday = new Date(now.getTime() - 86_400_000);
  for (const status of [getUniversityContractStatus, getCompanyContractStatus]) {
    assert.equal(status(null, now), "no_dates");
    assert.equal(status(yesterday, now), "expired");
    assert.equal(status(in14Days, now), "expiring_soon");
    assert.equal(status(in31Days, now), "active");
  }
});
