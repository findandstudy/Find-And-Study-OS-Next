import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveScopeRule, tokenScopeGuard } from "../src/middlewares/tokenScopeGuard";

// Minimal Express req/res/next doubles.
function run(reqOverrides: Record<string, unknown>) {
  const req = { method: "GET", path: "/", ...reqOverrides } as any;
  let nextCalled = false;
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
  tokenScopeGuard(req, res as any, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

test("resolveScopeRule: path/method mapping", () => {
  assert.equal(resolveScopeRule("GET", "/applications")?.scope, "applications:read");
  assert.equal(resolveScopeRule("GET", "/applications/123")?.scope, "applications:read");
  assert.equal(resolveScopeRule("POST", "/applications")?.scope, "applications:write");
  assert.equal(resolveScopeRule("PATCH", "/applications/123")?.scope, "applications:patch");
  assert.equal(resolveScopeRule("GET", "/documents/9/download")?.scope, "documents:read");
  assert.equal(resolveScopeRule("GET", "/students/5")?.scope, "students:read");
  // Student-scoped documents (read-only list + binary download).
  assert.equal(resolveScopeRule("GET", "/students/5/documents")?.scope, "documents:read");
  assert.equal(resolveScopeRule("GET", "/students/5/documents/9/download")?.scope, "documents:read");
  assert.equal(resolveScopeRule("GET", "/universities/countries")?.scope, "universities:read");
  assert.equal(resolveScopeRule("GET", "/universities/42")?.scope, "universities:read");
  assert.equal(resolveScopeRule("GET", "/programs/7")?.scope, "universities:read");
  // No rule for non-enumerated / sensitive endpoints.
  assert.equal(resolveScopeRule("POST", "/applications/1/notes"), null);
  assert.equal(resolveScopeRule("POST", "/students/1/purge"), null);
  assert.equal(resolveScopeRule("PATCH", "/applications"), null);
  assert.equal(resolveScopeRule("DELETE", "/documents/1"), null);
  // Student-scoped documents are read-only via token: no write/delete mapping.
  assert.equal(resolveScopeRule("POST", "/students/5/documents"), null);
  assert.equal(resolveScopeRule("DELETE", "/students/5/documents/9"), null);
  assert.equal(resolveScopeRule("POST", "/students/5/documents/9/download"), null);
});

test("tokenScopeGuard: session requests always pass through", () => {
  // Even an unmapped, sensitive path is allowed for cookie sessions.
  const { nextCalled, res } = run({ apiTokenAuth: false, method: "POST", path: "/students/1/purge" });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 0);
});

test("tokenScopeGuard: token with the required scope passes", () => {
  const { nextCalled } = run({
    apiTokenAuth: true,
    tokenScopes: ["applications:read"],
    method: "GET",
    path: "/applications/123",
  });
  assert.equal(nextCalled, true);
});

test("tokenScopeGuard: token missing the required scope is 403 INSUFFICIENT_SCOPE", () => {
  const { nextCalled, res } = run({
    apiTokenAuth: true,
    tokenScopes: ["documents:read"],
    method: "GET",
    path: "/applications",
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal((res.body as any).code, "INSUFFICIENT_SCOPE");
});

test("tokenScopeGuard: token on a non-enumerated endpoint is 403 TOKEN_ENDPOINT_FORBIDDEN (default-deny)", () => {
  const { nextCalled, res } = run({
    apiTokenAuth: true,
    tokenScopes: ["applications:read", "applications:write", "applications:patch"],
    method: "POST",
    path: "/applications/1/notes",
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal((res.body as any).code, "TOKEN_ENDPOINT_FORBIDDEN");
});

test("tokenScopeGuard: token with empty scopes is rejected on a mapped endpoint", () => {
  const { nextCalled, res } = run({
    apiTokenAuth: true,
    tokenScopes: [],
    method: "GET",
    path: "/students/5",
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal((res.body as any).code, "INSUFFICIENT_SCOPE");
});
