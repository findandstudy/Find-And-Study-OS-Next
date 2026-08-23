/**
 * Adapter auto-graduation — api-server convenience wrappers.
 *
 * The single counting implementation lives in
 * lib/portal-runner/src/graduation.ts (shared with the worker and the
 * drain-once cron script). See that module for the graduation rule:
 *
 *   experimental(key) = staticExperimentalFamily(key)
 *                       && successCount(key) < GRADUATION_THRESHOLD
 *
 * Manual single-submission of experimental adapters is ALWAYS allowed — only
 * automatic processing / auto-process toggles consult these helpers.
 */
import {
  getAdapterSuccessCounts,
  getNonGraduatedExperimentalAdapterKeys,
  GRADUATION_THRESHOLD,
} from "@workspace/portal-runner";
import { isExperimentalAdapterKey } from "@workspace/portal-adapters";

export { GRADUATION_THRESHOLD };

/** Batched live verified-success counts per adapter key (one GROUP BY query). */
export async function getSuccessCounts(
  adapterKeys: string[],
): Promise<Map<string, number>> {
  return getAdapterSuccessCounts(adapterKeys);
}

/** Dynamic experimental: family is experimental AND not yet graduated. */
export async function isExperimentalDynamic(adapterKey: string): Promise<boolean> {
  if (!isExperimentalAdapterKey(adapterKey)) return false;
  const nonGraduated = await getNonGraduatedExperimentalAdapterKeys([adapterKey]);
  return nonGraduated.has(adapterKey);
}

/**
 * All still-experimental (non-graduated) adapter keys among the given keys —
 * used by the bulk auto-process toggle to skip ineligible universities.
 */
export async function getNonGraduatedExperimentalKeys(
  adapterKeys: string[],
): Promise<string[]> {
  const set = await getNonGraduatedExperimentalAdapterKeys(adapterKeys);
  return [...set];
}
