/**
 * Finance Sprint FAZ 5 — Agent Payment (FIFO distribution) regression tests.
 *
 * AP-1  GET /finance/agent-payables
 *        Returns per-agent per-currency aggregate (totalAgentCommission, remaining).
 *
 * AP-2  POST /finance/agent-payment — FIFO distribution
 *        Payment of 150 split: comm1 gets 120 (full), comm2 gets 30 (partial).
 *
 * AP-3  agentPaid updated on commission rows after FIFO payment.
 *
 * AP-4  Amount > remaining → 400 with error message.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:agent-payment
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express } from "express";
import { eq, inArray } from "drizzle-orm";
import { db, agentsTable, commissionsTable, financialTransactionsTable } from "@workspace/db";

import financeRouter from "../src/routes/finance.js";

after(() => {
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

const RUN_ID = `ap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const SEASON  = `2099-AP-${RUN_ID}`;

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
let testAgentId: number;
const createdCommissionIds: number[] = [];
const createdTxIds: number[] = [];
let commId1: number;
let commId2: number;

async function seedAll() {
  // Create a test agent
  const [agent] = await db.insert(agentsTable).values({
    firstName: "FAZ5",
    lastName: `Agent_${RUN_ID}`,
    email: `faz5agent_${RUN_ID}@test.local`,
    status: "active",
    country: "TR",
  }).returning({ id: agentsTable.id });
  testAgentId = agent.id;

  // Commission 1: agentCommissionAmount=120, agentPaid=0
  const [c1] = await db.insert(commissionsTable).values({
    season: SEASON,
    agentId: testAgentId,
    studentName: `FAZ5_A_${RUN_ID}`,
    universityName: `FAZ5Uni_${RUN_ID}`,
    currency: "USD",
    universityCommissionAmount: "300",
    universityCollected: "0",
    agentCommissionAmount: "120",
    agentPaid: "0",
    subAgentCommissionAmount: "0",
    subAgentPaid: "0",
    status: "confirmed",
    confirmedAt: new Date("2025-01-10"),
  } as any).returning({ id: commissionsTable.id });
  commId1 = c1.id;
  createdCommissionIds.push(commId1);

  // Commission 2: agentCommissionAmount=80, agentPaid=0
  const [c2] = await db.insert(commissionsTable).values({
    season: SEASON,
    agentId: testAgentId,
    studentName: `FAZ5_B_${RUN_ID}`,
    universityName: `FAZ5Uni_${RUN_ID}`,
    currency: "USD",
    universityCommissionAmount: "200",
    universityCollected: "0",
    agentCommissionAmount: "80",
    agentPaid: "0",
    subAgentCommissionAmount: "0",
    subAgentPaid: "0",
    status: "confirmed",
    confirmedAt: new Date("2025-02-15"),
  } as any).returning({ id: commissionsTable.id });
  commId2 = c2.id;
  createdCommissionIds.push(commId2);
}

after(async () => {
  // Clean up transactions, commissions, agent in reverse dependency order
  const txRows = await db.select({ id: financialTransactionsTable.id })
    .from(financialTransactionsTable)
    .where(
      createdCommissionIds.length > 0
        ? inArray(financialTransactionsTable.commissionId, createdCommissionIds)
        : eq(financialTransactionsTable.id, -1)
    );
  if (txRows.length) {
    await db.delete(financialTransactionsTable)
      .where(inArray(financialTransactionsTable.id, txRows.map(r => r.id)));
  }
  if (createdCommissionIds.length) {
    await db.delete(commissionsTable).where(inArray(commissionsTable.id, createdCommissionIds));
  }
  if (testAgentId) {
    await db.delete(agentsTable).where(eq(agentsTable.id, testAgentId));
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────
test("AP-1: GET /finance/agent-payables aggregates per-agent per-currency remaining", async () => {
  await seedAll();
  const app = buildApp();
  await withServer(app, async server => {
    const r = await sendReq(server, "GET", `/api/finance/agent-payables?season=${encodeURIComponent(SEASON)}`);
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const data: any[] = r.body?.data ?? [];

    const entry = data.find((d: any) => Number(d.agentId) === testAgentId && d.currency === "USD");
    assert.ok(entry, `Expected USD entry for agentId=${testAgentId}, got: ${JSON.stringify(data)}`);

    // totalAgentCommission = 120 + 80 = 200
    assert.equal(toNum(entry.totalAgentCommission), 200,
      `totalAgentCommission should be 200, got ${entry.totalAgentCommission}`);
    assert.equal(toNum(entry.remaining), 200,
      `remaining should be 200, got ${entry.remaining}`);
  });
});

test("AP-2: POST /finance/agent-payment distributes FIFO (pay 150 → comm1=120, comm2=30)", async () => {
  const app = buildApp();
  await withServer(app, async server => {
    const r = await sendReq(server, "POST", "/api/finance/agent-payment", {
      agentId: testAgentId,
      currency: "USD",
      amount: 150,
      transactionDate: "2025-06-01",
      reference: "FAZ5-TEST",
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

test("AP-3: agentPaid updated on commission rows after FIFO payment", async () => {
  const [u1] = await db.select({ agentPaid: commissionsTable.agentPaid, status: commissionsTable.status })
    .from(commissionsTable).where(eq(commissionsTable.id, commId1));
  const [u2] = await db.select({ agentPaid: commissionsTable.agentPaid, status: commissionsTable.status })
    .from(commissionsTable).where(eq(commissionsTable.id, commId2));

  assert.equal(toNum(u1.agentPaid), 120,
    `comm1.agentPaid should be 120, got ${u1.agentPaid}`);
  assert.equal(toNum(u2.agentPaid), 30,
    `comm2.agentPaid should be 30, got ${u2.agentPaid}`);
  // University not yet collected → status stays confirmed
  assert.equal(u1.status, "confirmed",
    `comm1.status should be confirmed, got ${u1.status}`);
  assert.equal(u2.status, "confirmed",
    `comm2.status should be confirmed, got ${u2.status}`);
});

test("AP-4: amount > remaining → 400", async () => {
  const app = buildApp();
  await withServer(app, async server => {
    const r = await sendReq(server, "POST", "/api/finance/agent-payment", {
      agentId: testAgentId,
      currency: "USD",
      amount: 9999,
      transactionDate: "2025-06-01",
    });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body?.error, "Should return error message");
  });
});
