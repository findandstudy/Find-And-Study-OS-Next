---
name: edcons stored object URLs are root-relative, not absolute
description: Why backend validation of uploaded-asset URLs must NOT use z.string().url()
---

# Uploaded-asset URLs are root-relative

edcons frontend uploaders (branding LogoUploader, Quick Links logo, etc.) store
the uploaded file reference as a ROOT-RELATIVE path built as
`${BASE}/api/storage/objects/<key>`, where `BASE = import.meta.env.BASE_URL`
(empty string in production). So the persisted value looks like
`/api/storage/objects/branding/<uuid>` — NOT an absolute `https://...` URL.

**Why it matters:** any backend zod schema that validates such a field with
`z.string().url()` will REJECT the relative path and return HTTP 400
"Validation failed" on save, even though the file uploaded fine (the upload and
the save are two separate steps; only the save carries the URL).

**How to apply:** validate uploaded-asset URL fields with a schema that accepts
EITHER a root-relative path (`startsWith("/")` but not `//` protocol-relative)
OR an absolute `http(s)` URL — never bare `z.string().url()`. Legacy rows may
hold absolute URLs, so keep both accepted. These URLs are only rendered in
client `<img>` tags, not fetched server-side, so there's no SSRF surface.
