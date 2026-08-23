/**
 * Multi-account-per-channel test coverage (Task #554).
 *
 * Two layers are exercised:
 *
 *  1. Resolver unit checks (resolveInboundAccount / resolveOutboundConfig in
 *     src/lib/inbox/channelAccountConfig.ts) against real channel_accounts rows:
 *       - inbound resolution matches by (channel, externalAccountId) only when
 *         the account is active; returns null (legacy fallback) otherwise.
 *       - outbound resolution returns the referenced active account's config,
 *         and refuses it (falls back) when the account is inactive, missing,
 *         null, or on a different channel.
 *
 *  2. CRUD route invariants (routes/channelAccounts.ts) through Express with a
 *     mocked super_admin:
 *       - create returns 201, secrets are masked on the way out.
 *       - set-default keeps exactly one default per channel.
 *       - toggle-active flips isActive + status.
 *       - update with a still-masked secret preserves the stored credential
 *         (no credential loss — the core constraint of this task).
 *       - test runs in simulated mode without live network calls.
 *       - delete removes the row and never leaves a channel with >1 default.
 *
 * All rows are tagged with a per-run id and cleaned up; the test is safe to run
 * against the shared dev database. The legacy single-config integrations row is
 * never touched.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:multi-account
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express } from "express";
import { and, eq, inArray, like } from "drizzle-orm";
import { db, channelAccountsTable } from "@workspace/db";
import channelAccountsRouter from "../src/routes/channelAccounts.js";
import {
  resolveInboundAccount,
  resolveOutboundConfig,
  serializeAccountConfig,
  parseAccountConfig,
} from "../src/lib/inbox/channelAccountConfig.js";

const RUN_ID = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const MOCK_USER = { id: 1, role: "super_admin", isActive: true, emailVerified: true };

const createdIds: number[] = [];

function tag(s: string): string {
  return `${s}_${RUN_ID}`;
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { ...MOCK_USER };
    if (!("cookies" in req)) (req as any).cookies = {};
    next();
  });
  app.use("/api", channelAccountsRouter);
  return app;
}

function sendReq(
  server: http.Server,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const json = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(json !== undefined ? { "Content-Length": Buffer.byteLength(json) } : {}),
        },
      },
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
    if (json !== undefined) req.write(json);
    req.end();
  });
}

function listen(app: Express): Promise<http.Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((r) => server.close(() => r()));
}

/** Insert a channel_accounts row directly (bypassing the route) for resolver tests. */
async function insertAccount(opts: {
  channel: string;
  externalAccountId: string;
  config: Record<string, any>;
  isActive: boolean;
  isDefault?: boolean;
}): Promise<number> {
  const [row] = await db.insert(channelAccountsTable).values({
    channel: opts.channel,
    displayName: tag(`acct_${opts.channel}`),
    externalAccountId: opts.externalAccountId,
    configEncrypted: serializeAccountConfig(opts.config),
    status: opts.isActive ? "active" : "inactive",
    isActive: opts.isActive,
    isDefault: opts.isDefault ?? false,
  }).returning();
  createdIds.push(row.id);
  return row.id;
}

after(async () => {
  // Clean up everything tagged with this run (route-created + direct inserts).
  if (createdIds.length > 0) {
    await db.delete(channelAccountsTable).where(inArray(channelAccountsTable.id, createdIds));
  }
  await db.delete(channelAccountsTable).where(like(channelAccountsTable.displayName, `%${RUN_ID}%`));
});

// ---------------------------------------------------------------------------
// 1. Resolver unit checks
// ---------------------------------------------------------------------------

