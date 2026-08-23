import React, { useState, useEffect, useMemo, useRef } from "react";
import { useLocation } from "wouter";
import { toLatinUpper, digitsOnly } from "@/lib/textTransform";
import { useListLeads, useUpdateLead, useDeleteLead, customFetch } from "@workspace/api-client-react";
import { useSeason } from "@/contexts/SeasonContext";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import {
  Plus, Search, Filter, Eye, TrendingUp, X,
  ChevronDown, GripVertical, Check, Trophy, XCircle, LayoutGrid, List,
  ArrowUpDown, ArrowUp, ArrowDown, Trash2, Pencil, Download,
} from "lucide-react";
import { TablePagination, useTablePagination } from "@/components/TablePagination";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PhoneCodePicker } from "@/components/ui/phone-code-picker";
import { Badge } from "@/components/ui/badge";
import { CountryFlag } from "@/components/CountryFlag";
import { useCountrySearch } from "@/hooks/use-countries";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { usePipelineStages, type PipelineStage } from "@/hooks/use-pipeline-stages";
import { useI18n } from "@/hooks/use-i18n";
import { CreateLeadDialog } from "@/components/agent/CreateLeadDialog";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

async function apiFetch(url: string) {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

type CountryRecord = { id: number; name: string; code: string; flagEmoji?: string; isActive: boolean };

function useCountries() {
  return useQuery<CountryRecord[]>({
    queryKey: ["countries-all"],
    queryFn: async () => {
      const res = await apiFetch(`${BASE_URL}/api/countries?limit=500`);
      return res.data ?? res;
    },
    staleTime: 5 * 60_000,
  });
}

const SOURCES = ["website", "referral", "social_media", "walk_in", "partner", "other"];

type ColVariant = "default" | "won" | "lost";

interface ColDef {
  id: string;
  title: string;
  variant?: ColVariant;
}

const VIEW_KEY = "edcons_leads_view";

function formatCurrency(value: number | string | null | undefined): string {
  const num = typeof value === "string" ? parseFloat(value) : (value ?? 0);
  if (!num || isNaN(num)) return "";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(num);
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "-";
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const LEAD_STAGE_COLORS = [
  "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-700/60",
  "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700/60",
  "bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-900/40 dark:text-purple-300 dark:border-purple-700/60",
  "bg-cyan-100 text-cyan-700 border-cyan-200 dark:bg-cyan-900/40 dark:text-cyan-300 dark:border-cyan-700/60",
  "bg-indigo-100 text-indigo-700 border-indigo-200 dark:bg-indigo-900/40 dark:text-indigo-300 dark:border-indigo-700/60",
  "bg-teal-100 text-teal-700 border-teal-200 dark:bg-teal-900/40 dark:text-teal-300 dark:border-teal-700/60",
  "bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-900/40 dark:text-orange-300 dark:border-orange-700/60",
];
const LEAD_WON_COLOR = "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-700/60";
const LEAD_LOST_COLOR = "bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-900/40 dark:text-rose-300 dark:border-rose-700/60";

function getLeadStageColor(stage: PipelineStage, index: number): string {
  if (stage.variant === "won") return LEAD_WON_COLOR;
  if (stage.variant === "lost") return LEAD_LOST_COLOR;
  return LEAD_STAGE_COLORS[index % LEAD_STAGE_COLORS.length];
}

/* ── Lazy IntersectionObserver hook ───────────────────────── */
function useInView(rootMargin = "200px") {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") { setInView(true); return; }
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setInView(true); obs.disconnect(); } },
      { threshold: 0, rootMargin },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [rootMargin]);
  return { ref, inView };
}

/* ── LeadAvatar ────────────────────────────────────────────── */
function LeadAvatar({ lead, size = "sm" }: { lead: any; size?: "sm" | "md" }) {
  const dim = size === "md" ? "w-10 h-10" : "w-8 h-8";
  const textSize = size === "md" ? "text-sm" : "text-xs";
  const [imgError, setImgError] = useState(false);
  const { ref, inView } = useInView();

  const showPhoto = !!(lead.convertedStudentId && lead.convertedStudentHasPhoto && !imgError && inView);

  return (
    <div ref={ref} className={`${dim} rounded-full shrink-0 overflow-hidden`}>
      {showPhoto ? (
        <img
          src={lead.convertedStudentPhotoUrl || `${BASE_URL}/api/students/${lead.convertedStudentId}/photo/thumbnail`}
          alt={`${lead.firstName} ${lead.lastName}`}
          className={`${dim} rounded-full object-cover border border-primary/20`}
          onError={() => setImgError(true)}
        />
      ) : (
        <div className={`${dim} rounded-full bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center`}>
          <span className={`${textSize} font-bold text-primary`}>{lead.firstName?.[0]}{lead.lastName?.[0]}</span>
        </div>
      )}
    </div>
  );
}

