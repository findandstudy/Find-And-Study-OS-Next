export const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
] as const;

export const ALLOWED_EXTENSIONS = [
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
] as const;

export const ACCEPT_ATTRIBUTE = ".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx,.ppt,.pptx";

// Pre-flight size gate on `/storage/uploads/request-url`. Raw scans (student
// passports/diplomas) commonly land in the 3-8MB range; these limits admit
// them so `processUpload()` (server-side, on registration) can compress down
// to the ≤2MB portal-ready target instead of rejecting them outright. Only
// genuinely oversized files should hit the hard cap.
export const PDF_MAX_SIZE = 15 * 1024 * 1024;
export const IMAGE_MAX_SIZE = 15 * 1024 * 1024;
export const OFFICE_MAX_SIZE = 20 * 1024 * 1024;

export const PDF_MAX_SIZE_MB = 15;
export const IMAGE_MAX_SIZE_MB = 15;
export const OFFICE_MAX_SIZE_MB = 20;

export const FILE_UPLOAD_HELP_TEXT =
  "PDF (maks. 15 MB), JPG/PNG (maks. 15 MB), Word/Excel/PowerPoint (maks. 20 MB)";

// Public/application intake is intentionally stricter than the general staff
// document pipeline. Keep this value shared by widget, web and API guards so
// the limit shown to applicants is the limit the server actually enforces.
export const APPLICATION_DOCUMENT_MAX_SIZE = 5 * 1024 * 1024;
export const APPLICATION_DOCUMENT_MAX_SIZE_MB = 5;
export const APPLICATION_DOCUMENT_ACCEPT_ATTRIBUTE = ".pdf,.jpg,.jpeg,.png";
export const APPLICATION_DOCUMENT_HELP_TEXT = "PDF, JPG, JPEG or PNG \u2022 Max 5 MB per file";

const APPLICATION_DOCUMENT_MIME_TYPES = new Set<string>([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);

const APPLICATION_DOCUMENT_EXTENSIONS = new Set<string>([
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
]);

const OFFICE_MIME_TYPES = new Set<string>([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const LEGACY_OFFICE_MIME_TYPES = new Set<string>([
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
]);

const OFFICE_EXTENSIONS = new Set<string>([".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"]);

const UNSUPPORTED_FILE_TYPE_MESSAGE =
  "Sadece PDF, JPG, JPEG, PNG, Word, Excel ve PowerPoint dosyalar\u0131 y\u00fckleyebilirsiniz.";

export function getExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot < 0) return "";
  return fileName.slice(lastDot).toLowerCase();
}

export function isAllowedMimeType(mimeType: string): boolean {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType);
}

export function isAllowedExtension(fileName: string): boolean {
  const ext = getExtension(fileName);
  return (ALLOWED_EXTENSIONS as readonly string[]).includes(ext);
}

export function isPdf(mimeType: string): boolean {
  return mimeType === "application/pdf";
}

export function isImage(mimeType: string): boolean {
  return mimeType === "image/jpeg" || mimeType === "image/png";
}

export function isOffice(mimeType: string): boolean {
  return OFFICE_MIME_TYPES.has(mimeType);
}

export function getMaxSizeForType(mimeType: string): number {
  if (isPdf(mimeType)) return PDF_MAX_SIZE;
  if (isOffice(mimeType)) return OFFICE_MAX_SIZE;
  return IMAGE_MAX_SIZE;
}

export function getMaxSizeLabelForType(mimeType: string): string {
  if (isPdf(mimeType)) return `${PDF_MAX_SIZE_MB} MB`;
  if (isOffice(mimeType)) return `${OFFICE_MAX_SIZE_MB} MB`;
  return `${IMAGE_MAX_SIZE_MB} MB`;
}

