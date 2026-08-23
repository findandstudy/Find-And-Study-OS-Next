import { Router, type IRouter } from "express";
import { db, invoicesTable, commissionsTable, serviceFeesTable, financialTransactionsTable, agentsTable, programsTable, usersTable, studentsTable, applicationsTable, settingsTable, staffCommissionsTable, staffCommissionPayoutsTable } from "@workspace/db";
import { eq, sql, and, desc, asc, inArray, isNull, or } from "drizzle-orm";
import { requireAuth, requireRole, requireAgentStaffPermission, logAudit } from "../lib/auth";
import { FINANCE_ROLES, STAFF_ROLES, AGENT_ROLES } from "../lib/roles";
import { z } from "zod";
import { validate, getValidated } from "../middlewares/validate";
import { getAgentRecord } from "../lib/agentVisibility";
import { dispatchNotification } from "../lib/notificationDispatcher";
import { getCurrentSeason } from "../lib/season";
import { loadCurrencyCatalog } from "../lib/currencyCatalog";
import * as XLSX from "xlsx";

const router: IRouter = Router();

function generateInvoiceNumber() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `INV-${ts}-${rand}`;
}

function toNum(v: any): number {
  return parseFloat(String(v ?? 0)) || 0;
}

// Currency normalization preserves any valid ISO-shaped code so that
// admin-added currencies (e.g. CHF, SAR) flow into per-currency
// aggregation buckets WITHOUT being collapsed into USD. This is critical:
// the system never mixes totals across currencies, so an unrecognised
// code must stay in its own bucket rather than poison the USD bucket.
function normCurrency(c: any): string {
  const s = String(c ?? "USD").toUpperCase().trim();
  return /^[A-Z]{2,5}$/.test(s) ? s : "USD";
}

type CommBucket = {
  potentialUniversityCommission: number;
  potentialAgentCommission: number;
  confirmedUniversityCommission: number;
  confirmedAgentCommission: number;
  totalUniversityCommission: number;
  totalUniversityCollected: number;
  totalAgentCommission: number;
  totalAgentPaid: number;
  totalSubAgentCommission: number;
  totalSubAgentPaid: number;
  totalStaffCommission: number;
  totalNetAgency: number;
  totalOffsetAmount: number;
  paidToAgents: number;
  paidToSubAgents: number;
  collectedFromUniversities: number;
  pendingToCollect: number;
  pendingToPay: number;
  pendingToPaySubAgents: number;
  totalStaffPayouts?: number;
  staffPayable?: number;
};
function emptyCommBucket(): CommBucket {
  return {
    potentialUniversityCommission: 0, potentialAgentCommission: 0,
    confirmedUniversityCommission: 0, confirmedAgentCommission: 0,
    totalUniversityCommission: 0, totalUniversityCollected: 0,
    totalAgentCommission: 0, totalAgentPaid: 0,
    totalSubAgentCommission: 0, totalSubAgentPaid: 0,
    totalStaffCommission: 0,
    totalNetAgency: 0, totalOffsetAmount: 0,
    paidToAgents: 0, paidToSubAgents: 0,
    collectedFromUniversities: 0,
    pendingToCollect: 0, pendingToPay: 0, pendingToPaySubAgents: 0,
  };
}
function buildCommissionsByCurrency(rows: any[]): Record<string, CommBucket> {
  const buckets: Record<string, CommBucket> = {};
  for (const c of rows) {
    const cur = normCurrency(c.currency);
    const b = buckets[cur] ?? (buckets[cur] = emptyCommBucket());
    const uAmt = toNum(c.universityCommissionAmount);
    const uColl = toNum(c.universityCollected);
    const aAmt = toNum(c.agentCommissionAmount);
    const aPaid = toNum(c.agentPaid);
    const saAmt = toNum(c.subAgentCommissionAmount);
    const saPaid = toNum(c.subAgentPaid);
    const staffAmt = toNum(c.staffCommissionAmount);
    b.totalUniversityCommission += uAmt;
    b.totalUniversityCollected += uColl;
    b.totalAgentCommission += aAmt;
    b.totalAgentPaid += aPaid;
    b.totalSubAgentCommission += saAmt;
    b.totalSubAgentPaid += saPaid;
    b.totalNetAgency += uAmt - aAmt - saAmt - staffAmt;
    b.totalOffsetAmount += toNum(c.offsetAmount);
    b.paidToAgents += aPaid;
    b.paidToSubAgents += saPaid;
    b.collectedFromUniversities += uColl;
    if (c.status === "potential") {
      b.potentialUniversityCommission += uAmt;
      b.potentialAgentCommission += aAmt;
    } else {
      // Only confirmed (non-potential) rows count toward staff commission totals
      b.totalStaffCommission += staffAmt;
      b.confirmedUniversityCommission += uAmt;
      b.confirmedAgentCommission += aAmt;
      b.pendingToCollect += (uAmt - uColl);
      b.pendingToPay += (aAmt - aPaid);
      b.pendingToPaySubAgents += (saAmt - saPaid);
    }
  }
  return buckets;
}

type FeeBucket = {
  totalServiceFees: number;
  totalCollected: number;
  potentialTotal: number;
  confirmedTotal: number;
};
function emptyFeeBucket(): FeeBucket {
  return { totalServiceFees: 0, totalCollected: 0, potentialTotal: 0, confirmedTotal: 0 };
}
function buildFeesByCurrency(rows: any[]): Record<string, FeeBucket> {
  const buckets: Record<string, FeeBucket> = {};
  for (const f of rows) {
    const cur = normCurrency(f.currency);
    const b = buckets[cur] ?? (buckets[cur] = emptyFeeBucket());
    const total = toNum(f.totalAmount);
    const collected = toNum(f.firstInstallmentPaidAt ? f.firstInstallmentAmount : 0) + toNum(f.secondInstallmentPaidAt ? f.secondInstallmentAmount : 0);
    b.totalServiceFees += total;
    b.totalCollected += collected;
    if (f.financeStatus === "potential") b.potentialTotal += total;
    else if (f.financeStatus === "confirmed") b.confirmedTotal += total;
  }
  return buckets;
}

type AgentCommBucket = { potential: number; confirmed: number; paid: number; pending: number };
function buildAgentCommByCurrency(rows: any[], isSubAgent: boolean): Record<string, AgentCommBucket> {
  const buckets: Record<string, AgentCommBucket> = {};
  for (const c of rows) {
    const cur = normCurrency(c.currency);
    const b = buckets[cur] ?? (buckets[cur] = { potential: 0, confirmed: 0, paid: 0, pending: 0 });
    const amt = toNum(isSubAgent ? c.subAgentCommissionAmount : c.agentCommissionAmount);
    const paid = toNum(isSubAgent ? c.subAgentPaid : c.agentPaid);
    if (c.status === "potential") b.potential += amt;
    else if (["confirmed", "collected_partial", "collected_full", "settled"].includes(c.status)) b.confirmed += amt;
    b.paid += paid;
    if (c.status !== "potential") b.pending += (amt - paid);
  }
  return buckets;
}
function buildAgentFeeByCurrency(rows: any[]): Record<string, AgentCommBucket> {
  const buckets: Record<string, AgentCommBucket> = {};
  for (const f of rows) {
    const cur = normCurrency(f.currency);
    const b = buckets[cur] ?? (buckets[cur] = { potential: 0, confirmed: 0, paid: 0, pending: 0 });
    const total = toNum(f.totalAmount);
    const collected = toNum(f.firstInstallmentPaidAt ? f.firstInstallmentAmount : 0) + toNum(f.secondInstallmentPaidAt ? f.secondInstallmentAmount : 0);
    if (f.financeStatus === "potential") b.potential += total;
    else if (f.financeStatus === "confirmed") b.confirmed += total;
    b.paid += collected;
    if (f.status !== "paid") b.pending += (total - collected);
  }
  return buckets;
}

async function enrichWithNames<T extends { agentId?: number | null; applicationId?: number | null; studentId?: number | null }>(
  rows: T[]
): Promise<(T & { agentName: string | null; staffName: string | null })[]> {
  if (rows.length === 0) return rows.map(r => ({ ...r, agentName: null, staffName: null }));
  const agentIds = [...new Set(rows.map(r => r.agentId).filter((x): x is number => x != null))];
  const appIds = [...new Set(rows.map(r => r.applicationId).filter((x): x is number => x != null))];
  const stuIds = [...new Set(rows.map(r => r.studentId).filter((x): x is number => x != null))];
  const [agents, apps, stus] = await Promise.all([
    agentIds.length > 0 ? db.select({ id: agentsTable.id, firstName: agentsTable.firstName, lastName: agentsTable.lastName, companyName: agentsTable.companyName }).from(agentsTable).where(inArray(agentsTable.id, agentIds)) : Promise.resolve([]),
    appIds.length > 0 ? db.select({ id: applicationsTable.id, assignedToId: applicationsTable.assignedToId }).from(applicationsTable).where(inArray(applicationsTable.id, appIds)) : Promise.resolve([]),
    stuIds.length > 0 ? db.select({ id: studentsTable.id, assignedToId: studentsTable.assignedToId }).from(studentsTable).where(inArray(studentsTable.id, stuIds)) : Promise.resolve([]),
  ]);
  const staffUserIds = [...new Set([
    ...apps.map(a => a.assignedToId),
    ...stus.map(s => s.assignedToId),
  ].filter((x): x is number => x != null))];
  const staffUsers = staffUserIds.length > 0
    ? await db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName }).from(usersTable).where(inArray(usersTable.id, staffUserIds))
    : [];
  const agentMap = new Map<number, string | null>(agents.map(a => [a.id, `${a.firstName || ""} ${a.lastName || ""}`.trim() || a.companyName || null]));
  const appToStaff = new Map<number, number | null>(apps.map(a => [a.id, a.assignedToId]));
  const stuToStaff = new Map<number, number | null>(stus.map(s => [s.id, s.assignedToId]));
  const staffMap = new Map<number, string | null>(staffUsers.map(u => [u.id, `${u.firstName || ""} ${u.lastName || ""}`.trim() || null]));
  return rows.map(r => {
    const agentName = r.agentId != null ? (agentMap.get(r.agentId) ?? null) : null;
    const suid = r.applicationId != null && appToStaff.has(r.applicationId)
      ? appToStaff.get(r.applicationId) ?? null
      : r.studentId != null && stuToStaff.has(r.studentId)
        ? stuToStaff.get(r.studentId) ?? null
        : null;
    const staffName = suid != null ? (staffMap.get(suid) ?? null) : null;
    return { ...r, agentName, staffName };
  });
}

function calcCommissionAmounts(body: any) {
  const programFee = toNum(body.programFee);
  const uRate = toNum(body.universityCommissionRate);
  const aRate = toNum(body.agentCommissionRate);
  const saRate = toNum(body.subAgentCommissionRate);
  const uAmount = body.universityCommissionAmount !== undefined
    ? toNum(body.universityCommissionAmount)
    : programFee > 0 && uRate > 0 ? (programFee * uRate) / 100 : 0;
  const aAmount = body.agentCommissionAmount !== undefined
    ? toNum(body.agentCommissionAmount)
    : uAmount > 0 && aRate > 0 ? (uAmount * aRate) / 100 : 0;
  const saAmount = body.subAgentCommissionAmount !== undefined
    ? toNum(body.subAgentCommissionAmount)
    : aAmount > 0 && saRate > 0 ? (aAmount * saRate) / 100 : 0;
  return { uAmount, aAmount, saAmount };
}

/* ─── CURRENCIES IN USE ──────────────────────────────────────── */

