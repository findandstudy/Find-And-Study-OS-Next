import test from "node:test";
import assert from "node:assert/strict";
import { resolveApplicationIntakeSnapshot } from "../src/lib/applicationIntake";

test("explicit application intake wins over programme fallback", () => {
  assert.equal(resolveApplicationIntakeSnapshot("Jan 2027", "Sep"), "Jan 2027");
});

test("programme intake is snapshotted when application intake is empty", () => {
  assert.equal(resolveApplicationIntakeSnapshot("", "Sep"), "Sep");
  assert.equal(resolveApplicationIntakeSnapshot(null, "Feb, Sep"), "Feb, Sep");
});

test("empty or invalid values remain null", () => {
  assert.equal(resolveApplicationIntakeSnapshot("   ", " "), null);
  assert.equal(resolveApplicationIntakeSnapshot(undefined, 2027), null);
});
