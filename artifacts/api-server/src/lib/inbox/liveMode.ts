/**
 * Production-only configuration discipline.
 * Returns true when live third-party integrations should be writable / sendable.
 *
 * - In production: always true.
 * - Otherwise: only when ALLOW_LIVE_INTEGRATIONS=true is explicitly set.
 *
 * Webhooks (inbound) work in every environment regardless of this flag, so
 * developers can still test signature/HMAC verification and inbound flows.
 * Outbound calls (sending WhatsApp, etc.) are simulated when this is false.
 */
export function isLiveIntegrationsEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return true;
  return process.env.ALLOW_LIVE_INTEGRATIONS === "true";
}

export function liveModeReason(): string {
  if (isLiveIntegrationsEnabled()) return "live";
  return "simulated (development; set ALLOW_LIVE_INTEGRATIONS=true to override)";
}
