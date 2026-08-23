import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBearerToken } from "../src/lib/apiTokenAuth";
import { requireScope } from "../src/lib/auth";

test("extractBearerToken: only our Bearer tokens are intercepted", () => {
  assert.equal(extractBearerToken("Bearer fas_live_abc123"), "fas_live_abc123");
  assert.equal(extractBearerToken("Bearer  fas_live_padded "), "fas_live_padded");
  // Array header (Node can deliver duplicate headers as an array).
  assert.equal(extractBearerToken(["Bearer fas_live_xyz"]), "fas_live_xyz");
  // Non-Bearer / unknown formats fall through to session auth.
  assert.equal(extractBearerToken(undefined), null);
  assert.equal(extractBearerToken(""), null);
  assert.equal(extractBearerToken("Basic abc"), null);
  assert.equal(extractBearerToken("Bearer someothertoken"), null);
  assert.equal(extractBearerToken("fas_live_no_bearer"), null);
});

// Minimal Express req/res doubles for exercising the requireScope middleware.
function makeCtx(reqOverrides: Record<string, unknown>) {
  const req = { ...reqOverrides } as any;
  let nextCalled = false;
  const res = {
    statusCode: 0 as number,
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
  const next = () => {
    nextCalled = true;
  };
  return { req, res, next, wasNext: () => nextCalled };
}

test("requireScope: session (non-token) requests pass through untouched", () => {
  const mw = requireScope("applications:read");
  const { req, res, next, wasNext } = makeCtx({ apiTokenAuth: false });
  mw(req, res as any, next);
  assert.equal(wasNext(), true, "session request must call next()");
  assert.equal(res.statusCode, 0, "session request must not get a status");
});

test("requireScope: token with all required scopes passes", () => {
  const mw = requireScope("applications:read", "students:read");
  const { req, res, next, wasNext } = makeCtx({
    apiTokenAuth: true,
    tokenScopes: ["applications:read", "students:read", "documents:read"],
  });
  mw(req, res as any, next);
  assert.equal(wasNext(), true);
  assert.equal(res.statusCode, 0);
});

test("requireScope: token missing a required scope is rejected with 403", () => {
  const mw = requireScope("applications:write");
  const { req, res, next, wasNext } = makeCtx({
    apiTokenAuth: true,
    tokenScopes: ["applications:read"],
  });
  mw(req, res as any, next);
  assert.equal(wasNext(), false, "must not call next() on insufficient scope");
  assert.equal(res.statusCode, 403);
  assert.deepEqual((res.body as any).required, ["applications:write"]);
});

test("requireScope: token with empty scopes is rejected when a scope is required", () => {
  const mw = requireScope("documents:read");
  const { req, res, next, wasNext } = makeCtx({ apiTokenAuth: true, tokenScopes: [] });
  mw(req, res as any, next);
  assert.equal(wasNext(), false);
  assert.equal(res.statusCode, 403);
});