router.get("/currencies-in-use", requireAuth, requireRole(...FINANCE_ROLES), async (_req, res): Promise<void> => {
  try {
    const [progRows, commRows, feeRows, catalog] = await Promise.all([
      db.selectDistinct({ currency: programsTable.currency }).from(programsTable),
      db.selectDistinct({ currency: commissionsTable.currency }).from(commissionsTable),
      db.selectDistinct({ currency: serviceFeesTable.currency }).from(serviceFeesTable),
      loadCurrencyCatalog(),
    ]);
    const set = new Set<string>();
    for (const r of [...progRows, ...commRows, ...feeRows]) {
      const raw = String((r as any).currency ?? "").toUpperCase().trim();
      if (/^[A-Z]{2,5}$/.test(raw)) set.add(raw);
    }
    // Strict intersection: only codes that BOTH appear in real data AND
    // are configured in catalog_options. If an admin deactivates/deletes
    // a currency, it disappears from selectors even if legacy rows still
    // exist (those rows are reported via the delete usage-check instead).
    const ordered = catalog.ordered.filter(c => set.has(c));
    res.json({ currencies: ordered });
  } catch {
    res.json({ currencies: [] });
  }
});

/* ─── FINANCE HELPER ENDPOINTS ──────────────────────────────── */

router.get("/finance/student-search", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const q = String(req.query.q || "").trim();
  const limit = Math.min(parseInt(String(req.query.limit || "10"), 10), 20);
  if (q.length < 2) { res.json({ data: [] }); return; }
  const term = `%${q}%`;
  const rows = await db.select({
    id: studentsTable.id,
    firstName: studentsTable.firstName,
    lastName: studentsTable.lastName,
    email: studentsTable.email,
  })
  .from(studentsTable)
  .where(and(
    isNull(studentsTable.deletedAt),
    sql`(${studentsTable.firstName} ilike ${term} OR ${studentsTable.lastName} ilike ${term} OR ${studentsTable.email} ilike ${term} OR concat(${studentsTable.firstName}, ' ', ${studentsTable.lastName}) ilike ${term})`
  ))
  .orderBy(desc(studentsTable.id))
  .limit(limit);
  res.json({ data: rows.map(r => ({ id: r.id, name: `${r.firstName || ""} ${r.lastName || ""}`.trim(), email: r.email })) });
});

router.get("/finance/student-applications/:studentId", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const studentId = parseInt(String(req.params.studentId), 10);
  if (isNaN(studentId)) { res.json({ data: [] }); return; }
  const rows = await db.select({
    id: applicationsTable.id,
    universityName: applicationsTable.universityName,
    programName: applicationsTable.programName,
    stage: applicationsTable.stage,
    season: applicationsTable.season,
  })
  .from(applicationsTable)
  .where(and(isNull(applicationsTable.deletedAt), eq(applicationsTable.studentId, studentId)))
  .orderBy(desc(applicationsTable.createdAt))
  .limit(30);
  res.json({ data: rows });
});

/* ─── UNIVERSITY RECEIVABLES & COLLECTION ───────────────────── */

router.get("/finance/university-receivables", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const { season } = req.query as Record<string, string>;
  const conditions: any[] = [
    sql`${commissionsTable.status} != 'potential'`,
    sql`${commissionsTable.status} != 'excluded'`,
  ];
  if (season) conditions.push(eq(commissionsTable.season, season));

  const rows = await db
    .select({
      universityName: commissionsTable.universityName,
      currency: commissionsTable.currency,
      totalConfirmed: sql<string>`COALESCE(SUM(${commissionsTable.universityCommissionAmount}::numeric), 0)`,
      totalCollected: sql<string>`COALESCE(SUM(${commissionsTable.universityCollected}::numeric), 0)`,
    })
    .from(commissionsTable)
    .where(and(...conditions))
    .groupBy(commissionsTable.universityName, commissionsTable.currency)
    .orderBy(asc(commissionsTable.universityName));

  const data = rows
    .filter(r => r.universityName)
    .map(r => ({
      universityName: r.universityName!,
      currency: r.currency || "USD",
      totalConfirmed: toNum(r.totalConfirmed),
      totalCollected: toNum(r.totalCollected),
      remaining: Math.max(0, toNum(r.totalConfirmed) - toNum(r.totalCollected)),
    }))
    .filter(r => r.remaining > 0.001);

  res.json({ data });
});

const uniCollectionBodySchema = z.object({
  universityName: z.string().min(1),
  currency: z.string().min(1),
  amount: z.number().positive(),
  transactionDate: z.string().min(1),
  reference: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

router.post("/finance/university-collection", requireAuth, requireRole(...FINANCE_ROLES), validate({ body: uniCollectionBodySchema }), async (req, res): Promise<void> => {
  const { universityName, currency, amount, transactionDate, reference, notes } =
    getValidated<{ body: typeof uniCollectionBodySchema }>(req).body;

  // FIFO: confirmed/partial/full rows for this university+currency with remaining > 0
  const rows = await db.select().from(commissionsTable)
    .where(and(
      eq(commissionsTable.universityName, universityName),
      eq(commissionsTable.currency, currency),
      sql`${commissionsTable.status} IN ('confirmed', 'collected_partial', 'collected_full')`,
      sql`${commissionsTable.universityCommissionAmount}::numeric > ${commissionsTable.universityCollected}::numeric`,
    ))
    .orderBy(asc(commissionsTable.confirmedAt), asc(commissionsTable.id));

  if (rows.length === 0) {
    res.status(400).json({ error: "No receivable balance for this university/currency" });
    return;
  }

  const totalRemaining = rows.reduce((s, r) =>
    s + Math.max(0, toNum(r.universityCommissionAmount) - toNum(r.universityCollected)), 0);

  if (amount > totalRemaining + 0.001) {
    res.status(400).json({ error: "Amount exceeds remaining balance", remaining: totalRemaining });
    return;
  }

  // FIFO distribution
  let leftover = amount;
  const distributed: { commissionId: number; amount: number }[] = [];
  for (const row of rows) {
    if (leftover <= 0.001) break;
    const rowRemaining = Math.max(0, toNum(row.universityCommissionAmount) - toNum(row.universityCollected));
    if (rowRemaining <= 0.001) continue;
    const toApply = Math.min(rowRemaining, leftover);
    leftover -= toApply;
    distributed.push({ commissionId: row.id, amount: toApply });
  }

  // Create transactions + recompute each row's denormalised totals
  for (const d of distributed) {
    const [comm] = await db.select().from(commissionsTable).where(eq(commissionsTable.id, d.commissionId));

    await db.insert(financialTransactionsTable).values({
      commissionId: d.commissionId,
      type: "collection",
      amount: String(d.amount),
      currency,
      transactionDate: new Date(transactionDate),
      reference: reference || null,
      universityName,
      notes: notes || null,
    });

    const allTx = await db.select().from(financialTransactionsTable)
      .where(eq(financialTransactionsTable.commissionId, d.commissionId));

    const totalColl = allTx.filter(t => t.type === "collection").reduce((s, t) => s + toNum(t.amount), 0);
    const totalPaid = allTx.filter(t => t.type === "agent_payment").reduce((s, t) => s + toNum(t.amount), 0);
    const totalSubPaid = allTx.filter(t => t.type === "sub_agent_payment").reduce((s, t) => s + toNum(t.amount), 0);
    const uTotal = toNum(comm.universityCommissionAmount);
    const aTotal = toNum(comm.agentCommissionAmount);
    const saTotal = toNum(comm.subAgentCommissionAmount);
    const agentFullyPaid = totalPaid >= aTotal;
    const subAgentFullyPaid = saTotal <= 0 || totalSubPaid >= saTotal;

    let newStatus = comm.status;
    if (totalColl >= uTotal && agentFullyPaid && subAgentFullyPaid && uTotal > 0) {
      newStatus = "settled";
    } else if (totalColl >= uTotal && uTotal > 0) {
      newStatus = "collected_full";
    } else if (totalColl > 0) {
      newStatus = "collected_partial";
    }

    await db.update(commissionsTable).set({
      universityCollected: String(totalColl),
      agentPaid: String(totalPaid),
      subAgentPaid: String(totalSubPaid),
      status: newStatus,
    }).where(eq(commissionsTable.id, d.commissionId));
  }

  await logAudit(req.user!.id, "record_university_collection", "commission",
    distributed[0]?.commissionId,
    { universityName, currency, amount, count: distributed.length }, req.ip);

  const updatedRemaining = Math.max(0, totalRemaining - amount);
  res.status(201).json({ distributed, updatedRemaining });
});

/* ─── AGENT PAYABLES & AGENT PAYMENT ────────────────────────── */

router.get("/finance/agent-payables", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const { season } = req.query as Record<string, string>;

  const rows = await db.execute<{
    agentId: number;
    agentName: string;
    currency: string;
    totalAgentCommission: string;
    totalAgentPaid: string;
    remaining: string;
  }>(sql`
    SELECT
      c.agent_id AS "agentId",
      COALESCE(
        NULLIF(TRIM(CONCAT(a.first_name, ' ', a.last_name)), ''),
        a.company_name,
        a.business_name,
        CONCAT('Agent #', c.agent_id::text)
      ) AS "agentName",
      c.currency,
      SUM(c.agent_commission_amount::numeric) AS "totalAgentCommission",
      SUM(c.agent_paid::numeric)              AS "totalAgentPaid",
      SUM(c.agent_commission_amount::numeric - c.agent_paid::numeric) AS remaining
    FROM commissions c
    LEFT JOIN agents a ON a.id = c.agent_id
    WHERE c.agent_id IS NOT NULL
      AND c.status NOT IN ('potential', 'excluded')
      AND c.agent_commission_amount::numeric > 0
      ${season ? sql`AND c.season = ${season}` : sql``}
    GROUP BY c.agent_id, a.first_name, a.last_name, a.company_name, a.business_name, c.currency
    HAVING SUM(c.agent_commission_amount::numeric - c.agent_paid::numeric) > 0.001
    ORDER BY "agentName", c.currency
  `);

  res.json({ data: rows.rows });
});

const agentPaymentBodySchema = z.object({
  agentId: z.number().int().positive(),
  currency: z.string().min(1).max(10),
  amount: z.number().positive(),
  transactionDate: z.string().min(1),
  reference: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

router.post("/finance/agent-payment", requireAuth, requireRole(...FINANCE_ROLES), validate({ body: agentPaymentBodySchema }), async (req, res): Promise<void> => {
  const { agentId, currency, amount, transactionDate, reference, notes } =
    getValidated<{ body: typeof agentPaymentBodySchema }>(req).body;

  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, agentId));
  if (!agent) {
    res.status(400).json({ error: "Agent not found" });
    return;
  }

  const rows = await db.select().from(commissionsTable)
    .where(and(
      eq(commissionsTable.agentId, agentId),
      eq(commissionsTable.currency, currency),
      sql`${commissionsTable.status} IN ('confirmed', 'collected_partial', 'collected_full', 'settled')`,
      sql`${commissionsTable.agentCommissionAmount}::numeric > ${commissionsTable.agentPaid}::numeric`,
    ))
    .orderBy(asc(commissionsTable.confirmedAt), asc(commissionsTable.id));

  if (rows.length === 0) {
    res.status(400).json({ error: "No agent commission balance for this agent/currency" });
    return;
  }

  const totalRemaining = rows.reduce((s, r) => s + toNum(r.agentCommissionAmount) - toNum(r.agentPaid), 0);
  if (amount > totalRemaining + 0.001) {
    res.status(400).json({ error: "Amount exceeds remaining agent balance" });
    return;
  }

  let toDistribute = amount;
  const distributed: { commissionId: number; amount: number }[] = [];

  for (const row of rows) {
    if (toDistribute <= 0.001) break;
    const rowRemaining = toNum(row.agentCommissionAmount) - toNum(row.agentPaid);
    if (rowRemaining <= 0.001) continue;
    const take = Math.min(toDistribute, rowRemaining);
    distributed.push({ commissionId: row.id, amount: parseFloat(take.toFixed(6)) });
    toDistribute -= take;
  }

  const agentDisplayName = [agent.firstName, agent.lastName].filter(Boolean).join(" ") || agent.companyName || agent.businessName || null;

  for (const d of distributed) {
    const [comm] = await db.select().from(commissionsTable).where(eq(commissionsTable.id, d.commissionId));

    await db.insert(financialTransactionsTable).values({
      commissionId: d.commissionId,
      type: "agent_payment",
      amount: String(d.amount),
      currency,
      transactionDate: new Date(transactionDate),
      reference: reference || null,
      agentId,
      agentName: agentDisplayName,
      notes: notes || null,
    });

    const allTx = await db.select().from(financialTransactionsTable)
      .where(eq(financialTransactionsTable.commissionId, d.commissionId));

    const totalCollected = allTx.filter(t => t.type === "collection").reduce((s, t) => s + toNum(t.amount), 0);
    const totalPaid = allTx.filter(t => t.type === "agent_payment").reduce((s, t) => s + toNum(t.amount), 0);
    const totalSubPaid = allTx.filter(t => t.type === "sub_agent_payment").reduce((s, t) => s + toNum(t.amount), 0);

    const uTotal = toNum(comm.universityCommissionAmount);
    const aTotal = toNum(comm.agentCommissionAmount);
    const saTotal = toNum(comm.subAgentCommissionAmount);

    let newStatus = comm.status;
    const agentFullyPaid = aTotal <= 0 || totalPaid >= aTotal;
    const subAgentFullyPaid = saTotal <= 0 || totalSubPaid >= saTotal;
    if (totalCollected >= uTotal && agentFullyPaid && subAgentFullyPaid && uTotal > 0) {
      newStatus = "settled";
    } else if (totalCollected >= uTotal && uTotal > 0) {
      newStatus = "collected_full";
    } else if (totalCollected > 0) {
      newStatus = "collected_partial";
    }

    await db.update(commissionsTable).set({
      agentPaid: String(totalPaid),
      status: newStatus,
    }).where(eq(commissionsTable.id, d.commissionId));
  }

  await logAudit(req.user!.id, "create_agent_payment", "financial_transaction", agentId, { agentId, currency, amount }, req.ip);

  res.status(201).json({ distributed, updatedRemaining: Math.max(0, totalRemaining - amount) });
});

/* ─── STAFF COMMISSION PAYABLES ─────────────────────────────── */

router.get("/finance/staff-payables", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const { season } = req.query as Record<string, string>;

  const rows = await db.execute<{
    staffUserId: number;
    staffName: string;
    currency: string;
    totalStaffCommission: string;
    totalPaid: string;
    remaining: string;
  }>(sql`
    SELECT
      c.staff_user_id AS "staffUserId",
      COALESCE(
        NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''),
        u.email,
        CONCAT('Staff #', c.staff_user_id::text)
      ) AS "staffName",
      c.staff_commission_currency AS currency,
      SUM(c.staff_commission_amount::numeric) AS "totalStaffCommission",
      COALESCE(SUM(paid_sub.paid), 0) AS "totalPaid",
      SUM(c.staff_commission_amount::numeric) - COALESCE(SUM(paid_sub.paid), 0) AS remaining
    FROM commissions c
    LEFT JOIN users u ON u.id = c.staff_user_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(p.amount::numeric), 0) AS paid
      FROM staff_commission_payouts p
      WHERE p.commission_id = c.id AND p.deleted_at IS NULL
    ) paid_sub ON true
    WHERE c.staff_user_id IS NOT NULL
      AND c.status NOT IN ('potential', 'excluded')
      AND c.staff_commission_amount::numeric > 0
      ${season ? sql`AND c.season = ${season}` : sql``}
    GROUP BY c.staff_user_id, u.first_name, u.last_name, u.email, c.staff_commission_currency
    HAVING SUM(c.staff_commission_amount::numeric) - COALESCE(SUM(paid_sub.paid), 0) > 0.001
    ORDER BY "staffName", c.staff_commission_currency
  `);

  res.json({ data: rows.rows });
});

