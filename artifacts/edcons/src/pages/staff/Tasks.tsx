import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useI18n } from "@/hooks/use-i18n";
import { useToast } from "@/hooks/use-toast";
import { customFetch, ApiError } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Plus, Archive, ArchiveRestore, GripVertical, ArrowRight, MessageSquarePlus,
  Pencil, Trash2, RotateCcw, X, ClipboardList, CheckCircle2, Circle, Clock, AtSign,
  AlertTriangle, CalendarClock, LayoutGrid, List,
} from "lucide-react";
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from "@/components/ui/table";
import { ColumnHeader } from "@/components/ui/column-header";
import { Checkbox } from "@/components/ui/checkbox";

import { ADMIN_ROLES as _ADMIN_ROLES } from "@workspace/roles";
const ADMIN_ROLES = _ADMIN_ROLES;
const MANAGE_ROLES = [...ADMIN_ROLES, "staff", "consultant", "editor", "accountant"] as const;

type TaskNote = { id: string; text: string; createdAt: string; authorName: string; mentions?: number[] };
type Task = {
  id: number;
  title: string;
  description: string | null;
  assignedTo: number | null;
  assignedToName: string | null;
  dueDate: string | null;
  priority: "low" | "medium" | "high";
  status: "todo" | "in_progress" | "done";
  taskNotes: TaskNote[] | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
type Assignee = { id: number; firstName: string | null; lastName: string | null; email: string | null; role: string };

const STATUS_FLOW: Record<Task["status"], Task["status"] | null> = {
  todo: "in_progress",
  in_progress: "done",
  done: null,
};

const PRIORITY_COLORS: Record<Task["priority"], string> = {
  low: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  medium: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  high: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
};

const COLUMN_DOT_COLORS: Record<Task["status"], string> = {
  todo: "bg-slate-400",
  in_progress: "bg-blue-500",
  done: "bg-green-500",
};

function toastApiError(toast: ReturnType<typeof useToast>["toast"], err: unknown, fallback: string) {
  if (err instanceof ApiError) {
    if (err.status === 401) {
      // Session-expired toast is handled centrally; suppress duplicate.
      return;
    }
    const data = err.data as { error?: string; message?: string } | null;
    const msg = data?.error || data?.message || err.message || fallback;
    toast({ title: fallback, description: msg, variant: "destructive" });
    return;
  }
  if (err instanceof Error) {
    toast({ title: fallback, description: err.message, variant: "destructive" });
    return;
  }
  toast({ title: fallback, variant: "destructive" });
}

function formatNoteDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function displayName(u: Assignee): string {
  const full = `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim();
  return full || u.email || `User #${u.id}`;
}

// Local-time YYYY-MM-DD for `dueDate` lexicographic comparisons.
function toLocalIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

type DueFilter = "all" | "dueWeek" | "overdue" | "noDue";

type TaskSortKey = "title" | "status" | "priority" | "assignee" | "due";

const TASKS_VIEW_KEY = "tasks-view-mode";

// Ordering weights for sortable enum-like fields.
const STATUS_SORT_ORDER: Record<Task["status"], number> = { todo: 0, in_progress: 1, done: 2 };
const PRIORITY_SORT_ORDER: Record<Task["priority"], number> = { high: 0, medium: 1, low: 2 };

type DueState = "none" | "overdue" | "soon" | "future";

function classifyDue(
  dueDate: string | null,
  status: Task["status"],
  todayIso: string,
  threeDaysIso: string,
): DueState {
  if (!dueDate) return "none";
  if (status === "done") return "future";
  if (dueDate < todayIso) return "overdue";
  if (dueDate <= threeDaysIso) return "soon";
  return "future";
}

// Detect an active "@query" token immediately preceding the caret. The token
// starts at an `@` that is at the beginning of the text or preceded by
// whitespace, and may contain letters, digits, underscores, and single spaces.
function detectMentionTrigger(text: string, caret: number): { atIndex: number; query: string } | null {
  if (caret <= 0) return null;
  // Walk backwards from the caret looking for a triggering `@`.
  // Stop early on a newline or after too many chars to keep this cheap.
  const max = Math.max(0, caret - 60);
  for (let i = caret - 1; i >= max; i--) {
    const ch = text[i];
    if (ch === "\n") return null;
    if (ch === "@") {
      const prev = i === 0 ? "" : text[i - 1];
      if (i !== 0 && !/\s/.test(prev)) return null;
      const query = text.slice(i + 1, caret);
      // Allow letters, digits, spaces, underscores, dots, hyphens.
      if (/^[\p{L}\p{N}_.\- ]*$/u.test(query)) return { atIndex: i, query };
      return null;
    }
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Render note text, highlighting `@DisplayName` substrings for any of the
// given mentioned users. Falls back to plain text when no mentions resolve.
function renderNoteText(text: string, mentionIds: number[] | undefined, byId: Map<number, Assignee>): React.ReactNode {
  if (!mentionIds || mentionIds.length === 0) return text;
  const names = mentionIds
    .map(id => byId.get(id))
    .filter((u): u is Assignee => !!u)
    .map(u => displayName(u))
    .filter(n => n.length > 0)
    // Longest names first so "John Smith" wins over "John".
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return text;
  const pattern = new RegExp(`@(?:${names.map(escapeRegExp).join("|")})`, "g");
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <span
        key={`m-${m.index}`}
        className="inline-flex items-center rounded bg-primary/10 text-primary font-medium px-1"
      >
        {m[0]}
      </span>
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type TaskFormState = {
  title: string;
  description: string;
  assignedTo: string;
  assignedToName: string;
  dueDate: string;
  priority: Task["priority"];
  status: Task["status"];
};

const EMPTY_FORM: TaskFormState = {
  title: "",
  description: "",
  assignedTo: "unassigned",
  assignedToName: "",
  dueDate: "",
  priority: "medium",
  status: "todo",
};

export default function TasksPage() {
  const { user } = useAuth(true);
  const { t } = useI18n();
  const { toast } = useToast();

  const [tasks, setTasks] = useState<Task[]>([]);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [dueFilter, setDueFilter] = useState<DueFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | Task["status"]>("all");
  const [priorityFilter, setPriorityFilter] = useState<"all" | Task["priority"]>("all");
  const [assigneeFilter, setAssigneeFilter] = useState("all");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkArchiving, setBulkArchiving] = useState(false);
  const [viewMode, setViewMode] = useState<"canvas" | "list">(() => {
    if (typeof window === "undefined") return "canvas";
    return (localStorage.getItem(TASKS_VIEW_KEY) as "canvas" | "list") || "canvas";
  });
  const [sort, setSort] = useState<{ key: TaskSortKey; dir: "asc" | "desc" }>({ key: "due", dir: "asc" });
  const [editOpen, setEditOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [form, setForm] = useState<TaskFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [notesTask, setNotesTask] = useState<Task | null>(null);
  const [newNoteText, setNewNoteText] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  // Note id to scroll into view + highlight when arriving from a
  // notification deep-link. Cleared when the dialog closes.
  const [highlightedNoteId, setHighlightedNoteId] = useState<string | null>(null);
  // Whether we still owe the targeted note a scrollIntoView call after
  // the notes dialog has mounted. Set together with highlightedNoteId
  // and reset once the scroll has happened.
  const scrollPendingRef = useRef<string | null>(null);
  // Tracks the deep-link query string we've already consumed so we don't
  // re-open the dialog if the user closes it manually.
  const consumedDeepLinkRef = useRef<string | null>(null);
  const [, setLocation] = useLocation();
  // Mention autocomplete state for the note textarea.
  const [noteMentionIds, setNoteMentionIds] = useState<number[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionAnchorIdx, setMentionAnchorIdx] = useState<number>(-1);
  const [mentionActiveIdx, setMentionActiveIdx] = useState<number>(0);
  const noteTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const role = user?.role || "";
  const isAdmin = (ADMIN_ROLES as readonly string[]).includes(role);
  const canManage = (MANAGE_ROLES as readonly string[]).includes(role);

  const loadTasks = useCallback(async (archived: boolean) => {
    setLoading(true);
    try {
      const res = await customFetch<{ data: Task[] }>(`/api/tasks?archived=${archived ? "true" : "false"}`);
      setTasks(res.data || []);
    } catch (err) {
      toastApiError(toast, err, t("tasks.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [toast, t]);

  const loadAssignees = useCallback(async () => {
    try {
      const res = await customFetch<{ data: Assignee[] }>(`/api/tasks/assignees`);
      setAssignees(res.data || []);
    } catch {
      // Non-blocking
    }
  }, []);

  useEffect(() => {
    if (user) {
      void loadTasks(showArchived);
    }
  }, [user, showArchived, loadTasks]);

  useEffect(() => {
    if (user) void loadAssignees();
  }, [user, loadAssignees]);

  // Deep-link handler: when arriving at /staff/tasks?taskId=N(&noteId=...)
  // automatically open that task's notes dialog and (when noteId is given)
  // mark the matching note for scroll + highlight. The query string is
  // consumed once and cleared so back-navigation and manual close-and-reopen
  // behave normally.
  useEffect(() => {
    if (!user || tasks.length === 0) return;
    if (typeof window === "undefined") return;
    const search = window.location.search;
    if (!search) return;
    if (consumedDeepLinkRef.current === search) return;
    const params = new URLSearchParams(search);
    const taskIdRaw = params.get("taskId");
    if (!taskIdRaw) return;
    const taskId = Number(taskIdRaw);
    if (!Number.isFinite(taskId)) return;
    const target = tasks.find(t => t.id === taskId);
    if (!target) return;
    consumedDeepLinkRef.current = search;
    setNotesTask(target);
    const noteId = params.get("noteId");
    if (noteId) {
      setHighlightedNoteId(noteId);
      scrollPendingRef.current = noteId;
    }
    // Strip the query string from the URL so back-nav and manual reopens
    // do not retrigger this effect.
    setLocation("/staff/tasks", { replace: true });
  }, [user, tasks, setLocation]);

  // Once the notes dialog is mounted with a highlighted note, scroll that
  // note into view. We use a small timeout so the radix Dialog content has
  // had a chance to mount and lay out before we query the DOM.
  useEffect(() => {
    if (!notesTask || !highlightedNoteId) return;
    if (scrollPendingRef.current !== highlightedNoteId) return;
    const noteId = highlightedNoteId;
    const timer = window.setTimeout(() => {
      const el = document.querySelector(
        `[data-testid="note-text-${CSS.escape(noteId)}"]`,
      );
      if (el && typeof (el as HTMLElement).scrollIntoView === "function") {
        (el as HTMLElement).scrollIntoView({ block: "center", behavior: "smooth" });
      }
      scrollPendingRef.current = null;
    }, 80);
    return () => window.clearTimeout(timer);
  }, [notesTask, highlightedNoteId]);

  // Clear the highlight ring when the notes dialog closes so the next
  // open of the same task doesn't keep the stale highlight.
  useEffect(() => {
    if (!notesTask) {
      setHighlightedNoteId(null);
      scrollPendingRef.current = null;
    }
  }, [notesTask]);

  function toggleView(mode: "canvas" | "list") {
    setViewMode(mode);
    try { localStorage.setItem(TASKS_VIEW_KEY, mode); } catch { /* ignore */ }
  }

  function handleSort(key: TaskSortKey) {
    setSort(prev => prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }

  function openCreate() {
    setEditingTask(null);
    setForm(EMPTY_FORM);
    setEditOpen(true);
  }

  function openEdit(task: Task) {
    setEditingTask(task);
    setForm({
      title: task.title,
      description: task.description ?? "",
      assignedTo: task.assignedTo == null ? "unassigned" : String(task.assignedTo),
      assignedToName: task.assignedToName ?? "",
      dueDate: task.dueDate ?? "",
      priority: task.priority,
      status: task.status,
    });
    setEditOpen(true);
  }

  async function saveTask() {
    if (!form.title.trim()) {
      toast({ title: t("tasks.titleRequired"), variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        title: form.title.trim(),
        description: form.description.trim() || null,
        dueDate: form.dueDate || null,
        priority: form.priority,
        status: form.status,
      };
      if (form.assignedTo === "unassigned") {
        payload.assignedTo = null;
        payload.assignedToName = null;
      } else {
        payload.assignedTo = Number(form.assignedTo);
        payload.assignedToName = form.assignedToName || null;
      }

      if (editingTask) {
        await customFetch(`/api/tasks/${editingTask.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        toast({ title: t("tasks.updated") });
      } else {
        await customFetch(`/api/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        toast({ title: t("tasks.created") });
      }
      setEditOpen(false);
      void loadTasks(showArchived);
    } catch (err) {
      toastApiError(toast, err, t("tasks.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function moveToStatus(task: Task, status: Task["status"]) {
    if (status === task.status) return;
    try {
      await customFetch(`/api/tasks/${task.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      void loadTasks(showArchived);
    } catch (err) {
      toastApiError(toast, err, t("tasks.moveFailed"));
    }
  }

  async function advanceStatus(task: Task) {
    const next = STATUS_FLOW[task.status];
    if (!next) return;
    await moveToStatus(task, next);
  }

  async function archiveTask(task: Task) {
    if (!confirm(t("tasks.confirmArchive"))) return;
    try {
      await customFetch(`/api/tasks/${task.id}`, { method: "DELETE" });
      toast({ title: t("tasks.archived") });
      void loadTasks(showArchived);
    } catch (err) {
      toastApiError(toast, err, t("tasks.archiveFailed"));
    }
  }

  async function restoreTask(task: Task) {
    try {
      await customFetch(`/api/tasks/restore/${task.id}`, { method: "POST" });
      toast({ title: t("tasks.restored") });
      void loadTasks(showArchived);
    } catch (err) {
      toastApiError(toast, err, t("tasks.restoreFailed"));
    }
  }

  async function archiveSelectedTasks() {
    if (!isAdmin || selectedIds.size === 0) return;
    const count = selectedIds.size;
    if (!confirm(`Archive ${count} selected task${count === 1 ? "" : "s"}?`)) return;
    setBulkArchiving(true);
    try {
      const result = await customFetch<{ archived: number }>("/api/tasks/bulk-archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selectedIds) }),
      });
      toast({ title: `${result.archived} task${result.archived === 1 ? "" : "s"} archived` });
      setSelectedIds(new Set());
      void loadTasks(showArchived);
    } catch (err) {
      toastApiError(toast, err, "Could not archive selected tasks");
    } finally {
      setBulkArchiving(false);
    }
  }

  function resetNoteEditor() {
    setNewNoteText("");
    setNoteMentionIds([]);
    setMentionQuery(null);
    setMentionAnchorIdx(-1);
    setMentionActiveIdx(0);
  }

  async function addNote() {
    if (!notesTask || !newNoteText.trim()) return;
    const text = newNoteText.trim();
    // Only send mentions whose `@DisplayName` substring is still present in
    // the final text (handles cases where the user deleted a mention).
    const idToName = new Map(assignees.map(a => [a.id, displayName(a)]));
    const finalMentions = Array.from(new Set(noteMentionIds)).filter(id => {
      const name = idToName.get(id);
      return !!name && text.includes(`@${name}`);
    });
    setAddingNote(true);
    try {
      const res = await customFetch<Task>(`/api/tasks/${notesTask.id}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, mentions: finalMentions }),
      });
      setNotesTask(res);
      setTasks(prev => prev.map(tk => tk.id === res.id ? res : tk));
      resetNoteEditor();
    } catch (err) {
      toastApiError(toast, err, t("tasks.noteAddFailed"));
    } finally {
      setAddingNote(false);
    }
  }

  // Update mention autocomplete state based on current text + caret.
  function updateMentionTrigger(text: string, caret: number) {
    const trig = detectMentionTrigger(text, caret);
    if (!trig) {
      setMentionQuery(null);
      setMentionAnchorIdx(-1);
      return;
    }
    setMentionQuery(trig.query);
    setMentionAnchorIdx(trig.atIndex);
    setMentionActiveIdx(0);
  }

  function handleNoteChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setNewNoteText(value);
    const caret = e.target.selectionStart ?? value.length;
    updateMentionTrigger(value, caret);
  }

  function handleNoteSelect(e: React.SyntheticEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    updateMentionTrigger(el.value, el.selectionStart ?? el.value.length);
  }

  function pickMention(a: Assignee) {
    if (mentionAnchorIdx < 0) return;
    const ta = noteTextareaRef.current;
    const caret = ta?.selectionStart ?? newNoteText.length;
    const before = newNoteText.slice(0, mentionAnchorIdx);
    const after = newNoteText.slice(caret);
    const insert = `@${displayName(a)} `;
    const next = before + insert + after;
    const nextCaret = (before + insert).length;
    setNewNoteText(next);
    setNoteMentionIds(ids => (ids.includes(a.id) ? ids : [...ids, a.id]));
    setMentionQuery(null);
    setMentionAnchorIdx(-1);
    // Restore caret position right after the inserted mention.
    requestAnimationFrame(() => {
      const el = noteTextareaRef.current;
      if (!el) return;
      el.focus();
      try { el.setSelectionRange(nextCaret, nextCaret); } catch { /* ignore */ }
    });
  }

  async function deleteNote(noteId: string) {
    if (!notesTask) return;
    try {
      const res = await customFetch<Task>(`/api/tasks/${notesTask.id}/notes/${noteId}`, { method: "DELETE" });
      setNotesTask(res);
      setTasks(prev => prev.map(tk => tk.id === res.id ? res : tk));
    } catch (err) {
      toastApiError(toast, err, t("tasks.noteDeleteFailed"));
    }
  }

  // Today + window boundaries (local time) for due-date classification.
  // Recomputed on each render — cheap and keeps the boundaries fresh if the
  // page is left open across midnight.
  const todayIso = toLocalIsoDate(new Date());
  const threeDaysIso = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 3);
    return toLocalIsoDate(d);
  }, [todayIso]);
  const sevenDaysIso = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return toLocalIsoDate(d);
  }, [todayIso]);

  // Counts for filter chips, computed from the full task list (so chip totals
  // don't change when a chip is selected). Both "Overdue" and "Due this week"
  // count only actionable work — done tasks are excluded from each.
  const filterCounts = useMemo(() => {
    let dueWeek = 0, overdue = 0, noDue = 0;
    for (const tk of tasks) {
      if (!tk.dueDate) { noDue += 1; continue; }
      if (tk.status === "done") continue;
      if (tk.dueDate < todayIso) overdue += 1;
      else if (tk.dueDate <= sevenDaysIso) dueWeek += 1;
    }
    return { all: tasks.length, dueWeek, overdue, noDue };
  }, [tasks, todayIso, sevenDaysIso]);

  const visibleTasks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return tasks.filter(tk => {
      if (dueFilter === "noDue" && tk.dueDate) return false;
      if (dueFilter === "overdue" && (tk.status === "done" || !tk.dueDate || tk.dueDate >= todayIso)) return false;
      if (dueFilter === "dueWeek" && (tk.status === "done" || !tk.dueDate || tk.dueDate < todayIso || tk.dueDate > sevenDaysIso)) return false;
      if (statusFilter !== "all" && tk.status !== statusFilter) return false;
      if (priorityFilter !== "all" && tk.priority !== priorityFilter) return false;
      if (assigneeFilter === "unassigned" && tk.assignedTo !== null) return false;
      if (assigneeFilter !== "all" && assigneeFilter !== "unassigned" && tk.assignedTo !== Number(assigneeFilter)) return false;
      if (query && !`${tk.title} ${tk.description ?? ""} ${tk.assignedToName ?? ""}`.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [tasks, dueFilter, statusFilter, priorityFilter, assigneeFilter, searchQuery, todayIso, sevenDaysIso]);

  useEffect(() => {
    const available = new Set(tasks.map(task => task.id));
    setSelectedIds(previous => {
      const next = new Set(Array.from(previous).filter(id => available.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [tasks]);

  const grouped = useMemo(() => {
    const out: Record<Task["status"], Task[]> = { todo: [], in_progress: [], done: [] };
    for (const tk of visibleTasks) out[tk.status].push(tk);
    return out;
  }, [visibleTasks]);

  // Flat, sorted list for the list/table view. Sorts the same filtered tasks
  // the canvas shows so switching views preserves filters.
  const sortedTasks = useMemo(() => {
    const arr = [...visibleTasks];
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sort.key) {
        case "title":
          cmp = a.title.localeCompare(b.title);
          break;
        case "status":
          cmp = STATUS_SORT_ORDER[a.status] - STATUS_SORT_ORDER[b.status];
          break;
        case "priority":
          cmp = PRIORITY_SORT_ORDER[a.priority] - PRIORITY_SORT_ORDER[b.priority];
          break;
        case "assignee":
          cmp = (a.assignedToName ?? "").localeCompare(b.assignedToName ?? "");
          break;
        case "due":
          // Tasks without a due date sort last regardless of direction.
          if (!a.dueDate && !b.dueDate) cmp = 0;
          else if (!a.dueDate) return 1;
          else if (!b.dueDate) return -1;
          else cmp = a.dueDate.localeCompare(b.dueDate);
          break;
      }
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [visibleTasks, sort]);

  const totalCount = tasks.length;
  const visibleCount = visibleTasks.length;
  const allVisibleSelected = visibleCount > 0 && visibleTasks.every(task => selectedIds.has(task.id));
  const someVisibleSelected = visibleTasks.some(task => selectedIds.has(task.id));

  function toggleTaskSelection(id: number, checked: boolean) {
    setSelectedIds(previous => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleVisibleSelection(checked: boolean) {
    setSelectedIds(previous => {
      const next = new Set(previous);
      for (const task of visibleTasks) {
        if (checked) next.add(task.id);
        else next.delete(task.id);
      }
      return next;
    });
  }

  const assigneesById = useMemo(() => {
    const m = new Map<number, Assignee>();
    for (const a of assignees) m.set(a.id, a);
    return m;
  }, [assignees]);

  // Active autocomplete suggestions, filtered by query and excluding self.
  const mentionSuggestions = useMemo(() => {
    if (mentionQuery === null) return [] as Assignee[];
    const q = mentionQuery.trim().toLowerCase();
    const list = assignees.filter(a => a.id !== user?.id);
    const matches = !q
      ? list
      : list.filter(a => {
          const name = displayName(a).toLowerCase();
          const email = (a.email ?? "").toLowerCase();
          return name.includes(q) || email.includes(q);
        });
    return matches.slice(0, 8);
  }, [assignees, mentionQuery, user?.id]);

  // ------------------------ Drag & Drop ------------------------
  const [dragging, setDragging] = useState<{ id: number; status: Task["status"]; x: number; y: number } | null>(null);
  const [hoverColumn, setHoverColumn] = useState<Task["status"] | null>(null);
  const dragStartRef = useRef<{ id: number; status: Task["status"]; x: number; y: number; started: boolean } | null>(null);
  const columnRefs = useRef<Record<Task["status"], HTMLDivElement | null>>({ todo: null, in_progress: null, done: null });
  const tasksRef = useRef<Task[]>([]);
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);

  const findColumnAt = useCallback((x: number, y: number): Task["status"] | null => {
    for (const status of ["todo", "in_progress", "done"] as const) {
      const el = columnRefs.current[status];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return status;
    }
    return null;
  }, []);

  const moveToStatusRef = useRef(moveToStatus);
  useEffect(() => { moveToStatusRef.current = moveToStatus; });

  function handleCardPointerDown(e: React.PointerEvent, task: Task) {
    if (!canManage || showArchived) return;
    if (e.button !== 0) return;
    dragStartRef.current = { id: task.id, status: task.status, x: e.clientX, y: e.clientY, started: false };

    const onPointerMove = (ev: PointerEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!start.started && Math.hypot(dx, dy) > 5) {
        start.started = true;
        setDragging({ id: start.id, status: start.status, x: ev.clientX, y: ev.clientY });
      }
      if (start.started) {
        setDragging(d => d ? { ...d, x: ev.clientX, y: ev.clientY } : d);
        setHoverColumn(findColumnAt(ev.clientX, ev.clientY));
      }
    };
    const onPointerUp = (ev: PointerEvent) => {
      const start = dragStartRef.current;
      dragStartRef.current = null;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      if (start?.started) {
        const target = findColumnAt(ev.clientX, ev.clientY);
        if (target && target !== start.status) {
          const tk = tasksRef.current.find(t => t.id === start.id);
          if (tk) void moveToStatusRef.current(tk, target);
        }
      }
      setDragging(null);
      setHoverColumn(null);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  }
  // -------------------------------------------------------------

  const draggingTask = dragging ? tasks.find(t => t.id === dragging.id) : null;

  return (
    <>
      <div className="p-4 md:p-6 lg:p-8 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight" data-testid="text-tasks-title">{t("tasks.title")}</h1>
            <p className="text-sm text-muted-foreground mt-0.5">{t("tasks.subtitle")}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center border rounded-full overflow-hidden" data-testid="view-toggle">
              <button
                type="button"
                onClick={() => toggleView("canvas")}
                className={`p-2 transition-colors ${viewMode === "canvas" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}
                title={t("tasks.view.canvas")}
                aria-pressed={viewMode === "canvas"}
                data-testid="button-view-canvas"
              >
                <LayoutGrid className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => toggleView("list")}
                className={`p-2 transition-colors ${viewMode === "list" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}
                title={t("tasks.view.list")}
                aria-pressed={viewMode === "list"}
                data-testid="button-view-list"
              >
                <List className="w-4 h-4" />
              </button>
            </div>
            <Button
              variant={showArchived ? "default" : "outline"}
              size="sm"
              onClick={() => setShowArchived(s => !s)}
              data-testid="button-toggle-archive"
            >
              {showArchived ? <ArchiveRestore className="w-4 h-4 mr-1.5" /> : <Archive className="w-4 h-4 mr-1.5" />}
              {showArchived ? t("tasks.viewActive") : t("tasks.viewArchive")}
            </Button>
            {isAdmin && (
              <Button size="sm" onClick={openCreate} data-testid="button-new-task">
                <Plus className="w-4 h-4 mr-1.5" />
                {t("tasks.newTask")}
              </Button>
            )}
          </div>
        </div>

        {/* Filter chips */}
        {!loading && totalCount > 0 && (
          <div
            className="flex flex-wrap items-center gap-2"
            role="group"
            aria-label={t("tasks.filters.label")}
            data-testid="due-filter-bar"
          >
            {(["all", "dueWeek", "overdue", "noDue"] as const).map(key => {
              const active = dueFilter === key;
              const count = filterCounts[key];
              const isOverdue = key === "overdue";
              const baseCls = active
                ? isOverdue && count > 0
                  ? "bg-red-600 text-white border-red-600 hover:bg-red-700"
                  : "bg-primary text-primary-foreground border-primary"
                : isOverdue && count > 0
                  ? "bg-background text-red-700 border-red-300 hover:bg-red-50 dark:text-red-300 dark:border-red-900/60 dark:hover:bg-red-950/40"
                  : "bg-background text-foreground border-border hover:bg-muted";
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setDueFilter(key)}
                  aria-pressed={active}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition ${baseCls}`}
                  data-testid={`filter-${key}`}
                >
                  {isOverdue && <AlertTriangle className="w-3.5 h-3.5" />}
                  {key === "dueWeek" && <CalendarClock className="w-3.5 h-3.5" />}
                  <span>{t(`tasks.filters.${key}`)}</span>
                  <span
                    className={`inline-flex items-center justify-center min-w-[1.25rem] h-4 rounded-full px-1 text-[10px] ${
                      active ? "bg-white/20 text-current" : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {!loading && totalCount > 0 && (
          <div className="flex flex-col xl:flex-row xl:items-center gap-2 rounded-xl border bg-card p-3" data-testid="task-advanced-filters">
            <Input
              value={searchQuery}
              onChange={event => setSearchQuery(event.target.value)}
              placeholder="Search title, description or assignee..."
              className="xl:max-w-sm"
              data-testid="input-task-search"
            />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 flex-1">
              <Select value={statusFilter} onValueChange={value => setStatusFilter(value as typeof statusFilter)}>
                <SelectTrigger data-testid="filter-task-status"><SelectValue placeholder={t("tasks.fields.status")} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="todo">{t("tasks.col.todo")}</SelectItem>
                  <SelectItem value="in_progress">{t("tasks.col.in_progress")}</SelectItem>
                  <SelectItem value="done">{t("tasks.col.done")}</SelectItem>
                </SelectContent>
              </Select>
              <Select value={priorityFilter} onValueChange={value => setPriorityFilter(value as typeof priorityFilter)}>
                <SelectTrigger data-testid="filter-task-priority"><SelectValue placeholder={t("tasks.fields.priority")} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All priorities</SelectItem>
                  <SelectItem value="high">{t("tasks.priority.high")}</SelectItem>
                  <SelectItem value="medium">{t("tasks.priority.medium")}</SelectItem>
                  <SelectItem value="low">{t("tasks.priority.low")}</SelectItem>
                </SelectContent>
              </Select>
              <Select value={assigneeFilter} onValueChange={setAssigneeFilter}>
                <SelectTrigger data-testid="filter-task-assignee"><SelectValue placeholder={t("tasks.fields.assignTo")} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All assignees</SelectItem>
                  <SelectItem value="unassigned">{t("tasks.unassigned")}</SelectItem>
                  {assignees.map(assignee => (
                    <SelectItem key={assignee.id} value={String(assignee.id)}>{displayName(assignee)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {(searchQuery || statusFilter !== "all" || priorityFilter !== "all" || assigneeFilter !== "all") && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => { setSearchQuery(""); setStatusFilter("all"); setPriorityFilter("all"); setAssigneeFilter("all"); }}
              >
                Clear filters
              </Button>
            )}
          </div>
        )}

        {isAdmin && !showArchived && !loading && totalCount > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-muted/30 px-3 py-2" data-testid="task-bulk-toolbar">
            <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
                onCheckedChange={value => toggleVisibleSelection(value === true)}
                aria-label="Select all filtered tasks"
                data-testid="checkbox-select-all-tasks"
              />
              Select all filtered ({visibleCount})
            </label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{selectedIds.size} selected</span>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={selectedIds.size === 0 || bulkArchiving}
                onClick={archiveSelectedTasks}
                data-testid="button-bulk-archive-tasks"
              >
                <Trash2 className="w-4 h-4 mr-1.5" />
                {bulkArchiving ? "Archiving..." : "Archive selected"}
              </Button>
            </div>
          </div>
        )}

        {/* Empty / Loading */}
        {loading ? (
          <div className="text-sm text-muted-foreground">{t("tasks.loading")}</div>
        ) : totalCount === 0 ? (
          <div className="border-2 border-dashed border-border rounded-xl p-10 text-center">
            <ClipboardList className="w-10 h-10 mx-auto text-muted-foreground/50 mb-3" />
            <h3 className="text-base font-semibold">{showArchived ? t("tasks.emptyArchive") : t("tasks.emptyActive")}</h3>
            <p className="text-sm text-muted-foreground mt-1">
              {showArchived ? t("tasks.emptyArchiveHint") : t("tasks.emptyActiveHint")}
            </p>
            {isAdmin && !showArchived && (
              <Button size="sm" className="mt-4" onClick={openCreate} data-testid="button-empty-create">
                <Plus className="w-4 h-4 mr-1.5" />
                {t("tasks.createTask")}
              </Button>
            )}
          </div>
        ) : visibleCount === 0 ? (
          <div className="border-2 border-dashed border-border rounded-xl p-10 text-center" data-testid="filter-empty">
            <ClipboardList className="w-10 h-10 mx-auto text-muted-foreground/50 mb-3" />
            <h3 className="text-base font-semibold">{t("tasks.filterEmpty")}</h3>
            <p className="text-sm text-muted-foreground mt-1">{t("tasks.filterEmptyHint")}</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-4"
              onClick={() => setDueFilter("all")}
              data-testid="button-clear-filter"
            >
              {t("tasks.filters.all")}
            </Button>
          </div>
        ) : viewMode === "canvas" ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {(["todo", "in_progress", "done"] as const).map(status => {
              const items = grouped[status];
              const isHover = hoverColumn === status && dragging && dragging.status !== status;
              return (
                <div
                  key={status}
                  ref={el => { columnRefs.current[status] = el; }}
                  className={`rounded-xl border bg-card p-3 min-h-[200px] transition-all ${
                    isHover ? "border-dashed border-primary ring-2 ring-primary/30" : "border-border"
                  }`}
                  data-testid={`column-${status}`}
                >
                  <div className="flex items-center gap-2 px-1 pb-2 mb-2 border-b">
                    <span className={`w-2 h-2 rounded-full ${COLUMN_DOT_COLORS[status]}`} />
                    <h2 className="text-sm font-semibold">{t(`tasks.col.${status}`)}</h2>
                    <Badge variant="secondary" className="text-[10px] h-5 px-1.5">{items.length}</Badge>
                  </div>
                  <div className="space-y-2">
                    {items.map(task => {
                      const isDragSelf = dragging?.id === task.id;
                      const noteCount = (task.taskNotes?.length) || 0;
                      const next = STATUS_FLOW[task.status];
                      const canEditThis = isAdmin || (canManage && task.assignedTo === user?.id);
                      const dueState = classifyDue(task.dueDate, task.status, todayIso, threeDaysIso);
                      const overdueRing = dueState === "overdue"
                        ? "border-red-500 ring-1 ring-red-500/30 dark:border-red-500/80"
                        : "";
                      return (
                        <div
                          key={task.id}
                          className={`group rounded-lg border bg-background p-3 cursor-pointer transition ${overdueRing} ${
                            isDragSelf ? "opacity-40 scale-95" : "hover:border-primary/50 hover:shadow-sm"
                          }`}
                          onClick={() => setNotesTask(task)}
                          data-testid={`task-card-${task.id}`}
                        >
                          <div className="flex items-start gap-2">
                            {isAdmin && !showArchived && (
                              <Checkbox
                                checked={selectedIds.has(task.id)}
                                onCheckedChange={value => toggleTaskSelection(task.id, value === true)}
                                onClick={event => event.stopPropagation()}
                                aria-label={`Select ${task.title}`}
                                data-testid={`checkbox-task-card-${task.id}`}
                              />
                            )}
                            {canManage && !showArchived && (
                              <span
                                className="mt-0.5 text-muted-foreground/60 hover:text-foreground cursor-grab active:cursor-grabbing"
                                onPointerDown={(e) => handleCardPointerDown(e, task)}
                                onClick={(e) => e.stopPropagation()}
                                data-testid={`drag-handle-${task.id}`}
                              >
                                <GripVertical className="w-4 h-4" />
                              </span>
                            )}
                            <div className="flex-1 min-w-0">
                              <div className={`text-sm font-medium leading-snug break-words ${task.status === "done" ? "line-through text-muted-foreground" : ""}`}>
                                {task.title}
                              </div>
                              {task.description && (
                                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{task.description}</p>
                              )}
                              <div className="flex flex-wrap items-center gap-1.5 mt-2">
                                <Badge variant="secondary" className={`text-[10px] h-5 px-1.5 ${PRIORITY_COLORS[task.priority]}`}>
                                  {t(`tasks.priority.${task.priority}`)}
                                </Badge>
                                {task.dueDate && (
                                  <span
                                    className={`inline-flex items-center gap-1 text-[10px] ${
                                      dueState === "overdue"
                                        ? "text-red-700 dark:text-red-400 font-medium"
                                        : dueState === "soon"
                                          ? "text-amber-700 dark:text-amber-400 font-medium"
                                          : "text-muted-foreground"
                                    }`}
                                    data-testid={`task-due-${task.id}`}
                                  >
                                    <Clock className="w-3 h-3" />
                                    {task.dueDate}
                                  </span>
                                )}
                                {dueState === "overdue" && (
                                  <span
                                    className="inline-flex items-center gap-1 text-[10px] h-5 px-1.5 rounded-full bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300 font-medium"
                                    data-testid={`pill-overdue-${task.id}`}
                                  >
                                    <AlertTriangle className="w-3 h-3" />
                                    {t("tasks.overduePill")}
                                  </span>
                                )}
                                {dueState === "soon" && (
                                  <span
                                    className="inline-flex items-center gap-1 text-[10px] h-5 px-1.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 font-medium"
                                    data-testid={`pill-due-soon-${task.id}`}
                                  >
                                    <CalendarClock className="w-3 h-3" />
                                    {t("tasks.dueSoonPill")}
                                  </span>
                                )}
                                {task.assignedToName && (
                                  <span className="inline-flex items-center gap-1 text-[10px] bg-muted/60 rounded-full px-1.5 py-0.5">
                                    {task.assignedToName}
                                  </span>
                                )}
                                {noteCount > 0 && (
                                  <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                                    <MessageSquarePlus className="w-3 h-3" />
                                    {noteCount}
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex flex-col items-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                              {!showArchived ? (
                                <>
                                  {next && canManage && (
                                    <Button
                                      type="button"
                                      size="icon"
                                      variant="ghost"
                                      className="h-6 w-6"
                                      title={t(`tasks.advanceTo.${next}`)}
                                      onClick={() => advanceStatus(task)}
                                      data-testid={`button-advance-${task.id}`}
                                    >
                                      <ArrowRight className="w-3.5 h-3.5" />
                                    </Button>
                                  )}
                                  <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    className="h-6 w-6"
                                    title={t("tasks.viewNotes")}
                                    onClick={() => setNotesTask(task)}
                                    data-testid={`button-notes-${task.id}`}
                                  >
                                    <MessageSquarePlus className="w-3.5 h-3.5" />
                                  </Button>
                                  {canEditThis && (
                                    <Button
                                      type="button"
                                      size="icon"
                                      variant="ghost"
                                      className="h-6 w-6"
                                      title={t("tasks.edit")}
                                      onClick={() => openEdit(task)}
                                      data-testid={`button-edit-${task.id}`}
                                    >
                                      <Pencil className="w-3.5 h-3.5" />
                                    </Button>
                                  )}
                                  {isAdmin && (
                                    <Button
                                      type="button"
                                      size="icon"
                                      variant="ghost"
                                      className="h-6 w-6 text-destructive hover:text-destructive"
                                      title={t("tasks.archive")}
                                      onClick={() => archiveTask(task)}
                                      data-testid={`button-archive-${task.id}`}
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </Button>
                                  )}
                                </>
                              ) : (
                                isAdmin && (
                                  <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    className="h-6 w-6"
                                    title={t("tasks.restore")}
                                    onClick={() => restoreTask(task)}
                                    data-testid={`button-restore-${task.id}`}
                                  >
                                    <RotateCcw className="w-3.5 h-3.5" />
                                  </Button>
                                )
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {items.length === 0 && (
                      <div className="text-xs text-muted-foreground/60 italic px-2 py-3 text-center">
                        {t("tasks.colEmpty")}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="rounded-2xl border bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    {isAdmin && !showArchived && (
                      <TableHead className="w-10">
                        <Checkbox
                          checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
                          onCheckedChange={value => toggleVisibleSelection(value === true)}
                          aria-label="Select all filtered tasks"
                        />
                      </TableHead>
                    )}
                    <ColumnHeader
                      label={t("tasks.fields.title")}
                      sort={{ sortKey: "title", current: sort, onSort: handleSort }}
                    />
                    <ColumnHeader
                      label={t("tasks.fields.status")}
                      sort={{ sortKey: "status", current: sort, onSort: handleSort }}
                    />
                    <ColumnHeader
                      label={t("tasks.fields.priority")}
                      sort={{ sortKey: "priority", current: sort, onSort: handleSort }}
                    />
                    <ColumnHeader
                      label={t("tasks.fields.assignTo")}
                      sort={{ sortKey: "assignee", current: sort, onSort: handleSort }}
                    />
                    <ColumnHeader
                      label={t("tasks.fields.dueDate")}
                      sort={{ sortKey: "due", current: sort, onSort: handleSort }}
                    />
                    <TableHead className="w-24 text-right">{t("tasks.fields.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedTasks.map(task => {
                    const noteCount = (task.taskNotes?.length) || 0;
                    const next = STATUS_FLOW[task.status];
                    const canEditThis = isAdmin || (canManage && task.assignedTo === user?.id);
                    const dueState = classifyDue(task.dueDate, task.status, todayIso, threeDaysIso);
                    return (
                      <TableRow
                        key={task.id}
                        className="cursor-pointer hover:bg-muted/30 transition-colors"
                        onClick={() => setNotesTask(task)}
                        data-testid={`task-row-${task.id}`}
                      >
                        {isAdmin && !showArchived && (
                          <TableCell onClick={event => event.stopPropagation()}>
                            <Checkbox
                              checked={selectedIds.has(task.id)}
                              onCheckedChange={value => toggleTaskSelection(task.id, value === true)}
                              aria-label={`Select ${task.title}`}
                              data-testid={`checkbox-task-row-${task.id}`}
                            />
                          </TableCell>
                        )}
                        <TableCell className="max-w-[360px]">
                          <div className={`font-medium leading-snug break-words ${task.status === "done" ? "line-through text-muted-foreground" : ""}`}>
                            {task.title}
                          </div>
                          {task.description && (
                            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{task.description}</p>
                          )}
                          {noteCount > 0 && (
                            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground mt-1">
                              <MessageSquarePlus className="w-3 h-3" />
                              {noteCount}
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className="inline-flex items-center gap-1.5 text-xs">
                            <span className={`w-2 h-2 rounded-full ${COLUMN_DOT_COLORS[task.status]}`} />
                            {t(`tasks.col.${task.status}`)}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className={`text-[10px] h-5 px-1.5 ${PRIORITY_COLORS[task.priority]}`}>
                            {t(`tasks.priority.${task.priority}`)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">
                          {task.assignedToName || <span className="text-muted-foreground">{t("tasks.unassigned")}</span>}
                        </TableCell>
                        <TableCell>
                          {task.dueDate ? (
                            <span
                              className={`inline-flex items-center gap-1 text-xs ${
                                dueState === "overdue"
                                  ? "text-red-700 dark:text-red-400 font-medium"
                                  : dueState === "soon"
                                    ? "text-amber-700 dark:text-amber-400 font-medium"
                                    : "text-muted-foreground"
                              }`}
                              data-testid={`task-row-due-${task.id}`}
                            >
                              <Clock className="w-3 h-3" />
                              {task.dueDate}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            {!showArchived ? (
                              <>
                                {next && canManage && (
                                  <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    className="h-7 w-7"
                                    title={t(`tasks.advanceTo.${next}`)}
                                    onClick={() => advanceStatus(task)}
                                    data-testid={`button-row-advance-${task.id}`}
                                  >
                                    <ArrowRight className="w-3.5 h-3.5" />
                                  </Button>
                                )}
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="ghost"
                                  className="h-7 w-7"
                                  title={t("tasks.viewNotes")}
                                  onClick={() => setNotesTask(task)}
                                  data-testid={`button-row-notes-${task.id}`}
                                >
                                  <MessageSquarePlus className="w-3.5 h-3.5" />
                                </Button>
                                {canEditThis && (
                                  <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    className="h-7 w-7"
                                    title={t("tasks.edit")}
                                    onClick={() => openEdit(task)}
                                    data-testid={`button-row-edit-${task.id}`}
                                  >
                                    <Pencil className="w-3.5 h-3.5" />
                                  </Button>
                                )}
                                {isAdmin && (
                                  <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    className="h-7 w-7 text-destructive hover:text-destructive"
                                    title={t("tasks.archive")}
                                    onClick={() => archiveTask(task)}
                                    data-testid={`button-row-archive-${task.id}`}
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </Button>
                                )}
                              </>
                            ) : (
                              isAdmin && (
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="ghost"
                                  className="h-7 w-7"
                                  title={t("tasks.restore")}
                                  onClick={() => restoreTask(task)}
                                  data-testid={`button-row-restore-${task.id}`}
                                >
                                  <RotateCcw className="w-3.5 h-3.5" />
                                </Button>
                              )
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </div>

      {/* Floating drag ghost */}
      {dragging && draggingTask && (
        <div
          className="pointer-events-none fixed z-50 rounded-lg border bg-background shadow-lg p-2 max-w-[260px] opacity-90"
          style={{ left: dragging.x + 12, top: dragging.y + 12 }}
        >
          <div className="text-xs font-medium truncate">{draggingTask.title}</div>
        </div>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingTask ? t("tasks.editTask") : t("tasks.newTask")}</DialogTitle>
            <DialogDescription>{t("tasks.dialogDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="task-title">{t("tasks.fields.title")} *</Label>
              <Input
                id="task-title"
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                data-testid="input-task-title"
              />
            </div>
            <div>
              <Label htmlFor="task-desc">{t("tasks.fields.description")}</Label>
              <Textarea
                id="task-desc"
                rows={3}
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                data-testid="input-task-description"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{t("tasks.fields.status")}</Label>
                <Select value={form.status} onValueChange={v => setForm(f => ({ ...f, status: v as Task["status"] }))}>
                  <SelectTrigger data-testid="select-task-status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="todo">{t("tasks.col.todo")}</SelectItem>
                    <SelectItem value="in_progress">{t("tasks.col.in_progress")}</SelectItem>
                    <SelectItem value="done">{t("tasks.col.done")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>{t("tasks.fields.priority")}</Label>
                <Select value={form.priority} onValueChange={v => setForm(f => ({ ...f, priority: v as Task["priority"] }))}>
                  <SelectTrigger data-testid="select-task-priority"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">{t("tasks.priority.low")}</SelectItem>
                    <SelectItem value="medium">{t("tasks.priority.medium")}</SelectItem>
                    <SelectItem value="high">{t("tasks.priority.high")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="task-due">{t("tasks.fields.dueDate")}</Label>
                <Input
                  id="task-due"
                  type="date"
                  value={form.dueDate}
                  onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))}
                  data-testid="input-task-due"
                />
              </div>
              <div>
                <Label>{t("tasks.fields.assignTo")}</Label>
                <Select
                  value={form.assignedTo}
                  onValueChange={v => {
                    if (v === "unassigned") {
                      setForm(f => ({ ...f, assignedTo: "unassigned", assignedToName: "" }));
                    } else {
                      const a = assignees.find(x => String(x.id) === v);
                      setForm(f => ({
                        ...f,
                        assignedTo: v,
                        assignedToName: a ? displayName(a) : "",
                      }));
                    }
                  }}
                >
                  <SelectTrigger data-testid="select-task-assignee"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unassigned">{t("tasks.unassigned")}</SelectItem>
                    {assignees.map(a => (
                      <SelectItem key={a.id} value={String(a.id)}>{displayName(a)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={saving}>{t("tasks.cancel")}</Button>
            <Button onClick={saveTask} disabled={saving} data-testid="button-save-task">
              {saving ? t("tasks.saving") : t("tasks.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Notes Dialog */}
      <Dialog open={!!notesTask} onOpenChange={(o) => { if (!o) { setNotesTask(null); resetNoteEditor(); } }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{notesTask?.title}</DialogTitle>
            {notesTask?.description && (
              <DialogDescription>{notesTask.description}</DialogDescription>
            )}
          </DialogHeader>
          {notesTask && (
            <>
              <div className="flex flex-wrap items-center gap-1.5 -mt-1">
                <Badge variant="secondary" className={`text-[10px] h-5 px-1.5 ${PRIORITY_COLORS[notesTask.priority]}`}>
                  {t(`tasks.priority.${notesTask.priority}`)}
                </Badge>
                <Badge variant="secondary" className="text-[10px] h-5 px-1.5">
                  {t(`tasks.col.${notesTask.status}`)}
                </Badge>
                {notesTask.dueDate && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Clock className="w-3 h-3" /> {notesTask.dueDate}
                  </span>
                )}
                {notesTask.assignedToName && (
                  <span className="text-[10px] bg-muted rounded-full px-1.5 py-0.5">{notesTask.assignedToName}</span>
                )}
              </div>

              <div className="border-t pt-3 space-y-2 max-h-[300px] overflow-y-auto">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{t("tasks.notes")}</h3>
                {(!notesTask.taskNotes || notesTask.taskNotes.length === 0) ? (
                  <p className="text-xs text-muted-foreground italic">{t("tasks.noNotes")}</p>
                ) : (
                  notesTask.taskNotes.map(n => {
                    const mentionIds = Array.isArray(n.mentions) ? n.mentions : [];
                    const dedupMentionIds = Array.from(new Set(mentionIds));
                    const youAreMentioned = user?.id != null && dedupMentionIds.includes(user.id);
                    const isHighlighted = highlightedNoteId === n.id;
                    return (
                    <div
                      key={n.id}
                      data-testid={`note-${n.id}`}
                      className={`rounded-md border bg-muted/40 p-2 group transition-shadow ${
                        isHighlighted ? "ring-2 ring-primary shadow-md" : ""
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <p
                          className="flex-1 text-sm whitespace-pre-wrap break-words"
                          data-testid={`note-text-${n.id}`}
                        >
                          {renderNoteText(n.text, n.mentions, assigneesById)}
                        </p>
                        {isAdmin && (
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="h-5 w-5 opacity-0 group-hover:opacity-100"
                            onClick={() => deleteNote(n.id)}
                            data-testid={`button-delete-note-${n.id}`}
                          >
                            <X className="w-3 h-3" />
                          </Button>
                        )}
                      </div>
                      {dedupMentionIds.length > 0 && (
                        <div
                          className="mt-1.5 flex flex-wrap items-center gap-1"
                          data-testid={`note-tagged-${n.id}`}
                        >
                          {youAreMentioned && (
                            <span
                              className="inline-flex items-center gap-0.5 rounded-full bg-primary/15 text-primary text-[10px] font-medium px-1.5 py-0.5"
                              data-testid={`note-you-mentioned-${n.id}`}
                            >
                              <AtSign className="w-2.5 h-2.5" />
                              {t("tasks.youWereMentioned")}
                            </span>
                          )}
                          <span className="text-[10px] text-muted-foreground">
                            {t("tasks.taggedLabel")}:
                          </span>
                          {dedupMentionIds.map(uid => {
                            const a = assigneesById.get(uid);
                            const label = a ? displayName(a) : t("tasks.unknownUser");
                            const isYou = user?.id != null && uid === user.id;
                            return (
                              <span
                                key={uid}
                                className={`inline-flex items-center rounded-full text-[10px] px-1.5 py-0.5 border ${
                                  isYou
                                    ? "bg-primary/10 text-primary border-primary/20"
                                    : a
                                      ? "bg-background text-foreground"
                                      : "bg-muted text-muted-foreground italic"
                                }`}
                                data-testid={`note-mention-${n.id}-${uid}`}
                              >
                                {label}
                              </span>
                            );
                          })}
                        </div>
                      )}
                      <p className="text-[10px] text-muted-foreground mt-1">
                        {n.authorName} — {formatNoteDate(n.createdAt)}
                      </p>
                    </div>
                    );
                  })
                )}
              </div>

              {(() => {
                const canComment = isAdmin || notesTask.assignedTo === user?.id || notesTask.assignedTo === null;
                if (!canComment) return null;
                const showSuggestions = mentionQuery !== null;
                const suggestions = showSuggestions
                  ? mentionSuggestions
                  : [];
                const safeActiveIdx = suggestions.length === 0
                  ? 0
                  : Math.min(mentionActiveIdx, suggestions.length - 1);
                return (
                  <div className="border-t pt-3 space-y-2">
                    <div className="relative">
                      <Textarea
                        ref={noteTextareaRef}
                        rows={2}
                        placeholder={t("tasks.addNotePlaceholder")}
                        value={newNoteText}
                        onChange={handleNoteChange}
                        onSelect={handleNoteSelect}
                        onClick={handleNoteSelect}
                        onKeyUp={handleNoteSelect}
                        onBlur={() => {
                          // Hide on blur after a tick so click on suggestion still fires.
                          setTimeout(() => {
                            setMentionQuery(null);
                            setMentionAnchorIdx(-1);
                          }, 120);
                        }}
                        onKeyDown={(e) => {
                          if (showSuggestions && suggestions.length > 0) {
                            if (e.key === "ArrowDown") {
                              e.preventDefault();
                              setMentionActiveIdx(i => (i + 1) % suggestions.length);
                              return;
                            }
                            if (e.key === "ArrowUp") {
                              e.preventDefault();
                              setMentionActiveIdx(i => (i - 1 + suggestions.length) % suggestions.length);
                              return;
                            }
                            if (e.key === "Enter" || e.key === "Tab") {
                              e.preventDefault();
                              pickMention(suggestions[safeActiveIdx]);
                              return;
                            }
                            if (e.key === "Escape") {
                              e.preventDefault();
                              setMentionQuery(null);
                              setMentionAnchorIdx(-1);
                              return;
                            }
                          }
                        }}
                        data-testid="input-new-note"
                      />
                      {showSuggestions && suggestions.length > 0 && (
                        <div
                          className="absolute z-10 left-0 right-0 mt-1 max-h-56 overflow-y-auto rounded-md border bg-popover shadow-lg"
                          data-testid="mention-suggestions"
                        >
                          {suggestions.map((a, idx) => (
                            <button
                              key={a.id}
                              type="button"
                              onMouseDown={(e) => { e.preventDefault(); pickMention(a); }}
                              onMouseEnter={() => setMentionActiveIdx(idx)}
                              className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 ${
                                idx === safeActiveIdx ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
                              }`}
                              data-testid={`mention-option-${a.id}`}
                            >
                              <AtSign className="w-3.5 h-3.5 text-muted-foreground" />
                              <span className="truncate">{displayName(a)}</span>
                              {a.email && (
                                <span className="ml-auto text-[11px] text-muted-foreground truncate">{a.email}</span>
                              )}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] text-muted-foreground">{t("tasks.mentionHint")}</p>
                      <Button
                        size="sm"
                        disabled={!newNoteText.trim() || addingNote}
                        onClick={addNote}
                        data-testid="button-add-note"
                      >
                        {addingNote ? t("tasks.adding") : t("tasks.add")}
                      </Button>
                    </div>
                  </div>
                );
              })()}
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
