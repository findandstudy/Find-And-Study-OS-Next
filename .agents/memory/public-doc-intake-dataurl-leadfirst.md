---
name: Public doc intake — data-URL prefix + lead-first validation
description: Rules for any public endpoint that accepts base64 documents (embed /apply, public-apply, AI extract)
---

**Rule 1:** Every public endpoint receiving base64 documents must normalize before `Buffer.from(..., "base64")`: strip a `data:<mime>;base64,` prefix (deriving mediaType from the header when the field is empty) and strip whitespace. Stale cached widgets send FileReader data-URLs verbatim; Node decodes them to garbage bytes that fail the magic-byte check.

**Rule 2:** Document validation must NEVER reject the request before the lead/submission row is committed. Invalid docs are dropped into a `documentWarnings[]` (returned in both 201 and 422 responses) and a `validDocs[]` drives everything downstream (documentCount, mandatory-doc gate, storage loops). A bad file format must never lose the contact.

**Why:** a prod widget sent prefixed base64 → 400 "Dosya içeriği tanınamadı" fired before the lead transaction → leads silently lost (revenue impact).

**How to apply:** three sites share this pattern — embed.ts /apply, public-apply.ts /apply doc-save loop, public-apply.ts /public/ai/extract-document. Keep them in sync; the extract endpoint may still 400 (no lead at stake).
