import {
  db,
  websiteBlogPostsTable,
  commissionsTable,
  serviceFeesTable,
  financialTransactionsTable,
  auditLogsTable,
  usersTable,
  leadsTable,
  portalSubmissionsTable,
} from "@workspace/db";
import { createHash } from "node:crypto";
import { desc, sql, gte, inArray, isNull, and } from "drizzle-orm";

export type ScopeContextResult = {
  scope: string;
  summary: string;
  data: unknown;
};

export type ScopeFn = (opts: { branchId?: number }) => Promise<ScopeContextResult>;

async function getBlogContext(_opts: { branchId?: number }): Promise<ScopeContextResult> {
  try {
    const rows = await db
      .select({
        id: websiteBlogPostsTable.id,
        slug: websiteBlogPostsTable.slug,
        title: websiteBlogPostsTable.title,
        status: websiteBlogPostsTable.status,
        locale: websiteBlogPostsTable.locale,
        publishedAt: websiteBlogPostsTable.publishedAt,
      })
      .from(websiteBlogPostsTable)
      .orderBy(desc(websiteBlogPostsTable.publishedAt))
      .limit(20);
    return {
      scope: "blog",
      summary: `Recent blog posts: ${rows.length}`,
      data: { recent: rows },
    };
  } catch (e) {
    return {
      scope: "blog",
      summary: `blog scope unavailable: ${(e as Error).message}`,
      data: null,
    };
  }
}

async function getFinanceContext(_opts: { branchId?: number }): Promise<ScopeContextResult> {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [commCount] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(commissionsTable)
      .where(gte(commissionsTable.createdAt, since));
    const [feeCount] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(serviceFeesTable)
      .where(gte(serviceFeesTable.createdAt, since));
    const [txCount] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(financialTransactionsTable)
      .where(gte(financialTransactionsTable.createdAt, since));
    return {
      scope: "finance",
      summary: `Last 30d — commissions: ${commCount?.c ?? 0}, fees: ${feeCount?.c ?? 0}, transactions: ${txCount?.c ?? 0}`,
      data: {
        commissions30d: commCount?.c ?? 0,
        serviceFees30d: feeCount?.c ?? 0,
        transactions30d: txCount?.c ?? 0,
      },
    };
  } catch (e) {
    return {
      scope: "finance",
      summary: `finance scope unavailable: ${(e as Error).message}`,
      data: null,
    };
  }
}

async function getAuditContext(_opts: { branchId?: number }): Promise<ScopeContextResult> {
  try {
    const rows = await db
      .select({
        action: auditLogsTable.action,
        resource: auditLogsTable.resource,
        createdAt: auditLogsTable.createdAt,
      })
      .from(auditLogsTable)
      .orderBy(desc(auditLogsTable.createdAt))
      .limit(50);
    return {
      scope: "audit",
      summary: `Last ${rows.length} audit events`,
      data: { recent: rows },
    };
  } catch (e) {
    return {
      scope: "audit",
      summary: `audit scope unavailable: ${(e as Error).message}`,
      data: null,
    };
  }
}

async function getHrContext(_opts: { branchId?: number }): Promise<ScopeContextResult> {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const staff = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        role: usersTable.role,
      })
      .from(usersTable)
      .limit(100);
    let recentAssignments = 0;
    try {
      const [r] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(leadsTable)
        .where(gte(leadsTable.createdAt, since));
      recentAssignments = r?.c ?? 0;
    } catch {
      recentAssignments = 0;
    }
    return {
      scope: "hr",
      summary: `Staff: ${staff.length}, new leads last 7d: ${recentAssignments}`,
      data: { staff, recentAssignments },
    };
  } catch (e) {
    return {
      scope: "hr",
      summary: `hr scope unavailable: ${(e as Error).message}`,
      data: null,
    };
  }
}

async function getPortalAutomationContext(
  _opts: { branchId?: number },
): Promise<ScopeContextResult> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    const grouped = await db
      .select({
        status: portalSubmissionsTable.status,
        count: sql<number>`count(*)::int`,
      })
      .from(portalSubmissionsTable)
      .where(
        and(
          isNull(portalSubmissionsTable.deletedAt),
          gte(portalSubmissionsTable.updatedAt, since),
        ),
      )
      .groupBy(portalSubmissionsTable.status);

    const recent = await db
      .select({
        id: portalSubmissionsTable.id,
        universityKey: portalSubmissionsTable.universityKey,
        adapterKey: portalSubmissionsTable.adapterKey,
        status: portalSubmissionsTable.status,
        attempts: portalSubmissionsTable.attempts,
        error: portalSubmissionsTable.error,
        updatedAt: portalSubmissionsTable.updatedAt,
      })
      .from(portalSubmissionsTable)
      .where(
        and(
          isNull(portalSubmissionsTable.deletedAt),
          gte(portalSubmissionsTable.updatedAt, since),
          inArray(portalSubmissionsTable.status, [
            "failed",
            "program_missing",
            "program_full",
          ]),
        ),
      )
      .orderBy(desc(portalSubmissionsTable.updatedAt))
      .limit(20);

    // Cross-submission context is deliberately aggregate/fingerprint-only.
    // Raw errors can contain values typed into a university portal, so the
    // exact text is supplied only by the single-submission Guardian evidence.
    const safeRecent = recent.map(({ error, ...row }) => ({
      ...row,
      errorFingerprint: error
        ? createHash("sha256").update(error).digest("hex").slice(0, 16)
        : null,
    }));
    const statusCounts = Object.fromEntries(grouped.map((row) => [row.status, row.count]));
    return {
      scope: "portal_automation",
      summary: `Portal automation in the last 24h: ${Object.entries(statusCounts)
        .map(([status, count]) => `${status}=${count}`)
        .join(", ") || "no submissions"}`,
      data: { statusCounts, recentOutcomes: safeRecent },
    };
  } catch (e) {
    return {
      scope: "portal_automation",
      summary: `portal automation scope unavailable: ${(e as Error).message}`,
      data: null,
    };
  }
}

export const SCOPE_REGISTRY: Record<string, { fn: ScopeFn; label: string; description: string }> = {
  blog: {
    fn: getBlogContext,
    label: "Blog",
    description: "Website blog posts (status, locale, recent publications)",
  },
  finance: {
    fn: getFinanceContext,
    label: "Finance",
    description: "Commissions, service fees, financial transactions (30d aggregates)",
  },
  audit: {
    fn: getAuditContext,
    label: "Audit",
    description: "Recent audit log events (admin/system actions)",
  },
  hr: {
    fn: getHrContext,
    label: "HR",
    description: "Staff roster + recent workload (PII masked)",
  },
  portal_automation: {
    fn: getPortalAutomationContext,
    label: "Portal Automation",
    description:
      "PII-free portal submission status aggregates and recent failure fingerprints",
  },
};

export function listScopes() {
  return Object.entries(SCOPE_REGISTRY).map(([key, v]) => ({
    key,
    label: v.label,
    description: v.description,
  }));
}
