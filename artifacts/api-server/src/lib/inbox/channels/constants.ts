/**
 * Single source of truth for inbox channel names. The `channel` column is a
 * free text field, so these constants keep the literals consistent across
 * webhook handlers, the dispatch pipeline, and later Meta omnichannel phases.
 */
export const CHANNEL_WHATSAPP = "whatsapp";
export const CHANNEL_WEB_FORM = "web_form";
export const CHANNEL_MESSENGER = "messenger";
export const CHANNEL_INSTAGRAM = "instagram";
export const CHANNEL_EMAIL = "email";
export const CHANNEL_SMS = "sms";
export const CHANNEL_TELEGRAM = "telegram";

export const CHANNELS = {
  whatsapp: CHANNEL_WHATSAPP,
  webForm: CHANNEL_WEB_FORM,
  messenger: CHANNEL_MESSENGER,
  instagram: CHANNEL_INSTAGRAM,
  email: CHANNEL_EMAIL,
  sms: CHANNEL_SMS,
  telegram: CHANNEL_TELEGRAM,
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
