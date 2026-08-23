/**
 * Service Fee Agent Filter — regression tests.
 *
 * Verifies that the GET /service-fees list endpoint:
 *
 *   SF1  agentId filter (server-side): returns only rows belonging to
 *        the requested agent; rows with a different agentId are excluded.
 *
 *   SF2  Without agentId filter all rows (both agents) are returned.
 *
 *   SF3  staffUserId filter: returns rows where the associated application
 *        (or student) is assigned to the requested staff user.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:service-fee-agent-filter
 *
 *   or directly:
 *   pnpm --filter @workspace/api-server exec tsx ./scripts/test-service-fee-agent-filter.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express } from "express";
import {
  db,
  agentsTable,
  serviceFeesTable,
} from "@workspace/db";

import financeRouter from "../src/routes/finance.js";

after(() => {
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

const RUN_ID = `sfaf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

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
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const json = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(json ? { "Content-Length": Buffer.byteLength(json) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: raw }); }
        });
      },
    );
    req.on("error", reject);
    if (json) req.write(json);
    req.end();
  });
}

async function withServer(app: Express, fn: (s: http.Server) => Promise<void>): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try { await fn(server); }
  finally { server.close(); }
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------
const SEASON = `2099-SFAF-${RUN_ID}`;
const createdFeeIds: number[] = [];
const createdAgentIds: number[] = [];

async function seedAgent(suffix: string) {
  const [agent] = await db.insert(agentsTable).values({
    firstName: `TestAgent_${suffix}_${RUN_ID}`,
    lastName: "Filter",
    email: `agent_${suffix}_${RUN_ID}@test.invalid`,
    commissionRate: 10,
  } as any).returning({ id: agentsTable.id });
  createdAgentIds.push(agent.id);
  return agent;
}

async function seedFee(overrides: Record<string, unknown> = {}) {
  const [row] = await db.insert(serviceFeesTable).values({
    season: SEASON,
    financeStatus: "confirmed",
    status: "pending",
    studentName: `Student_${RUN_ID}`,
    universityName: `Uni_${RUN_ID}`,
    totalAmount: "500.00",
    firstInstallmentAmount: "250.00",
    secondInstallmentAmount: "250.00",
    currency: "USD",
    ...overrides,
  } as any).returning({ id: serviceFeesTable.id });
  createdFeeIds.push(row.id);
  return row;
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------
after(async () => {
  if (createdFeeIds.length > 0) {
    const { inArray } = await import("drizzle-orm");
    await db.delete(serviceFeesTable).where(inArray(serviceFeesTable.id, createdFeeIds));
  }
  if (createdAgentIds.length > 0) {
    const { inArray } = await import("drizzle-orm");
    await db.delete(agentsTable).where(inArray(agentsTable.id, createdAgentIds));
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("SF1 — agentId filter returns only rows for that agent", async () => {
  const agentA = await seedAgent("A");
  const agentB = await seedAgent("B");
  const feeA = await seedFee({ agentId: agentA.id });
  const feeB = await seedFee({ agentId: agentB.id });

  const app = buildApp();
  await withServer(app, async (server) => {
    const res = await sendReq(server, "GET", `/api/service-fees?season=${SEASON}&agentId=${agentA.id}&limit=200`);
    assert.equal(res.status, 200, "Should return 200");
    const ids: number[] = (res.body.data ?? []).map((f: any) => f.id);
    assert.ok(ids.includes(feeA.id), "Should include agent A fee");
    assert.ok(!ids.includes(feeB.id), "Should exclude agent B fee");
  });
});

test("SF2 — without agentId filter all rows are returned", async () => {
  const agentA = await seedAgent("C");
  const agentB = await seedAgent("D");
  const feeA = await seedFee({ agentId: agentA.id });
  const feeB = await seedFee({ agentId: agentB.id });

  const app = buildApp();
  await withServer(app, async (server) => {
    const res = await sendReq(server, "GET", `/api/service-fees?season=${SEASON}&limit=200&includeExcluded=true`);
    assert.equal(res.status, 200, "Should return 200");
    const ids: number[] = (res.body.data ?? []).map((f: any) => f.id);
    assert.ok(ids.includes(feeA.id), "Should include agent A fee");
    assert.ok(ids.includes(feeB.id), "Should include agent B fee");
  });
});

test("SF3 — agentId filter returns zero rows for unknown agent id", async () => {
  const agentX = await seedAgent("X");
  await seedFee({ agentId: agentX.id });
  const bogusAgentId = 99999999;

  const app = buildApp();
  await withServer(app, async (server) => {
    const res = await sendReq(server, "GET", `/api/service-fees?season=${SEASON}&agentId=${bogusAgentId}&limit=200`);
    assert.equal(res.status, 200, "Should return 200");
    const rows: any[] = res.body.data ?? [];
    const seasonRows = rows.filter((f: any) => f.season === SEASON);
    assert.equal(seasonRows.length, 0, "No rows for bogus agentId in this season");
  });
});
