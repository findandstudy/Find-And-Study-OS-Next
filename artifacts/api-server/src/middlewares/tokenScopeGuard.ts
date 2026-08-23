import type { Request, Response, NextFunction } from "express";

type ScopeRule = { method: string; pattern: RegExp; scope: string };

// Single source of truth for the API surface reachable via a Bearer API token.
//
// Default-deny: any token request whose (method, path) matches no rule below is
// rejected with TOKEN_ENDPOINT_FORBIDDEN. This guarantees least privilege — a
// token can NEVER reach an endpoint it was not explicitly granted, regardless of
// how powerful the owning user's role is. Cookie/session requests bypass this
// guard entirely (req.apiTokenAuth is false for them), so there is zero
// regression to the existing interactive app.
//
// Paths here are relative to the /api mount (the router strips the prefix), e.g.
// "/applications", matching the convention already used by the onboarding gate.
const SCOPE_RULES: ScopeRule[] = [
  // applications
  { method: "GET", pattern: /^\/applications\/?$/, scope: "applications:read" },
  { method: "GET", pattern: /^\/applications\/\d+\/?$/, scope: "applications:read" },
  { method: "POST", pattern: /^\/applications\/?$/, scope: "applications:write" },
  { method: "PATCH", pattern: /^\/applications\/\d+\/?$/, scope: "applications:patch" },
  // documents
  { method: "GET", pattern: /^\/documents\/?$/, scope: "documents:read" },
  { method: "GET", pattern: /^\/documents\/\d+\/?$/, scope: "documents:read" },
  { method: "GET", pattern: /^\/documents\/\d+\/download\/?$/, scope: "documents:read" },
  { method: "POST", pattern: /^\/documents\/?$/, scope: "documents:write" },
  // students
  { method: "GET", pattern: /^\/students\/?$/, scope: "students:read" },
  { method: "GET", pattern: /^\/students\/\d+\/?$/, scope: "students:read" },
  // student-scoped documents (read-only: list + binary download)
  { method: "GET", pattern: /^\/students\/\d+\/documents\/?$/, scope: "documents:read" },
  { method: "GET", pattern: /^\/students\/\d+\/documents\/\d+\/download\/?$/, scope: "documents:read" },
  // universities & programs (all read-only)
  { method: "GET", pattern: /^\/universities\/?$/, scope: "universities:read" },
  { method: "GET", pattern: /^\/universities\/countries\/?$/, scope: "universities:read" },
  { method: "GET", pattern: /^\/universities\/\d+\/?$/, scope: "universities:read" },
  { method: "GET", pattern: /^\/programs\/?$/, scope: "universities:read" },
  { method: "GET", pattern: /^\/programs\/\d+\/?$/, scope: "universities:read" },
];

// Exported for testing.
export function resolveScopeRule(method: string, path: string): ScopeRule | null {
  const m = method.toUpperCase();
  return SCOPE_RULES.find((r) => r.method === m && r.pattern.test(path)) ?? null;
}

export function tokenScopeGuard(req: Request, res: Response, next: NextFunction): void {
  // Session (cookie) requests are never affected by token scoping.
  if (!req.apiTokenAuth) {
    next();
    return;
  }
  const rule = resolveScopeRule(req.method, req.path);
  if (!rule) {
    res.status(403).json({
      error: "This endpoint is not accessible with an API token",
      code: "TOKEN_ENDPOINT_FORBIDDEN",
    });
    return;
  }
  const granted = req.tokenScopes ?? [];
  if (!granted.includes(rule.scope)) {
    res.status(403).json({
      error: "Insufficient token scope",
      code: "INSUFFICIENT_SCOPE",
      required: [rule.scope],
      granted,
    });
    return;
  }
  next();
}
