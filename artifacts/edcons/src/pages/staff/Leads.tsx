import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import * as XLSX from "xlsx";
import { Link, useLocation } from "wouter";
import { toLatinUpper } from "@/lib/textTransform";
import { TableSkeleton } from "@/components/ui/page-skeleton";
import { QuickContactDialog } from "@/components/QuickContact";
import { AssignPopover } from "@/components/AssignPopover";
import { RowActionsMenu } from "@/components/RowActionsMenu";
import { useListLeads, useUpdateLead, useCreateLead, useDeleteLead, customFetch } from "@workspace/api-client-react";
import { useSeason } from "@/contexts/SeasonContext";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import {
  Plus, Search, Filter, Eye, TrendingUp, X, UserCheck2,
  ChevronDown, GripVertical, Check, Trophy, XCircle, LayoutGrid, List,
  ArrowUpDown, ArrowUp, ArrowDown, Trash2, Pencil,
  MessageSquare, Mail, UserPlus, Download, Building2,
  FileUp, Sparkles, FileText, CheckCircle2, Loader2, Users,
} from "lucide-react";
import { TablePagination, useTablePagination } from "@/components/TablePagination";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PhoneField, isPhoneFieldValid, toPhoneFieldValue } from "@/components/ui/phone-field";
import { Badge } from "@/components/ui/badge";
import { CountryFlag } from "@/components/CountryFlag";
import { useCountrySearch } from "@/hooks/use-countries";
import { useStudyLevels } from "@/hooks/useStudyLevels";
import { OriginBadge } from "@/components/OriginBadge";
import { Checkbox } from "@/components/ui/checkbox";
import { ColumnHeader } from "@/components/ui/column-header";
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
import { isNonLatinNameError } from "@/lib/latinNameError";
import { usePipelineStages, type PipelineStage } from "@/hooks/use-pipeline-stages";
import { usePersistedFilterValue } from "@/hooks/use-table-prefs";
import { BulkActionBar } from "@/components/BulkActionBar";
import { BulkMessageDialog } from "@/components/BulkMessageDialog";
import { useI18n } from "@/hooks/use-i18n";
import { useDateFormat } from "@/hooks/use-date-format";
import {
  DEFAULT_LEAD_SOURCE_OPTIONS,
  buildLeadSourceFilterOptions,
  type LeadSourceOption,
} from "@/lib/leadSourceOptions";
import { LinkedTableCell } from "@/components/LinkedTableCell";
import { getLeadSourceLabel } from "@/lib/leadSourceLabel";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

function getCsrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : "";
}

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

const SOURCES = DEFAULT_LEAD_SOURCE_OPTIONS.map((option) => option.value);

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

