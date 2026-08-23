export type PortalLifecycleSignal =
  | "submitted"
  | "offer_received"
  | "deposit_paid"
  | "acceptance_letter"
  | "final_acceptance"
  | "student_card"
  | "already_registered"
  | "quota_full"
  | "rejected"
  | "unknown";

export type PortalLifecycleArtifact =
  | "offer_letter"
  | "deposit_receipt"
  | "acceptance_letter"
  | "final_acceptance"
  | "student_card";

export type PortalLifecycleAction =
  | "none"
  | "review_stage_transition"
  | "collect_portal_artifact"
  | "review_payment_forward"
  | "manual_review";

export type PortalLifecycleDecision = {
  signal: PortalLifecycleSignal;
  targetStage: string | null;
  action: PortalLifecycleAction;
  requiredArtifact: PortalLifecycleArtifact | null;
  artifactVerified: boolean;
  proposeStudentNotification: boolean;
  proposeUniversityForward: boolean;
  humanApprovalRequired: boolean;
  allowPortalMutation: false;
  reason: string;
};

const compact = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Converts a portal's free-form status into a small, auditable lifecycle
 * vocabulary. Ordering matters: "final acceptance" must be evaluated before
 * the broader "accept" branch.
 */
export function normalizePortalLifecycleSignal(
  rawStatus: string,
): PortalLifecycleSignal {
  const status = compact(rawStatus);
  if (!status) return "unknown";
  if (/\bstudent card\b|\bstudent id card\b/.test(status)) {
    return "student_card";
  }
  if (
    /\bfinal acceptance\b|\bfinal admission\b|\bfinal letter\b/.test(status)
  ) {
    return "final_acceptance";
  }
  if (/\bacceptance letter\b|\badmission letter\b/.test(status)) {
    return "acceptance_letter";
  }
  if (
    /\bdeposit paid\b|\bpayment received\b|\bdeposit received\b/.test(status)
  ) {
    return "deposit_paid";
  }
  if (
    /\boffer\b|\bconditional accept(?:ance|ed)?\b|\bprovisional accept(?:ance|ed)?\b/.test(
      status,
    )
  ) {
    return "offer_received";
  }
  if (
    /\balready registered\b|\balready enrolled\b|\balready exists\b|\bregistered by another\b/.test(
      status,
    )
  ) {
    return "already_registered";
  }
  if (
    /\bquota full\b|\bfull quota\b|\bprogram(?:me)? full\b|\bno seats?\b/.test(
      status,
    )
  ) {
    return "quota_full";
  }
  if (/\breject(?:ed|ion)?\b|\bdeclin(?:ed|e)\b|\bunsuccessful\b/.test(status)) {
    return "rejected";
  }
  if (
    /\bsubmitted\b|\bwaiting approval\b|\bpending review\b|\bunder review\b|\bin evaluation\b/.test(
      status,
    )
  ) {
    return "submitted";
  }
  return "unknown";
}

const artifactForSignal: Partial<
  Record<PortalLifecycleSignal, PortalLifecycleArtifact>
> = {
  offer_received: "offer_letter",
  deposit_paid: "deposit_receipt",
  acceptance_letter: "acceptance_letter",
  final_acceptance: "final_acceptance",
  student_card: "student_card",
};

const targetStageForSignal: Partial<Record<PortalLifecycleSignal, string>> = {
  submitted: "submitted",
  offer_received: "offer_received",
  // Production stores the verified deposit receipt under "Upload Payment".
  deposit_paid: "upload_payment",
  acceptance_letter: "acceptance_letter",
  final_acceptance: "final_acceptance",
  student_card: "student_card",
  already_registered: "all_registered",
  quota_full: "quota_full",
  rejected: "rejected",
};

/**
 * Produces a fail-closed lifecycle plan. This function never authorizes a
 * portal mutation. It also refuses to move document-bearing stages until the
 * corresponding file has been persisted in Find & Study OS.
 */
export function planPortalLifecycle(input: {
  rawStatus: string;
  currentStage: string;
  artifacts?: Iterable<PortalLifecycleArtifact>;
}): PortalLifecycleDecision {
  const signal = normalizePortalLifecycleSignal(input.rawStatus);
  const artifacts = new Set(input.artifacts ?? []);
  const requiredArtifact = artifactForSignal[signal] ?? null;
  const artifactVerified =
    requiredArtifact === null || artifacts.has(requiredArtifact);
  const targetStage = targetStageForSignal[signal] ?? null;

  if (signal === "unknown") {
    return {
      signal,
      targetStage: null,
      action: "manual_review",
      requiredArtifact: null,
      artifactVerified: false,
      proposeStudentNotification: false,
      proposeUniversityForward: false,
      humanApprovalRequired: true,
      allowPortalMutation: false,
      reason:
        "Portal status is not in the deterministic lifecycle vocabulary.",
    };
  }

  if (requiredArtifact && !artifactVerified) {
    return {
      signal,
      targetStage,
      action: "collect_portal_artifact",
      requiredArtifact,
      artifactVerified: false,
      proposeStudentNotification: false,
      proposeUniversityForward: false,
      humanApprovalRequired: true,
      allowPortalMutation: false,
      reason: `The ${requiredArtifact} file must be stored and verified before the application stage can advance.`,
    };
  }

  if (targetStage === input.currentStage) {
    return {
      signal,
      targetStage,
      action: "none",
      requiredArtifact,
      artifactVerified,
      proposeStudentNotification: false,
      proposeUniversityForward: false,
      humanApprovalRequired: false,
      allowPortalMutation: false,
      reason: "The application is already at the verified target stage.",
    };
  }

  return {
    signal,
    targetStage,
    action:
      signal === "deposit_paid"
        ? "review_payment_forward"
        : "review_stage_transition",
    requiredArtifact,
    artifactVerified,
    proposeStudentNotification: [
      "offer_received",
      "acceptance_letter",
      "final_acceptance",
      "student_card",
      "rejected",
    ].includes(signal),
    proposeUniversityForward: signal === "deposit_paid",
    humanApprovalRequired: true,
    allowPortalMutation: false,
    reason:
      signal === "deposit_paid"
        ? "A verified receipt exists; forwarding payment evidence to the university still requires approval."
        : "The portal signal is deterministic; the CRM transition and outbound message remain reviewable actions.",
  };
}