const staffCommissionPaymentBodySchema = z.object({
  staffUserId: z.number().int().positive(),
  currency: z.string().min(1).max(10),
  amount: z.number().positive(),
  transactionDate: z.string().min(1),
  reference: z.string().optional().nullable(),
  attachmentUrl: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

router.post("/finance/staff-commission-payment", requireAuth, requireRole(...FINANCE_ROLES), validate({ body: staffCommissionPaymentBodySchema }), async (req, res): Promise<void> => {
  const { staffUserId, currency, amount, transactionDate, reference, attachmentUrl, notes } =
    getValidated<{ body: typeof staffCommissionPaymentBodySchema }>(req).body;

  const [staffUser] = await db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName })
    .from(usersTable).where(eq(usersTable.id, staffUserId));
  if (!staffUser) {
    res.status(400).json({ error: "Staff user not found" });
    return;
  }

  const commRows = await db.select().from(commissionsTable)
    .where(and(
      eq(commissionsTable.staffUserId, staffUserId),
      eq(commissionsTable.staffCommissionCurrency, currency),
      sql`${commissionsTable.status} IN ('confirmed', 'collected_partial', 'collected_full', 'settled')`,
      sql`${commissionsTable.staffCommissionAmount}::numeric > 0`,
    ))
    .orderBy(asc(commissionsTable.confirmedAt), asc(commissionsTable.id));

  if (commRows.length === 0) {
    res.status(400).json({ error: "No staff commission balance for this staff/currency" });
    return;
  }

  const commIds = commRows.map(r => r.id);
  const payoutRows = await db.select({
    commissionId: staffCommissionPayoutsTable.commissionId,
    total: sql<string>`COALESCE(SUM(${staffCommissionPayoutsTable.amount}::numeric), 0)`,
  }).from(staffCommissionPayoutsTable)
    .where(and(
      inArray(staffCommissionPayoutsTable.commissionId, commIds),
      isNull(staffCommissionPayoutsTable.deletedAt),
    ))
    .groupBy(staffCommissionPayoutsTable.commissionId);

  const payoutByComm: Record<number, number> = {};
  for (const p of payoutRows) {
    if (p.commissionId !== null) payoutByComm[p.commissionId] = toNum(p.total);
  }

  const eligibleRows = commRows
    .map(r => ({ ...r, rowRemaining: toNum(r.staffCommissionAmount) - (payoutByComm[r.id] ?? 0) }))
    .filter(r => r.rowRemaining > 0.001);

  const totalRemaining = eligibleRows.reduce((s, r) => s + r.rowRemaining, 0);

  if (amount > totalRemaining + 0.001) {
    res.status(400).json({ error: "Amount exceeds remaining staff balance" });
    return;
  }

  let toDistribute = amount;
  const distributed: { commissionId: number; amount: number }[] = [];

  for (const row of eligibleRows) {
    if (toDistribute <= 0.001) break;
    const take = Math.min(toDistribute, row.rowRemaining);
    distributed.push({ commissionId: row.id, amount: parseFloat(take.toFixed(6)) });
    toDistribute -= take;
  }

  const paidAt = new Date(transactionDate);
  for (const d of distributed) {
    await db.insert(staffCommissionPayoutsTable).values({
      commissionId: d.commissionId,
      staffUserId,
      amount: String(d.amount),
      currency,
      paidAt,
      reference: reference || null,
      attachmentUrl: attachmentUrl || null,
      notes: notes || null,
      createdBy: req.user!.id,
    });
  }

  await logAudit(req.user!.id, "create_staff_commission_payment", "staff_commission_payout", staffUserId, { staffUserId, currency, amount, count: distributed.length }, req.ip);

  res.status(201).json({ distributed, updatedRemaining: Math.max(0, totalRemaining - amount) });
});

/* ─── COMMISSIONS ────────────────────────────────────────────── */

const COMMISSION_PATCH_FIELDS = [
  "status", "season", "currency", "studentName", "universityName", "programName",
  "isStateUniversity", "programFee", "universityCommissionRate", "universityCommissionAmount",
  "universityCollected", "agentCommissionRate", "agentCommissionAmount", "agentPaid",
  "subAgentId", "subAgentCommissionRate", "subAgentCommissionAmount", "subAgentPaid",
  "staffUserId", "staffCommissionAmount", "staffCommissionCurrency",
  "confirmedAt", "offsetAmount", "studentId", "agentId", "applicationId", "notes",
];

router.get("/commissions", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const { agentId, staffUserId, status, season, search, page = "1", limit = "100", includeExcluded } = req.query as Record<string, string>;
  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];
  if (agentId) conditions.push(eq(commissionsTable.agentId, parseInt(agentId, 10)));
  if (status) conditions.push(eq(commissionsTable.status, status));
  if (season) conditions.push(eq(commissionsTable.season, season));
  if (search) {
    conditions.push(
      sql`(${commissionsTable.studentName} ilike ${"%" + search + "%"} OR ${commissionsTable.universityName} ilike ${"%" + search + "%"})`
    );
  }
  if (staffUserId) {
    const staffId = parseInt(staffUserId, 10);
    if (!isNaN(staffId)) {
      conditions.push(sql`(
        ${commissionsTable.applicationId} IN (SELECT id FROM applications WHERE assigned_to_id = ${staffId})
        OR (${commissionsTable.applicationId} IS NULL AND ${commissionsTable.studentId} IN (SELECT id FROM students WHERE assigned_to_id = ${staffId}))
      )`);
    }
  }
  if (includeExcluded !== "true" && includeExcluded !== "1") {
    conditions.push(sql`${commissionsTable.status} != 'excluded'`);
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(commissionsTable).where(whereClause);
  const rawData = await db.select().from(commissionsTable).where(whereClause).limit(limitNum).offset(offset)
    .orderBy(desc(commissionsTable.createdAt));
  const data = await enrichWithNames(rawData);

  const summaryConditions = conditions.filter(c => c !== sql`${commissionsTable.status} != 'excluded'`);
  summaryConditions.push(sql`${commissionsTable.status} != 'excluded'`);
  const activeOnly = await db.select().from(commissionsTable).where(
    summaryConditions.length > 0 ? and(...summaryConditions) : undefined
  );

  // Query staff commission payouts for the active commission set (for staffPayable)
  const activeCommissionIds = activeOnly.map(c => c.id);
  const staffPayoutsByCurrency: Record<string, number> = {};
  if (activeCommissionIds.length > 0) {
    const payoutRows = await db.select({
      currency: staffCommissionPayoutsTable.currency,
      total: sql<string>`coalesce(sum(${staffCommissionPayoutsTable.amount}::numeric), 0)`,
    }).from(staffCommissionPayoutsTable)
      .where(and(
        inArray(staffCommissionPayoutsTable.commissionId, activeCommissionIds),
        isNull(staffCommissionPayoutsTable.deletedAt)
      ))
      .groupBy(staffCommissionPayoutsTable.currency);
    for (const row of payoutRows) {
      const cur = normCurrency(row.currency);
      staffPayoutsByCurrency[cur] = (staffPayoutsByCurrency[cur] || 0) + toNum(row.total);
    }
  }

  const byCurrency = buildCommissionsByCurrency(activeOnly);
  // Enrich each currency bucket with staffPayable
  for (const [cur, bucket] of Object.entries(byCurrency)) {
    bucket.totalStaffPayouts = staffPayoutsByCurrency[cur] ?? 0;
    bucket.staffPayable = Math.max(0, bucket.totalStaffCommission - (staffPayoutsByCurrency[cur] ?? 0));
  }

  // Only confirmed (non-potential) rows count toward staff commission totals
  const totalStaffCommission = activeOnly.filter(c => c.status !== "potential").reduce((s, c) => s + toNum(c.staffCommissionAmount), 0);
  const totalStaffPayouts = Object.values(staffPayoutsByCurrency).reduce((s, v) => s + v, 0);

  const summary = {
    potentialCount: activeOnly.filter(c => c.status === "potential").length,
    confirmedCount: activeOnly.filter(c => c.status === "confirmed").length,
    totalUniversityCommission: activeOnly.reduce((s, c) => s + toNum(c.universityCommissionAmount), 0),
    totalUniversityCollected: activeOnly.reduce((s, c) => s + toNum(c.universityCollected), 0),
    totalAgentCommission: activeOnly.reduce((s, c) => s + toNum(c.agentCommissionAmount), 0),
    totalAgentPaid: activeOnly.reduce((s, c) => s + toNum(c.agentPaid), 0),
    totalSubAgentCommission: activeOnly.reduce((s, c) => s + toNum(c.subAgentCommissionAmount), 0),
    totalSubAgentPaid: activeOnly.reduce((s, c) => s + toNum(c.subAgentPaid), 0),
    totalStaffCommission,
    totalStaffPayouts,
    staffPayable: Math.max(0, totalStaffCommission - totalStaffPayouts),
    // Net Income = University − Agent − SubAgent − Staff
    totalNetAgency: activeOnly.reduce((s, c) => s + (toNum(c.universityCommissionAmount) - toNum(c.agentCommissionAmount) - toNum(c.subAgentCommissionAmount) - toNum(c.staffCommissionAmount)), 0),
    totalOffsetAmount: activeOnly.reduce((s, c) => s + toNum(c.offsetAmount), 0),
    byCurrency,
  };

  res.json({
    data,
    summary,
    meta: { total: Number(count), page: pageNum, limit: limitNum, totalPages: Math.ceil(Number(count) / limitNum) },
  });
});