test("resolveInboundAccount matches active account by external id; null otherwise", async () => {
  const extActive = tag("wa_phone_active");
  const extInactive = tag("wa_phone_inactive");
  const secret = `INBOUND_SECRET_${RUN_ID}`;

  const activeId = await insertAccount({
    channel: "whatsapp",
    externalAccountId: extActive,
    config: { phoneNumberId: extActive, accessToken: "tok", appSecret: secret },
    isActive: true,
  });
  await insertAccount({
    channel: "whatsapp",
    externalAccountId: extInactive,
    config: { phoneNumberId: extInactive, accessToken: "tok", appSecret: secret },
    isActive: false,
  });

  const matched = await resolveInboundAccount<{ appSecret: string }>("whatsapp", extActive);
  assert.ok(matched, "active account should resolve");
  assert.equal(matched!.channelAccountId, activeId);
  assert.equal(matched!.config.appSecret, secret, "decrypted secret should round-trip");

  const inactive = await resolveInboundAccount("whatsapp", extInactive);
  assert.equal(inactive, null, "inactive account must NOT resolve (legacy fallback)");

  const unknown = await resolveInboundAccount("whatsapp", tag("never_seen"));
  assert.equal(unknown, null, "unknown external id must not resolve");

  const missing = await resolveInboundAccount("whatsapp", null);
  assert.equal(missing, null, "missing external id must not resolve");

  // Channel scoping: same external id on a different channel must not cross over.
  const crossChannel = await resolveInboundAccount("messenger", extActive);
  assert.equal(crossChannel, null, "external id is scoped to its channel");
});

test("resolveOutboundConfig returns active account config, refuses inactive/null/mismatch", async () => {
  const ext = tag("ig_acct_out");
  const secret = `OUTBOUND_TOKEN_${RUN_ID}`;
  const activeId = await insertAccount({
    channel: "instagram",
    externalAccountId: ext,
    config: { igBusinessAccountId: ext, pageAccessToken: secret },
    isActive: true,
  });
  const inactiveId = await insertAccount({
    channel: "instagram",
    externalAccountId: tag("ig_acct_out_off"),
    config: { igBusinessAccountId: tag("ig_acct_out_off"), pageAccessToken: secret },
    isActive: false,
  });

  const active = await resolveOutboundConfig<{ pageAccessToken: string }>("instagram", activeId);
  assert.ok(active, "active account should resolve a config");
  assert.equal(active!.pageAccessToken, secret, "outbound returns the account's own secret");

  // Inactive → must not return THIS account's secret (falls back to legacy/null).
  const inactive = await resolveOutboundConfig<{ pageAccessToken?: string }>("instagram", inactiveId);
  assert.notEqual(inactive?.pageAccessToken, secret, "inactive account config must not be used");

  // Null id → legacy fallback, never this account's secret.
  const legacy = await resolveOutboundConfig<{ pageAccessToken?: string }>("instagram", null);
  assert.notEqual(legacy?.pageAccessToken, secret, "null id must not return a per-account secret");

  // Channel mismatch (instagram account id queried as whatsapp) → fallback.
  const mismatch = await resolveOutboundConfig<{ pageAccessToken?: string }>("whatsapp", activeId);
  assert.notEqual(mismatch?.pageAccessToken, secret, "channel mismatch must not return the account secret");
});

// ---------------------------------------------------------------------------
// 2. CRUD route invariants
// ---------------------------------------------------------------------------

