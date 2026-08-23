---
name: Radix Popover/cmdk inside a Dialog breaks
description: Why nesting a Radix Popover + cmdk Command inside a Radix Dialog silently fails, and the proven portal-into-dialog-content fix used across edcons.
---

A Radix `Popover` + cmdk `Command` (CommandInput/CommandItem) nested inside a
Radix `Dialog` looks fine (popover opens, list renders) but is functionally
broken: typing into the search input fails and/or clicking items does nothing.

**Why:** the Dialog's FocusScope pulls focus back on every keystroke (input
never keeps focus), and the Dialog body's `pointer-events:none` can swallow
clicks on the popover portal (rendered outside the dialog subtree). The combo
degrades silently — no console error.

**How to apply:** do NOT use Radix Popover/cmdk for a select INSIDE a Dialog.
Use the codebase's proven pattern (see `components/ui/searchable-select.tsx`,
and `components/admin/PortalMembersDialog.tsx` for a server-side-search
multi-select built the same way):
- plain `<button>` trigger toggling an open state;
- `createPortal` the menu INTO the dialog content element
  (`[data-radix-dialog-content]`, fall back to `document.body`) so FocusScope
  treats the input as "inside" and keeps it focusable;
- `position:fixed` from the trigger's `getBoundingClientRect` (escapes dialog
  `overflow` clipping), flip up when little space below;
- `pointerEvents:"auto"` + high zIndex so clicks register;
- outside-close on `"click"` (not `mousedown`) so scrollbar drag doesn't dismiss;
- focus the search input on open via ref+setTimeout.
- LIFECYCLE: reset the open/pos/portalTarget state when the dialog closes AND
  gate the portal render by the dialog-open prop, or the menu lingers as an
  orphaned floating element and re-anchors stale on reopen.
