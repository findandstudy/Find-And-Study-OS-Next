/**
 * PortalMembersDialog.tsx — Phase 3 multi-portal MEMBERSHIP
 *
 * Manages the member universities of a multi-portal account, sourced directly
 * from the FAS-OS catalog (universities table) keyed by catalog id. Replaces the
 * Phase 2 universityKey-based MultiPortalMembersDialog.
 *
 *  - Loads current members:  GET  /portal-automation/accounts/:key/members
 *  - Searches the catalog:   GET  /portal-automation/catalog-universities?q=
 *  - Saves the member set:   PUT  /portal-automation/accounts/:key/members
 *
 * A catalog university already owned by a DIFFERENT account → 409 ALREADY_ASSIGNED.
 * The user is then asked to confirm a force-move (retry with force=true).
 */

import { useState, useEffect, useMemo, useRef } from "react";
import { customFetch, ApiError } from "@workspace/api-client-react";
import { useI18n } from "@/hooks/use-i18n";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Network, Check, X, Loader2, ChevronDown } from "lucide-react";

interface PortalAccount {
  universityKey: string;
  universityName: string;
}

interface CatalogUniversity {
  id: number;
  name: string;
  country: string;
  universityType: string | null;
}

interface CatalogFilters {
  countries: string[];
  types: string[];
}

interface MemberRow {
  catalogUniversityId: number;
  enabled: boolean;
  universityName: string;
  country: string;
}

interface MembersResponse {
  portalKey: string;
  members: MemberRow[];
}

interface PortalMembersDialogProps {
  /** The multi-portal account whose members are managed (null = closed). */
  portal: PortalAccount | null;
  onClose: () => void;
  onSaved: () => void;
}

