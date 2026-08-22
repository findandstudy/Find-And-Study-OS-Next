import crypto from "node:crypto";

import {
  ACTIVE_CONTEXT_TTL_MS,
} from "./activeTenantContext";
import {
  issueAuthoritativeActiveTenantContext,
  type AuthoritativeActiveContextIssuanceFailure,
  type AuthoritativeActiveContextIssuanceOptions,
} from "./authoritativeActiveContextIssuance";
import { ABSOLUTE_SESSION_TTL } from "./sessionLifetime";

const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const SESSION_ID_RE = /^[0-9a-f]{64}$/i;
const CSRF_TOKEN_RE = /^[0-9a-f]{64}$/i;

export const ACTIVE_CONTEXT_SESSION_GATEWAY_PATH =
  "/api/internal/active-context/issue";
export const ACTIVE_CONTEXT_SESSION_GATEWAY_BUDGET_MS = 8_000;
export const ACTIVE_CONTEXT_RATE_LIMIT_PERMIT_MAX_TTL_MS = 60_000;

type HttpRequestLike = {
  method?: unknown;
  path?: unknown;
  headers?: unknown;
  cookies?: unknown;
  apiTokenAuth?: unknown;
};

export type ActiveContextSessionState = {
  selectionId: string;
  sessionFingerprint: string;
  sessionGeneration: number;
  status: "ACTIVE" | "REVOKED" | "ROTATED";
  accountStatus: "ACTIVE" | "INACTIVE" | "DELETED" | "UNVERIFIED";
  authenticatedPrincipalId: string;
  tenantId: string;
  organizationId: string | null;
  legacyBranchId: number | null;
  issuedAt: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  impersonatorPrincipalId: string | null;
  originalSessionFingerprint: string | null;
};

export interface ActiveContextSessionRepository {
  withLockedCurrentSession(
    input: {
      sessionId: string;
      sessionFingerprint: string;
      observedAt: number;
    },
    operation: (state: unknown) => Promise<string>,
  ): Promise<string>;
}

export type ActiveContextRateLimitInput = {
  operation: "ACTIVE_CONTEXT_ISSUE";
  sessionFingerprint: string;
  sessionGeneration: number;
  authenticatedPrincipalId: string;
  tenantId: string;
  subjectHash: string;
  observedAt: number;
};

export interface ActiveContextIssuanceRateLimiter {
  consume(input: ActiveContextRateLimitInput): Promise<unknown>;
}

export type ActiveContextSessionGatewayFailure =
  | "http_request_invalid"
  | "authorization_header_forbidden"
  | "origin_untrusted"
  | "csrf_invalid"
  | "clock_invalid"
  | "gateway_timeout"
  | "session_repository_unavailable"
  | "session_repository_contract_invalid"
  | "session_missing"
  | "session_state_invalid"
  | "session_inactive"
  | "account_inactive"
  | "session_expired"
  | "session_scope_invalid"
  | "impersonation_forbidden"
  | "rate_limiter_unavailable"
  | "rate_limiter_contract_invalid"
  | "rate_limited"
  | "rate_limit_permit_expired"
  | "authoritative_context_denied";

type IssuanceConfiguration = Omit<
  AuthoritativeActiveContextIssuanceOptions,
  "request" | "now" | "ttlMs"
>;

export type ActiveContextSessionGatewayOptions = {
  request: unknown;
  trustedOrigins: readonly string[];
  sessionRepository: ActiveContextSessionRepository;
  rateLimiter: ActiveContextIssuanceRateLimiter;
  issuance: IssuanceConfiguration;
  tokenTtlMs?: number;
  gatewayBudgetMs?: number;
  now?: () => number;
};

export type ActiveContextSessionGatewayResult =
  | {
      ok: true;
      token: string;
      contextId: string;
      issuedAt: number;
      expiresAt: number;
      rateLimitPermitId: string;
    }
  | {
      ok: false;
      reason: Exclude<
        ActiveContextSessionGatewayFailure,
        "rate_limited" | "authoritative_context_denied"
      >;
    }
  | {
      ok: false;
      reason: "rate_limited";
      retryAfterMs: number;
    }
  | {
      ok: false;
      reason: "authoritative_context_denied";
      authoritativeReason: AuthoritativeActiveContextIssuanceFailure;
    };

