import { validatePassportNumber } from "@workspace/portal-adapters/identity-validation";

export const PORTAL_PASSPORT_IDENTITY_EXTRACTION_VERSION = 2;

const normalizedConfidence = (value: unknown): string =>
  String(value ?? "").trim().toLowerCase();

export function hasHighConfidencePassportIdentityExtraction(
  extracted: Record<string, unknown> | null,
  confidenceScore: number,
): boolean {
  if (!extracted) return false;
  const identityConfidence = normalizedConfidence(
    extracted.identityConfidence,
  );
  // New extraction payloads carry identityConfidence specifically for the
  // name + passport-number tuple. Once present it is authoritative: a high
  // document-wide score must never upgrade a medium/low identity reading.
  if (identityConfidence) return identityConfidence === "high";
  // Legacy payloads did not have the identity-specific field. Keep their
  // existing confidence fallback until they are re-read and version-stamped.
  return normalizedConfidence(extracted.confidence) === "high" ||
    confidenceScore >= 0.9;
}

/**
 * Re-read legacy/low-confidence passport extraction at most once with the
 * identity-specific prompt. A version marker prevents every staff click from
 * repeating the same AI request when the source document is genuinely unclear.
 */
export function shouldRefreshPassportIdentityExtraction(
  extracted: Record<string, unknown> | null,
  confidenceScore: number,
): boolean {
  const passportNumber = extracted?.passportNumber ?? extracted?.passportNo;
  if (
    passportNumber != null &&
    String(passportNumber).trim() &&
    validatePassportNumber(String(passportNumber))
  ) {
    const version = Number(
      extracted?.portalPassportIdentityExtractionVersion ?? 0,
    );
    return !Number.isFinite(version) ||
      version < PORTAL_PASSPORT_IDENTITY_EXTRACTION_VERSION;
  }
  if (hasHighConfidencePassportIdentityExtraction(extracted, confidenceScore)) {
    return false;
  }
  // Presence of the identity-specific confidence proves this document has
  // already gone through the dedicated passport prompt. Repeating the same
  // AI read cannot safely promote a genuinely unclear document.
  if (normalizedConfidence(extracted?.identityConfidence)) return false;
  const version = Number(extracted?.portalPassportIdentityExtractionVersion ?? 0);
  return !Number.isFinite(version) ||
    version < PORTAL_PASSPORT_IDENTITY_EXTRACTION_VERSION;
}

export function stampPassportIdentityExtraction(
  extracted: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...extracted,
    portalPassportIdentityExtractionVersion:
      PORTAL_PASSPORT_IDENTITY_EXTRACTION_VERSION,
  };
}
