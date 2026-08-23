import { useMemo, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { FileText, Search, Plus, X, Check, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { saveStageDocRequests, type StageDocRequestItem } from "@/lib/stageTransition";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

interface CatalogOption {
  value: string;
  label: string;
}

interface CustomItem {
  id: string;
  title: string;
  note: string;
}

interface StageDocRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applicationId: number;
  stage: string;
  stageLabel: string;
  suggestedDocTypes?: string[];
  title?: string | null;
  /** Called after requests are saved successfully. Caller retries the move. */
  onSaved: () => void;
}

/**
 * Task #269 — Modern per-application document-request modal. Opened when an
 * application is moved INTO a stage that has the "Belge Yükle" (missing_docs)
 * action. Staff multi-select catalog documents (pre-checked from the action's
 * configured requiredDocTypes) and/or add custom free-text requests, with an
 * optional note each. On save, the requests persist for this application+stage
 * and the caller completes the stage move.
 */
export function StageDocRequestDialog({
  open, onOpenChange, applicationId, stage, stageLabel, suggestedDocTypes, title, onSaved,
}: StageDocRequestDialogProps) {
  const { t } = useI18n();
  const { toast } = useToast();

  const { data: catalogResp } = useQuery<any>({
    queryKey: ["catalog-options"],
    queryFn: () => customFetch(`${BASE_URL}/api/catalog-options`),
    staleTime: 5 * 60_000,
    enabled: open,
  });

  const catalogOptions: CatalogOption[] = useMemo(() => {
    const grouped = (catalogResp as any)?.grouped || {};
    const rows: any[] = grouped["documents"] || [];
    return rows
      .filter((r: any) => r.isActive !== false)
      .map((r: any) => {
        const md = r.metadata || {};
        const label = (typeof md.label === "string" && md.label.trim())
          ? md.label.trim()
          : String(r.value).replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
        return { value: r.value, label };
      });
  }, [catalogResp]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [customItems, setCustomItems] = useState<CustomItem[]>([]);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);

  // Seed selection from the action's configured requiredDocTypes each time the
  // dialog opens for a new stage.
  useEffect(() => {
    if (open) {
      const seed = Array.isArray(suggestedDocTypes) ? suggestedDocTypes.filter(Boolean) : [];
      setSelected(new Set(seed));
      setNotes({});
      setCustomItems([]);
      setSearch("");
    }
  }, [open, stage, suggestedDocTypes]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return catalogOptions;
    return catalogOptions.filter(o => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q));
  }, [catalogOptions, search]);

  function toggle(value: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value); else next.add(value);
      return next;
    });
  }

  const totalCount = selected.size + customItems.filter(c => c.title.trim()).length;

  async function handleSave() {
    const items: StageDocRequestItem[] = [];
    for (const value of selected) {
      const note = (notes[value] || "").trim();
      items.push({ documentType: value, note: note || undefined });
    }
    for (const c of customItems) {
      const title = c.title.trim();
      if (title) items.push({ customTitle: title, note: c.note.trim() || undefined });
    }
    if (items.length === 0) {
      toast({ title: t("stageDocRequest.atLeastOne"), variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await saveStageDocRequests(applicationId, stage, items);
      onSaved();
    } catch (err: any) {
      toast({ title: t("stageDocRequest.saveFailed"), description: err?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!saving) onOpenChange(o); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-primary" />
            {title || t("stageDocRequest.title")}
          </DialogTitle>
          <DialogDescription>
            {t("stageDocRequest.subtitle", { stage: stageLabel })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("stageDocRequest.searchPlaceholder")}
              className="pl-8 h-9"
              disabled={saving}
            />
          </div>

          <div className="max-h-[300px] overflow-y-auto pr-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground col-span-full py-4 text-center">
                {t("stageDocRequest.noCatalog")}
              </p>
            ) : filtered.map((opt) => {
              const isOn = selected.has(opt.value);
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => toggle(opt.value)}
                  disabled={saving}
                  className={`flex items-start gap-2 text-left rounded-lg border p-2.5 transition-colors ${
                    isOn ? "border-primary bg-primary/5" : "hover:bg-muted/40"
                  }`}
                >
                  <Checkbox checked={isOn} className="mt-0.5 pointer-events-none" />
                  <span className="text-sm font-medium leading-tight">{opt.label}</span>
                </button>
              );
            })}
          </div>

          {selected.size > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground">{t("stageDocRequest.selectedNotes")}</p>
              <div className="space-y-1.5 max-h-[140px] overflow-y-auto pr-1">
                {Array.from(selected).map((value) => {
                  const opt = catalogOptions.find(o => o.value === value);
                  return (
                    <div key={value} className="flex items-center gap-2">
                      <Badge variant="outline" className="shrink-0 text-[10px]">{opt?.label || value}</Badge>
                      <Input
                        value={notes[value] || ""}
                        onChange={(e) => setNotes(prev => ({ ...prev, [value]: e.target.value }))}
                        placeholder={t("stageDocRequest.notePlaceholder")}
                        className="h-7 text-xs"
                        disabled={saving}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {customItems.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground">{t("stageDocRequest.customDocs")}</p>
              {customItems.map((c, idx) => (
                <div key={c.id} className="flex items-center gap-2">
                  <Badge variant="secondary" className="shrink-0 text-[10px]">{t("stageDocRequest.customBadge")}</Badge>
                  <Input
                    value={c.title}
                    onChange={(e) => setCustomItems(prev => prev.map((p, i) => i === idx ? { ...p, title: e.target.value } : p))}
                    placeholder={t("stageDocRequest.customNamePlaceholder")}
                    className="h-8 text-sm"
                    disabled={saving}
                  />
                  <Input
                    value={c.note}
                    onChange={(e) => setCustomItems(prev => prev.map((p, i) => i === idx ? { ...p, note: e.target.value } : p))}
                    placeholder={t("stageDocRequest.notePlaceholder")}
                    className="h-8 text-xs"
                    disabled={saving}
                  />
                  <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => setCustomItems(prev => prev.filter((_, i) => i !== idx))} disabled={saving}>
                    <X className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <Button
            type="button" variant="outline" size="sm" className="gap-1.5"
            onClick={() => setCustomItems(prev => [...prev, { id: `c${Date.now()}`, title: "", note: "" }])}
            disabled={saving}
          >
            <Plus className="w-3.5 h-3.5" /> {t("stageDocRequest.addCustom")}
          </Button>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={saving || totalCount === 0} className="gap-1.5">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            {saving ? t("stageDocRequest.saving") : t("stageDocRequest.saveAndMove", { count: totalCount })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
