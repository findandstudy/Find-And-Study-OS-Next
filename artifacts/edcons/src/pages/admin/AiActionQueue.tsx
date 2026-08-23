import { useEffect, useState } from "react";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Check,
  Loader2,
  ListChecks,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { useI18n } from "@/hooks/use-i18n";
import { useToast } from "@/hooks/use-toast";
import { TablePagination, useTablePagination } from "@/components/TablePagination";

type PortalDiagnosis = {
  classification?: string;
  confidence?: number;
  risk?: string;
  retrySafe?: boolean;
  requiresCodeChange?: boolean;
  summary?: string;
  evidence?: string[];
  recommendedAction?: string;
  missingDataFields?: string[];
  selectorCandidates?: unknown[];
  proposedSpecPatch?: unknown[];
};

type ActionItem = {
  id: number;
  personaId: number;
  personaName: string | null;
  runId: number | null;
  actionType: string;
  payload: {
    context?: {
      submissionId?: number;
      universityKey?: string;
      adapterKey?: string;
      reviewOnly?: boolean;
      baseSpecId?: number;
      baseSpecVersion?: number;
      draftSpecId?: number;
      draftSpecVersion?: number;
    };
    diagnosis?: PortalDiagnosis;
    structuredOutputValid?: boolean;
    staging?: {
      status?: "passed" | "failed";
      mode?: string;
      baseSpecHash?: string;
      patchedSpecHash?: string;
      reportHash?: string;
      changedPaths?: string[];
      checks?: Array<{ key: string; passed: boolean; detail: string }>;
      canaryRequired?: boolean;
      limitations?: string[];
    };
    deployment?: {
      automaticExecution?: boolean;
      productionChanged?: boolean;
      requiresManualDeployment?: boolean;
      requiresFreshReadOnlyProbe?: boolean;
      requiresAuthorizedCanary?: boolean;
      checklist?: string[];
      rollback?: { specId?: number; specVersion?: number };
    };
  } | null;
  preview: string | null;
  status: string;
  createdAt: string;
  reviewedAt: string | null;
  reviewerEmail: string | null;
};