export function sanitizeFileName(fileName: string): string {
  let name = fileName.normalize("NFC");

  name = name.replace(/\.\./g, "");
  name = name.replace(/[/\\]/g, "");

  const lastDot = name.lastIndexOf(".");
  let base = lastDot > 0 ? name.slice(0, lastDot) : name;
  const ext = lastDot > 0 ? name.slice(lastDot) : "";

  base = base.replace(/[^a-zA-Z0-9._\-\s\u00C0-\u024F\u0400-\u04FF\u0600-\u06FF\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/g, "_");
  base = base.replace(/_+/g, "_").replace(/^_|_$/g, "");

  if (!base) base = "document";

  if (base.length > 200) base = base.slice(0, 200);

  return base + ext.toLowerCase();
}

export type FileValidationError = {
  type: "invalid_type" | "invalid_extension" | "size_exceeded" | "mime_extension_mismatch" | "empty_file" | "document_type_mismatch";
  message: string;
};

export function validateUploadedFile(
  fileName: string,
  mimeType: string,
  sizeBytes: number
): FileValidationError | null {
  if (!isAllowedMimeType(mimeType)) {
    return {
      type: "invalid_type",
      message: UNSUPPORTED_FILE_TYPE_MESSAGE,
    };
  }

  if (!isAllowedExtension(fileName)) {
    return {
      type: "invalid_extension",
      message: UNSUPPORTED_FILE_TYPE_MESSAGE,
    };
  }

  const ext = getExtension(fileName);
  if (isPdf(mimeType) && ext !== ".pdf") {
    return {
      type: "mime_extension_mismatch",
      message: "Dosya tipi ile uzant\u0131s\u0131 uyu\u015fmuyor.",
    };
  }
  if (isImage(mimeType) && ![".jpg", ".jpeg", ".png"].includes(ext)) {
    return {
      type: "mime_extension_mismatch",
      message: "Dosya tipi ile uzant\u0131s\u0131 uyu\u015fmuyor.",
    };
  }
  if (isOffice(mimeType) && !OFFICE_EXTENSIONS.has(ext)) {
    return {
      type: "mime_extension_mismatch",
      message: "Dosya tipi ile uzant\u0131s\u0131 uyu\u015fmuyor.",
    };
  }

  const maxSize = getMaxSizeForType(mimeType);
  if (sizeBytes > maxSize) {
    if (isPdf(mimeType)) {
      return {
        type: "size_exceeded",
        message: `PDF dosyalar\u0131 en fazla ${PDF_MAX_SIZE_MB} MB olabilir.`,
      };
    }
    if (isOffice(mimeType)) {
      return {
        type: "size_exceeded",
        message: `Word, Excel ve PowerPoint dosyalar\u0131 en fazla ${OFFICE_MAX_SIZE_MB} MB olabilir.`,
      };
    }
    return {
      type: "size_exceeded",
      message: `JPG, JPEG ve PNG dosyalar\u0131 en fazla ${IMAGE_MAX_SIZE_MB} MB olabilir.`,
    };
  }

  return null;
}

export function validateApplicationDocumentFile(
  fileName: string,
  mimeType: string,
  sizeBytes: number,
): FileValidationError | null {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return {
      type: "empty_file",
      message: "Bo\u015f dosya y\u00fcklenemez.",
    };
  }
  const ext = getExtension(fileName);
  if (!APPLICATION_DOCUMENT_MIME_TYPES.has(mimeType) || !APPLICATION_DOCUMENT_EXTENSIONS.has(ext)) {
    return {
      type: "invalid_type",
      message: "Sadece PDF, JPG, JPEG ve PNG dosyalar\u0131 y\u00fckleyebilirsiniz.",
    };
  }
  if (
    (mimeType === "application/pdf" && ext !== ".pdf") ||
    (mimeType === "image/jpeg" && ![".jpg", ".jpeg"].includes(ext)) ||
    (mimeType === "image/png" && ext !== ".png")
  ) {
    return {
      type: "mime_extension_mismatch",
      message: "Dosya tipi ile uzant\u0131s\u0131 uyu\u015fmuyor.",
    };
  }
  if (sizeBytes > APPLICATION_DOCUMENT_MAX_SIZE) {
    return {
      type: "size_exceeded",
      message: `Dosya boyutu en fazla ${APPLICATION_DOCUMENT_MAX_SIZE_MB} MB olabilir.`,
    };
  }
  return null;
}

/**
 * Canonical student/lead/application document policy. All intake documents are
 * capped at 5 MB and limited to PDF/JPG/JPEG/PNG. Photograph slots accept the
 * same safe formats; they remain single-file slots at the UI layer.
 */
export function validateStudentDocumentFile(
  documentType: string,
  fileName: string,
  mimeType: string,
  sizeBytes: number,
): FileValidationError | null {
  const baseError = validateApplicationDocumentFile(fileName, mimeType, sizeBytes);
  if (baseError) return baseError;

  return null;
}

export type FileValidationResult = {
  valid: false;
  message: string;
} | {
  valid: true;
};

export type BufferValidationError = FileValidationError | {
  type: "magic_byte_mismatch" | "magic_byte_unknown";
  message: string;
};

