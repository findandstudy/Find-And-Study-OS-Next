import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

export type StageActionType = "upload" | "download" | "missing_docs";
export interface StageAction {
  type: StageActionType;
  label?: string | null;
  documentName?: string | null;
  color?: string | null;
  // Empty / null = "Don't change" — no stage transition after action.
  targetStageKey?: string | null;
  requiredDocTypes?: string[];
}

export interface PipelineStage {
  id?: number;
  entityType: string;
  key: string;
  label: string;
  sortOrder: number;
  variant?: string | null;
  icon?: string | null;
  color?: string | null;
  isNotesMandatory?: boolean;
  canAttachFile?: boolean;
  maxFiles?: number;
  isFileUploadMandatory?: boolean;
  canGoBack?: boolean;
  isCaseClose?: boolean;
  countries?: string | null;
  mappedStudentStageKey?: string | null;
  // Task #134 — dynamic stage behaviors:
  uploadPermissionLevel?: string;
  tracksOfferExpiry?: boolean;
  requiresValidUntil?: boolean;
  commissionFinanceStatus?: string | null;
  serviceFeeFinanceStatus?: string | null;
  autoCancelSiblingsOnWon?: boolean;
  // Task #167 — up to 2 admin-defined action buttons (application only).
  actions?: StageAction[];
  // Task #187 — id of the stage the application auto-advances to once
  // every catalog-based missing-doc request on this stage is fulfilled.
  missingDocsFulfilledTargetStageId?: number | null;
  // Convenience key form derived/used by the admin UI; the server accepts
  // this on PUT (preferred over id, since ids change across resaves).
  missingDocsFulfilledTargetStageKey?: string | null;
}

async function fetchStages(entityType: string): Promise<PipelineStage[]> {
  const r = await fetch(`${BASE_URL}/api/pipeline-stages/${entityType}`, { credentials: "include" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function deduplicateStages(stages: PipelineStage[]): PipelineStage[] {
  const seen = new Set<string>();
  return stages.filter(s => {
    if (seen.has(s.key)) return false;
    seen.add(s.key);
    return true;
  });
}

export interface SaveStagesResult {
  stages: PipelineStage[];
  warnings: string[];
}

async function saveStages(entityType: string, stages: PipelineStage[]): Promise<SaveStagesResult> {
  const r = await fetch(`${BASE_URL}/api/pipeline-stages/${entityType}`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stages }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const body = await r.json();
  // Backwards-compat: server may return either an array of stages
  // (legacy) or `{ stages, warnings }` (Task #134).
  if (Array.isArray(body)) return { stages: body, warnings: [] };
  return { stages: body.stages || [], warnings: Array.isArray(body.warnings) ? body.warnings : [] };
}

export function usePipelineStages(entityType: string) {
  const queryClient = useQueryClient();

  const query = useQuery<PipelineStage[]>({
    queryKey: ["pipeline-stages", entityType],
    queryFn: () => fetchStages(entityType),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const uniqueStages = useMemo(
    () => deduplicateStages(query.data ?? []),
    [query.data]
  );

  const mutation = useMutation({
    mutationFn: (stages: PipelineStage[]) => saveStages(entityType, stages),
    onSuccess: (data) => {
      queryClient.setQueryData(["pipeline-stages", entityType], data.stages);
    },
  });

  return {
    stages: uniqueStages,
    isLoading: query.isLoading,
    saveStages: mutation.mutateAsync,
    isSaving: mutation.isPending,
  };
}
