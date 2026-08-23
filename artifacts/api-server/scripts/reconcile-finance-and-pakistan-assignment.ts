/**
 * One-time guarded reconciliation for the 2026-08-16 portal-finance and +92
 * assignment incident. Dry-run is the default; production apply requires all
 * expected counts so a changed dataset aborts rather than widening scope.
 *
 *   tsx scripts/reconcile-finance-and-pakistan-assignment.ts
 *   tsx scripts/reconcile-finance-and-pakistan-assignment.ts \
 *     --apply --expected-finance=60 --expected-leads=20 --rule-id=8
 */
import {
  auditLogsTable,
  commissionsTable,
  db,
  leadAssignmentRulesTable,
  leadsTable,
} from "@workspace/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { syncApplicationFinance } from "@workspace/portal-runner";
import {
  applyLeadAssignmentRules,
  findMatchingLeadAssignmentRule,
} from "../src/lib/leadAssignment.js";

function argNumber(name: string): number | null {
  const prefix = `--${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (raw == null) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid --${name}`);
  return value;
}

const apply = process.argv.includes("--apply");
const expectedFinance = argNumber("expected-finance");
const expectedLeads = argNumber("expected-leads");
const ruleId = argNumber("rule-id") ?? 8;

type IdRow = { id: number };

async function financeCandidateIds(): Promise<number[]> {
  const result = await db.execute(sql`
    WITH stage_policy AS (
      SELECT key,
        CASE
          WHEN commission_finance_status IN ('potential','confirmed','excluded') THEN commission_finance_status
          WHEN variant='won' THEN 'confirmed'
          WHEN variant IN ('lost','none_finance') THEN 'excluded'
          ELSE 'potential'
        END AS target_status
      FROM pipeline_stages
      WHERE entity_type='application'
    )
    SELECT DISTINCT a.id
    FROM applications a
    LEFT JOIN stage_policy sp ON sp.key=a.stage
    LEFT JOIN commissions c ON c.application_id=a.id
    WHERE a.deleted_at IS NULL
      AND (
        (
          a.created_source='automation'
          AND (
            c.id IS NULL
            OR (
              c.status IS DISTINCT FROM COALESCE(sp.target_status,'potential')
              AND c.status NOT IN ('collected_partial','collected_full','settled')
            )
          )
        )
        OR (
          COALESCE(sp.target_status,'potential')='excluded'
          AND c.id IS NOT NULL
          AND c.status NOT IN ('excluded','collected_partial','collected_full','settled')
        )
      )
    ORDER BY a.id
  `);
  return (result.rows as IdRow[]).map((row) => Number(row.id));
}

async function pakistanCandidates() {
  const rows = await db.select().from(leadsTable)
    .where(and(
      isNull(leadsTable.deletedAt),
      isNull(leadsTable.assignedToId),
      sql`regexp_replace(COALESCE(NULLIF(${leadsTable.phoneE164}, ''), ${leadsTable.phone}, ''), '[^0-9]', '', 'g') LIKE ANY (ARRAY['92%', '0092%'])`,
    ))
    .orderBy(asc(leadsTable.id));

  const safe: typeof rows = [];
  const excluded: Array<{ id: number; matchingRuleId: number | null }> = [];
  for (const lead of rows) {
    const matchingRule = await findMatchingLeadAssignmentRule(lead);
    if (matchingRule?.id === ruleId) safe.push(lead);
    else excluded.push({ id: lead.id, matchingRuleId: matchingRule?.id ?? null });
  }
  return { all: rows, safe, excluded };
}

async function verifyFinance() {
  const rows = await db.select({
    applicationId: commissionsTable.applicationId,
    status: commissionsTable.status,
    amount: commissionsTable.universityCommissionAmount,
  }).from(commissionsTable).where(sql`${commissionsTable.applicationId} IN (3322, 3325)`);
  const byApp = new Map(rows.map((row) => [row.applicationId, row]));
  if (byApp.get(3322)?.status !== "excluded") throw new Error("Verification failed: #3322 is not excluded");
  if (byApp.get(3325)?.status !== "potential" || byApp.get(3325)?.amount !== "422.50") {
    throw new Error("Verification failed: #3325 is not potential 422.50 USD");
  }
}

async function main() {
  const [financeIds, pakistan, [rule]] = await Promise.all([
    financeCandidateIds(),
    pakistanCandidates(),
    db.select().from(leadAssignmentRulesTable).where(eq(leadAssignmentRulesTable.id, ruleId)).limit(1),
  ]);
  if (!rule || !rule.isActive || rule.strategy !== "round_robin") {
    throw new Error(`Rule #${ruleId} is missing, inactive, or not round_robin`);
  }
  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    financeCandidateCount: financeIds.length,
    financeApplicationIds: financeIds,
    plus92UnassignedCount: pakistan.all.length,
    pakistanRuleCandidateCount: pakistan.safe.length,
    excludedByPriorityOrNoMatch: pakistan.excluded,
    rule: {
      id: rule.id,
      phoneCodes: rule.phoneCodes,
      countries: rule.countries,
      staffUserIds: rule.staffUserIds,
      lastAssignedIndex: rule.lastAssignedIndex,
    },
  }, null, 2));

  if (!apply) return;
  if (expectedFinance == null || expectedLeads == null) {
    throw new Error("--apply requires --expected-finance and --expected-leads");
  }
  if (financeIds.length !== expectedFinance || pakistan.safe.length !== expectedLeads) {
    throw new Error(
      `Scope changed: finance=${financeIds.length}/${expectedFinance}, leads=${pakistan.safe.length}/${expectedLeads}`,
    );
  }

  for (const applicationId of financeIds) {
    const result = await syncApplicationFinance(applicationId);
    if (!result) throw new Error(`Application #${applicationId} disappeared during reconciliation`);
    await db.insert(auditLogsTable).values({
      userId: null,
      action: "application.finance_reconciled",
      resource: "application",
      resourceId: applicationId,
      changes: JSON.stringify({ source: "2026-08-16-safe-backfill", ...result }),
    });
  }
  await verifyFinance();

  const assignmentCounts = new Map<number, number>();
  for (const lead of pakistan.safe) {
    const assignedTo = await applyLeadAssignmentRules(lead);
    if (!assignedTo || !rule.staffUserIds.includes(assignedTo)) {
      throw new Error(`Lead #${lead.id} was not assigned through rule #${ruleId}`);
    }
    assignmentCounts.set(assignedTo, (assignmentCounts.get(assignedTo) ?? 0) + 1);
  }

  const remainingFinance = await financeCandidateIds();
  const remainingPakistan = await pakistanCandidates();
  if (remainingFinance.length !== 0 || remainingPakistan.safe.length !== 0) {
    throw new Error(
      `Post-check failed: remaining finance=${remainingFinance.length}, leads=${remainingPakistan.safe.length}`,
    );
  }
  console.log(JSON.stringify({
    applied: true,
    financeReconciled: financeIds.length,
    leadsAssigned: pakistan.safe.length,
    assignmentCounts: Object.fromEntries(assignmentCounts),
    verified: true,
  }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
