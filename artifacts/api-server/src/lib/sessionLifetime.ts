export const ABSOLUTE_SESSION_TTL = 24 * 60 * 60 * 1000;

export function resolveSessionIssuedAt(value: unknown, now = Date.now()): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= now
    ? value
    : now;
}

export function getAbsoluteSessionExpiry(issuedAt: number): number {
  return issuedAt + ABSOLUTE_SESSION_TTL;
}

export function isAbsoluteSessionExpired(issuedAt: number, now = Date.now()): boolean {
  return now >= getAbsoluteSessionExpiry(issuedAt);
}

export function getBoundedSessionExpiry(
  issuedAt: number,
  idleTtlMs: number,
  now = Date.now(),
): number {
  return Math.min(now + idleTtlMs, getAbsoluteSessionExpiry(issuedAt));
}

export function getRemainingSessionCookieTtl(
  issuedAt: number,
  idleTtlMs: number,
  now = Date.now(),
): number {
  return Math.max(0, Math.min(idleTtlMs, getAbsoluteSessionExpiry(issuedAt) - now));
}
