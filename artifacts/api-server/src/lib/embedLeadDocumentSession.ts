import crypto from "node:crypto";

const EMBED_LEAD_DOCUMENT_TTL_MS = 2 * 60 * 60 * 1000;

export type EmbedLeadDocumentSession = {
  leadId: number;
};

export function createEmbedLeadDocumentSessionToken(
  secret: string,
  slug: string,
  leadId: number,
  now = Date.now(),
): string {
  const payload = Buffer.from(JSON.stringify({
    kind: "embed_lead_documents",
    slug,
    leadId,
    exp: now + EMBED_LEAD_DOCUMENT_TTL_MS,
  })).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`lead-documents:${payload}`)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyEmbedLeadDocumentSessionToken(
  secret: string,
  token: string | undefined,
  slug: string,
  now = Date.now(),
): EmbedLeadDocumentSession | null {
  if (!token || typeof token !== "string") return null;
  try {
    const dot = token.indexOf(".");
    if (dot < 1) return null;
    const payload = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    const expected = crypto
      .createHmac("sha256", secret)
      .update(`lead-documents:${payload}`)
      .digest("base64url");
    const signatureBuffer = Buffer.from(signature, "base64url");
    const expectedBuffer = Buffer.from(expected, "base64url");
    if (
      signatureBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
    ) return null;

    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (parsed.kind !== "embed_lead_documents" || parsed.slug !== slug) return null;
    if (!Number.isInteger(parsed.leadId) || parsed.leadId < 1) return null;
    if (typeof parsed.exp !== "number" || now > parsed.exp) return null;
    return { leadId: parsed.leadId };
  } catch {
    return null;
  }
}
