/**
 * Meta DM (Messenger + Instagram) unit tests — Omnichannel Faz 6.
 *
 * Pure unit coverage for the shared Meta messaging helpers. No DB / no server.
 * DM-only: comment / feed events are out of scope for this phase.
 *
 *   - verifyMetaSignature: happy path / bad signature / missing appSecret /
 *     missing signature header.
 *   - parseMessengerWebhook / parseInstagramWebhook / parseMetaMessaging:
 *     normalize a user message, skip echoes, skip delivery/read receipts,
 *     attachment-only text fallback, skip events missing a mid, epoch-ms
 *     timestamp parsing, and channel tagging.
 *   - sendMessengerText / sendInstagramText: simulated success in dev (no
 *     network), and the exact Graph `me/messages` request body schema when
 *     live (global fetch stubbed).
 *   - isWithin24hWindow: inside / outside / null.
 *
 * Run:
 *   pnpm --filter @workspace/api-server run test:meta-dm
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

import {
  verifyMetaSignature,
  parseMetaMessaging,
} from "../src/lib/inbox/channels/meta-shared.js";
import {
  parseMessengerWebhook,
  sendMessengerText,
} from "../src/lib/inbox/channels/messenger.js";
import {
  parseInstagramWebhook,
  sendInstagramText,
} from "../src/lib/inbox/channels/instagram.js";
import { isWithin24hWindow } from "../src/lib/inbox/channels/whatsapp.js";

// ---------------------------------------------------------------------------
// verifyMetaSignature
// ---------------------------------------------------------------------------

const APP_SECRET = "unit_meta_app_secret";
function sign(body: string, secret = APP_SECRET): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

test("verifyMetaSignature: accepts a correctly signed body", () => {
  const body = JSON.stringify({ object: "page", entry: [] });
  assert.equal(verifyMetaSignature(body, sign(body), APP_SECRET), true);
});

test("verifyMetaSignature: accepts a Buffer body identical to the signed bytes", () => {
  const body = Buffer.from(JSON.stringify({ object: "instagram", entry: [] }));
  const header = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(body).digest("hex");
  assert.equal(verifyMetaSignature(body, header, APP_SECRET), true);
});

test("verifyMetaSignature: rejects a body signed with the wrong secret", () => {
  const body = JSON.stringify({ object: "page", entry: [] });
  assert.equal(verifyMetaSignature(body, sign(body, "other_secret"), APP_SECRET), false);
});

test("verifyMetaSignature: rejects a tampered body", () => {
  const body = JSON.stringify({ object: "page", entry: [] });
  const header = sign(body);
  assert.equal(verifyMetaSignature(body + "x", header, APP_SECRET), false);
});

test("verifyMetaSignature: rejects when appSecret is missing", () => {
  const body = JSON.stringify({ object: "page", entry: [] });
  assert.equal(verifyMetaSignature(body, sign(body), undefined), false);
});

test("verifyMetaSignature: rejects when the signature header is missing", () => {
  const body = JSON.stringify({ object: "page", entry: [] });
  assert.equal(verifyMetaSignature(body, undefined, APP_SECRET), false);
});

// ---------------------------------------------------------------------------
// parse* (Messenger / Instagram / shared)
// ---------------------------------------------------------------------------

function messengerPayload(overrides: {
  mid?: string;
  text?: string;
  senderId?: string;
  timestamp?: number;
  isEcho?: boolean;
  attachments?: unknown[];
  noMessage?: boolean;
}): unknown {
  const evt: Record<string, unknown> = {
    sender: { id: overrides.senderId ?? "psid_123" },
    recipient: { id: "page_1" },
    timestamp: overrides.timestamp ?? 1_700_000_000_000,
  };
  if (!overrides.noMessage) {
    const message: Record<string, unknown> = {
      mid: overrides.mid ?? "mid_abc",
    };
    if (overrides.text !== undefined) message.text = overrides.text;
    if (overrides.isEcho) message.is_echo = true;
    if (overrides.attachments) message.attachments = overrides.attachments;
    evt.message = message;
  }
  return { object: "page", entry: [{ id: "page_1", time: 1, messaging: [evt] }] };
}

test("parseMessengerWebhook: normalizes a plain text DM", () => {
  const out = parseMessengerWebhook(
    messengerPayload({ mid: "mid_1", text: "hello", senderId: "psid_9", timestamp: 1_700_000_000_000 }),
  );
  assert.equal(out.length, 1);
  const m = out[0];
  assert.equal(m.channel, "messenger");
  assert.equal(m.externalUserId, "psid_9");
  assert.equal(m.text, "hello");
  assert.equal(m.externalMessageId, "mid_1");
  assert.ok(m.timestamp instanceof Date);
  assert.equal(m.timestamp.getTime(), 1_700_000_000_000);
});

test("parseInstagramWebhook: tags the instagram channel", () => {
  const payload = { object: "instagram", entry: [{ id: "ig_1", messaging: [{ sender: { id: "igsid_5" }, recipient: { id: "ig_1" }, timestamp: 1_700_000_000_001, message: { mid: "ig_mid", text: "hi ig" } }] }] };
  const out = parseInstagramWebhook(payload);
  assert.equal(out.length, 1);
  assert.equal(out[0].channel, "instagram");
  assert.equal(out[0].externalUserId, "igsid_5");
  assert.equal(out[0].text, "hi ig");
});

test("parseMetaMessaging: skips echoes of our own outbound messages", () => {
  const out = parseMetaMessaging(messengerPayload({ isEcho: true, text: "echoed" }), "messenger");
  assert.equal(out.length, 0);
});

test("parseMetaMessaging: skips delivery / read receipts (no message object)", () => {
  const out = parseMetaMessaging(messengerPayload({ noMessage: true }), "messenger");
  assert.equal(out.length, 0);
});

test("parseMetaMessaging: skips events with no mid", () => {
  const payload = { object: "page", entry: [{ messaging: [{ sender: { id: "psid_1" }, timestamp: 1, message: { text: "no id" } }] }] };
  assert.equal(parseMetaMessaging(payload, "messenger").length, 0);
});

test("parseMetaMessaging: falls back to an attachment placeholder when text is empty", () => {
  const out = parseMetaMessaging(
    messengerPayload({ mid: "mid_att", attachments: [{ type: "image", payload: { url: "https://x/y.jpg" } }] }),
    "messenger",
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "[image]");
  assert.equal(out[0].attachments?.[0].type, "image");
  assert.equal(out[0].attachments?.[0].url, "https://x/y.jpg");
});

test("parseMetaMessaging: returns [] for a comment/feed change payload (DM-only)", () => {
  const payload = { object: "page", entry: [{ id: "page_1", changes: [{ field: "feed", value: { item: "comment" } }] }] };
  assert.equal(parseMetaMessaging(payload, "messenger").length, 0);
});

// ---------------------------------------------------------------------------
// sendMessengerText / sendInstagramText
// ---------------------------------------------------------------------------

test("sendMessengerText: simulated success in dev (no live integrations)", async () => {
  const prev = process.env.ALLOW_LIVE_INTEGRATIONS;
  delete process.env.ALLOW_LIVE_INTEGRATIONS;
  try {
    const res = await sendMessengerText({ config: { pageAccessToken: "tok" }, recipientId: "psid_1", text: "hi" });
    assert.equal(res.ok, true);
    assert.equal(res.simulated, true);
    assert.ok(res.externalMessageId?.startsWith("sim_msgr_"));
  } finally {
    if (prev === undefined) delete process.env.ALLOW_LIVE_INTEGRATIONS;
    else process.env.ALLOW_LIVE_INTEGRATIONS = prev;
  }
});

test("sendInstagramText: simulated success in dev (no live integrations)", async () => {
  const prev = process.env.ALLOW_LIVE_INTEGRATIONS;
  delete process.env.ALLOW_LIVE_INTEGRATIONS;
  try {
    const res = await sendInstagramText({ config: { pageAccessToken: "tok" }, recipientId: "igsid_1", text: "hi" });
    assert.equal(res.ok, true);
    assert.equal(res.simulated, true);
    assert.ok(res.externalMessageId?.startsWith("sim_ig_"));
  } finally {
    if (prev === undefined) delete process.env.ALLOW_LIVE_INTEGRATIONS;
    else process.env.ALLOW_LIVE_INTEGRATIONS = prev;
  }
});

/**
 * In live mode the Graph `me/messages` body must be exactly
 * { recipient: { id }, messaging_type: "RESPONSE", message: { text } } with a
 * Bearer page access token. We stub global fetch to capture and assert it
 * without making a real network call.
 */
