import nodePath from "node:path";
import { detectUploadedFileType } from "@workspace/file-upload-validation";

export const WEB_CHAT_MEDIA_MAX_BYTES = 5 * 1024 * 1024;

export type WebChatMediaKind = "image" | "video" | "audio" | "file";

type MediaRule = {
  extensions: ReadonlySet<string>;
  detectedMimes: ReadonlySet<string>;
  kind: WebChatMediaKind;
};

const rules: Readonly<Record<string, MediaRule>> = {
  "image/jpeg": rule(["jpg", "jpeg"], ["image/jpeg"], "image"),
  "image/png": rule(["png"], ["image/png"], "image"),
  "image/webp": rule(["webp"], ["image/webp"], "image"),
  "application/pdf": rule(["pdf"], ["application/pdf"], "file"),
  "application/msword": rule(["doc"], ["application/msword", "application/x-cfb"], "file"),
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": rule(
    ["docx"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/zip"],
    "file",
  ),
  "application/vnd.ms-excel": rule(["xls"], ["application/vnd.ms-excel", "application/x-cfb"], "file"),
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": rule(
    ["xlsx"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/zip"],
    "file",
  ),
  "application/vnd.ms-powerpoint": rule(["ppt"], ["application/vnd.ms-powerpoint", "application/x-cfb"], "file"),
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": rule(
    ["pptx"],
    ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/zip"],
    "file",
  ),
  "audio/mpeg": rule(["mp3"], ["audio/mpeg"], "audio"),
  "audio/ogg": rule(["ogg", "opus"], ["audio/ogg", "application/ogg"], "audio"),
  // file-type reports the WebM container as video/webm even when the browser
  // recorded an audio-only Opus stream. The declared MIME and extension still
  // determine how the attachment is rendered.
  "audio/webm": rule(["webm"], ["audio/webm", "video/webm"], "audio"),
  "audio/mp4": rule(["m4a", "mp4"], ["audio/mp4", "video/mp4"], "audio"),
  "audio/wav": rule(["wav"], ["audio/wav", "audio/x-wav"], "audio"),
  "audio/aac": rule(["aac"], ["audio/aac"], "audio"),
  "video/mp4": rule(["mp4"], ["video/mp4"], "video"),
  "video/webm": rule(["webm"], ["video/webm"], "video"),
  "video/quicktime": rule(["mov"], ["video/quicktime"], "video"),
  "video/3gpp": rule(["3gp", "3gpp"], ["video/3gpp"], "video"),
};

function rule(
  extensions: string[],
  detectedMimes: string[],
  kind: WebChatMediaKind,
): MediaRule {
  return {
    extensions: new Set(extensions),
    detectedMimes: new Set(detectedMimes),
    kind,
  };
}

export type ValidatedWebChatMedia = {
  filename: string;
  mimeType: string;
  kind: WebChatMediaKind;
  size: number;
};

export class WebChatMediaValidationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 413 = 400,
  ) {
    super(message);
    this.name = "WebChatMediaValidationError";
  }
}

function normalizeMime(value: string): string {
  return value.split(";", 1)[0].trim().toLowerCase();
}

export function sanitizeWebChatFilename(value: string): string {
  const basename = nodePath.basename(String(value || "attachment"));
  const withoutControls = basename.replace(/[\u0000-\u001f\u007f]/g, "");
  const safe = withoutControls.replace(/[^A-Za-z0-9._ -]/g, "_").trim();
  return (safe || "attachment").slice(0, 180);
}

export function webChatMediaAcceptAttribute(): string {
  const extensions = new Set<string>();
  Object.values(rules).forEach((selectedRule) => {
    selectedRule.extensions.forEach((extension) => extensions.add(`.${extension}`));
  });
  return [...Object.keys(rules), ...extensions].join(",");
}

export async function validateWebChatMedia(
  buffer: Buffer,
  originalFilename: string,
  declaredMime: string,
): Promise<ValidatedWebChatMedia> {
  if (!Buffer.isBuffer(buffer) || buffer.length <= 0) {
    throw new WebChatMediaValidationError("The selected file is empty.");
  }
  if (buffer.length > WEB_CHAT_MEDIA_MAX_BYTES) {
    throw new WebChatMediaValidationError("The maximum file size is 5 MB.", 413);
  }

  const filename = sanitizeWebChatFilename(originalFilename);
  const mimeType = normalizeMime(declaredMime);
  const selectedRule = rules[mimeType];
  const extension = nodePath.extname(filename).slice(1).toLowerCase();
  if (!selectedRule || !extension || !selectedRule.extensions.has(extension)) {
    throw new WebChatMediaValidationError("The file type or filename extension is not supported.");
  }

  const detected = await detectUploadedFileType(buffer);
  if (!detected || !selectedRule.detectedMimes.has(detected.mime)) {
    throw new WebChatMediaValidationError("The file contents do not match the selected file type.");
  }

  return {
    filename,
    mimeType,
    kind: selectedRule.kind,
    size: buffer.length,
  };
}

export type WebChatAttachment = {
  url: string;
  type: WebChatMediaKind;
  name: string;
  mimeType: string;
  fileType: string;
  fileSize: number;
  voiceNote?: boolean;
};

export function readWebChatAttachments(metadata: unknown): WebChatAttachment[] {
  if (!metadata || typeof metadata !== "object") return [];
  const row = metadata as { attachment?: unknown; attachments?: unknown };
  const candidates = [
    ...(row.attachment ? [row.attachment] : []),
    ...(Array.isArray(row.attachments) ? row.attachments : []),
  ];
  return candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const value = candidate as Partial<WebChatAttachment>;
    if (
      typeof value.url !== "string" ||
      typeof value.name !== "string" ||
      typeof value.mimeType !== "string" ||
      typeof value.fileSize !== "number" ||
      !["image", "video", "audio", "file"].includes(String(value.type))
    ) return [];
    return [{
      url: value.url,
      type: value.type as WebChatMediaKind,
      name: sanitizeWebChatFilename(value.name),
      mimeType: normalizeMime(value.mimeType),
      fileType: normalizeMime(value.fileType || value.mimeType),
      fileSize: value.fileSize,
      ...(value.voiceNote === true ? { voiceNote: true } : {}),
    }];
  });
}

export function webChatObjectPath(rawUrl: string, conversationId: number): string | null {
  let pathname: string;
  try {
    pathname = new URL(rawUrl, "https://local.invalid").pathname;
  } catch {
    return null;
  }
  const prefix = "/api/storage/objects/";
  if (!pathname.startsWith(prefix)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return null;
  }
  const expectedPrefix = `inbox/web-chat/${conversationId}/`;
  if (
    !decoded.startsWith(expectedPrefix) ||
    decoded.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"))
  ) return null;
  return `/objects/${decoded}`;
}
