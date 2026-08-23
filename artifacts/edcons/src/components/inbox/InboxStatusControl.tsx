import { useState } from "react";
import { Loader2 } from "lucide-react";
import { customFetch } from "@workspace/api-client-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/hooks/use-auth";
import { useI18n } from "@/hooks/use-i18n";
import { useToast } from "@/hooks/use-toast";
import { usePipelineStages } from "@/hooks/use-pipeline-stages";
import { requestStageChange } from "@/lib/stageTransition";
import {
  canChangeInboxStatus,
  type InboxStatusEntityType,
} from "@/lib/inboxStatusPermissions";
import { PipelineStageBadge } from "./PipelineStageBadge";

interface InboxStatusControlProps {
  entityType: InboxStatusEntityType;
  entityId: number;
  status: string;
  label?: string;
  onUpdated?: () => void;
}

function blockedApplicationStageMessage(
  result: Exclude<Awaited<ReturnType<typeof requestStageChange>>, { kind: "ok" }>,
  fallback: string,
): string {
  if (result.kind === "doc_selection_required") {
    return result.actionLabel || fallback;
  }
  if (result.kind === "docs_incomplete") {
    const missing = result.missing
      .map((item) => item.customTitle || item.documentType)
      .filter(Boolean)
      .join(", ");
    return missing ? `${fallback}: ${missing}` : fallback;
  }
  if (result.kind === "docs_required") {
    return fallback;
  }
  if (result.kind === "student_docs_required") {
    return result.missingDocTypes.length > 0
      ? `${fallback}: ${result.missingDocTypes.join(", ")}`
      : fallback;
  }
  return result.message || fallback;
}

export function InboxStatusControl({
  entityType,
  entityId,
  status,
  label,
  onUpdated,
}: InboxStatusControlProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const { user } = useAuth();
  const { stages, isLoading } = usePipelineStages(entityType);
  const [saving, setSaving] = useState(false);

  const permissions = ((user as any)?.permissions as string[] | undefined) ?? [];
  const canChange = canChangeInboxStatus(user?.role, permissions, entityType);
  const currentStage =
    stages.find((stage) => stage.key === status) ??
    (status
      ? {
          entityType,
          key: status,
          label: status.replace(/_/g, " "),
          sortOrder: 0,
          color: null,
          variant: null,
        }
      : null);

  async function changeStatus(nextStatus: string) {
    if (!canChange || saving || nextStatus === status) return;
    setSaving(true);
    try {
      if (entityType === "application") {
        const result = await requestStageChange(entityId, nextStatus);
        if (result.kind !== "ok") {
          toast({
            title: t("applicationDetailPage.errorTitle"),
            description: blockedApplicationStageMessage(
              result,
              t("applicationDetailPage.couldNotUpdateStage"),
            ),
            variant: "destructive",
          });
          return;
        }
        toast({ title: t("applicationDetailPage.stageUpdated") });
      } else if (
        entityType === "lead" &&
        stages.find((stage) => stage.key === nextStatus)?.variant === "won"
      ) {
        await customFetch(`/api/leads/${entityId}/convert`, { method: "POST" });
        toast({ title: t("leadDetailPage.statusUpdated") });
      } else {
        await customFetch(`/api/${entityType === "lead" ? "leads" : "students"}/${entityId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: nextStatus }),
        });
        toast({
          title:
            entityType === "lead"
              ? t("leadDetailPage.statusUpdated")
              : t("common.saved"),
        });
      }
      onUpdated?.();
    } catch (error: any) {
      const message =
        error?.data?.error ??
        error?.body?.error ??
        error?.message ??
        t("inbox.sidebar.updateFailed");
      toast({
        title: t("inbox.sidebar.updateFailed"),
        description: typeof message === "string" ? message : undefined,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-1" data-testid={`inbox-${entityType}-status-control`}>
      {label && (
        <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
          {label}
        </div>
      )}
      {canChange ? (
        <Select
          value={status}
          onValueChange={(value) => void changeStatus(value)}
          disabled={saving || isLoading || stages.length === 0}
        >
          <SelectTrigger
            className="h-8 w-full text-xs"
            data-testid={`inbox-${entityType}-status-select`}
          >
            <div className="flex items-center gap-1.5 min-w-0">
              {saving && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
              <SelectValue placeholder={t("common.status")} />
            </div>
          </SelectTrigger>
          <SelectContent>
            {stages.map((stage) => (
              <SelectItem key={stage.key} value={stage.key}>
                {stage.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <PipelineStageBadge stage={currentStage} size="md" />
      )}
    </div>
  );
}