class GatewayDenied extends Error {
  constructor(readonly result: ActiveContextSessionGatewayResult & { ok: false }) {
    super(result.reason);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function isUuidV7(value: unknown): value is string {
  return typeof value === "string" && UUID_V7_RE.test(value);
}

function isNullableUuidV7(value: unknown): value is string | null {
  return value === null || isUuidV7(value);
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isBranch(value: unknown): value is number | null {
  return value === null || isPositiveInteger(value);
}

function readHeader(
  headers: Record<string, unknown>,
  name: string,
): { present: boolean; value: string | null; invalid: boolean } {
  const matches = Object.entries(headers).filter(
    ([key]) => key.toLowerCase() === name,
  );
  if (matches.length === 0) return { present: false, value: null, invalid: false };
  if (matches.length !== 1) return { present: true, value: null, invalid: true };
  const value = matches[0][1];
  if (typeof value !== "string" || value.length === 0) {
    return { present: true, value: null, invalid: true };
  }
  return { present: true, value, invalid: false };
}

function parseOrigin(value: string, allowPath: boolean): string | null {
  try {
    const parsed = new URL(value);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      (!allowPath &&
        (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== ""))
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function parseTrustedOrigins(value: unknown): Set<string> | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) return null;
  const parsed = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") return null;
    const origin = parseOrigin(candidate, false);
    if (!origin) return null;
    parsed.add(origin);
  }
  return parsed.size === value.length ? parsed : null;
}

function timingSafeCsrfMatch(cookie: string, header: string): boolean {
  if (!CSRF_TOKEN_RE.test(cookie) || !CSRF_TOKEN_RE.test(header)) return false;
  const cookieBytes = Buffer.from(cookie.toLowerCase(), "ascii");
  const headerBytes = Buffer.from(header.toLowerCase(), "ascii");
  return (
    cookieBytes.length === headerBytes.length &&
    crypto.timingSafeEqual(cookieBytes, headerBytes)
  );
}

function parseSecurityCookies(
  rawCookieHeader: string,
): { sessionId: string; csrfToken: string } | null {
  const values = new Map<string, string[]>();
  for (const segment of rawCookieHeader.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 1) continue;
    const name = segment.slice(0, separator).trim();
    if (name !== "sid" && name !== "csrf_token") continue;
    const value = segment.slice(separator + 1).trim();
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  const sessionIds = values.get("sid") ?? [];
  const csrfTokens = values.get("csrf_token") ?? [];
  if (
    sessionIds.length !== 1 ||
    csrfTokens.length !== 1 ||
    !SESSION_ID_RE.test(sessionIds[0]) ||
    !CSRF_TOKEN_RE.test(csrfTokens[0])
  ) {
    return null;
  }
  return {
    sessionId: sessionIds[0].toLowerCase(),
    csrfToken: csrfTokens[0].toLowerCase(),
  };
}

function parseHttpRequest(
  raw: unknown,
  trustedOrigins: Set<string>,
):
  | { ok: true; sessionId: string }
  | {
      ok: false;
      reason:
        | "http_request_invalid"
        | "authorization_header_forbidden"
        | "origin_untrusted"
        | "csrf_invalid";
    } {
  if (!isRecord(raw)) return { ok: false, reason: "http_request_invalid" };
  const request = raw as HttpRequestLike;
  if (
    request.method !== "POST" ||
    request.path !== ACTIVE_CONTEXT_SESSION_GATEWAY_PATH ||
    !isRecord(request.headers) ||
    !isRecord(request.cookies) ||
    (request.apiTokenAuth !== undefined && request.apiTokenAuth !== false)
  ) {
    return { ok: false, reason: "http_request_invalid" };
  }

  const authorization = readHeader(request.headers, "authorization");
  if (authorization.present) {
    return authorization.invalid
      ? { ok: false, reason: "http_request_invalid" }
      : { ok: false, reason: "authorization_header_forbidden" };
  }
  const csrfHeader = readHeader(request.headers, "x-csrf-token");
  const cookieHeader = readHeader(request.headers, "cookie");
  const originHeader = readHeader(request.headers, "origin");
  const refererHeader = readHeader(request.headers, "referer");
  if (
    csrfHeader.invalid ||
    cookieHeader.invalid ||
    originHeader.invalid ||
    refererHeader.invalid
  ) {
    return { ok: false, reason: "http_request_invalid" };
  }

  const origin = originHeader.value ? parseOrigin(originHeader.value, false) : null;
  const refererOrigin = refererHeader.value
    ? parseOrigin(refererHeader.value, true)
    : null;
  if (
    (originHeader.present && !origin) ||
    (refererHeader.present && !refererOrigin) ||
    (origin && refererOrigin && origin !== refererOrigin)
  ) {
    return { ok: false, reason: "origin_untrusted" };
  }
  const requestOrigin = origin ?? refererOrigin;
  if (!requestOrigin || !trustedOrigins.has(requestOrigin)) {
    return { ok: false, reason: "origin_untrusted" };
  }

  const sessionId = request.cookies.sid;
  const csrfCookie = request.cookies.csrf_token;
  const securityCookies = cookieHeader.value
    ? parseSecurityCookies(cookieHeader.value)
    : null;
  if (
    typeof sessionId !== "string" ||
    !SESSION_ID_RE.test(sessionId) ||
    !securityCookies ||
    securityCookies.sessionId !== sessionId.toLowerCase()
  ) {
    return { ok: false, reason: "http_request_invalid" };
  }
  if (
    typeof csrfCookie !== "string" ||
    !csrfHeader.value ||
    securityCookies.csrfToken !== csrfCookie.toLowerCase() ||
    !timingSafeCsrfMatch(csrfCookie, csrfHeader.value)
  ) {
    return { ok: false, reason: "csrf_invalid" };
  }
  return { ok: true, sessionId: sessionId.toLowerCase() };
}

function parseSessionState(value: unknown): ActiveContextSessionState | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "absoluteExpiresAt",
      "accountStatus",
      "authenticatedPrincipalId",
      "idleExpiresAt",
      "impersonatorPrincipalId",
      "issuedAt",
      "legacyBranchId",
      "organizationId",
      "originalSessionFingerprint",
      "selectionId",
      "sessionFingerprint",
      "sessionGeneration",
      "status",
      "tenantId",
    ]) ||
    !isUuidV7(value.selectionId) ||
    typeof value.sessionFingerprint !== "string" ||
    !SHA256_RE.test(value.sessionFingerprint) ||
    !isPositiveInteger(value.sessionGeneration) ||
    !["ACTIVE", "REVOKED", "ROTATED"].includes(String(value.status)) ||
    !["ACTIVE", "INACTIVE", "DELETED", "UNVERIFIED"].includes(
      String(value.accountStatus),
    ) ||
    !isUuidV7(value.authenticatedPrincipalId) ||
    !isUuidV7(value.tenantId) ||
    !isNullableUuidV7(value.organizationId) ||
    !isBranch(value.legacyBranchId) ||
    (value.legacyBranchId !== null && value.organizationId === null) ||
    !isTimestamp(value.issuedAt) ||
    !isTimestamp(value.idleExpiresAt) ||
    !isTimestamp(value.absoluteExpiresAt) ||
    !isNullableUuidV7(value.impersonatorPrincipalId) ||
    (value.originalSessionFingerprint !== null &&
      (typeof value.originalSessionFingerprint !== "string" ||
        !SHA256_RE.test(value.originalSessionFingerprint))) ||
    ((value.impersonatorPrincipalId === null) !==
      (value.originalSessionFingerprint === null))
  ) {
    return null;
  }
  return {
    selectionId: value.selectionId.toLowerCase(),
    sessionFingerprint: value.sessionFingerprint.toLowerCase(),
    sessionGeneration: Number(value.sessionGeneration),
    status: value.status as ActiveContextSessionState["status"],
    accountStatus: value.accountStatus as ActiveContextSessionState["accountStatus"],
    authenticatedPrincipalId: value.authenticatedPrincipalId.toLowerCase(),
    tenantId: value.tenantId.toLowerCase(),
    organizationId: value.organizationId?.toLowerCase() ?? null,
    legacyBranchId:
      value.legacyBranchId === null ? null : Number(value.legacyBranchId),
    issuedAt: Number(value.issuedAt),
    idleExpiresAt: Number(value.idleExpiresAt),
    absoluteExpiresAt: Number(value.absoluteExpiresAt),
    impersonatorPrincipalId: value.impersonatorPrincipalId?.toLowerCase() ?? null,
    originalSessionFingerprint:
      value.originalSessionFingerprint?.toLowerCase() ?? null,
  };
}

