import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, X, Check } from "lucide-react";

interface MultiSelectFilterProps {
  values: string[];
  onChange: (values: string[]) => void;
  options: { value: string; label: string }[];
  placeholder: string;
  className?: string;
  searchable?: boolean;
  dropDirection?: "up" | "down" | "auto";
}

export function MultiSelectFilter({ values, onChange, options, placeholder, className = "", searchable = true, dropDirection = "auto" }: MultiSelectFilterProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [openUp, setOpenUp] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  // The element we portal into: the Radix dialog content (keeps FocusScope
  // happy and pointer-events working) or document.body for standalone usage.
  const [portalTarget, setPortalTarget] = useState<Element | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Resolve portal target once on mount. Inside a Radix Dialog we MUST portal
  // into the dialog content (role="dialog") — not document.body. Radix sets
  // pointer-events:none on the body while a modal is open, so a menu portaled
  // to body swallows nothing and lets clicks fall THROUGH to whatever sits
  // behind it (e.g. the "Upload file" button), and its FocusScope steals focus
  // from the search input. Portaling into the dialog subtree fixes both.
  useEffect(() => {
    if (ref.current) {
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
      if (ref.current && ref.current.contains(target)) return;
      if (popRef.current && popRef.current.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  // Track trigger position in viewport coordinates (for position:fixed portal).
  // Fixed coords mean the dropdown is never clipped by any overflow ancestor
  // (dialog body or scroll container) and never mispositioned by scroll offsets.
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    function update() {
      if (!ref.current) return;
      const rect = ref.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const up = dropDirection === "up" || (dropDirection === "auto" && spaceBelow < 300);
      setOpenUp(prev => (prev === up ? prev : up));
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
  }, [open, dropDirection, portalTarget]);

  // Reset search when closed.
  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  // Focus the search input each time the dropdown opens (ref + setTimeout so it
  // fires on every re-open, not just first mount).
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

  const toggle = (val: string) => {
    onChange(values.includes(val) ? values.filter(v => v !== val) : [...values, val]);
  };

  const displayText = values.length === 0
    ? placeholder
    : values.length === 1
      ? (options.find(o => o.value === values[0])?.label || values[0])
      : `${values.length} selected`;

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`flex items-center justify-between w-full h-9 px-3 rounded-lg border text-sm transition-colors ${
          values.length > 0
            ? "bg-primary/10 border-primary/30 hover:bg-primary/15"
            : "border-input bg-background hover:bg-accent/50"
        }`}
      >
        <span className={`truncate text-left ${values.length === 0 ? "text-muted-foreground" : "text-primary font-medium"}`}>
          {displayText}
        </span>
        <div className="flex items-center gap-1 shrink-0 ml-1">
          {values.length > 0 && (
            <span
              role="button"
              onClick={e => { e.stopPropagation(); onChange([]); }}
              className="hover:text-destructive transition-colors"
            >
              <X className="w-3 h-3" />
            </span>
          )}
          <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
        </div>
      </button>

      {/* Portal dropdown: position:fixed + viewport coords so it escapes every
          overflow ancestor; pointerEvents:auto overrides Radix Dialog's
          body-level pointer-events:none so clicks register inside the menu
          instead of falling through to controls behind it. */}
      {open && pos && portalTarget && createPortal(
        <div
          ref={popRef}
          onClick={event => event.stopPropagation()}
          style={{
            position: "fixed",
            top: openUp ? pos.top - 4 : pos.top + 4,
            left: pos.left,
            width: Math.max(pos.width, 180),
            transform: openUp ? "translateY(-100%)" : "translateY(0)",
            pointerEvents: "auto",
            zIndex: 9999,
          }}
          className="bg-popover border border-border rounded-lg shadow-lg overflow-hidden animate-in fade-in-0 zoom-in-95"
        >
          {searchable && options.length > 6 && (
            <div className="p-2 border-b border-border">
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search..."
                className="w-full h-7 px-2 text-xs rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          )}
          <div className="max-h-56 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground text-center">No results</div>
            ) : (
              filtered.map(opt => {
                const selected = values.includes(opt.value);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => toggle(opt.value)}
                    className={`flex items-center gap-2 w-full px-2.5 py-1.5 text-xs rounded-md transition-colors text-left ${
                      selected ? "bg-primary/10 text-primary font-medium" : "hover:bg-primary/10 text-foreground"
                    }`}
                  >
                    <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                      selected ? "bg-primary border-primary" : "border-muted-foreground/40"
                    }`}>
                      {selected && <Check className="w-2.5 h-2.5 text-white" />}
                    </div>
                    <span className="truncate">{opt.label}</span>
                  </button>
                );
              })
            )}
          </div>
          {values.length > 0 && (
            <div className="border-t border-border p-1">
              <button
                type="button"
                onClick={() => { onChange([]); setOpen(false); }}
                className="w-full px-2.5 py-1.5 text-xs text-muted-foreground hover:text-destructive rounded-md hover:bg-primary/10 transition-colors text-left"
              >
                Clear all
              </button>
            </div>
          )}
        </div>,
        portalTarget,
      )}
    </div>
  );
}
