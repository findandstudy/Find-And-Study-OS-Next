/**
 * PortalSubmissionPanel.tsx — "Üniversite portalına gönder" paneli
 *
 * ApplicationDetail içine gömülür.
 * Orval hook'ları kullanır; queued/running durumlarında 5 sn'de bir poll yapar.
 */

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  customFetch,
  useGetUniversityPortals,
  useEnqueuePortalSubmission,
  useRetryPortalSubmission,
  useApplyToAllUniversities,
  getGetPortalSubmissionsQueryOptions,
} from "@workspace/api-client-react";
import type {
  PortalSubmission,
  UniversityPortal,
  ApplyToAllItem,
} from "@workspace/api-client-react";
import { formatDate } from "@workspace/i18n";
import { useI18n } from "@/hooks/use-i18n";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Send, RefreshCw, ShieldCheck, Rocket } from "lucide-react";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACTIVE_STATUSES = new Set<string>(["queued", "running"]);

const STATUS_COLORS: Record<string, string> = {
  queued:          "bg-gray-100 text-gray-700 dark:bg-gray-800/50 dark:text-gray-300",
  running:         "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  submitted:       "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  already_exists:  "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
  program_missing: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  failed:          "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  canceled:        "bg-muted text-muted-foreground",
  dry_run:         "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
};

