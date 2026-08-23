import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import {
  APPLICATION_DOCUMENT_MAX_SIZE,
  validateStudentDocumentBuffer,
} from "./fileUploadValidation";
import { processUpload } from "./uploads/processUpload";

const MAX_PARTS_PER_REQUEST = 6;
const MAX_MERGED_PAGES = 60;
const PDF_PAGE_WIDTH = 595.28;
const PDF_PAGE_HEIGHT = 841.89;
const PDF_PAGE_MARGIN = 24;
const MAX_CONCURRENT_MERGES = 2;
const MAX_QUEUED_MERGES = 30;

export type DocumentPartInput = {
  data: string;
  mediaType: string;
  fileName?: string;
};

export type MergedDocumentResult = {
  data: string;
  mediaType: "application/pdf";
  fileName: string;
  sizeBytes: number;
  partCount: number;
  pageCount: number;
};

export class DocumentPartMergeError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 413 | 422 | 429 = 400,
  ) {
    super(message);
    this.name = "DocumentPartMergeError";
  }
}

function isPhotoDocumentType(documentType: string): boolean {
  const normalized = documentType.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return normalized === "photo" || normalized === "photograph" || normalized === "passport_photo";
}

function safeBaseName(value: string): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || "document";
}

function decodePart(part: DocumentPartInput, index: number): Buffer {
  if (!part || typeof part.data !== "string" || !part.data.trim()) {
    throw new DocumentPartMergeError(`Document part ${index + 1} has no data.`);
  }
  const data = part.data.includes(",") ? part.data.slice(part.data.indexOf(",") + 1) : part.data;
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(data)) {
    throw new DocumentPartMergeError(`Document part ${index + 1} is not valid base64.`);
  }
  const buffer = Buffer.from(data, "base64");
  if (buffer.length === 0) {
    throw new DocumentPartMergeError(`Document part ${index + 1} is empty.`);
  }
  if (buffer.length > APPLICATION_DOCUMENT_MAX_SIZE) {
    throw new DocumentPartMergeError(
      `Each document part must be 5 MB or smaller. Part ${index + 1} is too large.`,
      413,
    );
  }
  return buffer;
}

/**
 * Merge PDF/image pieces into the single canonical PDF expected by document,
 * AI-extraction and portal-automation flows. Inputs are byte-validated before
 * parsing. The final PDF is compressed and must still fit the application-wide
 * 5 MB document contract.
 */
