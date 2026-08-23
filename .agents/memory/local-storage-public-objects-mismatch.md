---
name: Local storage keeps private and public namespaces separate
description: How trusted attachment readers preserve legacy compatibility without exposing private local objects through the anonymous public-object route.
---

With `STORAGE_DRIVER=local`, authenticated uploads are private and are written as
`STORAGE_LOCAL_DIR/<prefix>/<objectId>`. The virtual `/objects/<relPath>` form is
for authenticated, object-authorized reads through `getObjectEntityFile()`.

The anonymous `/storage/public-objects/*` route is deliberately different. Its
`searchPublicObject()` resolver may read only the physical
`STORAGE_LOCAL_DIR/public/<relPath>` namespace. It must never try the bare
storage-root path first: a caller who knows a private object key would otherwise
bypass object authorization.

Legacy inbox URLs can contain double slashes or a stray leading `objects/`
segment. Trusted server-side callers should normalize those URLs with
`resolveLocalInboxStorageKey()`, then try
`getObjectEntityFile('/objects/' + key)` first. They may fall back to
`searchPublicObject(key)` only for historical objects that were genuinely
stored in a configured public namespace (including GCS public search paths).

Do not build storage paths by hand, expose a private key through the public
route, or restore the former bare-path fallback in `searchPublicObject()`.
