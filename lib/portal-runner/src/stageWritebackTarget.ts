import type { SubmitResult } from "@workspace/portal-adapters";

export type SubmissionStatus =
  | "submitted"
  | "program_missing"
  | "already_exists"
  | "program_full"
  | "exclusive_region"
  | "failed"
  | "dry_run";

export interface WritebackTarget {
  submissionStatus: SubmissionStatus;
  /** pipeline_stages.key to set on the application; null = no change */
  stageKey: string | null;
}

/** Pure result-to-stage reducer shared by the DB writeback and unit tests. */
export function resolveWritebackTarget(
  result: SubmitResult | null,
  meta?: Record<string, unknown>,
): WritebackTarget {
  if (!result) {
    return { submissionStatus: "failed", stageKey: null };
  }
  if (result.exclusiveRegion) {
    return { submissionStatus: "exclusive_region", stageKey: null };
  }
  if (result.skippedNotMember) {
    return { submissionStatus: "exclusive_region", stageKey: null };
  }
  if (result.programFull) {
    return {
      submissionStatus: "program_full",
      // Keep existing Topkapı/SIT behaviour unchanged. Altınbaş has a proven
      // application pipeline target named `quota_full`.
      stageKey: meta?.["adapterKey"] === "altinbas" ? "quota_full" : null,
    };
  }
  if (
    result.programMissing &&
    result.resolution === "not_in_dropdown" &&
    (result.availablePrograms?.length ?? 0) > 0
  ) {
    return { submissionStatus: "program_missing", stageKey: null };
  }
  if (meta?.["dryRun"]) {
    return { submissionStatus: "dry_run", stageKey: null };
  }
  if (result.submitted) {
    return { submissionStatus: "submitted", stageKey: "awaiting_offer" };
  }
  if (result.programMissing) {
    return {
      submissionStatus: "program_missing",
      stageKey: "documents_collected",
    };
  }
  if (result.alreadyExists) {
    return { submissionStatus: "already_exists", stageKey: "all_registered" };
  }
  return { submissionStatus: "failed", stageKey: null };
}

/** Preserve the adapter's concrete portal failure when the run completed but
 * returned submitted=false. A thrown worker error still takes precedence. */
export function resolveWritebackError(
  result: SubmitResult | null,
  submissionStatus: SubmissionStatus,
  errorMessage?: string,
): string | null {
  if (result?.skippedNotMember) {
    return (
      result.detail ??
      "SIT üyesi değil — doğrudan üniversite panelinden başvurulmalı"
    );
  }
  if (submissionStatus === "exclusive_region") {
    return result?.exclusiveAgency
      ? `Exclusive bölge — ${result.exclusiveAgency} üzerinden başvurulmalı`
      : "Exclusive bölge — acenta üzerinden başvurulmalı";
  }
  if (submissionStatus === "failed") {
    return errorMessage ?? result?.detail ?? "submission failed";
  }
  return null;
}
