/**
 * Safely reconcile explicitly supplied application IDs against passport data.
 *
 * This script never queues or submits a portal application. It only runs the
 * normal preflight enrichment and parks an Inquiry application in Missing
 * Documents when passport proof remains absent, invalid, conflicting or
 * unreadable. Output contains IDs and field names only (no PII).
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx \
 *     scripts/reconcile-portal-passport-identities.ts 2866 2869 2879
 */
import { prepareApplicationPortalPreflight } from "../src/lib/portalApplicationPreflight.js";
import { parkApplicationInMissingDocsStage } from "../src/lib/mandatoryDocs.js";

const applicationIds = process.argv.slice(2).map(Number);
if (
  applicationIds.length === 0 ||
  applicationIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
) {
  throw new Error("Provide one or more explicit positive application IDs");
}

for (const applicationId of applicationIds) {
  try {
    const result = await prepareApplicationPortalPreflight({
      applicationId,
      adapterKey: "sit",
      actorUserId: null,
      ip: "passport-identity-reconciliation",
      autoEnrich: true,
    });
    const parked = result.ready
      ? false
      : await parkApplicationInMissingDocsStage(applicationId);
    console.log(JSON.stringify({
      applicationId,
      status: result.ready ? "ready" : "missing_documents",
      parked,
      autoFilledFields: result.autoFilledFields,
      missingFields: result.missingFields,
      incompatibleFields: result.incompatibleFields.map((issue) => issue.field),
      warnings: result.enrichmentWarnings,
    }));
  } catch (error) {
    console.log(JSON.stringify({
      applicationId,
      status: "error",
      message: error instanceof Error ? error.message : "unknown_error",
    }));
  }
}