const postCommissionBodySchema = z.object({
  applicationId: z.number().int().optional().nullable(),
  studentId: z.number().int().optional().nullable(),
  agentId: z.number().int().optional().nullable(),
  subAgentId: z.number().int().optional().nullable(),
  staffUserId: z.number().int().optional().nullable(),
  studentName: z.string().optional().nullable(),
  universityName: z.string().optional().nullable(),
  programName: z.string().optional().nullable(),
  isStateUniversity: z.boolean().optional().default(false),
  season: z.string().optional().nullable(),
  currency: z.string().default("USD"),
  programFee: z.number().optional().nullable(),
  universityCommissionRate: z.number().optional().nullable(),
  agentCommissionRate: z.number().optional().nullable(),
  universityCommissionAmount: z.number().optional().nullable(),
  agentCommissionAmount: z.number().optional().nullable(),
  subAgentCommissionRate: z.number().optional().nullable(),
  subAgentCommissionAmount: z.number().optional().nullable(),
  staffCommissionAmount: z.number().optional().nullable(),
  staffCommissionCurrency: z.string().optional().nullable(),
  universityCollected: z.number().optional().default(0),
  agentPaid: z.number().optional().default(0),
  subAgentPaid: z.number().optional().default(0),
  offsetAmount: z.number().optional().default(0),
  status: z.string().default("potential"),
  notes: z.string().optional().nullable(),
});

router.post("/commissions", requireAuth, requireRole(...FINANCE_ROLES), validate({ body: postCommissionBodySchema }), async (req, res): Promise<void> => {
  const body = getValidated<{ body: typeof postCommissionBodySchema }>(req).body;
  const {
    applicationId, studentId, agentId, subAgentId, staffUserId,
    studentName, universityName, programName, isStateUniversity,
    season: bodySeason, currency,
    programFee, universityCommissionRate, agentCommissionRate,
    universityCommissionAmount, agentCommissionAmount,
    subAgentCommissionRate, subAgentCommissionAmount,
    staffCommissionAmount, staffCommissionCurrency,
    universityCollected, agentPaid, subAgentPaid, offsetAmount,
    status, notes,
  } = body;
  const season = bodySeason || (await getCurrentSeason());

  const { uAmount, aAmount, saAmount } = calcCommissionAmounts({
    programFee, universityCommissionRate, agentCommissionRate,
    universityCommissionAmount, agentCommissionAmount,
    subAgentCommissionRate, subAgentCommissionAmount,
  });

  const [commission] = await db.insert(commissionsTable).values({
    applicationId: applicationId ?? null,
    studentId: studentId ?? null,
    agentId: agentId ?? null,
    subAgentId: subAgentId ?? null,
    staffUserId: staffUserId ?? null,
    studentName: studentName || null,
    universityName: universityName || null,
    programName: programName || null,
    isStateUniversity: isStateUniversity ?? false,
    season,
    currency,
    programFee: programFee != null ? String(programFee) : null,
    universityCommissionRate: universityCommissionRate != null ? String(universityCommissionRate) : null,
    universityCommissionAmount: uAmount > 0 ? String(uAmount) : (universityCommissionAmount != null ? String(universityCommissionAmount) : null),
    universityCollected: String(universityCollected ?? 0),
    agentCommissionRate: agentCommissionRate != null ? String(agentCommissionRate) : null,
    agentCommissionAmount: aAmount > 0 ? String(aAmount) : (agentCommissionAmount != null ? String(agentCommissionAmount) : null),
    agentPaid: String(agentPaid ?? 0),
    subAgentCommissionRate: subAgentCommissionRate != null ? String(subAgentCommissionRate) : null,
    subAgentCommissionAmount: saAmount > 0 ? String(saAmount) : (subAgentCommissionAmount != null ? String(subAgentCommissionAmount) : null),
    subAgentPaid: String(subAgentPaid ?? 0),
    staffCommissionAmount: staffCommissionAmount != null ? String(staffCommissionAmount) : undefined,
    staffCommissionCurrency: staffCommissionCurrency || null,
    status,
    offsetAmount: String(offsetAmount ?? 0),
    notes: notes || null,
  }).returning();

  await logAudit(req.user!.id, "create_commission", "commission", commission.id, { studentName, universityName }, req.ip);

  try {
    await dispatchNotification({
      actorUserId: req.user!.id,
      event: "finance.commission_confirmed",
      title: "Commission Created",
      body: `A new commission has been created for ${studentName || "student"} — ${universityName || "University"}.`,
      actionUrl: `/staff/finance`,
      icon: "DollarSign",
      templateVars: { studentName: studentName || "", universityName: universityName || "", programName: programName || "" },
    });
  } catch {}

  res.status(201).json(commission);
});

router.get("/commissions/:id", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [c] = await db.select().from(commissionsTable).where(eq(commissionsTable.id, id));
  if (!c) { res.status(404).json({ error: "Commission not found" }); return; }
  res.json(c);
});

router.patch("/commissions/:id", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const updates: Record<string, unknown> = {};
  for (const key of COMMISSION_PATCH_FIELDS) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (req.body.universityCommissionRate !== undefined || req.body.programFee !== undefined || req.body.agentCommissionRate !== undefined || req.body.subAgentCommissionRate !== undefined) {
    const existing = await db.select().from(commissionsTable).where(eq(commissionsTable.id, id));
    if (existing[0]) {
      const merged = { ...existing[0], ...req.body };
      const { uAmount, aAmount, saAmount } = calcCommissionAmounts(merged);
      if (!req.body.universityCommissionAmount && uAmount > 0) updates.universityCommissionAmount = String(uAmount);
      if (!req.body.agentCommissionAmount && aAmount > 0) updates.agentCommissionAmount = String(aAmount);
      if (!req.body.subAgentCommissionAmount && saAmount > 0) updates.subAgentCommissionAmount = String(saAmount);
    }
  }

  if (req.body.status === "confirmed" && !req.body.confirmedAt) {
    updates.confirmedAt = new Date().toISOString();
  }

  if (Object.keys(updates).length === 0) { res.status(400).json({ error: "No valid fields" }); return; }
  const [commission] = await db.update(commissionsTable).set(updates).where(eq(commissionsTable.id, id)).returning();
  if (!commission) { res.status(404).json({ error: "Commission not found" }); return; }
  await logAudit(req.user!.id, "update_commission", "commission", id, updates, req.ip);
  res.json(commission);
});

router.post("/commissions/bulk-delete", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "ids array is required" });
    return;
  }
  const numericIds = ids.map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id));
  if (numericIds.length === 0) { res.status(400).json({ error: "No valid ids" }); return; }
  await db.delete(commissionsTable).where(inArray(commissionsTable.id, numericIds));
  await logAudit(req.user!.id, "bulk_delete_commissions", "commission", null as any, { count: numericIds.length, ids: numericIds }, req.ip);
  res.json({ deleted: numericIds.length });
});

router.post("/commissions/bulk-delete-by-university", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const { universityNames } = req.body;
  if (!Array.isArray(universityNames) || universityNames.length === 0) {
    res.status(400).json({ error: "universityNames array is required" });
    return;
  }
  const names = (universityNames as any[]).filter((n: any) => typeof n === "string" && n.trim());
  if (names.length === 0) { res.status(400).json({ error: "No valid university names" }); return; }
  await db.delete(commissionsTable).where(inArray(commissionsTable.universityName, names));
  await logAudit(req.user!.id, "bulk_delete_commissions_by_university", "commission", null as any, { count: names.length, universityNames: names }, req.ip);
  res.json({ deleted: names.length });
});

router.delete("/commissions/:id", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(commissionsTable).where(eq(commissionsTable.id, id));
  await logAudit(req.user!.id, "delete_commission", "commission", id, {}, req.ip);
  res.sendStatus(204);
});

/* ─── SERVICE FEES ───────────────────────────────────────────── */

const SERVICE_FEE_PATCH_FIELDS = [
  "status", "financeStatus", "season", "currency", "totalAmount", "payerType",
  "studentName", "universityName", "isStateUniversity",
  "firstInstallmentAmount", "firstInstallmentPaidAt",
  "secondInstallmentAmount", "secondInstallmentPaidAt",
  "studentId", "agentId", "applicationId", "notes",
];

router.get("/service-fees", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const { studentId, agentId, staffUserId, status, financeStatus, season, page = "1", limit = "100", includeExcluded } = req.query as Record<string, string>;
  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];
  if (studentId) conditions.push(eq(serviceFeesTable.studentId, parseInt(studentId, 10)));
  if (agentId) conditions.push(eq(serviceFeesTable.agentId, parseInt(agentId, 10)));
  if (status) conditions.push(eq(serviceFeesTable.status, status));
  if (financeStatus) conditions.push(eq(serviceFeesTable.financeStatus, financeStatus));
  if (season) conditions.push(eq(serviceFeesTable.season, season));
  if (staffUserId) {
    const staffId = parseInt(staffUserId, 10);
    if (!isNaN(staffId)) {
      conditions.push(sql`(
        ${serviceFeesTable.applicationId} IN (SELECT id FROM applications WHERE assigned_to_id = ${staffId})
        OR (${serviceFeesTable.applicationId} IS NULL AND ${serviceFeesTable.studentId} IN (SELECT id FROM students WHERE assigned_to_id = ${staffId}))
      )`);
    }
  }
  if (includeExcluded !== "true" && includeExcluded !== "1") {
    conditions.push(sql`${serviceFeesTable.financeStatus} != 'excluded'`);
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(serviceFeesTable).where(whereClause);
  const rawServiceData = await db.select().from(serviceFeesTable).where(whereClause).limit(limitNum).offset(offset)
    .orderBy(desc(serviceFeesTable.createdAt));
  const data = await enrichWithNames(rawServiceData);

  const sfSummaryConditions = conditions.filter(c => c !== sql`${serviceFeesTable.financeStatus} != 'excluded'`);
  sfSummaryConditions.push(sql`${serviceFeesTable.financeStatus} != 'excluded'`);
  const activeOnly = await db.select().from(serviceFeesTable).where(
    sfSummaryConditions.length > 0 ? and(...sfSummaryConditions) : undefined
  );
  const summary = {
    totalServiceFees: activeOnly.reduce((s, f) => s + toNum(f.totalAmount), 0),
    totalCollected: activeOnly.reduce((s, f) => s + toNum(f.firstInstallmentPaidAt ? f.firstInstallmentAmount : 0) + toNum(f.secondInstallmentPaidAt ? f.secondInstallmentAmount : 0), 0),
    pendingCount: activeOnly.filter(f => f.status === "pending").length,
    partialCount: activeOnly.filter(f => f.status === "partial").length,
    paidCount: activeOnly.filter(f => f.status === "paid").length,
    potentialCount: activeOnly.filter(f => f.financeStatus === "potential").length,
    confirmedCount: activeOnly.filter(f => f.financeStatus === "confirmed").length,
    potentialTotal: activeOnly.filter(f => f.financeStatus === "potential").reduce((s, f) => s + toNum(f.totalAmount), 0),
    confirmedTotal: activeOnly.filter(f => f.financeStatus === "confirmed").reduce((s, f) => s + toNum(f.totalAmount), 0),
    byCurrency: buildFeesByCurrency(activeOnly),
  };

  res.json({ data, summary, meta: { total: Number(count), page: pageNum, limit: limitNum, totalPages: Math.ceil(Number(count) / limitNum) } });
});

