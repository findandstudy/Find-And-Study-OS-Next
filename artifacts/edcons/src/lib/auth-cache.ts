/**
 * Two-layer auth cache:
 *
 * Layer 1 — module-level in-memory "sticky user":
 *   Set the first time the real API user is resolved, never expires until
 *   page unload. Survives component remounts (e.g. React tree rebuilds on
 *   navigation) because it lives outside React's lifecycle.
 *
 * Layer 2 — localStorage cache with TTL:
 *   Survives hard page reloads (e.g. login redirect) so the layout renders
 *   immediately without waiting for the /api/auth/me round-trip.
 *
 * Both layers are used as `initialData` for useGetMe, so the layout is
 * never blocked by an empty auth state after SPA navigation.
 */

// ─── Layer 1: module-level sticky user (no expiry) ────────────────────────
let _stickyUser: unknown | undefined;

export function getStickyUser(): unknown | undefined {
  return _stickyUser;
}

/** Call this whenever the real API user is resolved (non-null). */
export function setStickyUser(data: unknown): void {
  if (data) _stickyUser = data;
}

export function clearStickyUser(): void {
  _stickyUser = undefined;
}

// ─── Layer 2: localStorage cache with TTL ─────────────────────────────────
const CACHE_KEY = "edcons_auth_v2";
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

interface AuthCacheEntry {
  data: unknown;
  ts: number;
}

export function getAuthCache(): unknown | undefined {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return undefined;
    const entry: AuthCacheEntry = JSON.parse(raw);
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
      window.localStorage.removeItem(CACHE_KEY);
      return undefined;
    }
    return entry.data;
  } catch {
    return undefined;
  }
}

export function setAuthCache(data: unknown): void {
  try {
    const entry: AuthCacheEntry = { data, ts: Date.now() };
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // Ignore quota errors
  }
}

export function clearAuthCache(): void {
  try {
    window.localStorage.removeItem(CACHE_KEY);
    clearStickyUser();
  } catch {
    // Ignore
  }
}