test("CRUD: create masks secrets, set-default is exclusive, toggle + masked-update preserve credentials, delete keeps <=1 default", async () => {
  const app = buildApp();
  const server = await listen(app);
  const channel = "instagram";
  const secretA = `PAT_A_${RUN_ID}`;
  const secretB = `PAT_B_${RUN_ID}`;

  try {
    // --- create A ---
    const createA = await sendReq(server, "POST", "/api/channel-accounts", {
      channel,
      displayName: tag("crud_A"),
      config: { igBusinessAccountId: tag("ig_A"), pageAccessToken: secretA, appSecret: `AS_A_${RUN_ID}` },
    });
    assert.equal(createA.status, 201, `create A: ${JSON.stringify(createA.body)}`);
    const idA = createA.body.id as number;
    createdIds.push(idA);
    assert.equal(createA.body.externalAccountId, tag("ig_A"), "external id derived from igBusinessAccountId");
    assert.ok(
      typeof createA.body.config.pageAccessToken === "string" && createA.body.config.pageAccessToken.includes("•"),
      "secret must be masked in the response",
    );
    assert.ok(!createA.body.config.pageAccessToken.includes(secretA), "raw secret must never be returned");

    // --- create B ---
    const createB = await sendReq(server, "POST", "/api/channel-accounts", {
      channel,
      displayName: tag("crud_B"),
      config: { igBusinessAccountId: tag("ig_B"), pageAccessToken: secretB },
    });
    assert.equal(createB.status, 201, `create B: ${JSON.stringify(createB.body)}`);
    const idB = createB.body.id as number;
    createdIds.push(idB);

    // --- set-default A, then B: exactly one default per channel ---
    const setA = await sendReq(server, "PATCH", `/api/channel-accounts/${idA}/set-default`);
    assert.equal(setA.status, 200);
    assert.equal(setA.body.isDefault, true);

    let list = await sendReq(server, "GET", `/api/channel-accounts?channel=${channel}`);
    assert.equal(list.status, 200);
    let defaults = (list.body.accounts as any[]).filter((a) => a.isDefault);
    assert.equal(defaults.length, 1, "exactly one default after set-default A");
    assert.equal(defaults[0].id, idA, "A is the default");

    const setB = await sendReq(server, "PATCH", `/api/channel-accounts/${idB}/set-default`);
    assert.equal(setB.status, 200);
    list = await sendReq(server, "GET", `/api/channel-accounts?channel=${channel}`);
    defaults = (list.body.accounts as any[]).filter((a) => a.isDefault);
    assert.equal(defaults.length, 1, "exactly one default after set-default B");
    assert.equal(defaults[0].id, idB, "B is now the default, A cleared");

    // --- toggle-active B ---
    const beforeB = (list.body.accounts as any[]).find((a) => a.id === idB);
    const toggle = await sendReq(server, "PATCH", `/api/channel-accounts/${idB}/toggle-active`);
    assert.equal(toggle.status, 200);
    assert.equal(toggle.body.isActive, !beforeB.isActive, "isActive flips");
    assert.equal(toggle.body.status, toggle.body.isActive ? "active" : "inactive", "status mirrors isActive");

    // --- masked update of A must preserve the stored credential ---
    const maskedA = createA.body.config.pageAccessToken; // contains "•"
    const updateA = await sendReq(server, "PUT", `/api/channel-accounts/${idA}`, {
      displayName: tag("crud_A_renamed"),
      config: { igBusinessAccountId: tag("ig_A"), pageAccessToken: maskedA },
    });
    assert.equal(updateA.status, 200, `update A: ${JSON.stringify(updateA.body)}`);
    assert.equal(updateA.body.displayName, tag("crud_A_renamed"));
    const [rowA] = await db.select().from(channelAccountsTable).where(eq(channelAccountsTable.id, idA));
    const plainA = parseAccountConfig(rowA.configEncrypted);
    assert.equal(plainA.pageAccessToken, secretA, "masked update must NOT overwrite the stored secret");

    // --- test endpoint in simulated mode (no live network) ---
    const testRes = await sendReq(server, "POST", `/api/channel-accounts/${idA}/test`);
    assert.equal(testRes.status, 200);
    assert.equal(testRes.body.success, true, "simulated-mode test should pass without live creds");

    // --- delete B then A; channel must never have >1 default ---
    const delB = await sendReq(server, "DELETE", `/api/channel-accounts/${idB}`);
    assert.equal(delB.status, 200);
    const delA = await sendReq(server, "DELETE", `/api/channel-accounts/${idA}`);
    assert.equal(delA.status, 200);

    const finalList = await sendReq(server, "GET", `/api/channel-accounts?channel=${channel}`);
    const stillThere = (finalList.body.accounts as any[]).filter((a) => a.id === idA || a.id === idB);
    assert.equal(stillThere.length, 0, "both deleted rows are gone");
    const finalDefaults = (finalList.body.accounts as any[]).filter((a) => a.isDefault);
    assert.ok(finalDefaults.length <= 1, "channel never has more than one default");
  } finally {
    await close(server);
  }
});

test("CRUD: rejects unsupported channel and missing displayName", async () => {
  const app = buildApp();
  const server = await listen(app);
  try {
    const badChannel = await sendReq(server, "POST", "/api/channel-accounts", {
      channel: "telegram",
      displayName: tag("bad"),
      config: {},
    });
    assert.equal(badChannel.status, 400, "unsupported channel rejected");

    const noName = await sendReq(server, "POST", "/api/channel-accounts", {
      channel: "whatsapp",
      displayName: "   ",
      config: {},
    });
    assert.equal(noName.status, 400, "blank displayName rejected");
  } finally {
    await close(server);
  }
});
