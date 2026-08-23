import {
  agentsTable,
  applicationsTable,
  commissionsTable,
  db,
  pipelineStagesTable,
  serviceFeesTable,
  studentsTable,
  universitiesTable,
} from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";

export type ApplicationFinanceStatus = "potential" | "confirmed" | "excluded";

export interface ApplicationFinanceSyncResult {
  applicationId: number;
  commissionStatus: ApplicationFinanceStatus;
  serviceFeeStatus: ApplicationFinanceStatus;
  commissionCreated: boolean;
  commissionUpdated: boolean;
  serviceFeeCreated: boolean;
  serviceFeeUpdated: boolean;
}

function statusFromStage(
  explicitStatus: string | null | undefined,
  variant: string | null | undefined,
): ApplicationFinanceStatus {
  if (explicitStatus === "potential" || explicitStatus === "confirmed" || explicitStatus === "excluded") {
    return explicitStatus;
  }
  if (variant === "won") return "confirmed";
  if (variant === "lost" || variant === "none_finance") return "excluded";
  return "potential";
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Canonical, idempotent finance reconciliation for one application.
 *
 * Every application creation/stage-write path must call this function after
 * the application row is committed. It serializes per application, creates
 * missing finance rows, and reconciles stage-driven statuses without ever
 * downgrading collected/settled money.
 */
export async function syncApplicationFinance(applicationId: number): Promise<ApplicationFinanceSyncResult | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(74021, ${applicationId})`);

    const [app] = await tx
      .select()
      .from(applicationsTable)
      .where(and(eq(applicationsTable.id, applicationId), isNull(applicationsTable.deletedAt)))
      .limit(1);
    if (!app) return null;

    const [[stage], [student], [university]] = await Promise.all([
      tx.select({
        variant: pipelineStagesTable.variant,
        commissionFinanceStatus: pipelineStagesTable.commissionFinanceStatus,
        serviceFeeFinanceStatus: pipelineStagesTable.serviceFeeFinanceStatus,
      }).from(pipelineStagesTable).where(and(
        eq(pipelineStagesTable.entityType, "application"),
        eq(pipelineStagesTable.key, app.stage),
      )).limit(1),
      tx.select({ firstName: studentsTable.firstName, lastName: studentsTable.lastName })
        .from(studentsTable).where(eq(studentsTable.id, app.studentId)).limit(1),
      app.universityId
        ? tx.select({ universityType: universitiesTable.universityType }).from(universitiesTable)
            .where(eq(universitiesTable.id, app.universityId)).limit(1)
        : Promise.resolve([]),
    ]);

    const commissionStatus = statusFromStage(stage?.commissionFinanceStatus, stage?.variant);
    const serviceFeeStatus = statusFromStage(stage?.serviceFeeFinanceStatus, stage?.variant);
    const studentName = student
      ? `${student.firstName || ""} ${student.lastName || ""}`.trim() || null
      : null;

    const result: ApplicationFinanceSyncResult = {
      applicationId,
      commissionStatus,
      serviceFeeStatus,
      commissionCreated: false,
      commissionUpdated: false,
      serviceFeeCreated: false,
      serviceFeeUpdated: false,
    };

    const existingCommissions = await tx.select().from(commissionsTable)
      .where(eq(commissionsTable.applicationId, applicationId));
    if (existingCommissions.length === 0 && commissionStatus !== "excluded") {
      const baseFee = app.discountedFee != null && Number.isFinite(app.discountedFee)
        ? finiteNumber(app.discountedFee)
        : finiteNumber(app.tuitionFee);
      const universityCommissionAmount = baseFee * finiteNumber(app.commissionRate) / 100;

      let resolvedAgentId = app.agentId ?? null;
      let agentCommissionRate: string | null = null;
      let agentCommissionAmount: string | null = null;
      let subAgentId: number | null = null;
      let subAgentCommissionRate: string | null = null;
      let subAgentCommissionAmount: string | null = null;

      if (app.agentId && universityCommissionAmount > 0) {
        const [agent] = await tx.select().from(agentsTable).where(eq(agentsTable.id, app.agentId)).limit(1);
        let parent: typeof agent | null = null;
        if (agent?.parentAgentId && agent.parentAgentId !== agent.id) {
          [parent] = await tx.select().from(agentsTable).where(eq(agentsTable.id, agent.parentAgentId)).limit(1);
        }
        if (agent && parent) {
          const parentRate = finiteNumber(parent.commissionRate);
          const parentAmount = universityCommissionAmount * parentRate / 100;
          const childRate = finiteNumber(agent.commissionRate);
          const childAmount = parentAmount * childRate / 100;
          resolvedAgentId = parent.id;
          agentCommissionRate = parentRate > 0 ? String(parentRate) : null;
          agentCommissionAmount = parentAmount > 0 ? String(Math.round(parentAmount * 100) / 100) : null;
          subAgentId = agent.id;
          subAgentCommissionRate = childRate > 0 ? String(childRate) : null;
          subAgentCommissionAmount = childAmount > 0 ? String(Math.round(childAmount * 100) / 100) : null;
        } else if (agent) {
          const rate = finiteNumber(agent.commissionRate);
          const amount = universityCommissionAmount * rate / 100;
          agentCommissionRate = rate > 0 ? String(rate) : null;
          agentCommissionAmount = amount > 0 ? String(Math.round(amount * 100) / 100) : null;
        }
      }

      await tx.insert(commissionsTable).values({
        applicationId,
        studentId: app.studentId,
        agentId: resolvedAgentId,
        studentName,
        universityName: app.universityName || null,
        programName: app.programName || null,
        isStateUniversity: ["public", "state"].includes(university?.universityType?.toLowerCase() ?? ""),
        season: app.season,
        currency: app.currency || "USD",
        status: commissionStatus,
        programFee: baseFee > 0 ? String(baseFee) : null,
        universityCommissionRate: finiteNumber(app.commissionRate) > 0 ? String(app.commissionRate) : null,
        universityCommissionAmount: universityCommissionAmount > 0
          ? String(Math.round(universityCommissionAmount * 100) / 100)
          : null,
        agentCommissionRate,
        agentCommissionAmount,
        subAgentId,
        subAgentCommissionRate,
        subAgentCommissionAmount,
        ...(commissionStatus === "confirmed" ? { confirmedAt: new Date() } : {}),
      });
      result.commissionCreated = true;
    } else {
      for (const commission of existingCommissions) {
        const protectedStatus = ["collected_partial", "collected_full", "settled"].includes(commission.status);
        if (protectedStatus) continue;
        let nextStatus: ApplicationFinanceStatus | null = null;
        let confirmedAt: Date | null | undefined;
        if (commissionStatus === "excluded" && commission.status !== "excluded") {
          nextStatus = "excluded";
          confirmedAt = null;
        } else if (commissionStatus === "confirmed" && ["potential", "excluded"].includes(commission.status)) {
          nextStatus = "confirmed";
          confirmedAt = new Date();
        } else if (commissionStatus === "potential") {
          if (commission.status === "excluded") nextStatus = "potential";
          if (commission.status === "confirmed" && finiteNumber(commission.universityCollected) <= 0) {
            nextStatus = "potential";
            confirmedAt = null;
          }
        }
        if (nextStatus) {
          await tx.update(commissionsTable)
            .set({ status: nextStatus, ...(confirmedAt !== undefined ? { confirmedAt } : {}) })
            .where(eq(commissionsTable.id, commission.id));
          result.commissionUpdated = true;
        }
      }
    }

    const existingServiceFees = await tx.select().from(serviceFeesTable)
      .where(eq(serviceFeesTable.applicationId, applicationId));
    if (existingServiceFees.length === 0 && serviceFeeStatus !== "excluded") {
      const total = finiteNumber(app.serviceFeeAmount);
      await tx.insert(serviceFeesTable).values({
        applicationId,
        studentId: app.studentId,
        agentId: app.agentId,
        studentName,
        universityName: app.universityName || null,
        isStateUniversity: ["public", "state"].includes(university?.universityType?.toLowerCase() ?? ""),
        season: app.season,
        currency: app.currency || "USD",
        totalAmount: String(total),
        firstInstallmentAmount: total > 0 ? String(total / 2) : null,
        secondInstallmentAmount: total > 0 ? String(total / 2) : null,
        financeStatus: serviceFeeStatus,
        status: "pending",
      });
      result.serviceFeeCreated = true;
    } else {
      for (const serviceFee of existingServiceFees) {
        const hasPaid = Boolean(serviceFee.firstInstallmentPaidAt || serviceFee.secondInstallmentPaidAt);
        let nextStatus: ApplicationFinanceStatus | null = null;
        if (serviceFeeStatus === "excluded" && !hasPaid && serviceFee.financeStatus !== "excluded") {
          nextStatus = "excluded";
        } else if (serviceFeeStatus === "confirmed" && serviceFee.financeStatus !== "confirmed") {
          nextStatus = "confirmed";
        } else if (
          serviceFeeStatus === "potential" && !hasPaid &&
          ["excluded", "confirmed"].includes(serviceFee.financeStatus)
        ) {
          nextStatus = "potential";
        }
        if (nextStatus) {
          await tx.update(serviceFeesTable).set({ financeStatus: nextStatus })
            .where(eq(serviceFeesTable.id, serviceFee.id));
          result.serviceFeeUpdated = true;
        }
      }
    }

    return result;
  });
}