/* ── LeadCard ──────────────────────────────────────────────── */
function LeadCard({ lead, onView, showRevenue, variant }: {
  lead: any; onView: (id: number) => void; showRevenue: boolean; variant?: ColVariant;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: lead.id });
  const style = { transform: CSS.Transform.toString(transform), transition };

  const cardBg =
    variant === "won" ? "bg-emerald-50 border-emerald-200 hover:border-emerald-300 dark:bg-emerald-900/20 dark:border-emerald-700/50 dark:hover:border-emerald-600" :
    variant === "lost" ? "bg-rose-50 border-rose-200 hover:border-rose-300 dark:bg-rose-900/20 dark:border-rose-700/50 dark:hover:border-rose-600" :
    "bg-card border-border hover:shadow-md";

  return (
    <>
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-xl border ${
        isDragging ? "border-primary shadow-xl opacity-50 z-50 relative" : cardBg
      } mb-3 transition-shadow duration-200`}
    >
      <div {...attributes} {...listeners} className={`p-4 pb-2 ${isDragging ? "cursor-grabbing" : "cursor-grab"}`}>
        <div className="flex items-start gap-2 mb-2">
          <LeadAvatar lead={lead} />
          <div className="flex-1 min-w-0 flex justify-between items-start gap-1">
            <h4 className="font-bold text-sm text-foreground line-clamp-1">
              {lead.firstName} {lead.lastName}
            </h4>
            {lead.source && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground font-medium shrink-0">
                {lead.source}
              </span>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground truncate">{lead.email || lead.phone || "No contact info"}</p>
        {lead.interestedProgram && (
          <p className="text-xs font-medium text-primary mt-2 truncate bg-primary/5 block max-w-full px-2 py-1 rounded-md">
            {lead.interestedProgram}
          </p>
        )}
        {showRevenue && lead.estimatedValue && parseFloat(lead.estimatedValue) > 0 && (
          <div className="mt-2 flex items-center gap-1">
            <TrendingUp className="w-3 h-3 text-emerald-500" />
            <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">
              {formatCurrency(lead.estimatedValue)}
            </span>
          </div>
        )}
      </div>
      <div className="px-4 pb-3 flex justify-end">
        <button
          onClick={() => onView(lead.id)}
          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary transition-colors"
        >
          <Eye className="w-3 h-3" /> View
        </button>
      </div>
    </div>
    </>
  );
}

/* ── DroppableColumn ──────────────────────────────────────── */
function DroppableColumn({ col, leads, showRevenue, onView }: {
  col: ColDef; leads: any[]; showRevenue: boolean; onView: (id: number) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: col.id });
  const totalRevenue = showRevenue ? leads.reduce((sum, l) => sum + (parseFloat(l.estimatedValue) || 0), 0) : 0;
  const v = col.variant ?? "default";

  const headerBg =
    v === "won" ? "bg-emerald-100/80 border-emerald-200/70 dark:bg-emerald-900/30 dark:border-emerald-700/40" :
    v === "lost" ? "bg-rose-100/80 border-rose-200/70 dark:bg-rose-900/30 dark:border-rose-700/40" :
    "bg-card/50 border-border/50";

  const colBg =
    v === "won" ? "bg-emerald-50/60 border-emerald-200/50 dark:bg-emerald-900/15 dark:border-emerald-700/30" :
    v === "lost" ? "bg-rose-50/60 border-rose-200/50 dark:bg-rose-900/15 dark:border-rose-700/30" :
    "bg-secondary/50 border-border/50";

  const dropBg =
    v === "won" ? (isOver ? "bg-emerald-100/60 dark:bg-emerald-900/25" : "") :
    v === "lost" ? (isOver ? "bg-rose-100/60 dark:bg-rose-900/25" : "") :
    (isOver ? "bg-primary/5" : "");

  const badgeBg =
    v === "won" ? "bg-emerald-200/60 text-emerald-800 border-emerald-300/50" :
    v === "lost" ? "bg-rose-200/60 text-rose-800 border-rose-300/50" :
    "bg-background text-muted-foreground border shadow-sm";

  const emptyBorder =
    v === "won" ? "border-emerald-300/50 text-emerald-500" :
    v === "lost" ? "border-rose-300/50 text-rose-400" :
    "border-border/50 text-muted-foreground";

  const icon =
    v === "won" ? <Trophy className="w-4 h-4 text-emerald-500 shrink-0" /> :
    v === "lost" ? <XCircle className="w-4 h-4 text-rose-400 shrink-0" /> :
    null;

  return (
    <>
    <div className={`w-72 flex flex-col max-h-full rounded-2xl border overflow-hidden ${colBg}`}>
      <div className={`p-4 border-b shrink-0 ${headerBg}`}>
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-1.5">
            {icon}
            <h3 className={`font-display font-bold ${
              v === "won" ? "text-emerald-800" : v === "lost" ? "text-rose-700" : "text-foreground"
            }`}>{col.title}</h3>
          </div>
          <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold border ${badgeBg}`}>
            {leads.length}
          </span>
        </div>
        {showRevenue && totalRevenue > 0 && (
          <div className="mt-2 flex items-center gap-1.5 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 rounded-lg px-2.5 py-1">
            <TrendingUp className="w-3.5 h-3.5 text-emerald-600" />
            <span className="text-xs font-bold text-emerald-700">{formatCurrency(totalRevenue)}</span>
          </div>
        )}
      </div>
      <div ref={setNodeRef} className={`p-3 flex-1 overflow-y-auto custom-scrollbar transition-colors duration-150 ${dropBg}`}>
        <SortableContext items={leads.map((l) => l.id)} strategy={verticalListSortingStrategy}>
          {leads.map((lead) => (
            <LeadCard key={lead.id} lead={lead} onView={onView} showRevenue={showRevenue} variant={v} />
          ))}
          {leads.length === 0 && (
            <div className={`h-20 border-2 border-dashed rounded-xl flex items-center justify-center text-sm font-medium ${emptyBorder}`}>
              Drop here
            </div>
          )}
        </SortableContext>
      </div>
    </div>
    </>
  );
}


