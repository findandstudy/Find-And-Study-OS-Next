/**
 * gpaNormalize unit test suite.
 *
 * Locks down the conversion table for free-text GPA inputs into 0-100 scale.
 * Pure unit checks against artifacts/api-server/src/lib/gpaNormalize.ts.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server exec tsx ./scripts/test-gpa-normalize.ts
 */
import { normalizeGpaEvidenceTo100, normalizeGpaTo100 } from "../src/lib/gpaNormalize";

let pass = 0;
let fail = 0;

function approx(actual: number, expected: number, eps = 0.01): boolean {
  if (Number.isNaN(actual) && Number.isNaN(expected)) return true;
  return Math.abs(actual - expected) <= eps;
}

function check(label: string, input: string | null | undefined, expected: number) {
  const actual = normalizeGpaTo100(input);
  const ok = approx(actual, expected);
  if (ok) {
    pass++;
    console.log(`  ok   ${label} -> ${actual.toFixed(2)}`);
  } else {
    fail++;
    console.error(`  FAIL ${label}: expected ${expected}, got ${actual}`);
  }
}

console.log("gpaNormalize unit tests");

check("804/1100", "804/1100", (804 / 1100) * 100);
check("3.5/4", "3.5/4", 87.5);
check("85 (already 100-scale)", "85", 85);
check("3.5 auto-/4", "3.5", 87.5);
check("4.2 auto-/5", "4.2", 84);
check("8.5 auto-/10", "8.5", 85);
check("15/20", "15/20", 75);
check("85 (Grade A) — paren stripped", "85 (Grade A)", 85);
check("comma decimal 3,5", "3,5", 87.5);
check("empty string -> NaN", "", NaN);
check("null -> NaN", null, NaN);
check("undefined -> NaN", undefined, NaN);
check("non-numeric -> NaN", "n/a", NaN);
check("0/4", "0/4", 0);
check("110 (over 100, returned as-is)", "110", 110);

const strictPakistan = normalizeGpaEvidenceTo100("955/1200");
if (approx(strictPakistan, (955 / 1200) * 100)) {
  pass++;
  console.log(`  ok   strict 955/1200 -> ${strictPakistan.toFixed(2)}`);
} else {
  fail++;
  console.error(`  FAIL strict 955/1200: got ${strictPakistan}`);
}

if (Number.isNaN(normalizeGpaEvidenceTo100("955"))) {
  pass++;
  console.log("  ok   strict bare 955 -> NaN");
} else {
  fail++;
  console.error("  FAIL strict bare 955 must be rejected");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
