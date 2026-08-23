import { db, pipelineStagesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

type FinanceStatus = "potential" | "confirmed" | "excluded";

interface StageFlags {
  variant: string | null;
  commissionFinanceStatus: string | null;
  serviceFeeFinanceStatus: string | null;
  autoCancelSiblingsOnWon: boolean;
}

let stageCache: Map<string, StageFlags> = new Map();
let cacheTimestamp = 0;
const CACHE_TTL = 60_000;

async function loadStages(): Promise<Map<string, StageFlags>> {
  const now = Date.now();
  if (now - cacheTimestamp < CACHE_TTL && stageCache.size > 0) {
    return stageCache;
  }

  try {
    const stages = await db
      .select({
        key: pipelineStagesTable.key,
        variant: pipelineStagesTable.variant,
        commissionFinanceStatus: pipelineStagesTable.commissionFinanceStatus,
        serviceFeeFinanceStatus: pipelineStagesTable.serviceFeeFinanceStatus,
        autoCancelSiblingsOnWon: pipelineStagesTable.autoCancelSiblingsOnWon,
      })
      .from(pipelineStagesTable)
      .where(eq(pipelineStagesTable.entityType, "application"));

    const map = new Map<string, StageFlags>();
    for (const s of stages) {
      map.set(s.key, {
        variant: s.variant,
        commissionFinanceStatus: s.commissionFinanceStatus,
        serviceFeeFinanceStatus: s.serviceFeeFinanceStatus,
        autoCancelSiblingsOnWon: !!s.autoCancelSiblingsOnWon,
      });
    }

    if (map.size > 0) {
      stageCache = map;
      cacheTimestamp = now;
    }
    return map;
  } catch {
    return stageCache;
  }
}

export function clearStageFinanceCache() {
  cacheTimestamp = 0;
  stageCache.clear();
}

function resolveFromVariant(variant: string | null | undefined): FinanceStatus | null {
  if (variant === "won") return "confirmed";
  if (variant === "partial_won") return "potential";
  if (variant === "lost") return "excluded";
  if (variant === "none_finance") return "excluded";
  return null;
}

function isValidStatus(v: any): v is FinanceStatus {
  return v === "potential" || v === "confirmed" || v === "excluded";
}

export async function getCommissionFinanceStatus(stage: string): Promise<FinanceStatus> {
  const stages = await loadStages();
  const flags = stages.get(stage);
  if (flags) {
    if (isValidStatus(flags.commissionFinanceStatus)) return flags.commissionFinanceStatus;
    const variantResult = resolveFromVariant(flags.variant);
    if (variantResult !== null) return variantResult;
    return "potential";
  }
  // Unknown stage (not yet seeded): treat as potential.
  return "potential";
}

export async function getServiceFeeFinanceStatus(stage: string): Promise<FinanceStatus> {
  const stages = await loadStages();
  const flags = stages.get(stage);
  if (flags) {
    if (isValidStatus(flags.serviceFeeFinanceStatus)) return flags.serviceFeeFinanceStatus;
    const variantResult = resolveFromVariant(flags.variant);
    if (variantResult !== null) return variantResult;
    return "potential";
  }
  return "potential";
}

/**
 * Whether transitioning into this stage should auto-cancel sibling
 * applications for the same student. Driven entirely by the
 * `auto_cancel_siblings_on_won` flag on the pipeline stage.
 */
export async function shouldAutoCancelSiblings(stage: string): Promise<boolean> {
  const stages = await loadStages();
  return !!stages.get(stage)?.autoCancelSiblingsOnWon;
}

export async function getCancelledStageKey(): Promise<string> {
  const stages = await loadStages();
  if (stages.has("cancelled")) return "cancelled";
  return "cancelled";
}

export async function shouldHaveCommission(stage: string): Promise<boolean> {
  const status = await getCommissionFinanceStatus(stage);
  return status !== "excluded";
}

export async function shouldHaveServiceFee(stage: string): Promise<boolean> {
  const status = await getServiceFeeFinanceStatus(stage);
  return status !== "excluded";
}
