import { db, applicationStageDocumentsTable, applicationsTable, studentsTable, usersTable, agentsTable, settingsTable, pipelineStagesTable } from "@workspace/db";
import { and, eq, isNotNull, isNull, inArray, sql } from "drizzle-orm";
import { dispatchNotification } from "./notificationDispatcher";
import { formatDate } from "@workspace/i18n";

const CHECK_INTERVAL = 60 * 60 * 1000;

function parseThresholds(csv: string | null | undefined): number[] {
  const raw = (csv || "30,14,7,1").split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0);
  return Array.from(new Set(raw)).sort((a, b) => b - a);
}

function daysBetween(future: Date, now: Date): number {
  return Math.ceil((future.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

export async function checkOfferLetterExpiries(): Promise<void> {
  try {
    const [settings] = await db.select({ offerExpiryWarningDays: settingsTable.offerExpiryWarningDays, defaultLanguage: settingsTable.defaultLanguage }).from(settingsTable);
    const thresholds = parseThresholds(settings?.offerExpiryWarningDays);
    const lang = settings?.defaultLanguage || "tr";
    if (thresholds.length === 0) return;

    const expiryStages = await db.select({
      key: pipelineStagesTable.key,
      label: pipelineStagesTable.label,
    }).from(pipelineStagesTable)
      .where(and(
        eq(pipelineStagesTable.entityType, "application"),
        eq(pipelineStagesTable.tracksOfferExpiry, true),
      ));
    if (expiryStages.length === 0) return;
    const stageLabels = new Map(expiryStages.map(s => [s.key, s.label]));
    const expiryStageKeys = expiryStages.map(s => s.key);

    const now = new Date();
    const docs = await db.select({
      id: applicationStageDocumentsTable.id,
      applicationId: applicationStageDocumentsTable.applicationId,
      stage: applicationStageDocumentsTable.stage,
      fileName: applicationStageDocumentsTable.fileName,
      validUntil: applicationStageDocumentsTable.validUntil,
      expiryNotifiedThresholds: applicationStageDocumentsTable.expiryNotifiedThresholds,
    })
      .from(applicationStageDocumentsTable)
      .where(and(
        isNotNull(applicationStageDocumentsTable.validUntil),
        inArray(applicationStageDocumentsTable.stage, expiryStageKeys),
      ));

    if (docs.length === 0) return;

    for (const doc of docs) {
      if (!doc.validUntil) continue;
      const validUntil = new Date(doc.validUntil);
      const daysLeft = daysBetween(validUntil, now);
      if (daysLeft <= 0) continue;

      // Pick the smallest threshold >= daysLeft (e.g. daysLeft=6 with [30,14,7,1] → 7).
      // This way each threshold fires exactly once as the deadline approaches.
      const ascending = [...thresholds].sort((a, b) => a - b);
      const matched = ascending.find(t => daysLeft <= t);
      if (!matched) continue;

      const alreadyNotified = (doc.expiryNotifiedThresholds || "")
        .split(",").map(s => s.trim()).filter(Boolean);
      if (alreadyNotified.includes(String(matched))) continue;

      const [app] = await db.select({
        id: applicationsTable.id,
        studentId: applicationsTable.studentId,
        agentId: applicationsTable.agentId,
        assignedToId: applicationsTable.assignedToId,
        universityName: applicationsTable.universityName,
        programName: applicationsTable.programName,
      }).from(applicationsTable).where(and(eq(applicationsTable.id, doc.applicationId), isNull(applicationsTable.deletedAt)));
      if (!app) continue;

      const [student] = await db.select({
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        userId: studentsTable.userId,
      }).from(studentsTable).where(eq(studentsTable.id, app.studentId));
      const studentName = student ? `${student.firstName || ""} ${student.lastName || ""}`.trim() : "";

      const recipientUserIds = new Set<number>();

      const adminUsers = await db.select({ id: usersTable.id })
        .from(usersTable)
        .where(and(
          inArray(usersTable.role, ["super_admin", "admin", "manager", "staff", "consultant"]),
          eq(usersTable.isActive, true),
        ));
      for (const u of adminUsers) recipientUserIds.add(u.id);

      if (app.assignedToId) recipientUserIds.add(app.assignedToId);

      if (app.agentId) {
        const [agentRec] = await db.select({ userId: agentsTable.userId, parentAgentId: agentsTable.parentAgentId })
          .from(agentsTable).where(eq(agentsTable.id, app.agentId));
        if (agentRec?.userId) recipientUserIds.add(agentRec.userId);
        if (agentRec?.parentAgentId) {
          const [parentAgent] = await db.select({ userId: agentsTable.userId })
            .from(agentsTable).where(eq(agentsTable.id, agentRec.parentAgentId));
          if (parentAgent?.userId) recipientUserIds.add(parentAgent.userId);
        }
      }

      if (student?.userId) recipientUserIds.add(student.userId);

      if (recipientUserIds.size === 0) continue;

      const stageLabel = stageLabels.get(doc.stage) || doc.stage;
      const validUntilStr = formatDate(validUntil, lang, { day: "2-digit", month: "long", year: "numeric" });
      // English is only a storage/fallback language. The browser renders this
      // event from structured data in the user's currently selected UI language.
      const title = `${stageLabel} expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
      const body = `${studentName ? studentName + " — " : ""}${app.universityName || ""}${app.programName ? " / " + app.programName : ""}: the ${stageLabel.toLowerCase()} document is valid until ${validUntilStr} (${daysLeft} day${daysLeft === 1 ? "" : "s"} left).`;

      await dispatchNotification({
        event: "application.offer_letter_expiring",
        title,
        body,
        actionUrl: `/staff/applications/${app.id}`,
        icon: "AlertTriangle",
        recipientUserIds: Array.from(recipientUserIds),
        data: {
          applicationId: app.id,
          stage: doc.stage,
          documentId: doc.id,
          validUntil: validUntil.toISOString(),
          daysLeft,
          studentName,
          universityName: app.universityName || "",
          programName: app.programName || "",
          stageLabel,
        },
        templateVars: {
          studentName,
          universityName: app.universityName || "",
          programName: app.programName || "",
          validUntil: validUntilStr,
          daysLeft: String(daysLeft),
          stageLabel,
        },
      });

      const updated = [...alreadyNotified, String(matched)].join(",");
      await db.update(applicationStageDocumentsTable)
        .set({ expiryNotifiedThresholds: updated })
        .where(eq(applicationStageDocumentsTable.id, doc.id));

      console.log(`[OFFER-EXPIRY] Notified ${recipientUserIds.size} recipient(s) for doc ${doc.id} — ${daysLeft}d left, threshold ${matched}`);
    }
  } catch (err) {
    console.error("[OFFER-EXPIRY] Check error:", err);
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

export function startOfferExpiryChecker(): () => void {
  if (intervalHandle || initialTimer) return stopOfferExpiryChecker;
  console.log(`[OFFER-EXPIRY] Checker started, running every ${CHECK_INTERVAL / 60000} minute(s)`);
  initialTimer = setTimeout(() => {
    initialTimer = null;
    void checkOfferLetterExpiries();
  }, 15000);
  intervalHandle = setInterval(() => { checkOfferLetterExpiries(); }, CHECK_INTERVAL);
  return stopOfferExpiryChecker;
}

export function stopOfferExpiryChecker(): void {
  if (initialTimer) clearTimeout(initialTimer);
  if (intervalHandle) clearInterval(intervalHandle);
  initialTimer = null;
  intervalHandle = null;
}
