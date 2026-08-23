type Translate = (key: string) => string;

function humaniseDocumentType(documentType: string): string {
  return documentType
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * Inbox document pickers and checklists use the canonical program-document
 * catalog. Its translations live under `programDocTypes`; `docTypes` is kept
 * only as a legacy fallback for older keys such as diploma/transcript.
 */
export function inboxDocumentLabel(
  t: Translate,
  documentType: string,
  backendFallback?: string | null,
): string {
  const normalized = documentType.trim().toLowerCase();
  for (const namespace of ["programDocTypes", "docTypes"]) {
    const key = `${namespace}.${normalized}`;
    const translated = t(key);
    if (translated && translated !== key) return translated;
  }
  return backendFallback?.trim() || humaniseDocumentType(documentType);
}
