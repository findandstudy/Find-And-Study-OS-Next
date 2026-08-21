import { type File } from "@google-cloud/storage";
import { Readable } from "stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "crypto";
import * as fsPromises from "node:fs/promises";
import { createReadStream as fsCreateReadStream } from "node:fs";
import * as nodePath from "node:path";
import type { Request, Response as ExpressResponse } from "express";
import {
  createGcsClient,
  ObjectUploadTimeoutError,
} from "@workspace/object-storage";
import {
  type ObjectAclPolicy,
  ObjectPermission,
  canAccessObject,
  getObjectAclPolicy,
  setObjectAclPolicy,
} from "./objectAcl";

export { ObjectUploadTimeoutError };

// ── Common file handle interface ──────────────────────────────────────────────
// Both the GCS File (replit driver) and LocalStorageFile (local driver) satisfy
// this interface.  All callers of getObjectEntityFile() use this type so they
// don't need to know which driver is active, and don't trigger TypeScript union
// overload incompatibility errors from the different stream implementations.

export interface ObjectFileHandle {
  createReadStream(opts?: { start?: number; end?: number }): Readable;
  download(opts?: { start?: number; end?: number }): Promise<[Buffer]>;
  delete(opts?: { ignoreNotFound?: boolean }): Promise<void>;
  getMetadata(): Promise<[{ contentType?: string; size?: number | string }]>;
  exists(): Promise<[boolean]>;
}

// Replit sidecar endpoint — used by signObjectURL for pre-signed URL generation.
const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

const UPLOAD_TIMEOUT_MS = 30_000;

// Lazily create GCS client only when the replit storage driver is actually used.
let _gcsClient: ReturnType<typeof createGcsClient> | null = null;
function getGcsClient() {
  if (!_gcsClient) _gcsClient = createGcsClient();
  return _gcsClient;
}

// ── Driver selection ──────────────────────────────────────────────────────────
// Set STORAGE_DRIVER=local on VPS to use local-disk storage instead of Replit
// Object Storage (GCS). Default is "replit" so existing behaviour is unchanged.

function isLocalDriver(): boolean {
  return (process.env.STORAGE_DRIVER ?? "replit") === "local";
}

