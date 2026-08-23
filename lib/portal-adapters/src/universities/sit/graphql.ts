// ---------------------------------------------------------------------------
// SIT portal — READ-ONLY GraphQL client
//
// SIT exposes a GraphQL endpoint at POST /api/graphql (Supabase pg_graphql over
// Zoho-synced tables). We use it for read-only lookups (idempotency + catalog)
// AND to CREATE the application record via the `InsertApplication` mutation
// (insertIntozoho_applicationsCollection) — replacing the brittle UI "Add
// Application" flow. Student creation still goes through the "Add Student" UI
// wizard. Mutations run in REAL mode only; DRY never calls them.
//
// AUTH: a session cookie alone is not enough — SIT (Laravel/axios SPA) also
// wants the `X-XSRF-TOKEN` header echoed from the XSRF-TOKEN cookie and, when
// present, an `Authorization: Bearer` token the app keeps in web storage. The
// symptom of the missing header/token is a 200 response with `data: null`
// (never surfaced as an auth error), which used to be logged as "shape
// mismatch — null". `collectAuth` gathers both (XSRF from the browser context
// cookie jar, bearer from local/sessionStorage) and we send them via TWO
// transports, tried in order until one returns usable data:
//   1) page.request.post + the auth headers + Origin/Referer — CORS-immune and
//      the transport we KNOW reaches the server (it returned 200 in prod); the
//      only thing it lacked before was the XSRF/bearer headers.
//   2) an in-page window.fetch (credentials:"include") to a RELATIVE path so it
//      is always same-origin — the SPA-faithful fallback if (1) is rejected. A
//      cross-origin ABSOLUTE URL here is what made the earlier in-page fetch
//      throw and silently fall back to a cookie-only request.
//
// Every response is validated with zod and narrowed to a typed shape; on any
// network error, GraphQL error, or shape mismatch the helpers return null/[]
// so the adapter can fall back to scanning the UI (graceful degradation —
// the live schema may evolve). Diagnostics log the HTTP status, whether the
// XSRF/bearer credentials were attached, any GraphQL `errors`, and the
// PII-redacted response STRUCTURE so a real auth/schema problem is visible.
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { Page } from "playwright-core";
import { logger } from "../../browser.js";
import { fold } from "../../programMatch.js";
import type { ProgramCandidate } from "../../programMatch.js";
import {
  distinctiveTokens,
  evaluateSitIdentity,
  normalizeSitPassport,
} from "./helpers.js";
import { SIT_URLS } from "./selectors.js";

const GRAPHQL_PATH = "/api/graphql";

// SIT authenticates GraphQL with a Supabase access_token. The Supabase project
// (auth + rest) lives here; the token endpoint mints an access_token from the
// SIT email/password (the same portal_credentials used for the UI login).
const SUPABASE_URL = "https://knqtjanxjwfjfrwoater.supabase.co";
const SUPABASE_TOKEN_PATH = "/auth/v1/token?grant_type=password";
// Supabase project ref (the subdomain). The SPA reads its session from the
// localStorage key `sb-<ref>-auth-token`; we write it there in a probe page to
// authenticate the SPA and observe its REAL /api/graphql requests.
const SUPABASE_PROJECT_REF = "knqtjanxjwfjfrwoater";

// A bare (unprefixed) JWT — used to validate a minted/captured access_token.
const JWT_RE = /^ey[\w-]+\.[\w-]+\.[\w-]+$/;

// ---------------------------------------------------------------------------
// Supabase auth for GraphQL.
//
// DEFINITIVE approach (mintSupabaseBearer): the adapter's headless SPA login
// does NOT produce a real Supabase session — it reaches the app but the heavy
// SPA login never authenticates, so no access_token is ever written to storage
// and no authenticated /api/graphql request is fired to intercept. Three prior
// approaches (storage read, poll+cookie, SPA header capture) all failed for
// this reason. Instead we BYPASS the SPA login and mint an access_token
// directly from Supabase Auth: capture the public anon `apikey` the SPA sends
// on its own *.supabase.co requests, then POST it with the SIT email/password
// to /auth/v1/token?grant_type=password. The returned access_token is the
// Bearer the GraphQL endpoint needs.
//
// The passive SPA-header capture and web-storage reads are retained only as
// best-effort fallbacks. All tokens/keys are held in memory only (keyed weakly
// by page) and are NEVER logged (only bearer=true/false + HTTP status).
// ---------------------------------------------------------------------------
const capturedBearerByPage = new WeakMap<Page, string>();
const capturedAnonKeyByPage = new WeakMap<Page, string>();
const captureInstalledPages = new WeakSet<Page>();
// The FULL Supabase session JSON from the password grant (access_token +
// refresh_token + expires_at + user …). Retained ONLY to inject into a
// throwaway probe page so the SPA authenticates and fires its REAL /api/graphql
// requests, which we capture to learn the exact query this route expects. Held
// in memory, keyed weakly by page; NEVER logged.
const capturedSessionByPage = new WeakMap<Page, Record<string, unknown>>();
// The SPA's OWN /api/graphql request bodies, captured PASSIVELY during natural
// navigation (keyed by operationName so each distinct op is kept once). This is
// the most reliable source of the route's real query shape — no session
// injection needed — because the SPA fires these itself after login.
const capturedRealGqlByPage = new WeakMap<Page, Map<string, string>>();
// Guards the one-shot real-request capture (per page).
const graphqlCaptureAttempted = new WeakSet<Page>();
// Guards the one-shot pg_graphql introspection log (per page).
const introspectionLogged = new WeakSet<Page>();

// Matches "Bearer <jwt>" and captures the bare JWT (group 1).
const BEARER_JWT_RE = /^bearer\s+(ey[\w-]+\.[\w-]+\.[\w-]+)\s*$/i;

/**
 * Attach a one-time network listener that captures (a) the Bearer token the SPA
 * sends on its own /api/graphql requests and (b) the public anon `apikey`
 * header the SPA sends on its *.supabase.co requests (needed to mint a token).
 * Idempotent per page. Call as early as possible after opening the portal so
 * both are captured during natural navigation before our first GraphQL call.
 */
export function installSpaAuthCapture(page: Page): void {
  if (captureInstalledPages.has(page)) return;
  captureInstalledPages.add(page);
  page.on("request", (req) => {
    try {
      const url = req.url();
      // (b) public anon apikey from any Supabase request (never logged).
      if (url.includes(".supabase.co") && !capturedAnonKeyByPage.has(page)) {
        const key = req.headers()["apikey"];
        if (typeof key === "string" && key) capturedAnonKeyByPage.set(page, key);
      }
      // (a) Bearer from the SPA's own graphql calls (fallback source) AND the
      //     request BODY (query+variables+operationName) so we can learn the
      //     exact shape this Zoho-backed route expects. Deduped by op.
      if (url.includes(GRAPHQL_PATH)) {
        const authz = req.headers()["authorization"];
        const m = typeof authz === "string" ? authz.match(BEARER_JWT_RE) : null;
        if (m) capturedBearerByPage.set(page, m[1]);
        if (req.method() === "POST") {
          const b = req.postData();
          if (b) {
            let store = capturedRealGqlByPage.get(page);
            if (!store) {
              store = new Map<string, string>();
              capturedRealGqlByPage.set(page, store);
            }
            const op = extractOperationName(b) ?? `#${store.size}`;
            if (!store.has(op)) store.set(op, b);
          }
        }
      }
    } catch {
      /* header read failed — ignore, other requests may still be captured */
    }
  });
}

/**
 * Resolve the public anon apikey — from the passive capture, or by waiting once
 * (bounded) for the SPA to fire a *.supabase.co request carrying it. Returns
 * null if none is observed. The key value is NEVER logged.
 */
async function resolveAnonKey(page: Page): Promise<string | null> {
  let key = capturedAnonKeyByPage.get(page);
  if (key) return key;
  try {
    const req = await page.waitForRequest(
      (r) => r.url().includes(".supabase.co") && !!r.headers()["apikey"],
      { timeout: 12_000 },
    );
    const k = req.headers()["apikey"];
    if (typeof k === "string" && k) {
      capturedAnonKeyByPage.set(page, k);
      key = k;
    }
  } catch {
    /* no supabase request observed */
  }
  return key ?? capturedAnonKeyByPage.get(page) ?? null;
}

/**
 * Log the login-page state (URL + storage/cookie KEY NAMES only, plus a
 * screenshot to /tmp) when auth fails, so we can see WHERE the adapter is and
 * whether it is authenticated — WITHOUT ever logging any secret value.
 */
async function logSitLoginDiagnostics(page: Page): Promise<void> {
  try {
    const info = await page
      .evaluate(() => {
        let lsKeys: string[] = [];
        try {
          lsKeys = Object.keys(window.localStorage);
        } catch {
          /* access denied */
        }
        let cookieKeys: string[] = [];
        try {
          cookieKeys = document.cookie
            .split(";")
            .map((x) => x.trim().split("=")[0])
            .filter(Boolean);
        } catch {
          /* access denied */
        }
        return { lsKeys, cookieKeys };
      })
      .catch(() => ({ lsKeys: [] as string[], cookieKeys: [] as string[] }));
    logger.warn(
      `[sit:auth] tanı — sayfa: ${page.url()}; localStorage anahtarları: [${
        info.lsKeys.join(", ") || "yok"
      }]; cookie anahtarları: [${info.cookieKeys.join(", ") || "yok"}]`,
    );
    await page
      .screenshot({ path: "/tmp/sit-login-state.png" })
      .catch(() => {});
  } catch {
    /* diagnostics are best-effort */
  }
}

// ---------------------------------------------------------------------------
// Process-level Supabase session cache — SINGLE-SESSION REUSE.
//
// The submission pipeline opens a FRESH browser page per application, so a
// per-page token (capturedBearerByPage) was minted again for EVERY submission.
// In a batch that means many /auth/token calls in a short window — exactly what
// tripped SIT's bot-protection / rate-limit. We now cache the minted Supabase
// session at MODULE scope, keyed by the (lowercased) account email, and reuse it
// across every page/submission in this worker process. The password grant runs
// at most ONCE per process (until expiry); afterwards we reuse the cached
// access_token or refresh it with the refresh_token — never re-login.
//
// Token acquisition order (first that succeeds wins):
//   1) fresh cached session (reuse)               — no network
//   2) refresh_token grant on the cached session  — no re-login
//   3) operator-injected env token (SIT_ACCESS_TOKEN / SIT_REFRESH_TOKEN)
//   4) password grant (email/password)            — the primary mint
// The UI login FORM is NEVER submitted here (that is the adapter's last resort).
//
// Nothing here is ever logged as a value — only "acquired / refreshed / reused /
// expired" state + HTTP status. Everything is held in memory only.
// ---------------------------------------------------------------------------
interface CachedSitSession {
  accessToken: string;
  refreshToken?: string;
  /** Absolute expiry (ms since epoch); 0 when the grant did not report one. */
  expiresAtMs: number;
  /** Raw grant body — kept ONLY for probe-page injection; never logged. */
  raw?: Record<string, unknown>;
}
const sitSessionByAccount = new Map<string, CachedSitSession>();
// Supabase rotates refresh tokens. When a batch starts several SIT submissions
// at once, two pages can otherwise refresh the same token concurrently: the
// first request rotates it and the second receives HTTP 400, leaving that
// page's SPA session stale and sending `/students` back to `/auth/login`.
// Serialize every token-cache mutation per account while still allowing
// different SIT accounts to authenticate independently.
const sitAuthTailByAccount = new Map<string, Promise<void>>();
// The public anon apikey, cached once observed (from env or a page capture) so
// later pages/submissions can mint without re-capturing. Public value; not a
// secret, but still never logged.
let cachedAnonKey: string | null = null;
// Refresh a token this many ms BEFORE its reported expiry (clock-skew guard).
const SIT_TOKEN_SKEW_MS = 60_000;

/**
 * Run a token-cache operation exclusively for one SIT account.
 *
 * Exported for a deterministic concurrency regression test; callers outside
 * this module should normally use `getSitAccessToken` instead.
 */
export async function runSitAuthExclusive<T>(
  account: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = account.trim().toLowerCase();
  const previous = sitAuthTailByAccount.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => gate);
  sitAuthTailByAccount.set(key, tail);

  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (sitAuthTailByAccount.get(key) === tail) {
      sitAuthTailByAccount.delete(key);
    }
  }
}