export function PortalMembersDialog({ portal, onClose, onSaved }: PortalMembersDialogProps) {
  const { t } = useI18n();
  const { toast } = useToast();

  // Selected catalog ids → display label, so chips render without re-fetching.
  const [selected, setSelected] = useState<Map<number, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CatalogUniversity[]>([]);
  const [searching, setSearching] = useState(false);

  // Country + university-type filters for the picker.
  const [filterCountry, setFilterCountry] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterOptions, setFilterOptions] = useState<CatalogFilters>({ countries: [], types: [] });

  // 409 force-move confirmation state.
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);

  // ── Picker dropdown (rendered INLINE inside the dialog content) ────────────
  // Do NOT portal this to document.body: a modal Radix Dialog marks every
  // sibling of its portal as inert (`pointer-events:none` + aria-hidden) and
  // traps focus inside its content, so a body-portaled dropdown renders but
  // can't be typed in or clicked. Rendering the menu inline keeps it inside the
  // dialog's FocusScope (typing works) and interactive, and absolute
  // positioning relative to the trigger avoids the transformed-ancestor issue
  // that breaks position:fixed inside the translated DialogContent.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [placement, setPlacement] = useState<{ up: boolean; maxH: number }>({
    up: false,
    maxH: 340,
  });

  // Anchor the picker to the trigger and size it so it always fits inside the
  // viewport (and therefore inside the centered modal). Prefer opening downward;
  // flip upward only when there is more room above than below, and cap the height
  // to the available space so the panel can never float past the modal's
  // top/bottom edge. maxH is bounded by min(45vh, 340px) per design.
  const computePlacement = () => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const MARGIN = 8;
    const spaceBelow = window.innerHeight - rect.bottom - MARGIN;
    const spaceAbove = rect.top - MARGIN;
    const cap = Math.min(340, Math.round(window.innerHeight * 0.45));
    const up = spaceBelow < cap && spaceAbove > spaceBelow;
    const avail = up ? spaceAbove : spaceBelow;
    // Use as much of the available space as the cap allows, but keep a usable
    // floor (160px) so an extremely short viewport can't collapse the panel to
    // nothing — always bounded by the cap so it still respects the design max.
    const maxH = Math.min(cap, Math.max(160, avail));
    setPlacement({ up, maxH });
  };

  // Toggle the picker, computing its anchored placement just before it opens.
  const togglePicker = () => {
    if (!pickerOpen) computePlacement();
    setPickerOpen((o) => !o);
  };

  // Keep the picker anchored & contained if the viewport changes while it is open.
  useEffect(() => {
    if (!pickerOpen) return;
    const onResize = () => computePlacement();
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
    };
  }, [pickerOpen]);

  // Outside-click closes the picker. Listen to "click" (not "mousedown") so
  // dragging the results scrollbar doesn't dismiss it prematurely.
  useEffect(() => {
    if (!pickerOpen) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popRef.current?.contains(target)) return;
      setPickerOpen(false);
    }
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [pickerOpen]);

  // Focus the search box each time the picker opens.
  useEffect(() => {
    if (!pickerOpen) return;
    const id = setTimeout(() => searchInputRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [pickerOpen]);

  // Tear the picker down whenever the dialog closes, so it never lingers as an
  // orphaned floating element and always re-anchors fresh on the next open.
  useEffect(() => {
    if (!portal) {
      setPickerOpen(false);
    }
  }, [portal]);

  // Load current members whenever a portal is opened.
  useEffect(() => {
    if (!portal) return;
    let cancelled = false;
    setLoading(true);
    setSelected(new Map());
    setQuery("");
    setResults([]);
    setFilterCountry("");
    setFilterType("");
    (async () => {
      try {
        const res = await customFetch<MembersResponse>(
          `/api/portal-automation/accounts/${encodeURIComponent(portal.universityKey)}/members`,
        );
        if (!cancelled) {
          setSelected(
            new Map(res.members.map((m) => [m.catalogUniversityId, m.universityName])),
          );
        }
      } catch {
        if (!cancelled) {
          toast({ title: t("portalAutomation.members.loadError"), variant: "destructive" });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [portal, t, toast]);

  // Debounced catalog search. Fetch the FULL matching catalog (not a capped
  // first page): the server caps pageSize at 100, so we loop pages until a short
  // page signals the end and accumulate. searchRunRef makes any in-flight
  // multi-page run cancellable when the query/filters change under it.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRunRef = useRef(0);
  useEffect(() => {
    if (!portal) return;
    // Invalidate any in-flight run IMMEDIATELY (not only when the next debounce
    // fires) so a still-running multi-page fetch from a stale query/filter can
    // never call setResults after the inputs have changed under it.
    const runId = ++searchRunRef.current;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setSearching(true);
      (async () => {
        const PAGE = 100;
        const MAX_PAGES = 50; // hard safety ceiling (≤ 5000 universities)
        const acc: CatalogUniversity[] = [];
        try {
          for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
            const params = new URLSearchParams({
              pageSize: String(PAGE),
              page: String(pageNo),
            });
            if (query.trim()) params.set("q", query.trim());
            if (filterCountry) params.set("country", filterCountry);
            if (filterType) params.set("type", filterType);
            const res = await customFetch<{ data: CatalogUniversity[] }>(
              `/api/portal-automation/catalog-universities?${params.toString()}`,
            );
            if (searchRunRef.current !== runId) return; // superseded
            acc.push(...res.data);
            if (res.data.length < PAGE) break; // last page reached
          }
          if (searchRunRef.current === runId) setResults(acc);
        } catch {
          if (searchRunRef.current === runId) setResults([]);
        } finally {
          if (searchRunRef.current === runId) setSearching(false);
        }
      })();
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, portal, filterCountry, filterType]);

  // Load distinct country + type filter options once a portal opens.
  useEffect(() => {
    if (!portal) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await customFetch<CatalogFilters>(
          `/api/portal-automation/catalog-university-filters`,
        );
        if (!cancelled) setFilterOptions(res);
      } catch {
        if (!cancelled) setFilterOptions({ countries: [], types: [] });
      }
    })();
    return () => { cancelled = true; };
  }, [portal]);

  const toggle = (uni: CatalogUniversity) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(uni.id)) next.delete(uni.id);
      else next.set(uni.id, uni.name);
      return next;
    });
  };

  const removeMember = (id: number) => {
    setSelected((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  };

  const persist = async (force: boolean): Promise<void> => {
    if (!portal) return;
    setSaving(true);
    try {
      await customFetch<MembersResponse>(
        `/api/portal-automation/accounts/${encodeURIComponent(portal.universityKey)}/members`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            catalogUniversityIds: Array.from(selected.keys()),
            force,
          }),
        },
      );
      toast({ title: t("portalAutomation.members.saveSuccess") });
      setConflictMessage(null);
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // A selected school belongs to another account — ask to force-move.
        const data = err.data as { message?: string } | null;
        setConflictMessage(data?.message ?? t("portalAutomation.members.conflictBody"));
        return;
      }
      toast({ title: t("portalAutomation.members.saveError"), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const selectedList = useMemo(
    () => Array.from(selected.entries()).map(([id, name]) => ({ id, name })),
    [selected],
  );

  return (
    <>
      <Dialog open={!!portal} onOpenChange={(o) => { if (!o) onClose(); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Network className="w-4 h-4" />
              {t("portalAutomation.members.title")}
              {portal && (
                <span className="text-sm font-normal text-muted-foreground">
                  — {portal.universityName}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-3 py-1">
            <p className="text-sm text-muted-foreground">
              {t("portalAutomation.members.description")}
            </p>

            {loading ? (
              <div className="space-y-2">
                {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-8 w-full rounded-md" />)}
              </div>
            ) : (
              <>
                {/* Catalog multi-select (server-side search, inline picker) */}
                <div className="relative">
                  <button
                    ref={triggerRef}
                    type="button"
                    onClick={togglePicker}
                    className="flex w-full items-center justify-between h-10 px-3 rounded-md border border-input bg-background text-sm hover:bg-accent/30 transition-colors"
                  >
                    <span className="text-muted-foreground">
                      {t("portalAutomation.members.addMembers")}
                    </span>
                    <ChevronDown
                      className={`w-4 h-4 text-muted-foreground transition-transform ${pickerOpen ? "rotate-180" : ""}`}
                    />
                  </button>

                  {pickerOpen && (
                    <div
                      ref={popRef}
                      style={{ maxHeight: placement.maxH }}
                      className={`absolute left-0 right-0 z-50 flex flex-col ${placement.up ? "bottom-full mb-1" : "top-full mt-1"} bg-popover border border-border rounded-md shadow-lg overflow-hidden animate-in fade-in-0 zoom-in-95`}
                    >
                      <div className="p-2 border-b border-border space-y-2 shrink-0">
                        <input
                          ref={searchInputRef}
                          type="text"
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                          placeholder={t("portalAutomation.members.searchPlaceholder")}
                          className="w-full h-8 px-2 text-sm rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                        <div className="flex gap-2">
                          <select
                            value={filterCountry}
                            onChange={(e) => setFilterCountry(e.target.value)}
                            className="flex-1 h-8 px-2 text-xs rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                          >
                            <option value="">{t("portalAutomation.members.allCountries")}</option>
                            {filterOptions.countries.map((c) => (
                              <option key={c} value={c}>{c}</option>
                            ))}
                          </select>
                          <select
                            value={filterType}
                            onChange={(e) => setFilterType(e.target.value)}
                            className="flex-1 h-8 px-2 text-xs rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                          >
                            <option value="">{t("portalAutomation.members.allTypes")}</option>
                            {filterOptions.types.map((ty) => (
                              <option key={ty} value={ty}>{ty}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div className="flex-1 min-h-0 overflow-y-auto p-1">
                        {searching ? (
                          <div className="py-4 flex justify-center">
                            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                          </div>
                        ) : results.length === 0 ? (
                          <div className="px-3 py-3 text-xs text-muted-foreground text-center">
                            {t("portalAutomation.members.noCandidates")}
                          </div>
                        ) : (
                          results.map((c) => {
                            const isSelected = selected.has(c.id);
                            return (
                              <button
                                key={c.id}
                                type="button"
                                onClick={() => toggle(c)}
                                className={`flex items-center w-full px-2.5 py-2 text-sm rounded-md transition-colors text-left ${
                                  isSelected ? "bg-primary/10" : "hover:bg-primary/10"
                                }`}
                              >
                                <Check
                                  className={`mr-2 h-4 w-4 shrink-0 ${isSelected ? "opacity-100 text-primary" : "opacity-0"}`}
                                />
                                <span className="font-medium flex-1 truncate">{c.name}</span>
                                <span className="ml-2 text-xs text-muted-foreground shrink-0">
                                  {c.country}
                                </span>
                              </button>
                            );
                          })
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Selected members */}
                <div className="min-h-[60px] rounded-lg border p-2">
                  {selectedList.length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-3">
                      {t("portalAutomation.members.noMembers")}
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {selectedList.map((m) => (
                        <Badge key={m.id} variant="secondary" className="gap-1 pr-1">
                          {m.name}
                          <button
                            type="button"
                            onClick={() => removeMember(m.id)}
                            className="ml-0.5 rounded-sm hover:bg-muted-foreground/20"
                            aria-label={t("common.remove")}
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => persist(false)} disabled={saving || loading}>
              {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {saving
                ? t("portalAutomation.members.saving")
                : t("portalAutomation.members.saveButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 409 force-move confirmation */}
      <AlertDialog
        open={conflictMessage !== null}
        onOpenChange={(o) => { if (!o) setConflictMessage(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("portalAutomation.members.conflictTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{conflictMessage}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => persist(true)} disabled={saving}>
              {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {t("portalAutomation.members.forceMove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