const APPLY_ALL_OUTCOME_COLORS: Record<string, string> = {
  queued:       "bg-gray-100 text-gray-700 dark:bg-gray-800/50 dark:text-gray-300",
  excluded:     "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  "no-program": "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  duplicate:    "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
  failed:       "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

/** Roles that may trigger a "real" (non-dry) submission */
const REAL_SUBMISSION_ROLES = ["super_admin", "admin", "manager", "staff"];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  applicationId: number;
  /** Pre-selects the portal whose label matches this university */
  universityName?: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PortalSubmissionPanel({ applicationId, universityName }: Props) {
  const { t, dir } = useI18n();
  const { toast } = useToast();
  const { user: authUser } = useAuth();

  const canSendReal = authUser ? REAL_SUBMISSION_ROLES.includes(authUser.role) : false;

  // ----- Resolved submission target (multi-portal routing badge) ----------
  const [resolveInfo, setResolveInfo] = useState<{
    portalKey: string;
    routed: boolean;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await customFetch<{
          resolved: boolean;
          portalKey?: string;
          routed?: boolean;
        }>(`/api/portal-automation/resolve?applicationId=${applicationId}`);
        if (!cancelled) {
          setResolveInfo(
            res.resolved && res.portalKey
              ? { portalKey: res.portalKey, routed: res.routed ?? false }
              : null,
          );
        }
      } catch {
        if (!cancelled) setResolveInfo(null);
      }
    })();
    return () => { cancelled = true; };
  }, [applicationId]);

  // ----- Portal list -------------------------------------------------------
  const { data: portalsRaw, isLoading: portalsLoading } = useGetUniversityPortals();
  const portals: UniversityPortal[] = Array.isArray(portalsRaw) ? portalsRaw : [];

  // ----- Submissions list (auto-poll) -------------------------------------
  const subsQueryOpts = getGetPortalSubmissionsQueryOptions({ applicationId, limit: 20 });
  const { data: subsRaw, refetch: refetchSubs } = useQuery({
    ...subsQueryOpts,
    refetchInterval: (query) => {
      const rows: PortalSubmission[] = (query.state.data as { data?: PortalSubmission[] } | undefined)?.data ?? [];
      return rows.some((s) => ACTIVE_STATUSES.has(s.status)) ? 5000 : false;
    },
  });
  const subs: PortalSubmission[] = (subsRaw as { data?: PortalSubmission[] })?.data ?? [];

  // ----- Form state --------------------------------------------------------
  const defaultKey =
    portals.find(
      (p) =>
        universityName &&
        p.label.toLowerCase() === universityName.toLowerCase(),
    )?.key ?? "";

  const [selectedKey, setSelectedKey] = useState<string>("");
  const effectiveKey = selectedKey || defaultKey;
  const [mode, setMode] = useState<"dry" | "real">("dry");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applyAllOpen, setApplyAllOpen] = useState(false);
  const [applyAllResults, setApplyAllResults] = useState<ApplyToAllItem[] | null>(null);

  // ----- Mutations ---------------------------------------------------------
  const enqueueMutation = useEnqueuePortalSubmission({
    mutation: {
      onSuccess: () => {
        toast({ title: t("portalAutomation.panel.enqueuedSuccess") });
        void refetchSubs();
      },
      onError: () => {
        toast({
          title: t("portalAutomation.panel.enqueuedError"),
          variant: "destructive",
        });
      },
    },
  });

  const retryMutation = useRetryPortalSubmission({
    mutation: {
      onSuccess: () => {
        toast({ title: t("portalAutomation.panel.retrySuccess") });
        void refetchSubs();
      },
      onError: () => {
        toast({
          title: t("portalAutomation.panel.retryError"),
          variant: "destructive",
        });
      },
    },
  });

  const applyAllMutation = useApplyToAllUniversities({
    mutation: {
      onSuccess: (data) => {
        setApplyAllResults(data.results);
        toast({
          title: t("portalAutomation.applyAll.done", { queued: data.counts.queued }),
        });
        void refetchSubs();
      },
      onError: () => {
        toast({
          title: t("portalAutomation.applyAll.error"),
          variant: "destructive",
        });
      },
    },
  });

  // ----- Handlers ----------------------------------------------------------
  function handleEnqueue() {
    if (!effectiveKey) return;
    if (mode === "real") {
      setConfirmOpen(true);
      return;
    }
    enqueueMutation.mutate({
      appId: applicationId,
      data: { universityKey: effectiveKey, mode: "dry" },
    });
  }

  function handleConfirmReal() {
    setConfirmOpen(false);
    enqueueMutation.mutate({
      appId: applicationId,
      data: { universityKey: effectiveKey, mode: "real", confirm: true },
    });
  }

  function handleRetry(id: number) {
    retryMutation.mutate({ id });
  }

  function handleConfirmApplyAll() {
    setApplyAllOpen(false);
    setApplyAllResults(null);
    applyAllMutation.mutate({
      data: {
        applicationId,
        mode,
        ...(mode === "real" ? { confirm: true } : {}),
      },
    });
  }

  // ----- Derived -----------------------------------------------------------
  const selectedPortal = portals.find((p) => p.key === effectiveKey);
  const isEnqueueDisabled =
    !effectiveKey ||
    !selectedPortal?.hasCredentials ||
    enqueueMutation.isPending;

  // ----- Render ------------------------------------------------------------
  return (
    <Card className="rounded-2xl border shadow-sm mt-6" dir={dir}>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <Send className="w-4 h-4" />
          {t("portalAutomation.panel.panelTitle")}
          {resolveInfo && (
            <Badge
              variant="secondary"
              className="font-normal gap-1"
              title={t("portalAutomation.members.targetTooltip")}
            >
              {t("portalAutomation.members.targetLabel")}: {resolveInfo.portalKey}
              {resolveInfo.routed && (
                <span className="text-xs text-muted-foreground">
                  ({t("portalAutomation.members.routedTag")})
                </span>
              )}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* ---- Enqueue form ---- */}
        <div className="flex flex-wrap gap-3 items-end">
          {/* University selector */}
          <div className="space-y-1 min-w-[220px]">
            <Label className="text-xs">{t("portalAutomation.panel.target")}</Label>
            {portalsLoading ? (
              <Skeleton className="h-9 w-[240px]" />
            ) : (
              <Select
                value={effectiveKey}
                onValueChange={(v) => setSelectedKey(v)}
                disabled={portals.length === 0}
              >
                <SelectTrigger className="h-9 w-[240px]">
                  <SelectValue placeholder={t("portalAutomation.panel.target")} />
                </SelectTrigger>
                <SelectContent>
                  {portals.length === 0 ? (
                    <SelectItem value="__none__" disabled>
                      {t("portalAutomation.panel.noPortals")}
                    </SelectItem>
                  ) : (
                    portals.map((p) => (
                      <SelectItem key={p.key} value={p.key} disabled={!p.hasCredentials}>
                        <span className="flex items-center gap-1.5">
                          {p.label}
                          {!p.hasCredentials && (
                            <span className="text-muted-foreground text-[11px]">
                              ({t("portalAutomation.panel.outOfScope")})
                            </span>
                          )}
                        </span>
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Mode selector */}
          <div className="space-y-1">
            <Label className="text-xs">{t("portalAutomation.rules.modeLabel")}</Label>
            <Select
              value={mode}
              onValueChange={(v) => setMode(v as "dry" | "real")}
            >
              <SelectTrigger className="h-9 w-[200px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dry">{t("portalAutomation.panel.modeDry")}</SelectItem>
                {canSendReal && (
                  <SelectItem value="real">{t("portalAutomation.panel.modeReal")}</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>

          {/* Submit button */}
          <Button
            size="sm"
            className="h-9 gap-1.5"
            onClick={handleEnqueue}
            disabled={isEnqueueDisabled}
          >
            {enqueueMutation.isPending ? (
              <>
                <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin inline-block" />
                {t("portalAutomation.panel.submitting")}
              </>
            ) : (
              <>
                <Send className="w-3.5 h-3.5" />
                {t("portalAutomation.panel.enqueue")}
              </>
            )}
          </Button>

          {/* Apply-to-all button */}
          <Button
            size="sm"
            variant="secondary"
            className="h-9 gap-1.5"
            onClick={() => { setApplyAllResults(null); setApplyAllOpen(true); }}
            disabled={portals.length === 0 || applyAllMutation.isPending}
            title={t("portalAutomation.applyAll.buttonHint")}
          >
            {applyAllMutation.isPending ? (
              <>
                <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin inline-block" />
                {t("portalAutomation.applyAll.submitting")}
              </>
            ) : (
              <>
                <Rocket className="w-3.5 h-3.5" />
                {t("portalAutomation.applyAll.button")}
              </>
            )}
          </Button>
        </div>

        {/* ---- Apply-to-all results ---- */}
        {applyAllResults && applyAllResults.length > 0 && (
          <div className="space-y-2 pt-1">
            <p className="text-xs font-medium text-muted-foreground">
              {t("portalAutomation.applyAll.resultsTitle")}
            </p>
            <div className="rounded-lg border divide-y divide-border overflow-hidden">
              {applyAllResults.map((r) => (
                <div
                  key={r.universityKey}
                  className="flex items-center gap-2 px-3 py-2 text-xs bg-card flex-wrap"
                >
                  <Badge
                    className={`text-[11px] py-0 h-5 ${APPLY_ALL_OUTCOME_COLORS[r.outcome] ?? "bg-muted text-muted-foreground"}`}
                  >
                    {t(`portalAutomation.applyAll.outcome.${r.outcome === "no-program" ? "noProgram" : r.outcome}`)}
                  </Badge>
                  <span className="font-medium">{r.universityName}</span>
                  {r.programName && (
                    <span className="text-muted-foreground truncate max-w-[220px]">
                      {r.programName}
                      {typeof r.confidence === "number" && (
                        <span className="ml-1 opacity-70">
                          ({Math.round(r.confidence * 100)}%)
                        </span>
                      )}
                    </span>
                  )}
                  {r.message && (
                    <span className="text-muted-foreground truncate max-w-[220px]">
                      {r.message}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ---- Submissions list ---- */}
        {subs.length > 0 && (
          <div className="space-y-2 pt-1">
            <p className="text-xs font-medium text-muted-foreground">
              {t("portalAutomation.panel.recentTitle")}
            </p>
            <div className="rounded-lg border divide-y divide-border overflow-hidden">
              {subs.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center gap-2 px-3 py-2 text-xs bg-card flex-wrap"
                >
                  <Badge
                    className={`text-[11px] py-0 h-5 ${STATUS_COLORS[s.status] ?? "bg-muted text-muted-foreground"}`}
                  >
                    {t(`portalAutomation.panel.status.${s.status}`) || s.status}
                  </Badge>
                  <span className="font-medium">{s.universityName}</span>
                  <Badge
                    variant={s.mode === "real" ? "default" : "secondary"}
                    className="text-[11px] py-0 h-5"
                  >
                    {s.mode}
                  </Badge>
                  {s.externalRef && (
                    <span className="text-muted-foreground">
                      {t("portalAutomation.panel.externalRef")}: {s.externalRef}
                    </span>
                  )}
                  {s.error && (
                    <span className="text-destructive truncate max-w-[200px]">
                      {s.error}
                    </span>
                  )}
                  <span className="text-muted-foreground ml-auto">
                    {formatDate(s.updatedAt)}
                  </span>
                  {(s.status === "failed" || s.status === "canceled") && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 px-1.5 text-[11px] gap-1"
                      onClick={() => handleRetry(s.id)}
                      disabled={retryMutation.isPending}
                    >
                      <RefreshCw className="w-2.5 h-2.5" />
                      {t("portalAutomation.panel.retry")}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>

      {/* ---- Real submission confirm dialog ---- */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-destructive" />
              {t("portalAutomation.panel.confirmRealTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("portalAutomation.panel.confirmRealBody")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmReal}
              disabled={enqueueMutation.isPending}
            >
              {enqueueMutation.isPending ? (
                <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin inline-block" />
              ) : (
                t("portalAutomation.panel.enqueue")
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- Apply-to-all confirm dialog ---- */}
      <Dialog open={applyAllOpen} onOpenChange={setApplyAllOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Rocket className="w-5 h-5 text-primary" />
              {t("portalAutomation.applyAll.confirmTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("portalAutomation.applyAll.confirmBody", {
                count: portals.length,
                mode: t(mode === "real" ? "portalAutomation.panel.modeReal" : "portalAutomation.panel.modeDry"),
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApplyAllOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant={mode === "real" ? "destructive" : "default"}
              onClick={handleConfirmApplyAll}
              disabled={applyAllMutation.isPending}
            >
              {applyAllMutation.isPending ? (
                <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin inline-block" />
              ) : (
                t("portalAutomation.applyAll.confirmCta")
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
