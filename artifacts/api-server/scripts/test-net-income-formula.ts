/**
 * Finance Sprint Phase 1 — Net Income formula + staffPayable tests.
 *
 * Tests the pure calculation logic for:
 *  (a) staffCommissionAmount=0 → Net Income unchanged vs baseline
 *  (b) staffCommissionAmount>0 → deducted from Net Income
 *  (c) staffPayable = totalStaffCommission − staffPayouts (floored at 0)
 *  (d) byCurrency totalStaffCommission accumulation
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:net-income-formula
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ─── Pure helpers extracted from finance route logic ───────────────────────

const toNum = (v: any): number => parseFloat(String(v ?? 0)) || 0;

interface CommRow {
  currency: string;
  status: string;
  universityCommissionAmount: string | null;
  agentCommissionAmount: string | null;
  subAgentCommissionAmount: string | null;
  staffCommissionAmount: string | null;
  universityCollected: string | null;
  agentPaid: string | null;
  subAgentPaid: string | null;
  offsetAmount?: string | null;
}

function calcNetIncome(c: CommRow): number {
  return (
    toNum(c.universityCommissionAmount) -
    toNum(c.agentCommissionAmount) -
    toNum(c.subAgentCommissionAmount) -
    toNum(c.staffCommissionAmount)
  );
}

function calcTotalNetAgency(rows: CommRow[]): number {
  return rows.reduce((s, c) => s + calcNetIncome(c), 0);
}

function calcStaffPayable(
  totalStaffCommission: number,
  totalStaffPayouts: number
): number {
  return Math.max(0, totalStaffCommission - totalStaffPayouts);
}

interface ByCurrencyResult {
  totalStaffCommission: number;
  totalNetAgency: number;
}

function buildNetByCurrency(rows: CommRow[]): Record<string, ByCurrencyResult> {
  const buckets: Record<string, ByCurrencyResult> = {};
  for (const c of rows) {
    const cur = c.currency || "USD";
    if (!buckets[cur]) {
      buckets[cur] = { totalStaffCommission: 0, totalNetAgency: 0 };
    }
    buckets[cur].totalStaffCommission += toNum(c.staffCommissionAmount);
    buckets[cur].totalNetAgency += calcNetIncome(c);
  }
  return buckets;
}

// ─── Test suite ───────────────────────────────────────────────────────────

describe("Net Income formula: universityCommission − agent − subAgent − staff", () => {
  test("(a) staffCommissionAmount=0 → Net Income equals uni − agent − subAgent", () => {
    const row: CommRow = {
      currency: "USD",
      status: "confirmed",
      universityCommissionAmount: "1000",
      agentCommissionAmount: "700",
      subAgentCommissionAmount: "100",
      staffCommissionAmount: "0",
      universityCollected: "0",
      agentPaid: "0",
      subAgentPaid: "0",
    };
    const net = calcNetIncome(row);
    // Expected: 1000 - 700 - 100 - 0 = 200
    assert.equal(net, 200);
  });

  test("(a) null staffCommissionAmount treated as 0 → same as explicit 0", () => {
    const withNull: CommRow = {
      currency: "USD",
      status: "confirmed",
      universityCommissionAmount: "1000",
      agentCommissionAmount: "700",
      subAgentCommissionAmount: "0",
      staffCommissionAmount: null,
      universityCollected: "0",
      agentPaid: "0",
      subAgentPaid: "0",
    };
    const withZero: CommRow = { ...withNull, staffCommissionAmount: "0" };
    assert.equal(calcNetIncome(withNull), calcNetIncome(withZero));
    assert.equal(calcNetIncome(withNull), 300);
  });

  test("(b) staffCommissionAmount>0 → deducted from Net Income", () => {
    const row: CommRow = {
      currency: "USD",
      status: "confirmed",
      universityCommissionAmount: "5000",
      agentCommissionAmount: "2000",
      subAgentCommissionAmount: "500",
      staffCommissionAmount: "300",
      universityCollected: "5000",
      agentPaid: "2000",
      subAgentPaid: "500",
    };
    const net = calcNetIncome(row);
    // Expected: 5000 - 2000 - 500 - 300 = 2200
    assert.equal(net, 2200);
  });

  test("(b) large staffCommissionAmount reduces net to below zero (allowed)", () => {
    const row: CommRow = {
      currency: "USD",
      status: "confirmed",
      universityCommissionAmount: "1000",
      agentCommissionAmount: "800",
      subAgentCommissionAmount: "100",
      staffCommissionAmount: "200",
      universityCollected: "0",
      agentPaid: "0",
      subAgentPaid: "0",
    };
    const net = calcNetIncome(row);
    // Expected: 1000 - 800 - 100 - 200 = -100 (negative allowed for display)
    assert.equal(net, -100);
  });

  test("totalNetAgency across multiple rows sums correctly", () => {
    const rows: CommRow[] = [
      {
        currency: "USD",
        status: "confirmed",
        universityCommissionAmount: "1000",
        agentCommissionAmount: "600",
        subAgentCommissionAmount: "100",
        staffCommissionAmount: "50",
        universityCollected: "0",
        agentPaid: "0",
        subAgentPaid: "0",
      },
      {
        currency: "USD",
        status: "confirmed",
        universityCommissionAmount: "2000",
        agentCommissionAmount: "1200",
        subAgentCommissionAmount: "200",
        staffCommissionAmount: "100",
        universityCollected: "0",
        agentPaid: "0",
        subAgentPaid: "0",
      },
    ];
    const total = calcTotalNetAgency(rows);
    // Row1: 1000-600-100-50=250; Row2: 2000-1200-200-100=500; Total=750
    assert.equal(total, 750);
  });

  test("existing records (staffCommissionAmount=default 0) Net Income unchanged", () => {
    const oldStyleRow: CommRow = {
      currency: "USD",
      status: "confirmed",
      universityCommissionAmount: "3000",
      agentCommissionAmount: "1500",
      subAgentCommissionAmount: "300",
      staffCommissionAmount: "0",
      universityCollected: "3000",
      agentPaid: "1500",
      subAgentPaid: "300",
    };
    const net = calcNetIncome(oldStyleRow);
    // 3000 - 1500 - 300 - 0 = 1200 (same as the old uni-agent-subAgent formula)
    assert.equal(net, 1200);
  });
});

describe("staffPayable = totalStaffCommission − totalStaffPayouts", () => {
  test("(c) no payouts → staffPayable equals totalStaffCommission", () => {
    const payable = calcStaffPayable(500, 0);
    assert.equal(payable, 500);
  });

  test("(c) partial payouts → staffPayable is the remainder", () => {
    const payable = calcStaffPayable(500, 200);
    assert.equal(payable, 300);
  });

  test("(c) fully paid → staffPayable is 0", () => {
    const payable = calcStaffPayable(500, 500);
    assert.equal(payable, 0);
  });

  test("(c) overpaid → staffPayable is floored at 0 (no negative)", () => {
    const payable = calcStaffPayable(500, 600);
    assert.equal(payable, 0);
  });

  test("(c) zero staff commission and zero payouts → staffPayable is 0", () => {
    const payable = calcStaffPayable(0, 0);
    assert.equal(payable, 0);
  });
});

describe("byCurrency totalStaffCommission accumulation", () => {
  test("(d) single-currency: totalStaffCommission and totalNetAgency correct", () => {
    const rows: CommRow[] = [
      {
        currency: "USD",
        status: "confirmed",
        universityCommissionAmount: "1000",
        agentCommissionAmount: "500",
        subAgentCommissionAmount: "0",
        staffCommissionAmount: "100",
        universityCollected: "0",
        agentPaid: "0",
        subAgentPaid: "0",
      },
      {
        currency: "USD",
        status: "confirmed",
        universityCommissionAmount: "2000",
        agentCommissionAmount: "1000",
        subAgentCommissionAmount: "200",
        staffCommissionAmount: "150",
        universityCollected: "0",
        agentPaid: "0",
        subAgentPaid: "0",
      },
    ];
    const by = buildNetByCurrency(rows);
    assert.ok(by["USD"]);
    assert.equal(by["USD"].totalStaffCommission, 250); // 100+150
    // Net: (1000-500-0-100) + (2000-1000-200-150) = 400 + 650 = 1050
    assert.equal(by["USD"].totalNetAgency, 1050);
  });

  test("(d) multi-currency: buckets are separated by currency", () => {
    const rows: CommRow[] = [
      {
        currency: "USD",
        status: "confirmed",
        universityCommissionAmount: "1000",
        agentCommissionAmount: "500",
        subAgentCommissionAmount: "0",
        staffCommissionAmount: "100",
        universityCollected: "0",
        agentPaid: "0",
        subAgentPaid: "0",
      },
      {
        currency: "EUR",
        status: "confirmed",
        universityCommissionAmount: "800",
        agentCommissionAmount: "400",
        subAgentCommissionAmount: "0",
        staffCommissionAmount: "50",
        universityCollected: "0",
        agentPaid: "0",
        subAgentPaid: "0",
      },
    ];
    const by = buildNetByCurrency(rows);
    assert.ok(by["USD"]);
    assert.ok(by["EUR"]);
    assert.equal(by["USD"].totalStaffCommission, 100);
    assert.equal(by["EUR"].totalStaffCommission, 50);
    assert.equal(by["USD"].totalNetAgency, 400); // 1000-500-0-100
    assert.equal(by["EUR"].totalNetAgency, 350); // 800-400-0-50
  });

  test("(d) rows with zero staffCommissionAmount don't pollute totalStaffCommission", () => {
    const rows: CommRow[] = [
      {
        currency: "USD",
        status: "potential",
        universityCommissionAmount: "500",
        agentCommissionAmount: "300",
        subAgentCommissionAmount: "0",
        staffCommissionAmount: "0",
        universityCollected: "0",
        agentPaid: "0",
        subAgentPaid: "0",
      },
      {
        currency: "USD",
        status: "confirmed",
        universityCommissionAmount: "500",
        agentCommissionAmount: "300",
        subAgentCommissionAmount: "0",
        staffCommissionAmount: "75",
        universityCollected: "0",
        agentPaid: "0",
        subAgentPaid: "0",
      },
    ];
    const by = buildNetByCurrency(rows);
    assert.equal(by["USD"].totalStaffCommission, 75);
    // Net: (500-300-0-0) + (500-300-0-75) = 200 + 125 = 325
    assert.equal(by["USD"].totalNetAgency, 325);
  });
});
