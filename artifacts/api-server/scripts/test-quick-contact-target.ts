import assert from "node:assert/strict";
import test from "node:test";
import { resolveApplicationMessageTarget } from "../src/lib/inbox/quickContactTarget";

test("application messaging resolves to the linked student", () => {
  assert.deepEqual(
    resolveApplicationMessageTarget(
      { studentId: 2480, agentId: 17 },
      {
        agentId: 22,
        phoneE164: "+905456978515",
        firstName: "Ada",
        lastName: "Lovelace",
      },
    ),
    {
      studentId: 2480,
      agentId: 17,
      phoneE164: "+905456978515",
      displayName: "Ada Lovelace",
    },
  );
});

test("student agency ownership is used when the application has none", () => {
  const target = resolveApplicationMessageTarget(
    { studentId: 2480, agentId: null },
    { agentId: 22, phone: "0545 697 85 15", firstName: "Ada", lastName: "Lovelace" },
  );

  assert.equal(target?.agentId, 22);
  assert.equal(target?.phoneE164, "+905456978515");
});

test("fails closed when the application or linked student is missing", () => {
  assert.equal(resolveApplicationMessageTarget(null, null), null);
  assert.equal(resolveApplicationMessageTarget({ studentId: null, agentId: null }, {}), null);
  assert.equal(resolveApplicationMessageTarget({ studentId: 2480, agentId: null }, null), null);
});
