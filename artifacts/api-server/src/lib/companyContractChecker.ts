import { db, companyContractsTable, usersTable, settingsTable } from "@workspace/db";
import { and, eq, isNotNull, isNull, inArray } from "drizzle-orm";
import { dispatchNotification } from "./notificationDispatcher";
import { formatDate } from "@workspace/i18n";
import { getAppBaseUrl } from "./email";

const CHECK_INTERVAL = 60 * 60 * 1000;

const THRESHOLDS = [
  { days: 30, field: "lastWarning30SentAt" as const },
  { days: 14, field: "lastWarning14SentAt" as const },
  { days: 7, field: "lastWarning7SentAt" as const },
  { days: 1, field: "lastWarning1SentAt" as const },
];

function daysBetween(future: Date, now: Date): number {
  return Math.ceil((future.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

// Recipients per contract:
//   * Active admin-level users (super_admin, admin, manager) — they
//     always receive every expiry notification.
//   * Active users explicitly assigned to this contract via
//     `assigned_user_ids`.
// Unlike university contracts there is no "company" master entity, so there is
// no per-company assignedStaffIds source — recipients are admins ∪ the
// contract's own assignedUserIds.
const ADMIN_ROLES = ["super_admin", "admin", "manager"];

async function getAdminRecipients(): Promise<number[]> {
  const users = await db.select({ id: usersTable.id })
    .from(usersTable)
    .where(and(inArray(usersTable.role, ADMIN_ROLES), eq(usersTable.isActive, true)));
  return users.map(u => u.id);
}

async function resolveRecipients(
  adminIds: number[],
  contractUserIds: number[] | null | undefined,
): Promise<number[]> {
  const extra = Array.isArray(contractUserIds) ? contractUserIds : [];
  if (extra.length === 0) return [...adminIds];
  const activeExtras = await db.select({ id: usersTable.id })
    .from(usersTable)
    .where(and(inArray(usersTable.id, extra), eq(usersTable.isActive, true)));
  return Array.from(new Set([...adminIds, ...activeExtras.map(u => u.id)]));
}

function buildEmail(subject: string, body: string, actionUrl: string): { subject: string; html: string; text: string } {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1);">
    <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:28px;text-align:center;">
      <h1 style="margin:0;color:#fff;font-size:22px;">Find And Study OS</h1>
      <p style="margin:6px 0 0;color:rgba(255,255,255,.85);font-size:13px;">Company Contract Notification</p>
    </div>
    <div style="padding:28px;">
      <h2 style="margin:0 0 14px;color:#111827;font-size:18px;">${escape(subject)}</h2>
      <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6;white-space:pre-line;">${escape(body)}</p>
      <div style="text-align:center;margin:0 0 20px;">
        <a href="${actionUrl}" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:600;">Open contract</a>
      </div>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;" />
      <p style="margin:0;color:#9ca3af;font-size:12px;text-align:center;">Automated notification from Find And Study OS.</p>
    </div>
  </div></body></html>`;
  return { subject, html, text: body };
}

export async function checkCompanyContractExpiries(): Promise<void> {
  try {
    const rows = await db.select({
      id: companyContractsTable.id,
      companyName: companyContractsTable.companyName,
      country: companyContractsTable.country,
      year: companyContractsTable.year,
      effectiveDate: companyContractsTable.effectiveDate,
      expiryDate: companyContractsTable.expiryDate,
      lastWarning30SentAt: companyContractsTable.lastWarning30SentAt,
      lastWarning14SentAt: companyContractsTable.lastWarning14SentAt,
      lastWarning7SentAt: companyContractsTable.lastWarning7SentAt,
      lastWarning1SentAt: companyContractsTable.lastWarning1SentAt,
      expiryNoticeSentAt: companyContractsTable.expiryNoticeSentAt,
      assignedUserIds: companyContractsTable.assignedUserIds,
    })
      .from(companyContractsTable)
      .where(and(
        isNotNull(companyContractsTable.expiryDate),
        isNull(companyContractsTable.deletedAt),
      ));

    if (rows.length === 0) return;

    const adminIds = await getAdminRecipients();
    const [settings] = await db.select({ defaultLanguage: settingsTable.defaultLanguage }).from(settingsTable);
    const lang = settings?.defaultLanguage || "tr";
    const now = new Date();
    const baseUrl = getAppBaseUrl().replace(/\/$/, "");

    for (const row of rows) {
      if (!row.expiryDate) continue;
      const expiry = new Date(row.expiryDate);
      const daysLeft = daysBetween(expiry, now);
      const companyName = row.companyName || `Şirket #${row.id}`;
      const fmt = (d: Date) => formatDate(d, lang, { day: "2-digit", month: "long", year: "numeric" });
      const expiryStr = fmt(expiry);
      const effective = row.effectiveDate ? new Date(row.effectiveDate) : null;
      const effectiveStr = effective ? fmt(effective) : "—";
      const countryLabel = row.country || "—";

      // Absolute URL so email clients render a clickable deep link.
      const actionUrl = `${baseUrl}/admin/company-contracts/${row.id}`;

      if (daysLeft <= 0) {
        if (row.expiryNoticeSentAt) continue;
        const claimed = await db.update(companyContractsTable)
          .set({ expiryNoticeSentAt: now })
          .where(and(eq(companyContractsTable.id, row.id), isNull(companyContractsTable.expiryNoticeSentAt)))
          .returning({ id: companyContractsTable.id });
        if (claimed.length === 0) continue;

        const recipientIds = await resolveRecipients(adminIds, row.assignedUserIds as number[] | null);
        if (recipientIds.length === 0) continue;

        const subject = `[FindAndStudy] Company contract expired: ${companyName} (${countryLabel})`;
        const body = `Company: ${companyName}\nCountry: ${countryLabel}\nEffective date: ${effectiveStr}\nExpiry date: ${expiryStr}\n\nThe agreement with ${companyName} expired on ${expiryStr}. Please renew the contract or upload an updated version in Find And Study OS.\n\nOpen contract: ${actionUrl}`;
        await dispatchNotification({
          event: "company_contract.expired",
          title: `Şirket sözleşmesi sona erdi — ${companyName}`,
          body: `${companyName} (${countryLabel}) sözleşmesi ${expiryStr} tarihinde sona erdi. Lütfen yenileyin.`,
          actionUrl,
          icon: "AlertOctagon",
          recipientUserIds: recipientIds,
          data: { contractId: row.id, companyName, expiryDate: expiry.toISOString() },
          templateVars: { companyName, country: countryLabel, expiryDate: expiryStr },
          emailOverride: buildEmail(subject, body, actionUrl),
        });
        console.log(`[COMPANY-CONTRACT] Expiry notice sent for contract ${row.id} (${companyName}) → ${recipientIds.length} recipients`);
        continue;
      }

      // Exact-day trigger: warning fires only when daysLeft equals one of the
      // target thresholds (30 / 14 / 7 / 1). Hourly checker + ceil-based day
      // count means the equality holds for ~24h, but the per-threshold
      // sentAt column ensures one-shot delivery.
      const matched = THRESHOLDS.find(t => t.days === daysLeft);
      if (!matched) continue;
      if (row[matched.field]) continue;

      const claimed = await db.update(companyContractsTable)
        .set({ [matched.field]: now })
        .where(and(eq(companyContractsTable.id, row.id), isNull(companyContractsTable[matched.field])))
        .returning({ id: companyContractsTable.id });
      if (claimed.length === 0) continue;

      const recipientIds = await resolveRecipients(adminIds, row.assignedUserIds as number[] | null);
      if (recipientIds.length === 0) continue;

      const subject = `[FindAndStudy] Company contract expiring in ${matched.days} days: ${companyName} (${countryLabel})`;
      const body = `Company: ${companyName}\nCountry: ${countryLabel}\nEffective date: ${effectiveStr}\nExpiry date: ${expiryStr}\n\nThe agreement with ${companyName} is set to expire on ${expiryStr} (${daysLeft} day${daysLeft === 1 ? "" : "s"} remaining). Please prepare a renewal or contact the company to extend the contract.\n\nOpen contract: ${actionUrl}`;
      await dispatchNotification({
        event: "company_contract.expiring",
        title: `Şirket sözleşmesi ${daysLeft} gün içinde sona eriyor — ${companyName}`,
        body: `${companyName} (${countryLabel}) sözleşmesi ${expiryStr} tarihinde sona eriyor (${daysLeft} gün kaldı).`,
        actionUrl,
        icon: "AlertTriangle",
        recipientUserIds: recipientIds,
        data: { contractId: row.id, companyName, expiryDate: expiry.toISOString(), daysLeft, threshold: matched.days },
        templateVars: { companyName, country: countryLabel, expiryDate: expiryStr, daysLeft: String(daysLeft), threshold: String(matched.days) },
        emailOverride: buildEmail(subject, body, actionUrl),
      });
      console.log(`[COMPANY-CONTRACT] Notified ${recipientIds.length} for contract ${row.id} (${companyName}) — exactly ${daysLeft}d (threshold ${matched.days})`);
    }
  } catch (err) {
    console.error("[COMPANY-CONTRACT] Check error:", err);
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

export function startCompanyContractChecker(): () => void {
  if (intervalHandle || initialTimer) return stopCompanyContractChecker;
  console.log(`[COMPANY-CONTRACT] Checker started, running every ${CHECK_INTERVAL / 60000} minute(s)`);
  initialTimer = setTimeout(() => {
    initialTimer = null;
    void checkCompanyContractExpiries();
  }, 20000);
  intervalHandle = setInterval(() => { checkCompanyContractExpiries(); }, CHECK_INTERVAL);
  return stopCompanyContractChecker;
}

export function stopCompanyContractChecker(): void {
  if (initialTimer) clearTimeout(initialTimer);
  if (intervalHandle) clearInterval(intervalHandle);
  initialTimer = null;
  intervalHandle = null;
}
