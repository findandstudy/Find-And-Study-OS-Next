import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { loadDocumentBytes, type DocBytesSource } from "./documentBytes";

const THUMBNAIL_SIZE = 128;
const CACHE_TTL_MS = 6 * 60 * 60_000;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_RENDERABLE_PDF_BYTES = 25 * 1024 * 1024;
const MAX_PDF_RENDER_CONCURRENCY = 2;
const execFileAsync = promisify(execFile);

interface ThumbnailEntry {
  buffer: Buffer;
  expiresAt: number;
}

const cache = new Map<string, ThumbnailEntry>();
const inFlight = new Map<string, Promise<Buffer>>();
let cacheBytes = 0;
let activePdfRenders = 0;
const pdfRenderWaiters: Array<() => void> = [];

async function withPdfRenderSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (activePdfRenders >= MAX_PDF_RENDER_CONCURRENCY) {
    await new Promise<void>(resolve => pdfRenderWaiters.push(resolve));
  }
  activePdfRenders += 1;
  try {
    return await operation();
  } finally {
    activePdfRenders -= 1;
    pdfRenderWaiters.shift()?.();
  }
}

function safeInitials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map(part => part[0] || "").join("").toUpperCase().replace(/[^A-Z0-9]/g, "") || "?";
}

async function placeholderThumbnail(label: string): Promise<Buffer> {
  const initials = safeInitials(label);
  const svg = Buffer.from(`
    <svg width="${THUMBNAIL_SIZE}" height="${THUMBNAIL_SIZE}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#e8eefc"/>
      <text x="50%" y="52%" dominant-baseline="middle" text-anchor="middle"
        font-family="Arial, sans-serif" font-size="38" font-weight="700" fill="#173b92">${initials}</text>
    </svg>
  `);
  return sharp(svg).jpeg({ quality: 78, mozjpeg: true }).toBuffer();
}

function isPdf(buffer: Buffer, declaredMimeType: string): boolean {
  return declaredMimeType === "application/pdf"
    || buffer.subarray(0, 5).toString("latin1") === "%PDF-";
}

async function renderPdfFirstPage(buffer: Buffer): Promise<Buffer | null> {
  if (buffer.length === 0 || buffer.length > MAX_RENDERABLE_PDF_BYTES) return null;

  return withPdfRenderSlot(async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "fas-student-photo-"));
    const pdfPath = join(tempDirectory, "source.pdf");
    const outputBase = join(tempDirectory, "page");
    const outputPath = `${outputBase}.jpg`;
    try {
      await writeFile(pdfPath, buffer);
      let rendered = false;
      try {
        await execFileAsync(
          "pdftoppm",
          ["-jpeg", "-f", "1", "-l", "1", "-scale-to", "512", "-singlefile", pdfPath, outputBase],
          { timeout: 20_000, maxBuffer: 1024 * 1024 },
        );
        rendered = true;
      } catch {
        try {
          await execFileAsync(
            "gs",
            [
              "-dSAFER",
              "-dBATCH",
              "-dNOPAUSE",
              "-dFirstPage=1",
              "-dLastPage=1",
              "-sDEVICE=jpeg",
              "-r96",
              `-sOutputFile=${outputPath}`,
              pdfPath,
            ],
            { timeout: 20_000, maxBuffer: 1024 * 1024 },
          );
          rendered = true;
        } catch {
          // A missing/failed renderer is not fatal. The caller returns initials.
        }
      }
      if (!rendered) return null;
      return await readFile(outputPath);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
}

async function normalizeThumbnail(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer, { failOn: "warning" })
    .rotate()
    .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, {
      fit: "cover",
      position: "attention",
      withoutEnlargement: false,
    })
    .jpeg({ quality: 78, mozjpeg: true })
    .toBuffer();
}

async function createThumbnail(source: DocBytesSource, fallbackLabel: string): Promise<Buffer> {
  const loaded = await loadDocumentBytes(source);
  if (!loaded) return placeholderThumbnail(fallbackLabel);
  try {
    if (isPdf(loaded.buffer, loaded.mimeType)) {
      const firstPage = await renderPdfFirstPage(loaded.buffer);
      return firstPage
        ? await normalizeThumbnail(firstPage)
        : await placeholderThumbnail(fallbackLabel);
    }
    return await normalizeThumbnail(loaded.buffer);
  } catch {
    return placeholderThumbnail(fallbackLabel);
  }
}

function store(key: string, buffer: Buffer): void {
  while (cache.size > 0 && cacheBytes + buffer.length > MAX_CACHE_BYTES) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = cache.get(oldestKey);
    if (oldest) cacheBytes -= oldest.buffer.length;
    cache.delete(oldestKey);
  }
  cache.set(key, { buffer, expiresAt: Date.now() + CACHE_TTL_MS });
  cacheBytes += buffer.length;
}

export async function getStudentPhotoThumbnail(
  cacheKey: string,
  source: DocBytesSource,
  fallbackLabel: string,
): Promise<{ buffer: Buffer; cacheStatus: "hit" | "miss" | "coalesced" }> {
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    return { buffer: cached.buffer, cacheStatus: "hit" };
  }
  if (cached) {
    cacheBytes -= cached.buffer.length;
    cache.delete(cacheKey);
  }

  const active = inFlight.get(cacheKey);
  if (active) return { buffer: await active, cacheStatus: "coalesced" };

  const pending = createThumbnail(source, fallbackLabel);
  inFlight.set(cacheKey, pending);
  try {
    const buffer = await pending;
    store(cacheKey, buffer);
    return { buffer, cacheStatus: "miss" };
  } finally {
    inFlight.delete(cacheKey);
  }
}

export function clearStudentPhotoThumbnailCacheForTests(): void {
  cache.clear();
  inFlight.clear();
  cacheBytes = 0;
}
