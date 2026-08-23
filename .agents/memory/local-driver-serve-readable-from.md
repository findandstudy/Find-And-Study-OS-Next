---
name: Local-driver serve broke on Readable.from(Promise)
description: Why local-disk object serving (quick-link logos etc.) returned 500 in prod but worked in dev/GCS.
---

The local storage driver serves objects through `downloadObject` → `LocalStorageFile.createReadStream`. That method must return a Readable **synchronously**; `Readable.from()` cannot take a `Promise` (it wants an Iterable/AsyncIterable) and throws `ERR_INVALID_ARG_TYPE` on every call. Use `fs.createReadStream` instead (its `end` is inclusive, matching the GCS `File.download({start,end})` contract callers rely on).

**Why:** Symptom was prod-only broken-image icons for quick-link logos (served via `/api/storage/objects/*path`). GCS uses a *different* `downloadObject` branch, so dev never exercised the broken code. Documents were unaffected because they serve via `.download()` (Buffer), not the stream path. Re-uploading never "fixed" it because the file existed — the *serve* was broken.

**How to apply:** Any bug that is "works on Replit/GCS, broken on the VPS local driver" for file serving → suspect the LocalStorageFile stream/serve path, and reproduce with `STORAGE_DRIVER=local` + `STORAGE_LOCAL_DIR` (a tsx repro of request-url → PUT → getObjectEntityFile → downloadObject is enough). Don't chase CSRF: `csrfSetup.ts` monkeypatches `window.fetch` to add `x-csrf-token` to all unsafe methods, so plain-fetch upload PUTs already carry it.
