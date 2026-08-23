---
name: position:fixed dropdown portaled into a transformed dialog
description: Why a dropdown portaled INTO Radix DialogContent lands off-screen, and the coordinate fix
---

Custom dropdowns (searchable-select.tsx, multi-select-filter.tsx) portal their menu INTO the Radix DialogContent (`closest('[role="dialog"]')`) when inside a dialog — this is required so Radix FocusScope keeps the search input inside the dialog subtree and doesn't yank focus on every keystroke.

**Trap:** shadcn `DialogContent` centers with `translate-x-[-50%] translate-y-[-50%]`. A non-`none` `transform` on an ancestor makes it the containing block for `position: fixed` descendants (CSS spec). So a `position:fixed` dropdown portaled into the dialog resolves its coords relative to the DIALOG's box, not the viewport → it lands far off-screen ("patladı"/exploded). Portaling to `document.body` positions correctly but reintroduces the FocusScope focus-steal.

**Fix (keep both correct):** in the `update()` that computes fixed coords from `getBoundingClientRect()`, subtract the portal host's origin when the host is not `document.body`:
```
const host = portalTarget && portalTarget !== document.body ? host.getBoundingClientRect() : null;
top = (up ? rect.top : rect.bottom) - (host?.top ?? 0);
left = rect.left - (host?.left ?? 0);
```
Add `portalTarget` to the effect deps. body → origin (0,0) so standalone usage is unchanged. ~1px border-box vs padding-box discrepancy is imperceptible.

**Why:** a commit that switched these dropdowns from body-portal to dialog-portal (to fix typing/focus) silently broke positioning inside every dialog select. Any change to portal target must be paired with transform-aware coordinates.