/* ── FilterPopover ────────────────────────────────────────── */
function FilterPopover({ filters, onChange, columns }: {
  filters: { source: string; status: string };
  onChange: (f: { source: string; status: string }) => void;
  columns: ColDef[];
}) {
  const [open, setOpen] = useState(false);
  const hasActive = filters.source !== "all" || filters.status !== "all";

  return (
    <>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className={`rounded-full relative ${hasActive ? "border-primary text-primary bg-primary/5" : ""}`}
        >
          <Filter className="w-4 h-4" />
          {hasActive && (
            <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-primary" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-4 space-y-4" align="end">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">Filtreler</p>
          {hasActive && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs text-muted-foreground"
              onClick={() => onChange({ source: "all", status: "all" })}
            >
              Temizle
            </Button>
          )}
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Source</Label>
          <Select value={filters.source} onValueChange={v => onChange({ ...filters, source: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {SOURCES.map(s => (
                <SelectItem key={s} value={s} className="capitalize">{s.replace(/_/g, " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Stage</Label>
          <Select value={filters.status} onValueChange={v => onChange({ ...filters, status: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {columns.map(c => (
                <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button size="sm" className="w-full" onClick={() => setOpen(false)}>
          Uygula
        </Button>
      </PopoverContent>
    </Popover>
    </>
  );
}

/* ── NationalityCombobox ──────────────────────────────────── */
function NationalityCombobox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [searchVal, setSearchVal] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Server-side (AJAX) debounced search over the country catalog.
  const { data: filtered = [] } = useCountrySearch(searchVal);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearchVal("");
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <>
    <div className="relative" ref={containerRef}>
      <Input
        value={open ? searchVal : value}
        onChange={e => { setSearchVal(e.target.value); if (!open) setOpen(true); }}
        onFocus={() => { setSearchVal(""); setOpen(true); }}
        placeholder={value || "Select or type..."}
        autoComplete="off"
      />
      {open && (
        <div className="absolute z-[9999] mt-1 w-full bg-popover border rounded-md shadow-lg max-h-48 overflow-y-auto">
          {filtered.length === 0 && <div className="p-3 text-sm text-muted-foreground text-center">{searchVal ? "No match — custom value OK" : "No countries loaded"}</div>}
          {filtered.map(c => (
            <button key={c.id} type="button" className={`w-full text-left px-3 py-2 text-sm hover:bg-secondary/70 transition-colors flex items-center gap-2 ${c.name === value ? "bg-primary/10 font-medium" : ""}`}
              onMouseDown={e => { e.preventDefault(); onChange(c.name); setSearchVal(""); setOpen(false); }}>
              <CountryFlag code={c.code} size="sm" />
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
    </>
  );
}

/* ── MultiCountrySelect (countries from Course Finder – universities with active programs) ── */
function MultiCountrySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: cfFilters } = useQuery<{ countries: string[] }>({
    queryKey: ["course-finder-filters"],
    queryFn: async () => {
      const res = await apiFetch(`${BASE_URL}/api/course-finder/filters`);
      return res;
    },
    staleTime: 5 * 60_000,
  });
  const cfCountryNames = cfFilters?.countries ?? [];
  const { data: allCountries = [] } = useCountries();
  const activeDestinations = useMemo(() => {
    const nameSet = new Set(cfCountryNames);
    return allCountries.filter(c => nameSet.has(c.name));
  }, [allCountries, cfCountryNames]);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [localSelected, setLocalSelected] = useState<string[]>(() =>
    value ? value.split(",").map(s => s.trim()).filter(Boolean) : []
  );

  useEffect(() => {
    const parsed = value ? value.split(",").map(s => s.trim()).filter(Boolean) : [];
    setLocalSelected(prev => {
      if (prev.join(",") === parsed.join(",")) return prev;
      return parsed;
    });
  }, [value]);

  function toggle(name: string) {
    setLocalSelected(prev => {
      const next = prev.includes(name) ? prev.filter(s => s !== name) : [...prev, name];
      onChange(next.join(", "));
      return next;
    });
  }

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    const timer = setTimeout(() => document.addEventListener("click", handleClick), 0);
    return () => { clearTimeout(timer); document.removeEventListener("click", handleClick); };
  }, [open]);

  return (
    <>
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background hover:bg-accent/50 transition-colors"
      >
        <span className={`truncate ${localSelected.length === 0 ? "text-muted-foreground" : ""}`}>
          {localSelected.length === 0 ? "Select countries..." : localSelected.length === 1 ? localSelected[0] : `${localSelected.length} countries selected`}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
      </button>
      {localSelected.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {localSelected.map(name => {
            const c = activeDestinations.find(d => d.name === name);
            return (
              <span key={name} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                {c && <CountryFlag code={c.code} size="sm" />}
                {name}
                <button type="button" className="ml-0.5 hover:text-destructive" onClick={(e) => { e.stopPropagation(); toggle(name); }}><X className="w-3 h-3" /></button>
              </span>
            );
          })}
        </div>
      )}
      {open && (
        <div className="absolute z-[9999] mt-1 w-full bg-popover border rounded-md shadow-lg max-h-48 overflow-y-auto">
          {activeDestinations.length === 0 && <div className="p-3 text-sm text-muted-foreground text-center">No active destinations</div>}
          {activeDestinations.map(c => (
            <button key={c.id} type="button" className={`w-full text-left px-3 py-2 text-sm hover:bg-secondary/70 transition-colors flex items-center gap-2 ${localSelected.includes(c.name) ? "bg-primary/10 font-medium" : ""}`}
              onClick={e => { e.preventDefault(); e.stopPropagation(); toggle(c.name); }}>
              <Checkbox checked={localSelected.includes(c.name)} className="pointer-events-none" />
              <CountryFlag code={c.code} size="sm" />
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
    </>
  );
}

/* ── EditLeadDialog ───────────────────────────────────────── */
function EditLeadDialog({ open, onClose, lead, canSeeRevenue, columns }: {
  open: boolean; onClose: () => void; lead: any; canSeeRevenue: boolean; columns: ColDef[];
}) {
  const [form, setForm] = useState({ ...EMPTY_FORM, status: "new" });
  const updateLead = useUpdateLead();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    if (open && lead) {
      const parsed = parsePhoneCode(lead.phone || "");
      setForm({
        firstName: lead.firstName || "",
        lastName: lead.lastName || "",
        email: lead.email || "",
        phoneCode: parsed.phoneCode,
        phone: parsed.phone,
        source: lead.source || "website",
        interestedProgram: lead.interestedProgram || "",
        interestedCountry: lead.interestedCountry || "",
        nationality: lead.nationality || "",
        estimatedValue: lead.estimatedValue ? String(lead.estimatedValue) : "",
        status: lead.status || "new",
      });
    }
  }, [open, lead]);

  function handleSave() {
    if (!lead || !form.firstName || !form.lastName) return;
    const { phoneCode, ...rest } = form;
    const payload: any = { ...rest, phone: form.phone ? `${phoneCode}${form.phone}` : "" };
    const parsedVal = parseFloat(form.estimatedValue);
    if (form.estimatedValue && !isNaN(parsedVal)) payload.estimatedValue = parsedVal;
    else delete payload.estimatedValue;

    updateLead.mutate(
      { id: lead.id, data: payload },
      {
        onSuccess: () => {
          toast({ title: "Lead updated" });
          queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
          onClose();
        },
        onError: () => {
          toast({ title: "Error", description: "Failed to update lead", variant: "destructive" });
        },
      }
    );
  }

  return (
    <>
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Edit Lead</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-2">
          <div className="space-y-1.5">
            <Label>First Name *</Label>
            <Input value={form.firstName} onChange={e => setForm({ ...form, firstName: toLatinUpper(e.target.value) })} className="uppercase" />
          </div>
          <div className="space-y-1.5">
            <Label>Last Name *</Label>
            <Input value={form.lastName} onChange={e => setForm({ ...form, lastName: toLatinUpper(e.target.value) })} className="uppercase" />
          </div>
          <div className="space-y-1.5">
            <Label>Email *</Label>
            <Input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Phone *</Label>
            <div className="flex gap-1">
              <PhoneCodePicker value={form.phoneCode} onChange={v => setForm({ ...form, phoneCode: v })} triggerClassName="w-[90px] shrink-0 px-2" />
              <Input className="flex-1 min-w-0" value={form.phone} onChange={e => setForm({ ...form, phone: digitsOnly(e.target.value) })} placeholder="555 000 0000" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Nationality</Label>
            <NationalityCombobox value={form.nationality} onChange={v => setForm({ ...form, nationality: v })} />
          </div>
          <div className="space-y-1.5">
            <Label>Source</Label>
            <Select value={form.source} onValueChange={v => setForm({ ...form, source: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {SOURCES.map(s => (
                  <SelectItem key={s} value={s} className="capitalize">{s.replace(/_/g, " ")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Status</Label>
            <Select value={form.status} onValueChange={v => setForm({ ...form, status: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {columns.map(c => (
                  <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Interested Program</Label>
            <Input value={form.interestedProgram} onChange={e => setForm({ ...form, interestedProgram: e.target.value })} />
          </div>
          <div className="space-y-1.5 col-span-2">
            <Label>Interested Country</Label>
            <MultiCountrySelect value={form.interestedCountry} onChange={v => setForm({ ...form, interestedCountry: v })} />
          </div>
          {canSeeRevenue && (
            <div className="space-y-1.5 col-span-2">
              <Label className="flex items-center gap-1.5">
                <TrendingUp className="w-3.5 h-3.5 text-emerald-500" />
                Estimated Value (USD)
              </Label>
              <Input type="number" min="0" step="100" value={form.estimatedValue} onChange={e => setForm({ ...form, estimatedValue: e.target.value })} />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={updateLead.isPending || !form.firstName || !form.lastName}>
            {updateLead.isPending ? "Saving…" : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

/* ── DeleteConfirmDialog ─────────────────────────────────── */
function DeleteConfirmDialog({ open, onClose, count, onConfirm, isPending }: {
  open: boolean; onClose: () => void; count: number; onConfirm: () => void; isPending: boolean;
}) {
  return (
    <>
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete {count} Lead{count > 1 ? "s" : ""}?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground py-2">
          This action cannot be undone. The selected lead{count > 1 ? "s" : ""} and all associated data will be permanently removed.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={isPending}>
            {isPending ? "Deleting…" : `Delete ${count} Lead${count > 1 ? "s" : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

/* ── SortHeader ──────────────────────────────────────────── */
type SortKey = "name" | "email" | "status" | "source" | "program" | "country" | "value" | "date";
type SortDir = "asc" | "desc";

function SortHeader({ label, sortKey, currentSort, onSort }: {
  label: string; sortKey: SortKey;
  currentSort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
}) {
  const active = currentSort.key === sortKey;
  return (
    <>
    <TableHead
      className="cursor-pointer select-none hover:bg-muted/50 transition-colors"
      onClick={() => onSort(sortKey)}
    >
      <div className="flex items-center gap-1">
        {label}
        {active ? (
          currentSort.dir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />
        ) : (
          <ArrowUpDown className="w-3 h-3 text-muted-foreground/50" />
        )}
      </div>
    </TableHead>
    </>
  );
}

/* ── PHONE CODES ─────────────────────────────────────────── */
const PHONE_CODES = [
  { code: "+90", country: "TR" },
  { code: "+1", country: "US" },
  { code: "+44", country: "GB" },
  { code: "+49", country: "DE" },
  { code: "+33", country: "FR" },
  { code: "+39", country: "IT" },
  { code: "+34", country: "ES" },
  { code: "+31", country: "NL" },
  { code: "+46", country: "SE" },
  { code: "+47", country: "NO" },
  { code: "+45", country: "DK" },
  { code: "+41", country: "CH" },
  { code: "+43", country: "AT" },
  { code: "+48", country: "PL" },
  { code: "+7", country: "RU" },
  { code: "+380", country: "UA" },
  { code: "+86", country: "CN" },
  { code: "+81", country: "JP" },
  { code: "+82", country: "KR" },
  { code: "+91", country: "IN" },
  { code: "+92", country: "PK" },
  { code: "+93", country: "AF" },
  { code: "+966", country: "SA" },
  { code: "+971", country: "AE" },
  { code: "+964", country: "IQ" },
  { code: "+98", country: "IR" },
  { code: "+962", country: "JO" },
  { code: "+961", country: "LB" },
  { code: "+20", country: "EG" },
  { code: "+212", country: "MA" },
  { code: "+234", country: "NG" },
  { code: "+254", country: "KE" },
  { code: "+55", country: "BR" },
  { code: "+52", country: "MX" },
  { code: "+61", country: "AU" },
  { code: "+64", country: "NZ" },
  { code: "+60", country: "MY" },
  { code: "+65", country: "SG" },
  { code: "+66", country: "TH" },
  { code: "+84", country: "VN" },
  { code: "+62", country: "ID" },
  { code: "+63", country: "PH" },
  { code: "+880", country: "BD" },
  { code: "+94", country: "LK" },
  { code: "+977", country: "NP" },
  { code: "+251", country: "ET" },
  { code: "+255", country: "TZ" },
  { code: "+233", country: "GH" },
];

function parsePhoneCode(fullPhone: string): { phoneCode: string; phone: string } {
  if (!fullPhone) return { phoneCode: "", phone: "" };
  const sorted = [...PHONE_CODES].sort((a, b) => b.code.length - a.code.length);
  const matched = sorted.find(pc => fullPhone.startsWith(pc.code));
  if (matched) return { phoneCode: matched.code, phone: fullPhone.slice(matched.code.length).trim() };
  return { phoneCode: "", phone: fullPhone.replace(/^\+/, "").trim() };
}

/* ── EMPTY_FORM ───────────────────────────────────────────── */
const EMPTY_FORM = {
  firstName: "",
  lastName: "",
  email: "",
  phoneCode: "",
  phone: "",
  source: "website",
  interestedProgram: "",
  interestedCountry: "",
  nationality: "",
  estimatedValue: "",
  status: "new",
};

/* ── LeadsPage ────────────────────────────────────────────── */
export default function AgentLeadsPage() {
  const { t } = useI18n();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [filters, setFilters] = useState({ source: "all", status: "all" });
  const { stages: pipelineStages } = usePipelineStages("lead");
  const [viewMode, setViewMode] = useState<"pipeline" | "list">(() => {
    return (localStorage.getItem(VIEW_KEY) as "pipeline" | "list") || "pipeline";
  });

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "date", dir: "desc" });
  const [editLead, setEditLead] = useState<any>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteInProgress, setDeleteInProgress] = useState(false);

  const pg = useTablePagination(25);

  // Authorization (role + granular permission) is enforced by the route-level
  // ProtectedRoute (AGENT_ROLES + requiredPermission). Do NOT pass a narrower
  // role list here — ["agent","sub_agent"] excludes agent_staff and would
  // bounce permitted agent_staff users to "/" (→ /en).
  const { user, hasPermission } = useAuth(true);
  const canSeeRevenue = true;

  const { season } = useSeason();
  const { data, isLoading } = useListLeads({ search, season, limit: 200 } as any);
  const updateLead = useUpdateLead();
  const deleteLead = useDeleteLead();
  const queryClient = useQueryClient();

  // Lead stage change is governed by the leads.change_stage permission
  // (Task #564 — agents no longer use a separate Settings toggle).
  const canChangLeadStage = hasPermission("leads.change_stage");

  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 5 } });
  const keyboardSensor = useSensor(KeyboardSensor);
  const sensors = useSensors(
    ...(canChangLeadStage ? [pointerSensor, keyboardSensor] : [])
  );

  const allLeads = data?.data || [];

  const columns: ColDef[] = pipelineStages.map(s => ({
    id: s.key,
    title: s.label,
    variant: (s.variant as ColVariant) || undefined,
  }));

  const allColumnIds = new Set(columns.map(c => c.id));
  const leadStageMap = Object.fromEntries(pipelineStages.map((s, i) => [s.key, { ...s, _index: i }]));

  const filteredLeads = allLeads.filter((l: any) => {
    if (filters.source !== "all" && l.source !== filters.source) return false;
    if (filters.status !== "all" && l.status !== filters.status) return false;
    return true;
  });

  const sortedLeads = useMemo(() => {
    const arr = [...filteredLeads];
    arr.sort((a: any, b: any) => {
      let valA: any, valB: any;
      switch (sort.key) {
        case "name": valA = `${a.firstName} ${a.lastName}`.toLowerCase(); valB = `${b.firstName} ${b.lastName}`.toLowerCase(); break;
        case "email": valA = (a.email || "").toLowerCase(); valB = (b.email || "").toLowerCase(); break;
        case "status": valA = a.status || ""; valB = b.status || ""; break;
        case "source": valA = a.source || ""; valB = b.source || ""; break;
        case "program": valA = (a.interestedProgram || "").toLowerCase(); valB = (b.interestedProgram || "").toLowerCase(); break;
        case "country": valA = (a.interestedCountry || "").toLowerCase(); valB = (b.interestedCountry || "").toLowerCase(); break;
        case "value": valA = parseFloat(a.estimatedValue) || 0; valB = parseFloat(b.estimatedValue) || 0; break;
        case "date": valA = a.createdAt || ""; valB = b.createdAt || ""; break;
        default: return 0;
      }
      if (valA < valB) return sort.dir === "asc" ? -1 : 1;
      if (valA > valB) return sort.dir === "asc" ? 1 : -1;
      return 0;
    });
    return arr;
  }, [filteredLeads, sort]);

  const { paged: pagedLeads, total: totalLeadsCount } = pg.paginate(sortedLeads);

  useEffect(() => { pg.setPage(1); setSelectedIds(new Set()); }, [search, filters, sort]);

  const activeCard = activeId ? allLeads.find((l: any) => l.id === activeId) : null;

  function toggleView(mode: "pipeline" | "list") {
    setViewMode(mode);
    localStorage.setItem(VIEW_KEY, mode);
    setSelectedIds(new Set());
  }

  function handleSort(key: SortKey) {
    setSort(prev => prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }

  function toggleSelect(id: number) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const pagedIds = useMemo(() => new Set(pagedLeads.map((l: any) => l.id)), [pagedLeads]);
  const allPageSelected = pagedLeads.length > 0 && pagedLeads.every((l: any) => selectedIds.has(l.id));

  function toggleSelectAll() {
    if (allPageSelected) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        pagedIds.forEach(id => next.delete(id));
        return next;
      });
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev);
        pagedIds.forEach(id => next.add(id));
        return next;
      });
    }
  }

  async function handleExport(scope: "selected" | "all" = "all") {
    // Export the current client-side scoped/filtered set. "selected" exports
    // only the checked rows; "all" exports every filtered+sorted row.
    // Data is already agent-scoped server-side by /api/leads, so this adds
    // no new IDOR surface.
    const rows = scope === "selected"
      ? sortedLeads.filter((l: any) => selectedIds.has(l.id))
      : sortedLeads;
    if (rows.length === 0) {
      toast({ title: t("agentLeads.export.empty"), variant: "destructive" });
      return;
    }
    const data = rows.map((l: any) => {
      const row: Record<string, any> = {
        [t("agentLeads.export.colName")]: `${l.firstName ?? ""} ${l.lastName ?? ""}`.trim(),
        [t("agentLeads.export.colEmail")]: l.email || "",
        [t("agentLeads.export.colPhone")]: l.phone || "",
        [t("agentLeads.export.colStatus")]: leadStageMap[l.status]?.label || l.status || "",
        [t("agentLeads.export.colSource")]: l.source ? l.source.replace(/_/g, " ") : "",
        [t("agentLeads.export.colProgram")]: l.interestedProgram || "",
        [t("agentLeads.export.colCountry")]: l.interestedCountry || "",
      };
      if (canSeeRevenue) {
        const n = Number(l.estimatedValue);
        row[t("agentLeads.export.colValue")] = l.estimatedValue && Number.isFinite(n) ? n : "";
      }
      row[t("agentLeads.export.colCreated")] = l.createdAt ? new Date(l.createdAt).toLocaleDateString() : "";
      return row;
    });
    const XLSX = await import("xlsx");
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Leads");
    XLSX.writeFile(wb, `leads_${new Date().toISOString().slice(0, 10)}.xlsx`);
    toast({ title: t("agentLeads.export.success", { count: rows.length }) });
  }

  async function handleBulkDelete() {
    setDeleteInProgress(true);
    const ids = Array.from(selectedIds);
    let failed = 0;
    for (const id of ids) {
      try {
        await deleteLead.mutateAsync({ id });
      } catch {
        failed++;
      }
    }
    setDeleteInProgress(false);
    setDeleteOpen(false);
    setSelectedIds(new Set());
    queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
    if (failed === 0) {
      toast({ title: `${ids.length} lead${ids.length > 1 ? "s" : ""} deleted` });
    } else {
      toast({ title: "Some leads could not be deleted", variant: "destructive" });
    }
  }

  const handleDragStart = (event: DragStartEvent) => setActiveId(event.active.id as number);

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    if (!over) return;

    const leadId = active.id as number;
    const overId = over.id;

    let targetStatus: string;
    if (allColumnIds.has(overId as string)) {
      targetStatus = overId as string;
    } else {
      const overLead = allLeads.find((l: any) => l.id === overId);
      if (!overLead) return;
      targetStatus = overLead.status;
    }

    const lead = allLeads.find((l: any) => l.id === leadId);
    if (!lead || lead.status === targetStatus) return;

    const targetCol = columns.find(c => c.id === targetStatus);
    const isWonColumn = targetCol?.variant === "won";

    if (isWonColumn) {
      try {
        const result = await customFetch(`/api/leads/${leadId}/convert`, { method: "POST" }) as any;
        await Promise.all([
          queryClient.refetchQueries({ queryKey: ["/api/leads"] }),
          queryClient.refetchQueries({ queryKey: ["/api/students"] }),
        ]);
        if (result.alreadyConverted) {
          toast({ title: "Lead already converted", description: "This lead has already been converted to a student." });
        } else {
          const studentName = `${result.student?.firstName || ""} ${result.student?.lastName || ""}`.trim();
          toast({
            title: "Lead converted to student",
            description: result.merged
              ? `Merged with existing student: ${studentName}`
              : `New student created: ${studentName}`,
          });
        }
      } catch (err: any) {
        toast({ title: "Conversion failed", description: err.message || "Failed to convert lead", variant: "destructive" });
        await queryClient.refetchQueries({ queryKey: ["/api/leads"] });
      }
      return;
    }

    updateLead.mutate(
      { id: leadId, data: { status: targetStatus } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
          queryClient.invalidateQueries({ queryKey: [`/api/leads/${leadId}`] });
          const colLabel = targetCol?.title ?? targetStatus;
          toast({ title: `Lead moved to ${colLabel}` });
        },
        onError: () => {
          toast({ title: "Error", description: "Failed to move lead", variant: "destructive" });
          queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
          queryClient.invalidateQueries({ queryKey: [`/api/leads/${leadId}`] });
        },
      }
    );
  };

  return (
    <>
      <div className="h-[calc(100vh-8rem)] flex flex-col">
        {/* ── Header ─────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 shrink-0">
          <div className="flex items-center gap-3">
            <div>
              <h1 className="text-3xl font-display font-bold text-foreground">{t("agentLeads.title")}</h1>
              <p className="text-muted-foreground text-sm mt-1">{t("agentLeads.subtitle")}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search leads..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 bg-white dark:bg-black/20 border-border rounded-full"
              />
            </div>
            <FilterPopover filters={filters} onChange={setFilters} columns={columns} />

            <Button variant="outline" className="rounded-full gap-2" onClick={() => handleExport("all")} title={t("agentLeads.export.button")}>
              <Download className="w-4 h-4" /> {t("agentLeads.export.button")}
            </Button>

            <div className="flex items-center border rounded-full overflow-hidden">
              <button
                onClick={() => toggleView("pipeline")}
                className={`p-2 transition-colors ${viewMode === "pipeline" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}
                title="Pipeline view"
              >
                <LayoutGrid className="w-4 h-4" />
              </button>
              <button
                onClick={() => toggleView("list")}
                className={`p-2 transition-colors ${viewMode === "list" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}
                title="List view"
              >
                <List className="w-4 h-4" />
              </button>
            </div>

            {selectedIds.size > 0 && (
              <Button variant="outline" size="sm" className="rounded-full gap-1.5" onClick={() => handleExport("selected")}>
                <Download className="w-4 h-4" />
                {t("agentLeads.export.exportSelected")}
              </Button>
            )}

            {selectedIds.size > 0 && (
              <Button variant="destructive" size="sm" className="rounded-full" onClick={() => setDeleteOpen(true)}>
                <Trash2 className="w-4 h-4 mr-1" />
                Delete ({selectedIds.size})
              </Button>
            )}

            <Button className="rounded-full shadow-lg shadow-primary/20" onClick={() => setCreateOpen(true)}>
              <Plus className="w-4 h-4 mr-2" /> Add Lead
            </Button>
          </div>
        </div>

        {/* ── Pipeline board ─────────────────────────────────── */}
        {viewMode === "pipeline" && (
          <div className="flex-1 overflow-x-auto overflow-y-hidden pb-4">
            <div className="flex gap-5 h-full min-w-max px-1">
              <DndContext
                sensors={sensors}
                collisionDetection={closestCorners}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
              >
                {columns.map((col) => {
                  const columnLeads = filteredLeads.filter((l: any) => l.status === col.id).sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
                  return (
                    <DroppableColumn
                      key={col.id}
                      col={col}
                      leads={columnLeads}
                      showRevenue={canSeeRevenue}
                      onView={(id) => setLocation(`/agent/leads/${id}`)}
                    />
                  );
                })}

                <DragOverlay>
                  {activeCard ? (
                    <div className="bg-card rounded-xl border border-primary shadow-2xl p-4 w-72 opacity-95 rotate-1">
                      <div className="flex justify-between items-start mb-2">
                        <h4 className="font-bold text-sm text-foreground">
                          {activeCard.firstName} {activeCard.lastName}
                        </h4>
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {activeCard.email || activeCard.phone || "No contact info"}
                      </p>
                      {activeCard.interestedProgram && (
                        <p className="text-xs font-medium text-primary mt-2 truncate bg-primary/5 block max-w-full px-2 py-1 rounded-md">
                          {activeCard.interestedProgram}
                        </p>
                      )}
                      {canSeeRevenue && activeCard.estimatedValue && parseFloat(String(activeCard.estimatedValue)) > 0 && (
                        <div className="mt-2 flex items-center gap-1">
                          <TrendingUp className="w-3 h-3 text-emerald-500" />
                          <span className="text-xs font-semibold text-emerald-600">
                            {formatCurrency(activeCard.estimatedValue)}
                          </span>
                        </div>
                      )}
                    </div>
                  ) : null}
                </DragOverlay>
              </DndContext>
            </div>
          </div>
        )}

        {/* ── List view ──────────────────────────────────────── */}
        {viewMode === "list" && (
          <div className="flex-1 flex flex-col overflow-hidden bg-card rounded-2xl border">
            <div className="flex-1 overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead className="w-10">
                      <Checkbox
                        checked={allPageSelected}
                        onCheckedChange={toggleSelectAll}
                      />
                    </TableHead>
                    <SortHeader label="Name" sortKey="name" currentSort={sort} onSort={handleSort} />
                    <SortHeader label="Email" sortKey="email" currentSort={sort} onSort={handleSort} />
                    <SortHeader label="Status" sortKey="status" currentSort={sort} onSort={handleSort} />
                    <SortHeader label="Source" sortKey="source" currentSort={sort} onSort={handleSort} />
                    <SortHeader label="Program" sortKey="program" currentSort={sort} onSort={handleSort} />
                    <SortHeader label="Country" sortKey="country" currentSort={sort} onSort={handleSort} />
                    {canSeeRevenue && (
                      <SortHeader label="Value" sortKey="value" currentSort={sort} onSort={handleSort} />
                    )}
                    <SortHeader label="Created" sortKey="date" currentSort={sort} onSort={handleSort} />
                    <TableHead className="w-20 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow>
                      <TableCell colSpan={canSeeRevenue ? 10 : 9} className="text-center py-12 text-muted-foreground">
                        Loading...
                      </TableCell>
                    </TableRow>
                  ) : pagedLeads.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={canSeeRevenue ? 10 : 9} className="text-center py-12 text-muted-foreground">
                        No leads found
                      </TableCell>
                    </TableRow>
                  ) : pagedLeads.map((lead: any) => (
                    <TableRow
                      key={lead.id}
                      className={`cursor-pointer hover:bg-muted/30 transition-colors ${selectedIds.has(lead.id) ? "bg-primary/5" : ""}`}
                    >
                      <TableCell onClick={e => e.stopPropagation()}>
                        <Checkbox
                          checked={selectedIds.has(lead.id)}
                          onCheckedChange={() => toggleSelect(lead.id)}
                        />
                      </TableCell>
                      <TableCell
                        className="font-medium cursor-pointer"
                        onClick={() => setLocation(`/agent/leads/${lead.id}`)}
                      >
                        <div className="flex items-center gap-2">
                          <LeadAvatar lead={lead} />
                          <span>{lead.firstName} {lead.lastName}</span>
                        </div>
                      </TableCell>
                      <TableCell
                        className="text-muted-foreground cursor-pointer"
                        onClick={() => setLocation(`/agent/leads/${lead.id}`)}
                      >
                        {lead.email || "-"}
                      </TableCell>
                      <TableCell className="cursor-pointer" onClick={() => setLocation(`/agent/leads/${lead.id}`)}>
                        {(() => {
                          const sm = leadStageMap[lead.status];
                          const color = sm ? getLeadStageColor(sm, sm._index) : "bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-800/50 dark:text-gray-300 dark:border-gray-600/50";
                          return <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${color}`}>{sm?.label || lead.status}</span>;
                        })()}
                      </TableCell>
                      <TableCell
                        className="text-muted-foreground capitalize cursor-pointer"
                        onClick={() => setLocation(`/agent/leads/${lead.id}`)}
                      >
                        {lead.source?.replace(/_/g, " ") || "-"}
                      </TableCell>
                      <TableCell
                        className="max-w-[150px] truncate cursor-pointer"
                        onClick={() => setLocation(`/agent/leads/${lead.id}`)}
                      >
                        {lead.interestedProgram || "-"}
                      </TableCell>
                      <TableCell className="cursor-pointer" onClick={() => setLocation(`/agent/leads/${lead.id}`)}>
                        {lead.interestedCountry || "-"}
                      </TableCell>
                      {canSeeRevenue && (
                        <TableCell className="cursor-pointer" onClick={() => setLocation(`/agent/leads/${lead.id}`)}>
                          {lead.estimatedValue ? (
                            <span className="text-emerald-600 font-medium">{formatCurrency(lead.estimatedValue)}</span>
                          ) : "-"}
                        </TableCell>
                      )}
                      <TableCell
                        className="text-muted-foreground text-xs cursor-pointer"
                        onClick={() => setLocation(`/agent/leads/${lead.id}`)}
                      >
                        {formatDate(lead.createdAt)}
                      </TableCell>
                      <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => setEditLead(lead)}
                            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                            title="Edit lead"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => { setSelectedIds(new Set([lead.id])); setDeleteOpen(true); }}
                            className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                            title="Delete lead"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <TablePagination
              currentPage={pg.page}
              totalItems={totalLeadsCount}
              pageSize={pg.pageSize}
              onPageChange={pg.setPage}
              onPageSizeChange={pg.setPageSize}
            />
          </div>
        )}
      </div>

      {/* ── Edit Lead Dialog ───────────────────────────────── */}
      <EditLeadDialog
        open={!!editLead}
        onClose={() => setEditLead(null)}
        lead={editLead}
        canSeeRevenue={canSeeRevenue}
        columns={columns}
      />

      {/* ── Delete Confirm Dialog ──────────────────────────── */}
      <DeleteConfirmDialog
        open={deleteOpen}
        onClose={() => { setDeleteOpen(false); }}
        count={selectedIds.size}
        onConfirm={handleBulkDelete}
        isPending={deleteInProgress}
      />

      <CreateLeadDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
