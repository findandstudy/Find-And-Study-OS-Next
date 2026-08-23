import crypto from "crypto";

export interface WebFormSubmission {
  externalMessageId: string;
  fromName?: string;
  email?: string;
  phone?: string;
  text: string;
  agentRef?: string | null;
  externalThreadId: string;
  receivedAt: Date;
  raw: Record<string, unknown>;
}

/**
 * Verify HMAC-SHA256 signature on a web form POST body.
 * Header expected as raw hex: X-Webform-Signature.
 */
export function verifyWebFormSignature(rawBody: Buffer | string, signatureHeader: string | undefined, secret: string | undefined): boolean {
  if (!secret) return true;
  if (!signatureHeader) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

/**
 * Parse a web form payload into a normalized inbound submission.
 * Expected shape (lenient): { name, email, phone, message, agent_ref, form_id, submission_id }
 */
export function parseWebFormPayload(payload: unknown): WebFormSubmission | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const text = String(p.message || p.text || p.body || "").trim();
  // Idempotency: prefer caller-supplied submission_id/id. When absent (most plain
  // HTML form posts), derive a deterministic content hash so retries of the same
  // submission collapse to the same externalMessageId. Includes a coarse 1-hour
  // bucket so legitimate re-submissions later (e.g. user retries the next day)
  // are not silently de-duped.
  const explicitId = p.submission_id || p.id;
  let externalMessageId: string;
  if (explicitId) {
    externalMessageId = String(explicitId);
  } else {
    const hourBucket = Math.floor(Date.now() / (60 * 60 * 1000));
    const hashInput = JSON.stringify({
      formId: p.form_id ?? null,
      email: p.email ?? null,
      phone: p.phone ?? null,
      text,
      bucket: hourBucket,
    });
    externalMessageId = `wf_${crypto.createHash("sha256").update(hashInput).digest("hex").slice(0, 24)}`;
  }
  const externalThreadId = String(
    p.thread_id || p.email || p.phone || externalMessageId,
  );
  const fromName = p.name
    ? String(p.name)
    : [p.firstName, p.lastName].filter(Boolean).join(" ").trim() || undefined;
  return {
    externalMessageId,
    fromName,
    email: p.email ? String(p.email) : undefined,
    phone: p.phone ? String(p.phone) : undefined,
    agentRef: p.agent_ref ? String(p.agent_ref) : null,
    text: text || "(no message body)",
    externalThreadId,
    receivedAt: new Date(),
    raw: p,
  };
}
