/**
 * @workspace/object-storage
 *
 * Shared GCS client + upload primitives for Replit Object Storage.
 *
 * Uses the Replit sidecar (http://127.0.0.1:1106) for external_account
 * authentication — the same approach as the original api-server
 * objectStorage.ts.  Both api-server and portal-automation-worker can
 * import from this package to avoid duplicating the credential setup.
 *
 * Path format: Replit Object Storage uses paths like "/bucket-name/prefix/…"
 * (NOT "gs://…").  PRIVATE_OBJECT_DIR is set by the Replit platform in that
 * format, e.g. "/my-bucket/private".
 */

import { Storage } from "@google-cloud/storage";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
const DEFAULT_UPLOAD_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ObjectUploadTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Object upload timed out after ${timeoutMs}ms`);
    this.name = "ObjectUploadTimeoutError";
    Object.setPrototypeOf(this, ObjectUploadTimeoutError.prototype);
  }
}

// ---------------------------------------------------------------------------
// GCS client factory
// ---------------------------------------------------------------------------

/**
 * Creates a new GCS Storage client using Replit sidecar authentication.
 * Callers that need a singleton should use getGcsClient() instead.
 */
export function createGcsClient(): Storage {
  return new Storage({
    credentials: {
      audience: "replit",
      subject_token_type: "access_token",
      token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
      type: "external_account",
      credential_source: {
        url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
        format: {
          type: "json",
          subject_token_field_name: "access_token",
        },
      },
      universe_domain: "googleapis.com",
    },
    projectId: "",
  });
}

/** Process-lifetime singleton — use this in application code. */
let _client: Storage | null = null;
export function getGcsClient(): Storage {
  if (!_client) _client = createGcsClient();
  return _client;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Parse a Replit Object Storage path ("/bucket-name/path/to/file") into
 * its bucket and object components.
 */
export function parseGcsPath(gcsPath: string): {
  bucketName: string;
  objectName: string;
} {
  let p = gcsPath;
  if (!p.startsWith("/")) p = `/${p}`;
  const parts = p.split("/");
  if (parts.length < 3) {
    throw new Error(`[object-storage] Invalid GCS path: "${gcsPath}"`);
  }
  return {
    bucketName: parts[1] as string,
    objectName: parts.slice(2).join("/"),
  };
}

/**
 * Resolves a portal-relative subpath to:
 *  - gcsPath   — full "/bucket/prefix/subpath" for upload
 *  - objectsRef — "/objects/subpath" compatible with api-server
 *                 ObjectStorageService.getObjectEntityFile()
 *
 * Reads PRIVATE_OBJECT_DIR from the environment.
 *
 * @example
 *   resolveObjectPaths("portal-submissions/42/0-login.png")
 *   // { gcsPath: "/my-bucket/private/portal-submissions/42/0-login.png",
 *   //   objectsRef: "/objects/portal-submissions/42/0-login.png" }
 */
export function resolveObjectPaths(subpath: string): {
  gcsPath: string;
  objectsRef: string;
} {
  const dir = (process.env["PRIVATE_OBJECT_DIR"] ?? "").replace(/\/+$/, "");
  if (!dir) {
    throw new Error(
      "[object-storage] PRIVATE_OBJECT_DIR is not set — " +
        "configure Object Storage in the Replit panel and set this env var.",
    );
  }
  return {
    gcsPath:    `${dir}/${subpath}`,
    objectsRef: `/objects/${subpath}`,
  };
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export interface UploadBufferOpts {
  /**
   * Full GCS path: "/bucket-name/path/to/file"
   * Typically produced by resolveObjectPaths().gcsPath.
   */
  gcsPath: string;
  buffer: Buffer;
  contentType: string;
  timeoutMs?: number;
}

/**
 * Uploads a Buffer to GCS.  Throws ObjectUploadTimeoutError on timeout,
 * any GCS error on failure.
 */
export async function uploadBufferToGcs(opts: UploadBufferOpts): Promise<void> {
  const { gcsPath, buffer, contentType, timeoutMs = DEFAULT_UPLOAD_TIMEOUT_MS } = opts;
  const { bucketName, objectName } = parseGcsPath(gcsPath);
  const client = getGcsClient();
  const file = client.bucket(bucketName).file(objectName);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ObjectUploadTimeoutError(timeoutMs)),
      timeoutMs,
    );
  });

  try {
    await Promise.race([
      file.save(buffer, {
        metadata: { contentType },
        resumable: false,
        timeout: timeoutMs,
      }),
      timeoutPromise,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
