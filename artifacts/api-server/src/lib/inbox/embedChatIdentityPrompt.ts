type EmbedChatContact = {
  displayName?: string | null;
  email?: string | null;
  phone?: string | null;
  phoneE164?: string | null;
};

function safePromptValue(value: string, maxLength: number): string {
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, maxLength);
}

/**
 * Gives the embedded assistant the identity already collected by the signed
 * pre-chat form. The contact is server-owned CRM context, not visitor-authored
 * prompt text, so the assistant must not ask for the same fields again.
 */
export function buildKnownEmbedContactInstruction(
  contact: EmbedChatContact | null | undefined,
): string {
  if (!contact) return "";

  const fullName = safePromptValue(contact.displayName || "", 160);
  const email = safePromptValue(contact.email || "", 320).toLowerCase();
  const phone = safePromptValue(contact.phoneE164 || contact.phone || "", 50);
  const knownFields = [
    fullName ? `- Full name: ${JSON.stringify(fullName)}` : "",
    email ? `- Email: ${JSON.stringify(email)}` : "",
    phone ? `- Phone: ${JSON.stringify(phone)}` : "",
  ].filter(Boolean);

  if (knownFields.length === 0) return "";

  return [
    "## Verified pre-chat visitor details (authoritative CRM context)",
    ...knownFields,
    "- These details were collected by the signed pre-chat form and are already saved or matched in CRM.",
    "- Treat every listed field as known. Never ask the visitor to provide, repeat or confirm it.",
    "- Ask only for application information that is still missing and relevant to the next step.",
    "- If the visitor explicitly says a listed value is wrong, acknowledge it and offer human correction; never claim it was updated unless the system confirms the update.",
  ].join("\n");
}
