export type QueueReconcileStatement = {
  text: string;
  values: [string[], string[], number];
};

const DEFAULT_STALE_AGE_MS = 86_400_000;
const MIN_STALE_AGE_MS = 60_000;

/**
 * Builds the stale automatic-queue reconciliation statement without touching
 * the database so its safety boundaries can be regression-tested.
 */
export function buildStaleIneligibleQueueStatement(
  universityKeys: string[],
  triggerStages: string[],
  thresholdMs: number,
): QueueReconcileStatement | null {
  const keys = [...new Set(universityKeys.map((key) => key.trim()).filter(Boolean))];
  if (keys.length === 0) return null;

  const safeThresholdMs = Number.isFinite(thresholdMs)
    ? Math.max(MIN_STALE_AGE_MS, Math.trunc(thresholdMs))
    : DEFAULT_STALE_AGE_MS;

  return {
    text: `UPDATE portal_submissions ps
        SET status     = 'canceled',
            locked_at  = NULL,
            locked_by  = NULL,
            error      = 'STALE_AUTO_QUEUE_STAGE_CHANGED: application left the configured portal trigger stages',
            meta       = COALESCE(ps.meta, '{}'::jsonb) || jsonb_build_object(
                           'queueReconcileReason', 'stage_changed',
                           'queueReconciledAt', NOW(),
                           'applicationStage', a.stage,
                           'configuredTriggerStages', to_jsonb($2::text[])
                         ),
            updated_at = NOW()
       FROM applications a
      WHERE ps.application_id = a.id
        AND ps.status = 'queued'
        AND ps.deleted_at IS NULL
        AND ps.university_key = ANY($1::text[])
        AND ps.created_at < NOW() - ($3::bigint * INTERVAL '1 millisecond')
        AND COALESCE(ps.meta->>'manual', 'false') <> 'true'
        AND (
          a.deleted_at IS NOT NULL
          OR a.stage IS NULL
          OR NOT (a.stage = ANY($2::text[]))
        )
     RETURNING ps.id`,
    values: [keys, [...triggerStages], safeThresholdMs],
  };
}
