/**
 * Finance Sprint FAZ 6 — Staff Commission Payment (FIFO distribution) regression tests.
 *
 * SP-1  GET /finance/staff-payables
 *        Returns per-staff per-currency aggregate (totalStaffCommission, remaining).
 *
 * SP-2  POST /finance/staff-commission-payment — FIFO distribution
 *        Payment of 150 split: comm1 gets 120 (full), comm2 gets 30 (partial).
 *
 * SP-3  staff_commission_payouts rows written after FIFO payment.
 *
 * SP-4  Amount > remaining → 400 with error message.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:staff-commission-payment
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express } from "express";
import { eq, inArray, and } from "drizzle-orm";
import { db, commissionsTable, usersTable, staffCommissionPayoutsTable } from "@workspace/db";

import financeRouter from "../src/routes/finance.js";

after(() => {
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

const RUN_ID = `sp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const SEASON  = `2099-SP-${RUN_ID}`;

// ── Auth stub ─────────────────────────────────────────────────────────────────
const currentUser = { id: 1, role: "super_admin", isActive: true };

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = currentUser;
    if (!("cookies" in req)) (req as any).cookies = {};
    next();
  });
  app.use("/api", financeRouter);
  return app;
}

function sendReq(
  server: http.Server,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const opts: http.RequestOptions = {
      hostname: "127.0.0.1",
      port: addr.port,
      path,
      method,
      headers: { "Content-Type": "application/json" },
    };
    const req = http.request(opts, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode!, body: data }); }
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function withServer(app: Express, fn: (s: http.Server) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", async () => {
      try { await fn(s); resolve(); }
      catch (e) { reject(e); }
      finally { s.close(); }
    });
  });
}

function toNum(v: any) { return parseFloat(String(v ?? 0)) || 0; }

// ── Seed helpers ──────────────────────────────────────────────────────────────
let testStaffUserId: number;
const createdCommissionIds: number[] = [];
const createdPayoutIds: number[] = [];
let commId1: number;
let commId2: number;

async function seedAll() {
  // Create a test staff user
  const [staffUser] = await db.insert(usersTable).values({
    email: `faz6staff_${RUN_ID}@test.local`,
    firstName: "FAZ6",
    lastName: `Staff_${RUN_ID}`,
    role: "staff",
    isActive: true,
    emailVerified: false,
    language: "en",
  }).returning({ id: usersTable.id });
  testStaffUserId = staffUser.id;

  // Commission 1: staffCommissionAmount=120, confirmedAt earlier
  const [c1] = await db.insert(commissionsTable).values({
    season: SEASON,
    studentName: `FAZ6_A_${RUN_ID}`,
    universityName: `FAZ6Uni_${RUN_ID}`,
    currency: "USD",
    staffCommissionCurrency: "USD",
    staffUserId: testStaffUserId,
    universityCommissionAmount: "300",
    universityCollected: "0",
    agentCommissionAmount: "0",
    agentPaid: "0",
    subAgentCommissionAmount: "0",
    subAgentPaid: "0",
    staffCommissionAmount: "120",
    status: "confirmed",
    confirmedAt: new Date("2025-01-10"),
  } as any).returning({ id: commissionsTable.id });
  commId1 = c1.id;
  createdCommissionIds.push(commId1);

  // Commission 2: staffCommissionAmount=80, confirmedAt later
  const [c2] = await db.insert(commissionsTable).values({
    season: SEASON,
    studentName: `FAZ6_B_${RUN_ID}`,
    universityName: `FAZ6Uni_${RUN_ID}`,
    currency: "USD",
    staffCommissionCurrency: "USD",
    staffUserId: testStaffUserId,
    universityCommissionAmount: "200",
    universityCollected: "0",
    agentCommissionAmount: "0",
    agentPaid: "0",
    subAgentCommissionAmount: "0",
    subAgentPaid: "0",
    staffCommissionAmount: "80",
    status: "confirmed",
    confirmedAt: new Date("2025-02-15"),
  } as any).returning({ id: commissionsTable.id });
  commId2 = c2.id;
  createdCommissionIds.push(commId2);
}

after(async () => {
  // Clean up payouts, commissions, staff user in reverse dependency order
  const payoutRows = await db.select({ id: staffCommissionPayoutsTable.id })
    .from(staffCommissionPayoutsTable)
    .where(
      createdCommissionIds.length > 0
        ? inArray(staffCommissionPayoutsTable.commissionId, createdCommissionIds)
        : eq(staffCommissionPayoutsTable.id, -1)
    );
  const allPayoutIds = [...new Set([...payoutRows.map(r => r.id), ...createdPayoutIds])];
  if (allPayoutIds.length > 0) {
    await db.delete(staffCommissionPayoutsTable)
      .where(inArray(staffCommissionPayoutsTable.id, allPayoutIds));
  }
  if (createdCommissionIds.length) {
    await db.delete(commissionsTable).where(inArray(commissionsTable.id, createdCommissionIds));
  }
  if (testStaffUserId) {
    await db.delete(usersTable).where(eq(usersTable.id, testStaffUserId));
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────
test("SP-1: GET /finance/staff-payables aggregates per-staff per-currency remaining", async () => {
  await seedAll();
  const app = buildApp();
  await withServer(app, async server => {
    const r = await sendReq(server, "GET", `/api/finance/staff-payables?season=${encodeURIComponent(SEASON)}`);
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const data: any[] = r.body?.data ?? [];

    const entry = data.find((d: any) => Number(d.staffUserId) === testStaffUserId && d.currency === "USD");
    assert.ok(entry, `Expected USD entry for staffUserId=${testStaffUserId}, got: ${JSON.stringify(data)}`);

    // totalStaffCommission = 120 + 80 = 200
    assert.equal(toNum(entry.totalStaffCommission), 200,
      `totalStaffCommission should be 200, got ${entry.totalStaffCommission}`);
    assert.equal(toNum(entry.remaining), 200,
      `remaining should be 200, got ${entry.remaining}`);
  });
});

test("SP-2: POST /finance/staff-commission-payment distributes FIFO (pay 150 → comm1=120, comm2=30)", async () => {
  const app = buildApp();
  await withServer(app, async server => {
    const r = await sendReq(server, "POST", "/api/finance/staff-commission-payment", {
      staffUserId: testStaffUserId,
      currency: "USD",
      amount: 150,
      transactionDate: "2025-06-01",
      reference: "FAZ6-TEST",
      attachmentUrl: "https://example.com/doc.pdf",
    });
    assert.equal(r.status, 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(Array.isArray(r.body.distributed), "distributed should be array");
    assert.equal(r.body.distributed.length, 2,
      `Should distribute across 2 commissions, got ${r.body.distributed.length}`);

    const d1 = r.body.distributed.find((d: any) => d.commissionId === commId1);
    const d2 = r.body.distributed.find((d: any) => d.commissionId === commId2);
    assert.ok(d1, "Should have distribution for commission 1");
    assert.ok(d2, "Should have distribution for commission 2");
    assert.equal(toNum(d1.amount), 120,
      `comm1 should get 120 (full balance), got ${d1.amount}`);
    assert.equal(toNum(d2.amount), 30,
      `comm2 should get 30 (partial), got ${d2.amount}`);
    assert.equal(toNum(r.body.updatedRemaining), 50,
      `updatedRemaining should be 50, got ${r.body.updatedRemaining}`);
  });
});

test("SP-3: staff_commission_payouts rows written with correct amounts and attachmentUrl", async () => {
  const payouts = await db.select()
    .from(staffCommissionPayoutsTable)
    .where(and(
      inArray(staffCommissionPayoutsTable.commissionId, createdCommissionIds),
      eq(staffCommissionPayoutsTable.staffUserId, testStaffUserId),
    ));

  assert.equal(payouts.length, 2,
    `Expected 2 payout rows, got ${payouts.length}`);

  const p1 = payouts.find(p => p.commissionId === commId1);
  const p2 = payouts.find(p => p.commissionId === commId2);

  assert.ok(p1, "Should have payout row for commission 1");
  assert.ok(p2, "Should have payout row for commission 2");
  assert.equal(toNum(p1!.amount), 120,
    `payout1.amount should be 120, got ${p1!.amount}`);
  assert.equal(toNum(p2!.amount), 30,
    `payout2.amount should be 30, got ${p2!.amount}`);
  assert.equal(p1!.attachmentUrl, "https://example.com/doc.pdf",
    `attachmentUrl should be preserved, got ${p1!.attachmentUrl}`);
  assert.equal(p1!.currency, "USD",
    `currency should be USD, got ${p1!.currency}`);
  assert.equal(p1!.reference, "FAZ6-TEST",
    `reference should be FAZ6-TEST, got ${p1!.reference}`);
});

test("SP-4: amount > remaining → 400", async () => {
  const app = buildApp();
  await withServer(app, async server => {
    const r = await sendReq(server, "POST", "/api/finance/staff-commission-payment", {
      staffUserId: testStaffUserId,
      currency: "USD",
      amount: 9999,
      transactionDate: "2025-06-01",
    });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body?.error, "Should return error message");
  });
});
