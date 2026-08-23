---
name: VPS storage driver abstraction
description: STORAGE_DRIVER env var switches Object Storage between Replit GCS and local filesystem for VPS migration
---

## Rule
Set `STORAGE_DRIVER=local` + `STORAGE_LOCAL_DIR=/path/to/storage` on VPS. Default (`replit`) behavior unchanged.

**Why:** Replit Object Storage is GCS-backed and unavailable on a self-hosted VPS. The `ObjectFileHandle` interface duck-types `LocalStorageFile` to be compatible with GCS `File` so all callers (documents, signContract, documentBytes) need no changes.

**How to apply:**
- `LocalStorageFile` class in `src/lib/objectStorage.ts` — implements download(), delete(), createReadStream(), getMetadata(), exists()
- GCS client is lazily initialized — not imported when `STORAGE_DRIVER=local` (avoids missing credentials crash on VPS)
- Local uploads: `PUT /api/storage/local-upload/:encoded` where encoded = base64url(relPath); content-type stored in `.ct` sidecar file
- `normalizeObjectEntityPath(rawPath)` decodes the local-upload URL back to `/objects/<relPath>` for DB storage

## Export facts
- Prod DB active fileKeys: **65 rows, 56 unique** (9 rows share the same GCS object across multiple documents)
- Deleted documents still have `file_key` in DB — export correctly filters `deleted_at IS NULL`
- Export script: `artifacts/api-server/scripts/export-object-storage.ts` (queries dev DB via `@workspace/db`)
- For prod export: query prod DB via `executeSql(env:"production")`, write keys to temp file, run inline tsx script
- `object-export.tar.gz` in `artifacts/api-server/` — 33.59 MB, contains `object-export/objects/uploads/<uuid>`
- Manifest: `object-export/manifest.json`

## Dev DB vs Prod DB
The `@workspace/db` import in scripts/tsx uses the dev DATABASE_URL (Replit dev DB). The prod DB is only reachable via `executeSql(environment:"production")` in code_execution. Object Storage bucket is shared between both environments.
