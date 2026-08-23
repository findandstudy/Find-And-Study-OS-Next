import { createHash } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  aiActionQueueTable,
  aiPersonasTable,
  applicationStageDocumentsTable,
  applicationsTable,
  db,
} from "@workspace/db";
import {
  planPortalLifecycle,
  type PortalLifecycleArtifact,
  type PortalLifecycleDecision,
} from "./portalLifecycleContract";
import { PORTAL_GUARDIAN_SLUG } from "./portalAiGuardian";

export const PORTAL_LIFECYCLE_ACTION = "portal_lifecycle_proposal";

const documentStageToArtifact: Record<string, PortalLifecycleArtifact> = {
  offer_received: "offer_letter",
  upload_payment: "deposit_receipt",
  acceptance_letter: "acceptance_letter",
  final_acceptance: "final_acceptance",
  student_card: "student_card",
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function proposalFingerprint(input: {
  submissionId: number;
  applicationId: number;
  rawStatus: string;
  currentStage: string;
  artifacts: PortalLifecycleArtifact[];
  decision: PortalLifecycleDecision;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        submissionId: input.submissionId,
        applicationId: input.applicationId,
        rawStatus: input.rawStatus.trim().toLowerCase(),
        currentStage: input.currentStage,
        artifacts: [...input.artifacts].sort(),
        signal: input.decision.signal,
        action: input.decision.action,
        targetStage: input.decision.targetStage,
      }),
    )
    .digest("hex");
}

/**
 * Creates one idempotent Approval Queue item from a portal status change.
 * This path is intentionally deterministic and does not invoke an LLM. It
 * never changes a CRM stage, sends a message, forwards a payment, or mutates a
 * university portal.
 */
export async function queuePortalLifecycleReview(input: {
  submissionId: number;
  applicationId: number;
  rawStatus: string;
}): Promise<{
  queued: boolean;
  actionId?: number;
  reason?: string;
  decision?: PortalLifecycleDecision;
}> {
  const [persona] = await db
    .select({ id: aiPersonasTable.id })
    .from(aiPersonasTable)
    .where(
      and(
        eq(aiPersonasTable.slug, PORTAL_GUARDIAN_SLUG),
        eq(aiPersonasTable.isActive, true),
      ),
    )
    .limit(1);
  if (!persona) return { queued: false, reason: "GUARDIAN_INACTIVE" };

  const [application] = await db
    .select({ stage: applicationsTable.stage })
    .from(applicationsTable)
    .where(
      and(
        eq(applicationsTable.id, input.applicationId),
        isNull(applicationsTable.deletedAt),
      ),
    )
    .limit(1);
  if (!application) {
    return { queued: false, reason: "APPLICATION_NOT_FOUND" };
  }

  const docs = await db
    .select({
      stage: applicationStageDocumentsTable.stage,
      fileData: applicationStageDocumentsTable.fileData,
      fileUrl: applicationStageDocumentsTable.fileUrl,
      isMissingDocNote: applicationStageDocumentsTable.isMissingDocNote,
    })
    .from(applicationStageDocumentsTable)
    .where(eq(applicationStageDocumentsTable.applicationId, input.applicationId));
  const artifacts = [
    ...new Set(
      docs
        .filter(
          (doc) =>
            !doc.isMissingDocNote &&
            Boolean(doc.fileData || doc.fileUrl) &&
            documentStageToArtifact[doc.stage],
        )
        .map((doc) => documentStageToArtifact[doc.stage]),
    ),
  ];
  const decision = planPortalLifecycle({
    rawStatus: input.rawStatus,
    currentStage: application.stage,
    artifacts,
  });
  if (decision.action === "none") {
    return { queued: false, reason: "NO_ACTION", decision };
  }

  const fingerprint = proposalFingerprint({
    ...input,
    currentStage: application.stage,
    artifacts,
    decision,
  });
  const pending = await db
    .select({ id: aiActionQueueTable.id, payload: aiActionQueueTable.payload })
    .from(aiActionQueueTable)
    .where(
      and(
        eq(aiActionQueueTable.personaId, persona.id),
        eq(aiActionQueueTable.actionType, PORTAL_LIFECYCLE_ACTION),
        eq(aiActionQueueTable.status, "pending_approval"),
      ),
    )
    .orderBy(desc(aiActionQueueTable.createdAt))
    .limit(100);
  const duplicate = pending.find((item) => {
    const context = asRecord(asRecord(item.payload).context);
    return context.fingerprint === fingerprint;
  });
  if (duplicate) {
    return {
      queued: false,
      actionId: duplicate.id,
      reason: "ALREADY_QUEUED",
      decision,
    };
  }

  const [action] = await db
    .insert(aiActionQueueTable)
    .values({
      personaId: persona.id,
      actionType: PORTAL_LIFECYCLE_ACTION,
      payload: {
        context: {
          submissionId: input.submissionId,
          applicationId: input.applicationId,
          fingerprint,
          reviewOnly: true,
        },
        portalStatus: input.rawStatus.slice(0, 250),
        currentStage: application.stage,
        artifacts,
        decision,
      },
      preview: decision.reason.slice(0, 400),
      status: "pending_approval",
    })
    .returning({ id: aiActionQueueTable.id });
  return { queued: true, actionId: action?.id, decision };
}
