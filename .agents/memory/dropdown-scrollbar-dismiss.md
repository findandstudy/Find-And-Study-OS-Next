---
name: Custom dropdown closes on scrollbar drag
description: Outside-click dismissal of custom popovers/dropdowns must listen to "click", not "mousedown", or grabbing a scrollbar closes them.
---

A custom (non-Radix) popover/dropdown that dismisses on outside interaction
must register its document listener on `click`, NOT `mousedown`.

**Why:** Native scrollbar interactions (clicking the track, dragging the thumb)
emit `mousedown` but never a `click` event. A `mousedown` outside-handler
therefore dismisses the menu the moment the user grabs any scrollbar — the
popover's own inner scroll, or an ancestor scroll container such as a modal
dialog body. Using `click` keeps the menu open during scrollbar drags while
still closing on genuine outside clicks. Trigger-open is unaffected: the same
click that opens the menu has its target inside the trigger ref, so the handler
early-returns.

**How to apply:** In `SearchableSelect` (edcons `components/ui/searchable-select.tsx`)
the outside-close effect uses `document.addEventListener("click", ...)`. Keep it
on `click`. Applies to any hand-rolled dropdown with a portaled popover.

Related: when an option list is filtered down (e.g. by "only countries that have
universities"), edit mode can show blank if the saved value is filtered out —
inject the currently-selected value as a fallback option so it still displays.