async function withLiveFetchCapture<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; calls: Array<{ url: string; init: RequestInit }> }> {
  const prevEnv = process.env.ALLOW_LIVE_INTEGRATIONS;
  const prevNodeEnv = process.env.NODE_ENV;
  const prevFetch = globalThis.fetch;
  process.env.ALLOW_LIVE_INTEGRATIONS = "true";
  // Ensure we are NOT in production so we never hit real Meta even if env leaks.
  if (prevNodeEnv === "production") process.env.NODE_ENV = "test";
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ message_id: "mid_live_1", recipient_id: "r1" }),
    } as unknown as Response;
  }) as typeof fetch;
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    globalThis.fetch = prevFetch;
    if (prevEnv === undefined) delete process.env.ALLOW_LIVE_INTEGRATIONS;
    else process.env.ALLOW_LIVE_INTEGRATIONS = prevEnv;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  }
}

test("sendMessengerText: live request body matches the Graph me/messages schema", async () => {
  const { result, calls } = await withLiveFetchCapture(() =>
    sendMessengerText({ config: { pageAccessToken: "page_tok_msgr" }, recipientId: "psid_42", text: "yo" }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.simulated, false);
  assert.equal(result.externalMessageId, "mid_live_1");
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.ok(url.endsWith("/me/messages"), `unexpected url: ${url}`);
  assert.match(url, /graph\.facebook\.com\/v21\.0\/me\/messages$/);
  assert.equal(init.method, "POST");
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer page_tok_msgr");
  assert.equal(headers["Content-Type"], "application/json");
  const body = JSON.parse(String(init.body));
  assert.deepEqual(body, { recipient: { id: "psid_42" }, messaging_type: "RESPONSE", message: { text: "yo" } });
});

test("sendInstagramText: live request body matches the Graph me/messages schema", async () => {
  const { result, calls } = await withLiveFetchCapture(() =>
    sendInstagramText({ config: { pageAccessToken: "page_tok_ig" }, recipientId: "igsid_42", text: "ig live" }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.simulated, false);
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.match(url, /graph\.facebook\.com\/v21\.0\/me\/messages$/);
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer page_tok_ig");
  const body = JSON.parse(String(init.body));
  assert.deepEqual(body, { recipient: { id: "igsid_42" }, messaging_type: "RESPONSE", message: { text: "ig live" } });
});

// ---------------------------------------------------------------------------
// isWithin24hWindow (shared across WhatsApp + Messenger + Instagram)
// ---------------------------------------------------------------------------

test("isWithin24hWindow: true when the last inbound was minutes ago", () => {
  assert.equal(isWithin24hWindow(new Date(Date.now() - 5 * 60_000)), true);
});

test("isWithin24hWindow: false when the last inbound was over 24h ago", () => {
  assert.equal(isWithin24hWindow(new Date(Date.now() - 25 * 60 * 60_000)), false);
});

test("isWithin24hWindow: false when there is no inbound timestamp", () => {
  assert.equal(isWithin24hWindow(null), false);
  assert.equal(isWithin24hWindow(undefined), false);
});
