import crypto from "crypto";
import { isLiveIntegrationsEnabled } from "../liveMode";

/**
 * Meta Graph API version used across every Meta channel (WhatsApp Cloud API,
 * Messenger, Instagram). Kept as a single source of truth so all channels stay
 * on the same version. Aligned with the WhatsApp Cloud API version.
 */
export const META_API_VERSION = "v21.0";

/**
 * Verify the X-Hub-Signature-256 header from any Meta webhook request
 * (WhatsApp, Messenger, Instagram). Meta signs the raw request body with the
 * app secret using HMAC-SHA256 and sends the digest as `sha256=<hex>`.
 *
 * Returns false (reject) when either appSecret or signatureHeader is missing,
 * so unsigned/spoofed payloads are never accepted in production. The comparison
 * is constant-time to avoid leaking the expected digest via timing.
 */
export function verifyMetaSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  appSecret: string | undefined,
): boolean {
  if (!appSecret || !signatureHeader) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

/**
 * A normalized inbound message shared by every Meta Messaging channel
 * (Messenger and Instagram DMs). Both channels deliver structurally identical
 * `entry[].messaging[]` events, so they map onto the same shape.
 */
export interface MetaAttachment {
  type: string;
  url?: string;
}

export interface MetaInbound {
  channel: "messenger" | "instagram";
  /** The sender's page-scoped (PSID) / IG-scoped (IGSID) id. Also the thread key. */
  externalUserId: string;
  displayName?: string;
  text: string;
  externalMessageId: string;
  attachments?: MetaAttachment[];
  timestamp: Date;
  raw: Record<string, unknown>;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/**
 * Parse a Meta Messaging webhook payload (`object: "page"` for Messenger or
 * `object: "instagram"` for Instagram DMs) into normalized inbound messages.
 *
 * Only user-sent messages are returned. Delivery / read receipts, postbacks,
 * and echoes of our own outbound messages are skipped. Comment / feed events
 * (`entry[].changes[]`) are ignored here — they carry no `messaging[]` array —
 * and are handled in a later comments phase.
 */
export function parseMetaMessaging(
  payload: unknown,
  channel: "messenger" | "instagram",
): MetaInbound[] {
  const out: MetaInbound[] = [];
  const root = asRecord(payload);
  const entries = Array.isArray(root.entry) ? (root.entry as unknown[]) : [];
  for (const entryRaw of entries) {
    const entry = asRecord(entryRaw);
    const messaging = Array.isArray(entry.messaging) ? (entry.messaging as unknown[]) : [];
    for (const evtRaw of messaging) {
      const evt = asRecord(evtRaw);
      // Only message events carry a `message` object; skip delivery/read/postback.
      if (!evt.message || typeof evt.message !== "object") continue;
      const message = asRecord(evt.message);
      // Skip echoes of our own outbound messages.
      if (message.is_echo === true) continue;
      const mid = typeof message.mid === "string" ? message.mid : "";
      if (!mid) continue;
      const sender = asRecord(evt.sender);
      const externalUserId =
        typeof sender.id === "string"
          ? sender.id
          : sender.id != null
            ? String(sender.id)
            : "";
      if (!externalUserId) continue;

      const attachmentsRaw = Array.isArray(message.attachments)
        ? (message.attachments as unknown[])
        : [];
      const attachments: MetaAttachment[] = attachmentsRaw.map((a) => {
        const att = asRecord(a);
        const payloadObj = asRecord(att.payload);
        return {
          type: typeof att.type === "string" ? att.type : "unknown",
          url: typeof payloadObj.url === "string" ? payloadObj.url : undefined,
        };
      });

      const rawText = typeof message.text === "string" ? message.text : "";
      let text = rawText;
      if (!text) {
        text = attachments.length > 0 ? `[${attachments[0].type}]` : "[message]";
      }

      // Meta messaging timestamps are epoch milliseconds.
      const tsNum =
        typeof evt.timestamp === "number" ? evt.timestamp : Number(evt.timestamp);
      const timestamp = Number.isFinite(tsNum) && tsNum > 0 ? new Date(tsNum) : new Date();

      out.push({
        channel,
        externalUserId,
        text,
        externalMessageId: mid,
        attachments: attachments.length > 0 ? attachments : undefined,
        timestamp,
        raw: evt,
      });
    }
  }
  return out;
}

/**
 * Result of a Meta Messaging send (Messenger / Instagram). Mirrors the
 * WhatsApp send-result shape so all Meta channels report uniformly.
 */
export interface MetaSendResult {
  ok: boolean;
  externalMessageId?: string;
  error?: string;
  simulated: boolean;
}

// Retry policy mirrors the WhatsApp Cloud API client: long back-off on 429
// (rate limit) and a short exponential back-off on transient 5xx / network
// errors. Max 3 attempts so a calling request never hangs unbounded.
const META_429_WAIT_MS = 60_000;
const META_5XX_BACKOFF_MS = [250, 750, 1750];
const META_429_MAX_WAIT_MS = 65_000; // hard cap on Retry-After

async function sendMetaGraphRequest(
  url: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; error: string }> {
  const maxAttempts = 3;
  let last: { status: number; error: string } = { status: 0, error: "no_attempt" };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const data: unknown = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true, data };

      const errObj = (data as { error?: { message?: string } })?.error;
      const errMsg = errObj?.message || `HTTP ${res.status}`;
      last = { status: res.status, error: errMsg };

      const isRateLimit = res.status === 429;
      const is5xx = res.status >= 500 && res.status < 600;
      const retriable = isRateLimit || is5xx;
      if (!retriable || attempt === maxAttempts - 1) {
        return { ok: false, status: res.status, error: errMsg };
      }

      let waitMs: number;
      if (isRateLimit) {
        const retryAfter = res.headers.get("retry-after");
        const retryAfterMs = retryAfter ? Math.min(parseInt(retryAfter, 10) * 1000, META_429_MAX_WAIT_MS) : NaN;
        waitMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : META_429_WAIT_MS;
      } else {
        waitMs = META_5XX_BACKOFF_MS[attempt] ?? META_5XX_BACKOFF_MS[META_5XX_BACKOFF_MS.length - 1];
      }
      await new Promise((r) => setTimeout(r, waitMs));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "network_error";
      last = { status: 0, error: msg };
      if (attempt === maxAttempts - 1) break;
      const waitMs = META_5XX_BACKOFF_MS[attempt] ?? META_5XX_BACKOFF_MS[META_5XX_BACKOFF_MS.length - 1];
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  return { ok: false, status: last.status, error: last.error };
}

/**
 * Send a free-form text message to a Messenger / Instagram user via the Meta
 * Graph API `me/messages` endpoint. Both channels share this transport: a
 * page-scoped access token authenticates, the recipient is addressed by their
 * page-/IG-scoped id, and `messaging_type: "RESPONSE"` keeps the send inside
 * the standard messaging window.
 *
 * In dev (without ALLOW_LIVE_INTEGRATIONS) returns a simulated success with a
 * synthesized externalMessageId so the rest of the pipeline can run. On a live
 * non-ok response it logs and returns ok:false with the Graph API error so the
 * caller can surface it (e.g. token / permission errors #200 / #10 before
 * Advanced Access is granted).
 */
export async function sendMetaText(opts: {
  pageAccessToken: string | undefined;
  recipientId: string;
  text: string;
  simulatedPrefix: string;
  notConfiguredError: string;
  logLabel: string;
}): Promise<MetaSendResult> {
  const { pageAccessToken, recipientId, text, simulatedPrefix, notConfiguredError, logLabel } = opts;

  if (!isLiveIntegrationsEnabled()) {
    return {
      ok: true,
      externalMessageId: `${simulatedPrefix}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      simulated: true,
    };
  }

  if (!pageAccessToken) {
    return { ok: false, error: notConfiguredError, simulated: false };
  }
  if (!recipientId) {
    return { ok: false, error: "Conversation has no recipient id", simulated: false };
  }

  const url = `https://graph.facebook.com/${META_API_VERSION}/me/messages`;
  const result = await sendMetaGraphRequest(url, pageAccessToken, {
    recipient: { id: recipientId },
    messaging_type: "RESPONSE",
    message: { text },
  });
  if (!result.ok) {
    console.error(`[${logLabel}] send failed:`, result.error);
    return { ok: false, error: result.error, simulated: false };
  }
  const externalMessageId = (result.data as Record<string, any>)?.message_id;
  return { ok: true, externalMessageId, simulated: false };
}

/**
 * Returns true when any entry carries a `changes[]` array — i.e. a feed /
 * comment / mention event rather than a DM. The unified Meta route logs and
 * skips these (handled in the comments phase).
 */
export function hasMetaChanges(payload: unknown): boolean {
  const root = asRecord(payload);
  const entries = Array.isArray(root.entry) ? (root.entry as unknown[]) : [];
  return entries.some((e) => {
    const changes = asRecord(e).changes;
    return Array.isArray(changes) && changes.length > 0;
  });
}
