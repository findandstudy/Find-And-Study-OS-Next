export type DormBookingOutputRule =
  | "length"
  | "question_count"
  | "praise_opener"
  | "language_mixing"
  | "catalog_name"
  | "currency_assumption"
  | "bare_attachment";

export interface DormBookingOutputValidation {
  ok: boolean;
  ruleIds: DormBookingOutputRule[];
}

const PRAISE_OPENER = /^(?:perfect|great|excellent|wonderful|thank you|sounds great|that's great|you're right|harika|mükemmel|süper)\b/i;
const ENGLISH_FUNCTION_WORDS = /\b(?:i|you|your|we|the|and|with|for|can|will|would|please|room|price)\b/i;
const TURKISH_SIGNAL = /[ışğİŞĞ]|\b(?:merhaba|selam|teşekkür|yardımcı|fiyat|oda|yurt|rezervasyon)\b/i;
const CURRENCY_FIGURE = /(?:[$€£]|\b(?:USD|EUR|GBP|TRY|TL)\b)\s*([\d,.]+)|([\d,.]+)\s*(?:[$€£]|\b(?:USD|EUR|GBP|TRY|TL)\b)/gi;

export function validateDormBookingOutput(input: {
  text: string;
  firstReply: boolean;
  latestInbound?: string;
  knownDormNames?: string[];
  mediaCount?: number;
}): DormBookingOutputValidation {
  const text = input.text.trim();
  const rules = new Set<DormBookingOutputRule>();
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 8 || (input.firstReply && lines.length > 4)) rules.add("length");
  const questions = (text.match(/\?/g) ?? []).length;
  if (questions > (input.firstReply ? 3 : 2)) rules.add("question_count");
  if (PRAISE_OPENER.test(text)) rules.add("praise_opener");
  if (TURKISH_SIGNAL.test(text) && ENGLISH_FUNCTION_WORDS.test(text)) rules.add("language_mixing");
  if ((input.mediaCount ?? 0) > 0 && !text) rules.add("bare_attachment");

  const knownDormNames = (input.knownDormNames ?? []).filter(Boolean);
  if (knownDormNames.length) {
    const dormishLines = lines.filter((line) => /\b(?:dormitory|dorm|residence|yurt|apart)\b/i.test(line));
    for (const line of dormishLines) {
      const mentionsKnown = knownDormNames.some((name) => line.includes(name));
      const genericProcessLine = /\b(?:dormitory|dorm|residence|yurt)\b/i.test(line)
        && /\b(?:options?|availability|catalog|listings?|preferences?|team)\b/i.test(line);
      if (!mentionsKnown && !genericProcessLine) rules.add("catalog_name");
    }
  }

  const inbound = input.latestInbound ?? "";
  for (const match of text.matchAll(CURRENCY_FIGURE)) {
    const number = (match[1] || match[2] || "").replace(/[,.]+$/, "").replace(/,/g, "");
    if (!number) continue;
    const inboundHasNumber = inbound.replace(/,/g, "").includes(number);
    const inboundHasCurrency = new RegExp(`(?:[$€£]|USD|EUR|GBP|TRY|TL)\\s*${number}|${number}\\s*(?:[$€£]|USD|EUR|GBP|TRY|TL)`, "i").test(inbound.replace(/,/g, ""));
    if (inboundHasNumber && !inboundHasCurrency) rules.add("currency_assumption");
  }
  return { ok: rules.size === 0, ruleIds: [...rules] };
}
