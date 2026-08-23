import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { requireRole } from "../src/lib/auth";
import { ADMIN_ROLES } from "../src/lib/roles";

// Token management endpoints (/api-tokens*) must be restricted to admin roles at
// the SERVER, not just hidden in the UI. A non-admin session could otherwise mint
// long-lived bearer credentials directly. These tests lock the gate semantics of
// the exact middleware (requireRole(...ADMIN_ROLES)) used on those routes.

function mockRes(): Response & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

const guard = requireRole(...ADMIN_ROLES);

test("requireRole(...ADMIN_ROLES): unauthenticated request is 401", () => {
  const req = {} as Request;
  const res = mockRes();
  let nextCalled = false;
  guard(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test("requireRole(...ADMIN_ROLES): student session is 403 (cannot manage tokens)", () => {
  const req = { user: { id: 1, role: "student" } } as unknown as Request;
  const res = mockRes();
  let nextCalled = false;
  guard(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test("requireRole(...ADMIN_ROLES): agent session is 403 (cannot manage tokens)", () => {
  const req = { user: { id: 2, role: "agent" } } as unknown as Request;
  const res = mockRes();
  let nextCalled = false;
  guard(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test("requireRole(...ADMIN_ROLES): admin roles pass through", () => {
  for (const role of ADMIN_ROLES) {
    const req = { user: { id: 3, role } } as unknown as Request;
    const res = mockRes();
    let nextCalled = false;
    guard(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true, `role ${role} should pass`);
    assert.equal(res.statusCode, 0, `role ${role} should not set an error status`);
  }
});