function getLocalStorageDir(): string {
  const dir = process.env.STORAGE_LOCAL_DIR ?? "";
  if (!dir) {
    throw new Error(
      "STORAGE_LOCAL_DIR is not set. Set it to the absolute path where files " +
        "should be stored (e.g. /var/www/apply.findandstudy.com/storage)."
    );
  }
  return dir;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = nodePath.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${nodePath.sep}`) && relative !== ".." && !nodePath.isAbsolute(relative));
}

function assertSafeLocalRelativePath(relativePath: string): string[] {
  const parts = relativePath.split("/");
  if (
    !relativePath ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    nodePath.isAbsolute(relativePath) ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new ObjectNotFoundError();
  }
  return parts;
}

async function resolveExistingLocalPath(relativePath: string): Promise<string> {
  assertSafeLocalRelativePath(relativePath);
  const root = await fsPromises.realpath(getLocalStorageDir());
  const candidate = nodePath.resolve(root, relativePath);
  if (!isWithinRoot(root, candidate)) throw new ObjectNotFoundError();
  let realCandidate: string;
  try {
    realCandidate = await fsPromises.realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ObjectNotFoundError();
    throw error;
  }
  if (!isWithinRoot(root, realCandidate)) throw new ObjectNotFoundError();
  return realCandidate;
}

// ── LocalStorageFile ──────────────────────────────────────────────────────────
// Duck-typed local equivalent of @google-cloud/storage File.
// Implements exactly the methods used by ObjectStorageService so the rest of the
// codebase can treat it the same way.

export class LocalStorageFile {
  constructor(
    public readonly localPath: string,
    public readonly relPath: string,
  ) {}

  async getMetadata(): Promise<[{ contentType?: string; size?: number | string }]> {
    const stats = await fsPromises.stat(this.localPath);
    const ctFile = `${this.localPath}.ct`;
    let contentType = "application/octet-stream";
    try {
      contentType = (await fsPromises.readFile(ctFile, "utf8")).trim();
    } catch {
      const ext = nodePath.extname(this.localPath).toLowerCase();
      const MIME: Record<string, string> = {
        ".pdf": "application/pdf",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".doc": "application/msword",
        ".docx":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xls": "application/vnd.ms-excel",
        ".xlsx":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".zip": "application/zip",
        ".json": "application/json",
        ".txt": "text/plain",
        ".csv": "text/csv",
      };
      contentType = MIME[ext] ?? "application/octet-stream";
    }
    return [{ contentType, size: stats.size }];
  }

  // Returns a proper Node.js Readable so callers can chain .on() the same way
  // they do with GCS File.createReadStream(). Uses fs.createReadStream so a real
  // stream is returned synchronously — Readable.from() cannot take a Promise and
  // throws ERR_INVALID_ARG_TYPE, which previously broke every local-driver serve
  // (e.g. quick-link logos returned HTTP 500 → broken image). fs.createReadStream
  // treats `end` as inclusive, matching the GCS File.download({start,end})
  // contract callers rely on.
  createReadStream(opts?: { start?: number; end?: number }): Readable {
    const streamOpts: { start?: number; end?: number } = {};
    if (opts?.start !== undefined) streamOpts.start = opts.start;
    if (opts?.end !== undefined) streamOpts.end = opts.end;
    return fsCreateReadStream(this.localPath, streamOpts);
  }

  // GCS File.download() compatibility — downloads the whole file (or a range)
  // into a Buffer and returns it as a one-element tuple, just like the GCS SDK.
  async download(opts?: { start?: number; end?: number }): Promise<[Buffer]> {
    const raw = await fsPromises.readFile(this.localPath);
    if (opts?.start !== undefined || opts?.end !== undefined) {
      const s = opts.start ?? 0;
      const e = opts.end !== undefined ? opts.end + 1 : raw.length;
      return [raw.slice(s, e)];
    }
    return [raw];
  }

  // GCS File.delete() compatibility — removes the file and its sidecar.
  async delete(opts?: { ignoreNotFound?: boolean }): Promise<void> {
    try {
      await fsPromises.unlink(this.localPath);
      try { await fsPromises.unlink(`${this.localPath}.ct`); } catch { /* no sidecar is fine */ }
    } catch (err) {
      if (opts?.ignoreNotFound && (err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  async exists(): Promise<[boolean]> {
    try {
      await fsPromises.access(this.localPath);
      return [true];
    } catch {
      return [false];
    }
  }
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export class InvalidObjectRangeError extends Error {
  constructor(public readonly size: number) {
    super("Requested range is not satisfiable");
    this.name = "InvalidObjectRangeError";
  }
}

type ByteRange = { start: number; end: number };

export function parseObjectRange(rangeHeader: string | undefined, size: number): ByteRange | null {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || size === 0) throw new InvalidObjectRangeError(size);
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) throw new InvalidObjectRangeError(size);

  let start: number;
  let end: number;
  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) throw new InvalidObjectRangeError(size);
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
      throw new InvalidObjectRangeError(size);
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

// ── ObjectStorageService ──────────────────────────────────────────────────────

export class ObjectStorageService {
  constructor() {}

  // ── Replit-driver config helpers ──────────────────────────────────────────

  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS ?? "";
    const paths = Array.from(
      new Set(
        pathsStr
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p.length > 0)
      )
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in 'Object Storage' " +
          "tool and set PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths)."
      );
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR ?? "";
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }
    return dir;
  }

  // ── searchPublicObject ────────────────────────────────────────────────────

  async searchPublicObject(filePath: string): Promise<ObjectFileHandle | null> {
    if (isLocalDriver()) {
      // The unauthenticated public-object route may resolve only the physical
      // public namespace. Private local objects live directly below the
      // storage root and must be opened through getObjectEntityFile(), whose
      // callers apply authentication and object-level authorization.
      try {
        assertSafeLocalRelativePath(filePath);
        const publicLocalPath = await resolveExistingLocalPath(nodePath.posix.join("public", filePath));
        return new LocalStorageFile(publicLocalPath, nodePath.posix.join("public", filePath));
      } catch {
        return null;
      }
    }

    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;
      const { bucketName, objectName } = parseObjectPath(fullPath);
      const bucket = getGcsClient().bucket(bucketName);
      const file = bucket.file(objectName);
      const [exists] = await file.exists();
      if (exists) return file as unknown as ObjectFileHandle;
    }
    return null;
  }

  // ── downloadObject ────────────────────────────────────────────────────────

  async downloadObject(
    file: ObjectFileHandle,
    cacheTtlSec: number = 3600
  ): Promise<Response> {
    if (file instanceof LocalStorageFile) {
      const [metadata] = await file.getMetadata();
      const headers: Record<string, string> = {
        "Content-Type": metadata.contentType ?? "application/octet-stream",
        "Cache-Control": `private, max-age=${cacheTtlSec}`,
      };
      if (metadata.size !== undefined) {
        headers["Content-Length"] = String(metadata.size);
      }
      const nodeStream = file.createReadStream();
      const webStream = Readable.toWeb(nodeStream) as ReadableStream;
      return new Response(webStream, { headers });
    }

    // GCS path
    const gcsFile = file as unknown as File;
    const [metadata] = await gcsFile.getMetadata();
    const aclPolicy = await getObjectAclPolicy(gcsFile);
    const isPublic = aclPolicy?.visibility === "public";
    const nodeStream = gcsFile.createReadStream();
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;
    const headers: Record<string, string> = {
      "Content-Type": (metadata.contentType as string) ?? "application/octet-stream",
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
    };
    if (metadata.size) headers["Content-Length"] = String(metadata.size);
    return new Response(webStream, { headers });
  }

  async streamObjectToResponse(
    req: Request,
    res: ExpressResponse,
    file: ObjectFileHandle,
    options: {
      cacheTtlSec?: number;
      contentType?: string;
      cacheControl?: string;
    } = {},
  ): Promise<void> {
    const [metadata] = await file.getMetadata();
    const size = Number(metadata.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error("Object metadata has an invalid size");
    }

    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", options.contentType ?? metadata.contentType ?? "application/octet-stream");
    res.setHeader("Cache-Control", options.cacheControl ?? `private, max-age=${options.cacheTtlSec ?? 3600}`);

    let range: ByteRange | null;
    try {
      range = parseObjectRange(req.headers.range, size);
    } catch (error) {
      if (error instanceof InvalidObjectRangeError) {
        res.status(416);
        res.setHeader("Content-Range", `bytes */${size}`);
        res.setHeader("Content-Length", "0");
        res.end();
        return;
      }
      throw error;
    }

    if (range) {
      res.status(206);
      res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
      res.setHeader("Content-Length", String(range.end - range.start + 1));
    } else {
      res.status(200);
      res.setHeader("Content-Length", String(size));
    }
    if (size === 0) {
      res.end();
      return;
    }

    const stream = file.createReadStream(range ?? undefined);
    let disconnected = false;
    const closeStream = () => {
      if (!res.writableEnded) {
        disconnected = true;
        stream.destroy();
      }
    };
    req.once("aborted", closeStream);
    try {
      await pipeline(stream, res);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!disconnected || (code !== "ERR_STREAM_PREMATURE_CLOSE" && code !== "ECONNRESET")) {
        throw error;
      }
    } finally {
      req.off("aborted", closeStream);
      if (!stream.destroyed) stream.destroy();
    }
  }

  // ── uploadBuffer ──────────────────────────────────────────────────────────

  async writeLocalObjectBuffer(
    relativePath: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<void> {
    if (!isLocalDriver()) throw new ObjectNotFoundError();

    const parts = assertSafeLocalRelativePath(relativePath);
    const configuredRoot = nodePath.resolve(getLocalStorageDir());
    await fsPromises.mkdir(configuredRoot, { recursive: true, mode: 0o700 });
    const root = await fsPromises.realpath(configuredRoot);
    await fsPromises.chmod(root, 0o700);

    let parent = root;
    for (const directoryPart of parts.slice(0, -1)) {
      const next = nodePath.join(parent, directoryPart);
      if (!isWithinRoot(root, next)) throw new ObjectNotFoundError();
      try {
        const info = await fsPromises.lstat(next);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new ObjectNotFoundError();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await fsPromises.mkdir(next, { mode: 0o700 });
      }
      const realDirectory = await fsPromises.realpath(next);
      if (!isWithinRoot(root, realDirectory)) throw new ObjectNotFoundError();
      await fsPromises.chmod(realDirectory, 0o700);
      parent = realDirectory;
    }

    const localPath = nodePath.join(parent, parts.at(-1)!);
    if (!isWithinRoot(root, localPath)) throw new ObjectNotFoundError();
    for (const candidate of [localPath, `${localPath}.ct`]) {
      try {
        const info = await fsPromises.lstat(candidate);
        if (!info.isFile() || info.isSymbolicLink()) throw new ObjectNotFoundError();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    await fsPromises.writeFile(localPath, buffer, { mode: 0o600 });
    await fsPromises.chmod(localPath, 0o600);
    await fsPromises.writeFile(`${localPath}.ct`, contentType, { mode: 0o600 });
    await fsPromises.chmod(`${localPath}.ct`, 0o600);
  }

  async uploadBuffer(opts: {
    subdir: string;
    filename: string;
    buffer: Buffer;
    contentType: string;
  }): Promise<string> {
    const objectId = randomUUID();
    const subdir = opts.subdir.replace(/^\/+|\/+$/g, "");
    const filename = opts.filename.replace(/[^A-Za-z0-9._-]/g, "_");

    if (isLocalDriver()) {
      const relPath = `${subdir}/${objectId}-${filename}`;
      await this.writeLocalObjectBuffer(relPath, opts.buffer, opts.contentType);
      return `/objects/${relPath}`;
    }

    const privateObjectDir = this.getPrivateObjectDir();
    const fullPath = `${privateObjectDir}/${subdir}/${objectId}-${filename}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    const bucket = getGcsClient().bucket(bucketName);
    const file = bucket.file(objectName);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ObjectUploadTimeoutError(UPLOAD_TIMEOUT_MS)),
        UPLOAD_TIMEOUT_MS
      );
    });
    try {
      await Promise.race([
        file.save(opts.buffer, {
          metadata: { contentType: opts.contentType },
          resumable: false,
          timeout: UPLOAD_TIMEOUT_MS,
        }),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    let entityDir = privateObjectDir;
    if (entityDir.endsWith("/")) entityDir = entityDir.slice(0, -1);
    const relPath = fullPath.slice(entityDir.length + 1);
    return `/objects/${relPath}`;
  }

  // ── getObjectEntityUploadURL ──────────────────────────────────────────────

  async getObjectEntityUploadURL(prefix?: string): Promise<string> {
    const objectId = randomUUID();
    let cleanPrefix = (prefix ?? "uploads").replace(/^\/+|\/+$/g, "");
    if (cleanPrefix.includes("..") || cleanPrefix.includes("\\"))
      cleanPrefix = "uploads";

    if (isLocalDriver()) {
      // Return a relative URL handled by PUT /api/storage/local-upload/:encoded.
      // The encoded segment is the base64url of the file's relative path inside
      // STORAGE_LOCAL_DIR, which lets normalizeObjectEntityPath recover it.
      const relPath = `${cleanPrefix}/${objectId}`;
      const encoded = Buffer.from(relPath).toString("base64url");
      return `/api/storage/local-upload/${encoded}`;
    }

    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }
    const fullPath = `${privateObjectDir}/${cleanPrefix}/${objectId}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    return signObjectURL({ bucketName, objectName, method: "PUT", ttlSec: 900 });
  }

  // ── getObjectEntityFile ───────────────────────────────────────────────────

  async getObjectEntityFile(objectPath: string): Promise<ObjectFileHandle> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    if (isLocalDriver()) {
      const relPath = objectPath.slice("/objects/".length);
      const localPath = await resolveExistingLocalPath(relPath);
      const localFile = new LocalStorageFile(localPath, relPath);
      return localFile;
    }

    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) throw new ObjectNotFoundError();
    const entityId = parts.slice(1).join("/");
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) entityDir = `${entityDir}/`;
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    const bucket = getGcsClient().bucket(bucketName);
    const objectFile = bucket.file(objectName);
    const [exists] = await objectFile.exists();
    if (!exists) throw new ObjectNotFoundError();
    return objectFile as unknown as ObjectFileHandle;
  }

  // ── overwriteObjectBuffer ─────────────────────────────────────────────────
  // Replaces the bytes at an already-existing object path in place (same
  // key). Used by the upload-time compression chokepoint (processUpload) to
  // shrink a file that was already written via a signed PUT URL, without
  // changing the fileKey any caller has already persisted.

  async overwriteObjectBuffer(objectPath: string, buffer: Buffer, contentType: string): Promise<void> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    if (isLocalDriver()) {
      const relPath = objectPath.slice("/objects/".length);
      await this.writeLocalObjectBuffer(relPath, buffer, contentType);
      return;
    }

    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) throw new ObjectNotFoundError();
    const entityId = parts.slice(1).join("/");
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) entityDir = `${entityDir}/`;
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    const bucket = getGcsClient().bucket(bucketName);
    const file = bucket.file(objectName);
    await file.save(buffer, { metadata: { contentType }, resumable: false, timeout: UPLOAD_TIMEOUT_MS });
  }

  // ── normalizeObjectEntityPath ─────────────────────────────────────────────

  normalizeObjectEntityPath(rawPath: string): string {
    if (isLocalDriver()) {
      // Handle both relative (/api/storage/local-upload/{encoded}) and absolute
      // (https://host/api/storage/local-upload/{encoded}) forms.
      const LOCAL_UPLOAD_SEGMENT = "/api/storage/local-upload/";
      let encoded: string | null = null;

      if (rawPath.startsWith(LOCAL_UPLOAD_SEGMENT)) {
        encoded = rawPath.slice(LOCAL_UPLOAD_SEGMENT.length);
      } else if (rawPath.includes(LOCAL_UPLOAD_SEGMENT)) {
        try {
          const url = new URL(rawPath);
          const idx = url.pathname.indexOf(LOCAL_UPLOAD_SEGMENT);
          if (idx !== -1) {
            encoded = url.pathname.slice(idx + LOCAL_UPLOAD_SEGMENT.length);
          }
        } catch {
          // not a full URL
        }
      }

      if (encoded) {
        try {
          const relPath = Buffer.from(encoded, "base64url").toString();
          if (!relPath.includes("..") && !relPath.includes("\\")) {
            return `/objects/${relPath}`;
          }
        } catch {
          // bad encoding — fall through and return rawPath unchanged
        }
      }
      return rawPath;
    }

    if (!rawPath.startsWith("https://storage.googleapis.com/")) {
      return rawPath;
    }
    const url = new URL(rawPath);
    const rawObjectPath = url.pathname;
    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith("/")) objectEntityDir = `${objectEntityDir}/`;
    if (!rawObjectPath.startsWith(objectEntityDir)) return rawObjectPath;
    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }

  // ── trySetObjectEntityAclPolicy ───────────────────────────────────────────

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy
  ): Promise<string> {
    if (isLocalDriver()) {
      // ACL not applicable for local-disk storage; return the normalised path.
      return this.normalizeObjectEntityPath(rawPath);
    }
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/")) return normalizedPath;
    const objectFile = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(objectFile as unknown as File, aclPolicy);
    return normalizedPath;
  }

  // ── canAccessObjectEntity ─────────────────────────────────────────────────

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: ObjectFileHandle;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    if (objectFile instanceof LocalStorageFile) {
      // Local storage has no per-file ACL; access control is the calling
      // route's responsibility (session auth + IDOR guard).
      return true;
    }
    return canAccessObject({
      userId,
      objectFile: objectFile as unknown as File,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith("/")) path = `/${path}`;
  const pathParts = path.split("/");
  if (pathParts.length < 3) {
    throw new Error("Invalid path: must contain at least a bucket name");
  }
  return { bucketName: pathParts[1], objectName: pathParts.slice(2).join("/") };
}

async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
}: {
  bucketName: string;
  objectName: string;
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  ttlSec: number;
}): Promise<string> {
  const request = {
    bucket_name: bucketName,
    object_name: objectName,
    method,
    expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
  };
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!response.ok) {
    throw new Error(
      `Failed to sign object URL, errorcode: ${response.status}, ` +
        `make sure you're running on Replit`
    );
  }
  const { signed_url: signedURL } = (await response.json()) as {
    signed_url: string;
  };
  return signedURL;
}
