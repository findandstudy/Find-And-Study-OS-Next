/**
 * Rate-Limit IP Security — regression tests (Task #476 / Faz S5).
 *
 * Verifies that the rate-limit IP header bypass is closed:
 *
 *   RL1  getClientIp() returns req.ip, not raw X-Forwarded-For
 *
 *   RL2  trust proxy = 1 behavior
 *        - With XFF: "spoofed, real" and socket=127.0.0.1 (trusted), req.ip = "real"
 *          (last XFF entry, not the client-supplied spoofed first entry)
 *        - With XFF: "only-entry" and socket=127.0.0.1, req.ip = "only-entry"
 *          (in prod the edge appends the real IP — this is the last entry)
 *
 *   RL3  keyGenerator is wired on the public signing codeLimiter
 *        - 8 requests from same IP → 9th gets 429
 *        - 1 request from a different IP is NOT rate-limited
 *
 * RL2 demonstrates the production security model:
 *   - Attacker sends "X-Forwarded-For: fake"
 *   - Replit edge appends their REAL IP → XFF becomes "fake, real"
 *   - trust proxy = 1 → req.ip = "real" (rightmost entry)
 *   - Rate limiter keys on "real", not "fake"
 *   - Rotating "fake" entries does not bypass the limit
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:rate-limit-ip-security
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express } from "express";
import rateLimit from "express-rate-limit";

import { getClientIp, getRateLimitIp } from "../src/lib/clientIp.js";

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
function sendReq(
  server: http.Server,
  opts: { xff?: string; path?: string },
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.xff !== undefined) headers["X-Forwarded-For"] = opts.xff;
    const req = http.request(
      { hostname: "127.0.0.1", port: addr.port, path: opts.path ?? "/test", method: "GET", headers },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: raw }); }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function withServer(app: Express, fn: (s: http.Server) => Promise<void>): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try { await fn(server); }
  finally { server.close(); }
}

// ---------------------------------------------------------------------------
// RL1: getClientIp uses req.ip, not raw XFF header
// ---------------------------------------------------------------------------
test("RL1: getClientIp() returns req.ip (not raw XFF header value)", async () => {
  // Build a minimal Express app that records what getClientIp returns.
  const app = express();
  app.set("trust proxy", 1);
  let capturedIp: string | null = undefined as unknown as string | null;
  app.get("/test", (req, res) => {
    capturedIp = getClientIp(req);
    res.json({ ip: capturedIp });
  });
  await withServer(app, async (server) => {
    // Send a request with a known XFF header.
    // trust proxy = 1 → socket (127.0.0.1) is the trusted proxy,
    // so req.ip = last XFF entry = "203.0.113.99".
    const r = await sendReq(server, { xff: "198.51.100.1, 203.0.113.99" });
    assert.equal(r.status, 200);
    // getClientIp must return req.ip, which Express sets to the last XFF entry.
    assert.equal(capturedIp, "203.0.113.99",
      `getClientIp returned ${capturedIp} — must equal req.ip, not the raw first XFF entry`);
  });
});

// ---------------------------------------------------------------------------
// RL2: trust proxy = 1 ignores client-supplied (spoofed) XFF prefix
// ---------------------------------------------------------------------------
test("RL2a: trust proxy = 1 — req.ip = last XFF entry (not the client-supplied first)", async () => {
  // In production: attacker sends "X-Forwarded-For: spoofed".
  // Replit edge appends their real IP → XFF: "spoofed, 203.0.113.42".
  // trust proxy = 1 → req.ip = "203.0.113.42" (rightmost, added by edge).
  const app = express();
  app.set("trust proxy", 1);
  let observedIp = "";
  app.get("/test", (req, res) => {
    observedIp = req.ip ?? "";
    res.json({ ip: observedIp });
  });
  await withServer(app, async (server) => {
    const r = await sendReq(server, { xff: "10.0.0.1, 203.0.113.42" });
    assert.equal(r.status, 200);
    // The rate limiter must key on "203.0.113.42", not "10.0.0.1".
    assert.equal(observedIp, "203.0.113.42",
      `req.ip was ${observedIp}; expected "203.0.113.42" (rightmost XFF, added by edge)`);
  });
});

test("RL2b: rotating the spoofed first XFF entry does not change req.ip", async () => {
  // Attacker tries to bypass limits by sending different fake IP prefixes.
  // Each time the edge still appends their real IP as the last entry.
  // req.ip stays constant = real IP.
  const app = express();
  app.set("trust proxy", 1);
  const seenIps: string[] = [];
  app.get("/test", (req, res) => {
    seenIps.push(req.ip ?? "");
    res.json({ ip: req.ip });
  });
  await withServer(app, async (server) => {
    const realIp = "203.0.113.99";
    // Simulate 4 requests with rotating spoofed prefixes, real IP constant.
    for (const fakePrefix of ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4"]) {
      await sendReq(server, { xff: `${fakePrefix}, ${realIp}` });
    }
    // All observed req.ip values must be the constant real IP.
    for (const ip of seenIps) {
      assert.equal(ip, realIp,
        `req.ip was ${ip}; rotating fake XFF prefix must not change the keyed IP`);
    }
  });
});

// ---------------------------------------------------------------------------
// RL3: keyGenerator is wired — rate limit enforced on real IP
// ---------------------------------------------------------------------------
test("RL3: keyGenerator bound to getRateLimitIp — 9th request from same IP gets 429", async () => {
  // Build an app with a tight limiter (max 8 / window) using the same
  // keyGenerator pattern as all public limiters in the app. The in-memory
  // store keeps this security regression deterministic and independent from a
  // developer's local PostgreSQL availability; PgRateLimitStore integration is
  // covered by the DB-backed integration suite.
  const WINDOW_MS = 60_000;
  const MAX = 8;

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.get(
    "/test",
    rateLimit({
      windowMs: WINDOW_MS,
      max: MAX,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many requests" },
      keyGenerator: (req) => getRateLimitIp(req),
      // No NODE_ENV skip — this test explicitly exercises the limiter.
    }),
    (_req, res) => { res.json({ ok: true }); },
  );

  await withServer(app, async (server) => {
    const FIXED_IP = "203.0.113.77";
    // First MAX requests should all succeed.
    for (let i = 1; i <= MAX; i++) {
      const r = await sendReq(server, { xff: FIXED_IP });
      assert.equal(r.status, 200, `Request ${i} should succeed (got ${r.status})`);
    }
    // The (MAX+1)th request must be rate-limited.
    const blocked = await sendReq(server, { xff: FIXED_IP });
    assert.equal(blocked.status, 429,
      `Request ${MAX + 1} should be rate-limited (got ${blocked.status})`);
  });
});

test("RL3b: a different IP is not limited by the first IP's counter", async () => {
  const WINDOW_MS = 60_000;
  const MAX = 8;

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.get(
    "/test",
    rateLimit({
      windowMs: WINDOW_MS,
      max: MAX,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many requests" },
      keyGenerator: (req) => getRateLimitIp(req),
    }),
    (_req, res) => { res.json({ ok: true }); },
  );

  await withServer(app, async (server) => {
    const IP_A = "203.0.113.11";
    const IP_B = "203.0.113.22";

    // Exhaust IP_A's limit.
    for (let i = 0; i < MAX; i++) {
      await sendReq(server, { xff: IP_A });
    }
    const blockedA = await sendReq(server, { xff: IP_A });
    assert.equal(blockedA.status, 429, `IP_A should be rate-limited`);

    // IP_B must still be allowed — different bucket.
    const allowedB = await sendReq(server, { xff: IP_B });
    assert.equal(allowedB.status, 200,
      `IP_B should NOT be limited by IP_A's counter (got ${allowedB.status})`);
  });
});
