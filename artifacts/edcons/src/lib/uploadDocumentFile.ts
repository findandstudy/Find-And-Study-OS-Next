import { apiFetch } from "./apiFetch";
import { validateApplicationDocumentFileObj } from "./fileUploadValidation";

const BASE_URL = import.meta.env?.BASE_URL?.replace(/\/$/, "") || "";

interface UploadResult {
  fileKey: string;
  mimeType: string;
  sizeBytes: number;
}

export interface CreateDocumentRecordInput {
  name: string;
  type: string;
  status?: string;
  studentId?: number | null;
  applicationId?: number;
  respondingToNoteId?: number;
  fileKey: string;
  mimeType: string;
  sizeBytes: number;
  originalFileName?: string | null;
}

export interface CreatedDocumentRecord {
  id: number;
  fileKey?: string | null;
  [key: string]: unknown;
}

/**
 * Uploads a file to object storage via the presigned-URL flow used by the
 * `documents` table. Returns the canonical `fileKey` to send to
 * POST /api/documents (no more base64 in the request body).
 */
export async function uploadDocumentFile(file: File): Promise<UploadResult> {
  const validation = validateApplicationDocumentFileObj(file);
  if (!validation.valid) throw new Error(validation.message);

  const reqRes = await apiFetch(`${BASE_URL}/api/storage/uploads/request-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prefix: "student-documents",
      name: file.name,
      size: file.size,
      contentType: file.type,
    }),
  });
  if (!reqRes.ok) {
    const txt = await reqRes.text().catch(() => "");
    throw new Error(txt || "Failed to get upload URL");
  }
  const { uploadURL, objectPath } = await reqRes.json() as { uploadURL: string; objectPath: string };
  if (!uploadURL || !objectPath) throw new Error("Invalid upload URL response");

  const putRes = await fetch(uploadURL, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": file.type },
  });
  if (!putRes.ok) {
    throw new Error(`Upload to storage failed (${putRes.status})`);
  }

  return { fileKey: objectPath, mimeType: file.type, sizeBytes: file.size };
}

/**
 * Registers an uploaded object as a document. The trailing slash avoids the
 * production proxy's collection-route redirect; redirects are rejected so an
 * unsafe POST can never be converted into a successful GET response.
 */
export async function createDocumentRecord(
  input: CreateDocumentRecordInput,
): Promise<CreatedDocumentRecord> {
  const response = await apiFetch(`${BASE_URL}/api/documents/`, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (response.status !== 201) {
    const errorBody = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(errorBody?.error || `Document registration failed (${response.status})`);
  }

  const documentRecord = await response.json().catch(() => null) as CreatedDocumentRecord | null;
  if (!documentRecord || !Number.isInteger(documentRecord.id) || documentRecord.id <= 0) {
    throw new Error("Document registration returned an invalid response");
  }
  if (documentRecord.fileKey !== input.fileKey) {
    throw new Error("Document registration did not confirm the uploaded file");
  }

  return documentRecord;
}
