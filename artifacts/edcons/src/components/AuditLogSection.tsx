import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { formatDate } from "@workspace/i18n";
import { useAuth } from "@/hooks/use-auth";
import { useI18n } from "@/hooks/use-i18n";
import {
  ChevronDown,
  ChevronUp,
  History,
  Trash2,
  Pencil,
  Plus,
  UserCheck2,
  ArrowRightLeft,
  KeyRound,
  Archive,
  Globe,
  Users,
  Calendar,
  CheckCircle2,
  RotateCcw,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

interface Props {
  resource: "lead" | "student" | "application";
  resourceId: number;
}

interface AuditLogRow {
  id: number;
  action: string;
  resource: string;
  resourceId: number | null;
  changes: any;
  ipAddress: string | null;
  createdAt: string;
  userName: string | null;
}

type ActionMeta = {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: "neutral" | "positive" | "warning" | "danger" | "info";
};

const ACTION_META: Record<string, ActionMeta> = {
  create_lead: { label: "Lead created", icon: Plus, tone: "positive" },
  update_lead: { label: "Lead updated", icon: Pencil, tone: "info" },
  delete_lead: { label: "Lead deleted", icon: Trash2, tone: "danger" },
  bulk_assign_leads: { label: "Leads bulk-assigned", icon: UserCheck2, tone: "info" },
  bulk_move_leads: { label: "Leads bulk-moved", icon: ArrowRightLeft, tone: "info" },
  convert_lead: { label: "Lead converted to student", icon: ArrowRightLeft, tone: "positive" },
  override_origin: { label: "Origin updated", icon: Globe, tone: "info" },

  create_student: { label: "Student created", icon: Plus, tone: "positive" },
  update_student: { label: "Student updated", icon: Pencil, tone: "info" },
  archive_student: { label: "Student archived", icon: Archive, tone: "warning" },
  bulk_create_students: { label: "Students bulk-created", icon: Users, tone: "positive" },
  bulk_assign_students: { label: "Students bulk-assigned", icon: UserCheck2, tone: "info" },
  bulk_move_students: { label: "Students bulk-moved", icon: ArrowRightLeft, tone: "info" },
  set_password: { label: "Password set", icon: KeyRound, tone: "warning" },

  delete_note: { label: "Note deleted", icon: Trash2, tone: "danger" },

  create_follow_up: { label: "Follow-up added", icon: Calendar, tone: "positive" },
  update_follow_up: { label: "Follow-up edited", icon: Pencil, tone: "info" },
  complete_follow_up: { label: "Follow-up completed", icon: CheckCircle2, tone: "positive" },
  reopen_follow_up: { label: "Follow-up reopened", icon: RotateCcw, tone: "warning" },
};

const TONE_BADGE: Record<ActionMeta["tone"], string> = {
  neutral: "bg-muted text-foreground/80",
  positive: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  warning: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  danger: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  info: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
};

const TONE_ICON: Record<ActionMeta["tone"], string> = {
  neutral: "text-muted-foreground bg-muted",
  positive: "text-emerald-600 bg-emerald-50 dark:bg-emerald-900/30 dark:text-emerald-400",
  warning: "text-amber-600 bg-amber-50 dark:bg-amber-900/30 dark:text-amber-400",
  danger: "text-rose-600 bg-rose-50 dark:bg-rose-900/30 dark:text-rose-400",
  info: "text-sky-600 bg-sky-50 dark:bg-sky-900/30 dark:text-sky-400",
};

const FIELD_LABELS: Record<string, string> = {
  firstName: "First name",
  lastName: "Last name",
  email: "Email",
  phone: "Phone",
  nationality: "Nationality",
  status: "Status",
  source: "Source",
  notes: "Notes",
  assignedTo: "Assigned to",
  assignedToName: "Assigned to",
  assignedToId: "Assigned to",
  agentName: "Agent",
  season: "Season",
  estimatedValue: "Estimated value",
  interestedProgram: "Interested program",
  interestedCountry: "Interested country",
  studentId: "Student",
  userName: "User",
  targetUserName: "Target user",
  authorName: "Author",
  ids: "Items",
  count: "Count",
  contentPreview: "Content",
  isInternal: "Visibility",
  linkedExisting: "Linked to existing user",
  createdUser: "Created new user",
  merged: "Merged with existing student",
  old: "Before",
  new: "After",
  originType: "Type",
  originDisplayName: "Name",
  title: "Title",
  scheduledAt: "Scheduled at",
  completed: "Completed",
  titleChange: "Title",
  scheduledAtChange: "Scheduled at",
  notesChange: "Notes",
  dateOfBirth: "Date of birth",
  passportNumber: "Passport #",
  passportIssueDate: "Passport issue date",
  passportExpiry: "Passport expiry",
  motherName: "Mother's name",
  fatherName: "Father's name",
  address: "Address",
  highSchool: "High school",
  universityBachelor: "Bachelor",
  universityMaster: "Master",
  graduationYear: "Graduation year",
  gpa: "GPA",
  languageScore: "Language score",
  photoUrl: "Photo",
};

const HIDDEN_FIELDS = new Set([
  "noteId",
  "authorId",
  "userId",
  "agentId",
  "createdById",
  "updatedById",
  "targetUserId",
  "originEntityId",
  "originEntityType",
  "originLocked",
  "followUpId",
]);

const DATE_FIELDS = new Set([
  "scheduledAt",
  "scheduledAtChange",
  "dateOfBirth",
  "passportIssueDate",
  "passportExpiry",
  "completedAt",
]);

function parseChanges(raw: any): Record<string, any> | null {
  if (!raw) return null;
  let parsed: any = raw;
  if (typeof raw === "string") {
    try { parsed = JSON.parse(raw); } catch { return null; }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed;
}

function fmtDate(v: any): string {
  if (v === null || v === undefined || v === "") return "—";
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return `${formatDate(d, "tr", { day: "2-digit", month: "2-digit", year: "numeric" })} ${formatDate(d, "tr", { hour: "2-digit", minute: "2-digit" })}`;
}

function isDiff(v: any): v is { from?: any; to?: any; fromName?: string; toName?: string } {
  return v && typeof v === "object" && !Array.isArray(v) && ("from" in v || "to" in v);
}

function isOldNew(v: any): v is { old?: any; new?: any; oldName?: string; newName?: string } {
  return v && typeof v === "object" && !Array.isArray(v) && ("old" in v || "new" in v);
}

function quote(s: string): string {
  return s.length > 60 ? `"${s.slice(0, 60)}…"` : `"${s}"`;
}

function humanizeValue(key: string, v: any): string {
  if (v === null || v === undefined || v === "") return "—";
  if (key === "isInternal") return v === true ? "Private" : "General";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (DATE_FIELDS.has(key) && (typeof v === "string" || v instanceof Date)) return fmtDate(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "—";
    if (v.length <= 5) return v.join(", ");
    return `${v.slice(0, 5).join(", ")} +${v.length - 5} more`;
  }
  if (isDiff(v)) {
    const fmt = (side: "from" | "to") => {
      const sideName = (v as any)[`${side}Name`];
      const sideVal = (v as any)[side];
      if (sideName) return sideName;
      if (sideVal === null || sideVal === undefined || sideVal === "") return "(empty)";
      if (DATE_FIELDS.has(key)) return fmtDate(sideVal);
      if (typeof sideVal === "boolean") return sideVal ? "Yes" : "No";
      if (typeof sideVal === "string") return sideVal;
      return String(sideVal);
    };
    return `${fmt("from")} → ${fmt("to")}`;
  }
  if (isOldNew(v)) {
    const fmt = (side: "old" | "new") => {
      const sideName = (v as any)[`${side}Name`];
      const sideVal = (v as any)[side];
      if (sideName) return sideName;
      if (sideVal && typeof sideVal === "object") {
        const display = (sideVal as any).originDisplayName || (sideVal as any).originType;
        if (display) return String(display);
      }
      if (sideVal === null || sideVal === undefined || sideVal === "") return "(empty)";
      return String(sideVal);
    };
    return `${fmt("old")} → ${fmt("new")}`;
  }
  if (typeof v === "object") {
    const entries = Object.entries(v).filter(([, vv]) => vv !== null && vv !== "" && vv !== undefined);
    if (entries.length === 0) return "—";
    return entries.map(([k, vv]) => `${FIELD_LABELS[k] ?? k}: ${humanizeValue(k, vv)}`).join(" · ");
  }
  return String(v);
}

function buildSummary(action: string, changes: Record<string, any> | null): string | null {
  if (!changes) return null;
  switch (action) {
    case "delete_note": {
      const visibility = changes.isInternal ? "private" : "general";
      const preview = typeof changes.contentPreview === "string" ? changes.contentPreview.replace(/\s+/g, " ").trim() : "";
      const snippet = preview ? ` — ${quote(preview)}` : "";
      return `Removed a ${visibility} note${snippet}`;
    }
    case "convert_lead": {
      if (changes.merged) return `Merged into existing student #${changes.studentId}`;
      if (changes.studentId) return `Created student #${changes.studentId}`;
      return null;
    }
    case "set_password": {
      if (changes.createdUser) return "Created a new user account and set its password";
      if (changes.linkedExisting) return "Linked to existing user account and set password";
      return "Password updated";
    }
    case "bulk_assign_leads":
    case "bulk_assign_students": {
      const count = Array.isArray(changes.ids) ? changes.ids.length : null;
      return count !== null ? `Assigned ${count} record${count === 1 ? "" : "s"}` : null;
    }
    case "bulk_move_leads":
    case "bulk_move_students": {
      const count = Array.isArray(changes.ids) ? changes.ids.length : null;
      const status = changes.status ? ` to status ${quote(changes.status)}` : "";
      return count !== null ? `Moved ${count} record${count === 1 ? "" : "s"}${status}` : null;
    }
    case "bulk_create_students": {
      return changes.count ? `Imported ${changes.count} student${changes.count === 1 ? "" : "s"}` : null;
    }
    case "override_origin": {
      const newSide = changes.new && typeof changes.new === "object" ? (changes.new.originDisplayName || changes.new.originType) : null;
      const oldSide = changes.old && typeof changes.old === "object" ? (changes.old.originDisplayName || changes.old.originType) : null;
      if (newSide && oldSide) return `Changed from ${quote(String(oldSide))} to ${quote(String(newSide))}`;
      if (newSide) return `Set to ${quote(String(newSide))}`;
      return null;
    }
    case "update_lead":
    case "update_student": {
      const fields = Object.keys(changes).filter(k => !HIDDEN_FIELDS.has(k) && !k.endsWith("Name"));
      if (fields.length === 0) return null;
      if (fields.length === 1) {
        const k = fields[0];
        return `${FIELD_LABELS[k] ?? k}: ${humanizeValue(k, changes[k])}`;
      }
      return `${fields.length} field${fields.length === 1 ? "" : "s"} updated`;
    }
    case "create_lead":
    case "create_student": {
      const name = [changes.firstName, changes.lastName].filter(Boolean).join(" ");
      return name || null;
    }
    case "create_follow_up": {
      const t = changes.title ? quote(String(changes.title)) : "";
      const when = changes.scheduledAt ? ` for ${fmtDate(changes.scheduledAt)}` : "";
      return `Added follow-up${t ? ` ${t}` : ""}${when}`;
    }
    case "update_follow_up": {
      const t = changes.title ? quote(String(changes.title)) : "";
      const parts: string[] = [];
      if (changes.titleChange) parts.push("title");
      if (changes.scheduledAtChange) parts.push("date");
      if (changes.notesChange) parts.push("notes");
      if (parts.length === 0) return t ? `Edited follow-up ${t}` : "Edited follow-up";
      return `Edited follow-up${t ? ` ${t}` : ""} — changed ${parts.join(", ")}`;
    }
    case "complete_follow_up": {
      const t = changes.title ? quote(String(changes.title)) : "";
      return `Marked follow-up${t ? ` ${t}` : ""} as completed`;
    }
    case "reopen_follow_up": {
      const t = changes.title ? quote(String(changes.title)) : "";
      return `Reopened follow-up${t ? ` ${t}` : ""}`;
    }
    default:
      return null;
  }
}

function buildDetails(action: string, changes: Record<string, any> | null): { label: string; value: string }[] {
  if (!changes) return [];
  if (action === "delete_note") return [];
  if (action === "convert_lead") return [];
  if (action === "set_password") return [];
  if (action === "override_origin") return [];
  if (action === "create_follow_up") return [];
  if (action === "complete_follow_up" || action === "reopen_follow_up") return [];

  const isUpdate = action === "update_lead" || action === "update_student";
  const isCreate = action === "create_lead" || action === "create_student";
  const isBulk = action.startsWith("bulk_");
  const isFollowUpEdit = action === "update_follow_up";

  const ID_TO_NAME: Record<string, string> = {
    assignedToId: "assignedToName",
    createdById: "createdByName",
    updatedById: "updatedByName",
    authorId: "authorName",
    userId: "userName",
    targetUserId: "targetUserName",
    agentId: "agentName",
  };
  const visibleKeys = Object.keys(changes).filter(k => {
    if (HIDDEN_FIELDS.has(k)) return false;
    if (k === "title" && isFollowUpEdit) return false;
    const nameSibling = ID_TO_NAME[k];
    if (nameSibling && typeof changes[k] !== "object" && changes[nameSibling]) return false;
    return true;
  });
  const onlyOneField = isUpdate && visibleKeys.filter(k => !k.endsWith("Name") || !Object.values(ID_TO_NAME).includes(k)).length === 1;

  const entries = Object.entries(changes).filter(([k, v]) => {
    if (HIDDEN_FIELDS.has(k)) return false;
    if (v === null || v === undefined || v === "") return false;
    if (isBulk && (k === "ids" || k === "status" || k === "assignedToId" || k === "count")) return false;
    if (isCreate && (k === "firstName" || k === "lastName")) return false;
    if (isUpdate && onlyOneField) return false;
    if (isFollowUpEdit && k === "title") return false;
    const nameSibling = ID_TO_NAME[k];
    if (nameSibling && typeof v !== "object" && (changes as any)[nameSibling]) return false;
    const isNameOfId = Object.entries(ID_TO_NAME).find(([, nameKey]) => nameKey === k);
    if (isNameOfId) {
      const idKey = isNameOfId[0];
      if (changes[idKey] && typeof changes[idKey] === "object") return false;
    }
    return true;
  });

  return entries.map(([k, v]) => ({
    label: FIELD_LABELS[k] ?? k.replace(/Change$/, "").replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase()),
    value: humanizeValue(k, v),
  }));
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return "";
}

export function AuditLogSection({ resource, resourceId }: Props) {
  const { t, lang } = useI18n();
  const { user } = useAuth(true);
  const [open, setOpen] = useState(false);
  const isAdminLike = user && ["super_admin", "admin"].includes(user.role);

  const { data, isLoading } = useQuery<{ data: AuditLogRow[]; meta?: any }>({
    queryKey: [`/api/audit`, resource, resourceId],
    queryFn: () => customFetch(`/api/audit?resource=${resource}&resourceId=${resourceId}&limit=100`),
    enabled: !!isAdminLike && open,
    staleTime: 30_000,
  });

  if (!isAdminLike) return null;

  const logs = data?.data ?? [];

  return (
    <div className="bg-card rounded-2xl border shadow-sm">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between p-4 hover:bg-secondary/30 rounded-2xl transition-colors"
        data-testid="audit-log-toggle"
      >
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-muted-foreground" />
          <h2 className="font-semibold text-foreground">{t("common.activityLog")}</h2>
          {logs.length > 0 && (
            <span className="text-xs text-muted-foreground">({logs.length})</span>
          )}
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>
      {open && (
        <div className="border-t px-4 pb-4 pt-2">
          {isLoading ? (
            <div className="space-y-2 py-2">
              {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          ) : logs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">No activity recorded.</p>
          ) : (
            <div className="space-y-2 max-h-[28rem] overflow-y-auto pr-1">
              {logs.map((log) => {
                const meta = ACTION_META[log.action] ?? { label: log.action.replace(/_/g, " "), icon: History, tone: "neutral" as const };
                const Icon = meta.icon;
                const changes = parseChanges(log.changes);
                const summary = buildSummary(log.action, changes);
                const details = buildDetails(log.action, changes);
                const rel = relativeTime(log.createdAt);
                return (
                  <div key={log.id} className="rounded-xl border bg-card p-3" data-testid={`audit-log-row-${log.id}`}>
                    <div className="flex items-start gap-3">
                      <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${TONE_ICON[meta.tone]}`}>
                        <Icon className="w-4 h-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2 flex-wrap min-w-0">
                            <span className="text-sm font-semibold text-foreground truncate">
                              {log.userName || "System"}
                            </span>
                            <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${TONE_BADGE[meta.tone]}`}>
                              {meta.label}
                            </span>
                          </div>
                          <span className="text-xs text-muted-foreground whitespace-nowrap" title={(() => { const d = new Date(log.createdAt); return isNaN(d.getTime()) ? "" : `${String(d.getDate()).padStart(2,"0")}.${String(d.getMonth()+1).padStart(2,"0")}.${d.getFullYear()} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; })()}>
                            {formatDate(log.createdAt, lang, { day: "2-digit", month: "2-digit", year: "numeric" })}
                            {" "}
                            {formatDate(log.createdAt, lang, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                            {rel && <span className="text-muted-foreground/60"> · {rel}</span>}
                          </span>
                        </div>
                        {summary && (
                          <p className="mt-1 text-sm text-foreground/90 break-words">{summary}</p>
                        )}
                        {details.length > 0 && (
                          <dl className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                            {details.map(({ label, value }) => (
                              <div key={label} className="flex gap-2 text-xs min-w-0">
                                <dt className="text-muted-foreground shrink-0">{label}:</dt>
                                <dd className="text-foreground/85 break-words min-w-0">{value}</dd>
                              </div>
                            ))}
                          </dl>
                        )}
                        {!summary && details.length === 0 && (
                          <p className="mt-1 text-xs text-muted-foreground italic">No additional details</p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
