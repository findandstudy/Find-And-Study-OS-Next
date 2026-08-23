import {
  validateApplicationDocumentFile as _validateApplicationDocumentFile,
  validateStudentDocumentFile,
  validateUploadedFile as _validateUploadedFile,
} from "@workspace/file-upload-validation";

export {
  ALLOWED_MIME_TYPES,
  ALLOWED_EXTENSIONS,
  ACCEPT_ATTRIBUTE,
  PDF_MAX_SIZE,
  IMAGE_MAX_SIZE,
  PDF_MAX_SIZE_MB,
  IMAGE_MAX_SIZE_MB,
  FILE_UPLOAD_HELP_TEXT,
  APPLICATION_DOCUMENT_MAX_SIZE,
  APPLICATION_DOCUMENT_MAX_SIZE_MB,
  APPLICATION_DOCUMENT_ACCEPT_ATTRIBUTE,
  APPLICATION_DOCUMENT_HELP_TEXT,
  getExtension,
  isAllowedMimeType,
  isAllowedExtension,
  isPdf,
  isImage,
  getMaxSizeForType,
  getMaxSizeLabelForType,
  sanitizeFileName,
  validateUploadedFile,
  validateApplicationDocumentFile,
  validateStudentDocumentFile,
  validateFile,
} from "@workspace/file-upload-validation";

export type {
  FileValidationError,
  FileValidationResult,
} from "@workspace/file-upload-validation";

export function validateFileObj(file: File): { valid: true } | { valid: false; message: string } {
  const error = _validateUploadedFile(file.name, file.type, file.size);
  if (error) return { valid: false, message: error.message };
  return { valid: true };
}

export function validateApplicationDocumentFileObj(file: File): { valid: true } | { valid: false; message: string } {
  const error = _validateApplicationDocumentFile(file.name, file.type, file.size);
  if (error) return { valid: false, message: error.message };
  return { valid: true };
}

export function validateStudentDocumentFileObj(documentType: string, file: File): { valid: true } | { valid: false; message: string } {
  const error = validateStudentDocumentFile(documentType, file.name, file.type, file.size);
  if (error) return { valid: false, message: error.message };
  return { valid: true };
}