router.post("/service-fees", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const {
    applicationId, studentId, agentId,
    studentName, universityName, isStateUniversity,
    payerType = "student",
    season: bodySeason,
    currency = "USD",
    totalAmount, notes,
  } = req.body;
  const season = bodySeason || (await getCurrentSeason());

  if (!totalAmount) { res.status(400).json({ error: "totalAmount is required" }); return; }
  const total = toNum(totalAmount);
  if (total <= 0) { res.status(400).json({ error: "totalAmount must be positive" }); return; }

  const half = total / 2;

  const [fee] = await db.insert(serviceFeesTable).values({
    applicationId: applicationId || null,
    studentId: studentId || null,
    agentId: agentId || null,
    studentName: studentName || null,
    universityName: universityName || null,
    isStateUniversity: isStateUniversity ?? false,
    payerType,
    season,
    currency,
    totalAmount: String(total),
    firstInstallmentAmount: String(half),
    firstInstallmentPaidAt: null,
    secondInstallmentAmount: String(half),
    secondInstallmentPaidAt: null,
    status: "pending",
    notes: notes || null,
  }).returning();

  await logAudit(req.user!.id, "create_service_fee", "service_fee", fee.id, { studentName, totalAmount }, req.ip);
  res.status(201).json(fee);
});

router.patch("/service-fees/:id", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const updates: Record<string, unknown> = {};
  for (const key of SERVICE_FEE_PATCH_FIELDS) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  for (const key of ["firstInstallmentPaidAt", "secondInstallmentPaidAt"] as const) {
    if (updates[key] === undefined) continue;
    const raw = updates[key];
    if (raw === null || raw === "") {
      updates[key] = null;
      continue;
    }
    const parsed = new Date(raw as string | number | Date);
    if (isNaN(parsed.getTime())) {
      res.status(400).json({ error: `Invalid date for ${key}` });
      return;
    }
    updates[key] = parsed;
  }

  const existingArr = await db.select().from(serviceFeesTable).where(eq(serviceFeesTable.id, id));
  if (!existingArr[0]) { res.status(404).json({ error: "Service fee not found" }); return; }
  const existing = existingArr[0];

  const firstPaid = req.body.firstInstallmentPaidAt !== undefined
    ? !!req.body.firstInstallmentPaidAt
    : !!existing.firstInstallmentPaidAt;
  const secondPaid = req.body.secondInstallmentPaidAt !== undefined
    ? !!req.body.secondInstallmentPaidAt
    : !!existing.secondInstallmentPaidAt;

  if (firstPaid && secondPaid) updates.status = "paid";
  else if (firstPaid || secondPaid) updates.status = "partial";
  else updates.status = "pending";

  if (Object.keys(updates).length === 0) { res.status(400).json({ error: "No valid fields" }); return; }
  const [fee] = await db.update(serviceFeesTable).set(updates).where(eq(serviceFeesTable.id, id)).returning();
  await logAudit(req.user!.id, "update_service_fee", "service_fee", id, updates, req.ip);
  res.json(fee);
});

router.post("/service-fees/bulk-delete", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "ids array is required" });
    return;
  }
  const numericIds = ids.map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id));
  if (numericIds.length === 0) { res.status(400).json({ error: "No valid ids" }); return; }
  await db.delete(serviceFeesTable).where(inArray(serviceFeesTable.id, numericIds));
  await logAudit(req.user!.id, "bulk_delete_service_fees", "service_fee", null as any, { count: numericIds.length, ids: numericIds }, req.ip);
  res.json({ deleted: numericIds.length });
});

router.delete("/service-fees/:id", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(serviceFeesTable).where(eq(serviceFeesTable.id, id));
  await logAudit(req.user!.id, "delete_service_fee", "service_fee", id, {}, req.ip);
  res.sendStatus(204);
});

/* ─── FINANCIAL TRANSACTIONS (collections & agent payments) ── */

router.get("/financial-transactions", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const { commissionId, type, page = "1", limit = "100" } = req.query as Record<string, string>;
  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];
  if (commissionId) conditions.push(eq(financialTransactionsTable.commissionId, parseInt(commissionId, 10)));
  if (type) conditions.push(eq(financialTransactionsTable.type, type));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(financialTransactionsTable).where(whereClause);
  const data = await db.select().from(financialTransactionsTable).where(whereClause)
    .limit(limitNum).offset(offset).orderBy(desc(financialTransactionsTable.createdAt));

  res.json({ data, meta: { total: Number(count), page: pageNum, limit: limitNum, totalPages: Math.ceil(Number(count) / limitNum) } });
});

router.post("/financial-transactions", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const {
    commissionId, type, amount, currency = "USD", transactionDate,
    reference, universityName, agentId, agentName, studentName,
    fileUrl, fileName, notes,
  } = req.body;

  if (!type || amount === undefined || amount === null || !transactionDate) {
    res.status(400).json({ error: "type, amount, and transactionDate are required" });
    return;
  }

  if (!["collection", "agent_payment", "sub_agent_payment"].includes(type)) {
    res.status(400).json({ error: "type must be 'collection', 'agent_payment', or 'sub_agent_payment'" });
    return;
  }

  const parsedAmount = toNum(amount);
  if (parsedAmount <= 0) {
    res.status(400).json({ error: "amount must be a positive number" });
    return;
  }

  const [tx] = await db.insert(financialTransactionsTable).values({
    commissionId: commissionId || null,
    type,
    amount: String(parsedAmount),
    currency,
    transactionDate,
    reference: reference || null,
    universityName: universityName || null,
    agentId: agentId || null,
    agentName: agentName || null,
    studentName: studentName || null,
    fileUrl: fileUrl || null,
    fileName: fileName || null,
    notes: notes || null,
  }).returning();

  if (commissionId && parsedAmount > 0) {
    const [comm] = await db.select().from(commissionsTable).where(eq(commissionsTable.id, parseInt(commissionId, 10)));
    if (comm) {
      const allTxForComm = await db.select().from(financialTransactionsTable)
        .where(eq(financialTransactionsTable.commissionId, parseInt(commissionId, 10)));

      const totalCollected = allTxForComm
        .filter(t => t.type === "collection")
        .reduce((s, t) => s + toNum(t.amount), 0);
      const totalPaid = allTxForComm
        .filter(t => t.type === "agent_payment")
        .reduce((s, t) => s + toNum(t.amount), 0);
      const totalSubAgentPaid = allTxForComm
        .filter(t => t.type === "sub_agent_payment")
        .reduce((s, t) => s + toNum(t.amount), 0);
      const uTotal = toNum(comm.universityCommissionAmount);
      const aTotal = toNum(comm.agentCommissionAmount);
      const saTotal = toNum(comm.subAgentCommissionAmount);

      let newStatus = comm.status;
      const agentFullyPaid = totalPaid >= aTotal;
      const subAgentFullyPaid = saTotal <= 0 || totalSubAgentPaid >= saTotal;
      if (totalCollected >= uTotal && agentFullyPaid && subAgentFullyPaid && uTotal > 0) {
        newStatus = "settled";
      } else if (totalCollected >= uTotal && uTotal > 0) {
        newStatus = "collected_full";
      } else if (totalCollected > 0) {
        newStatus = "collected_partial";
      } else if (comm.status !== "potential") {
        newStatus = "confirmed";
      }

      await db.update(commissionsTable).set({
        universityCollected: String(totalCollected),
        agentPaid: String(totalPaid),
        subAgentPaid: String(totalSubAgentPaid),
        status: newStatus,
      }).where(eq(commissionsTable.id, parseInt(commissionId, 10)));
    }
  }

  await logAudit(req.user!.id, "create_financial_transaction", "financial_transaction", tx.id, { type, amount }, req.ip);

  if (type === "agent_payment" || type === "sub_agent_payment") {
    try {
      await dispatchNotification({
        actorUserId: req.user!.id,
        event: "finance.agent_payout",
        title: "Agent Payout Processed",
        body: `A ${type === "sub_agent_payment" ? "sub-agent" : "agent"} payout of ${parsedAmount} ${currency} has been processed.${agentName ? ` Agent: ${agentName}.` : ""}`,
        actionUrl: `/staff/finance`,
        icon: "BadgeDollarSign",
        templateVars: {
          type,
          amount: String(parsedAmount),
          currency,
          agentName: agentName || "",
        },
      });
    } catch (err) {
      console.error("[FINANCE] agent_payout dispatch error:", err);
    }
  }

  res.status(201).json(tx);
});

router.delete("/financial-transactions/:id", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [tx] = await db.select().from(financialTransactionsTable).where(eq(financialTransactionsTable.id, id));
  if (!tx) { res.status(404).json({ error: "Transaction not found" }); return; }

  await db.delete(financialTransactionsTable).where(eq(financialTransactionsTable.id, id));

  if (tx.commissionId) {
    const [comm] = await db.select().from(commissionsTable).where(eq(commissionsTable.id, tx.commissionId));
    const remaining = await db.select().from(financialTransactionsTable)
      .where(eq(financialTransactionsTable.commissionId, tx.commissionId));
    const totalCollected = remaining.filter(t => t.type === "collection").reduce((s, t) => s + toNum(t.amount), 0);
    const totalPaid = remaining.filter(t => t.type === "agent_payment").reduce((s, t) => s + toNum(t.amount), 0);
    const totalSubAgentPaid = remaining.filter(t => t.type === "sub_agent_payment").reduce((s, t) => s + toNum(t.amount), 0);

    let newStatus = comm?.status || "confirmed";
    if (comm) {
      const uTotal = toNum(comm.universityCommissionAmount);
      const aTotal = toNum(comm.agentCommissionAmount);
      const saTotal = toNum(comm.subAgentCommissionAmount);
      const agentFullyPaid = totalPaid >= aTotal;
      const subAgentFullyPaid = saTotal <= 0 || totalSubAgentPaid >= saTotal;
      if (totalCollected >= uTotal && agentFullyPaid && subAgentFullyPaid && uTotal > 0) {
        newStatus = "settled";
      } else if (totalCollected >= uTotal && uTotal > 0) {
        newStatus = "collected_full";
      } else if (totalCollected > 0) {
        newStatus = "collected_partial";
      } else if (comm.status !== "potential") {
        newStatus = "confirmed";
      }
    }

    await db.update(commissionsTable).set({
      universityCollected: String(totalCollected),
      agentPaid: String(totalPaid),
      subAgentPaid: String(totalSubAgentPaid),
      status: newStatus,
    }).where(eq(commissionsTable.id, tx.commissionId));
  }

  await logAudit(req.user!.id, "delete_financial_transaction", "financial_transaction", id, {}, req.ip);
  res.sendStatus(204);
});

/* ─── UNIVERSITY BREAKDOWN ──────────────────────────────────── */

