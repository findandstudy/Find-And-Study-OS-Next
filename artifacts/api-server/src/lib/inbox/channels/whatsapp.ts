import { isLiveIntegrationsEnabled } from "../liveMode";
import { verifyMetaSignature, META_API_VERSION } from "./meta-shared";

const WA_API_VERSION = META_API_VERSION;

export interface WhatsAppConfig {
  phoneNumberId?: string;
  accessToken?: string;
  businessAccountId?: string;
  webhookVerifyToken?: string;
  appSecret?: string;
}

export interface WhatsAppSendResult {
  ok: boolean;
  externalMessageId?: string;
  error?: string;
  simulated: boolean;
}

const SIMULATED_PREFIX = "sim_wa_";

/**
 * Verify the X-Hub-Signature-256 header from a WhatsApp webhook request.
 *
 * Returns false (reject) when either appSecret or signatureHeader is missing,
 * so unsigned spoofed payloads are never accepted in production.
 */
export function verifyWhatsAppSignature(rawBody: Buffer | string, signatureHeader: string | undefined, appSecret: string | undefined): boolean {
  return verifyMetaSignature(rawBody, signatureHeader, appSecret);
}

/**
 * Send a free-form text message via the WhatsApp Cloud API.
 *
 * In dev (and without ALLOW_LIVE_INTEGRATIONS), returns a simulated success
 * with a synthesized externalMessageId so the rest of the pipeline can run.
 */
/**
 * Send a WA Cloud API request with bounded retry+backoff.
 *
 * Per the WhatsApp Cloud API rate-limit spec, on HTTP 429 we MUST back off for
 * roughly a minute before retrying (or honor the Retry-After header if Meta
 * returns one). For transient 5xx / network errors we use a much shorter
 * exponential backoff so writes don't stall under brief upstream blips.
 *
 * Max 3 attempts total. Per-attempt delays are capped to keep p99 latency
 * bounded for the calling request.
 */
const WA_429_WAIT_MS = 60_000;
const WA_5XX_BACKOFF_MS = [250, 750, 1750];
const WA_429_MAX_WAIT_MS = 65_000; // hard cap on Retry-After to avoid request hangs

async function sendWaApiRequest(
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
        const retryAfterMs = retryAfter ? Math.min(parseInt(retryAfter, 10) * 1000, WA_429_MAX_WAIT_MS) : NaN;
        waitMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : WA_429_WAIT_MS;
      } else {
        waitMs = WA_5XX_BACKOFF_MS[attempt] ?? WA_5XX_BACKOFF_MS[WA_5XX_BACKOFF_MS.length - 1];
      }
      await new Promise((r) => setTimeout(r, waitMs));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "network_error";
      last = { status: 0, error: msg };
      // Network errors are retriable; use short backoff.
      if (attempt === maxAttempts - 1) break;
      const waitMs = WA_5XX_BACKOFF_MS[attempt] ?? WA_5XX_BACKOFF_MS[WA_5XX_BACKOFF_MS.length - 1];
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  return { ok: false, status: last.status, error: last.error };
}

