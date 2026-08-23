import type { Response } from "express";
import { Readable } from "stream";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage";
import { processUpload, UploadTooLargeError, type ProcessUploadMeta } from "./uploads/processUpload";

export interface DocBytesSource {
  fileKey?: string | null;
  fileData?: string | null;
  mimeType?: string | null;
}

const objectStorageService = new ObjectStorageService();

function normalizeFileKey(fileKey: string): string {
  if (fileKey.startsWith("/objects/")) return fileKey;
  if (fileKey.startsWith("objects/")) return `/${fileKey}`;
  if (fileKey.startsWith("/")) return `/objects${fileKey}`;
  return `/objects/${fileKey}`;
}

export interface RecompressResult {
  recompressed: boolean;
  sizeBytes: number;
  mimeType: string;
  meta?: ProcessUploadMeta;
}

/**
 * System-wide document size policy chokepoint for objects already written to
 * storage via a client-side signed PUT URL (GCS driver) — the server never
 * saw the bytes at upload time, so registration (POST /api/documents,
 * staff-card uploads, stage-documents) is where we get a first look and can
 * shrink anything over the portal-ready target in place, same key. A no-op
 * (fast path) when the file is already <= target.
 *
 * Local-driver uploads are already compressed inline at PUT time
 * (`/api/storage/local-upload/:encoded`), so this is naturally a no-op there.
 */
export async function recompressStoredObjectIfNeeded(
  fileKey: string,
  declaredMimeType: string | null | undefined,
): Promise<RecompressResult | null> {
  const normalized = normalizeFileKey(fileKey);
  let file;
  try {
    file = await objectStorageService.getObjectEntityFile(normalized);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return null;
    throw err;
  }

  const [metadata] = await file.getMetadata();
  const mime = declaredMimeType || metadata.contentType || "application/octet-stream";
  const [buffer] = await file.download();

  try {
    const processed = await processUpload(buffer, "document", mime);
    if (!processed.meta.compressed) {
      return { recompressed: false, sizeBytes: buffer.length, mimeType: mime };
    }
    await objectStorageService.overwriteObjectBuffer(normalized, processed.buffer, processed.mime);
    return {
      recompressed: true,
      sizeBytes: processed.buffer.length,
      mimeType: processed.mime,
      meta: processed.meta,
    };
  } catch (err) {
    if (err instanceof UploadTooLargeError) throw err;
    console.error(`[recompressStoredObjectIfNeeded] failed for ${normalized}:`, err);
    return { recompressed: false, sizeBytes: buffer.length, mimeType: mime };
  }
}

/**
 * Load full document bytes into memory.
 *
 * Prefers `fileKey` (object storage) when present, falls back to legacy
 * base64 `fileData`. Returns null when neither is available.
 */
export async function loadDocumentBytes(
  doc: DocBytesSource,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const mime = doc.mimeType || "application/octet-stream";
  if (doc.fileKey) {
    try {
      const file = await objectStorageService.getObjectEntityFile(
        normalizeFileKey(doc.fileKey),
      );
      const [contents] = await file.download();
      return { buffer: contents, mimeType: mime };
    } catch (err) {
      if (err instanceof ObjectNotFoundError && doc.fileData) {
        // fall through to legacy data
      } else if (!(err instanceof ObjectNotFoundError)) {
        throw err;
      } else {
        return null;
      }
    }
  }
  if (doc.fileData) {
    return { buffer: Buffer.from(doc.fileData, "base64"), mimeType: mime };
  }
  return null;
}

/**
 * Stream document content to an HTTP response. Sets Content-Type header.
 * Caller should set any additional headers (Cache-Control, Content-Disposition).
 */
export async function streamDocumentToResponse(
  doc: DocBytesSource,
  res: Response,
): Promise<boolean> {
  const mime = doc.mimeType || "application/octet-stream";
  if (doc.fileKey) {
    try {
      const file = await objectStorageService.getObjectEntityFile(
        normalizeFileKey(doc.fileKey),
      );
      res.setHeader("Content-Type", mime);
      try {
        const [metadata] = await file.getMetadata();
        if (metadata?.size != null) {
          res.setHeader("Content-Length", String(metadata.size));
        }
      } catch {
        // metadata is optional; stream without Content-Length if unavailable
      }
      const nodeStream = file.createReadStream();
      await new Promise<void>((resolve, reject) => {
        nodeStream.on("error", reject);
        nodeStream.on("end", () => resolve());
        nodeStream.pipe(res);
      });
      return true;
    } catch (err) {
      if (!(err instanceof ObjectNotFoundError)) throw err;
      // fall through to legacy fileData if present
    }
  }
  if (doc.fileData) {
    const buffer = Buffer.from(doc.fileData, "base64");
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Length", buffer.length);
    res.end(buffer);
    return true;
  }
  return false;
}
