---
name: Dropdown clipping inside overflow containers
description: Why custom dropdowns/popovers get clipped in tables/cards and the portal fix
---

# Custom dropdown clipped by ancestor overflow

A custom dropdown positioned with `absolute` + a high `z-index` is still clipped by
any ancestor with `overflow: hidden|auto` (table wrappers, kanban cards). z-index
does NOT escape an overflow clip. A page can look "fine" only because its container
happens to be tall enough — the bug is latent everywhere the component is used.

**Why:** `AssignPopover` (shared by Applications, Students, Leads — list + kanban)
broke on Applications because that table had few rows / a short overflow container.

**How to apply:** Render the menu via `createPortal(..., document.body)` with
`position: fixed` coordinates from the trigger's `getBoundingClientRect()`. Flip
above the trigger when space below is short; clamp horizontally to viewport;
recompute on `scroll` (capture=true, to catch nested scrollers) + `resize` while
open. For outside-close, listen to `click` (not `mousedown`) and exclude BOTH the
trigger ref and the portaled menu ref (the menu lives outside the trigger subtree).
