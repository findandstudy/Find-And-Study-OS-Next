const INBOX_STORAGE_PATH = /^\/api\/storage\/(?:public-objects|objects)\//;
const JPEG_TRANSPORT_EXTENSION = /\.(?:jfif|jfi|jif)$/i;

export type InboxAttachmentPreviewKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "file";

export function getInboxAttachmentPreviewKind(input: {
  type?: string | null;
  mimeType?: string | null;
  name?: string | null;
}): InboxAttachmentPreviewKind {
  const type = String(input.type ?? "").trim().toLowerCase();
  const mimeType = String(input.mimeType ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const extension = String(input.name ?? "")
    .trim()
    .toLowerCase()
    .split(".")
    .pop();

  if (type === "image" || mimeType.startsWith("image/")) return "image";
  if (type === "video" || mimeType.startsWith("video/")) return "video";
  if (type === "audio" || mimeType.startsWith("audio/")) return "audio";
  if (mimeType === "application/pdf" || extension === "pdf") return "pdf";
  if (["jpg", "jpeg", "jfif", "jfi", "jif", "png", "gif", "webp"].includes(extension ?? "")) return "image";
  if (["mp4", "3gp", "3gpp", "mov"].includes(extension ?? "")) return "video";
  if (["mp3", "ogg", "opus", "webm", "wav", "m4a", "aac", "amr"].includes(extension ?? "")) return "audio";
  return "file";
}

export function normalizeInboxDownloadFilename(name: string): string {
  return String(name || "attachment").replace(JPEG_TRANSPORT_EXTENSION, ".jpg");
}

/**
 * Route protected inbox media through the current API origin. Historical
 * messages may contain an absolute production URL, which cannot be fetched by
 * pdfjs from a local or later deployment origin because of browser CORS rules.
 * The API remains the authority that validates the source host and storage key.
 */
export function shouldProxyInboxAttachment(rawUrl: string): boolean {
  const value = String(rawUrl ?? "").trim();
  if (!value) return false;

  try {
    const parsed = new URL(value, "https://local.invalid");
    if (parsed.protocol === "https:" && parsed.hostname === "zernio.com") {
      return true;
    }
    return INBOX_STORAGE_PATH.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function inboxAttachmentMediaUrl(
  rawUrl: string,
  messageId: number,
  attachmentIndex: number,
): string {
  return shouldProxyInboxAttachment(rawUrl)
    ? `/api/inbox/media/${messageId}/${attachmentIndex}`
    : rawUrl;
}
