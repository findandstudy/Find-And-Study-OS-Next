import type { GuardianStagingReport } from "./portalAiGuardianStaging";
import type { PortalDiagnosis } from "./portalAiGuardianContract";

export function buildPortalDeployProposalPayload(input: {
  sourceActionId: number;
  submissionId: number;
  universityKey: string | null;
  adapterKey: string | null;
  fingerprint: string;
  baseSpecId: number;
  baseSpecVersion: number;
  draftSpecId: number;
  draftSpecVersion: number;
  diagnosis: PortalDiagnosis;
  staging: GuardianStagingReport;
}) {
  return {
    context: {
      sourceActionId: input.sourceActionId,
      submissionId: input.submissionId,
      universityKey: input.universityKey,
      adapterKey: input.adapterKey,
      fingerprint: input.fingerprint,
      baseSpecId: input.baseSpecId,
      baseSpecVersion: input.baseSpecVersion,
      draftSpecId: input.draftSpecId,
      draftSpecVersion: input.draftSpecVersion,
    },
    diagnosis: input.diagnosis,
    staging: input.staging,
    deployment: {
      status: "proposed",
      automaticExecution: false,
      productionChanged: false,
      requiresManualDeployment: true,
      requiresFreshReadOnlyProbe: true,
      requiresAuthorizedCanary: true,
      checklist: [
        "Confirm the active base spec still matches the staged base hash.",
        "Run a fresh PII-free read-only DOM probe against the target portal.",
        "Run adapter regression and dry-run mutation-boundary tests.",
        "Obtain explicit authorization before any state-changing canary.",
        "Prepare rollback to the currently active spec version.",
        "Deploy manually, then verify process PID, cwd, adapter hash and health.",
      ],
      rollback: {
        specId: input.baseSpecId,
        specVersion: input.baseSpecVersion,
      },
    },
  };
}