/**
 * Expose the canonical magic-byte detector to upload surfaces that support
 * safe media types beyond the student-document policy (for example web-chat
 * audio/video). Keeping the dependency here avoids each API route inventing a
 * second content-sniffing implementation.
 */
export async function detectUploadedFileType(
  buffer: Buffer | Uint8Array,
): Promise<{ ext: string; mime: string } | undefined> {
  const { fileTypeFromBuffer } = await import("file-type");
  return fileTypeFromBuffer(buffer);
}

export async function validateUploadedFileBuffer(
  fileName: string,
  declaredMimeType: string,
  buffer: Buffer | Uint8Array,
): Promise<BufferValidationError | null> {
  const baseError = validateUploadedFile(fileName, declaredMimeType, buffer.byteLength);
  if (baseError) return baseError;

  const detected = await detectUploadedFileType(buffer);

  // Legacy Office formats (.doc/.xls/.ppt) all share the same OLE/CFB
  // container signature, so magic-byte sniffing can't tell them apart from
  // each other — file-type just reports the generic "application/x-cfb".
  // Trust the declared type + extension pairing (already validated above) in
  // that case instead of forcing an exact mime match.
  if (!detected) {
    if (LEGACY_OFFICE_MIME_TYPES.has(declaredMimeType)) return null;
    return {
      type: "magic_byte_unknown",
      message: "Dosya i\u00e7eri\u011fi tan\u0131namad\u0131. L\u00fctfen ge\u00e7erli bir dosya y\u00fckleyin.",
    };
  }

  if (LEGACY_OFFICE_MIME_TYPES.has(declaredMimeType)) {
    if (detected.mime === "application/x-cfb" || detected.mime === declaredMimeType) return null;
    return {
      type: "magic_byte_mismatch",
      message: `Dosya i\u00e7eri\u011fi belirtilen tip ile uyu\u015fmuyor (belirtilen: ${declaredMimeType}, alg\u0131lanan: ${detected.mime}).`,
    };
  }

  // Modern OOXML formats (.docx/.xlsx/.pptx) are zip containers; file-type
  // usually resolves the specific OOXML mime, but a minimal/edge-case zip can
  // fall back to the generic "application/zip" — accept both.
  if (OFFICE_MIME_TYPES.has(declaredMimeType) && declaredMimeType !== "application/msword") {
    if (detected.mime === declaredMimeType || detected.mime === "application/zip") return null;
    return {
      type: "magic_byte_mismatch",
      message: `Dosya i\u00e7eri\u011fi belirtilen tip ile uyu\u015fmuyor (belirtilen: ${declaredMimeType}, alg\u0131lanan: ${detected.mime}).`,
    };
  }

  const allowedDetectedMimes = new Set<string>(["application/pdf", "image/jpeg", "image/png"]);
  if (!allowedDetectedMimes.has(detected.mime)) {
    return {
      type: "magic_byte_mismatch",
      message: `Dosya i\u00e7eri\u011fi izin verilen bir t\u00fcr de\u011fil (alg\u0131lanan: ${detected.mime}).`,
    };
  }

  if (detected.mime !== declaredMimeType) {
    return {
      type: "magic_byte_mismatch",
      message: `Dosya i\u00e7eri\u011fi belirtilen tip ile uyu\u015fmuyor (belirtilen: ${declaredMimeType}, alg\u0131lanan: ${detected.mime}).`,
    };
  }

  return null;
}

export function validateFile(fileName: string, mimeType: string, sizeBytes: number): FileValidationResult {
  if (!isAllowedMimeType(mimeType) || !isAllowedExtension(fileName)) {
    return {
      valid: false,
      message: UNSUPPORTED_FILE_TYPE_MESSAGE,
    };
  }

  const maxSize = getMaxSizeForType(mimeType);
  if (sizeBytes > maxSize) {
    if (isPdf(mimeType)) {
      return {
        valid: false,
        message: `PDF dosyalar\u0131 en fazla ${PDF_MAX_SIZE_MB} MB olabilir.`,
      };
    }
    if (isOffice(mimeType)) {
      return {
        valid: false,
        message: `Word, Excel ve PowerPoint dosyalar\u0131 en fazla ${OFFICE_MAX_SIZE_MB} MB olabilir.`,
      };
    }
    return {
      valid: false,
      message: `JPG, JPEG ve PNG dosyalar\u0131 en fazla ${IMAGE_MAX_SIZE_MB} MB olabilir.`,
    };
  }

  return { valid: true };
}