function sessionFingerprint(sessionId: string): string {
  return crypto.createHash("sha256").update(sessionId, "ascii").digest("hex");
}

function rateLimitSubjectHash(state: ActiveContextSessionState): string {
  return crypto
    .createHash("sha256")
    .update("fas.active-context-issuance-rate-limit.v1\0", "utf8")
    .update(state.sessionFingerprint, "ascii")
    .update("\0", "ascii")
    .update(String(state.sessionGeneration), "ascii")
    .update("\0", "ascii")
    .update(state.authenticatedPrincipalId, "ascii")
    .update("\0", "ascii")
    .update(state.tenantId, "ascii")
    .digest("hex");
}

function parsePermit(
  value: unknown,
  expectedSubjectHash: string,
  observedAt: number,
):
  | { allowed: true; permitId: string; expiresAt: number }
  | { allowed: false; retryAfterMs: number }
  | null {
  if (!isRecord(value) || typeof value.allowed !== "boolean") return null;
  if (!value.allowed) {
    if (
      !exactKeys(value, ["allowed", "retryAfterMs"]) ||
      !isPositiveInteger(value.retryAfterMs) ||
      Number(value.retryAfterMs) > 3_600_000
    ) {
      return null;
    }
    return { allowed: false, retryAfterMs: Number(value.retryAfterMs) };
  }
  if (
    !exactKeys(value, [
      "allowed",
      "expiresAt",
      "issuedAt",
      "permitId",
      "subjectHash",
    ]) ||
    !isUuidV7(value.permitId) ||
    typeof value.subjectHash !== "string" ||
    value.subjectHash.toLowerCase() !== expectedSubjectHash ||
    value.issuedAt !== observedAt ||
    !isTimestamp(value.expiresAt) ||
    Number(value.expiresAt) <= observedAt ||
    Number(value.expiresAt) - observedAt >
      ACTIVE_CONTEXT_RATE_LIMIT_PERMIT_MAX_TTL_MS
  ) {
    return null;
  }
  return {
    allowed: true,
    permitId: value.permitId.toLowerCase(),
    expiresAt: Number(value.expiresAt),
  };
}

