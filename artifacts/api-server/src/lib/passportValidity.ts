/**
 * passportValidity — pure helpers for passport expiry checks (FAZ 2).
 *
 * Policy (user decision): threshold is TODAY (00:00 UTC), no buffer.
 * Unparseable dates are NOT blocked (fail-open) — we only hard-block
 * when we can positively determine the passport has expired.
 *
 * SINGLE SOURCE: the implementation lives in
 * @workspace/portal-adapters (lib/portal-adapters/src/identityValidation.ts)
 * so the api-server, worker, and portal-runner all share the exact same
 * date-parsing and expiry logic. This module only re-exports it to keep
 * existing api-server import paths working.
 */
export { parseFlexibleDate, isPassportExpired } from "@workspace/portal-adapters";