function formatDate(dateStr: string | null | undefined, dateFormat?: string | null): string {
  if (!dateStr) return "-";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "-";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = String(d.getFullYear());
  switch (dateFormat) {
    case "DD/MM/YYYY": return `${dd}/${mm}/${yyyy}`;
    case "MM/DD/YYYY": return `${mm}/${dd}/${yyyy}`;
    case "YYYY-MM-DD": return `${yyyy}-${mm}-${dd}`;
    default:           return `${dd}.${mm}.${yyyy}`;
  }
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
          src={lead.convertedStudentPhotoUrl || `/api/students/${lead.convertedStudentId}/photo/thumbnail`}
          alt={`${lead.firstName} ${lead.lastName}`}
          className={`${dim} rounded-full object-cover border border-primary/20`}
          loading="lazy"
          decoding="async"
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
function LeadCard({ lead, onView, showRevenue, variant, assignedUserName, onAssign, staffUsersList, currentUserId, canAssign, canReassign, canMoveCards }: {
  lead: any; onView: (id: number) => void; showRevenue: boolean; variant?: ColVariant;
  assignedUserName?: string; onAssign?: (entityId: number, userId: number) => void;
  staffUsersList?: { id: number; name: string }[]; currentUserId?: number; canAssign?: boolean; canReassign?: boolean; canMoveCards?: boolean;
}) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: lead.id, disabled: !canMoveCards });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const [contactOpen, setContactOpen] = useState(false);
  const [contactChannel, setContactChannel] = useState<"email" | "whatsapp" | "instagram" | "internal">("internal");
  const [, setLoc] = useLocation();

  const isDirect = !lead.originType || lead.originType === "direct";
  const cardBg =
    variant === "won" ? "bg-emerald-50 border-emerald-200 hover:border-emerald-300 dark:bg-emerald-900/20 dark:border-emerald-700/40 dark:hover:border-emerald-600/60" :
    variant === "lost" ? "bg-rose-50 border-rose-200 hover:border-rose-300 dark:bg-rose-900/20 dark:border-rose-700/40 dark:hover:border-rose-600/60" :
    isDirect ? "bg-blue-50 border-blue-200 hover:border-blue-300 hover:shadow-md dark:bg-blue-900/20 dark:border-blue-700/40 dark:hover:border-blue-600/60" :
    "bg-card border-border hover:shadow-md";

  function openContact(ch: "email" | "whatsapp" | "instagram" | "internal") {
    setContactChannel(ch);
    setContactOpen(true);
  }

  return (
    <>
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-xl border overflow-hidden ${
        isDragging ? "border-primary shadow-xl opacity-50 z-50 relative" : cardBg
      } mb-3 transition-shadow duration-200`}
    >
      <div {...attributes} {...listeners} className={`p-4 pb-2 ${!canMoveCards ? "cursor-default" : isDragging ? "cursor-grabbing" : "cursor-grab"}`}>
        <div className="flex items-start gap-2 mb-2">
          <LeadAvatar lead={lead} />
          <div className="flex-1 min-w-0 flex justify-between items-start gap-2">
            <h4 className="min-w-0 flex-1 font-bold text-sm text-foreground truncate">
              {lead.firstName} {lead.lastName}
            </h4>
            {lead.source && (
              <span
                className="max-w-[48%] truncate text-[10px] px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground font-medium shrink"
                title={getLeadSourceLabel(lead.source, lead.sourcePageUrl)}
              >
                {getLeadSourceLabel(lead.source, lead.sourcePageUrl)}
              </span>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground truncate">{lead.email || lead.phone || t("leadsPage.noContactInfo")}</p>
        <OriginBadge originType={lead.originType || "direct"} originDisplayName={lead.originDisplayName} className="mt-1" />
        {lead.interestedProgram && (
          <p className="text-xs font-medium text-primary mt-2 bg-primary/5 block max-w-full px-2 py-1 rounded-md leading-relaxed">
            {lead.interestedProgram}
          </p>
        )}
        {lead.interestedUniversity && (
          <p className="text-xs text-muted-foreground mt-1 truncate" title={lead.interestedUniversity}>
            {lead.interestedUniversity}
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
      {lead.agentName && (
        <div className="px-4 pb-1.5">
          <span
            className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 font-medium cursor-pointer hover:bg-amber-100 hover:border-amber-300 transition-colors max-w-full truncate dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700/50 dark:hover:bg-amber-900/50"
            onClick={(e) => { e.stopPropagation(); setLoc(`/staff/agents/${lead.agentId}`); }}
            title={t("leadsPage.agentTooltip", { name: lead.agentName })}
          >
            <Building2 className="w-3 h-3 shrink-0" />{lead.agentName}
          </span>
        </div>
      )}
      <div className="px-4 pb-3 flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {onAssign && lead.assignedToId ? (
            (canReassign || lead.assignedToId === currentUserId) && staffUsersList ? (
              <AssignPopover assignedUserName={assignedUserName} staffUsers={staffUsersList} currentUserId={currentUserId} onAssign={(uid) => onAssign(lead.id, uid)} />
            ) : assignedUserName ? (
              <span className="text-[10px] text-muted-foreground truncate" title={assignedUserName}><UserCheck2 className="w-3 h-3 inline mr-0.5" />{assignedUserName}</span>
            ) : null
          ) : onAssign && !lead.assignedToId ? (
            canReassign && staffUsersList ? (
              <AssignPopover staffUsers={staffUsersList} currentUserId={currentUserId} onAssign={(uid) => onAssign(lead.id, uid)} />
            ) : canAssign && currentUserId ? (
              <button onClick={(e) => { e.stopPropagation(); onAssign(lead.id, currentUserId); }} className="text-[10px] text-primary hover:underline font-medium flex items-center gap-0.5" title={t("leadsPage.assignToMe")}>
                <UserPlus className="w-3 h-3 shrink-0" />{t("leadsPage.assignToMe")}
              </button>
            ) : null
          ) : assignedUserName ? (
            <span className="text-[10px] text-muted-foreground truncate" title={assignedUserName}><UserCheck2 className="w-3 h-3 inline mr-0.5" />{assignedUserName}</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button onClick={(e) => { e.stopPropagation(); openContact("internal"); }} title={t("leadsPage.message")}
            className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors">
            <MessageSquare className="w-3.5 h-3.5" />
          </button>
          {lead.email && (
            <button onClick={(e) => { e.stopPropagation(); openContact("email"); }} title={t("common.email")}
              className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors">
              <Mail className="w-3.5 h-3.5" />
            </button>
          )}
          {lead.phone && (
            <button onClick={(e) => { e.stopPropagation(); openContact("whatsapp"); }} title={t("leadsPage.whatsapp")}
              className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-emerald-600 hover:bg-emerald-50 transition-colors">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
            </button>
          )}
          <Link
            href={`/staff/leads/${lead.id}`}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary transition-colors"
          >
            <Eye className="w-3 h-3" /> {t("common.view")}
          </Link>
        </div>
      </div>
      <QuickContactDialog
        open={contactOpen}
        onClose={() => setContactOpen(false)}
        channel={contactChannel}
        setChannel={setContactChannel}
        name={`${lead.firstName} ${lead.lastName}`}
        email={lead.email}
        phone={lead.phone}
        entityType="lead"
        entityId={lead.id}
        hideEmail={!lead.email}
        hideWhatsApp={!lead.phone}
      />
    </div>
    </>
  );
}

/* ── DroppableColumn ──────────────────────────────────────── */
function DroppableColumn({ col, leads, totalCount, showRevenue, onView, staffUsersMap, onAssign, staffUsersList, currentUserId, canAssign, canReassign, canMoveCards }: {
  col: ColDef; leads: any[]; showRevenue: boolean; onView: (id: number) => void;
  totalCount?: number;
  staffUsersMap?: Record<number, string>; onAssign?: (entityId: number, userId: number) => void;
  staffUsersList?: { id: number; name: string }[]; currentUserId?: number; canAssign?: boolean; canReassign?: boolean; canMoveCards?: boolean;
}) {
  const { t } = useI18n();
  const { setNodeRef, isOver } = useDroppable({ id: col.id });
  const totalRevenue = showRevenue ? leads.reduce((sum, l) => sum + (parseFloat(l.estimatedValue) || 0), 0) : 0;
  const v = col.variant ?? "default";

  const headerBg =
    v === "won" ? "bg-emerald-100/80 border-emerald-200/70 dark:bg-emerald-900/40 dark:border-emerald-700/50" :
    v === "lost" ? "bg-rose-100/80 border-rose-200/70 dark:bg-rose-900/40 dark:border-rose-700/50" :
    "bg-card/50 border-border/50";

  const colBg =
    v === "won" ? "bg-emerald-50/60 border-emerald-200/50 dark:bg-emerald-900/20 dark:border-emerald-700/30" :
    v === "lost" ? "bg-rose-50/60 border-rose-200/50 dark:bg-rose-900/20 dark:border-rose-700/30" :
    "bg-secondary/50 border-border/50";

  const dropBg =
    v === "won" ? (isOver ? "bg-emerald-100/60 dark:bg-emerald-900/30" : "") :
    v === "lost" ? (isOver ? "bg-rose-100/60 dark:bg-rose-900/30" : "") :
    (isOver ? "bg-primary/5" : "");

  const badgeBg =
    v === "won" ? "bg-emerald-200/60 text-emerald-800 border-emerald-300/50 dark:bg-emerald-800/40 dark:text-emerald-200 dark:border-emerald-600/40" :
    v === "lost" ? "bg-rose-200/60 text-rose-800 border-rose-300/50 dark:bg-rose-800/40 dark:text-rose-200 dark:border-rose-600/40" :
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
            {totalCount ?? leads.length}
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
            <LeadCard key={lead.id} lead={lead} onView={onView} showRevenue={showRevenue} variant={v} assignedUserName={lead.assignedToId && staffUsersMap ? staffUsersMap[lead.assignedToId] : undefined} onAssign={onAssign} staffUsersList={staffUsersList} currentUserId={currentUserId} canAssign={canAssign} canReassign={canReassign} canMoveCards={canMoveCards} />
          ))}
          {leads.length === 0 && (
            <div className={`h-20 border-2 border-dashed rounded-xl flex items-center justify-center text-sm font-medium ${emptyBorder}`}>
              {t("leadsPage.dropHere")}
            </div>
          )}
        </SortableContext>
      </div>
    </div>
    </>
  );
}


/* ── FilterPopover ────────────────────────────────────────── */
type LeadFilters = { source: string; status: string; appSource: string; assignment: string; nationality: string; agent: string; dateRange: string; followupRange: string; originType: string };
const DEFAULT_LEAD_FILTERS: LeadFilters = { source: "all", status: "all", appSource: "all", assignment: "mine_unassigned", nationality: "all", agent: "all", dateRange: "all", followupRange: "all", originType: "all" };

function leadIsDateInRange(dateStr: string, range: string): boolean {
  if (range === "all") return true;
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === "today") return d >= today && d < new Date(today.getTime() + 86400000);
  if (range === "yesterday") { const y = new Date(today); y.setDate(y.getDate() - 1); return d >= y && d < today; }
  if (range === "last7") { const w = new Date(today); w.setDate(w.getDate() - 7); return d >= w; }
  if (range === "thisMonth") return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  if (range === "thisYear") return d.getFullYear() === now.getFullYear();
  if (range === "upcoming7") { const w = new Date(today); w.setDate(w.getDate() + 7); return d >= today && d <= w; }
  if (range === "overdue") return d < today;
  if (range === "none") return false;
  return true;
}

function FilterPopoverInner(props: any) { const { t } = useI18n(); return <FilterPopoverBody {...props} t={t} />; }
const FilterPopover = FilterPopoverInner;
function FilterPopoverBody({ filters, onChange, columns, staffUsers, currentUserId, leads, sourceOptions, facetNationalities, facetAgents, t }: {
  filters: LeadFilters;
  onChange: (f: LeadFilters) => void;
  columns: ColDef[];
  staffUsers: any[];
  t: (k: string) => string;
  currentUserId?: number;
  leads: any[];
  sourceOptions: LeadSourceOption[];
  facetNationalities?: string[];
  facetAgents?: Array<{ id: number; name: string }>;
}) {
  const [open, setOpen] = useState(false);
  const hasActive = Object.entries(filters).some(([, v]) => v !== "all");

  const uniqueNationalities = useMemo(() => {
    const set = new Set<string>();
    leads.forEach((l: any) => { if (l.nationality) set.add(l.nationality); });
    return facetNationalities?.length ? facetNationalities : Array.from(set).sort();
  }, [leads, facetNationalities]);

  const uniqueAgents = useMemo(() => {
    const map = new Map<number, string>();
    leads.forEach((l: any) => { if (l.agentId && l.agentName) map.set(l.agentId, l.agentName); });
    return facetAgents?.length
      ? facetAgents.map((agent) => [agent.id, agent.name] as [number, string])
      : Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [leads, facetAgents]);

  return (
    <>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="icon" className={`rounded-full relative ${hasActive ? "border-primary text-primary bg-primary/5" : ""}`}>
          <Filter className="w-4 h-4" />
          {hasActive && <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-primary" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-4 space-y-3 max-h-[70vh] overflow-y-auto" align="end">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">{t("leadsPage.filters")}</p>
          {hasActive && <Button variant="ghost" size="sm" className="h-6 text-xs text-muted-foreground" onClick={() => onChange({ ...DEFAULT_LEAD_FILTERS })}>{t("leadsPage.clear")}</Button>}
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">{t("leadsPage.source")}</Label>
          <Select value={filters.source} onValueChange={v => onChange({ ...filters, source: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("leadsPage.all")}</SelectItem>
              {sourceOptions.map(option => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">{t("leadsPage.stage")}</Label>
          <Select value={filters.status} onValueChange={v => onChange({ ...filters, status: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("leadsPage.all")}</SelectItem>
              {columns.map(c => (
                <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">{t("leadsPage.nationality")}</Label>
          <Select value={filters.nationality} onValueChange={v => onChange({ ...filters, nationality: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-60">
              <SelectItem value="all">{t("leadsPage.all")}</SelectItem>
              {uniqueNationalities.map(n => <SelectItem key={n} value={n}>{n}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">{t("leadsPage.agentLabel")}</Label>
          <Select value={filters.agent} onValueChange={v => onChange({ ...filters, agent: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-60">
              <SelectItem value="all">{t("leadsPage.all")}</SelectItem>
              <SelectItem value="none">{t("leadsPage.noAgent")}</SelectItem>
              {uniqueAgents.map(([id, name]) => <SelectItem key={id} value={String(id)}>{name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">{t("leadsPage.origin")}</Label>
          <Select value={filters.originType} onValueChange={v => onChange({ ...filters, originType: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("leadsPage.all")}</SelectItem>
              <SelectItem value="direct">{t("leadsPage.direct")}</SelectItem>
              <SelectItem value="agent">{t("leadsPage.agentLabel")}</SelectItem>
              <SelectItem value="sub_agent">{t("leadsPage.subAgent")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">{t("leadsPage.assignedTo")}</Label>
          <Select value={filters.assignment} onValueChange={v => onChange({ ...filters, assignment: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("leadsPage.all")}</SelectItem>
              <SelectItem value="mine">{t("leadsPage.me")}</SelectItem>
              <SelectItem value="unassigned">{t("leadsPage.unassigned")}</SelectItem>
              <SelectItem value="mine_unassigned">{t("leadsPage.meUnassigned")}</SelectItem>
              {staffUsers.filter(u => u.id !== currentUserId).map((u: any) => (
                <SelectItem key={u.id} value={String(u.id)}>
                  {`${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">{t("leadsPage.applications")}</Label>
          <Select value={filters.appSource} onValueChange={v => onChange({ ...filters, appSource: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("leadsPage.all")}</SelectItem>
              <SelectItem value="agent">{t("leadsPage.agentLabel")}</SelectItem>
              <SelectItem value="staff">{t("leadsPage.staff")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">{t("leadsPage.origin")}</Label>
          <Select value={filters.originType} onValueChange={v => onChange({ ...filters, originType: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("leadsPage.all")}</SelectItem>
              <SelectItem value="direct">{t("leadsPage.direct")}</SelectItem>
              <SelectItem value="agent">{t("leadsPage.agentLabel")}</SelectItem>
              <SelectItem value="sub_agent">{t("leadsPage.subAgent")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">{t("leadsPage.createdDate")}</Label>
          <Select value={filters.dateRange} onValueChange={v => onChange({ ...filters, dateRange: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("leadsPage.all")}</SelectItem>
              <SelectItem value="today">{t("leadsPage.today")}</SelectItem>
              <SelectItem value="yesterday">{t("leadsPage.yesterday")}</SelectItem>
              <SelectItem value="last7">{t("leadsPage.last7Days")}</SelectItem>
              <SelectItem value="thisMonth">{t("leadsPage.thisMonth")}</SelectItem>
              <SelectItem value="thisYear">{t("leadsPage.thisYear")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">{t("leadsPage.nextFollowup")}</Label>
          <Select value={filters.followupRange} onValueChange={v => onChange({ ...filters, followupRange: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("leadsPage.all")}</SelectItem>
              <SelectItem value="overdue">{t("leadsPage.overdue")}</SelectItem>
              <SelectItem value="today">{t("leadsPage.today")}</SelectItem>
              <SelectItem value="upcoming7">{t("leadsPage.next7Days")}</SelectItem>
              <SelectItem value="none">{t("leadsPage.notSet")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button size="sm" className="w-full" onClick={() => setOpen(false)}>{t("leadsPage.apply")}</Button>
      </PopoverContent>
    </Popover>
    </>
  );
}

/* ── NationalityCombobox ──────────────────────────────────── */
function NationalityCombobox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useI18n();
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
        placeholder={value || t("leadsPage.selectOrType")}
        autoComplete="off"
      />
      {open && (
        <div className="absolute z-[9999] mt-1 w-full bg-popover border rounded-md shadow-lg max-h-48 overflow-y-auto">
          {filtered.length === 0 && <div className="p-3 text-sm text-muted-foreground text-center">{searchVal ? t("leadsPage.noMatchCustomOk") : t("leadsPage.noCountriesLoaded")}</div>}
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
  const { t } = useI18n();
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
          {localSelected.length === 0 ? t("leadsPage.selectCountries") : localSelected.length === 1 ? localSelected[0] : t("leadsPage.countriesSelected", { n: localSelected.length })}
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
          {activeDestinations.length === 0 && <div className="p-3 text-sm text-muted-foreground text-center">{t("leadsPage.noActiveDestinations")}</div>}
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
function EditLeadDialog(props: any) { const { t } = useI18n(); return <EditLeadDialogBody {...props} t={t} />; }
function EditLeadDialogBody({ open, onClose, lead, canSeeRevenue, columns, t }: {
  open: boolean; onClose: () => void; lead: any; canSeeRevenue: boolean; columns: ColDef[]; t: (k: string) => string;
}) {
  const [form, setForm] = useState({ ...EMPTY_FORM, status: "new" });
  const updateLead = useUpdateLead();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { levels: studyLevels } = useStudyLevels();

  useEffect(() => {
    if (open && lead) {
      const edu = (lead.educationData as any) ?? {};
      setForm({
        firstName: lead.firstName || "",
        lastName: lead.lastName || "",
        email: lead.email || "",
        phone: toPhoneFieldValue(lead.phoneE164 || lead.phone),
        source: lead.source || "website",
        interestedProgram: lead.interestedProgram || "",
        interestedUniversity: lead.interestedUniversity || "",
        interestedCountry: lead.interestedCountry || "",
        nationality: lead.nationality || "",
        estimatedValue: lead.estimatedValue ? String(lead.estimatedValue) : "",
        status: lead.status || "new",
        interestedLevel: lead.interestedLevel || "",
        eduSchoolName: edu.schoolName || "",
        eduCountry: edu.country || "",
        eduCity: edu.city || "",
        eduFieldOfStudy: edu.fieldOfStudy || "",
        eduStartYear: edu.startYear ? String(edu.startYear) : "",
        eduEndYear: edu.endYear ? String(edu.endYear) : "",
        eduGpa: edu.gpa || "",
        eduLanguageScore: edu.languageScore || "",
      });
    }
  }, [open, lead]);

  function handleSave() {
    if (!lead || !form.firstName || !form.lastName || !isPhoneFieldValid(form.phone)) return;
    const { eduSchoolName, eduCountry, eduCity, eduFieldOfStudy, eduStartYear, eduEndYear, eduGpa, eduLanguageScore, ...rest } = form;
    const payload: any = { ...rest, phone: form.phone || "" };
    const parsedVal = parseFloat(form.estimatedValue);
    if (form.estimatedValue && !isNaN(parsedVal)) payload.estimatedValue = parsedVal;
    else delete payload.estimatedValue;
    if (eduSchoolName || eduCountry || eduCity || eduFieldOfStudy || eduStartYear || eduEndYear || eduGpa || eduLanguageScore) {
      payload.educationData = {
        schoolName: eduSchoolName || null,
        country: eduCountry || null,
        city: eduCity || null,
        fieldOfStudy: eduFieldOfStudy || null,
        startYear: eduStartYear ? Number(eduStartYear) : null,
        endYear: eduEndYear ? Number(eduEndYear) : null,
        gpa: eduGpa || null,
        languageScore: eduLanguageScore || null,
      };
    }

    updateLead.mutate(
      { id: lead.id, data: payload },
      {
        onSuccess: () => {
          toast({ title: t("leadsPage.leadUpdated") });
          queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
          onClose();
        },
        onError: () => {
          toast({ title: t("common.error"), description: t("leadsPage.failedToUpdateLead"), variant: "destructive" });
        },
      }
    );
  }

  return (
    <>
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>{t("leadsPage.editLead")}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-2">
          <div className="space-y-1.5">
            <Label>{t("leadsPage.firstNameRequired")}</Label>
            <Input value={form.firstName} onChange={e => setForm({ ...form, firstName: toLatinUpper(e.target.value) })} className="uppercase" />
          </div>
          <div className="space-y-1.5">
            <Label>{t("leadsPage.lastNameRequired")}</Label>
            <Input value={form.lastName} onChange={e => setForm({ ...form, lastName: toLatinUpper(e.target.value) })} className="uppercase" />
          </div>
          <div className="space-y-1.5">
            <Label>{t("leadsPage.emailRequired")}</Label>
            <Input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("leadsPage.phoneRequired")}</Label>
            <PhoneField value={form.phone} onChange={v => setForm({ ...form, phone: v })} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("leadsPage.nationality")}</Label>
            <NationalityCombobox value={form.nationality} onChange={v => setForm({ ...form, nationality: v })} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("leadsPage.source")}</Label>
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
            <Label>{t("leadsPage.status")}</Label>
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
            <Label>{t("leadsPage.interestedProgram")}</Label>
            <Input value={form.interestedProgram} onChange={e => setForm({ ...form, interestedProgram: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("leadsPage.interestedUniversity")}</Label>
            <Input value={form.interestedUniversity} onChange={e => setForm({ ...form, interestedUniversity: e.target.value })} />
          </div>
          <div className="space-y-1.5 col-span-2">
            <Label>{t("leadsPage.interestedCountry")}</Label>
            <MultiCountrySelect value={form.interestedCountry} onChange={v => setForm({ ...form, interestedCountry: v })} />
          </div>
          <div className="space-y-1.5 col-span-2">
            <Label>{t("studentsPage.interestedLevel")}</Label>
            <Select value={form.interestedLevel} onValueChange={v => setForm({ ...form, interestedLevel: v })}>
              <SelectTrigger className="rounded-xl h-9"><SelectValue placeholder="Select level..." /></SelectTrigger>
              <SelectContent>
                {studyLevels.map(l => <SelectItem key={l.key} value={l.key}>{l.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {(() => {
            const lvl = (form.interestedLevel || "").toLowerCase();
            const isBachelor = /bachelor|associate|certificate/.test(lvl);
            const isMaster = /master/.test(lvl);
            const isPhd = /phd|doctor|doctorate/.test(lvl);
            if (!isBachelor && !isMaster && !isPhd) return null;
            const priorLabel = isBachelor ? t("studentDetailPage.eduLevelHS") : isMaster ? t("studentDetailPage.eduLevelBachelor") : t("studentDetailPage.eduLevelMaster");
            return (
              <div className="col-span-2 space-y-2 pt-1 border-t">
                <p className="text-xs font-medium text-muted-foreground">{t("leadsPage.priorEducation")} — {priorLabel}</p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1"><Label className="text-xs">{t("studentDetailPage.eduSchoolName")}</Label><Input className="h-8 text-sm" value={form.eduSchoolName} onChange={e => setForm({ ...form, eduSchoolName: e.target.value })} /></div>
                  <div className="space-y-1"><Label className="text-xs">{t("studentDetailPage.eduCountry")}</Label><Input className="h-8 text-sm" value={form.eduCountry} onChange={e => setForm({ ...form, eduCountry: e.target.value })} /></div>
                  <div className="space-y-1"><Label className="text-xs">{t("studentDetailPage.eduCity")}</Label><Input className="h-8 text-sm" value={form.eduCity} onChange={e => setForm({ ...form, eduCity: e.target.value })} /></div>
                  <div className="space-y-1"><Label className="text-xs">{t("studentDetailPage.eduFieldOfStudy")}</Label><Input className="h-8 text-sm" value={form.eduFieldOfStudy} onChange={e => setForm({ ...form, eduFieldOfStudy: e.target.value })} /></div>
                  <div className="space-y-1"><Label className="text-xs">{t("studentDetailPage.eduStartYear")}</Label><Input type="number" className="h-8 text-sm" value={form.eduStartYear} onChange={e => setForm({ ...form, eduStartYear: e.target.value })} placeholder="2018" /></div>
                  <div className="space-y-1"><Label className="text-xs">{t("studentDetailPage.eduEndYear")}</Label><Input type="number" className="h-8 text-sm" value={form.eduEndYear} onChange={e => setForm({ ...form, eduEndYear: e.target.value })} placeholder="2022" /></div>
                  <div className="space-y-1"><Label className="text-xs">{t("studentDetailPage.eduGpa")}</Label><Input className="h-8 text-sm" value={form.eduGpa} onChange={e => setForm({ ...form, eduGpa: e.target.value })} placeholder="3.50 / 85" /></div>
                  <div className="space-y-1"><Label className="text-xs">{t("studentDetailPage.eduLanguageScore")}</Label><Input className="h-8 text-sm" value={form.eduLanguageScore} onChange={e => setForm({ ...form, eduLanguageScore: e.target.value })} placeholder="IELTS 6.5" /></div>
                </div>
              </div>
            );
          })()}
          {canSeeRevenue && (
            <div className="space-y-1.5 col-span-2">
              <Label className="flex items-center gap-1.5">
                <TrendingUp className="w-3.5 h-3.5 text-emerald-500" />
                {t("leadsPage.estimatedValueUsd")}
              </Label>
              <Input type="number" min="0" step="100" value={form.estimatedValue} onChange={e => setForm({ ...form, estimatedValue: e.target.value })} />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("leadsPage.cancel")}</Button>
          <Button onClick={handleSave} disabled={updateLead.isPending || !form.firstName || !form.lastName}>
            {updateLead.isPending ? t("common.saving") : t("leadsPage.saveChanges")}
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
  const { t } = useI18n();
  return (
    <>
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("leadsPage.deleteLeadsTitle", { count })}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground py-2">
          {t("leadsPage.deleteLeadsWarning", { count })}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("leadsPage.cancel")}</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={isPending}>
            {isPending ? t("leadsPage.deleting") : t("leadsPage.deleteLeadsConfirm", { count })}
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


/* ── EMPTY_FORM ───────────────────────────────────────────── */
const EMPTY_FORM = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  source: "website",
  interestedProgram: "",
  interestedUniversity: "",
  interestedCountry: "",
  nationality: "",
  estimatedValue: "",
  status: "new",
  interestedLevel: "",
  // Prior-education fields (level-conditional)
  eduSchoolName: "",
  eduCountry: "",
  eduCity: "",
  eduFieldOfStudy: "",
  eduStartYear: "",
  eduEndYear: "",
  eduGpa: "",
  eduLanguageScore: "",
};

/* ── LeadsPage ────────────────────────────────────────────── */
const SAMPLE_CSV_LEADS = `firstName,lastName,email,phone,nationality,interestedProgram,interestedUniversity,interestedCountry,source,estimatedValue
John,Doe,john@example.com,+1-555-0001,American,Computer Science,MIT,USA,website,5000
Jane,Smith,jane@example.com,+44-20-0002,British,Business Administration,Oxford,UK,referral,7500`;

function LeadBulkImportModal({ open, onClose, onSuccess }: { open: boolean; onClose: () => void; onSuccess: () => void; }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [preview, setPreview] = useState<any[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ success: number; errors: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleClose() {
    setCsvFile(null);
    setParsing(false);
    setPreview(null);
    setImporting(false);
    setResult(null);
    onClose();
  }

  async function fileToCsv(file: File): Promise<string> {
    const isExcel = /\.(xlsx|xls)$/i.test(file.name);
    if (!isExcel) return file.text();
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const firstSheet = wb.SheetNames[0];
    if (!firstSheet) throw new Error(t("leadsPage.csvParsingFailed"));
    return XLSX.utils.sheet_to_csv(wb.Sheets[firstSheet]);
  }

  async function parseCSV(file: File) {
    setParsing(true);
    setPreview(null);
    try {
      const text = await fileToCsv(file);
      const res = await fetch(`${BASE_URL}/api/ai/extract-bulk-csv`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ csvData: text, entity: "lead" }),
      });
      if (!res.ok) throw new Error(t("leadsPage.csvParsingFailed"));
      const data = await res.json();
      setPreview(data.records || data.students || []);
    } catch (err: any) {
      toast({ title: t("leadsPage.csvParsingFailed"), description: err.message, variant: "destructive" });
    } finally {
      setParsing(false);
    }
  }

  async function importAll() {
    if (!preview) return;
    setImporting(true);
    try {
      const res = await fetch(`${BASE_URL}/api/leads/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ leads: preview }),
      });
      if (!res.ok) throw new Error(t("leadsPage.importFailed"));
      const data = await res.json();
      setResult({ success: data.success, errors: data.errors?.length || 0 });
      onSuccess();
    } catch (err: any) {
      toast({ title: t("leadsPage.importFailed"), description: err.message, variant: "destructive" });
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-5 pb-4 border-b border-border/50 shrink-0">
          <DialogTitle className="text-xl font-display flex items-center gap-2">
            <Users className="w-5 h-5 text-primary" />
            {t("leadsPage.bulkTitle")}
          </DialogTitle>
        </DialogHeader>

        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">
          {!result && (
            <>
              <div className="bg-gradient-to-br from-blue-50 to-violet-50 border border-blue-100 rounded-2xl p-4 flex items-start gap-3">
                <Sparkles className="w-5 h-5 text-blue-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-semibold">{t("leadsPage.bulkAiTitle")}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{t("leadsPage.bulkAiDesc")}</p>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-semibold">{t("leadsPage.bulkCsvFile")}</p>
                  <button
                    className="text-xs text-primary hover:underline flex items-center gap-1"
                    onClick={() => {
                      const wb = XLSX.read(SAMPLE_CSV_LEADS, { type: "string" });
                      const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
                      const blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = "sample_leads.xlsx";
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    <Download className="w-3 h-3" /> {t("leadsPage.bulkDownloadSample")}
                  </button>
                </div>

                {!csvFile ? (
                  <div
                    className="border-2 border-dashed border-border hover:border-primary/50 rounded-2xl p-8 text-center cursor-pointer transition-colors hover:bg-secondary/30"
                    onClick={() => inputRef.current?.click()}
                  >
                    <FileUp className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
                    <p className="text-sm font-semibold text-foreground">{t("leadsPage.bulkDropCsv")}</p>
                    <p className="text-xs text-muted-foreground mt-1">{t("leadsPage.bulkAcceptsCsv")}</p>
                    <input
                      ref={inputRef}
                      type="file"
                      accept=".csv,text/csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) { setCsvFile(f); parseCSV(f); }
                        e.target.value = "";
                      }}
                    />
                  </div>
                ) : (
                  <div className="flex items-center gap-3 p-3 bg-secondary/50 rounded-xl border border-border">
                    <FileText className="w-5 h-5 text-primary" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">{csvFile.name}</p>
                      <p className="text-xs text-muted-foreground">{Math.round(csvFile.size / 1024)}KB</p>
                    </div>
                    <button
                      onClick={() => { setCsvFile(null); setPreview(null); }}
                      className="text-muted-foreground hover:text-destructive transition-colors p-1"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>

              {parsing && (
                <div className="flex items-center gap-3 p-4 bg-violet-50 border border-violet-100 rounded-xl">
                  <Loader2 className="w-5 h-5 text-violet-500 animate-spin" />
                  <div>
                    <p className="text-sm font-semibold text-violet-700">{t("leadsPage.bulkParsing")}</p>
                    <p className="text-xs text-violet-600">{t("leadsPage.bulkParsingDesc")}</p>
                  </div>
                </div>
              )}

              {preview && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-semibold">
                      {t("leadsPage.bulkPreview")} — <span className="text-primary">{t("leadsPage.bulkLeadsCount", { count: preview.length })}</span>
                    </p>
                    <span className="text-xs text-muted-foreground">{t("leadsPage.bulkScrollReview")}</span>
                  </div>
                  <div className="border border-border rounded-xl overflow-hidden">
                    <div className="overflow-x-auto max-h-60">
                      <table className="w-full text-xs">
                        <thead className="bg-secondary/50 border-b border-border sticky top-0">
                          <tr>
                            {["#", t("leadsPage.bulkColFirst"), t("leadsPage.bulkColLast"), t("leadsPage.bulkColEmail"), t("leadsPage.bulkColPhone"), t("leadsPage.program"), t("leadsPage.country"), t("leadsPage.value")].map((h) => (
                              <th key={h} className="px-3 py-2 text-left font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/50">
                          {preview.map((s: any, i: number) => (
                            <tr key={i} className="hover:bg-secondary/20">
                              <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                              <td className="px-3 py-2 font-medium">{s.firstName || "—"}</td>
                              <td className="px-3 py-2">{s.lastName || "—"}</td>
                              <td className="px-3 py-2 text-muted-foreground max-w-[120px] truncate">{s.email || "—"}</td>
                              <td className="px-3 py-2">{s.phone || "—"}</td>
                              <td className="px-3 py-2">{s.interestedProgram || "—"}</td>
                              <td className="px-3 py-2">{s.interestedCountry || "—"}</td>
                              <td className="px-3 py-2">{s.estimatedValue || "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {result && (
            <div className="flex flex-col items-center justify-center py-12 gap-4 text-center">
              <div className="w-20 h-20 rounded-full bg-emerald-100 flex items-center justify-center">
                <CheckCircle2 className="w-10 h-10 text-emerald-500" />
              </div>
              <div>
                <p className="text-2xl font-display font-bold">{t("leadsPage.bulkImported", { count: result.success })}</p>
                {result.errors > 0 && (
                  <p className="text-sm text-destructive mt-1">{t("leadsPage.bulkRowsSkipped", { count: result.errors })}</p>
                )}
              </div>
              <Button onClick={handleClose} className="rounded-xl mt-2">{t("leadsPage.bulkDone")}</Button>
            </div>
          )}
        </div>

        {!result && (
          <div className="px-6 pb-5 pt-3 border-t border-border/50 flex items-center justify-between shrink-0">
            <Button variant="outline" onClick={handleClose} className="rounded-xl">{t("leadsPage.cancel")}</Button>
            <Button
              onClick={importAll}
              disabled={!preview || importing || preview.length === 0}
              className="rounded-xl gap-2"
            >
              {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Users className="w-4 h-4" />}
              {preview ? t("leadsPage.bulkImportBtn", { count: preview.length }) : t("leadsPage.bulkImportBtnEmpty")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function LeadsPage() {
  const { t } = useI18n();
  const dateFormat = useDateFormat();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [filters, setFilters] = useState<LeadFilters>({ ...DEFAULT_LEAD_FILTERS });
  const [colFilters, setColFilters] = useState({ name: "", email: "", program: "", country: "", value: "" });
  const { stages: pipelineStages } = usePipelineStages("lead");
  const [viewMode, setViewMode] = useState<"pipeline" | "list">(() => {
    return (localStorage.getItem(VIEW_KEY) as "pipeline" | "list") || "pipeline";
  });

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [messageCampaignOpen, setMessageCampaignOpen] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "date", dir: "desc" });
  const [editLead, setEditLead] = useState<any>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteInProgress, setDeleteInProgress] = useState(false);

  const pg = useTablePagination(25);

  const { user, hasPermission } = useAuth(true, [
    "super_admin", "admin", "manager", "staff", "consultant", "editor", "accountant",
  ]);
  const canSeeRevenue = hasPermission("leads.view_commission");
  const isAdmin = user?.role === "super_admin" || user?.role === "admin" || user?.role === "manager";
  const canMoveCards = hasPermission("records.move_cards");
  const canChangeStage = hasPermission("leads.change_stage");
  const canAssign = hasPermission("records.assign_button");
  const canReassign = !!isAdmin; // Task #494: non-admin relies on per-record current-assignee check

  // Persist the user's "Assigned to" choice locally (per user), like column prefs.
  const [persistedAssignment, setPersistedAssignment] = usePersistedFilterValue(
    "leads-table", "assignment_v2", DEFAULT_LEAD_FILTERS.assignment, user?.id,
  );
  // One-directional sync: adopt the persisted "Assigned to" choice into the
  // active filter whenever it is (re)stored — e.g. once auth resolves and the
  // per-user storage key becomes known. The guard keeps the filter object's
  // identity stable when nothing changed so dependent effects don't churn.
  // Persisting back to storage happens explicitly on user changes (see
  // changeAssignment / the FilterPopover handler) instead of via a second
  // mirroring effect — that removes the previous filter<->storage ping-pong.
  useEffect(() => {
    setFilters(f => (f.assignment === persistedAssignment ? f : { ...f, assignment: persistedAssignment }));
  }, [persistedAssignment]);

  const changeAssignment = useCallback((value: string) => {
    setFilters(f => (f.assignment === value ? f : { ...f, assignment: value }));
    setPersistedAssignment(value);
  }, [setPersistedAssignment]);

  const { season } = useSeason();
  const { levels: studyLevels } = useStudyLevels();
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  const leadListParams = useMemo(() => ({
    search: debouncedSearch || undefined,
    season,
    page: viewMode === "list" ? pg.page : 1,
    limit: viewMode === "list" ? pg.pageSize : 500,
    status: filters.status !== "all" ? filters.status : undefined,
    source: filters.source !== "all" ? filters.source : undefined,
    appSource: filters.appSource !== "all" ? filters.appSource : undefined,
    assignment: filters.assignment !== "all" ? filters.assignment : undefined,
    nationality: filters.nationality !== "all" ? filters.nationality : undefined,
    agentId: filters.agent !== "all" ? filters.agent : undefined,
    originType: filters.originType !== "all" ? filters.originType : undefined,
    dateRange: filters.dateRange !== "all" ? filters.dateRange : undefined,
    followupRange: filters.followupRange !== "all" ? filters.followupRange : undefined,
    name: colFilters.name || undefined,
    email: colFilters.email || undefined,
    program: colFilters.program || undefined,
    country: colFilters.country || undefined,
    minValue: colFilters.value || undefined,
    sortKey: sort.key,
    sortDir: sort.dir,
    includeFacets: pg.page === 1 ? 1 : 0,
  }), [debouncedSearch, season, viewMode, pg.page, pg.pageSize, filters, colFilters, sort]);
  const { data, isLoading } = useListLeads(leadListParams as any);
  const leadFacetScopeKey = useMemo(() => {
    const { page: _page, limit: _limit, includeFacets: _includeFacets, ...scope } = leadListParams as any;
    return JSON.stringify(scope);
  }, [leadListParams]);
  const leadAggregateCache = useRef<{
    key: string;
    statusCounts: Record<string, number>;
    facets?: { nationalities?: string[]; agents?: Array<{ id: number; name: string }> };
  } | null>(null);
  const leadAggregates = useMemo(() => {
    const meta = (data as any)?.meta;
    if (meta?.facets) {
      const next = {
        key: leadFacetScopeKey,
        statusCounts: (meta.statusCounts || {}) as Record<string, number>,
        facets: meta.facets as { nationalities?: string[]; agents?: Array<{ id: number; name: string }> },
      };
      leadAggregateCache.current = next;
      return next;
    }
    return leadAggregateCache.current?.key === leadFacetScopeKey
      ? leadAggregateCache.current
      : { key: leadFacetScopeKey, statusCounts: {}, facets: undefined };
  }, [data, leadFacetScopeKey]);

  const { data: staffUsersData } = useQuery({
    queryKey: ["staff-users-list"],
    queryFn: () => customFetch("/api/users?roles=super_admin,admin,manager,staff,consultant,accountant,editor&limit=100") as Promise<any>,
    staleTime: 5 * 60 * 1000,
  });
  const { data: leadSourcesData } = useQuery<{ data: LeadSourceOption[] }>({
    queryKey: ["lead-distinct-sources"],
    queryFn: () => customFetch("/api/leads/distinct-sources") as Promise<{ data: LeadSourceOption[] }>,
    staleTime: 5 * 60 * 1000,
  });
  const sourceFilterOptions = useMemo(
    () => buildLeadSourceFilterOptions(leadSourcesData?.data, filters.source),
    [leadSourcesData?.data, filters.source],
  );
  const staffUsers = staffUsersData
    ? (Array.isArray(staffUsersData) ? staffUsersData : staffUsersData?.data || []).filter((u: any) => ["super_admin", "admin", "manager", "staff", "consultant", "accountant", "editor"].includes(u.role))
    : [];
  const queryClient = useQueryClient();
  const updateLead = useUpdateLead();
  const createLead = useCreateLead();
  const deleteLead = useDeleteLead();

  const staffUsersMap = useMemo(() => {
    const m: Record<number, string> = {};
    staffUsers.forEach((u: any) => { m[u.id] = `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email; });
    return m;
  }, [staffUsers]);

  const staffUsersList = useMemo(() =>
    staffUsers.map((u: any) => ({ id: u.id, name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email })),
    [staffUsers]
  );

  async function handleAssign(leadId: number, userId: number) {
    try {
      await customFetch(`/api/leads/${leadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignedTo: userId }),
      });
      queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
      toast({ title: t("leadsPage.leadAssigned") });
    } catch (err: any) {
      toast({ title: t("common.error"), description: err.message, variant: "destructive" });
    }
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
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
    if (colFilters.name) {
      const fullName = `${l.firstName || ""} ${l.lastName || ""}`.toUpperCase();
      const needle = toLatinUpper(colFilters.name);
      if (!fullName.includes(needle)) return false;
    }
    if (colFilters.email && !(l.email || "").toLowerCase().includes(colFilters.email.toLowerCase())) return false;
    if (colFilters.program && !(l.interestedProgram || "").toLowerCase().includes(colFilters.program.toLowerCase())) return false;
    if (colFilters.country && !(l.interestedCountry || "").toLowerCase().includes(colFilters.country.toLowerCase())) return false;
    if (colFilters.value) {
      const minVal = parseFloat(colFilters.value);
      if (!isNaN(minVal) && (parseFloat(l.estimatedValue) || 0) < minVal) return false;
    }
    if (filters.source !== "all" && l.source !== filters.source) return false;
    if (filters.status !== "all" && l.status !== filters.status) return false;
    if (filters.appSource === "agent" && !l.agentId) return false;
    if (filters.appSource === "staff" && l.agentId) return false;
    if (filters.assignment === "mine" && l.assignedToId !== user?.id) return false;
    if (filters.assignment === "unassigned" && l.assignedToId != null) return false;
    if (filters.assignment === "mine_unassigned" && !(l.assignedToId === user?.id || l.assignedToId == null)) return false;
    if (filters.assignment !== "all" && filters.assignment !== "mine" && filters.assignment !== "unassigned" && filters.assignment !== "mine_unassigned" && !isNaN(Number(filters.assignment)) && l.assignedToId !== Number(filters.assignment)) return false;
    if (filters.nationality !== "all" && (l.nationality || "") !== filters.nationality) return false;
    if (filters.agent !== "all") {
      if (filters.agent === "none") { if (l.agentId) return false; }
      else if (String(l.agentId) !== filters.agent) return false;
    }
    if (filters.originType !== "all" && (l.originType || "direct") !== filters.originType) return false;
    if (filters.dateRange !== "all" && l.createdAt && !leadIsDateInRange(l.createdAt, filters.dateRange)) return false;
    if (filters.followupRange !== "all") {
      if (filters.followupRange === "none") { if (l.nextFollowup) return false; }
      else if (!l.nextFollowup) return false;
      else if (!leadIsDateInRange(l.nextFollowup, filters.followupRange)) return false;
    }
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

  const pagedLeads = sortedLeads;
  const totalLeadsCount = Number((data as any)?.meta?.total ?? sortedLeads.length);
  const leadStatusCounts = leadAggregates.statusCounts;
  const leadFacets = leadAggregates.facets;

  useEffect(() => { pg.setPage(1); setSelectedIds(new Set()); }, [search, filters, colFilters, sort]);

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

  async function handleBulkDelete() {
    setDeleteInProgress(true);
    try {
      const res = await fetch(`${BASE_URL}/api/leads/bulk-action`, { method: "POST", headers: { "Content-Type": "application/json", "x-csrf-token": getCsrfToken() }, credentials: "include", body: JSON.stringify({ ids: Array.from(selectedIds), action: "delete" }) });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      toast({ title: t("leadsPage.leadsDeleted", { count: data.updated }) });
    } catch { toast({ title: t("leadsPage.someLeadsNotDeleted"), variant: "destructive" }); }
    setDeleteInProgress(false); setDeleteOpen(false); setSelectedIds(new Set());
    queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
  }

  async function handleBulkAssign(userId: number) {
    try {
      const res = await fetch(`${BASE_URL}/api/leads/bulk-action`, { method: "POST", headers: { "Content-Type": "application/json", "x-csrf-token": getCsrfToken() }, credentials: "include", body: JSON.stringify({ ids: Array.from(selectedIds), action: "assign", assignedToId: userId }) });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      toast({ title: t("leadsPage.leadsAssigned", { count: data.updated }) });
    } catch { toast({ title: t("leadsPage.couldNotAssignLeads"), variant: "destructive" }); }
    setSelectedIds(new Set());
    queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
  }

  async function handleBulkMove(status: string) {
    try {
      const res = await fetch(`${BASE_URL}/api/leads/bulk-action`, { method: "POST", headers: { "Content-Type": "application/json", "x-csrf-token": getCsrfToken() }, credentials: "include", body: JSON.stringify({ ids: Array.from(selectedIds), action: "move", status }) });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      toast({ title: t("leadsPage.leadsMoved", { count: data.updated }) });
    } catch { toast({ title: t("leadsPage.couldNotMoveLeads"), variant: "destructive" }); }
    setSelectedIds(new Set());
    queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
  }

  const handleDragStart = (event: DragStartEvent) => setActiveId(event.active.id as number);

  const isMainStaff = user?.role && !["agent", "sub_agent", "student"].includes(user.role);

  const isSuperAdmin = user?.role === "super_admin";

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    if (!over) return;

    if (!canMoveCards) {
      toast({ title: t("leadsPage.noPermissionMoveCards"), variant: "destructive" });
      return;
    }

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

    if (isWonColumn && isMainStaff) {
      try {
        const result = await customFetch(`/api/leads/${leadId}/convert`, { method: "POST" }) as any;
        await Promise.all([
          queryClient.refetchQueries({ queryKey: ["/api/leads"] }),
          queryClient.refetchQueries({ queryKey: ["/api/students"] }),
        ]);
        if (result.alreadyConverted) {
          toast({ title: t("leadsPage.leadAlreadyConverted"), description: t("leadsPage.leadAlreadyConvertedDesc") });
        } else {
          const studentName = `${result.student?.firstName || ""} ${result.student?.lastName || ""}`.trim();
          toast({
            title: t("leadsPage.leadConverted"),
            description: result.merged
              ? t("leadsPage.mergedWithStudent", { name: studentName })
              : t("leadsPage.newStudentCreated", { name: studentName }),
          });
        }
      } catch (err: any) {
        toast({ title: t("leadsPage.conversionFailed"), description: err.message || t("leadsPage.failedToConvertLead"), variant: "destructive" });
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
          toast({ title: t("leadsPage.leadMovedTo", { stage: colLabel }) });
        },
        onError: () => {
          toast({ title: t("common.error"), description: t("leadsPage.failedToMoveLead"), variant: "destructive" });
          queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
          queryClient.invalidateQueries({ queryKey: [`/api/leads/${leadId}`] });
        },
      }
    );
  };

  function handleCreate() {
    if (!form.firstName || !form.lastName || !form.email || !isPhoneFieldValid(form.phone, true)) return;
    const defaultStatus = pipelineStages.length > 0 ? pipelineStages[0].key : "new";
    const { eduSchoolName, eduCountry, eduCity, eduFieldOfStudy, eduStartYear, eduEndYear, eduGpa, eduLanguageScore, ...restForm } = form;
    const payload: any = { ...restForm, status: defaultStatus, season };
    const parsedCreate = parseFloat(form.estimatedValue);
    if (form.estimatedValue && !isNaN(parsedCreate)) payload.estimatedValue = parsedCreate;
    else delete payload.estimatedValue;
    if (eduSchoolName || eduCountry || eduCity || eduFieldOfStudy || eduStartYear || eduEndYear || eduGpa || eduLanguageScore) {
      payload.educationData = {
        schoolName: eduSchoolName || null,
        country: eduCountry || null,
        city: eduCity || null,
        fieldOfStudy: eduFieldOfStudy || null,
        startYear: eduStartYear ? Number(eduStartYear) : null,
        endYear: eduEndYear ? Number(eduEndYear) : null,
        gpa: eduGpa || null,
        languageScore: eduLanguageScore || null,
      };
    }

    createLead.mutate(
      { data: payload },
      {
        onSuccess: () => {
          toast({ title: t("leadsPage.leadCreated") });
          setCreateOpen(false);
          setForm(EMPTY_FORM);
          queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
        },
        onError: (err: any) => {
          toast({
            title: t("common.error"),
            description: isNonLatinNameError(err) ? t("common.latinOnlyName") : err?.message,
            variant: "destructive",
          });
        },
      }
    );
  }

  if (isLoading) {
    return (
      <>
        <TableSkeleton />
      </>
    );
  }

  return (
    <>
      <div className="h-[calc(100vh-8rem)] flex flex-col">
        {/* ── Header ─────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 shrink-0">
          <div className="flex items-center gap-3">
            <div>
              <h1 className="text-3xl font-display font-bold text-foreground">{t("staffLeads.title")}</h1>
              <p className="text-muted-foreground text-sm mt-1">{t("staffLeads.subtitle")}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder={t("leadsPage.searchLeads")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 bg-white dark:bg-black/20 border-border rounded-full"
              />
            </div>
            <FilterPopover
              filters={filters}
              onChange={(next: LeadFilters) => { if (next.assignment !== filters.assignment) setPersistedAssignment(next.assignment); setFilters(next); }}
              columns={columns}
              staffUsers={staffUsers}
              currentUserId={user?.id}
              leads={allLeads}
              sourceOptions={sourceFilterOptions}
              facetNationalities={leadFacets?.nationalities}
              facetAgents={leadFacets?.agents}
            />

            <div className="flex items-center border rounded-full overflow-hidden">
              <button
                onClick={() => toggleView("pipeline")}
                className={`p-2 transition-colors ${viewMode === "pipeline" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}
                title={t("leadsPage.pipelineView")}
              >
                <LayoutGrid className="w-4 h-4" />
              </button>
              <button
                onClick={() => toggleView("list")}
                className={`p-2 transition-colors ${viewMode === "list" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}
                title={t("leadsPage.listView")}
              >
                <List className="w-4 h-4" />
              </button>
            </div>

            <BulkActionBar
              selectedCount={selectedIds.size}
              onDelete={(isAdmin || hasPermission("leads.delete")) ? () => setDeleteOpen(true) : undefined}
              onAssign={handleBulkAssign}
              onMove={handleBulkMove}
              onSendMessage={() => setMessageCampaignOpen(true)}
              stages={pipelineStages.map(s => ({ key: s.key, label: s.label }))}
              staffUsers={canReassign ? staffUsersList : []}
              entityLabel={t("leadsPage.entityLeads")}
              moveLabel={t("leadsPage.moveStatus")}
            />

            {isAdmin && (
              <Button variant="outline" size="sm" className="rounded-full h-8 gap-1.5" onClick={() => { const a = document.createElement("a"); const idsParam = selectedIds.size > 0 ? `&ids=${Array.from(selectedIds).join(",")}` : ""; a.href = `${BASE_URL}/api/export/leads?season=${encodeURIComponent(season || "")}${idsParam}`; a.click(); }}>
                <Download className="w-3.5 h-3.5" /> {t("leadsPage.excel")}
              </Button>
            )}
            {(isAdmin || hasPermission("leads.import")) && (
              <Button variant="outline" className="rounded-full gap-2 border-primary/30 text-primary hover:bg-primary/5" onClick={() => setBulkOpen(true)}>
                <FileUp className="w-4 h-4" /> {t("leadsPage.bulkImport")}
              </Button>
            )}
            <Button className="rounded-full shadow-lg shadow-primary/20" onClick={() => setCreateOpen(true)}>
              <Plus className="w-4 h-4 mr-2" /> {t("leadsPage.addLead")}
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
                  const columnLeads = filteredLeads.filter((l: any) => l.status === col.id).sort((a: any, b: any) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
                  return (
                    <DroppableColumn
                      key={col.id}
                      col={col}
                      leads={columnLeads}
                      totalCount={leadStatusCounts[col.id]}
                      showRevenue={canSeeRevenue}
                      onView={(id) => setLocation(`/staff/leads/${id}`)}
                      staffUsersMap={staffUsersMap}
                      onAssign={handleAssign}
                      staffUsersList={staffUsersList}
                      currentUserId={user?.id}
                      canAssign={canAssign}
                      canReassign={canReassign}
                      canMoveCards={canMoveCards}
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
                        {activeCard.email || activeCard.phone || t("leadsPage.noContactInfo")}
                      </p>
                      {activeCard.interestedProgram && (
                        <p className="text-xs font-medium text-primary mt-2 bg-primary/5 block max-w-full px-2 py-1 rounded-md leading-relaxed">
                          {activeCard.interestedProgram}
                        </p>
                      )}
                      {activeCard.interestedUniversity && (
                        <p className="text-xs text-muted-foreground mt-1 truncate" title={activeCard.interestedUniversity}>
                          {activeCard.interestedUniversity}
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
                    <ColumnHeader
                      label={t("common.name")}
                      sort={{ sortKey: "name", current: sort, onSort: handleSort }}
                    />
                    <ColumnHeader
                      label={t("common.email")}
                      sort={{ sortKey: "email", current: sort, onSort: handleSort }}
                    />
                    <ColumnHeader
                      label={t("leadsPage.status")}
                      sort={{ sortKey: "status", current: sort, onSort: handleSort }}
                      filter={{ type: "select", value: filters.status, onChange: v => setFilters(f => ({ ...f, status: v })), options: columns.map(c => ({ value: c.id, label: c.title })), label: t("leadsPage.status") }}
                    />
                    <ColumnHeader
                      label={t("leadsPage.source")}
                      sort={{ sortKey: "source", current: sort, onSort: handleSort }}
                      filter={{ type: "select", value: filters.source, onChange: v => setFilters(f => ({ ...f, source: v })), options: sourceFilterOptions, label: t("leadsPage.source") }}
                    />
                    <ColumnHeader
                      label={t("leadsPage.program")}
                      sort={{ sortKey: "program", current: sort, onSort: handleSort }}
                      filter={{ type: "text", value: colFilters.program, onChange: v => setColFilters(f => ({ ...f, program: v })), placeholder: t("leadsPage.filterByProgram"), label: t("leadsPage.programContains") }}
                    />
                    <ColumnHeader
                      label={t("leadsPage.country")}
                      sort={{ sortKey: "country", current: sort, onSort: handleSort }}
                      filter={{ type: "text", value: colFilters.country, onChange: v => setColFilters(f => ({ ...f, country: v })), placeholder: t("leadsPage.filterByCountry"), label: t("leadsPage.countryContains") }}
                    />
                    {canSeeRevenue && (
                      <ColumnHeader
                        label={t("leadsPage.value")}
                        sort={{ sortKey: "value", current: sort, onSort: handleSort }}
                        filter={{ type: "text", value: colFilters.value, onChange: v => setColFilters(f => ({ ...f, value: v })), placeholder: t("leadsPage.minValue"), label: t("leadsPage.minimumValue") }}
                      />
                    )}
                    <ColumnHeader
                      label={t("leadsPage.assigned")}
                      filter={{
                        type: "select",
                        value: filters.assignment,
                        onChange: changeAssignment,
                        options: [
                          { value: "mine", label: t("leadsPage.me") },
                          { value: "unassigned", label: t("leadsPage.unassigned") },
                          { value: "mine_unassigned", label: t("leadsPage.meUnassigned") },
                          ...staffUsersList.filter((u: any) => u.id !== user?.id).map((u: any) => ({ value: String(u.id), label: u.name })),
                        ],
                        label: t("leadsPage.assignedTo"),
                      }}
                    />
                    <ColumnHeader
                      label={t("leadsPage.created")}
                      sort={{ sortKey: "date", current: sort, onSort: handleSort }}
                      filter={{
                        type: "select",
                        value: filters.dateRange,
                        onChange: v => setFilters(f => ({ ...f, dateRange: v })),
                        options: [
                          { value: "today", label: t("leadsPage.today") },
                          { value: "yesterday", label: t("leadsPage.yesterday") },
                          { value: "last7", label: t("leadsPage.last7Days") },
                          { value: "thisMonth", label: t("leadsPage.thisMonth") },
                          { value: "thisYear", label: t("leadsPage.thisYear") },
                        ],
                        label: t("leadsPage.createdDate"),
                      }}
                    />
                    <TableHead className="w-20 text-right">{t("common.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow>
                      <TableCell colSpan={canSeeRevenue ? 11 : 10} className="text-center py-12 text-muted-foreground">
                        {t("common.loading")}
                      </TableCell>
                    </TableRow>
                  ) : pagedLeads.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={canSeeRevenue ? 11 : 10} className="text-center py-12 text-muted-foreground">
                        {t("leadsPage.noLeadsFound")}
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
                      <LinkedTableCell
                        href={`/staff/leads/${lead.id}`}
                        linkLabel={`Open ${lead.firstName} ${lead.lastName}`}
                        primary
                        className="font-medium"
                      >
                        <div className="flex items-center gap-2">
                          <LeadAvatar lead={lead} />
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span>{lead.firstName} {lead.lastName}</span>
                            <OriginBadge originType={lead.originType} originDisplayName={lead.originDisplayName} />
                          </div>
                        </div>
                      </LinkedTableCell>
                      <LinkedTableCell
                        href={`/staff/leads/${lead.id}`}
                        linkLabel={`Open ${lead.firstName} ${lead.lastName}`}
                        className="text-muted-foreground"
                      >
                        {lead.email || "-"}
                      </LinkedTableCell>
                      <LinkedTableCell href={`/staff/leads/${lead.id}`} linkLabel={`Open ${lead.firstName} ${lead.lastName}`}>
                        {(() => {
                          const sm = leadStageMap[lead.status];
                          const color = sm ? getLeadStageColor(sm, sm._index) : "bg-gray-100 text-gray-700 border-gray-200";
                          return <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${color}`}>{sm?.label || lead.status}</span>;
                        })()}
                      </LinkedTableCell>
                      <LinkedTableCell
                        href={`/staff/leads/${lead.id}`}
                        linkLabel={`Open ${lead.firstName} ${lead.lastName}`}
                        className="text-muted-foreground capitalize"
                      >
                        {lead.source?.replace(/_/g, " ") || "-"}
                      </LinkedTableCell>
                      <LinkedTableCell
                        href={`/staff/leads/${lead.id}`}
                        linkLabel={`Open ${lead.firstName} ${lead.lastName}`}
                        className="max-w-[250px]"
                      >
                        <span className="line-clamp-2" title={lead.interestedProgram || ""}>{lead.interestedProgram || "-"}</span>
                        {lead.interestedUniversity && (
                          <span className="block text-xs text-muted-foreground line-clamp-1" title={lead.interestedUniversity}>{lead.interestedUniversity}</span>
                        )}
                      </LinkedTableCell>
                      <LinkedTableCell href={`/staff/leads/${lead.id}`} linkLabel={`Open ${lead.firstName} ${lead.lastName}`}>
                        {lead.interestedCountry || "-"}
                      </LinkedTableCell>
                      {canSeeRevenue && (
                        <LinkedTableCell href={`/staff/leads/${lead.id}`} linkLabel={`Open ${lead.firstName} ${lead.lastName}`}>
                          {lead.estimatedValue ? (
                            <span className="text-emerald-600 font-medium">{formatCurrency(lead.estimatedValue)}</span>
                          ) : "-"}
                        </LinkedTableCell>
                      )}
                      <TableCell onClick={e => e.stopPropagation()}>
                        {lead.assignedToId ? (
                          (canReassign || lead.assignedToId === user?.id) ? (
                            <AssignPopover
                              assignedUserName={staffUsersMap[lead.assignedToId]}
                              staffUsers={staffUsersList}
                              currentUserId={user?.id}
                              onAssign={(userId) => handleAssign(lead.id, userId)}
                              size="list"
                            />
                          ) : (
                            <span className="text-xs text-muted-foreground truncate flex items-center gap-1">
                              <UserCheck2 className="w-3 h-3" />{staffUsersMap[lead.assignedToId] || t("leadsPage.assigned")}
                            </span>
                          )
                        ) : canReassign ? (
                          <AssignPopover
                            staffUsers={staffUsersList}
                            currentUserId={user?.id}
                            onAssign={(userId) => handleAssign(lead.id, userId)}
                            size="list"
                          />
                        ) : canAssign ? (
                          <button
                            onClick={e => { e.stopPropagation(); handleAssign(lead.id, user!.id); }}
                            className="text-[10px] text-primary hover:underline font-medium flex items-center gap-1"
                          >
                            <UserPlus className="w-3 h-3 shrink-0" />{t("leadsPage.assignToMe")}
                          </button>
                        ) : null}
                      </TableCell>
                      <LinkedTableCell
                        href={`/staff/leads/${lead.id}`}
                        linkLabel={`Open ${lead.firstName} ${lead.lastName}`}
                        className="text-muted-foreground text-xs"
                      >
                        {formatDate(lead.createdAt, dateFormat)}
                      </LinkedTableCell>
                      <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                        <RowActionsMenu
                          entityType="lead"
                          entityId={lead.id}
                          entityName={`${lead.firstName} ${lead.lastName}`}
                          currentAgentId={lead.agentId}
                          currentAgentName={lead.agentName}
                          currentAssignedToId={lead.assignedToId}
                          staffUsersMap={staffUsersMap}
                          staffUsersList={staffUsersList}
                          currentUserId={user?.id}
                          isAdmin={isAdmin}
                          canAssign={canAssign}
                          canReassign={canReassign}
                          onEdit={() => setEditLead(lead)}
                          onDelete={(isAdmin || hasPermission("leads.delete")) ? () => { setSelectedIds(new Set([lead.id])); setDeleteOpen(true); } : undefined}
                          onAssign={(uid) => handleAssign(lead.id, uid)}
                          onRefresh={() => queryClient.invalidateQueries({ queryKey: ["/api/leads"] })}
                        />
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
      <BulkMessageDialog
        open={messageCampaignOpen}
        onOpenChange={setMessageCampaignOpen}
        entityType="lead"
        entityIds={Array.from(selectedIds)}
        onCreated={() => setSelectedIds(new Set())}
      />

      {/* ── Create Lead Dialog ─────────────────────────────── */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>{t("leadsPage.addNewLead")}</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-4 py-2">
            <div className="space-y-1.5">
              <Label>{t("leadsPage.firstNameRequired")}</Label>
              <Input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: toLatinUpper(e.target.value) })} placeholder={t("leadsPage.firstNamePlaceholder")} className="uppercase" />
            </div>
            <div className="space-y-1.5">
              <Label>{t("leadsPage.lastNameRequired")}</Label>
              <Input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: toLatinUpper(e.target.value) })} placeholder={t("leadsPage.lastNamePlaceholder")} className="uppercase" />
            </div>
            <div className="space-y-1.5">
              <Label>{t("leadsPage.emailRequired")}</Label>
              <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="email@example.com" />
            </div>
            <div className="space-y-1.5">
              <Label>{t("leadsPage.phoneRequired")}</Label>
              <PhoneField value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("leadsPage.nationality")}</Label>
              <NationalityCombobox value={form.nationality} onChange={v => setForm({ ...form, nationality: v })} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("leadsPage.source")}</Label>
              <Select value={form.source} onValueChange={(v) => setForm({ ...form, source: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SOURCES.map((s) => (
                    <SelectItem key={s} value={s} className="capitalize">{s.replace(/_/g, " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 col-span-2">
              <Label>{t("leadsPage.interestedProgram")}</Label>
              <Input value={form.interestedProgram} onChange={(e) => setForm({ ...form, interestedProgram: e.target.value })} placeholder={t("leadsPage.interestedProgramPlaceholder")} />
            </div>
            <div className="space-y-1.5 col-span-2">
              <Label>{t("leadsPage.interestedUniversity")}</Label>
              <Input value={form.interestedUniversity} onChange={(e) => setForm({ ...form, interestedUniversity: e.target.value })} />
            </div>
            <div className="space-y-1.5 col-span-2">
              <Label>{t("leadsPage.interestedCountry")}</Label>
              <MultiCountrySelect value={form.interestedCountry} onChange={v => setForm({ ...form, interestedCountry: v })} />
            </div>
            <div className="space-y-1.5 col-span-2">
              <Label>{t("studentsPage.interestedLevel")}</Label>
              <Select value={form.interestedLevel} onValueChange={v => setForm({ ...form, interestedLevel: v })}>
                <SelectTrigger><SelectValue placeholder="Select level..." /></SelectTrigger>
                <SelectContent>
                  {studyLevels.map(l => <SelectItem key={l.key} value={l.key}>{l.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {(() => {
              const lvl = (form.interestedLevel || "").toLowerCase();
              const isBachelor = /bachelor|associate|certificate/.test(lvl);
              const isMaster = /master/.test(lvl);
              const isPhd = /phd|doctor|doctorate/.test(lvl);
              if (!isBachelor && !isMaster && !isPhd) return null;
              const priorLabel = isBachelor ? t("studentDetailPage.eduLevelHS") : isMaster ? t("studentDetailPage.eduLevelBachelor") : t("studentDetailPage.eduLevelMaster");
              return (
                <div className="col-span-2 space-y-2 pt-1 border-t">
                  <p className="text-xs font-medium text-muted-foreground">{t("leadsPage.priorEducation")} — {priorLabel}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1"><Label className="text-xs">{t("studentDetailPage.eduSchoolName")}</Label><Input className="h-8 text-sm" value={form.eduSchoolName} onChange={e => setForm({ ...form, eduSchoolName: e.target.value })} /></div>
                    <div className="space-y-1"><Label className="text-xs">{t("studentDetailPage.eduCountry")}</Label><Input className="h-8 text-sm" value={form.eduCountry} onChange={e => setForm({ ...form, eduCountry: e.target.value })} /></div>
                    <div className="space-y-1"><Label className="text-xs">{t("studentDetailPage.eduCity")}</Label><Input className="h-8 text-sm" value={form.eduCity} onChange={e => setForm({ ...form, eduCity: e.target.value })} /></div>
                    <div className="space-y-1"><Label className="text-xs">{t("studentDetailPage.eduFieldOfStudy")}</Label><Input className="h-8 text-sm" value={form.eduFieldOfStudy} onChange={e => setForm({ ...form, eduFieldOfStudy: e.target.value })} /></div>
                    <div className="space-y-1"><Label className="text-xs">{t("studentDetailPage.eduStartYear")}</Label><Input type="number" className="h-8 text-sm" value={form.eduStartYear} onChange={e => setForm({ ...form, eduStartYear: e.target.value })} placeholder="2018" /></div>
                    <div className="space-y-1"><Label className="text-xs">{t("studentDetailPage.eduEndYear")}</Label><Input type="number" className="h-8 text-sm" value={form.eduEndYear} onChange={e => setForm({ ...form, eduEndYear: e.target.value })} placeholder="2022" /></div>
                    <div className="space-y-1"><Label className="text-xs">{t("studentDetailPage.eduGpa")}</Label><Input className="h-8 text-sm" value={form.eduGpa} onChange={e => setForm({ ...form, eduGpa: e.target.value })} placeholder="3.50 / 85" /></div>
                    <div className="space-y-1"><Label className="text-xs">{t("studentDetailPage.eduLanguageScore")}</Label><Input className="h-8 text-sm" value={form.eduLanguageScore} onChange={e => setForm({ ...form, eduLanguageScore: e.target.value })} placeholder="IELTS 6.5" /></div>
                  </div>
                </div>
              );
            })()}
            {canSeeRevenue && (
              <div className="space-y-1.5 col-span-2">
                <Label className="flex items-center gap-1.5">
                  <TrendingUp className="w-3.5 h-3.5 text-emerald-500" />
                  {t("leadsPage.estimatedValueUsd")}
                </Label>
                <Input type="number" min="0" step="100" value={form.estimatedValue} onChange={(e) => setForm({ ...form, estimatedValue: e.target.value })} placeholder={t("leadsPage.estimatedValuePlaceholder")} />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>{t("leadsPage.cancel")}</Button>
            <Button onClick={handleCreate} disabled={createLead.isPending || !form.firstName || !form.lastName || !form.email || !isPhoneFieldValid(form.phone, true)}>
              {createLead.isPending ? t("leadsPage.creating") : t("leadsPage.createLead")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <LeadBulkImportModal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onSuccess={() => queryClient.invalidateQueries({ queryKey: ["/api/leads"] })}
      />
    </>
  );
}