router.get("/finance/university-breakdown", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const { season } = req.query as Record<string, string>;
  const conditions = [sql`${commissionsTable.status} != 'excluded'`];
  if (season) conditions.push(eq(commissionsTable.season, season));
  const whereClause = and(...conditions);

  const allComm = await db.select().from(commissionsTable).where(whereClause);

  // Build commissionId → staff payout total map (from staffCommissionPayoutsTable, deletedAt IS NULL)
  const uniBreakdownCommIds = allComm.map(c => c.id);
  const staffPayoutsByCommission: Record<number, number> = {};
  if (uniBreakdownCommIds.length > 0) {
    const uniPayoutRows = await db.select({
      commissionId: staffCommissionPayoutsTable.commissionId,
      total: sql<string>`sum(${staffCommissionPayoutsTable.amount})`,
    }).from(staffCommissionPayoutsTable)
      .where(and(
        inArray(staffCommissionPayoutsTable.commissionId, uniBreakdownCommIds),
        isNull(staffCommissionPayoutsTable.deletedAt),
      ))
      .groupBy(staffCommissionPayoutsTable.commissionId);
    for (const row of uniPayoutRows) {
      if (row.commissionId != null) {
        staffPayoutsByCommission[row.commissionId] = toNum(row.total);
      }
    }
  }

  const uniStudentsSeen: Record<string, Set<number>> = {};
  const uniMap: Record<string, {
    universityName: string;
    totalCommission: number;
    totalCollected: number;
    totalRemaining: number;
    totalAgentCommission: number;
    totalAgentPaid: number;
    totalAgentRemaining: number;
    totalSubAgentCommission: number;
    totalSubAgentPaid: number;
    totalStaffCommission: number;
    totalStaffPayouts: number;
    netIncome: number;
    studentCount: number;
    commissionCount: number;
    statuses: Record<string, number>;
    oldestUnpaid: Date | null;
  }> = {};

  for (const c of allComm) {
    const name = c.universityName || "Unknown";
    if (!uniMap[name]) {
      uniMap[name] = {
        universityName: name,
        totalCommission: 0, totalCollected: 0, totalRemaining: 0,
        totalAgentCommission: 0, totalAgentPaid: 0, totalAgentRemaining: 0,
        totalSubAgentCommission: 0, totalSubAgentPaid: 0,
        totalStaffCommission: 0, totalStaffPayouts: 0,
        netIncome: 0, studentCount: 0, commissionCount: 0,
        statuses: {}, oldestUnpaid: null,
      };
    }
    const u = uniMap[name];
    const uAmt = toNum(c.universityCommissionAmount);
    const uColl = toNum(c.universityCollected);
    const aAmt = toNum(c.agentCommissionAmount);
    const aPaid = toNum(c.agentPaid);
    const saAmt = toNum(c.subAgentCommissionAmount);
    const saPaid = toNum(c.subAgentPaid);
    const staffAmt = toNum(c.staffCommissionAmount);
    u.totalCommission += uAmt;
    u.totalCollected += uColl;
    u.totalRemaining += uAmt - uColl;
    u.totalAgentCommission += aAmt;
    u.totalAgentPaid += aPaid;
    u.totalAgentRemaining += aAmt - aPaid;
    u.totalSubAgentCommission += saAmt;
    u.totalSubAgentPaid += saPaid;
    // Only confirmed (non-potential) rows count toward staff commission totals
    if (c.status !== "potential") {
      u.totalStaffCommission += staffAmt;
      u.totalStaffPayouts += staffPayoutsByCommission[c.id] ?? 0;
    }
    // Net Income per commission: University − Agent − SubAgent − Staff
    u.netIncome += uAmt - aAmt - saAmt - staffAmt;
    if (c.studentId != null && !uniStudentsSeen[name]) uniStudentsSeen[name] = new Set();
    if (c.studentId != null && !uniStudentsSeen[name].has(c.studentId)) {
      uniStudentsSeen[name].add(c.studentId);
    }
    u.commissionCount++;
    u.statuses[c.status] = (u.statuses[c.status] || 0) + 1;

    if (uAmt > uColl && c.confirmedAt) {
      if (!u.oldestUnpaid || c.confirmedAt < u.oldestUnpaid) {
        u.oldestUnpaid = c.confirmedAt;
      }
    }
  }

  const students = new Set<string>();
  for (const c of allComm) {
    if (c.studentName) students.add(`${c.universityName}::${c.studentName}`);
  }
  for (const key of Object.keys(uniMap)) {
    uniMap[key].studentCount = [...students].filter(s => s.startsWith(key + "::")).length;
    // netIncome is already accumulated per-commission above (uni - agent - subAgent - staffCommissionAmount)
  }

  // Add per-row staffPayable so consumers don't need to derive it client-side
  const breakdown = Object.values(uniMap).map(u => ({
    ...u,
    staffPayable: Math.max(0, u.totalStaffCommission - u.totalStaffPayouts),
  })).sort((a, b) => b.totalCommission - a.totalCommission);

  const uniTotalStaffCommission = breakdown.reduce((s, u) => s + u.totalStaffCommission, 0);
  const uniTotalStaffPayouts = breakdown.reduce((s, u) => s + u.totalStaffPayouts, 0);
  const totals = {
    totalCommission: breakdown.reduce((s, u) => s + u.totalCommission, 0),
    totalCollected: breakdown.reduce((s, u) => s + u.totalCollected, 0),
    totalRemaining: breakdown.reduce((s, u) => s + u.totalRemaining, 0),
    totalAgentCommission: breakdown.reduce((s, u) => s + u.totalAgentCommission, 0),
    totalAgentPaid: breakdown.reduce((s, u) => s + u.totalAgentPaid, 0),
    totalSubAgentCommission: breakdown.reduce((s, u) => s + u.totalSubAgentCommission, 0),
    totalSubAgentPaid: breakdown.reduce((s, u) => s + u.totalSubAgentPaid, 0),
    totalStaffCommission: uniTotalStaffCommission,
    totalStaffPayouts: uniTotalStaffPayouts,
    staffPayable: Math.max(0, uniTotalStaffCommission - uniTotalStaffPayouts),
    totalNetIncome: breakdown.reduce((s, u) => s + u.netIncome, 0),
    universityCount: breakdown.length,
  };

  res.json({ breakdown, totals });
});

/* ─── FINANCE SUMMARY ────────────────────────────────────────── */

router.get("/finance/summary", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const { season } = req.query as Record<string, string>;
  const conditions = [sql`${commissionsTable.status} != 'excluded'`];
  const sfConditions = [sql`${serviceFeesTable.financeStatus} != 'excluded'`];
  if (season) {
    conditions.push(eq(commissionsTable.season, season));
    sfConditions.push(eq(serviceFeesTable.season, season));
  }
  const whereComm = and(...conditions);
  const whereSF = and(...sfConditions);

  const commissions = await db.select().from(commissionsTable).where(whereComm);
  const fees = await db.select().from(serviceFeesTable).where(whereSF);

  // Aggregate staff commission payouts for these commissions (deletedAt IS NULL)
  const allCommissionIds = commissions.map(c => c.id);
  const staffSummaryPayoutsByCurrency: Record<string, number> = {};
  let summaryTotalStaffPayouts = 0;
  if (allCommissionIds.length > 0) {
    const payoutRows = await db.select({
      currency: staffCommissionPayoutsTable.currency,
      total: sql<string>`sum(${staffCommissionPayoutsTable.amount})`,
    }).from(staffCommissionPayoutsTable)
      .where(and(
        inArray(staffCommissionPayoutsTable.commissionId, allCommissionIds),
        isNull(staffCommissionPayoutsTable.deletedAt),
      ))
      .groupBy(staffCommissionPayoutsTable.currency);
    for (const row of payoutRows) {
      const cur = normCurrency(row.currency);
      staffSummaryPayoutsByCurrency[cur] = (staffSummaryPayoutsByCurrency[cur] || 0) + toNum(row.total);
      summaryTotalStaffPayouts += toNum(row.total);
    }
  }

  const confirmedCommissions = commissions.filter(c => c.status === "confirmed" || c.status === "collected_partial" || c.status === "collected_full" || c.status === "settled");
  const totalConfirmedCommission = confirmedCommissions.reduce((s, c) => s + toNum(c.universityCommissionAmount), 0);
  const totalOffsetUsed = commissions.reduce((s, c) => s + toNum(c.offsetAmount), 0);
  const availableOffset = Math.min(totalConfirmedCommission * 0.7, totalConfirmedCommission - totalOffsetUsed);

  const overdueItems = commissions.filter(c => {
    if (c.status === "potential") return false;
    const uAmt = toNum(c.universityCommissionAmount);
    const uColl = toNum(c.universityCollected);
    if (uColl >= uAmt) return false;
    if (!c.confirmedAt) return false;
    const confirmedDate = new Date(c.confirmedAt);
    const daysSince = (Date.now() - confirmedDate.getTime()) / (1000 * 60 * 60 * 24);
    return daysSince > 90;
  });

  const potentialComms = commissions.filter(c => c.status === "potential");
  const confirmedComms = commissions.filter(c => c.status !== "potential");
  const paidComms = commissions.filter(c => c.status === "collected_partial" || c.status === "collected_full" || c.status === "settled");

  // Only confirmed (non-potential) rows count toward staff commission totals
  const summaryTotalStaffCommission = commissions.filter(c => c.status !== "potential").reduce((s, c) => s + toNum(c.staffCommissionAmount), 0);

  // Build byCurrency and enrich each bucket with staffPayable
  const summaryByCurrency = buildCommissionsByCurrency(commissions);
  for (const [cur, bucket] of Object.entries(summaryByCurrency)) {
    bucket.totalStaffPayouts = staffSummaryPayoutsByCurrency[cur] ?? 0;
    bucket.staffPayable = Math.max(0, bucket.totalStaffCommission - (staffSummaryPayoutsByCurrency[cur] ?? 0));
  }

  res.json({
    season: season || "all",
    commissions: {
      potential: potentialComms.length,
      confirmed: confirmedComms.length,
      totalUniversityCommission: commissions.reduce((s, c) => s + toNum(c.universityCommissionAmount), 0),
      totalUniversityCollected: commissions.reduce((s, c) => s + toNum(c.universityCollected), 0),
      totalUniversityPending: commissions.reduce((s, c) => s + (toNum(c.universityCommissionAmount) - toNum(c.universityCollected)), 0),
      totalAgentCommission: commissions.reduce((s, c) => s + toNum(c.agentCommissionAmount), 0),
      totalAgentPaid: commissions.reduce((s, c) => s + toNum(c.agentPaid), 0),
      totalAgentPending: commissions.reduce((s, c) => s + (toNum(c.agentCommissionAmount) - toNum(c.agentPaid)), 0),
      totalSubAgentCommission: commissions.reduce((s, c) => s + toNum(c.subAgentCommissionAmount), 0),
      totalSubAgentPaid: commissions.reduce((s, c) => s + toNum(c.subAgentPaid), 0),
      totalSubAgentPending: commissions.reduce((s, c) => s + (toNum(c.subAgentCommissionAmount) - toNum(c.subAgentPaid)), 0),
      // Only confirmed rows
      totalStaffCommission: summaryTotalStaffCommission,
      totalStaffPayouts: summaryTotalStaffPayouts,
      staffPayable: Math.max(0, summaryTotalStaffCommission - summaryTotalStaffPayouts),
      // Net Income = University − Agent − SubAgent − Staff
      totalNetAgency: commissions.reduce((s, c) => s + (toNum(c.universityCommissionAmount) - toNum(c.agentCommissionAmount) - toNum(c.subAgentCommissionAmount) - toNum(c.staffCommissionAmount)), 0),
      overdueCount: overdueItems.length,
      overdueAmount: overdueItems.reduce((s, c) => s + (toNum(c.universityCommissionAmount) - toNum(c.universityCollected)), 0),
      potentialUniversityCommission: potentialComms.reduce((s, c) => s + toNum(c.universityCommissionAmount), 0),
      potentialAgentCommission: potentialComms.reduce((s, c) => s + toNum(c.agentCommissionAmount), 0),
      confirmedUniversityCommission: confirmedComms.reduce((s, c) => s + toNum(c.universityCommissionAmount), 0),
      confirmedAgentCommission: confirmedComms.reduce((s, c) => s + toNum(c.agentCommissionAmount), 0),
      paidToAgents: commissions.reduce((s, c) => s + toNum(c.agentPaid), 0),
      paidToSubAgents: commissions.reduce((s, c) => s + toNum(c.subAgentPaid), 0),
      collectedFromUniversities: commissions.reduce((s, c) => s + toNum(c.universityCollected), 0),
      pendingToCollect: confirmedComms.reduce((s, c) => s + (toNum(c.universityCommissionAmount) - toNum(c.universityCollected)), 0),
      pendingToPay: confirmedComms.reduce((s, c) => s + (toNum(c.agentCommissionAmount) - toNum(c.agentPaid)), 0),
      pendingToPaySubAgents: confirmedComms.reduce((s, c) => s + (toNum(c.subAgentCommissionAmount) - toNum(c.subAgentPaid)), 0),
      byCurrency: summaryByCurrency,
    },
    serviceFees: {
      total: fees.reduce((s, f) => s + toNum(f.totalAmount), 0),
      collected: fees.reduce((s, f) => {
        return s + toNum(f.firstInstallmentPaidAt ? f.firstInstallmentAmount : 0) + toNum(f.secondInstallmentPaidAt ? f.secondInstallmentAmount : 0);
      }, 0),
      pending: fees.filter(f => f.status === "pending").length,
      partial: fees.filter(f => f.status === "partial").length,
      paid: fees.filter(f => f.status === "paid").length,
      potentialCount: fees.filter(f => f.financeStatus === "potential").length,
      confirmedCount: fees.filter(f => f.financeStatus === "confirmed").length,
      potentialTotal: fees.filter(f => f.financeStatus === "potential").reduce((s, f) => s + toNum(f.totalAmount), 0),
      confirmedTotal: fees.filter(f => f.financeStatus === "confirmed").reduce((s, f) => s + toNum(f.totalAmount), 0),
      byCurrency: buildFeesByCurrency(fees),
    },
    offset: {
      totalConfirmedCommission,
      totalOffsetUsed,
      availableForOffset: Math.max(0, availableOffset),
      maxOffsetRate: 70,
    },
  });
});

