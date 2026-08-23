---
name: Portal upload non-JPEG image → JPEG conversion
description: Decision — portals that accept only JPG need content-based image conversion before upload.
---

# Portal upload non-JPEG image → JPEG conversion

Some portals (Topkapı photo field) accept ONLY JPG/JPEG and reject PNG/WEBP/HEIC
("Dosya türü geçersiz: Fotoğraf"). The runner converts non-JPEG raster images to
JPEG before upload.

**Decision: detection must be CONTENT-based, never extension/mimeType-based.**
**Why:** students upload PNGs mislabeled as `.jpg` or with a wrong `image/jpeg`
mimeType; trusting the label lets a PNG slip through and the portal still rejects
it. Use `sharp().metadata().format` and convert only when the *detected* format
is a non-JPEG raster type (a whitelist), so real JPEGs, PDFs, SVGs, and anything
sharp can't decode are all left untouched. PDFs must never be converted.

**How to apply:** do the conversion once in the shared document-download core so
both the worker and the dry-test CLI inherit it (not per-adapter). Make it
non-throwing — on any failure return the original path so the upload still
proceeds. HEIC converts only if the installed `sharp` build has libheif;
otherwise it degrades gracefully (no crash).

**Dependency:** `sharp` has a native binary — verify it loads from the package
dir, not the workspace root (root can't resolve a package-scoped dependency).
