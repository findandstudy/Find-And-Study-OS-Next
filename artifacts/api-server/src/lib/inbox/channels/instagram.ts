import { parseMetaMessaging, sendMetaText, type MetaInbound } from "./meta-shared";
import { CHANNEL_INSTAGRAM } from "./constants";

/**
 * Instagram Direct integration config, stored under the `instagram`
 * integration key.
 */
export interface InstagramConfig {
  igBusinessAccountId?: string;
  pageId?: string;
  pageAccessToken?: string;
  appSecret?: string;
  webhookVerifyToken?: string;
}

export interface InstagramSendResult {
  ok: boolean;
  externalMessageId?: string;
  error?: string;
  simulated: boolean;
}

/**
 * Parse an Instagram webhook payload (`object: "instagram"`) into normalized
 * inbound messages. Returns an empty array for non-message events and for
 * comment / mention change events.
 */
export function parseInstagramWebhook(payload: unknown): MetaInbound[] {
  return parseMetaMessaging(payload, CHANNEL_INSTAGRAM);
}

/**
 * Send a text message to an Instagram user via the Meta Graph API `me/messages`
 * endpoint, using the page access token from the integration config. In dev
 * (without ALLOW_LIVE_INTEGRATIONS) returns a simulated success.
 */
export async function sendInstagramText(opts: {
  config: InstagramConfig;
  recipientId: string;
  text: string;
}): Promise<InstagramSendResult> {
  const { config, recipientId, text } = opts;
  return sendMetaText({
    pageAccessToken: config.pageAccessToken,
    recipientId,
    text,
    simulatedPrefix: "sim_ig_",
    notConfiguredError: "Instagram integration is not configured",
    logLabel: "INSTAGRAM",
  });
}