export async function sendWhatsAppText(opts: {
  config: WhatsAppConfig;
  toPhoneE164: string;
  text: string;
}): Promise<WhatsAppSendResult> {
  const { config, toPhoneE164, text } = opts;

  if (!isLiveIntegrationsEnabled()) {
    return {
      ok: true,
      externalMessageId: `${SIMULATED_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      simulated: true,
    };
  }

  if (!config.phoneNumberId || !config.accessToken) {
    return { ok: false, error: "WhatsApp integration is not configured", simulated: false };
  }

  const cleaned = toPhoneE164.replace(/^\+/, "");
  const url = `https://graph.facebook.com/${WA_API_VERSION}/${config.phoneNumberId}/messages`;
  const result = await sendWaApiRequest(url, config.accessToken, {
    messaging_product: "whatsapp",
    to: cleaned,
    type: "text",
    text: { body: text },
  });
  if (!result.ok) {
    return { ok: false, error: result.error, simulated: false };
  }
  const externalMessageId = (result.data as Record<string, any>)?.messages?.[0]?.id;
  return { ok: true, externalMessageId, simulated: false };
}

/**
 * Send a WhatsApp template message (used to re-open conversation outside the 24h window).
 */
export async function sendWhatsAppTemplate(opts: {
  config: WhatsAppConfig;
  toPhoneE164: string;
  templateName: string;
  language: string;
  parameters?: string[];
}): Promise<WhatsAppSendResult> {
  const { config, toPhoneE164, templateName, language, parameters } = opts;

  if (!isLiveIntegrationsEnabled()) {
    return {
      ok: true,
      externalMessageId: `${SIMULATED_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      simulated: true,
    };
  }

  if (!config.phoneNumberId || !config.accessToken) {
    return { ok: false, error: "WhatsApp integration is not configured", simulated: false };
  }

  const cleaned = toPhoneE164.replace(/^\+/, "");
  const url = `https://graph.facebook.com/${WA_API_VERSION}/${config.phoneNumberId}/messages`;

  const components = parameters && parameters.length > 0
    ? [{
        type: "body",
        parameters: parameters.map((p) => ({ type: "text", text: p })),
      }]
    : undefined;

  const result = await sendWaApiRequest(url, config.accessToken, {
    messaging_product: "whatsapp",
    to: cleaned,
    type: "template",
    template: {
      name: templateName,
      language: { code: language },
      ...(components ? { components } : {}),
    },
  });
  if (!result.ok) {
    return { ok: false, error: result.error, simulated: false };
  }
  const externalMessageId = (result.data as Record<string, any>)?.messages?.[0]?.id;
  return { ok: true, externalMessageId, simulated: false };
}

export interface WhatsAppInbound {
  externalMessageId: string;
  fromPhone: string;
  displayName?: string;
  text: string;
  receivedAt: Date;
  externalThreadId: string;
  raw: Record<string, unknown>;
}

interface WAContact {
  wa_id?: string;
  profile?: { name?: string };
}

interface WAMessage {
  id: string;
  from: string;
  type: string;
  timestamp?: string;
  text?: { body?: string };
  interactive?: {
    button_reply?: { title?: string };
    list_reply?: { title?: string };
  };
  image?: { caption?: string };
  document?: { caption?: string; filename?: string; mime_type?: string };
  audio?: { caption?: string };
  video?: { caption?: string };
  [k: string]: unknown;
}

/**
 * Parse a WhatsApp Cloud API webhook payload into normalized inbound messages.
 * Returns an empty array for non-message events (status updates, etc.).
 */
export function parseWhatsAppWebhook(payload: unknown): WhatsAppInbound[] {
  const out: WhatsAppInbound[] = [];
  const root = (payload && typeof payload === "object") ? payload as Record<string, unknown> : {};
  const entries = Array.isArray(root.entry) ? root.entry as Array<Record<string, unknown>> : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes as Array<Record<string, unknown>> : [];
    for (const change of changes) {
      const value = (change?.value && typeof change.value === "object") ? change.value as Record<string, unknown> : {};
      const contacts: WAContact[] = Array.isArray(value.contacts) ? value.contacts as WAContact[] : [];
      const messages: WAMessage[] = Array.isArray(value.messages) ? value.messages as WAMessage[] : [];
      for (const msg of messages) {
        const fromPhone = "+" + String(msg.from || "").replace(/^\+/, "");
        const contact = contacts.find((c) => c.wa_id === msg.from) || contacts[0];
        let text = "";
        if (msg.type === "text") text = msg.text?.body || "";
        else if (msg.type === "interactive") {
          text = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "[interactive]";
        } else if (msg.type === "image" || msg.type === "document" || msg.type === "audio" || msg.type === "video") {
          text = msg[msg.type]?.caption || `[${msg.type}]`;
        } else {
          text = `[${msg.type}]`;
        }
        out.push({
          externalMessageId: msg.id,
          fromPhone,
          displayName: contact?.profile?.name,
          text,
          receivedAt: msg.timestamp ? new Date(parseInt(msg.timestamp, 10) * 1000) : new Date(),
          externalThreadId: fromPhone,
          raw: msg,
        });
      }
    }
  }
  return out;
}

/**
 * Returns true if the conversation's last inbound message is within the 24h
 * WhatsApp service window. Outside this window only template messages are allowed.
 */
export function isWithin24hWindow(lastInboundAt: Date | null | undefined): boolean {
  if (!lastInboundAt) return false;
  const ms = Date.now() - new Date(lastInboundAt).getTime();
  return ms < 24 * 60 * 60 * 1000;
}