async function mergeDocumentPartsUnbounded(
  documentType: string,
  label: string,
  parts: DocumentPartInput[],
): Promise<MergedDocumentResult> {
  if (!Array.isArray(parts) || parts.length < 2) {
    throw new DocumentPartMergeError("At least two document parts are required for merging.");
  }
  if (parts.length > MAX_PARTS_PER_REQUEST) {
    throw new DocumentPartMergeError(`A maximum of ${MAX_PARTS_PER_REQUEST} parts can be merged at once.`);
  }
  if (isPhotoDocumentType(documentType)) {
    throw new DocumentPartMergeError("Photograph must remain a single JPG, JPEG or PNG image.");
  }

  const output = await PDFDocument.create();
  let pageCount = 0;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const raw = decodePart(part, index);
    const mediaType = String(part.mediaType || "").toLowerCase();
    const extension = mediaType === "application/pdf" ? ".pdf" : mediaType === "image/png" ? ".png" : ".jpg";
    const fileName = part.fileName?.trim() || `document-part-${index + 1}${extension}`;
    const validationError = await validateStudentDocumentBuffer(documentType, fileName, mediaType, raw);
    if (validationError) {
      throw new DocumentPartMergeError(`Part ${index + 1}: ${validationError.message}`, 422);
    }

    const processed = await processUpload(raw, fileName, mediaType);
    if (processed.mime === "application/pdf") {
      let source: PDFDocument;
      try {
        source = await PDFDocument.load(processed.buffer, {
          ignoreEncryption: false,
          updateMetadata: false,
        });
      } catch {
        throw new DocumentPartMergeError(`Part ${index + 1} is an unreadable or encrypted PDF.`, 422);
      }
      const sourcePages = source.getPageIndices();
      if (pageCount + sourcePages.length > MAX_MERGED_PAGES) {
        throw new DocumentPartMergeError(`The merged document cannot exceed ${MAX_MERGED_PAGES} pages.`, 413);
      }
      const copiedPages = await output.copyPages(source, sourcePages);
      for (const page of copiedPages) output.addPage(page);
      pageCount += copiedPages.length;
      continue;
    }

    let jpeg: Buffer;
    let imageWidth: number;
    let imageHeight: number;
    try {
      const image = sharp(processed.buffer, { failOn: "error" }).rotate();
      const metadata = await image.metadata();
      if (!metadata.width || !metadata.height) throw new Error("Missing image dimensions");
      imageWidth = metadata.width;
      imageHeight = metadata.height;
      jpeg = await image.jpeg({ quality: 85 }).toBuffer();
    } catch {
      throw new DocumentPartMergeError(`Part ${index + 1} is not a readable image.`, 422);
    }

    if (pageCount + 1 > MAX_MERGED_PAGES) {
      throw new DocumentPartMergeError(`The merged document cannot exceed ${MAX_MERGED_PAGES} pages.`, 413);
    }
    const embedded = await output.embedJpg(jpeg);
    const availableWidth = PDF_PAGE_WIDTH - PDF_PAGE_MARGIN * 2;
    const availableHeight = PDF_PAGE_HEIGHT - PDF_PAGE_MARGIN * 2;
    const scale = Math.min(availableWidth / imageWidth, availableHeight / imageHeight, 1);
    const width = imageWidth * scale;
    const height = imageHeight * scale;
    const page = output.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT]);
    page.drawImage(embedded, {
      x: (PDF_PAGE_WIDTH - width) / 2,
      y: (PDF_PAGE_HEIGHT - height) / 2,
      width,
      height,
    });
    pageCount += 1;
  }

  if (pageCount === 0) {
    throw new DocumentPartMergeError("The merged document contains no readable pages.", 422);
  }

  const mergedBytes = Buffer.from(await output.save({ useObjectStreams: true }));
  const baseName = safeBaseName(label || documentType);
  const processedMerged = await processUpload(mergedBytes, `${baseName}.pdf`, "application/pdf");
  if (processedMerged.buffer.length > APPLICATION_DOCUMENT_MAX_SIZE) {
    throw new DocumentPartMergeError(
      "The merged document is larger than 5 MB after compression. Please upload lower-resolution parts.",
      413,
    );
  }

  return {
    data: processedMerged.buffer.toString("base64"),
    mediaType: "application/pdf",
    fileName: `${baseName}.pdf`,
    sizeBytes: processedMerged.buffer.length,
    partCount: parts.length,
    pageCount,
  };
}

type MergeJob = {
  run: () => Promise<MergedDocumentResult>;
  resolve: (value: MergedDocumentResult) => void;
  reject: (error: unknown) => void;
};

let activeMerges = 0;
const pendingMerges: MergeJob[] = [];

function drainMergeQueue(): void {
  while (activeMerges < MAX_CONCURRENT_MERGES && pendingMerges.length > 0) {
    const job = pendingMerges.shift();
    if (!job) return;
    activeMerges += 1;
    void job.run()
      .then(job.resolve, job.reject)
      .finally(() => {
        activeMerges -= 1;
        drainMergeQueue();
      });
  }
}

/** Bound CPU/ghostscript work so concurrent public applications cannot freeze HTTP. */
export async function mergeDocumentParts(
  documentType: string,
  label: string,
  parts: DocumentPartInput[],
): Promise<MergedDocumentResult> {
  if (pendingMerges.length >= MAX_QUEUED_MERGES) {
    throw new DocumentPartMergeError("Document processing is busy. Please try again shortly.", 429);
  }
  return await new Promise<MergedDocumentResult>((resolve, reject) => {
    pendingMerges.push({
      run: () => mergeDocumentPartsUnbounded(documentType, label, parts),
      resolve,
      reject,
    });
    drainMergeQueue();
  });
}
