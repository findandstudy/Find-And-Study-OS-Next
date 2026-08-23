---
name: Document preview (in-app modal + middle-click background tab)
description: How edcons document "Preview" triggers behave and why lead docs need blob URLs
---

Every document "Preview" affordance in edcons is built from a shared hook
(`useDocumentPreview` in `components/DocumentPreviewDialog.tsx`) whose
`getTriggerProps` is spread onto an `<a target="_blank">`:

- Left click (no modifier, renderable kind) → in-app preview modal (iframe for pdf, img for image).
- Middle click → native anchor opens the file in a **background** tab without navigating away.
- Ctrl/Cmd/Shift+click or `kind === "other"` → native new-tab behavior.

**Why an anchor, not `window.open`:** only a real `<a href target="_blank">` opens a
*background* tab on middle click and leaves the current page focused. `window.open`
opens a *foreground* tab and steals focus — fails the "don't navigate the user away"
requirement. So every preview trigger MUST have a real `href`, not just an onClick.

**Lead documents need a blob href.** Lead-only docs (rows with `leadId` but no
`studentId`) 403 on `/api/documents/:id/download` for agent roles, so build a blob:
URL client-side from the already-loaded base64 `fileData`. Student/application docs
just use `${BASE}/api/documents/:id/download?disposition=inline` directly.

**Blob lifecycle:** because the anchor needs a stable href for native middle-click,
blob URLs are created eagerly per lead `fileData` doc and tracked in a ref; revoke
them ONLY on component unmount — never on `docs`/list refetch — or you invalidate a
blob still loading in an open modal or a freshly opened background tab. (`data:`
URLs are unreliable for top-level navigation; use blob.)

**How to apply:** when adding a preview to any new document surface, reuse
`useDocumentPreview`; pass `{ href, downloadHref, kind, name }`. Use the inline
download endpoint only for student/application-scoped docs; use the blob path for
anything that may be lead-scoped.