/* ─── INVOICES (kept for backward compat) ────────────────────── */

/* ─── STAFF BONUSES ─────────────────────────────────────────── */

router.get("/finance/staff-bonuses", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const { staffUserId, season } = req.query as Record<string, string>;
  const [settingsRow] = await db.select({ directStudentEnrollmentBonusRate: settingsTable.directStudentEnrollmentBonusRate }).from(settingsTable);
  const rate = Number(settingsRow?.directStudentEnrollmentBonusRate ?? 0) || 0;
  if (!staffUserId) {
    // Domain: all direct/no-agent students (regardless of current status — to include historical paid)
    const directBaseConds: any[] = [
      eq(studentsTable.originType, "direct"),
      isNull(studentsTable.agentId),
      isNull(studentsTable.deletedAt),
    ];
    if (season) directBaseConds.push(eq(studentsTable.season, season));
    const allDirectStudents = await db.select({ id: studentsTable.id })
      .from(studentsTable)
      .where(and(...directBaseConds));
    const allDirectIds = allDirectStudents.map(s => s.id);

    // totalPaid: paid commissions scoped to direct/no-agent domain only
    let paidForDirectTotal = 0;
    if (allDirectIds.length > 0) {
      const [directPaidRow] = await db.select({ total: sql<string>`coalesce(sum(amount::numeric), 0)` })
        .from(staffCommissionsTable)
        .where(and(eq(staffCommissionsTable.status, "paid"), inArray(staffCommissionsTable.studentId, allDirectIds)));
      paidForDirectTotal = toNum(directPaidRow?.total);
    }

    // totalPending: currently enrolled direct students × rate − historically-paid (rate changes reprice unpaid)
    const allEnrolledDirect = await db.select({ id: studentsTable.id })
      .from(studentsTable)
      .where(and(...directBaseConds, eq(studentsTable.status, "enrolled")));
    const totalPending = Math.max(0, allEnrolledDirect.length * rate - paidForDirectTotal);

    res.json({ rate, totalPaid: paidForDirectTotal, totalPending, perStaff: [] });
    return;
  }
  const staffId = parseInt(staffUserId, 10);
  if (isNaN(staffId)) { res.status(400).json({ error: "Invalid staffUserId" }); return; }
  const stdConds: any[] = [
    eq(studentsTable.assignedToId, staffId),
    eq(studentsTable.originType, "direct"),
    isNull(studentsTable.agentId),
    isNull(studentsTable.deletedAt),
  ];
  if (season) stdConds.push(eq(studentsTable.season, season));
  const directStudents = await db.select({
    id: studentsTable.id, status: studentsTable.status,
    firstName: studentsTable.firstName, lastName: studentsTable.lastName,
  }).from(studentsTable).where(and(...stdConds));
  const directIds = directStudents.map(s => s.id);
  let paidComms: any[] = [];
  if (directIds.length > 0) {
    paidComms = await db.select().from(staffCommissionsTable).where(
      and(eq(staffCommissionsTable.userId, staffId), eq(staffCommissionsTable.status, "paid"), inArray(staffCommissionsTable.studentId, directIds))
    );
  }
  const paidStudentIds = new Set(paidComms.map(c => c.studentId).filter(Boolean));
  const paidTotal = paidComms.reduce((s, c) => s + toNum(c.amount), 0);
  // Separate enrolled vs potential, independent of paid status
  const allEnrolled = directStudents.filter(s => s.status === "enrolled");
  const allPotential = directStudents.filter(s => s.status !== "enrolled");
  // Confirmed/potential buckets: exclude paid students from counts (they've been settled)
  const confirmedUnpaid = allEnrolled.filter(s => !paidStudentIds.has(s.id));
  const potentialUnpaid = allPotential.filter(s => !paidStudentIds.has(s.id));
  // Pending amount: total eligible earned (ALL enrolled × rate) minus historically-paid amounts
  // This ensures rate changes reprice the unpaid portion dynamically
  const pendingAmount = Math.max(0, allEnrolled.length * rate - paidTotal);
  res.json({
    staffUserId: staffId, rate,
    potential: { count: potentialUnpaid.length, amount: potentialUnpaid.length * rate },
    confirmed: { count: confirmedUnpaid.length, amount: confirmedUnpaid.length * rate },
    paid: { count: paidComms.length, amount: paidTotal },
    pending: { count: confirmedUnpaid.length, amount: pendingAmount },
    directStudentCount: directStudents.length,
  });
});

router.get("/invoices", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const { studentId, status, page = "1", limit = "20" } = req.query as Record<string, string>;
  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const offset = (pageNum - 1) * limitNum;
  const conditions = [];
  if (studentId) conditions.push(eq(invoicesTable.studentId, parseInt(studentId, 10)));
  if (status) conditions.push(eq(invoicesTable.status, status));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(invoicesTable).where(whereClause);
  const data = await db.select().from(invoicesTable).where(whereClause).limit(limitNum).offset(offset).orderBy(desc(invoicesTable.createdAt));
  res.json({ data, meta: { total: Number(count), page: pageNum, limit: limitNum, totalPages: Math.ceil(Number(count) / limitNum) } });
});

router.post("/invoices", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const { studentId, amount, currency = "USD", status = "draft", dueDate, notes } = req.body;
  if (!studentId || !amount) { res.status(400).json({ error: "studentId and amount are required" }); return; }
  const [invoice] = await db.insert(invoicesTable).values({
    studentId, amount: String(amount), currency, status, invoiceNumber: generateInvoiceNumber(),
    dueDate: dueDate || null, notes: notes || null,
  }).returning();
  await logAudit(req.user!.id, "create_invoice", "invoice", invoice.id, { studentId, amount }, req.ip);
  res.status(201).json(invoice);
});

router.patch("/invoices/:id", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const FIELDS = ["status", "amount", "currency", "dueDate", "paidAt", "notes"];
  const updates: Record<string, unknown> = {};
  for (const key of FIELDS) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (Object.keys(updates).length === 0) { res.status(400).json({ error: "No valid fields" }); return; }
  const [invoice] = await db.update(invoicesTable).set(updates).where(eq(invoicesTable.id, id)).returning();
  if (!invoice) { res.status(404).json({ error: "Invoice not found" }); return; }
  res.json(invoice);
});

router.get("/agent/finance-summary", requireAuth, requireRole(...AGENT_ROLES), requireAgentStaffPermission("commissions"), async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const userRole = req.user!.role;
  const agent = await getAgentRecord(userId, userRole);
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
  const agentId = agent.id;
  const isSubAgent = userRole === "sub_agent" || !!agent.parentAgentId;

  if (isSubAgent) {
    const commissions = await db.select().from(commissionsTable).where(
      and(eq(commissionsTable.subAgentId, agentId), sql`${commissionsTable.status} != 'excluded'`)
    );

    const commSummary = {
      potential: commissions.filter(c => c.status === "potential").reduce((s, c) => s + toNum(c.subAgentCommissionAmount), 0),
      confirmed: commissions.filter(c => ["confirmed", "collected_partial", "collected_full"].includes(c.status)).reduce((s, c) => s + toNum(c.subAgentCommissionAmount), 0),
      paid: commissions.reduce((s, c) => s + toNum(c.subAgentPaid), 0),
      pending: commissions.filter(c => !["potential"].includes(c.status)).reduce((s, c) => s + (toNum(c.subAgentCommissionAmount) - toNum(c.subAgentPaid)), 0),
    };

    res.json({
      commissions: { ...commSummary, byCurrency: buildAgentCommByCurrency(commissions, true) },
      serviceFees: { potential: 0, confirmed: 0, paid: 0, pending: 0, byCurrency: {} },
    });
    return;
  }

  const commissions = await db.select().from(commissionsTable).where(
    and(eq(commissionsTable.agentId, agentId), sql`${commissionsTable.status} != 'excluded'`)
  );
  const fees = await db.select().from(serviceFeesTable).where(
    and(eq(serviceFeesTable.agentId, agentId), sql`${serviceFeesTable.financeStatus} != 'excluded'`)
  );

  const commSummary = {
    potential: commissions.filter(c => c.status === "potential").reduce((s, c) => s + toNum(c.agentCommissionAmount), 0),
    confirmed: commissions.filter(c => ["confirmed", "collected_partial", "collected_full"].includes(c.status)).reduce((s, c) => s + toNum(c.agentCommissionAmount), 0),
    paid: commissions.reduce((s, c) => s + toNum(c.agentPaid), 0),
    pending: commissions.filter(c => !["potential"].includes(c.status)).reduce((s, c) => s + (toNum(c.agentCommissionAmount) - toNum(c.agentPaid)), 0),
  };

  const feeSummary = {
    potential: fees.filter(f => f.financeStatus === "potential").reduce((s, f) => s + toNum(f.totalAmount), 0),
    confirmed: fees.filter(f => f.financeStatus === "confirmed").reduce((s, f) => s + toNum(f.totalAmount), 0),
    paid: fees.reduce((s, f) => s + toNum(f.firstInstallmentPaidAt ? f.firstInstallmentAmount : 0) + toNum(f.secondInstallmentPaidAt ? f.secondInstallmentAmount : 0), 0),
    pending: fees.filter(f => f.status !== "paid").reduce((s, f) => {
      const collected = toNum(f.firstInstallmentPaidAt ? f.firstInstallmentAmount : 0) + toNum(f.secondInstallmentPaidAt ? f.secondInstallmentAmount : 0);
      return s + (toNum(f.totalAmount) - collected);
    }, 0),
  };

  res.json({
    commissions: { ...commSummary, byCurrency: buildAgentCommByCurrency(commissions, false) },
    serviceFees: { ...feeSummary, byCurrency: buildAgentFeeByCurrency(fees) },
  });
});