export default function AiActionQueue() {
  const { t } = useI18n();
  const { toast } = useToast();
  const [items, setItems] = useState<ActionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [reviewingId, setReviewingId] = useState<number | null>(null);
  const [suppressedGuardianCount, setSuppressedGuardianCount] = useState(0);
  const historyPagination = useTablePagination(25);

  const load = async () => {
    try {
      const data = await customFetch<{
        actions: ActionItem[];
        suppressed?: { guardianNoEnabledSpec?: number };
      }>(
        "/api/ai-personas/queue/actions",
      );
      setItems(data.actions);
      setSuppressedGuardianCount(
        data.suppressed?.guardianNoEnabledSpec ?? 0,
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const review = async (id: number, decision: "approved" | "rejected") => {
    setReviewingId(id);
    try {
      const result = await customFetch<{ message?: string }>(`/api/ai-personas/queue/actions/${id}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      toast({
        title:
          decision === "approved"
            ? t("aiActionQueue.approvedToast")
            : t("aiActionQueue.rejectedToast"),
        description: result.message ?? t("aiActionQueue.reviewOnlyNotice"),
      });
      await load();
    } catch (error) {
      toast({
        title: t("aiActionQueue.reviewError"),
        description: (error as Error).message,
        variant: "destructive",
      });
    } finally {
      setReviewingId(null);
    }
  };

  const pending = items.filter((i) => i.status === "pending_approval");
  const history = items.filter((i) => i.status !== "pending_approval");
  const { paged: pagedHistory, total: historyTotal } = historyPagination.paginate(history);

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <ListChecks className="h-6 w-6 text-indigo-500" /> {t("aiActionQueue.title")}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {t("aiActionQueue.subtitle")}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("aiActionQueue.pendingTitle", { count: pending.length })}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {loading && <div className="text-sm text-muted-foreground">{t("aiActionQueue.loading")}</div>}
          {!loading && pending.length === 0 && (
            <div className="text-sm text-muted-foreground">{t("aiActionQueue.noPending")}</div>
          )}
          {pending.map((a) => (
            <div key={a.id} className="border rounded p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm">
                  <Badge variant="outline">{a.actionType}</Badge>
                  <span className="text-muted-foreground">
                    {a.personaName ?? t("aiActionQueue.personaShort", { id: a.personaId })} · {t("aiActionQueue.runShort", { id: a.runId ?? "—" })}
                  </span>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={reviewingId === a.id}
                    onClick={() => void review(a.id, "rejected")}
                  >
                    {reviewingId === a.id
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <X className="h-3.5 w-3.5" />}
                    {t("aiActionQueue.reject")}
                  </Button>
                  <Button
                    size="sm"
                    disabled={
                      reviewingId === a.id ||
                      (a.actionType === "portal_fix_proposal" &&
                        a.payload?.staging?.status !== "passed")
                    }
                    onClick={() => void review(a.id, "approved")}
                  >
                    {reviewingId === a.id
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Check className="h-3.5 w-3.5" />}
                    {a.actionType === "portal_fix_proposal"
                      ? t("aiActionQueue.approveStaging")
                      : a.actionType === "portal_deploy_proposal"
                        ? t("aiActionQueue.approveDeployProposal")
                        : t("aiActionQueue.approve")}
                  </Button>
                </div>
              </div>
              {["portal_fix_proposal", "portal_deploy_proposal"].includes(
                a.actionType,
              ) && a.payload?.diagnosis ? (
                <div className="rounded-lg border border-indigo-200 bg-indigo-50/50 p-3 dark:border-indigo-900 dark:bg-indigo-950/20 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <ShieldAlert className="h-4 w-4 text-indigo-600" />
                    <Badge variant="secondary">{a.payload.diagnosis.classification}</Badge>
                    <Badge variant="outline">
                      {t("aiActionQueue.riskLabel")}: {a.payload.diagnosis.risk}
                    </Badge>
                    <Badge variant="outline">
                      {t("aiActionQueue.confidenceLabel")}:{" "}
                      {Math.round((a.payload.diagnosis.confidence ?? 0) * 100)}%
                    </Badge>
                    {a.payload.context?.submissionId && (
                      <a
                        href="/admin/portal-automation"
                        className="text-xs text-primary hover:underline"
                      >
                        {t("aiActionQueue.submissionShort", {
                          id: a.payload.context.submissionId,
                        })}
                      </a>
                    )}
                  </div>
                  <p className="text-sm">{a.payload.diagnosis.summary}</p>
                  <div className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {t("aiActionQueue.recommendedAction")}:
                    </span>{" "}
                    {a.payload.diagnosis.recommendedAction}
                  </div>
                  {a.payload.staging && (
                    <div className="rounded border bg-background/80 p-2 space-y-2">
                      <div className="flex flex-wrap items-center gap-2 text-xs font-medium">
                        <ShieldCheck className="h-4 w-4 text-emerald-600" />
                        {t("aiActionQueue.stagingReport")}
                        <Badge
                          variant={
                            a.payload.staging.status === "passed"
                              ? "secondary"
                              : "destructive"
                          }
                        >
                          {a.payload.staging.status ?? "—"}
                        </Badge>
                        <span className="text-muted-foreground">
                          {a.payload.staging.mode ?? "—"}
                        </span>
                      </div>
                      <ul className="grid gap-1 text-xs sm:grid-cols-2">
                        {a.payload.staging.checks?.map((check) => (
                          <li key={`${a.id}-${check.key}`} className="flex gap-1.5">
                            <span
                              className={
                                check.passed ? "text-emerald-600" : "text-destructive"
                              }
                            >
                              {check.passed ? "✓" : "✕"}
                            </span>
                            <span title={check.detail}>{check.key}</span>
                          </li>
                        ))}
                      </ul>
                      {!!a.payload.staging.changedPaths?.length && (
                        <div className="text-xs text-muted-foreground">
                          {t("aiActionQueue.changedPaths")}: {a.payload.staging.changedPaths.join(", ")}
                        </div>
                      )}
                      <div className="text-xs text-amber-700 dark:text-amber-400">
                        {t("aiActionQueue.offlineStagingLimitation")}
                      </div>
                    </div>
                  )}
                  {a.actionType === "portal_deploy_proposal" &&
                    a.payload.deployment && (
                      <div className="rounded border border-amber-300 bg-amber-50/70 p-2 text-xs dark:border-amber-900 dark:bg-amber-950/20">
                        <div className="font-medium">
                          {t("aiActionQueue.manualDeployChecklist")}
                        </div>
                        <ol className="mt-1 list-decimal space-y-1 pl-5">
                          {a.payload.deployment.checklist?.map((item, index) => (
                            <li key={`${a.id}-deploy-${index}`}>{item}</li>
                          ))}
                        </ol>
                        <div className="mt-2 font-medium text-amber-800 dark:text-amber-300">
                          {t("aiActionQueue.deployApprovalNotice")}
                        </div>
                      </div>
                    )}
                  {(a.payload.diagnosis.evidence?.length ||
                    a.payload.diagnosis.selectorCandidates?.length ||
                    a.payload.diagnosis.proposedSpecPatch?.length) && (
                    <details className="rounded border bg-background/70 p-2 text-xs">
                      <summary className="cursor-pointer font-medium">
                        {t("aiActionQueue.technicalDetails")}
                      </summary>
                      <div className="mt-2 space-y-2">
                        {!!a.payload.diagnosis.evidence?.length && (
                          <ul className="list-disc space-y-1 pl-5">
                            {a.payload.diagnosis.evidence.map((item, index) => (
                              <li key={`${a.id}-evidence-${index}`}>{item}</li>
                            ))}
                          </ul>
                        )}
                        {!!a.payload.diagnosis.selectorCandidates?.length && (
                          <pre className="max-h-48 overflow-auto rounded bg-muted p-2 whitespace-pre-wrap">
                            {JSON.stringify(
                              a.payload.diagnosis.selectorCandidates,
                              null,
                              2,
                            )}
                          </pre>
                        )}
                        {!!a.payload.diagnosis.proposedSpecPatch?.length && (
                          <pre className="max-h-64 overflow-auto rounded bg-muted p-2 whitespace-pre-wrap">
                            {JSON.stringify(
                              a.payload.diagnosis.proposedSpecPatch,
                              null,
                              2,
                            )}
                          </pre>
                        )}
                      </div>
                    </details>
                  )}
                  <div className="text-xs text-amber-700 dark:text-amber-400">
                    {a.actionType === "portal_fix_proposal"
                      ? t("aiActionQueue.stagingApprovalNotice")
                      : t("aiActionQueue.deployApprovalNotice")}
                  </div>
                </div>
              ) : a.preview ? (
                <pre className="bg-muted p-2 rounded text-xs whitespace-pre-wrap max-h-48 overflow-auto">
                  {a.preview}
                </pre>
              ) : null}
              <div className="text-xs text-muted-foreground">
                {new Date(a.createdAt).toLocaleString()}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {suppressedGuardianCount > 0 && (
        <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-200">
          {t("aiActionQueue.suppressedGuardianNotice", {
            count: suppressedGuardianCount,
          })}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("aiActionQueue.historyTitle", { count: history.length })}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {history.length === 0 && (
            <div className="text-sm text-muted-foreground">{t("aiActionQueue.noHistory")}</div>
          )}
          {pagedHistory.map((a) => (
            <div
              key={a.id}
              className="border rounded p-2 text-sm flex items-center justify-between"
            >
              <div className="flex items-center gap-2">
                <Badge variant="secondary">{a.status}</Badge>
                <span>{a.actionType}</span>
                <span className="text-muted-foreground">
                  · {a.personaName ?? `#${a.personaId}`}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                {a.reviewerEmail ?? ""} {a.reviewedAt ? new Date(a.reviewedAt).toLocaleString() : ""}
              </div>
            </div>
          ))}
          {historyTotal > 0 && (
            <TablePagination
              currentPage={historyPagination.page}
              totalItems={historyTotal}
              pageSize={historyPagination.pageSize}
              onPageChange={historyPagination.setPage}
              onPageSizeChange={historyPagination.setPageSize}
              pageSizeOptions={[10, 25, 50, 100]}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
