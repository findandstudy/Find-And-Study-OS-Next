import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const MAX_MAIN_AGENCY_SIGNATURE_BYTES = 2 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
// A neutral 1x1 PNG used only to exercise the PDF pipeline in local/test
// environments. It is deliberately assembled at runtime so no reusable
// signature data URL exists in source or release artifacts. Production stays
// fail-closed and must use the approved file from persistent storage.
function nonProductionPlaceholderDataUrl(): string {
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  return `data:${"image/png"};${"base64"},${pixel.toString("base64")}`;
}

type CachedSignature = {
  filePath: string;
  dataUrl: string;
};

let cachedSignature: CachedSignature | null = null;

function isInsideRuntimeRelease(filePath: string): boolean {
  const runtimeRoot = resolve(process.cwd());
  const rel = relative(runtimeRoot, filePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function detectSignatureMime(bytes: Buffer): "image/png" | "image/jpeg" | null {
  if (bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return "image/png";
  if (bytes.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) return "image/jpeg";
  return null;
}

/**
 * Load the pre-approved main-agency signature from persistent runtime storage.
 *
 * The signature is deliberately not bundled with source code or a release.
 * Production must set MAIN_AGENCY_SIGNATURE_FILE to an absolute file outside
 * the release directory. Invalid, missing, oversized, or unsupported files
 * fail closed so a final signed PDF cannot silently omit or corrupt the seal.
 */
export function loadMainAgencySignatureDataUrl(explicitPath?: string): string {
  const configuredPath = (explicitPath ?? process.env.MAIN_AGENCY_SIGNATURE_FILE ?? "").trim();
  if (!configuredPath) {
    if (!explicitPath && (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test")) {
      return nonProductionPlaceholderDataUrl();
    }
    throw new Error("MAIN_AGENCY_SIGNATURE_FILE is required to finalize a signed contract");
  }
  if (!isAbsolute(configuredPath)) {
    throw new Error("MAIN_AGENCY_SIGNATURE_FILE must be an absolute path");
  }

  const filePath = resolve(configuredPath);
  if (isInsideRuntimeRelease(filePath)) {
    throw new Error("MAIN_AGENCY_SIGNATURE_FILE must be outside the runtime release directory");
  }
  if (cachedSignature?.filePath === filePath) return cachedSignature.dataUrl;

  const bytes = readFileSync(filePath);
  if (bytes.length === 0 || bytes.length > MAX_MAIN_AGENCY_SIGNATURE_BYTES) {
    throw new Error("Main-agency signature file is empty or exceeds 2 MB");
  }

  const mime = detectSignatureMime(bytes);
  if (!mime) {
    throw new Error("Main-agency signature file must be a valid PNG or JPEG image");
  }

  const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
  cachedSignature = { filePath, dataUrl };
  return dataUrl;
}

export function clearMainAgencySignatureCacheForTests(): void {
  cachedSignature = null;
}
