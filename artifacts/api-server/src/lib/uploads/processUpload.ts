import { execFile } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Config (env-driven, never hardcoded) ────────────────────────────────────

export function getMaxUploadBytes(): number {
  const raw = process.env.MAX_UPLOAD_BYTES;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15 * 1024 * 1024;
}

export function getTargetMaxBytes(): number {
  const raw = process.env.TARGET_MAX_BYTES;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2 * 1024 * 1024;
}

function getImageMaxEdge(): number {
  const raw = process.env.IMAGE_MAX_EDGE;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2000;
}

const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

const QUALITY_LADDER = [85, 80, 75, 70, 65, 60];

export class UploadTooLargeError extends Error {
  constructor(public readonly sizeBytes: number, public readonly maxBytes: number) {
    super(`Dosya çok büyük (max ${Math.round(maxBytes / (1024 * 1024))}MB). Lütfen daha küçük bir dosya yükleyin.`);
    this.name = "UploadTooLargeError";
  }
}

export interface ProcessUploadMeta {
  originalBytes: number;
  finalBytes: number;
  compressed: boolean;
  method: "sharp" | "ghostscript" | "none";
  oversizedButAccepted?: boolean;
  stillOverTarget?: boolean;
}

export interface ProcessUploadResult {
  buffer: Buffer;
  mime: string;
  filename: string;
  meta: ProcessUploadMeta;
}

/**
 * Single chokepoint for every document/image intake path. Enforces a hard
 * reject cap on absurd files, and — for anything above the portal-ready
 * target — compresses in place (images via sharp, PDFs via ghostscript) so
 * every document that ends up in object storage is already <= target and
 * "just works" against portal upload widgets (SIT/Topkapı/United/etc.).
 *
 * Never rejects a compressible file just because compression under-performs:
 * best-effort accepts the smallest achievable result rather than losing the
 * document entirely (aligned with the "no application without documents"
 * rule elsewhere in the pipeline).
 */
export async function processUpload(
  input: Buffer,
  filename: string,
  mime: string,
): Promise<ProcessUploadResult> {
  const originalBytes = input.length;
  const hardCap = getMaxUploadBytes();
  const target = getTargetMaxBytes();

  if (originalBytes > hardCap) {
    throw new UploadTooLargeError(originalBytes, hardCap);
  }

  if (originalBytes <= target) {
    return {
      buffer: input,
      mime,
      filename,
      meta: { originalBytes, finalBytes: originalBytes, compressed: false, method: "none" },
    };
  }

  const normalizedMime = mime.toLowerCase();

  if (IMAGE_MIME_TYPES.has(normalizedMime)) {
    return compressImage(input, filename, normalizedMime, target, originalBytes);
  }

  if (normalizedMime === "application/pdf") {
    return compressPdf(input, filename, target, originalBytes);
  }

  // Non-compressible type (docx, xlsx, etc.) — accept as-is, never lose it.
  return {
    buffer: input,
    mime,
    filename,
    meta: {
      originalBytes,
      finalBytes: originalBytes,
      compressed: false,
      method: "none",
      oversizedButAccepted: true,
    },
  };
}

async function compressImage(
  input: Buffer,
  filename: string,
  mime: string,
  target: number,
  originalBytes: number,
): Promise<ProcessUploadResult> {
  const sharpModule = (await import("sharp")).default;
  const maxEdge = getImageMaxEdge();
  const isHeic = mime === "image/heic" || mime === "image/heif";
  const outputMime = isHeic ? "image/jpeg" : mime === "image/png" ? "image/png" : "image/jpeg";
  const outputFilename = isHeic
    ? filename.replace(/\.(heic|heif)$/i, ".jpg")
    : filename;

  let base = sharpModule(input, { failOn: "none" }).rotate().resize({
    width: maxEdge,
    height: maxEdge,
    fit: "inside",
    withoutEnlargement: true,
  });

  let buffer: Buffer = input;
  let usedPng = outputMime === "image/png";

  if (usedPng) {
    buffer = await base.png({ compressionLevel: 9 }).toBuffer();
    if (buffer.length > target) {
      // Photographic PNGs rarely shrink enough losslessly — fall back to JPEG.
      usedPng = false;
      base = sharpModule(input, { failOn: "none" }).rotate().resize({
        width: maxEdge,
        height: maxEdge,
        fit: "inside",
        withoutEnlargement: true,
      });
    }
  }

  if (!usedPng) {
    buffer = await base.jpeg({ quality: QUALITY_LADDER[0] }).toBuffer();
    for (const quality of QUALITY_LADDER.slice(1)) {
      if (buffer.length <= target) break;
      base = sharpModule(input, { failOn: "none" }).rotate().resize({
        width: maxEdge,
        height: maxEdge,
        fit: "inside",
        withoutEnlargement: true,
      });
      buffer = await base.jpeg({ quality }).toBuffer();
    }
  }

  const finalMime = usedPng ? "image/png" : "image/jpeg";
  let finalFilename = outputFilename;
  if (!usedPng) {
    finalFilename = /\.(jpe?g)$/i.test(finalFilename)
      ? finalFilename
      : finalFilename.replace(/\.(png|heic|heif)$/i, "").concat(".jpg");
  }

  return {
    buffer,
    mime: finalMime,
    filename: finalFilename,
    meta: {
      originalBytes,
      finalBytes: buffer.length,
      compressed: true,
      method: "sharp",
      stillOverTarget: buffer.length > target,
    },
  };
}

async function compressPdf(
  input: Buffer,
  filename: string,
  target: number,
  originalBytes: number,
): Promise<ProcessUploadResult> {
  const gsAvailable = await isGhostscriptAvailable();
  if (!gsAvailable) {
    return {
      buffer: input,
      mime: "application/pdf",
      filename,
      meta: {
        originalBytes,
        finalBytes: originalBytes,
        compressed: false,
        method: "none",
        stillOverTarget: true,
      },
    };
  }

  const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "pdf-compress-"));
  const inPath = path.join(tmpDir, "in.pdf");
  const outPath = path.join(tmpDir, "out.pdf");

  try {
    await fsPromises.writeFile(inPath, input);

    let best = input;
    for (const settings of ["/ebook", "/screen"]) {
      try {
        await execFileAsync("gs", [
          "-sDEVICE=pdfwrite",
          "-dCompatibilityLevel=1.4",
          `-dPDFSETTINGS=${settings}`,
          "-dNOPAUSE",
          "-dBATCH",
          "-dQUIET",
          `-sOutputFile=${outPath}`,
          inPath,
        ]);
        const candidate = await fsPromises.readFile(outPath);
        if (candidate.length < best.length) best = candidate;
        if (best.length <= target) break;
      } catch (err) {
        console.error(`[processUpload] ghostscript pass (${settings}) failed:`, (err as Error).message);
      }
    }

    return {
      buffer: best,
      mime: "application/pdf",
      filename,
      meta: {
        originalBytes,
        finalBytes: best.length,
        compressed: best.length < originalBytes,
        method: "ghostscript",
        stillOverTarget: best.length > target,
      },
    };
  } finally {
    await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

let _gsAvailable: boolean | null = null;
async function isGhostscriptAvailable(): Promise<boolean> {
  if (_gsAvailable !== null) return _gsAvailable;
  try {
    await execFileAsync("gs", ["--version"]);
    _gsAvailable = true;
  } catch {
    _gsAvailable = false;
  }
  return _gsAvailable;
}

/**
 * Generates a random-ish suffix-free unique tmp filename. Exposed for callers
 * that need to stage a file before/after processUpload without colliding on
 * concurrent requests.
 */
export function tmpId(): string {
  return randomUUID();
}
