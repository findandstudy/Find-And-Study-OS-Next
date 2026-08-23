export type PreviewKind = "image" | "pdf" | "other";

export function getPreviewKind(mimeType: string | undefined | null): PreviewKind {
  if (!mimeType) return "other";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf") return "pdf";
  return "other";
}

export interface PreviewTarget {
  /** URL used both for the in-app preview and (as the anchor href) for opening in a new tab. */
  href: string;
  kind: PreviewKind;
  name?: string;
  /** Optional separate URL used by the in-modal download button. Defaults to href. */
  downloadHref?: string;
  /** Revoke the href (a blob: URL) when the modal closes. */
  revokeOnClose?: boolean;
}
