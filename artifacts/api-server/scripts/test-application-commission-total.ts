import test from "node:test";
import assert from "node:assert/strict";
import { resolveApplicationCommissionTotal } from "../src/lib/applicationCommissionTotals";

const totals = {
  universityCommissionTotal: "1000.50",
  agentCommissionTotal: "300.25",
  subAgentCommissionTotal: "80.10",
};

test("staff sees the agency net total for the complete result set", () => {
  assert.equal(resolveApplicationCommissionTotal({
    ...totals,
    isAgentUser: false,
    isSubAgentUser: false,
  }), 700.25);
});

test("parent agent sees its net total", () => {
  assert.equal(resolveApplicationCommissionTotal({
    ...totals,
    isAgentUser: true,
    isSubAgentUser: false,
  }), 220.15);
});

test("sub-agent sees only its own total", () => {
  assert.equal(resolveApplicationCommissionTotal({
    ...totals,
    isAgentUser: true,
    isSubAgentUser: true,
  }), 80.1);
});

test("missing and malformed aggregate values safely resolve to zero", () => {
  assert.equal(resolveApplicationCommissionTotal({
    universityCommissionTotal: null,
    agentCommissionTotal: "not-a-number",
    subAgentCommissionTotal: undefined,
    isAgentUser: false,
    isSubAgentUser: false,
  }), 0);
});
