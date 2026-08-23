/**
 * PortalAuditTab.tsx — SUB-STEP J
 *
 * Portal automation audit log viewer.
 * Fetches audit_logs filtered to portal-related actions via:
 *   GET /api/audit-log?search=portal&limit=50&page=N
 */

import { useState, useEffect, useCallback } from "react";
import { customFetch } from "@workspace/api-client-react";
import { useI18n } from "@/hooks/use-i18n";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import { RefreshCw, Loader2, ChevronDown, ScrollText } from "lucide-react";
import {
  PortalEmptyState, PortalErrorState,
} from "@/components/admin/PortalTabStates";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuditEntry {
  id: number;
  userId: number | null;
  action: string;
  resource: string;
  resourceId: number | null;
  changes: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
  userName: string | null;
}

interface AuditResponse {
  data: AuditEntry[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACTION_COLORS: Record<string, string> = {
  create:   "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  update:   "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  delete:   "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  activate: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  deactivate:"bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
  enqueue:  "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  retry:    "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  cancel:   "bg-muted text-muted-foreground",
  test:     "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400",
};

function actionColor(action: string): string {
  const verb = action.split("_")[0] ?? "";
  return ACTION_COLORS[verb] ?? "bg-muted text-muted-foreground";
}

function formatAction(action: string): string {
  return action.replace(/_/g, " ").replace(/portal /i, "");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PortalAuditTab() {
  const { t } = useI18n();
  const { toast } = useToast();

  const [entries, setEntries]   = useState<AuditEntry[]>([]);
  const [total, setTotal]       = useState(0);
  const [page, setPage]         = useState(1);
  const [loading, setLoading]   = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [loadingMore, setLdgMore] = useState(false);
  const limit = 50;

  const load = useCallback(async (p: number, append: boolean) => {
    if (append) setLdgMore(true); else { setLoading(true); setLoadError(false); }
    try {
      const params = new URLSearchParams({
        search: "portal",
        limit:  String(limit),
        page:   String(p),
      });
      const res = await customFetch<AuditResponse>(`/api/audit?${params}`);
      const logs = res.data ?? [];
      setTotal(res.meta?.total ?? 0);
      setEntries((prev) => append ? [...prev, ...logs] : logs);
    } catch {
      if (!append) setLoadError(true);
      toast({ title: t("portalAutomation.auditLog.loadError"), variant: "destructive" });
    } finally {
      setLoading(false);
      setLdgMore(false);
    }
  }, [t, toast]);

  useEffect(() => { load(1, false); }, [load]);

  const handleLoadMore = () => {
    const next = page + 1;
    setPage(next);
    load(next, true);
  };

  const hasMore = entries.length < total;

  return (
    <div className="space-y-4 py-2">
      {/* Header / refresh */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {t("portalAutomation.auditLog.description")}
        </p>
        <Button
          variant="outline" size="sm" className="h-9 gap-1.5"
          onClick={() => { setPage(1); load(1, false); }}
          disabled={loading}
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          {t("portalAutomation.auditLog.refreshButton")}
        </Button>
      </div>

      {/* Entries */}
      {loading ? (
        <div className="space-y-2">
          {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-12 w-full rounded-lg" />)}
        </div>
      ) : loadError ? (
        <PortalErrorState onRetry={() => { setPage(1); load(1, false); }} retrying={loading} />
      ) : entries.length === 0 ? (
        <PortalEmptyState
          icon={ScrollText}
          title={t("portalAutomation.auditLog.emptyTitle")}
          description={t("portalAutomation.auditLog.noData")}
        />
      ) : (
        <div className="rounded-xl border overflow-hidden divide-y divide-border">
          {entries.map((e) => (
            <div key={e.id} className="flex items-start gap-3 px-4 py-3 bg-card hover:bg-muted/30 transition-colors flex-wrap">
              {/* Action badge */}
              <Badge className={`text-[11px] py-0 h-5 shrink-0 mt-0.5 ${actionColor(e.action)}`}>
                {formatAction(e.action)}
              </Badge>

              {/* Details */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                  <span className="font-medium text-foreground">
                    {e.resource}
                    {e.resourceId ? ` #${e.resourceId}` : ""}
                  </span>
                  {e.changes && Object.keys(e.changes).length > 0 && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="underline decoration-dotted cursor-help">
                            {Object.keys(e.changes).slice(0, 3).join(", ")}
                            {Object.keys(e.changes).length > 3 ? "…" : ""}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-sm">
                          <pre className="text-[11px] break-words whitespace-pre-wrap">
                            {JSON.stringify(e.changes, null, 2)}
                          </pre>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
              </div>

              {/* Actor + time */}
              <div className="text-right shrink-0">
                <p className="text-xs font-medium text-foreground">
                  {e.userName ?? "System"}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {new Date(e.createdAt).toLocaleString()}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Load more */}
      {hasMore && (
        <div className="text-center pt-1">
          <Button
            variant="outline" size="sm" className="gap-1.5"
            onClick={handleLoadMore}
            disabled={loadingMore}
          >
            {loadingMore
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <ChevronDown className="w-3.5 h-3.5" />}
            {t("portalAutomation.auditLog.loadMore")}
            <span className="text-muted-foreground text-xs">({entries.length}/{total})</span>
          </Button>
        </div>
      )}
    </div>
  );
}
