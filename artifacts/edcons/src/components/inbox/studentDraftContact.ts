type ContactSource = {
  email?: unknown;
  phone?: unknown;
} | null | undefined;

type InboxContactDetail = {
  student?: ContactSource;
  lead?: ContactSource;
  externalContact?: ContactSource;
} | null | undefined;

type ExtractedContact = {
  email?: unknown;
  phone?: unknown;
} | null | undefined;

function firstNonBlank(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (normalized) return normalized;
  }
  return "";
}

/**
 * Preserve contact data already verified in the CRM when an AI-generated
 * student draft is assembled. Document extraction is only a last-resort
 * fallback and must not erase or replace the linked student/lead data.
 */
export function resolveInboxStudentContactPrefill(
  detail: InboxContactDetail,
  extracted?: ExtractedContact,
) {
  return {
    email: firstNonBlank(
      detail?.student?.email,
      detail?.lead?.email,
      detail?.externalContact?.email,
      extracted?.email,
    ),
    phone: firstNonBlank(
      detail?.student?.phone,
      detail?.lead?.phone,
      detail?.externalContact?.phone,
      extracted?.phone,
    ),
  };
}