/** The Supabase auth origin — env override or the hard-coded project URL. */
function sitSupabaseUrl(): string {
  const v = process.env.SIT_SUPABASE_URL?.trim();
  return v && /^https?:\/\//i.test(v) ? v.replace(/\/+$/, "") : SUPABASE_URL;
}

/** The public anon apikey from env (SIT_SUPABASE_ANON_KEY), if configured. */
function envAnonKey(): string | null {
  const v = process.env.SIT_SUPABASE_ANON_KEY?.trim();
  return v && v.length > 0 ? v : null;
}

/**
 * Pick the public anon Supabase apikey out of arbitrary text (HTML or a JS
 * bundle). The anon key is a JWT whose payload carries `role:"anon"` and the
 * project `ref`; we prefer an exact project-ref match and fall back to any
 * anon-role JWT. The VALUE is never logged (public, but treated as sensitive).
 */
export function extractAnonJwt(text: string): string | null {
  const matches = text.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g);
  if (!matches) return null;
  let anonFallback: string | null = null;
  for (const jwt of matches) {
    try {
      const seg = jwt.split(".")[1];
      const json = JSON.parse(
        Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
          "utf8",
        ),
      ) as { role?: unknown; ref?: unknown };
      if (json && json.role === "anon") {
        if (json.ref === SUPABASE_PROJECT_REF) return jwt;
        anonFallback = anonFallback ?? jwt;
      }
    } catch {
      /* not a decodable JWT payload — skip */
    }
  }
  return anonFallback;
}

/**
 * Collect the JS assets referenced by the SPA root HTML — <script src> and
 * <link href> (modulepreload) — as absolute URLs, deduped and capped. Only
 * SAME-ORIGIN assets are kept (SSRF / supply-chain guard): the SPA serves its
 * own bundles from its origin, and we must never fetch a third-party URL that
 * happens to appear in the markup. Order is preserved so the scan is stable.
 */
