/**
 * Client-state version guard.
 *
 * Persisted client state (localStorage / sessionStorage written by a PREVIOUS
 * deployed bundle) can be rehydrated by a freshly deployed bundle into a shape
 * the new code does not expect. In the worst case this drives a component into
 * an infinite render loop on load (React minified error #185 — "Maximum update
 * depth exceeded"), which the global ErrorBoundary then surfaces as
 * "Page could not be loaded".
 *
 * A first visit / incognito window (empty storage) is always known-good, so on
 * a version change we reset persisted client state back to that clean baseline.
 * This runs as a side-effect import at the very top of main.tsx, BEFORE React
 * mounts and before any other module reads storage, so the new bundle always
 * boots from a compatible state and can self-heal users stuck after a deploy.
 *
 * Bump CURRENT_VERSION whenever the shape of any persisted client value changes
 * in a way the new code cannot tolerate. This only resets transient client UI
 * state (theme, language, prefs, optimistic auth cache); it does NOT log the
 * user out — the session lives in an http-only cookie, not localStorage.
 */

const VERSION_KEY = "edcons_client_state_version";
const CURRENT_VERSION = "2026-06-06";

export function ensureClientStateVersion(): void {
  try {
    const stored = window.localStorage.getItem(VERSION_KEY);
    if (stored === CURRENT_VERSION) return;

    window.localStorage.clear();
    try {
      window.sessionStorage.clear();
    } catch {
      // sessionStorage may be unavailable independently of localStorage.
    }

    window.localStorage.setItem(VERSION_KEY, CURRENT_VERSION);
  } catch {
    // Storage unavailable (private mode quota, disabled cookies, etc.) —
    // there is nothing persisted to reset, so booting fresh is already safe.
  }
}

ensureClientStateVersion();
