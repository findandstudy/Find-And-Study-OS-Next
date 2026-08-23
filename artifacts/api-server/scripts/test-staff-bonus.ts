/**
 * Staff direct-student enrollment bonus calculation test suite.
 *
 * Tests the pure calculation logic for:
 *  - bonus rate application (rate * count)
 *  - confirmed vs potential bucket separation (enrolled vs non-enrolled)
 *  - paid exclusion (students already paid via staffCommissions are excluded from pending)
 *  - edge cases: no direct students, all paid, rate=0
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:staff-bonus
 *   # or:
 *   pnpm --filter @workspace/api-server exec tsx --test ./scripts/test-staff-bonus.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ──────────────────────────────────────────────────────────────────────────────
// Pure calculation helpers extracted from the route handlers
// ──────────────────────────────────────────────────────────────────────────────

interface Student { id: number; status: string }
interface PaidComm { studentId: number | null }

function calcStaffBonusResult(
  rate: number,
  directStudents: Student[],
  paidComms: PaidComm[]
) {
  const paidStudentIds = new Set(
    paidComms.map(c => c.studentId).filter((x): x is number => x != null)
  );
  const eligible = directStudents.filter(s => !paidStudentIds.has(s.id));
  const confirmed = eligible.filter(s => s.status === "enrolled");
  const potential = eligible.filter(s => s.status !== "enrolled");
  const paidTotal = paidComms.length * rate;

  return {
    potential: { count: potential.length, amount: potential.length * rate },
    confirmed: { count: confirmed.length, amount: confirmed.length * rate },
    paid: { count: paidComms.length, amount: paidTotal },
    pending: { count: confirmed.length, amount: Math.max(0, confirmed.length * rate - paidTotal) },
  };
}

function calcBulkSalaryDates(count: number, startDate?: string): Date[] {
  const base = startDate ? new Date(startDate) : new Date();
  base.setDate(1);
  base.setHours(0, 0, 0, 0);
  return Array.from({ length: count }, (_, i) =>
    new Date(base.getFullYear(), base.getMonth() + i, 1)
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Bonus calculation tests
// ──────────────────────────────────────────────────────────────────────────────

describe("calcStaffBonusResult", () => {
  test("zero rate → all amounts are 0 regardless of students", () => {
    const students: Student[] = [
      { id: 1, status: "enrolled" },
      { id: 2, status: "active" },
    ];
    const result = calcStaffBonusResult(0, students, []);
    assert.equal(result.confirmed.amount, 0);
    assert.equal(result.potential.amount, 0);
    assert.equal(result.paid.amount, 0);
    assert.equal(result.pending.amount, 0);
    assert.equal(result.confirmed.count, 1);
    assert.equal(result.potential.count, 1);
  });

  test("no direct students → all counts and amounts are 0", () => {
    const result = calcStaffBonusResult(500, [], []);
    assert.equal(result.confirmed.count, 0);
    assert.equal(result.potential.count, 0);
    assert.equal(result.paid.count, 0);
    assert.equal(result.pending.amount, 0);
  });

  test("enrolled students → go into confirmed bucket", () => {
    const students: Student[] = [
      { id: 1, status: "enrolled" },
      { id: 2, status: "enrolled" },
      { id: 3, status: "active" },
    ];
    const result = calcStaffBonusResult(200, students, []);
    assert.equal(result.confirmed.count, 2);
    assert.equal(result.confirmed.amount, 400);
    assert.equal(result.potential.count, 1);
    assert.equal(result.potential.amount, 200);
  });

  test("paid students are excluded from eligible bucket", () => {
    const students: Student[] = [
      { id: 1, status: "enrolled" },
      { id: 2, status: "enrolled" },
      { id: 3, status: "active" },
    ];
    const paidComms: PaidComm[] = [{ studentId: 1 }];
    const result = calcStaffBonusResult(100, students, paidComms);
    // student 1 paid → excluded from eligible
    assert.equal(result.confirmed.count, 1, "only student 2 remains confirmed");
    assert.equal(result.confirmed.amount, 100);
    assert.equal(result.potential.count, 1, "only student 3 remains potential");
    assert.equal(result.paid.count, 1);
    assert.equal(result.paid.amount, 100);
  });

  test("pending = confirmed amount minus already-paid amount, floored at 0", () => {
    const students: Student[] = [
      { id: 1, status: "enrolled" },
      { id: 2, status: "enrolled" },
    ];
    const paidComms: PaidComm[] = [{ studentId: 1 }, { studentId: 2 }];
    const result = calcStaffBonusResult(300, students, paidComms);
    assert.equal(result.confirmed.count, 0, "both enrolled students already paid");
    assert.equal(result.pending.amount, 0, "pending must not go negative");
  });

  test("null studentId in paidComms is ignored safely", () => {
    const students: Student[] = [{ id: 1, status: "enrolled" }];
    const paidComms: PaidComm[] = [{ studentId: null }, { studentId: null }];
    const result = calcStaffBonusResult(500, students, paidComms);
    // null studentIds shouldn't affect the eligible set
    assert.equal(result.confirmed.count, 1);
    assert.equal(result.confirmed.amount, 500);
  });

  test("rate * count math is exact for typical bonus scenario", () => {
    const rate = 250;
    const students: Student[] = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      status: i < 3 ? "enrolled" : "active",
    }));
    const result = calcStaffBonusResult(rate, students, []);
    assert.equal(result.confirmed.count, 3);
    assert.equal(result.confirmed.amount, 750);
    assert.equal(result.potential.count, 2);
    assert.equal(result.potential.amount, 500);
    assert.equal(result.pending.amount, 750);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Bulk salary date generation tests
// ──────────────────────────────────────────────────────────────────────────────

describe("calcBulkSalaryDates", () => {
  test("generates correct count of monthly dates", () => {
    const dates = calcBulkSalaryDates(6, "2024-01-15");
    assert.equal(dates.length, 6);
  });

  test("all dates fall on the 1st of their month", () => {
    const dates = calcBulkSalaryDates(12, "2024-06-20");
    for (const d of dates) {
      assert.equal(d.getDate(), 1, `Expected 1st, got ${d.getDate()} in ${d}`);
    }
  });

  test("months increment sequentially from startDate month", () => {
    const dates = calcBulkSalaryDates(3, "2024-11-01");
    assert.equal(dates[0].getMonth(), 10, "Nov = month 10");
    assert.equal(dates[1].getMonth(), 11, "Dec = month 11");
    assert.equal(dates[2].getMonth(), 0, "Jan = month 0 (next year)");
    assert.equal(dates[2].getFullYear(), 2025);
  });

  test("count=1 returns single month", () => {
    const dates = calcBulkSalaryDates(1, "2024-03-15");
    assert.equal(dates.length, 1);
    assert.equal(dates[0].getMonth(), 2); // March = 2
  });

  test("count=36 max does not throw", () => {
    const dates = calcBulkSalaryDates(36, "2024-01-01");
    assert.equal(dates.length, 36);
    // last date should be Dec 2026
    assert.equal(dates[35].getMonth(), 11);
    assert.equal(dates[35].getFullYear(), 2026);
  });
});
