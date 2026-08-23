import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePortalLifecycleSignal,
  planPortalLifecycle,
} from "../src/lib/portalLifecycleContract";

test("normalizes the supported portal lifecycle vocabulary", () => {
  assert.equal(normalizePortalLifecycleSignal("Waiting Approval"), "submitted");
  assert.equal(
    normalizePortalLifecycleSignal("Conditional Acceptance"),
    "offer_received",
  );
  assert.equal(
    normalizePortalLifecycleSignal("Final Acceptance Letter Ready"),
    "final_acceptance",
  );
  assert.equal(
    normalizePortalLifecycleSignal("Registered by another agency"),
    "already_registered",
  );
  assert.equal(normalizePortalLifecycleSignal("No Seats Available"), "quota_full");
  assert.equal(normalizePortalLifecycleSignal("Some new status"), "unknown");
});

test("offer never advances without a stored offer letter", () => {
  const blocked = planPortalLifecycle({
    rawStatus: "Offer Ready",
    currentStage: "submitted",
  });
  assert.equal(blocked.action, "collect_portal_artifact");
  assert.equal(blocked.requiredArtifact, "offer_letter");
  assert.equal(blocked.artifactVerified, false);
  assert.equal(blocked.proposeStudentNotification, false);
  assert.equal(blocked.allowPortalMutation, false);

  const proved = planPortalLifecycle({
    rawStatus: "Offer Ready",
    currentStage: "submitted",
    artifacts: ["offer_letter"],
  });
  assert.equal(proved.action, "review_stage_transition");
  assert.equal(proved.targetStage, "offer_received");
  assert.equal(proved.proposeStudentNotification, true);
  assert.equal(proved.humanApprovalRequired, true);
});

test("payment text alone never authorizes forwarding or a stage move", () => {
  const blocked = planPortalLifecycle({
    rawStatus: "Deposit Paid",
    currentStage: "offer_received",
  });
  assert.equal(blocked.action, "collect_portal_artifact");
  assert.equal(blocked.requiredArtifact, "deposit_receipt");
  assert.equal(blocked.proposeUniversityForward, false);

  const proved = planPortalLifecycle({
    rawStatus: "Payment Received",
    currentStage: "offer_received",
    artifacts: ["deposit_receipt"],
  });
  assert.equal(proved.action, "review_payment_forward");
  assert.equal(proved.targetStage, "upload_payment");
  assert.equal(proved.proposeUniversityForward, true);
  assert.equal(proved.allowPortalMutation, false);
});

test("final and student-card stages require their exact artifact", () => {
  const final = planPortalLifecycle({
    rawStatus: "Final Admission",
    currentStage: "acceptance_letter",
    artifacts: ["acceptance_letter"],
  });
  assert.equal(final.action, "collect_portal_artifact");
  assert.equal(final.requiredArtifact, "final_acceptance");

  const card = planPortalLifecycle({
    rawStatus: "Student ID Card",
    currentStage: "final_acceptance",
    artifacts: ["student_card"],
  });
  assert.equal(card.targetStage, "student_card");
  assert.equal(card.action, "review_stage_transition");
});

test("unknown fails closed; quota-full proposes the configured review stage", () => {
  const unknown = planPortalLifecycle({
    rawStatus: "Portal says xyz",
    currentStage: "submitted",
  });
  assert.equal(unknown.action, "manual_review");
  assert.equal(unknown.targetStage, null);
  assert.equal(unknown.humanApprovalRequired, true);
  assert.equal(unknown.allowPortalMutation, false);

  const quota = planPortalLifecycle({
    rawStatus: "Quota Full",
    currentStage: "submitted",
  });
  assert.equal(quota.action, "review_stage_transition");
  assert.equal(quota.targetStage, "quota_full");
  assert.equal(quota.humanApprovalRequired, true);
  assert.equal(quota.allowPortalMutation, false);
});

test("an already-applied target stage is idempotent", () => {
  const decision = planPortalLifecycle({
    rawStatus: "Application Submitted",
    currentStage: "submitted",
  });
  assert.equal(decision.action, "none");
  assert.equal(decision.humanApprovalRequired, false);
});