export function selectBundleUrls(html: string, limit = 48): string[] {
  const base = SIT_URLS.base;
  let baseOrigin: string;
  try {
    baseOrigin = new URL(base).origin;
  } catch {
    baseOrigin = base;
  }
  const refs = [
    ...html.matchAll(/<script[^>]+src=["']([^"']+\.js[^"']*)["']/gi),
    ...html.matchAll(/<link[^>]+href=["']([^"']+\.js[^"']*)["']/gi),
  ].map((m) => m[1]);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of refs) {
    let abs: string;
    try {
      abs = new URL(raw, base + "/").toString();
    } catch {
      continue;
    }
    try {
      if (new URL(abs).origin !== baseOrigin) continue;
    } catch {
      continue;
    }
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Deterministically obtain the public anon apikey WITHOUT logging in: fetch the
 * SPA root HTML and its referenced JS bundles (public, same-origin static
 * assets) and regex the embedded anon JWT out of them. Bounded (few requests);
 * returns null if the key can't be found. No browser page required. The
 * anon-key chunk is often deep in the list (a vendor chunk), so we scan the
 * whole capped set and stop at the first match. Only runs once per process
 * (the result is cached in `cachedAnonKey`).
 */
async function anonKeyFromBundle(): Promise<string | null> {
  const base = SIT_URLS.base;
  const get = async (u: string): Promise<string | null> => {
    try {
      const res = await fetch(u, {
        headers: { accept: "text/html,application/javascript,*/*" },
        signal: AbortSignal.timeout(12_000),
      });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  };
  const html = await get(base + "/");
  if (!html) return null;
  // 1) The key may sit inline in the HTML (bootstrapped config).
  const inline = extractAnonJwt(html);
  if (inline) return inline;
  // 2) Otherwise scan the same-origin JS assets the page references.
  for (const abs of selectBundleUrls(html)) {
    const js = await get(abs);
    if (!js) continue;
    const key = extractAnonJwt(js);
    if (key) return key;
  }
  return null;
}

function isFreshSitSession(s: CachedSitSession): boolean {
  return (
    JWT_RE.test(s.accessToken) &&
    (s.expiresAtMs === 0 || s.expiresAtMs - Date.now() > SIT_TOKEN_SKEW_MS)
  );
}

/** Persist a grant/refresh body as the cached session. Returns it, or null. */
function storeSitSession(
  email: string,
  body: Record<string, unknown>,
): CachedSitSession | null {
  const access = body.access_token;
  if (typeof access !== "string" || !JWT_RE.test(access)) return null;
  const refresh =
    typeof body.refresh_token === "string" ? body.refresh_token : undefined;
  let expiresAtMs = 0;
  if (typeof body.expires_at === "number") expiresAtMs = body.expires_at * 1000;
  else if (typeof body.expires_in === "number")
    expiresAtMs = Date.now() + body.expires_in * 1000;
  const s: CachedSitSession = {
    accessToken: access,
    refreshToken: refresh,
    expiresAtMs,
    raw: body,
  };
  sitSessionByAccount.set(email.toLowerCase(), s);
  return s;
}

/**
 * POST to the Supabase token endpoint (password | refresh_token grant) using the
 * process-global fetch — decoupled from any browser page so it can run once and
 * be reused across submissions. Returns the parsed body on 2xx, else null. Never
 * logs the apikey, the credentials, or the returned tokens (only grant + status).
 */
async function sitTokenGrant(
  anonKey: string,
  grant: "password" | "refresh_token",
  payload: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  const url = `${sitSupabaseUrl()}/auth/v1/token?grant_type=${grant}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { apikey: anonKey, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const status = res.status;
    if (!res.ok) {
      logger.warn(
        `[sit:auth] Supabase ${grant} grant başarısız (status=${status})`,
      );
      return null;
    }
    return (await res.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
  } catch (e) {
    logger.warn(
      `[sit:auth] Supabase ${grant} grant hata: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return null;
  }
}

/**
 * True when a token can be minted/reused WITHOUT a browser page (i.e. no anon-key
 * capture is required): a fresh cached session, a refreshable session with a
 * known anon key, an injected env token, or a known anon key for a password
 * grant. Lets the adapter decide whether it still needs to load a page.
 */
export function sitCanAuthWithoutPage(creds: { user: string }): boolean {
  const cached = sitSessionByAccount.get(creds.user.toLowerCase());
  if (cached && isFreshSitSession(cached)) return true;
  const anon = envAnonKey() ?? cachedAnonKey;
  if (cached?.refreshToken && anon) return true;
  const injected = process.env.SIT_ACCESS_TOKEN?.trim();
  if (injected && JWT_RE.test(injected)) return true;
  return !!anon;
}

/**
 * Resolve a usable Supabase access_token for the SIT account, minting/refreshing
 * at most once per process (single-session reuse). See the acquisition order in
 * the section header. `page` is optional and used ONLY to capture the public anon
 * apikey when it is not provided via env. Returns null when no token could be
 * obtained (the caller may fall back to the UI login as a last resort).
 */
async function getSitAccessTokenUnlocked(
  creds: { user: string; password: string },
  page?: Page,
  forceRefresh = false,
): Promise<string | null> {
  const email = creds.user.toLowerCase();

  // 1) Reuse a still-fresh cached session — no network, no re-login.
  const cached = sitSessionByAccount.get(email);
  if (!forceRefresh && cached && isFreshSitSession(cached)) {
    return cached.accessToken;
  }

  // Resolve the public anon apikey deterministically, WITHOUT logging in:
  //   env > process cache > SPA-boot capture (page) > JS-bundle regex.
  // The bundle path needs no page and is the reliable fallback when the SPA
  // only fires its *.supabase.co request after login (chicken-and-egg).
  let anonKey = envAnonKey() ?? cachedAnonKey;
  if (!anonKey && page) {
    anonKey = await resolveAnonKey(page);
    if (anonKey) logger.info("[sit:auth] anon key captured via SPA-boot");
  }
  if (!anonKey) {
    anonKey = await anonKeyFromBundle();
    if (anonKey) logger.info("[sit:auth] anon key captured via JS bundle");
  }
  if (anonKey) cachedAnonKey = anonKey;

  // 2) Refresh the cached session without re-login.
  if (cached?.refreshToken && anonKey) {
    const body = await sitTokenGrant(anonKey, "refresh_token", {
      refresh_token: cached.refreshToken,
    });
    const s = body ? storeSitSession(email, body) : null;
    if (s) {
      logger.info("[sit:auth] token yenilendi (refresh_token, re-login yok)");
      return s.accessToken;
    }
  }

  // 3) Operator-injected env token (recovery path if the grant is ever blocked).
  const injected = process.env.SIT_ACCESS_TOKEN?.trim();
  const injectedValid = !!injected && JWT_RE.test(injected);
  if (injectedValid) {
    const s = storeSitSession(email, {
      access_token: injected,
      refresh_token: process.env.SIT_REFRESH_TOKEN?.trim() || undefined,
    });
    if (s) {
      logger.info("[sit:auth] enjekte edilen SIT_ACCESS_TOKEN kullanılıyor");
      return s.accessToken;
    }
  }
  // Refresh via env refresh token whenever the injected access token is absent
  // OR invalid (a non-JWT SIT_ACCESS_TOKEN must not block this fallback).
  const injectedRefresh = process.env.SIT_REFRESH_TOKEN?.trim();
  if (!injectedValid && injectedRefresh && anonKey) {
    const body = await sitTokenGrant(anonKey, "refresh_token", {
      refresh_token: injectedRefresh,
    });
    const s = body ? storeSitSession(email, body) : null;
    if (s) {
      logger.info(
        "[sit:auth] enjekte edilen SIT_REFRESH_TOKEN ile token alındı",
      );
      return s.accessToken;
    }
  }

  // 4) Password grant — the primary mint. Runs at most once per process/expiry.
  if (!anonKey) {
    logger.warn(
      "[sit:auth] anon apikey yok (SIT_SUPABASE_ANON_KEY veya sayfa capture gerekli) — password grant atlanıyor",
    );
    return null;
  }
  const body = await sitTokenGrant(anonKey, "password", {
    email: creds.user,
    password: creds.password,
  });
  const s = body ? storeSitSession(email, body) : null;
  if (s) {
    logger.info("[sit:auth] token acquired via password grant");
    return s.accessToken;
  }
  return null;
}

/**
 * Resolve a usable SIT access token with account-level refresh serialization.
 * `forceRefresh` is reserved for verified UI-session loss: it skips the fresh
 * cache fast-path, rotates the refresh token once (or falls back to a password
 * grant), and gives the affected page a new full Supabase session to seed.
 */
export async function getSitAccessToken(
  creds: { user: string; password: string },
  page?: Page,
  forceRefresh = false,
): Promise<string | null> {
  return runSitAuthExclusive(creds.user, () =>
    getSitAccessTokenUnlocked(creds, page, forceRefresh),
  );
}

/**
 * PRIMARY auth path — ensure a Supabase Bearer is available for the given page,
 * delegating to the process-level token manager (getSitAccessToken). Stores the
 * token in capturedBearerByPage (so collectAuth picks it up as the primary
 * Bearer) plus the full grant body in capturedSessionByPage (for the throwaway
 * probe page that learns the route's real query shape). The process cache makes
 * this idempotent without trusting a page's older captured bearer: a long-lived
 * page may still hold an expired token after another page refreshes the shared
 * session. Non-fatal — on any failure it logs diagnostics (never a secret) and
 * returns false so the caller falls back to the passive capture / storage read /
 * UI scan.
 */
export async function mintSupabaseBearer(
  page: Page,
  creds: { user: string; password: string },
  forceRefresh = false,
): Promise<boolean> {
  installSpaAuthCapture(page);

  const token = await getSitAccessToken(creds, page, forceRefresh);
  if (!token) {
    await logSitLoginDiagnostics(page);
    return false;
  }
  capturedBearerByPage.set(page, token);
  // Keep the FULL session so we can inject it into a probe page and learn the
  // route's real GraphQL query shape. Never logged.
  const cached = sitSessionByAccount.get(creds.user.toLowerCase());
  if (cached?.raw) capturedSessionByPage.set(page, cached.raw);
  return true;
}

// Tracks the last Supabase session value seeded into each page's localStorage,
// so we only (re)install the init script when the session actually changes
// (avoids stacking identical scripts on every ensureLoggedIn call).
const spaSessionSeededByPage = new WeakMap<Page, string>();

/**
 * Seed the minted Supabase session into the PAGE's own localStorage so the SIT
 * SPA boots already-authenticated instead of redirecting the UI wizard (student
 * detail / document upload) to `/auth/login`.
 *
 * Why this is needed: the adapter authenticates GraphQL with a Supabase bearer
 * minted via a token grant (getSitAccessToken) — it NEVER logs into the SPA, so
 * the browser has no `sb-<ref>-auth-token` in localStorage. Any UI route the
 * runner then opens (the wizard's student-detail page, required for the
 * file-chooser document/photo upload) sees no SPA session and bounces to the
 * captcha'd `/auth/login`, so the upload can never run. We already hold the full
 * Supabase session (the grant body, refreshed in lockstep with the bearer); this
 * writes it into localStorage in the exact gotrue-js v2 shape the SPA reads.
 *
 * Uses `page.addInitScript` (not `evaluate`) deliberately: the SPA reads the
 * session on boot BEFORE its own scripts run, so the value must be present
 * before the next navigation — addInitScript runs prior to every page load, so
 * every subsequent `page.goto` (all the openStudentDetail attempts) boots
 * authenticated. Idempotent per session value; non-fatal (returns false on any
 * failure so the caller proceeds unchanged). Never logs the session/token.
 */
export async function seedSpaSession(
  page: Page,
  creds: { user: string; password: string },
): Promise<boolean> {
  // Ensure a fresh session is cached (cache hit = no network / no re-login).
  const token = await getSitAccessToken(creds, page);
  if (!token) return false;
  const cached = sitSessionByAccount.get(creds.user.toLowerCase());
  const raw = cached?.raw;
  if (!raw) return false;

  const key = `sb-${SUPABASE_PROJECT_REF}-auth-token`;
  const value = JSON.stringify(raw);
  // Already seeded this exact session on this page — nothing to do.
  if (spaSessionSeededByPage.get(page) === value) return true;

  try {
    await page.addInitScript(
      ([k, v]) => {
        try {
          window.localStorage.setItem(k as string, v as string);
        } catch {
          /* storage blocked — SPA will fall back to /auth/login */
        }
      },
      [key, value] as [string, string],
    );
    spaSessionSeededByPage.set(page, value);
    logger.info(
      "[sit:auth] SPA oturumu localStorage'a seed edildi (sb-<ref>-auth-token) — UI wizard artık /auth/login'e düşmemeli",
    );
    return true;
  } catch (e) {
    logger.warn(
      `[sit:auth] SPA oturumu seed edilemedi — ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// One-shot diagnostic — learn the route's REAL GraphQL query shape.
//
// Our own /api/graphql calls return HTTP 200 `{"data":null}` even with a valid
// Bearer + apikey: auth is fine, but the query/operationName/variables we send
// don't match what this (Zoho-backed) route expects. To discover the exact
// shape, inject the minted Supabase session into a THROWAWAY probe page so the
// SPA authenticates, navigate it to a data page, and capture the SPA's own
// /api/graphql POST bodies (query + variables + operationName). Bodies are
// logged PII-masked (rawForLog). Runs at most once per page and only touches a
// separate page, so it never disturbs the main submission flow. Best-effort.
// ---------------------------------------------------------------------------
function extractOperationName(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as {
      operationName?: unknown;
      query?: unknown;
    };
    if (typeof parsed.operationName === "string" && parsed.operationName) {
      return parsed.operationName;
    }
    if (typeof parsed.query === "string") {
      const m = parsed.query.match(/\b(?:query|mutation)\s+(\w+)/);
      if (m) return m[1];
    }
  } catch {
    /* not JSON — no operation name */
  }
  return null;
}

// Log each DISTINCT captured /api/graphql body once (PII-masked), so the real
// student-search / program-listing queries are visible for reuse.
function logRealGqlBodies(source: string, bodies: Iterable<string>): void {
  const seen = new Set<string>();
  for (const body of bodies) {
    const op = extractOperationName(body) ?? "?";
    if (seen.has(op)) continue;
    seen.add(op);
    logger.info(
      `[sit:graphql] capture(${source}): REAL request op=${op} body=${rawForLog(
        body,
        900,
      )}`,
    );
    if (seen.size >= 8) break;
  }
}

async function captureRealGraphqlOnce(page: Page): Promise<void> {
  if (graphqlCaptureAttempted.has(page)) return;
  graphqlCaptureAttempted.add(page);

  // PRIMARY — the SPA's OWN /api/graphql requests observed passively during
  // natural navigation (installSpaAuthCapture). No injection needed; if the SPA
  // already fired requests after login, this is the true query shape verbatim.
  const passive = capturedRealGqlByPage.get(page);
  if (passive && passive.size > 0) {
    logRealGqlBodies("passive", passive.values());
    return;
  }

  // FALLBACK — inject the minted session into a throwaway probe page so the SPA
  // authenticates, then capture the /api/graphql requests it fires.
  const session = capturedSessionByPage.get(page);
  if (!session) {
    logger.warn(
      "[sit:graphql] capture: no SPA request seen passively and no minted session to inject — cannot learn real query shape",
    );
    return;
  }

  let probe: Page | null = null;
  try {
    probe = await page.context().newPage();
    await probe.addInitScript(
      ([key, value]) => {
        try {
          window.localStorage.setItem(key as string, value as string);
        } catch {
          /* storage blocked */
        }
      },
      [`sb-${SUPABASE_PROJECT_REF}-auth-token`, JSON.stringify(session)] as [
        string,
        string,
      ],
    );

    const captured: string[] = [];
    probe.on("request", (req) => {
      try {
        if (req.url().includes(GRAPHQL_PATH) && req.method() === "POST") {
          const b = req.postData();
          if (b) captured.push(b);
        }
      } catch {
        /* postData read failed — ignore */
      }
    });

    await probe
      .goto(SIT_URLS.base + SIT_URLS.studentsPath, {
        waitUntil: "networkidle",
        timeout: 30_000,
      })
      .catch(() => {});
    // Give any late XHRs a moment to fire.
    await probe.waitForTimeout(2_500).catch(() => {});

    if (captured.length === 0) {
      logger.warn(
        "[sit:graphql] capture: authed probe fired NO /api/graphql POST — session injection may not have authenticated the SPA",
      );
      return;
    }
    logRealGqlBodies("probe", captured);
  } catch (e) {
    logger.warn(
      `[sit:graphql] capture: hata ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  } finally {
    if (probe) await probe.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Redact PII value-keys so the STRUCTURE of a response is safe to log. Program
// / university names are deliberately NOT redacted (they are catalog data, not
// PII, and are needed to debug shape/matching), but any student identifier is.
// ---------------------------------------------------------------------------
function redactedStringify(value: unknown, max = 1000): string {
  try {
    const raw = JSON.stringify(value, (k, v) =>
      /email|passport|phone|password|token|address|tckn|national|firstname|lastname|surname|fullname|dob|birth/i.test(
        k,
      )
        ? "[redacted]"
        : v,
    );
    if (raw == null) return String(value);
    return raw.length > max ? `${raw.slice(0, max)}…(truncated)` : raw;
  } catch {
    return "(unserializable)";
  }
}

// ---------------------------------------------------------------------------
// Produce a PII-masked, length-capped view of a RAW response body for logging.
// Parses JSON and reuses redactedStringify (so student email/name/passport are
// stripped by key) and, failing that, masks JWT-looking substrings from the
// raw text. Used to surface the ACTUAL server body (e.g. `{"data":null}` vs
// `{"data":{"students":null}}` vs `{"errors":[...]}`) when a call doesn't
// return usable data, without ever leaking a token or student PII.
// ---------------------------------------------------------------------------
function rawForLog(bodyText: string, max = 500): string {
  if (!bodyText) return "(empty)";
  try {
    return redactedStringify(JSON.parse(bodyText), max);
  } catch {
    return bodyText
      .replace(/\s+/g, " ")
      .replace(/ey[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted-jwt]")
      .trim()
      .slice(0, max);
  }
}

interface RawGqlResponse {
  status: number;
  ok: boolean;
  bodyText: string;
  threw: string;
  via: "page-fetch" | "request" | "direct";
  xsrfSent: boolean;
  authSent: boolean;
  apiKeySent: boolean;
}

interface SitAuth {
  xsrf?: string;
  bearer?: string;
  // The public anon apikey the SPA sends alongside the Bearer (harmless to
  // include on our own calls; some Supabase-fronted routes expect both).
  apiKey?: string;
  // Diagnostics (page URL + KEY NAMES only, never values) captured when no
  // bearer was found, so the caller can tell "token truly absent" from "wrong
  // page / key renamed / login flow changed" without ever logging a secret.
  bearerDiag?: { url: string; lsKeys: string[]; cookieKeys: string[] };
}

// ---------------------------------------------------------------------------
// Collect the authentication material the SIT API expects beyond the session
// cookie: the Laravel/axios X-XSRF-TOKEN (the XSRF-TOKEN cookie value, URL-
// decoded) and a best-effort bearer token the SPA may keep in web storage.
// The XSRF cookie is read from the BROWSER CONTEXT (page.context().cookies),
// which is reliable even if it is HttpOnly — reading document.cookie in-page
// would miss those. The bearer is the SUPABASE access_token: SIT authenticates
// GraphQL with `Authorization: Bearer <access_token>`.
//
// The session is written to web storage right AFTER login completes, so a
// single early read can miss it. We POLL (≤15s, 500ms interval) and check TWO
// sources each pass, returning the moment either yields a JWT:
//   1) localStorage `sb-<project-ref>-auth-token` — gotrue-js plain JSON.
//   2) cookie `sb-<project-ref>-auth-token` — @supabase/ssr `base64-<b64(JSON)>`
//      (decode via atob of the value after the "base64-" prefix).
// A generic JWT scan is kept as a last-resort fallback. When nothing is found
// we capture the storage/cookie KEY NAMES ONLY (never values) so the caller can
// distinguish "token truly absent" from "key renamed". Failures are non-fatal.
// ---------------------------------------------------------------------------
async function collectAuth(page: Page, baseUrl: string): Promise<SitAuth> {
  const auth: SitAuth = {};

  try {
    const cookies = await page.context().cookies(baseUrl);
    const xsrf = cookies.find((c) => c.name === "XSRF-TOKEN");
    if (xsrf?.value) auth.xsrf = decodeURIComponent(xsrf.value);
  } catch {
    /* cookie read failed — proceed without XSRF */
  }

  // PRIMARY bearer source — the Authorization header the SPA attaches to its
  // OWN /api/graphql requests, captured from the network. This is the live
  // token verbatim and far more reliable than reading web storage in the
  // headless context. installSpaAuthCapture is idempotent; the token is usually
  // already captured from the students-list load that preceded this call.
  installSpaAuthCapture(page);
  const anon = capturedAnonKeyByPage.get(page) ?? envAnonKey() ?? cachedAnonKey;
  if (anon) auth.apiKey = anon;
  let captured = capturedBearerByPage.get(page);
  if (!captured) {
    // Nothing captured yet — wait ONCE (bounded) for the SPA to fire an
    // authenticated graphql request we can observe. No blind retries.
    try {
      const req = await page.waitForRequest(
        (r) =>
          r.url().includes(GRAPHQL_PATH) &&
          BEARER_JWT_RE.test(r.headers()["authorization"] ?? ""),
        { timeout: 12_000 },
      );
      const m = (req.headers()["authorization"] ?? "").match(BEARER_JWT_RE);
      if (m) {
        capturedBearerByPage.set(page, m[1]);
        captured = m[1];
      }
    } catch {
      /* no SPA graphql request observed — fall back to storage read below */
    }
    captured = captured ?? capturedBearerByPage.get(page);
  }
  if (captured) {
    auth.bearer = captured;
    return auth;
  }

  try {
    const res = await page.evaluate(async () => {
      const looksLikeJwt = (v: unknown): v is string =>
        typeof v === "string" && /^ey[\w-]+\.[\w-]+\.[\w-]+$/.test(v);

      // Decode a Supabase session value. gotrue-js v2 stores the session as a
      // plain JSON object; @supabase/ssr stores it base64-encoded behind a
      // "base64-" prefix (used for the cookie form). Handle both.
      const parseSession = (raw: string | null): unknown => {
        if (!raw) return null;
        let text = raw;
        if (text.startsWith("base64-")) {
          try {
            text = atob(text.slice("base64-".length));
          } catch {
            return null;
          }
        }
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      };

      // Pull the access_token out of a parsed Supabase session, tolerating the
      // top-level shape, the legacy `currentSession` wrapper, and array form.
      const extractAccessToken = (s: unknown): string | null => {
        let cand: unknown;
        if (Array.isArray(s)) {
          cand = (s[0] as { access_token?: unknown } | undefined)?.access_token;
        } else if (s && typeof s === "object") {
          const o = s as {
            access_token?: unknown;
            currentSession?: { access_token?: unknown };
          };
          cand = o.access_token ?? o.currentSession?.access_token;
        }
        return looksLikeJwt(cand) ? cand : null;
      };

      // Source 1 (authoritative) — localStorage `sb-<project-ref>-auth-token`.
      // The project ref changes per deployment, so discover the key dynamically.
      const readLocalStorage = (): string | null => {
        try {
          if (!window.localStorage) return null;
          const keys = Object.keys(window.localStorage).filter(
            (k) => k.startsWith("sb-") && k.endsWith("-auth-token"),
          );
          for (const k of keys) {
            const tok = extractAccessToken(
              parseSession(window.localStorage.getItem(k)),
            );
            if (tok) return tok;
          }
        } catch {
          /* access denied */
        }
        return null;
      };

      // Source 2 — cookie `sb-<project-ref>-auth-token` = `base64-<b64(JSON)>`
      // (the @supabase/ssr format). parseSession's base64- branch decodes it.
      const readCookie = (): string | null => {
        try {
          const c = document.cookie
            .split(";")
            .map((x) => x.trim())
            .find((x) => x.startsWith("sb-") && x.includes("-auth-token="));
          if (!c) return null;
          const value = decodeURIComponent(c.split("=").slice(1).join("="));
          return extractAccessToken(parseSession(value));
        } catch {
          return null;
        }
      };

      // Source 3 (last resort) — generic scan of web storage for any JWT-looking
      // value or token-ish JSON field (covers non-Supabase / future changes).
      const readHeuristic = (): string | null => {
        const stores: Storage[] = [];
        try {
          if (window.localStorage) stores.push(window.localStorage);
        } catch {
          /* access denied */
        }
        try {
          if (window.sessionStorage) stores.push(window.sessionStorage);
        } catch {
          /* access denied */
        }
        for (const store of stores) {
          let len = 0;
          try {
            len = store.length;
          } catch {
            len = 0;
          }
          for (let i = 0; i < len; i++) {
            const key = store.key(i);
            if (!key) continue;
            const val = store.getItem(key);
            if (!val) continue;
            if (looksLikeJwt(val)) return val;
            if (/token|auth|access|bearer|jwt/i.test(key)) {
              try {
                const parsed = JSON.parse(val) as Record<string, unknown>;
                const cand =
                  parsed?.token ??
                  parsed?.accessToken ??
                  parsed?.access_token ??
                  parsed?.authToken ??
                  parsed?.jwt ??
                  parsed?.value;
                if (looksLikeJwt(cand)) return cand;
              } catch {
                /* not JSON */
              }
            }
          }
        }
        return null;
      };

      // Poll ≤15s (30 × 500ms). The session appears right after login; return
      // the instant any source yields a JWT (happy path returns on pass 0 with
      // no delay). No blind retries — this is the ONLY wait.
      for (let i = 0; i < 30; i++) {
        const tok = readLocalStorage() || readCookie() || readHeuristic();
        if (tok) {
          return {
            bearer: tok,
            lsKeys: [] as string[],
            cookieKeys: [] as string[],
          };
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      // Not found — capture KEY NAMES ONLY (never values) for diagnostics.
      let lsKeys: string[] = [];
      try {
        lsKeys = Object.keys(window.localStorage);
      } catch {
        /* access denied */
      }
      let cookieKeys: string[] = [];
      try {
        cookieKeys = document.cookie
          .split(";")
          .map((x) => x.trim().split("=")[0])
          .filter(Boolean);
      } catch {
        /* access denied */
      }
      return { bearer: null as string | null, lsKeys, cookieKeys };
    });

    if (res?.bearer) {
      auth.bearer = res.bearer;
    } else {
      auth.bearerDiag = {
        url: page.url(),
        lsKeys: res?.lsKeys ?? [],
        cookieKeys: res?.cookieKeys ?? [],
      };
    }
  } catch {
    /* storage/cookie read failed — proceed without bearer */
  }

  return auth;
}

// ---------------------------------------------------------------------------
// Transport 1 — page.request (Playwright's context request). It shares the
// browser's cookie jar and is NOT subject to CORS, so it always reaches the
// endpoint; we add the X-XSRF-TOKEN / bearer headers (and Origin/Referer) that
// a cookie-only request was missing. This is the primary path because it is the
// one we KNOW reaches the server (it returned HTTP 200 in production).
// ---------------------------------------------------------------------------
async function postViaRequest(
  page: Page,
  url: string,
  baseUrl: string,
  query: string,
  variables: Record<string, unknown>,
  auth: SitAuth,
): Promise<RawGqlResponse> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    "x-requested-with": "XMLHttpRequest",
    origin: baseUrl,
    referer: baseUrl + "/",
  };
  if (auth.xsrf) headers["X-XSRF-TOKEN"] = auth.xsrf;
  if (auth.bearer) headers["authorization"] = "Bearer " + auth.bearer;
  if (auth.apiKey) headers["apikey"] = auth.apiKey;

  try {
    const res = await page.request.post(url, {
      data: { query, variables },
      headers,
      timeout: 20_000,
    });
    return {
      status: res.status(),
      ok: res.ok(),
      bodyText: await res.text(),
      threw: "",
      via: "request",
      xsrfSent: !!auth.xsrf,
      authSent: !!auth.bearer,
      apiKeySent: !!auth.apiKey,
    };
  } catch (e) {
    return {
      status: 0,
      ok: false,
      bodyText: "",
      threw: e instanceof Error ? e.message : String(e),
      via: "request",
      xsrfSent: !!auth.xsrf,
      authSent: !!auth.bearer,
      apiKeySent: !!auth.apiKey,
    };
  }
}

// ---------------------------------------------------------------------------
// Transport 2 — in-page window.fetch (SPA-faithful). Uses a RELATIVE path so it
// is always same-origin with the current page (an absolute cross-origin URL is
// what makes the browser throw), credentials:"include" for cookies, plus the
// XSRF/bearer headers. Secondary because it can be blocked by CSP or a
// destroyed execution context; used when transport 1 does not yield data.
// ---------------------------------------------------------------------------
async function postViaPageFetch(
  page: Page,
  path: string,
  query: string,
  variables: Record<string, unknown>,
  auth: SitAuth,
): Promise<RawGqlResponse> {
  try {
    const result = await page.evaluate(
      async (args: {
        path: string;
        query: string;
        variables: Record<string, unknown>;
        xsrf: string | null;
        bearer: string | null;
        apiKey: string | null;
      }) => {
        const headers: Record<string, string> = {
          "content-type": "application/json",
          accept: "application/json",
          "x-requested-with": "XMLHttpRequest",
        };
        if (args.xsrf) headers["X-XSRF-TOKEN"] = args.xsrf;
        if (args.bearer) headers["authorization"] = "Bearer " + args.bearer;
        if (args.apiKey) headers["apikey"] = args.apiKey;

        let status = 0;
        let ok = false;
        let bodyText = "";
        let threw = "";
        try {
          const resp = await fetch(args.path, {
            method: "POST",
            credentials: "include",
            headers,
            body: JSON.stringify({
              query: args.query,
              variables: args.variables,
            }),
          });
          status = resp.status;
          ok = resp.ok;
          bodyText = await resp.text();
        } catch (e) {
          threw = e instanceof Error ? e.message : String(e);
        }
        return { status, ok, bodyText, threw };
      },
      {
        path,
        query,
        variables,
        xsrf: auth.xsrf ?? null,
        bearer: auth.bearer ?? null,
        apiKey: auth.apiKey ?? null,
      },
    );
    return {
      ...result,
      via: "page-fetch",
      xsrfSent: !!auth.xsrf,
      authSent: !!auth.bearer,
      apiKeySent: !!auth.apiKey,
    };
  } catch (e) {
    return {
      status: 0,
      ok: false,
      bodyText: "",
      threw: e instanceof Error ? e.message : String(e),
      via: "page-fetch",
      xsrfSent: !!auth.xsrf,
      authSent: !!auth.bearer,
      apiKeySent: !!auth.apiKey,
    };
  }
}

// ---------------------------------------------------------------------------
// Interpret a raw transport response into either parsed data or a classified,
// human-readable failure. Separated from transport so each attempt can be
// logged and we can decide whether a second transport is worth trying.
// ---------------------------------------------------------------------------
type Interpretation<T> =
  | { kind: "ok"; data: T }
  // "gotData" means the API DID return non-null data (auth works); the shape
  // just did not match — retrying another transport cannot change that.
  | { kind: "gotData"; message: string }
  // recoverable: another transport (or a re-auth) might succeed.
  | { kind: "retry"; message: string };

function interpret<S extends z.ZodTypeAny>(
  raw: RawGqlResponse,
  dataSchema: S,
): Interpretation<z.infer<S>> {
  if (raw.threw) {
    return { kind: "retry", message: `request failed: ${raw.threw}` };
  }

  let body: unknown;
  try {
    body = JSON.parse(raw.bodyText);
  } catch {
    // A non-JSON body (typically an HTML login page) is the classic "session
    // not accepted" symptom. Strip JWTs and CSRF/token attribute values so a
    // login page embedding a token/meta tag cannot leak it into the logs.
    const snippet = raw.bodyText
      .replace(/\s+/g, " ")
      .replace(/ey[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted-jwt]")
      .replace(
        /((?:csrf|token|xsrf|authenticity)[\w-]*["']?\s*[:=]\s*["']?)[^"'\s>]+/gi,
        "$1[redacted]",
      )
      .trim()
      .slice(0, 300);
    return {
      kind: "retry",
      message: `non-JSON response (likely an unauthenticated redirect). First 300 chars: ${snippet}`,
    };
  }

  const envelope = z
    .object({
      data: z.unknown().optional(),
      errors: z.array(z.object({ message: z.string() })).optional(),
    })
    .safeParse(body);

  if (!envelope.success) {
    const keys =
      body && typeof body === "object"
        ? Object.keys(body).join(", ")
        : typeof body;
    return {
      kind: "retry",
      message: `malformed response envelope — top-level keys: [${keys}]`,
    };
  }

  // Surface GraphQL errors verbatim (e.g. "Unauthenticated.", "Cannot query
  // field X") — the actual cause the old code hid behind "null".
  if (envelope.data.errors && envelope.data.errors.length > 0) {
    return {
      kind: "retry",
      message: `GraphQL errors: ${envelope.data.errors
        .map((e) => e.message)
        .join("; ")}`,
    };
  }

  // Top-level `data: null` with NO errors: either an EMPTY result for this query
  // or a request the gateway silently refused. Do NOT assert "auth failed" — the
  // Bearer/apikey status (logged alongside) plus the raw body (logged by the
  // caller) tell the real story. The caller degrades to null → the read-only
  // caller (findStudent/listStudentApplications) treats that as "no record →
  // create", never a fatal error. Retrying the other transport is harmless.
  if (envelope.data.data == null) {
    return {
      kind: "retry",
      message: `server returned top-level data:null with no errors — empty result or request refused (bearer=${raw.authSent} apikey=${raw.apiKeySent})`,
    };
  }

  const parsed = dataSchema.safeParse(envelope.data.data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue?.path?.length ? ` at "${issue.path.join(".")}"` : "";
    return {
      kind: "gotData",
      message: `data shape mismatch${at} — actual response shape: ${redactedStringify(
        envelope.data.data,
      )}`,
    };
  }
  return { kind: "ok", data: parsed.data };
}

// ---------------------------------------------------------------------------
// Low-level request — POST { query, variables }, validate envelope + data.
// Tries transport 1 (page.request + auth headers) then, if that does not yield
// usable data, transport 2 (in-page fetch). Each failed attempt is logged with
// the transport, HTTP status, and which credentials were attached.
// ---------------------------------------------------------------------------
async function gqlRequest<S extends z.ZodTypeAny>(
  page: Page,
  query: string,
  variables: Record<string, unknown>,
  dataSchema: S,
  label: string,
): Promise<z.infer<S> | null> {
  const absUrl = SIT_URLS.base + GRAPHQL_PATH;
  const auth = await collectAuth(page, SIT_URLS.base);

  // Log OUR outgoing query (operation + PII-masked variables) so it can be
  // compared against the SPA's REAL captured request in the same run.
  const outOp = query.match(/\b(?:query|mutation)\s+(\w+)/)?.[1] ?? label;
  logger.info(
    `[sit:graphql] ${label}: sending op=${outOp} variables=${redactedStringify(
      variables,
      300,
    )}`,
  );

  // The SIT /api/graphql endpoint authenticates with the Supabase Bearer
  // access_token — without it the server returns HTTP 200 with data:null (never
  // an auth error). If no token was found, say so ONCE and clearly rather than
  // hammering both transports and logging opaque "data:null" twice.
  if (!auth.bearer) {
    // KEY NAMES ONLY (no values) so we can tell "truly absent" from "renamed".
    const diag = auth.bearerDiag;
    const keyInfo = diag
      ? ` — sayfa: ${diag.url}; localStorage anahtarları: [${
          diag.lsKeys.join(", ") || "yok"
        }]; cookie anahtarları: [${diag.cookieKeys.join(", ") || "yok"}]`
      : "";
    logger.warn(
      `[sit:graphql] ${label}: Supabase token bulunamadı — login akışı değişti mi? (Authorization: Bearer eklenemedi) — GraphQL atlanıyor, UI taramasına düşülecek${keyInfo}`,
    );
    // Without the Bearer token the endpoint only ever returns data:null, so
    // don't blindly hammer both transports — bail to the caller's UI fallback.
    return null;
  }

  const attempts: Array<() => Promise<RawGqlResponse>> = [
    () => postViaRequest(page, absUrl, SIT_URLS.base, query, variables, auth),
    () => postViaPageFetch(page, GRAPHQL_PATH, query, variables, auth),
  ];

  for (const run of attempts) {
    const raw = await run();
    const meta = `HTTP ${raw.status} via ${raw.via} xsrf=${raw.xsrfSent} bearer=${raw.authSent} apikey=${raw.apiKeySent}`;
    const result = interpret(raw, dataSchema);

    if (result.kind === "ok") {
      logger.info(`[sit:graphql] ${label}: OK — data received (${meta})`);
      return result.data;
    }

    logger.warn(`[sit:graphql] ${label}: ${result.message} (${meta})`);
    // Surface the ACTUAL server body (PII-masked, ≤500 chars) so we can tell an
    // empty result (`{"data":{"students":null}}`) apart from a refused request
    // (`{"data":null}`) or a GraphQL error, without leaking token/PII.
    logger.warn(
      `[sit:graphql] ${label}: raw: ${rawForLog(raw.bodyText)}`,
    );

    // The API returned data but the shape didn't match — another transport
    // would return the same shape, so stop and let the caller scan the UI.
    if (result.kind === "gotData") return null;
    // Otherwise (auth/empty/error/network) fall through to the next transport.
  }

  // We authenticated (a Bearer was present — no-bearer short-circuits earlier)
  // but got no usable data, most likely because our query shape doesn't match
  // this route. Learn the route's REAL query shape (once per page) by capturing
  // the authenticated SPA's own /api/graphql requests. Best-effort; we still
  // return null so THIS call falls back to scanning the UI. Skipped for the
  // introspection probe (it has its own diagnostics and would waste a ~32s
  // probe).
  if (label !== "introspect")
    await captureRealGraphqlOnce(page).catch(() => {});
  return null;
}

/**
 * A GraphQL connection that may arrive in any of the common shapes:
 *   - `{ nodes: [...] }`            (nodes-style connection)
 *   - `{ edges: [{ node: ... }] }` (Relay edges/node connection)
 *   - `[...]`                       (bare array)
 *   - `null`                        (empty result — no rows)
 * Returns a schema that normalises ALL of them to `{ nodes: T[] }` so
 * downstream code has one shape to consume. Accepting an explicit `null` is
 * important: SIT returns a null connection when a search yields no rows, which
 * must be read as "no records" (→ create flow) rather than logged as a shape
 * mismatch and retried. A genuinely ABSENT field (undefined) is intentionally
 * NOT accepted so real schema drift still surfaces via the mismatch diagnostic.
 */
function connection<T extends z.ZodTypeAny>(
  node: T,
): z.ZodType<{ nodes: z.infer<T>[] }> {
  return z
    .union([
      z.object({ nodes: z.array(node) }),
      z.object({ edges: z.array(z.object({ node })) }),
      z.array(node),
      z.null(),
    ])
    .transform((v) => {
      if (v == null) return { nodes: [] as z.infer<T>[] };
      if (Array.isArray(v)) return { nodes: v };
      if ("edges" in v) return { nodes: v.edges.map((e) => e.node) };
      return v;
    }) as z.ZodType<{ nodes: z.infer<T>[] }>;
}

// ---------------------------------------------------------------------------
// pg_graphql introspection (diagnostic) — confirm the EXACT insert/filter field
// names for the create mutations before we wire them up in a later turn. Logged
// once per page, best-effort; introspection may be disabled on the endpoint (→
// null, harmless). Field names are schema metadata, not PII/secrets.
// ---------------------------------------------------------------------------
const INTROSPECTION_QUERY = /* GraphQL */ `
  query IntrospectSitSchema {
    studentInsert: __type(name: "zoho_studentsInsertInput") { inputFields { name } }
    applicationInsert: __type(name: "zoho_applicationsInsertInput") { inputFields { name } }
    programsFilter: __type(name: "zoho_programsFilter") { inputFields { name } }
    studentNode: __type(name: "zoho_students") { fields { name } }
    programNode: __type(name: "zoho_programs") { fields { name } }
    applicationNode: __type(name: "zoho_applications") { fields { name } }
  }
`;

const introspectInputType = z
  .object({ inputFields: z.array(z.object({ name: z.string() })).nullish() })
  .nullish();
const introspectObjectType = z
  .object({ fields: z.array(z.object({ name: z.string() })).nullish() })
  .nullish();
const introspectionSchema = z.object({
  studentInsert: introspectInputType,
  applicationInsert: introspectInputType,
  programsFilter: introspectInputType,
  studentNode: introspectObjectType,
  programNode: introspectObjectType,
  applicationNode: introspectObjectType,
});

async function logPgGraphqlIntrospectionOnce(page: Page): Promise<void> {
  if (introspectionLogged.has(page)) return;
  introspectionLogged.add(page);

  const data = await gqlRequest(
    page,
    INTROSPECTION_QUERY,
    {},
    introspectionSchema,
    "introspect",
  );
  if (!data) {
    logger.info(
      "[sit:graphql] introspect: no data (introspection disabled or unsupported)",
    );
    return;
  }

  const names = (
    t?: {
      inputFields?: { name: string }[] | null;
      fields?: { name: string }[] | null;
    } | null,
  ): string =>
    (t?.inputFields ?? t?.fields ?? []).map((f) => f.name).join(", ") ||
    "(none)";

  logger.info(
    `[sit:graphql] introspect zoho_studentsInsertInput: [${names(data.studentInsert)}]`,
  );
  logger.info(
    `[sit:graphql] introspect zoho_applicationsInsertInput: [${names(data.applicationInsert)}]`,
  );
  logger.info(
    `[sit:graphql] introspect zoho_programsFilter: [${names(data.programsFilter)}]`,
  );
  logger.info(
    `[sit:graphql] introspect zoho_students fields: [${names(data.studentNode)}]`,
  );
  logger.info(
    `[sit:graphql] introspect zoho_programs fields: [${names(data.programNode)}]`,
  );
  logger.info(
    `[sit:graphql] introspect zoho_applications fields: [${names(data.applicationNode)}]`,
  );
}

// ---------------------------------------------------------------------------
// Student lookup (idempotency) — match by email or passport.
// ---------------------------------------------------------------------------
export interface SitStudentRef {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  passportNumber?: string;
}

// sitconnect's /api/graphql is a Supabase pg_graphql proxy over Zoho-synced
// tables (zoho_students / zoho_programs / zoho_applications). pg_graphql exposes
// `<table>Collection` fields returning Relay `edges { node }` connections and
// `filter` / `first` / `offset` / `orderBy` arguments — NOT the bespoke
// students(search:)/programs(universityName:) shape guessed earlier (which
// returned {"data":null} because those fields don't exist in this schema).
const STUDENT_SEARCH_QUERY = /* GraphQL */ `
  query GetZohoStudentsSearch($search: String!) {
    zoho_studentsCollection(
      filter: { or: [
        { email: { ilike: $search } },
        { passport_number: { ilike: $search } }
      ] }
      first: 25
    ) {
      edges { node { id first_name last_name email passport_number } }
    }
  }
`;

const studentSearchSchema = z.object({
  zoho_studentsCollection: connection(
    z.object({
      id: z.union([z.string(), z.number()]).transform((v) => String(v)),
      first_name: z.string().nullish(),
      last_name: z.string().nullish(),
      email: z.string().nullish(),
      passport_number: z.string().nullish(),
    }),
  ),
});

/**
 * Tri-state student lookup outcome. `unknown` means the search query itself
 * could not be confirmed (GraphQL unavailable / shape drift) — the caller MUST
 * fail closed (abort create) since proceeding would risk a duplicate student.
 */
export type SitStudentLookup =
  | {
      status: "found";
      ref: SitStudentRef;
      /**
       * Informational only: SIT may abbreviate or retain an older spelling of
       * the name. Reuse is still safe when one record matches both independent
       * identifiers exactly; callers should log these fields for auditability.
       */
      identityWarningFields?: string[];
    }
  | { status: "not_found" }
  | { status: "conflict"; fields: string[] }
  | { status: "unknown" };

function normalizeEmail(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/** Pure fail-closed decision used by the network lookup and regression tests. */
export function resolveSitStudentLookup(
  by: { email?: string; passportNumber?: string; firstName?: string; lastName?: string },
  candidates: readonly SitStudentRef[],
): SitStudentLookup {
  if (
    !normalizeEmail(by.email) ||
    !normalizeSitPassport(by.passportNumber) ||
    !by.firstName?.trim() ||
    !by.lastName?.trim()
  ) {
    return { status: "unknown" };
  }

  const relevant = candidates.filter((candidate) =>
    normalizeEmail(candidate.email) === normalizeEmail(by.email) ||
    normalizeSitPassport(candidate.passportNumber) === normalizeSitPassport(by.passportNumber),
  );
  if (relevant.length === 0) return { status: "not_found" };

  // Email and passport are the two independent identifiers used by SIT's own
  // search. A single row matching BOTH is safe to reuse even when SIT has
  // abbreviated a middle name or retained an older name spelling. Requiring
  // full name-token equality here caused verified existing students to be
  // rejected and then repeatedly retried. Name differences remain visible as
  // audit warnings; they never allow reuse when either identifier differs or
  // when more than one relevant portal row exists.
  const strongMatches = relevant.filter((candidate) =>
    normalizeEmail(candidate.email) === normalizeEmail(by.email) &&
    normalizeSitPassport(candidate.passportNumber) ===
      normalizeSitPassport(by.passportNumber),
  );
  if (strongMatches.length === 1 && relevant.length === 1) {
    const candidate = strongMatches[0];
    const identity = evaluateSitIdentity(
      {
        firstName: by.firstName ?? "",
        lastName: by.lastName ?? "",
        passportNumber: by.passportNumber ?? "",
      },
      {
        firstName: candidate.firstName ?? "",
        lastName: candidate.lastName ?? "",
        passportNumber: candidate.passportNumber ?? "",
        confidence: "high",
      },
    );
    const identityWarningFields = [
      ...identity.missingFields,
      ...identity.mismatchedFields,
    ].filter((field) => field !== "passportNumber").sort();
    return identityWarningFields.length > 0
      ? { status: "found", ref: candidate, identityWarningFields }
      : { status: "found", ref: candidate };
  }

  const fields = new Set<string>();
  if (strongMatches.length > 1 || relevant.length > 1) fields.add("multipleStudents");
  for (const candidate of relevant) {
    if (
      normalizeSitPassport(candidate.passportNumber) !==
      normalizeSitPassport(by.passportNumber)
    ) fields.add("passportNumber");
    const identity = evaluateSitIdentity(
      {
        firstName: by.firstName ?? "",
        lastName: by.lastName ?? "",
        passportNumber: by.passportNumber ?? "",
      },
      {
        firstName: candidate.firstName ?? "",
        lastName: candidate.lastName ?? "",
        passportNumber: candidate.passportNumber ?? "",
        confidence: "high",
      },
    );
    identity.missingFields.forEach((field) => fields.add(field));
    identity.mismatchedFields.forEach((field) => fields.add(field));
  }
  return { status: "conflict", fields: [...fields].sort() };
}

export async function findStudent(
  page: Page,
  by: { email?: string; passportNumber?: string; firstName?: string; lastName?: string },
): Promise<SitStudentLookup> {
  // One-shot pg_graphql introspection (insert/filter field names) to de-risk the
  // create mutations in a later turn — logged once per page, best-effort.
  await logPgGraphqlIntrospectionOnce(page).catch(() => {});

  const searchTerms = [by.email, by.passportNumber]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  // SIT reuse requires both independent search keys and full-name proof.
  if (searchTerms.length !== 2 || !by.firstName?.trim() || !by.lastName?.trim()) {
    logger.warn(
      "[sit:graphql] findStudent: arama anahtarı yok — mükerrer durumu doğrulanamadı (fail-closed)",
    );
    return { status: "unknown" };
  }

  const results = await Promise.all(searchTerms.map((search, index) =>
    gqlRequest(
      page,
      STUDENT_SEARCH_QUERY,
      { search: `%${search}%` },
      studentSearchSchema,
      `studentSearch:${index === 0 ? "email" : "passport"}`,
    ),
  ));
  if (results.some((data) => !data)) {
    // Could not confirm — fail closed so the caller does not create a possible
    // duplicate on a transient GraphQL outage / response-shape drift.
    logger.warn(
      "[sit:graphql] findStudent: sorgu başarısız — mükerrer durumu doğrulanamadı (fail-closed)",
    );
    return { status: "unknown" };
  }

  const merged = new Map<string, SitStudentRef>();
  for (const data of results) {
    for (const node of data!.zoho_studentsCollection.nodes) {
      merged.set(node.id, {
        id: node.id,
        firstName: node.first_name ?? undefined,
        lastName: node.last_name ?? undefined,
        email: node.email ?? undefined,
        passportNumber: node.passport_number ?? undefined,
      });
    }
  }
  return resolveSitStudentLookup(by, [...merged.values()]);
}

// ---------------------------------------------------------------------------
// Existing-application lookup (dedup) for a known student.
// ---------------------------------------------------------------------------
export interface SitApplicationRef {
  id: string;
  /** Zoho-assigned human reference (e.g. "SITP-14505") — the writeback ref. */
  appId?: string;
  universityName?: string;
  programName?: string;
  status?: string;
}

// zoho_applications columns (from the live schema): student, program,
// university, stage, degree, acdamic_year (real typo), semester, country,
// app_id (Zoho ref "SITP-…"), online_application_id, created_at.
// university/program are denormalised NAME strings (Zoho sync), not nested refs.
const STUDENT_APPLICATIONS_QUERY = /* GraphQL */ `
  query GetZohoApplications($studentId: String!) {
    zoho_applicationsCollection(
      filter: { student: { eq: $studentId } }
      first: 100
    ) {
      edges { node { id app_id stage university program } }
    }
  }
`;

const studentApplicationsSchema = z.object({
  zoho_applicationsCollection: connection(
    z.object({
      id: z.union([z.string(), z.number()]).transform((v) => String(v)),
      app_id: z.string().nullish(),
      stage: z.string().nullish(),
      university: z.string().nullish(),
      program: z.string().nullish(),
    }),
  ),
});

/**
 * List a student's existing applications (read-only, for dedup). Returns [] on
 * unavailability so the caller treats "unknown" as "no known duplicate".
 */
export async function listStudentApplications(
  page: Page,
  studentId: string,
): Promise<SitApplicationRef[]> {
  const data = await gqlRequest(
    page,
    STUDENT_APPLICATIONS_QUERY,
    { studentId },
    studentApplicationsSchema,
    "studentApplications",
  );
  if (!data) return [];

  return data.zoho_applicationsCollection.nodes.map((n) => ({
    id: n.id,
    appId: n.app_id ?? undefined,
    status: n.stage ?? undefined,
    universityName: n.university ?? undefined,
    programName: n.program ?? undefined,
  }));
}

// ---------------------------------------------------------------------------
// Newest-application lookup — the CREATE writeback path. After the portal's
// "Add Application" UI flow succeeds, the record is created by the SIT backend
// (Zoho CRM), which assigns id + app_id + stage (the client cannot generate
// them). We read the freshly-created row back — filtered by (student, program),
// newest first — to obtain app_id for the submission external reference.
// ---------------------------------------------------------------------------
export interface SitLatestApplication {
  /** pg_graphql record id (19-digit Zoho id). */
  id: string;
  /** Zoho-assigned human reference (e.g. "SITP-14505") — the writeback ref. */
  appId?: string;
  /** University application number, assigned later (often null at creation). */
  onlineApplicationId?: string;
  /** Application stage — "Pending Review" for a freshly created application. */
  stage?: string;
  createdAt?: string;
}

const LATEST_APPLICATION_QUERY = /* GraphQL */ `
  query GetLatestSitApplication($studentId: String!, $programId: String!) {
    zoho_applicationsCollection(
      filter: { student: { eq: $studentId }, program: { eq: $programId } }
      orderBy: [{ created_at: DescNullsLast }]
      first: 1
    ) {
      edges {
        node { id app_id online_application_id stage created_at }
      }
    }
  }
`;

const latestApplicationSchema = z.object({
  zoho_applicationsCollection: connection(
    z.object({
      id: z.union([z.string(), z.number()]).transform((v) => String(v)),
      app_id: z.string().nullish(),
      online_application_id: z.string().nullish(),
      stage: z.string().nullish(),
      created_at: z.string().nullish(),
    }),
  ),
});

/**
 * Read the newest application for (student, program) — the CREATE writeback.
 * Returns null when none is found yet (the caller retries a few times, since the
 * Zoho-backed create is eventually consistent).
 */
export async function findLatestApplication(
  page: Page,
  studentId: string,
  programId: string,
): Promise<SitLatestApplication | null> {
  const data = await gqlRequest(
    page,
    LATEST_APPLICATION_QUERY,
    { studentId, programId },
    latestApplicationSchema,
    "latestApplication",
  );
  const node = data?.zoho_applicationsCollection.nodes[0];
  if (!node) return null;
  return {
    id: node.id,
    appId: node.app_id ?? undefined,
    onlineApplicationId: node.online_application_id ?? undefined,
    stage: node.stage ?? undefined,
    createdAt: node.created_at ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Program catalog (paginated, active programs only) for a given university.
// Scoping the catalog to ONE university is what makes program matching exact
// even when many universities share a program name.
// ---------------------------------------------------------------------------
const PROGRAMS_PAGE_SIZE = 200;

// pg_graphql pagination is offset-based (first/offset), not Relay cursors.
//
// SCHEMA (verified via live Supabase pg_graphql introspection): the program
// university column is `university_name` (String) — there is NO `university`
// field on `zoho_programs` (querying it errors "Unknown field 'university'").
// Beykoz is stored as the English "Beykoz University".
//
// University matching is fragile: the CRM catalog name we search with
// ("Beykoz Üniversitesi") does NOT match the stored English "Beykoz
// University", so a full-name `ilike` returns 0 rows. We filter by the CORE
// DISTINCTIVE TOKENS instead — an AND of `ilike` per token ("%beykoz%") plus
// `active: { eq: true }` — which survives the Turkish/English spelling and the
// "Üniversitesi"/"University" suffix difference. We then confirm each row in
// code by Turkish-folding both sides (belt-and-suspenders against ilike
// over-matching, e.g. a bare "%istanbul%" pulling in several universities).
// Degree/language/name matching stays in code (matchProgram + language gate).
//
// NOTE: `zoho_programsFilter` is the pg_graphql-generated filter input type
// (confirmed against the live SPA request); `and` takes a list of sub-filters.
const PROGRAMS_QUERY = /* GraphQL */ `
  query FindPrograms($filter: zoho_programsFilter, $limit: Int!, $offset: Int!) {
    zoho_programsCollection(
      filter: $filter
      first: $limit
      offset: $offset
      orderBy: [{ name: AscNullsLast }]
    ) {
      edges { node { id name university_name degree_name language_name active } }
    }
  }
`;

const programsSchema = z.object({
  zoho_programsCollection: connection(
    z.object({
      id: z.union([z.string(), z.number()]).transform((v) => String(v)),
      name: z.string(),
      university_name: z.string().nullish(),
      degree_name: z.string().nullish(),
      language_name: z.string().nullish(),
    }),
  ),
});

// Diagnostic-only query: the DISTINCT `university_name` spellings actually
// stored in the catalog, so a name mismatch reveals the exact string to match
// against (English vs Turkish, with/without "University"). Run once per page,
// only when the token filter comes up empty.
const PROGRAMS_UNIVERSITIES_QUERY = /* GraphQL */ `
  query GetProgramUniversities($limit: Int!, $offset: Int!) {
    zoho_programsCollection(
      first: $limit
      offset: $offset
      orderBy: [{ university_name: AscNullsLast }]
    ) {
      edges { node { university_name } }
    }
  }
`;

const programUniversitiesSchema = z.object({
  zoho_programsCollection: connection(
    z.object({ university_name: z.string().nullish() }),
  ),
});

const distinctUniLogged = new WeakSet<Page>();

/**
 * One-shot (per page) diagnostic: fetch and log the DISTINCT catalog university
 * spellings. Called only when the token filter returns nothing, so the operator
 * can see the exact string Zoho stores and confirm/adjust the match.
 */
async function logDistinctCatalogUniversitiesOnce(
  page: Page,
  wantTokens: readonly string[],
): Promise<void> {
  if (distinctUniLogged.has(page)) return;
  distinctUniLogged.add(page);

  const distinct = new Set<string>();
  for (let pageNo = 0; pageNo < 5; pageNo++) {
    const data = await gqlRequest(
      page,
      PROGRAMS_UNIVERSITIES_QUERY,
      { limit: PROGRAMS_PAGE_SIZE, offset: pageNo * PROGRAMS_PAGE_SIZE },
      programUniversitiesSchema,
      "programs",
    );
    if (!data) break;
    const nodes = data.zoho_programsCollection.nodes;
    for (const n of nodes)
      if (n.university_name) distinct.add(n.university_name);
    if (nodes.length < PROGRAMS_PAGE_SIZE) break;
  }

  const all = [...distinct].sort((a, b) => a.localeCompare(b));
  // Surface entries that loosely resemble the target on a folded-token basis
  // (either side contains the other) so the true spelling is easy to spot.
  const near = all.filter((u) => {
    const ut = fold(u).split(" ").filter(Boolean);
    return wantTokens.some((t) =>
      ut.some((x) => x.includes(t) || t.includes(x)),
    );
  });
  logger.warn(
    `[sit:graphql] DISTINCT catalog universities (${all.length}): ${
      all.join(" | ") || "(none)"
    }`,
  );
  if (near.length) {
    logger.warn(
      `[sit:graphql] near-match candidates for [${wantTokens.join(
        " ",
      )}]: ${near.join(" | ")}`,
    );
  }
}

/**
 * Fetch the program catalog for a university (read-only), following offset
 * pagination. Matches by CORE DISTINCTIVE TOKENS (Turkish-folded) rather than
 * the full CRM name so English/Turkish spelling and the "University" suffix
 * don't cause misses. Returns [] on unavailability so the caller falls back to
 * scanning the program combobox in the UI.
 */
export async function fetchProgramCatalog(
  page: Page,
  universityName: string,
  _level?: string,
): Promise<ProgramCandidate[]> {
  const out: ProgramCandidate[] = [];
  const wantTokens = distinctiveTokens(universityName);
  if (wantTokens.length === 0) return out;

  // AND of per-token `ilike` on `university_name` + `active` — narrows to the
  // target university while tolerating spelling/suffix differences. Only active
  // programs are selectable. `zoho_programsFilter` is the pg_graphql input.
  const filter = {
    and: [
      ...wantTokens.map((t) => ({ university_name: { ilike: `%${t}%` } })),
      { active: { eq: true } },
    ],
  };
  const seenUniversities = new Set<string>();

  for (let pageNo = 0; pageNo < 25; pageNo++) {
    const data = await gqlRequest(
      page,
      PROGRAMS_QUERY,
      {
        filter,
        limit: PROGRAMS_PAGE_SIZE,
        offset: pageNo * PROGRAMS_PAGE_SIZE,
      },
      programsSchema,
      "programs",
    );
    if (!data) break;

    const nodes = data.zoho_programsCollection.nodes;
    for (const n of nodes) {
      if (n.university_name) seenUniversities.add(n.university_name);
      // Confirm in code: the row's university must token-cover the target on a
      // folded basis (guards against ilike over-matching a look-alike name).
      const uniTokens = new Set(
        fold(n.university_name ?? "").split(" ").filter(Boolean),
      );
      if (wantTokens.every((t) => uniTokens.has(t))) {
        out.push({
          id: n.id,
          name: n.name,
          universityName: n.university_name ?? undefined,
          degreeName: n.degree_name ?? undefined,
          languageName: n.language_name ?? undefined,
        });
      }
    }

    // A short page means we've reached the end of the collection.
    if (nodes.length < PROGRAMS_PAGE_SIZE) break;
  }

  if (out.length === 0) {
    logger.warn(
      `[sit:graphql] catalog: no programs matched "${universityName}" (tokens: ${wantTokens.join(
        " ",
      )}); universities returned by filter: [${
        [...seenUniversities].join(" | ") || "(none)"
      }]`,
    );
    // Reveal the real catalog spellings so the mismatch is actionable.
    await logDistinctCatalogUniversitiesOnce(page, wantTokens).catch(() => {});
  } else {
    logger.info(
      `[sit:graphql] catalog: "${universityName}" → ${out.length} programs from [${[
        ...seenUniversities,
      ].join(" | ")}]`,
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// CREATE flow — id derivation + dedup precheck + n8n webhook (LIVE-CAPTURED).
//
// The SIT "Add Application" modal's dropdown UI is automation-hostile. The
// panel's REAL create mechanism, captured live from the running SPA, is:
//   1) a pg_graphql dedup precheck (GetApplicationsByFilter), then
//   2) a JSON POST to an OPEN n8n webhook that returns the Zoho-assigned id.
// We derive every id from GraphQL (never hardcoded), run the same dedup the
// panel does, and POST only when no duplicate exists.
// ---------------------------------------------------------------------------

/** A required id field that may arrive as string or number → always string. */
const idString = z.union([z.string(), z.number()]).transform((v) => String(v));
/** An optional id field → string | undefined (null/absent become undefined). */
const optIdString = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v == null ? undefined : String(v)));

// Digits-only of a string (separator-agnostic academic-year comparison).
function yearDigits(s: string): string {
  return (s.match(/\d/g) ?? []).join("");
}

// Canonical semester key (case-insensitive, TR/EN): fall/spring/summer.
function semesterFold(s: string): string {
  const f = s.toLowerCase();
  if (/fall|g[üu]z|autumn/.test(f)) return "fall";
  if (/spring|bahar/.test(f)) return "spring";
  if (/summer|yaz/.test(f)) return "summer";
  return f.trim();
}

// ---------------------------------------------------------------------------
// Agency identity — user_id (= Supabase auth uid), agency_id, crm_id.
//
// The webhook create body carries the agency's identity. user_id is the auth
// uid (the `sub` claim of the Supabase access_token the SPA authenticates
// with); agency_id + crm_id come from the user_profile row keyed by that uid.
// All three are resolved DYNAMICALLY (never hardcoded) and cached per page.
// Values are treated as ids (not secrets), but we log PRESENCE only.
// ---------------------------------------------------------------------------
export interface SitIdentity {
  /** Supabase auth uid — the webhook `user_id`. */
  userId: string;
  agencyId?: string;
  crmId?: string;
}

const identityByPage = new WeakMap<Page, SitIdentity>();

/** Decode the `sub` claim from a bare JWT (no verification — id read only). */
function decodeJwtSub(jwt: string): string | null {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return null;
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const obj = JSON.parse(json) as { sub?: unknown };
    return typeof obj.sub === "string" && obj.sub ? obj.sub : null;
  } catch {
    return null;
  }
}

const USER_PROFILE_QUERY = /* GraphQL */ `
  query GetSitUserProfile($filter: user_profileFilter) {
    user_profileCollection(filter: $filter, first: 1) {
      edges { node { id email full_name crm_id agency_id } }
    }
  }
`;

const userProfileSchema = z.object({
  user_profileCollection: connection(
    z.object({
      id: idString,
      crm_id: optIdString,
      agency_id: optIdString,
    }),
  ),
});

/**
 * Resolve the agency identity (user_id = auth uid, agency_id, crm_id). Cached
 * per page. Returns null when no Supabase bearer is available or the auth uid
 * cannot be decoded; agency_id/crm_id may be undefined if the profile row is
 * missing (the caller decides whether that is fatal). Never logs a secret.
 */
export async function resolveSitIdentity(page: Page): Promise<SitIdentity | null> {
  const cached = identityByPage.get(page);
  if (cached) return cached;

  const auth = await collectAuth(page, SIT_URLS.base);
  if (!auth.bearer) {
    logger.warn(
      "[sit:graphql] identity: Supabase bearer yok — kimlik (user_id/agency_id/crm_id) çözülemedi",
    );
    return null;
  }
  const uid = decodeJwtSub(auth.bearer);
  if (!uid) {
    logger.warn(
      "[sit:graphql] identity: auth uid (sub) access_token'dan çözülemedi",
    );
    return null;
  }

  const data = await gqlRequest(
    page,
    USER_PROFILE_QUERY,
    { filter: { id: { eq: uid } } },
    userProfileSchema,
    "userProfile",
  );
  const node = data?.user_profileCollection.nodes[0];
  const identity: SitIdentity = {
    userId: uid,
    agencyId: node?.agency_id,
    crmId: node?.crm_id,
  };
  identityByPage.set(page, identity);
  logger.info(
    `[sit:graphql] identity çözüldü (user_id=var, agency_id=${
      identity.agencyId ? "var" : "yok"
    }, crm_id=${identity.crmId ? "var" : "yok"})`,
  );
  return identity;
}

// ---------------------------------------------------------------------------
// Program id fields — university_id / degree_id / country_id (+ canonical name)
// for a matched program. These are the ids the dedup filter and webhook body
// require (the catalog match only gives us the program id + display name).
// ---------------------------------------------------------------------------
export interface SitProgramIds {
  name?: string;
  universityId?: string;
  degreeId?: string;
  countryId?: string;
}

const PROGRAM_IDS_QUERY = /* GraphQL */ `
  query GetSitProgramIds($filter: zoho_programsFilter) {
    zoho_programsCollection(filter: $filter, first: 1) {
      edges { node { id name university_id degree_id country_id } }
    }
  }
`;

const programIdsSchema = z.object({
  zoho_programsCollection: connection(
    z.object({
      id: idString,
      name: z.string().nullish(),
      university_id: optIdString,
      degree_id: optIdString,
      country_id: optIdString,
    }),
  ),
});

/**
 * Fetch the university/degree/country ids (and canonical name) for a program.
 * Returns null when the program row is not found or GraphQL is unavailable.
 */
export async function fetchProgramIds(
  page: Page,
  programId: string,
): Promise<SitProgramIds | null> {
  const data = await gqlRequest(
    page,
    PROGRAM_IDS_QUERY,
    { filter: { id: { eq: programId } } },
    programIdsSchema,
    "programIds",
  );
  const node = data?.zoho_programsCollection.nodes[0];
  if (!node) return null;
  return {
    name: node.name ?? undefined,
    universityId: node.university_id,
    degreeId: node.degree_id,
    countryId: node.country_id,
  };
}

// ---------------------------------------------------------------------------
// Country name → zoho_countries id resolution.
//
// The student-create webhook (like the application webhook's `country`) stores
// nationality/country as a Zoho DROPDOWN — it expects the zoho_countries ROW ID,
// not the plain name. Sending a raw name ("Pakistan") makes the webhook reject
// the create with `INVALID_DATA: Nationality1`. We resolve name→id via the same
// read-only pg_graphql endpoint used everywhere else, cache the result per run,
// and NEVER throw (an unresolved country returns null so the caller can still
// attempt the create and log a clear diagnostic).
// ---------------------------------------------------------------------------
const COUNTRY_ID_QUERY = /* GraphQL */ `
  query GetSitCountryId($filter: zoho_countriesFilter) {
    zoho_countriesCollection(filter: $filter, first: 20) {
      edges { node { id name } }
    }
  }
`;

const countriesSchema = z.object({
  zoho_countriesCollection: connection(
    z.object({ id: idString, name: z.string().nullish() }),
  ),
});

// name-fold → id | null (null = looked up, not found). Per-process cache.
const countryIdCache = new Map<string, string | null>();

/**
 * Resolve a country NAME (e.g. "Pakistan") to its zoho_countries row id.
 * Case/Turkish-fold insensitive: fetches `ilike '%name%'` candidates and prefers
 * a folded-exact name match, else the first contains-match. Returns null (never
 * throws) when the name is empty, GraphQL is unavailable, or no row matches.
 */
export async function resolveCountryId(
  page: Page,
  name?: string | null,
): Promise<string | null> {
  if (name == null) return null;
  const raw = String(name).trim();
  if (raw === "") return null;

  const key = fold(raw);
  const cached = countryIdCache.get(key);
  if (cached !== undefined) return cached;

  const data = await gqlRequest(
    page,
    COUNTRY_ID_QUERY,
    { filter: { name: { ilike: `%${raw}%` } } },
    countriesSchema,
    "countryId",
  );
  const nodes = data?.zoho_countriesCollection.nodes ?? [];
  // Prefer a folded-EXACT name match. The ilike is a substring match, so a
  // short/ambiguous input ("Guinea") can return several rows; guessing nodes[0]
  // would silently map to the WRONG country. Fail safe: accept a contains-match
  // ONLY when it is unambiguous (exactly one candidate), otherwise return null.
  const exact = nodes.find((n) => n.name != null && fold(n.name) === key);
  const picked: string | null =
    exact?.id ?? (nodes.length === 1 ? nodes[0].id : null);
  countryIdCache.set(key, picked);
  return picked;
}

// ---------------------------------------------------------------------------
// Applied degree label → zoho_degrees id resolution.
//
// The student-create webhook's `education_level` is a Zoho DROPDOWN — it expects
// the zoho_degrees ROW ID of the APPLIED-FOR degree, NOT the plain label. Sending
// a name ("Bachelor") makes the webhook reject the create with
// `INVALID_DATA: Student_will_apply_for`. There is no directly-queryable degrees
// collection, but every `zoho_programs` row carries BOTH `degree_name` and
// `degree_id`, so we resolve the id from a program of that degree — reliable and
// schema-safe (both fields are already used elsewhere). Cached per run; NEVER
// throws (an unresolved degree returns null so the caller can log a diagnostic).
// ---------------------------------------------------------------------------
const DEGREE_ID_QUERY = /* GraphQL */ `
  query GetSitDegreeId($filter: zoho_programsFilter) {
    zoho_programsCollection(filter: $filter, first: 20) {
      edges { node { degree_id degree_name } }
    }
  }
`;

const degreeIdSchema = z.object({
  zoho_programsCollection: connection(
    z.object({
      degree_id: optIdString,
      degree_name: z.string().nullish(),
    }),
  ),
});

// label-fold → id | null (null = looked up, not found). Per-process cache.
const degreeIdCache = new Map<string, string | null>();

/**
 * Resolve a canonical degree LABEL (e.g. "Bachelor"/"Master"/"PhD"/"Associate",
 * as produced by mapEducationLevel) to its zoho_degrees row id. Fetches programs
 * whose `degree_name` ilike-matches and prefers a folded-EXACT degree_name; falls
 * back to the sole candidate when unambiguous. Returns null (never throws) when
 * the label is empty, GraphQL is unavailable, or no row matches.
 */
export async function resolveDegreeId(
  page: Page,
  label?: string | null,
): Promise<string | null> {
  if (label == null) return null;
  const raw = String(label).trim();
  if (raw === "") return null;

  const key = fold(raw);
  const cached = degreeIdCache.get(key);
  if (cached !== undefined) return cached;

  const data = await gqlRequest(
    page,
    DEGREE_ID_QUERY,
    { filter: { degree_name: { ilike: `%${raw}%` } } },
    degreeIdSchema,
    "degreeId",
  );
  const nodes = data?.zoho_programsCollection.nodes ?? [];
  // A degree_name is a controlled vocabulary shared by many programs, so the
  // ilike can return several rows that all point at the SAME degree_id. Prefer a
  // folded-EXACT degree_name match; otherwise accept the id only when every
  // candidate agrees on it (unambiguous), else fail safe with null.
  const exactId = nodes.find(
    (n) => n.degree_name != null && fold(n.degree_name) === key,
  )?.degree_id;
  const distinctIds = Array.from(
    new Set(nodes.map((n) => n.degree_id).filter((v): v is string => !!v)),
  );
  const picked: string | null =
    exactId ?? (distinctIds.length === 1 ? distinctIds[0] : null);
  degreeIdCache.set(key, picked);
  return picked;
}

// ---------------------------------------------------------------------------
// Academic-year + semester id resolution (defaults: "2026/2027" / "Fall").
// The application stores these as ids; we resolve the id whose name matches the
// default (year compared digit-only so "2026-2027" matches "2026/2027").
// ---------------------------------------------------------------------------
const namedRowSchema = z.object({ id: idString, name: z.string().nullish() });

const ACADEMIC_YEARS_QUERY = /* GraphQL */ `
  query GetSitAcademicYears {
    zoho_academic_yearsCollection(first: 100) {
      edges { node { id name } }
    }
  }
`;
const academicYearsSchema = z.object({
  zoho_academic_yearsCollection: connection(namedRowSchema),
});

/** Resolve the academic-year id whose name matches `target` (digit-only). */
export async function resolveAcademicYearId(
  page: Page,
  target: string,
): Promise<{ id: string; name?: string } | null> {
  const data = await gqlRequest(
    page,
    ACADEMIC_YEARS_QUERY,
    {},
    academicYearsSchema,
    "academicYears",
  );
  if (!data) return null;
  const t = yearDigits(target);
  for (const n of data.zoho_academic_yearsCollection.nodes) {
    const o = yearDigits(n.name ?? "");
    if (o && t && (o === t || o.startsWith(t) || t.startsWith(o))) {
      return { id: n.id, name: n.name ?? undefined };
    }
  }
  logger.warn(
    `[sit:graphql] academicYears: "${target}" eşleşen akademik yıl bulunamadı`,
  );
  return null;
}

const SEMESTERS_QUERY = /* GraphQL */ `
  query GetSitSemesters {
    zoho_semestersCollection(first: 100) {
      edges { node { id name } }
    }
  }
`;
const semestersSchema = z.object({
  zoho_semestersCollection: connection(namedRowSchema),
});

/** Resolve the semester id whose name matches `target` (fall/spring/summer). */
export async function resolveSemesterId(
  page: Page,
  target: string,
): Promise<{ id: string; name?: string } | null> {
  const data = await gqlRequest(
    page,
    SEMESTERS_QUERY,
    {},
    semestersSchema,
    "semesters",
  );
  if (!data) return null;
  const key = semesterFold(target);
  for (const n of data.zoho_semestersCollection.nodes) {
    if (semesterFold(n.name ?? "") === key) {
      return { id: n.id, name: n.name ?? undefined };
    }
  }
  logger.warn(`[sit:graphql] semesters: "${target}" eşleşen dönem bulunamadı`);
  return null;
}

// ---------------------------------------------------------------------------
// Dedup precheck — the exact filter the panel runs before create. The dedup
// KEY is student + university + degree + acdamic_year + semester (program and
// country are intentionally NOT part of the key). Returns the existing
// application id when a duplicate exists, else null.
// ---------------------------------------------------------------------------
const DEDUP_QUERY = /* GraphQL */ `
  query GetApplicationsByFilter($filter: zoho_applicationsFilter) {
    zoho_applicationsCollection(filter: $filter, first: 1) {
      edges { node { id } }
    }
  }
`;
const dedupSchema = z.object({
  zoho_applicationsCollection: connection(z.object({ id: idString })),
});

export interface SitDedupKeys {
  student: string;
  university: string;
  degree: string;
  academicYear: string;
  semester: string;
}

/**
 * Tri-state dedup outcome. `unknown` means the precheck could not be confirmed
 * (GraphQL unavailable / shape drift) — the caller MUST fail closed and NOT
 * create, since proceeding would risk a duplicate application.
 */
export type SitDedupResult =
  | { status: "found"; id: string }
  | { status: "not_found" }
  | { status: "unknown" };

/**
 * Run the panel's dedup precheck. Returns `found` (with the existing id) when a
 * matching application already exists, `not_found` when the query confirms none
 * exists, and `unknown` when the query itself fails — the caller treats
 * `unknown` as fail-closed (abort create) to protect idempotency.
 */
export async function dedupApplication(
  page: Page,
  keys: SitDedupKeys,
): Promise<SitDedupResult> {
  const filter = {
    student: { eq: keys.student },
    university: { eq: keys.university },
    degree: { eq: keys.degree },
    // NOTE: the column name is the panel's typo `acdamic_year` — keep verbatim.
    acdamic_year: { eq: keys.academicYear },
    semester: { eq: keys.semester },
  };
  const data = await gqlRequest(
    page,
    DEDUP_QUERY,
    { filter },
    dedupSchema,
    "dedup",
  );
  if (!data) {
    // Could not confirm — fail closed so the caller does not create a possible
    // duplicate on a transient GraphQL outage / response-shape drift.
    logger.warn(
      "[sit:graphql] dedup: sorgu başarısız — mükerrer durumu doğrulanamadı (fail-closed)",
    );
    return { status: "unknown" };
  }
  const node = data.zoho_applicationsCollection.nodes[0];
  return node ? { status: "found", id: node.id } : { status: "not_found" };
}

// ---------------------------------------------------------------------------
// CREATE via the n8n webhook. Open endpoint (Content-Type only), but we POST
// from the authenticated browser context anyway (harmless). The webhook URL is
// env-overridable (SIT_CREATE_WEBHOOK_URL) with the live-captured default. The
// request BODY (which carries student PII) is NEVER logged; only the response
// (PII-masked via rawForLog) and HTTP status are.
// ---------------------------------------------------------------------------
const DEFAULT_CREATE_WEBHOOK_URL =
  "https://automation.sitconnect.net/webhook/4615d5ae-b3ba-413f-980e-a30a48be3c00";

function createWebhookUrl(): string {
  const env = process.env.SIT_CREATE_WEBHOOK_URL?.trim();
  return env && /^https?:\/\//i.test(env) ? env : DEFAULT_CREATE_WEBHOOK_URL;
}

export interface SitWebhookPayload {
  student: string;
  program: string;
  /** Panel's typo field name — keep verbatim. */
  acdamic_year: string;
  semester: string;
  country: string;
  university: string;
  degree: string;
  student_name: string;
  program_name: string;
  user_id: string;
  agency_id: string;
  crm_id: string;
}

export type SitApplicationWebhookResult =
  | { ok: true; id: string }
  | { ok: false; detail: string };

/**
 * POST the create payload to the n8n webhook. On `{ status: true, id }` returns
 * { id } (the Zoho-assigned application id); on any non-200, non-true status,
 * unparseable body, or network error returns null (the caller reports failure).
 */
export async function createApplicationViaWebhook(
  page: Page,
  payload: SitWebhookPayload,
): Promise<SitApplicationWebhookResult> {
  const url = createWebhookUrl();
  try {
    const res = await page.request.post(url, {
      headers: { "content-type": "application/json" },
      data: payload,
      timeout: 30_000,
    });
    const status = res.status();
    const bodyText = await res.text().catch(() => "");
    if (!res.ok()) {
      logger.warn(
        `[sit:webhook] create başarısız (status=${status}) body=${rawForLog(bodyText)}`,
      );
      return {
        ok: false,
        detail: `SIT webhook HTTP ${status}: ${rawForLog(bodyText) || "boş yanıt"}`,
      };
    }
    let json: { status?: unknown; id?: unknown; message?: unknown } | null = null;
    try {
      json = JSON.parse(bodyText) as {
        status?: unknown;
        id?: unknown;
        message?: unknown;
      };
    } catch {
      json = null;
    }
    const id = json?.id;
    if (
      json?.status === true &&
      (typeof id === "string" || typeof id === "number") &&
      String(id)
    ) {
      logger.info(
        `[sit:webhook] create OK (status=${status}, id=${String(id)})`,
      );
      return { ok: true, id: String(id) };
    }
    logger.warn(
      `[sit:webhook] create beklenmeyen yanıt (status=${status}) body=${rawForLog(bodyText)}`,
    );
    const message =
      typeof json?.message === "string" ? rawForLog(json.message) : "";
    return {
      ok: false,
      detail:
        `SIT webhook HTTP ${status}, status=${String(json?.status ?? "unknown")}` +
        (message ? `: ${message}` : ": açıklama verilmedi"),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn(
      `[sit:webhook] create hata: ${message}`,
    );
    return { ok: false, detail: `SIT webhook ağ hatası: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// CREATE STUDENT via the n8n webhook. Mirrors createApplicationViaWebhook: the
// SIT "Add Student" 6-step wizard is automation-hostile, but the panel's real
// student-create is a JSON POST to a SEPARATE n8n webhook (da599eaf-…, NOT the
// application webhook 4615d5ae-… and NOT the users/invite webhook 03ed1ba0-…).
// URL is env-overridable (SIT_CREATE_STUDENT_WEBHOOK_URL) with the live-captured
// default. The request BODY (which carries student PII) is NEVER logged; only
// the response (PII-masked via rawForLog) and HTTP status are.
// ---------------------------------------------------------------------------
const DEFAULT_CREATE_STUDENT_WEBHOOK_URL =
  "https://automation.sitconnect.net/webhook/da599eaf-7f5e-45aa-9d53-33d1f185515a";

function createStudentWebhookUrl(): string {
  const env = process.env.SIT_CREATE_STUDENT_WEBHOOK_URL?.trim();
  return env && /^https?:\/\//i.test(env)
    ? env
    : DEFAULT_CREATE_STUDENT_WEBHOOK_URL;
}

export interface SitStudentWebhookPayload {
  // identity (dynamic — auth uid + user_profile), same as the application webhook
  user_id: string;
  agency_id: string;
  crm_id: string;
  // basics
  first_name: string;
  last_name: string;
  gender?: string;
  date_of_birth?: string; // YYYY-MM-DD
  nationality?: string;
  email: string;
  mobile?: string;
  // passport
  passport_number?: string;
  passport_issue_date?: string; // YYYY-MM-DD
  passport_expiry_date?: string; // YYYY-MM-DD
  // family
  father_name?: string;
  mother_name?: string;
  // flags (safe defaults). The webhook mutation types these as String, and the
  // wizard sends lowercase "no"/"yes" — sending a JSON boolean makes the panel
  // read them as truthy ("Yes"), so these MUST be the string forms.
  transfer_student: "no" | "yes";
  have_tc: "no" | "yes";
  tc_number: string;
  blue_card: "no" | "yes";
  // zoho_countries ROW ID of the residence country (same dropdown contract as
  // `nationality`); falls back to nationality when apply has no residence.
  country_of_residence?: string;
  // academic (previous education, keyed by applied level).
  // education_level is the zoho_degrees ROW ID of the APPLIED-FOR degree (the
  // webhook rejects a plain name with `INVALID_DATA: Student_will_apply_for`);
  // education_level_name is the human label. The *_country fields are
  // zoho_countries ROW IDs (same dropdown contract as `nationality`).
  education_level?: string;
  education_level_name?: string;
  high_school_name?: string;
  high_school_gpa_percent?: string;
  high_school_country?: string;
  bachelor_school_name?: string;
  bachelor_gpa_percent?: string;
  bachelor_country?: string;
  master_school_name?: string;
  master_gpa_percent?: string;
  master_country?: string;
  // documents: the webhook mutation types `$documents` as String, and the wizard
  // JSON.stringify()s the array before submitting — so this is a JSON STRING, not
  // a raw array (a raw array can't be parsed by the webhook → 0 documents shown).
  photo_url: string;
  documents: string;
}

/**
 * POST the student-create payload to the n8n webhook. On `{ status: true, id }`
 * returns { id } (the Zoho-assigned student id); on any non-200, non-true
 * status, unparseable body, or network error returns null (caller reports fail).
 */
export async function createStudentViaWebhook(
  page: Page,
  payload: SitStudentWebhookPayload,
): Promise<{ id: string } | null> {
  const url = createStudentWebhookUrl();
  try {
    const res = await page.request.post(url, {
      headers: { "content-type": "application/json" },
      data: payload,
      timeout: 30_000,
    });
    const status = res.status();
    const bodyText = await res.text().catch(() => "");
    if (!res.ok()) {
      logger.warn(
        `[sit:webhook] student create başarısız (status=${status}) body=${rawForLog(bodyText)}`,
      );
      return null;
    }
    let json: { status?: unknown; id?: unknown } | null = null;
    try {
      json = JSON.parse(bodyText) as { status?: unknown; id?: unknown };
    } catch {
      json = null;
    }
    const id = json?.id;
    if (
      json?.status === true &&
      (typeof id === "string" || typeof id === "number") &&
      String(id)
    ) {
      logger.info(
        `[sit:webhook] student create OK (status=${status}, id=${String(id)})`,
      );
      return { id: String(id) };
    }
    logger.warn(
      `[sit:webhook] student create beklenmeyen yanıt (status=${status}) body=${rawForLog(bodyText)}`,
    );
    return null;
  } catch (e) {
    logger.warn(
      `[sit:webhook] student create hata: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}
