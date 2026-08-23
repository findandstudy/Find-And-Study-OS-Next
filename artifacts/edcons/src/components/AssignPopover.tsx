import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { UserCheck, UserPlus, Search } from "lucide-react";

interface AssignPopoverProps {
  assignedUserName?: string;
  staffUsers: { id: number; name: string }[];
  currentUserId?: number;
  onAssign: (userId: number) => void;
  size?: "card" | "list";
}

const MENU_WIDTH = 224; // w-56
const MENU_MAX_HEIGHT = 290; // search box + scrollable list, used for flip decision

export function AssignPopover({ assignedUserName, staffUsers, currentUserId, onAssign }: AssignPopoverProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ left: number; triggerTop: number; triggerBottom: number; openUp: boolean } | null>(null);

  // The menu renders in a portal with fixed positioning so it is never clipped
  // by an ancestor table/card with overflow:hidden|auto. It flips above the
  // trigger when there isn't enough room below.
  function updatePosition() {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const spaceAbove = r.top;
    const openUp = spaceBelow < MENU_MAX_HEIGHT && spaceAbove > spaceBelow;
    let left = r.left;
    if (left + MENU_WIDTH > window.innerWidth - 8) left = window.innerWidth - MENU_WIDTH - 8;
    if (left < 8) left = 8;
    // Skip the update when nothing actually moved. Reposition runs on every
    // scroll/resize event; emitting a fresh object each time would re-render the
    // portal continuously and, if a reposition itself nudges scroll, could feed
    // back into an update loop (React #185). Returning the previous object on a
    // no-op keeps identity stable and breaks any such feedback.
    setCoords(prev =>
      prev &&
      prev.left === left &&
      prev.triggerTop === r.top &&
      prev.triggerBottom === r.bottom &&
      prev.openUp === openUp
        ? prev
        : { left, triggerTop: r.top, triggerBottom: r.bottom, openUp },
    );
  }

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    function onScrollResize() { updatePosition(); }
    window.addEventListener("scroll", onScrollResize, true);
    window.addEventListener("resize", onScrollResize);
    return () => {
      window.removeEventListener("scroll", onScrollResize, true);
      window.removeEventListener("resize", onScrollResize);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Use "click" (not "mousedown") so dragging the menu's inner scrollbar does
    // not dismiss it. Both the trigger and the portaled menu are excluded.
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [open]);

  const filtered = staffUsers.filter(u =>
    !search || u.name.toLowerCase().includes(search.toLowerCase())
  );

  const meFirst = currentUserId
    ? [...filtered.filter(u => u.id === currentUserId), ...filtered.filter(u => u.id !== currentUserId)]
    : filtered;

  return (
    <div ref={triggerRef} className="relative flex min-w-0 max-w-full">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); setSearch(""); }}
        className={`flex min-w-0 max-w-full items-center gap-0.5 truncate ${
          assignedUserName
            ? `text-[10px] text-muted-foreground hover:text-primary transition-colors`
            : `text-[10px] text-primary hover:underline font-medium`
        }`}
        title={assignedUserName || "Assign staff member"}
      >
        {assignedUserName ? (
          <><UserCheck className="w-3 h-3 shrink-0" />{assignedUserName}</>
        ) : (
          <><UserPlus className="w-3 h-3 shrink-0" />Assign</>
        )}
      </button>
      {open && coords && createPortal(
        <div
          ref={menuRef}
          style={{
            position: "fixed",
            left: coords.left,
            top: coords.openUp ? undefined : coords.triggerBottom + 4,
            bottom: coords.openUp ? window.innerHeight - coords.triggerTop + 4 : undefined,
            width: MENU_WIDTH,
          }}
          className="bg-popover border rounded-xl shadow-xl z-[9999] overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="p-2 border-b">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search staff..."
                className="w-full h-8 pl-7 pr-2 text-xs rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                autoFocus
              />
            </div>
          </div>
          <div className="max-h-48 overflow-y-auto py-1">
            {meFirst.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-3">No staff found</p>
            ) : (
              meFirst.map(u => (
                <button
                  key={u.id}
                  onClick={(e) => { e.stopPropagation(); onAssign(u.id); setOpen(false); }}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-primary/10 transition-colors flex items-center gap-2"
                >
                  <div className="w-5 h-5 rounded-full bg-primary/10 flex items-center justify-center text-primary text-[9px] font-bold shrink-0">
                    {u.name.split(" ").map(n => n[0]).join("").slice(0, 2)}
                  </div>
                  <span className="truncate">{u.name}</span>
                  {u.id === currentUserId && (
                    <span className="text-[9px] text-muted-foreground ml-auto shrink-0">(Me)</span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
