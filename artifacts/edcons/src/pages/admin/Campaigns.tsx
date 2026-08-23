import { useEffect, useMemo, useState } from "react";
import { customFetch, ApiError } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { Megaphone, Plus, Pencil, Archive, RotateCcw, Building2, Globe2, Loader2, Search, Calendar as CalendarIcon, Percent, ChevronDown } from "lucide-react";

type Status = "active" | "scheduled" | "expired" | "disabled" | "archived";
type ChangeType = "discount" | "markup";

interface Campaign {
  id: number;
  name: string;
  description: string | null;
  changeType: ChangeType;
  changePercent: number;
  startDate: string;
  endDate: string;
  universityIds: number[];
  agentCountries: string[];
  isActive: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  status: Status;
}

interface UniversityOption {
  id: number;
  name: string;
  country: string;
}

const STATUS_VARIANT: Record<Status, { label: string; cls: string }> = {
  active:    { label: "Active",    cls: "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30" },
  scheduled: { label: "Scheduled", cls: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30" },
  expired:   { label: "Expired",   cls: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-400 border-zinc-500/30" },
  disabled:  { label: "Disabled",  cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30" },
  archived:  { label: "Archived",  cls: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-400 border-zinc-500/30" },
};

function toastApiError(toast: ReturnType<typeof useToast>["toast"], err: unknown, fallback: string) {
  if (err instanceof ApiError) {
    if (err.status === 401) return;
    const data = err.data as { error?: string; message?: string } | null;
    toast({ title: fallback, description: data?.error || data?.message || err.message, variant: "destructive" });
    return;
  }
  if (err instanceof Error) {
    toast({ title: fallback, description: err.message, variant: "destructive" });
    return;
  }
  toast({ title: fallback, variant: "destructive" });
}

export default function CampaignsPage() {
  const { t } = useI18n();
  const { toast } = useToast();
  const [showArchived, setShowArchived] = useState(false);
  const [items, setItems] = useState<Campaign[]>([]);
  const [universities, setUniversities] = useState<UniversityOption[]>([]);
  const [agentCountries, setAgentCountries] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  const [search, setSearch] = useState("");

  async function loadAll() {
    setLoading(true);
    try {
      const [list, uniRes, ctyRes] = await Promise.all([
        customFetch<{ data: Campaign[] }>(`/api/campaigns?archived=${showArchived ? "true" : "false"}`),
        customFetch<{ data: UniversityOption[] }>(`/api/campaigns/universities`),
        customFetch<{ data: string[] }>(`/api/campaigns/agent-countries`),
      ]);
      setItems(list.data || []);
      setUniversities(uniRes.data || []);
      setAgentCountries(ctyRes.data || []);
    } catch (err) {
      toastApiError(toast, err, t("campaigns.loadFailed"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadAll(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [showArchived]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(c =>
      c.name.toLowerCase().includes(q)
      || (c.description || "").toLowerCase().includes(q)
    );
  }, [items, search]);

  function openCreate() {
    setEditing(null);
    setShowDialog(true);
  }

  function openEdit(c: Campaign) {
    setEditing(c);
    setShowDialog(true);
  }

  async function archive(c: Campaign) {
    if (!confirm(t("campaigns.archiveConfirm", { name: c.name }))) return;
    try {
      await customFetch(`/api/campaigns/${c.id}`, { method: "DELETE" });
      toast({ title: t("campaigns.archived") });
      await loadAll();
    } catch (err) {
      toastApiError(toast, err, t("campaigns.archiveFailed"));
    }
  }

  async function restore(c: Campaign) {
    try {
      await customFetch(`/api/campaigns/${c.id}/restore`, { method: "POST" });
      toast({ title: t("campaigns.restored") });
      await loadAll();
    } catch (err) {
      toastApiError(toast, err, t("campaigns.restoreFailed"));
    }
  }

  async function toggleActive(c: Campaign, next: boolean) {
    try {
      await customFetch(`/api/campaigns/${c.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isActive: next }),
      });
      await loadAll();
    } catch (err) {
      toastApiError(toast, err, t("campaigns.updateFailed"));
    }
  }

  return (
    <div className="p-4 md:p-6 max-w-[1400px] mx-auto" data-testid="page-campaigns">
      <div className="flex items-start justify-between gap-4 mb-5 flex-wrap">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
            <Megaphone className="w-6 h-6 text-primary" />
            {t("campaigns.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t("campaigns.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Tabs value={showArchived ? "archived" : "active"} onValueChange={(v) => setShowArchived(v === "archived")}>
            <TabsList>
              <TabsTrigger value="active" data-testid="tab-active">{t("campaigns.tabs.active")}</TabsTrigger>
              <TabsTrigger value="archived" data-testid="tab-archived">{t("campaigns.tabs.archived")}</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button onClick={openCreate} disabled={showArchived} data-testid="button-new-campaign">
            <Plus className="w-4 h-4 mr-1.5" />
            {t("campaigns.newCampaign")}
          </Button>
        </div>
      </div>

      <div className="mb-4 relative max-w-md">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={t("campaigns.searchPlaceholder")}
          className="pl-9"
          data-testid="input-search"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Megaphone className="w-10 h-10 mx-auto mb-3 text-muted-foreground/40" />
            <p className="font-medium">{showArchived ? t("campaigns.noneArchived") : t("campaigns.none")}</p>
            {!showArchived && (
              <Button className="mt-4" onClick={openCreate}>
                <Plus className="w-4 h-4 mr-1.5" /> {t("campaigns.createFirst")}
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(c => {
            const v = STATUS_VARIANT[c.status];
            const sign = c.changeType === "markup" ? "+" : "−";
            return (
              <Card key={c.id} className="overflow-hidden" data-testid={`campaign-card-${c.id}`}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base leading-snug break-words">{c.name}</CardTitle>
                    <Badge variant="outline" className={`text-[10px] ${v.cls}`}>{t(`campaigns.status.${c.status}`)}</Badge>
                  </div>
                  {c.description && <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{c.description}</p>}
                </CardHeader>
                <CardContent className="space-y-2.5 text-sm">
                  <div className="flex items-center gap-2">
                    <Percent className={`w-4 h-4 ${c.changeType === "markup" ? "text-amber-600" : "text-emerald-600"}`} />
                    <span className={`font-bold text-lg ${c.changeType === "markup" ? "text-amber-700 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400"}`}>
                      {sign}{c.changePercent}%
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t(`campaigns.type.${c.changeType}`)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <CalendarIcon className="w-3.5 h-3.5" />
                    {c.startDate} → {c.endDate}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Building2 className="w-3.5 h-3.5" />
                    {t("campaigns.universitiesCount", { count: c.universityIds.length })}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Globe2 className="w-3.5 h-3.5" />
                    {c.agentCountries.length === 0
                      ? t("campaigns.allAgents")
                      : t("campaigns.countriesCount", { count: c.agentCountries.length })}
                  </div>
                  <div className="flex items-center justify-between pt-2 border-t">
                    {c.archivedAt ? (
                      <Button size="sm" variant="ghost" onClick={() => restore(c)} data-testid={`button-restore-${c.id}`}>
                        <RotateCcw className="w-3.5 h-3.5 mr-1" /> {t("campaigns.restore")}
                      </Button>
                    ) : (
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={c.isActive}
                          onCheckedChange={(v) => toggleActive(c, v)}
                          data-testid={`switch-active-${c.id}`}
                        />
                        <span className="text-xs text-muted-foreground">{c.isActive ? t("campaigns.enabled") : t("campaigns.disabled")}</span>
                      </div>
                    )}
                    {!c.archivedAt && (
                      <div className="flex items-center gap-1">
                        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEdit(c)} data-testid={`button-edit-${c.id}`}>
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => archive(c)} data-testid={`button-archive-${c.id}`}>
                          <Archive className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {showDialog && (
        <CampaignDialog
          existing={editing}
          universities={universities}
          agentCountries={agentCountries}
          onClose={() => setShowDialog(false)}
          onSaved={async () => { setShowDialog(false); await loadAll(); }}
        />
      )}
    </div>
  );
}

function CampaignDialog({
  existing,
  universities,
  agentCountries,
  onClose,
  onSaved,
}: {
  existing: Campaign | null;
  universities: UniversityOption[];
  agentCountries: string[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [name, setName] = useState(existing?.name || "");
  const [description, setDescription] = useState(existing?.description || "");
  const [changeType, setChangeType] = useState<ChangeType>(existing?.changeType || "discount");
  const [changePercent, setChangePercent] = useState<string>(existing ? String(existing.changePercent) : "10");
  const [startDate, setStartDate] = useState(existing?.startDate || "");
  const [endDate, setEndDate] = useState(existing?.endDate || "");
  const [selectedUnis, setSelectedUnis] = useState<Set<number>>(new Set(existing?.universityIds || []));
  const [selectedCountries, setSelectedCountries] = useState<Set<string>>(new Set(existing?.agentCountries || []));
  const [isActive, setIsActive] = useState<boolean>(existing?.isActive ?? true);
  const [saving, setSaving] = useState(false);

  async function save() {
    const pct = Number(changePercent);
    if (!name.trim()) { toast({ title: t("campaigns.errors.nameRequired"), variant: "destructive" }); return; }
    if (isNaN(pct) || pct <= 0 || pct > 100) { toast({ title: t("campaigns.errors.percentRange"), variant: "destructive" }); return; }
    if (!startDate || !endDate) { toast({ title: t("campaigns.errors.datesRequired"), variant: "destructive" }); return; }
    if (startDate > endDate) { toast({ title: t("campaigns.errors.dateOrder"), variant: "destructive" }); return; }
    if (selectedUnis.size === 0) { toast({ title: t("campaigns.errors.uniRequired"), variant: "destructive" }); return; }

    const payload = {
      name: name.trim(),
      description: description.trim(),
      changeType,
      changePercent: pct,
      startDate,
      endDate,
      universityIds: Array.from(selectedUnis),
      agentCountries: Array.from(selectedCountries),
      isActive,
    };

    setSaving(true);
    try {
      if (existing) {
        await customFetch(`/api/campaigns/${existing.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        toast({ title: t("campaigns.updated") });
      } else {
        await customFetch(`/api/campaigns`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        toast({ title: t("campaigns.created") });
      }
      await onSaved();
    } catch (err) {
      toastApiError(toast, err, existing ? t("campaigns.updateFailed") : t("campaigns.createFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={true} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="dialog-campaign">
        <DialogHeader>
          <DialogTitle>{existing ? t("campaigns.editTitle") : t("campaigns.createTitle")}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-2">
          <div className="md:col-span-2">
            <Label htmlFor="cf-name">{t("campaigns.fields.name")} *</Label>
            <Input id="cf-name" value={name} onChange={e => setName(e.target.value)} placeholder={t("campaigns.fields.namePlaceholder")} data-testid="input-name" />
          </div>
          <div className="md:col-span-2">
            <Label htmlFor="cf-desc">{t("campaigns.fields.description")}</Label>
            <Textarea id="cf-desc" value={description} onChange={e => setDescription(e.target.value)} rows={2} data-testid="input-description" />
          </div>
          <div>
            <Label>{t("campaigns.fields.type")} *</Label>
            <Select value={changeType} onValueChange={(v) => setChangeType(v as ChangeType)}>
              <SelectTrigger data-testid="select-type"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="discount">{t("campaigns.type.discount")}</SelectItem>
                <SelectItem value="markup">{t("campaigns.type.markup")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="cf-pct">{t("campaigns.fields.percent")} (%) *</Label>
            <Input id="cf-pct" type="number" min={0.01} max={100} step={0.01} value={changePercent} onChange={e => setChangePercent(e.target.value)} data-testid="input-percent" />
          </div>
          <div>
            <Label htmlFor="cf-start">{t("campaigns.fields.startDate")} *</Label>
            <Input id="cf-start" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} data-testid="input-start-date" />
          </div>
          <div>
            <Label htmlFor="cf-end">{t("campaigns.fields.endDate")} *</Label>
            <Input id="cf-end" type="date" value={endDate} onChange={e => setEndDate(e.target.value)} data-testid="input-end-date" />
          </div>
          <div className="md:col-span-2">
            <Label>{t("campaigns.fields.universities")} *</Label>
            <UniversityPicker
              universities={universities}
              selected={selectedUnis}
              onChange={setSelectedUnis}
            />
            <p className="text-xs text-muted-foreground mt-1">
              {t("campaigns.universitiesCount", { count: selectedUnis.size })}
            </p>
          </div>
          <div className="md:col-span-2">
            <Label>{t("campaigns.fields.agentCountries")}</Label>
            <CountryPicker
              countries={agentCountries}
              selected={selectedCountries}
              onChange={setSelectedCountries}
            />
            <p className="text-xs text-muted-foreground mt-1">
              {selectedCountries.size === 0
                ? t("campaigns.allAgentsHint")
                : t("campaigns.countriesCount", { count: selectedCountries.size })}
            </p>
          </div>
          <div className="md:col-span-2 flex items-center gap-2 pt-2 border-t">
            <Switch checked={isActive} onCheckedChange={setIsActive} data-testid="switch-active" />
            <span className="text-sm">{isActive ? t("campaigns.enabled") : t("campaigns.disabled")}</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>{t("common.cancel")}</Button>
          <Button onClick={save} disabled={saving} data-testid="button-save">
            {saving && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UniversityPicker({
  universities,
  selected,
  onChange,
}: {
  universities: UniversityOption[];
  selected: Set<number>;
  onChange: (next: Set<number>) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const filtered = ql
      ? universities.filter(u => u.name.toLowerCase().includes(ql) || (u.country || "").toLowerCase().includes(ql))
      : universities;
    const map = new Map<string, UniversityOption[]>();
    for (const u of filtered) {
      const k = u.country || "—";
      const arr = map.get(k) || [];
      arr.push(u);
      map.set(k, arr);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [universities, q]);

  function toggle(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange(next);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="w-full justify-between" data-testid="button-pick-universities">
          <span className="truncate">
            {selected.size === 0 ? t("campaigns.fields.universitiesPlaceholder") : t("campaigns.universitiesCount", { count: selected.size })}
          </span>
          <ChevronDown className="w-4 h-4 opacity-50 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[420px] p-0" align="start">
        <div className="p-2 border-b">
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder={t("campaigns.searchUniversities")} className="h-8" />
        </div>
        <ScrollArea className="h-[320px]">
          <div className="p-2 space-y-3">
            {groups.length === 0 ? (
              <p className="text-sm text-muted-foreground p-2">{t("campaigns.noUniversities")}</p>
            ) : groups.map(([country, list]) => (
              <div key={country}>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-1 mb-1">{country}</p>
                <div className="space-y-1">
                  {list.map(u => (
                    <label key={u.id} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted cursor-pointer">
                      <Checkbox checked={selected.has(u.id)} onCheckedChange={() => toggle(u.id)} data-testid={`uni-checkbox-${u.id}`} />
                      <span className="text-sm flex-1 truncate">{u.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
        <div className="p-2 border-t flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={() => onChange(new Set())}>{t("campaigns.clearAll")}</Button>
          <Button size="sm" onClick={() => setOpen(false)}>{t("common.done")}</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function CountryPicker({
  countries,
  selected,
  onChange,
}: {
  countries: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return ql ? countries.filter(c => c.toLowerCase().includes(ql)) : countries;
  }, [countries, q]);

  function toggle(c: string) {
    const next = new Set(selected);
    if (next.has(c)) next.delete(c); else next.add(c);
    onChange(next);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="w-full justify-between" data-testid="button-pick-countries">
          <span className="truncate">
            {selected.size === 0 ? t("campaigns.fields.agentCountriesPlaceholder") : t("campaigns.countriesCount", { count: selected.size })}
          </span>
          <ChevronDown className="w-4 h-4 opacity-50 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[360px] p-0" align="start">
        <div className="p-2 border-b">
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder={t("campaigns.searchCountries")} className="h-8" />
        </div>
        <ScrollArea className="h-[280px]">
          <div className="p-2 space-y-1">
            {filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground p-2">{t("campaigns.noCountries")}</p>
            ) : filtered.map(c => (
              <label key={c} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted cursor-pointer">
                <Checkbox checked={selected.has(c)} onCheckedChange={() => toggle(c)} data-testid={`cty-checkbox-${c.replace(/\s+/g, "-").toLowerCase()}`} />
                <span className="text-sm flex-1 truncate">{c}</span>
              </label>
            ))}
          </div>
        </ScrollArea>
        <div className="p-2 border-t flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={() => onChange(new Set())}>{t("campaigns.clearAll")}</Button>
          <Button size="sm" onClick={() => setOpen(false)}>{t("common.done")}</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
