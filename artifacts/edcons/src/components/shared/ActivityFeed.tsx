import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useI18n } from "@/hooks/use-i18n";
import { useAuth } from "@/hooks/use-auth";
import { apiFetch } from "@/lib/apiFetch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@workspace/i18n";
import {
  CalendarClock, Activity, ChevronDown, ChevronUp,
  CheckCircle2, Circle, Loader2, AlertCircle, Lock, Globe, Plus, X, Check
} from "lucide-react";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

export type FeedContext = "lead" | "student" | "application";

interface ActivityFeedProps {
  context: FeedContext;
  id: number;
  className?: string;
}

type FeedItem = {
  id: string;
  type: "note" | "follow_up" | "status_change";
  ts: string;
  noteId?: number;
  content?: string;
  isInternal?: boolean;
  authorId?: number;
  authorName?: string | null;
  entityType?: string;
  entityId?: number;
  followUpId?: number;
  title?: string;
  dueAt?: string | null;
  completed?: boolean;
  completedAt?: string | null;
  assignedToId?: number | null;
  assignedToName?: string | null;
  followUpNotes?: string | null;
  auditId?: number;
  action?: string;
  actorId?: number | null;
  actorName?: string | null;
  auditChanges?: Record<string, unknown> | null;
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function isDueOverdue(dueAt: string | null | undefined): boolean {
  if (!dueAt) return false;
  return new Date(dueAt).getTime() < Date.now();
}

function actionLabel(action: string, changes: Record<string, unknown> | null | undefined): string {
  if (action === "convert_lead") return "Converted to student";
  if (action === "create_lead" || action === "create_student") return "Record created";
  if (changes && "status" in changes) {
    const from = (changes as any).status;
    return `Status → ${from}`;
  }
  return action.replace(/_/g, " ");
}

export function ActivityFeed({ context, id, className = "" }: ActivityFeedProps) {
  const { t } = useI18n();
  const { user } = useAuth();
  const qc = useQueryClient();

  const isStaff = user && ["super_admin", "admin", "manager", "staff"].includes(user.role);

  const feedKey = [`/api/persons/feed`, context, id];
  const { data, isLoading, isError } = useQuery<{ data: FeedItem[]; meta: Record<string, unknown> }>({
    queryKey: feedKey,
    queryFn: async () => {
      const res = await apiFetch(`${BASE_URL}/api/persons/feed?context=${context}&id=${id}`);
      if (!res.ok) throw new Error("Failed to load feed");
      return res.json();
    },
  });

  const feedItems = data?.data ?? [];

  // SSE for real-time updates
  useEffect(() => {
    const url = `${BASE_URL}/api/persons/feed/stream?context=${context}&id=${id}`;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      es = new EventSource(url, { withCredentials: true });
      es.addEventListener("feed_update", () => {
        qc.invalidateQueries({ queryKey: feedKey });
      });
      es.onerror = () => {
        es?.close();
        retryTimer = setTimeout(connect, 8000);
      };
    }
    connect();
    return () => {
      es?.close();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [context, id]);

  // ── Complete follow-up ────────────────────────────────────────────────────
  const completeFollowUp = useMutation({
    mutationFn: async (fuId: number) => {
      const res = await apiFetch(`${BASE_URL}/api/persons/feed/follow-ups/${fuId}?context=${context}&id=${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completed: true }),
      });
      if (!res.ok) throw new Error("Failed to update");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: feedKey }),
  });

  // ── Delete note ───────────────────────────────────────────────────────────
  const deleteNote = useMutation({
    mutationFn: async (noteId: number) => {
      const res = await apiFetch(`${BASE_URL}/api/persons/feed/notes/${noteId}?context=${context}&id=${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete note");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: feedKey }),
  });

  if (isLoading) {
    return (
      <div className={`flex items-center justify-center py-10 text-muted-foreground ${className}`}>
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        <span className="text-sm">{t("activityFeed.loading")}</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className={`flex items-center gap-2 py-6 text-destructive text-sm ${className}`}>
        <AlertCircle className="h-4 w-4 flex-shrink-0" />
        {t("activityFeed.loadError")}
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      {/* ── Feed items ─────────────────────────────────────────────────── */}
      {feedItems.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
          <Activity className="h-8 w-8 opacity-30" />
          <p className="text-sm">{t("activityFeed.empty")}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {feedItems.map(item => (
            <FeedItemCard
              key={item.id}
              item={item}
              isStaff={!!isStaff}
              currentUserId={user?.id}
              onComplete={id => completeFollowUp.mutate(id)}
              onDeleteNote={id => deleteNote.mutate(id)}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface FeedItemCardProps {
  item: FeedItem;
  isStaff: boolean;
  currentUserId?: number;
  onComplete: (id: number) => void;
  onDeleteNote: (id: number) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

function FeedItemCard({ item, isStaff, currentUserId, onComplete, onDeleteNote, t }: FeedItemCardProps) {
  const [expanded, setExpanded] = useState(false);

  if (item.type === "note") {
    const isOwn = item.authorId === currentUserId;
    const canDelete = isOwn || isStaff;
    return (
      <div className={`group relative rounded-xl p-3 text-sm ${item.isInternal ? "bg-orange-50 border border-orange-200" : "bg-secondary/50"}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            {item.isInternal ? (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-orange-300 text-orange-700 bg-orange-50">
                <Lock className="h-2.5 w-2.5 mr-0.5" />{t("activityFeed.internal")}
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                <Globe className="h-2.5 w-2.5 mr-0.5" />{t("activityFeed.general")}
              </Badge>
            )}
            {item.authorName && (
              <span className="text-xs text-muted-foreground">{item.authorName}</span>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <span className="text-[10px] text-muted-foreground">{relativeTime(item.ts)}</span>
            {canDelete && (
              <button
                className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive ml-1"
                onClick={() => item.noteId && onDeleteNote(item.noteId)}
                title="Delete"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        <p className="mt-1.5 text-foreground whitespace-pre-wrap leading-snug">{item.content}</p>
      </div>
    );
  }

  if (item.type === "follow_up") {
    const overdue = !item.completed && isDueOverdue(item.dueAt);
    return (
      <div className={`rounded-xl border p-3 text-sm ${item.completed ? "opacity-60 bg-muted/30" : overdue ? "border-red-200 bg-red-50" : "bg-card"}`}>
        <div className="flex items-start gap-2">
          <button
            onClick={() => !item.completed && item.followUpId && onComplete(item.followUpId)}
            className={`mt-0.5 flex-shrink-0 transition-colors ${item.completed ? "text-green-500" : "text-muted-foreground hover:text-green-500"}`}
          >
            {item.completed ? <CheckCircle2 className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className={`font-medium text-sm ${item.completed ? "line-through text-muted-foreground" : ""}`}>
                {item.title}
              </span>
              <span className="text-[10px] text-muted-foreground flex-shrink-0">{relativeTime(item.ts)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-0.5">
              {item.dueAt && (
                <span className={`text-xs flex items-center gap-0.5 ${overdue ? "text-red-600 font-medium" : "text-muted-foreground"}`}>
                  <CalendarClock className="h-3 w-3" />
                  {overdue && !item.completed ? t("activityFeed.overdue") + " · " : ""}
                  {formatDate(item.dueAt)}
                </span>
              )}
              {item.assignedToName && (
                <span className="text-xs text-muted-foreground">
                  {t("activityFeed.assignedTo")}: {item.assignedToName}
                </span>
              )}
            </div>
            {item.followUpNotes && (
              <p className="text-xs text-muted-foreground mt-1">{item.followUpNotes}</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (item.type === "status_change") {
    return (
      <div className="rounded-xl border border-dashed bg-muted/20 px-3 py-2 text-xs text-muted-foreground flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Activity className="h-3.5 w-3.5 flex-shrink-0" />
          <span>{actionLabel(item.action ?? "", item.auditChanges)}</span>
          {item.actorName && <span>· {item.actorName}</span>}
        </div>
        <span className="flex-shrink-0">{relativeTime(item.ts)}</span>
      </div>
    );
  }

  return null;
}
