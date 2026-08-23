export const MAX_DOCUMENT_PARTS = 6;

export function isSingleImageDocumentType(documentType: string): boolean {
  const normalized = documentType.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return normalized === "photo" || normalized === "photograph" || normalized === "passport_photo";
}

export type MergeDocumentPart = {
  file: File;
  mediaType: string;
};

export type MergeDocumentResult = {
  file: File;
  base64: string;
  mediaType: "application/pdf";
  sizeBytes: number;
  partCount: number;
  pageCount: number;
};

type MergeOptions = {
  documentType: string;
  label: string;
  parts: MergeDocumentPart[];
  publicSessionToken?: string;
};

async function fileToBase64(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
    };
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

function base64ToFile(base64: string, fileName: string, mediaType: string): File {
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  return new File([bytes], fileName, { type: mediaType, lastModified: Date.now() });
}

function getCsrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}

/**
 * Merge the current canonical file with newly selected pieces. The returned
 * file replaces the slot's previous value, so downstream AI, storage and
 * portal flows continue to receive exactly one canonical document.
 */
export async function mergeDocumentParts(options: MergeOptions): Promise<MergeDocumentResult> {
  if (options.parts.length < 2) throw new Error("At least two document parts are required.");
  if (options.parts.length > MAX_DOCUMENT_PARTS) {
    throw new Error(`A maximum of ${MAX_DOCUMENT_PARTS} parts can be merged at once.`);
  }

  const endpoint = options.publicSessionToken
    ? "/api/public/documents/merge-parts"
    : "/api/ai/merge-document-parts";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.publicSessionToken) headers["X-Application-Session"] = options.publicSessionToken;
  else {
    const csrfToken = getCsrfToken();
    if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
  }

  let current = options.parts[0];
  let lastResult: MergeDocumentResult | null = null;

  // Merge incrementally. Every request contains at most two 5 MB inputs, so
  // base64 JSON stays inside the bounded API body limit even when the user
  // selects all six parts at once.
  for (const next of options.parts.slice(1)) {
    const response = await fetch(endpoint, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({
        documentType: options.documentType,
        label: options.label,
        parts: await Promise.all([current, next].map(async ({ file, mediaType }) => ({
          data: await fileToBase64(file),
          mediaType,
          fileName: file.name,
        }))),
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Document parts could not be merged.");
    }
    const mergedFile = base64ToFile(payload.data, payload.fileName, payload.mediaType);
    lastResult = {
      file: mergedFile,
      base64: payload.data,
      mediaType: payload.mediaType,
      sizeBytes: payload.sizeBytes,
      partCount: options.parts.length,
      pageCount: payload.pageCount,
    };
    current = { file: mergedFile, mediaType: payload.mediaType };
  }

  if (!lastResult) throw new Error("Document parts could not be merged.");
  return lastResult;
}