function assertWithinBudget(now: number, startedAt: number, budget: number) {
  if (!isTimestamp(now) || now < startedAt) {
    throw new GatewayDenied({ ok: false, reason: "clock_invalid" });
  }
  if (now - startedAt > budget) {
    throw new GatewayDenied({ ok: false, reason: "gateway_timeout" });
  }
}

export async function issueActiveContextForHttpSession(
  options: ActiveContextSessionGatewayOptions,
): Promise<ActiveContextSessionGatewayResult> {
  if (
    !options ||
    !isRecord(options.sessionRepository) ||
    typeof options.sessionRepository.withLockedCurrentSession !== "function" ||
    !isRecord(options.rateLimiter) ||
    typeof options.rateLimiter.consume !== "function" ||
    !isRecord(options.issuance) ||
    Object.hasOwn(options.issuance, "request") ||
    Object.hasOwn(options.issuance, "now") ||
    Object.hasOwn(options.issuance, "ttlMs") ||
    (options.now !== undefined && typeof options.now !== "function")
  ) {
    throw new Error("active_context_session_gateway_configuration_invalid");
  }
  const trustedOrigins = parseTrustedOrigins(options.trustedOrigins);
  if (!trustedOrigins) {
    throw new Error("active_context_session_gateway_configuration_invalid");
  }
  const request = parseHttpRequest(options.request, trustedOrigins);
  if (!request.ok) return { ok: false, reason: request.reason };

  const now = options.now ?? Date.now;
  const startedAt = now();
  const gatewayBudget =
    options.gatewayBudgetMs ?? ACTIVE_CONTEXT_SESSION_GATEWAY_BUDGET_MS;
  const requestedTtl = options.tokenTtlMs ?? ACTIVE_CONTEXT_TTL_MS;
  if (!isTimestamp(startedAt)) return { ok: false, reason: "clock_invalid" };
  if (
    !isPositiveInteger(gatewayBudget) ||
    gatewayBudget > 30_000 ||
    !isPositiveInteger(requestedTtl) ||
    requestedTtl > ACTIVE_CONTEXT_TTL_MS
  ) {
    throw new Error("active_context_session_gateway_configuration_invalid");
  }

  const fingerprint = sessionFingerprint(request.sessionId);
  let operationCalls = 0;
  let issued: Extract<ActiveContextSessionGatewayResult, { ok: true }> | undefined;
  try {
    const returned = await options.sessionRepository.withLockedCurrentSession(
      {
        sessionId: request.sessionId,
        sessionFingerprint: fingerprint,
        observedAt: startedAt,
      },
      async (rawState) => {
        operationCalls += 1;
        if (operationCalls !== 1) {
          throw new GatewayDenied({
            ok: false,
            reason: "session_repository_contract_invalid",
          });
        }
        const observedAt = now();
        assertWithinBudget(observedAt, startedAt, gatewayBudget);
        if (rawState === null) {
          throw new GatewayDenied({ ok: false, reason: "session_missing" });
        }
        const state = parseSessionState(rawState);
        if (!state) {
          throw new GatewayDenied({ ok: false, reason: "session_state_invalid" });
        }
        if (state.sessionFingerprint !== fingerprint) {
          throw new GatewayDenied({ ok: false, reason: "session_scope_invalid" });
        }
        if (state.status !== "ACTIVE") {
          throw new GatewayDenied({ ok: false, reason: "session_inactive" });
        }
        if (state.accountStatus !== "ACTIVE") {
          throw new GatewayDenied({ ok: false, reason: "account_inactive" });
        }
        if (
          state.absoluteExpiresAt !== state.issuedAt + ABSOLUTE_SESSION_TTL ||
          state.idleExpiresAt > state.absoluteExpiresAt ||
          state.idleExpiresAt <= state.issuedAt
        ) {
          throw new GatewayDenied({ ok: false, reason: "session_state_invalid" });
        }
        if (
          state.issuedAt > observedAt ||
          observedAt >= state.idleExpiresAt ||
          observedAt >= state.absoluteExpiresAt
        ) {
          throw new GatewayDenied({ ok: false, reason: "session_expired" });
        }
        if (
          state.impersonatorPrincipalId !== null ||
          state.originalSessionFingerprint !== null
        ) {
          throw new GatewayDenied({ ok: false, reason: "impersonation_forbidden" });
        }

        const subjectHash = rateLimitSubjectHash(state);
        let rawPermit: unknown;
        try {
          rawPermit = await options.rateLimiter.consume({
            operation: "ACTIVE_CONTEXT_ISSUE",
            sessionFingerprint: state.sessionFingerprint,
            sessionGeneration: state.sessionGeneration,
            authenticatedPrincipalId: state.authenticatedPrincipalId,
            tenantId: state.tenantId,
            subjectHash,
            observedAt,
          });
        } catch {
          throw new GatewayDenied({ ok: false, reason: "rate_limiter_unavailable" });
        }
        const permit = parsePermit(rawPermit, subjectHash, observedAt);
        if (!permit) {
          throw new GatewayDenied({
            ok: false,
            reason: "rate_limiter_contract_invalid",
          });
        }
        if (!permit.allowed) {
          throw new GatewayDenied({
            ok: false,
            reason: "rate_limited",
            retryAfterMs: permit.retryAfterMs,
          });
        }

        const beforeIssuance = now();
        assertWithinBudget(beforeIssuance, startedAt, gatewayBudget);
        if (beforeIssuance >= permit.expiresAt) {
          throw new GatewayDenied({
            ok: false,
            reason: "rate_limit_permit_expired",
          });
        }
        const sessionBoundedTtl = Math.min(
          requestedTtl,
          state.idleExpiresAt - beforeIssuance,
          state.absoluteExpiresAt - beforeIssuance,
        );
        if (!isPositiveInteger(sessionBoundedTtl)) {
          throw new GatewayDenied({ ok: false, reason: "session_expired" });
        }

        const result = await issueAuthoritativeActiveTenantContext({
          ...options.issuance,
          selectionBinding: {
            selectionId: state.selectionId,
            sessionGeneration: state.sessionGeneration,
          },
          request: {
            authenticatedPrincipalId: state.authenticatedPrincipalId,
            tenantId: state.tenantId,
            organizationId: state.organizationId,
            legacyBranchId: state.legacyBranchId,
          },
          ttlMs: sessionBoundedTtl,
          now,
        });
        if (!result.ok) {
          throw new GatewayDenied({
            ok: false,
            reason: "authoritative_context_denied",
            authoritativeReason: result.reason,
          });
        }
        const completedAt = now();
        assertWithinBudget(completedAt, startedAt, gatewayBudget);
        if (completedAt >= permit.expiresAt) {
          throw new GatewayDenied({
            ok: false,
            reason: "rate_limit_permit_expired",
          });
        }
        if (
          result.expiresAt > state.idleExpiresAt ||
          result.expiresAt > state.absoluteExpiresAt
        ) {
          throw new GatewayDenied({
            ok: false,
            reason: "session_repository_contract_invalid",
          });
        }
        issued = {
          ...result,
          rateLimitPermitId: permit.permitId,
        };
        return result.token;
      },
    );
    if (
      operationCalls !== 1 ||
      !issued ||
      returned !== issued.token
    ) {
      return { ok: false, reason: "session_repository_contract_invalid" };
    }
    return issued;
  } catch (error) {
    if (error instanceof GatewayDenied) return error.result;
    return {
      ok: false,
      reason:
        operationCalls === 0
          ? "session_repository_unavailable"
          : "session_repository_contract_invalid",
    };
  }
}
