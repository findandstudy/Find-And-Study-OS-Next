import { parseMetaMessaging, sendMetaText, type MetaInbound } from "./meta-shared";
import { CHANNEL_MESSENGER } from "./constants";

/**
 * Facebook Messenger integration config, stored under the
 * `facebook_messenger` integration key.
 */
export interface MessengerConfig {
  pageId?: string;
  pageAccessToken?: string;
  appSecret?: string;
  webhookVerifyToken?: string;
}

export interface MessengerSendResult {
  ok: boolean;
  externalMessageId?: string;
  error?: string;
  simulated: boolean;
}

/**
 * Parse a Facebook Messenger webhook payload (`object: "page"`) into normalized
 * inbound messages. Returns an empty array for non-message events (delivery /
 * read receipts, postbacks) and for feed/comment change events.
 */
export function parseMessengerWebhook(payload: unknown): MetaInbound[] {
  return parseMetaMessaging(payload, CHANNEL_MESSENGER);
}

/**
 * Send a text message to a Messenger user via the Meta Graph API `me/messages`
 * endpoint, using the page access token from the integration config. In dev
 * (without ALLOW_LIVE_INTEGRATIONS) returns a simulated success.
 */
export async function sendMessengerText(opts: {
  config: MessengerConfig;
  recipientId: string;
  text: string;
}): Promise<MessengerSendResult> {
  const { config, recipientId, text } = opts;
  return sendMetaText({
    pageAccessToken: config.pageAccessToken,
    recipientId,
    text,
    simulatedPrefix: "sim_msgr_",
    notConfiguredError: "Messenger integration is not configured",
    logLabel: "MESSENGER",
  });
}
