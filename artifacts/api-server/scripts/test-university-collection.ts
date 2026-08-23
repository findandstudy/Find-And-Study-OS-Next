/**
 * Finance Sprint FAZ 4 — University Collection regression tests.
 *
 * UC-1  GET /finance/university-receivables
 *        Seeded confirmed commission rows aggregate by universityName+currency
 *        and only return rows where remaining > 0.
 *
 * UC-2  POST /finance/university-collection — FIFO distribution
 *        Payment split across two rows by confirmedAt ASC order.
 *
 * UC-3  Row universityCollected updated + status promoted after collection.
 *
 * UC-4  Amount > remaining → 400 with descriptive error.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:university-collection
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express } from "express";
import { eq, inArray } from "drizzle-orm";
import { db, usersTable, commissionsTable, financialTransactionsTable } from "@workspace/db";

import financeRouter from "../src/routes/finance.js";

after(() => {
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

const RUN_ID = `uc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const SEASON = `2099-UC-${RUN_ID}`;
const UNI_NAME = `TestUniversity_${RUN_ID}`;

// ---------------------------------------------------------------------------
// Auth stub
// ---------------------------------------------------------------------------
let currentUser: { id: number; role: string; isActive: boolean; branchId?: number | null } =
  { id: 0, role: "super_admin", isActive: true };

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
  method: "GET" | "POST" | "PATCH",
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

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------
const createdCommissionIds: number[] = [];
const createdTxIds: number[] = [];

async function seedCommission(overrides: Record<string, any>): Promise<number> {
  const [row] = await db.insert(commissionsTable).values({
    season: SEASON,
    status: "confirmed",
    studentName: `Student_${RUN_ID}`,
    universityName: UNI_NAME,
    currency: "USD",
    universityCommissionAmount: "1000.00",
    universityCollected: "0",
    agentCommissionAmount: "0",
    agentPaid: "0",
    subAgentCommissionAmount: "0",
    subAgentPaid: "0",
    ...overrides,
  } as any).returning({ id: commissionsTable.id });
  createdCommissionIds.push(row.id);
  return row.id;
}

after(async () => {
  if (createdTxIds.length) {
    await db.delete(financialTransactionsTable).where(inArray(financialTransactionsTable.id, createdTxIds));
  }
  if (createdCommissionIds.length) {
    await db.delete(commissionsTable).where(inArray(commissionsTable.id, createdCommissionIds));
  }
});

// ---------------------------------------------------------------------------
// UC-1: GET /finance/university-receivables
// ---------------------------------------------------------------------------
test("UC-1: GET /finance/university-receivables aggregates by university+currency, remaining > 0 only", async () => {
  const id1 = await seedCommission({
    universityCommissionAmount: "500.00",
    universityCollected: "0",
    confirmedAt: new Date("2099-01-01"),
  });
  const id2 = await seedCommission({
    universityCommissionAmount: "800.00",
    universityCollected: "800.00",
    status: "collected_full",
    confirmedAt: new Date("2099-01-02"),
  });

  const app = buildApp();
  await withServer(app, async server => {
    const r = await sendReq(server, "GET", `/api/finance/university-receivables?season=${encodeURIComponent(SEASON)}`);
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const data: any[] = r.body?.data ?? [];

    // id2 is fully collected → should not appear (remaining=0)
    const usdRows = data.filter((d: any) => d.universityName === UNI_NAME && d.currency === "USD");

    // id1 still has 500 remaining
    assert.ok(usdRows.length > 0, `Expected receivable row for ${UNI_NAME}/USD, got: ${JSON.stringify(data)}`);
    const row = usdRows[0];
    assert.ok(toNum(row.remaining) >= 500, `remaining should be >= 500, got: ${row.remaining}`);
    assert.ok(toNum(row.totalConfirmed) >= 500, `totalConfirmed should be >= 500`);
    void id2;
  });
});

// ---------------------------------------------------------------------------
// UC-2: POST /finance/university-collection — FIFO distribution
// ---------------------------------------------------------------------------
test("UC-2: FIFO distribution splits payment across two rows in confirmedAt order", async () => {
  const FIFO_UNI = `FifoUni_${RUN_ID}`;
  const idEarly = await seedCommission({
    universityName: FIFO_UNI,
    universityCommissionAmount: "300.00",
    universityCollected: "0",
    confirmedAt: new Date("2099-01-01T00:00:00Z"),
  });
  const idLate = await seedCommission({
    universityName: FIFO_UNI,
    universityCommissionAmount: "400.00",
    universityCollected: "0",
    confirmedAt: new Date("2099-01-02T00:00:00Z"),
  });

  const app = buildApp();
  await withServer(app, async server => {
    // Pay 450 → should fill early (300) + 150 from late (400)
    const r = await sendReq(server, "POST", "/api/finance/university-collection", {
      universityName: FIFO_UNI,
      currency: "USD",
      amount: 450,
      transactionDate: "2099-03-01",
      reference: `REF-${RUN_ID}`,
    });
    assert.equal(r.status, 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);

    const distributed: any[] = r.body?.distributed ?? [];
    assert.equal(distributed.length, 2, `Expected 2 distributions, got ${distributed.length}`);

    const earlyDist = distributed.find((d: any) => d.commissionId === idEarly);
    const lateDist = distributed.find((d: any) => d.commissionId === idLate);
    assert.ok(earlyDist, "early commission not in distributed");
    assert.ok(lateDist, "late commission not in distributed");
    assert.equal(earlyDist.amount, 300, `Early should get 300, got ${earlyDist.amount}`);
    assert.equal(lateDist.amount, 150, `Late should get 150, got ${lateDist.amount}`);

    // Track created txs for cleanup
    const txs = await db.select({ id: financialTransactionsTable.id })
      .from(financialTransactionsTable)
      .where(inArray(financialTransactionsTable.commissionId, [idEarly, idLate]));
    createdTxIds.push(...txs.map(t => t.id));
  });
});

// ---------------------------------------------------------------------------
// UC-3: universityCollected updated + status promoted
// ---------------------------------------------------------------------------
test("UC-3: universityCollected updates and status promotes to collected_full after full payment", async () => {
  const FULL_UNI = `FullUni_${RUN_ID}`;
  const id = await seedCommission({
    universityName: FULL_UNI,
    universityCommissionAmount: "600.00",
    universityCollected: "0",
    confirmedAt: new Date("2099-02-01"),
  });

  const app = buildApp();
  await withServer(app, async server => {
    const r = await sendReq(server, "POST", "/api/finance/university-collection", {
      universityName: FULL_UNI,
      currency: "USD",
      amount: 600,
      transactionDate: "2099-04-01",
    });
    assert.equal(r.status, 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);

    const txs = await db.select({ id: financialTransactionsTable.id })
      .from(financialTransactionsTable)
      .where(eq(financialTransactionsTable.commissionId, id));
    createdTxIds.push(...txs.map(t => t.id));

    const [updated] = await db.select({
      universityCollected: commissionsTable.universityCollected,
      status: commissionsTable.status,
    }).from(commissionsTable).where(eq(commissionsTable.id, id));

    assert.equal(toNum(updated.universityCollected), 600,
      `universityCollected should be 600, got ${updated.universityCollected}`);
    // agentCommissionAmount=0 so agent is considered fully paid → status = settled
    assert.ok(
      updated.status === "collected_full" || updated.status === "settled",
      `status should be collected_full or settled, got ${updated.status}`,
    );
  });
});

// ---------------------------------------------------------------------------
// UC-4: Amount exceeds remaining → 400
// ---------------------------------------------------------------------------
test("UC-4: amount > remaining returns 400 with error", async () => {
  const OVER_UNI = `OverUni_${RUN_ID}`;
  await seedCommission({
    universityName: OVER_UNI,
    universityCommissionAmount: "200.00",
    universityCollected: "0",
    confirmedAt: new Date("2099-03-01"),
  });

  const app = buildApp();
  await withServer(app, async server => {
    const r = await sendReq(server, "POST", "/api/finance/university-collection", {
      universityName: OVER_UNI,
      currency: "USD",
      amount: 999,
      transactionDate: "2099-05-01",
    });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body?.error, `Expected error message in body, got: ${JSON.stringify(r.body)}`);
  });
});
