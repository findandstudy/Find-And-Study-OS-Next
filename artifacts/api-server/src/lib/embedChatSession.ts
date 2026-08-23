import crypto from "node:crypto";

const EMBED_CHAT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export type EmbedChatSession = {
  sessionId: string;
  conversationId: number;
};

const EMBED_HUMAN_HANDOFF_PHRASES = [
  "human advisor",
  "human agent",
  "real person",
  "talk to a person",
  "speak to someone",
  "live support",
  "i don't trust",
  "i do not trust",
  "insan danışman",
  "insan danisman",
  "gerçek biri",
  "gercek biri",
  "bir insanla",
  "canlı destek",
  "canli destek",
  "müşteri temsilcisi",
  "musteri temsilcisi",
  "yetkiliyle görüş",
  "yetkiliyle gorus",
  "güvenmiyorum",
  "guvenmiyorum",
  "conseiller humain",
  "parler à une personne",
  "parler a une personne",
  "je ne vous fais pas confiance",
  "живой человек",
  "поговорить с человеком",
  "не доверяю",
  "موظف بشري",
  "التحدث مع شخص",
  "لا أثق",
] as const;

/**
 * Embedded assistants must never debate a visitor who asks for a person or
 * says they do not trust the assistant. Keep this decision deterministic and
 * independent from model output.
 */
export function requestsEmbedHumanHandoff(text: string): boolean {
  const normalized = text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;
  return EMBED_HUMAN_HANDOFF_PHRASES.some((phrase) => normalized.includes(phrase));
}

export function createEmbedChatSessionToken(
  secret: string,
  slug: string,
  sessionId: string,
  conversationId: number,
  now = Date.now(),
): string {
  const payload = Buffer.from(JSON.stringify({
    kind: "embed_chat",
    slug,
    sid: sessionId,
    cid: conversationId,
    exp: now + EMBED_CHAT_SESSION_TTL_MS,
  })).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`chat:${payload}`)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyEmbedChatSessionToken(
  secret: string,
  token: string | undefined,
  slug: string,
  now = Date.now(),
): EmbedChatSession | null {
  if (!token || typeof token !== "string") return null;
  try {
    const dot = token.indexOf(".");
    if (dot < 1) return null;
    const payload = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    const expected = crypto
      .createHmac("sha256", secret)
      .update(`chat:${payload}`)
      .digest("base64url");
    const signatureBuffer = Buffer.from(signature, "base64url");
    const expectedBuffer = Buffer.from(expected, "base64url");
    if (
      signatureBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
    ) return null;

    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      parsed.kind !== "embed_chat" ||
      parsed.slug !== slug ||
      typeof parsed.exp !== "number" ||
      now > parsed.exp
    ) return null;
    if (typeof parsed.sid !== "string" || !/^[a-f0-9-]{36}$/i.test(parsed.sid)) return null;
    if (!Number.isInteger(parsed.cid) || parsed.cid < 1) return null;
    return { sessionId: parsed.sid, conversationId: parsed.cid };
  } catch {
    return null;
  }
}
