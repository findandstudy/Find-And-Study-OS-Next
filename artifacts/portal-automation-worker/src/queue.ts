/**
 * Compatibility entrypoint for the worker package.
 *
 * Queue mechanics live in @workspace/portal-runner. Keeping a second SQL
 * implementation here caused the worker tests and production behaviour to
 * drift (filtering, manual retries and stale-run recovery all differed).
 */
export { claimNext, claimNextWithLaneLease, claimById, cancelStaleIneligibleQueued, releaseStale, heartbeat, requeueStuck } from "@workspace/portal-runner";

export type { ClaimedSubmission, ClaimedSubmissionLease, PortalLaneClaimOptions } from "@workspace/portal-runner";
