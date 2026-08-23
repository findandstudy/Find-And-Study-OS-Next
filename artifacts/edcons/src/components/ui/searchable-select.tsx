import { useState, useRef, useEffect, useLayoutEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, X, Check } from "lucide-react";

interface SearchableSelectProps {
  value: string;
  /** Preferred callback. `onValueChange` is accepted as an alias. */
  onChange?: (value: string) => void;
  /** Alias for `onChange` (Radix-style naming). */
  onValueChange?: (value: string) => void;
  options: { value: string; label: string; node?: ReactNode; icon?: ReactNode; group?: string }[];
  placeholder: string;
  searchPlaceholder?: string;
  className?: string;
  searchable?: boolean;
  clearable?: boolean;
  disabled?: boolean;
  /** Minimum pixel width of the portal dropdown (default 240). */
  minDropdownWidth?: number;
  /** When true, item labels wrap to multiple lines instead of truncating (default false). */
  wrapItems?: boolean;
}

export function SearchableSelect({
  value,
  onChange,
  onValueChange,
  options,
  placeholder,
  searchPlaceholder = "Search...",
  className = "",
  searchable = true,
  clearable = false,
  disabled = false,
  minDropdownWidth = 240,
  wrapItems = false,
}: SearchableSelectProps) {
  const emitChange = onChange ?? onValueChange ?? (() => {});
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [openUp, setOpenUp] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  // The element we portal into: dialog content (keeps Radix FocusScope happy)
  // or document.body for standalone usage.
  const [portalTarget, setPortalTarget] = useState<Element | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Resolve portal target once on mount.
  // Inside a Radix Dialog we portal INTO the dialog content div (not body) so
  // that Radix's FocusScope keeps the search input within its managed subtree
  // and doesn't snatch focus back on every keystroke. position:fixed (below)
  // means the dropdown still escapes the dialog's overflow:auto clipping.
  useEffect(() => {
    if (ref.current) {
      // Radix Dialog.Content renders with role="dialog" (NOT a
      // data-radix-dialog-content attribute), so match on the role. Falling
      // back to document.body would put the search input OUTSIDE the dialog
      // subtree, and Radix's FocusScope would then yank focus back on every
      // keystroke — making the search box impossible to type into.
      const dialogContent =
        ref.current.closest('[role="dialog"]') ??
        ref.current.closest("[data-radix-dialog-content]");
      setPortalTarget(dialogContent ?? document.body);
    }
  }, []);

  // Outside-click: use "click" (not "mousedown") so dragging a scrollbar inside
  // the dropdown doesn't close it prematurely.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (popRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  // Track trigger position in viewport coordinates (for position:fixed portal).
  // Using fixed coords means the dropdown is never clipped by any overflow
  // ancestor, whether that's the dialog body or any scroll container.
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    function update() {
      if (!ref.current) return;
      const rect = ref.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const up = spaceBelow < 320;
      // We portal INTO the Radix dialog content when inside a dialog. That
      // element uses translate(-50%,-50%) for centering, and a transformed
      // ancestor becomes the containing block for our position:fixed dropdown —
      // so fixed coords resolve relative to the dialog's box, not the viewport.
      // Subtract the host's origin so the dropdown lands under the trigger.
      // For document.body there is no transform → origin (0,0).
      const host =
        portalTarget && portalTarget !== document.body
          ? (portalTarget as HTMLElement).getBoundingClientRect()
          : null;
      const originTop = host ? host.top : 0;
      const originLeft = host ? host.left : 0;
      const top = (up ? rect.top : rect.bottom) - originTop;
      const left = rect.left - originLeft;
      const width = rect.width;
      setOpenUp(prev => (prev === up ? prev : up));
      setPos(prev =>
        prev && prev.top === top && prev.left === left && prev.width === width
          ? prev
          : { top, left, width },
      );
    }
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, portalTarget]);

  // Reset search when dropdown closes.
  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  // Focus the search input when the dropdown opens.
  // We use a ref + setTimeout instead of autoFocus so it fires every time the
  // dropdown re-opens, not only on the first mount.
  useEffect(() => {
    if (open && searchable && options.length > 6) {
      const id = setTimeout(() => searchRef.current?.focus(), 0);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [open, searchable, options.length]);

  const filtered = search
    ? options.filter(o => o.label.toLowerCase().includes(search.toLowerCase()))
    : options;

  const selected = options.find(o => o.value === value);

  // IMPORTANT: dropdownContent is a plain JSX value, NOT a function component.
  // Defining it as `function DropdownContent()` inside the render body would
  // give React a brand-new component type on every re-render, causing it to
  // unmount → remount the subtree and steal focus from the search input on
  // every keystroke. A JSX variable is stable identity → no unmount.
  const dropdownContent = (
    <>
      {searchable && options.length > 6 && (
        <div className="p-2 border-b border-border">
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={searchPlaceholder}
            className="w-full h-8 px-2 text-sm rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      )}
      <div className="max-h-72 overflow-y-auto p-1">
        {filtered.length === 0 ? (
          <div className="px-3 py-3 text-xs text-muted-foreground text-center">No results</div>
        ) : (
          (() => {
            const groups = new Map<string, typeof filtered>();
            for (const opt of filtered) {
              const g = opt.group || "";
              if (!groups.has(g)) groups.set(g, []);
              groups.get(g)!.push(opt);
            }
            return Array.from(groups.entries()).map(([group, items]) => (
              <div key={group}>
                {group && (
                  <div className="px-2.5 pt-2 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                    {group}
                  </div>
                )}
                {items.map(opt => {
                  const isSelected = opt.value === value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => { emitChange(opt.value); setOpen(false); }}
                      className={`flex items-center justify-between gap-2 w-full px-2.5 py-2 text-sm rounded-md transition-colors text-left ${
                        isSelected
                          ? "bg-primary/10 text-primary font-medium"
                          : "hover:bg-primary/10 text-foreground"
                      }`}
                    >
                      <span className={wrapItems ? "flex-1 whitespace-normal break-words text-left" : "truncate flex-1"}>
                        {opt.node ?? (
                          <span className="inline-flex items-center gap-1.5">
                            {opt.icon}
                            {opt.label}
                          </span>
                        )}
                      </span>
                      {isSelected && <Check className="w-3.5 h-3.5 shrink-0" />}
                    </button>
                  );
                })}
              </div>
            ));
          })()
        )}
      </div>
    </>
  );

  return (
    <div ref={ref} className={`relative ${className}`}>
      {/* ── Trigger button ───────────────────────────────────────────────── */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen(!open)}
        className={`flex items-center justify-between w-full h-10 px-3 rounded-md border text-sm transition-colors ${
          disabled
            ? "border-input bg-muted/50 text-muted-foreground cursor-not-allowed"
            : "border-input bg-background hover:bg-accent/30"
        }`}
      >
        <span className={`truncate text-left ${selected ? "text-foreground" : "text-muted-foreground"}`}>
          {selected
            ? (selected.node ?? (
                <span className="inline-flex items-center gap-1.5">
                  {selected.icon}
                  {selected.label}
                </span>
              ))
            : placeholder}
        </span>
        <div className="flex items-center gap-1 shrink-0 ml-1">
          {clearable && value && !disabled && (
            <span
              role="button"
              onClick={e => { e.stopPropagation(); emitChange(""); }}
              className="hover:text-destructive transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </span>
          )}
          <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
        </div>
      </button>

      {/* ── Portal dropdown ──────────────────────────────────────────────────
          Always portaled (never rendered as an inline absolute child) so it
          escapes every overflow:hidden/auto ancestor without exception.

          position:fixed + viewport coords = not clipped by any scroll container.

          pointerEvents:auto overrides Radix Dialog's `pointer-events:none` on
          the body so clicks inside the dropdown register correctly.

          When inside a Radix Dialog, we portal INTO the dialog content element
          (not body) so Radix's FocusScope considers the search input "inside"
          the dialog and doesn't forcibly move focus elsewhere.              */}
      {open && pos && portalTarget && createPortal(
        <div
          ref={popRef}
          style={{
            position: "fixed",
            top: openUp ? pos.top - 4 : pos.top + 4,
            left: pos.left,
            width: Math.max(pos.width, minDropdownWidth),
            transform: openUp ? "translateY(-100%)" : "translateY(0)",
            pointerEvents: "auto",
            zIndex: 9999,
          }}
          className="bg-popover border border-border rounded-md shadow-lg overflow-hidden animate-in fade-in-0 zoom-in-95"
        >
          {dropdownContent}
        </div>,
        portalTarget,
      )}
    </div>
  );
}