router.get("/agent/commissions", requireAuth, requireRole(...AGENT_ROLES), requireAgentStaffPermission("commissions"), async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const userRole = req.user!.role;
  const agent = await getAgentRecord(userId, userRole);
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
  const isSubAgent = userRole === "sub_agent" || !!agent.parentAgentId;

  const { page = "1", limit = "50", currency } = req.query as Record<string, string>;
  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10)));
  const offset = (pageNum - 1) * limitNum;

  const conds = [
    isSubAgent ? eq(commissionsTable.subAgentId, agent.id) : eq(commissionsTable.agentId, agent.id),
    sql`${commissionsTable.status} != 'excluded'`,
  ];
  if (currency && /^[A-Za-z]{2,5}$/.test(currency)) {
    conds.push(eq(commissionsTable.currency, currency.toUpperCase()));
  }
  const whereClause = and(...conds);
  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(commissionsTable).where(whereClause);
  const data = await db.select().from(commissionsTable).where(whereClause)
    .orderBy(desc(commissionsTable.createdAt)).limit(limitNum).offset(offset);
  const allRows = await db.select().from(commissionsTable).where(and(
    isSubAgent ? eq(commissionsTable.subAgentId, agent.id) : eq(commissionsTable.agentId, agent.id),
    sql`${commissionsTable.status} != 'excluded'`,
  ));
  const byCurrency = buildAgentCommByCurrency(allRows, isSubAgent);

  res.json({ data, isSubAgent, byCurrency, meta: { total: Number(count), page: pageNum, limit: limitNum, totalPages: Math.ceil(Number(count) / limitNum) } });
});

router.get("/agent/service-fees", requireAuth, requireRole(...AGENT_ROLES), requireAgentStaffPermission("commissions"), async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const userRole = req.user!.role;
  const agent = await getAgentRecord(userId, userRole);
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }

  const { page = "1", limit = "50", currency } = req.query as Record<string, string>;
  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10)));
  const offset = (pageNum - 1) * limitNum;

  const conds = [eq(serviceFeesTable.agentId, agent.id), sql`${serviceFeesTable.financeStatus} != 'excluded'`];
  if (currency && /^[A-Za-z]{2,5}$/.test(currency)) {
    conds.push(eq(serviceFeesTable.currency, currency.toUpperCase()));
  }
  const whereClause = and(...conds);
  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(serviceFeesTable).where(whereClause);
  const data = await db.select().from(serviceFeesTable).where(whereClause)
    .orderBy(desc(serviceFeesTable.createdAt)).limit(limitNum).offset(offset);
  const allRows = await db.select().from(serviceFeesTable).where(and(
    eq(serviceFeesTable.agentId, agent.id), sql`${serviceFeesTable.financeStatus} != 'excluded'`,
  ));
  const byCurrency = buildAgentFeeByCurrency(allRows);

  res.json({ data, byCurrency, meta: { total: Number(count), page: pageNum, limit: limitNum, totalPages: Math.ceil(Number(count) / limitNum) } });
});

/* ─── EXCEL EXPORT HELPERS & ENDPOINTS ──────────────────────── */

function sendXlsx(res: any, data: Record<string, any>[], filename: string, sheetName: string) {
  const empty = data.length === 0;
  const rows = empty ? [{ "No Data": "No records found" }] : data;
  const ws = XLSX.utils.json_to_sheet(rows);
  const colWidths = Object.keys(rows[0] || {}).map(key => {
    const maxLen = Math.max(key.length, ...rows.map(row => String(row[key] ?? "").length));
    return { wch: Math.min(maxLen + 2, 50) };
  });
  ws["!cols"] = colWidths;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(Buffer.from(buf));
}

function xlsxDate(v: any): string {
  if (!v) return "";
  const d = typeof v === "string" ? new Date(v) : v;
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB");
}

router.get("/finance/export/commissions", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const { status, season, search, currency } = req.query as Record<string, string>;
  const conditions: any[] = [sql`${commissionsTable.status} != 'excluded'`];
  if (status && status !== "all") conditions.push(eq(commissionsTable.status, status));
  if (season) conditions.push(eq(commissionsTable.season, season));
  if (search) {
    conditions.push(sql`(${commissionsTable.studentName} ilike ${"%" + search + "%"} OR ${commissionsTable.universityName} ilike ${"%" + search + "%"})`);
  }
  if (currency && currency !== "all" && /^[A-Za-z]{2,5}$/.test(currency)) {
    conditions.push(eq(commissionsTable.currency, currency.toUpperCase()));
  }

  const rows = await db.select().from(commissionsTable).where(and(...conditions)).orderBy(desc(commissionsTable.createdAt));

  const enrichedExportRows = await enrichWithNames(rows);
  const data = enrichedExportRows.map(c => ({
    "Student": c.studentName || "",
    "Agent": c.agentName || "",
    "Staff": c.staffName || "",
    "University": c.universityName || "",
    "Program": c.programName || "",
    "Season": c.season || "",
    "Currency": c.currency || "",
    "Program Fee": c.programFee ?? "",
    "Univ. Commission Rate (%)": c.universityCommissionRate ?? "",
    "Univ. Commission": c.universityCommissionAmount ?? "",
    "Collected from Univ.": c.universityCollected ?? "",
    "Agent Rate (%)": c.agentCommissionRate ?? "",
    "Agent Commission": c.agentCommissionAmount ?? "",
    "Agent Paid": c.agentPaid ?? "",
    "Sub-Agent Commission": c.subAgentCommissionAmount ?? "",
    "Sub-Agent Paid": c.subAgentPaid ?? "",
    "Staff Commission": c.staffCommissionAmount ?? "",
    "Net Income": (toNum(c.universityCommissionAmount) - toNum(c.agentCommissionAmount) - toNum(c.subAgentCommissionAmount) - toNum(c.staffCommissionAmount)).toFixed(2),
    "Status": c.status || "",
    "State University": c.isStateUniversity ? "Yes" : "No",
    "Offset Amount": c.offsetAmount ?? "",
    "Notes": c.notes || "",
    "Confirmed At": xlsxDate(c.confirmedAt),
    "Created": xlsxDate(c.createdAt),
  }));

  sendXlsx(res, data, `commissions_${season || "all"}_${new Date().toISOString().slice(0, 10)}.xlsx`, "Commissions");
});

router.get("/finance/export/university-breakdown", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const { season, currency } = req.query as Record<string, string>;
  const conditions: any[] = [sql`${commissionsTable.status} != 'excluded'`];
  if (season) conditions.push(eq(commissionsTable.season, season));
  if (currency && currency !== "all" && /^[A-Za-z]{2,5}$/.test(currency)) {
    conditions.push(eq(commissionsTable.currency, currency.toUpperCase()));
  }

  const allComm = await db.select().from(commissionsTable).where(and(...conditions));

  const uniMap: Record<string, {
    universityName: string;
    commissionCount: number;
    studentCount: number;
    totalCommission: number;
    totalCollected: number;
    totalRemaining: number;
    totalAgentCommission: number;
    totalAgentPaid: number;
    totalSubAgentCommission: number;
    totalStaffCommission: number;
    netIncome: number;
  }> = {};

  const studentKeys = new Set<string>();
  for (const c of allComm) {
    const name = c.universityName || "Unknown";
    if (!uniMap[name]) {
      uniMap[name] = { universityName: name, commissionCount: 0, studentCount: 0, totalCommission: 0, totalCollected: 0, totalRemaining: 0, totalAgentCommission: 0, totalAgentPaid: 0, totalSubAgentCommission: 0, totalStaffCommission: 0, netIncome: 0 };
    }
    const u = uniMap[name];
    const uAmt = toNum(c.universityCommissionAmount);
    const uColl = toNum(c.universityCollected);
    const aAmt = toNum(c.agentCommissionAmount);
    const aPaid = toNum(c.agentPaid);
    const saAmt = toNum(c.subAgentCommissionAmount);
    const staffAmt = toNum(c.staffCommissionAmount);
    u.totalCommission += uAmt;
    u.totalCollected += uColl;
    u.totalRemaining += uAmt - uColl;
    u.totalAgentCommission += aAmt;
    u.totalAgentPaid += aPaid;
    u.totalSubAgentCommission += saAmt;
    u.totalStaffCommission += staffAmt;
    // Net Income = University − Agent − SubAgent − Staff
    u.netIncome += uAmt - aAmt - saAmt - staffAmt;
    u.commissionCount++;
    if (c.studentName) {
      const key = `${name}::${c.studentName}`;
      if (!studentKeys.has(key)) { studentKeys.add(key); u.studentCount++; }
    }
  }

  const breakdown = Object.values(uniMap).sort((a, b) => b.totalCommission - a.totalCommission);

  const data = breakdown.map(u => ({
    "University": u.universityName,
    "Commissions": u.commissionCount,
    "Students": u.studentCount,
    "Total Commission": u.totalCommission.toFixed(2),
    "Collected": u.totalCollected.toFixed(2),
    "Remaining": u.totalRemaining.toFixed(2),
    "Agent Commission": u.totalAgentCommission.toFixed(2),
    "Agent Paid": u.totalAgentPaid.toFixed(2),
    "Sub-Agent Commission": u.totalSubAgentCommission.toFixed(2),
    "Staff Commission": u.totalStaffCommission.toFixed(2),
    "Net Income": u.netIncome.toFixed(2),
    "Collection %": u.totalCommission > 0 ? Math.round((u.totalCollected / u.totalCommission) * 100) + "%" : "0%",
  }));

  sendXlsx(res, data, `university_breakdown_${season || "all"}_${new Date().toISOString().slice(0, 10)}.xlsx`, "University Breakdown");
});

router.get("/finance/export/service-fees", requireAuth, requireRole(...FINANCE_ROLES), async (req, res): Promise<void> => {
  const { season, status, financeStatus, currency } = req.query as Record<string, string>;
  const conditions: any[] = [sql`${serviceFeesTable.financeStatus} != 'excluded'`];
  if (season) conditions.push(eq(serviceFeesTable.season, season));
  if (status && status !== "all") conditions.push(eq(serviceFeesTable.status, status));
  if (financeStatus && financeStatus !== "all") conditions.push(eq(serviceFeesTable.financeStatus, financeStatus));
  if (currency && currency !== "all" && /^[A-Za-z]{2,5}$/.test(currency)) {
    conditions.push(eq(serviceFeesTable.currency, currency.toUpperCase()));
  }

  const rawFeeRows = await db.select().from(serviceFeesTable).where(and(...conditions)).orderBy(desc(serviceFeesTable.createdAt));
  const rows = await enrichWithNames(rawFeeRows);

  const data = rows.map(f => ({
    "Student": f.studentName || "",
    "University": f.universityName || "",
    "Agent": f.agentName || "",
    "Staff": f.staffName || "",
    "Payer": f.payerType || "",
    "Season": f.season || "",
    "Currency": f.currency || "",
    "Total Amount": f.totalAmount ?? "",
    "1st Installment": f.firstInstallmentAmount ?? "",
    "1st Paid At": xlsxDate(f.firstInstallmentPaidAt),
    "2nd Installment": f.secondInstallmentAmount ?? "",
    "2nd Paid At": xlsxDate(f.secondInstallmentPaidAt),
    "Status": f.status || "",
    "Finance Status": f.financeStatus || "",
    "State University": f.isStateUniversity ? "Yes" : "No",
    "Notes": f.notes || "",
    "Created": xlsxDate(f.createdAt),
  }));

  sendXlsx(res, data, `service_fees_${season || "all"}_${new Date().toISOString().slice(0, 10)}.xlsx`, "Service Fees");
});

export default router;
