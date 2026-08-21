import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import {
  organizationsTable,
  principalsTable,
  tenantsTable,
} from "./authorization";
import { branchesTable } from "./branches";

const uuidV7 = (column: { name: string }) =>
  sql`substring(${sql.identifier(column.name)}::text from 15 for 1) = '7'`;

export const changeSetsTable = pgTable(
  "change_sets",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "restrict" }),
    changeType: text("change_type").notNull(),
    title: text("title").notNull(),
    purpose: text("purpose").notNull(),
    ownerPrincipalId: uuid("owner_principal_id")
      .notNull()
      .references(() => principalsTable.id, { onDelete: "restrict" }),
    makerPrincipalId: uuid("maker_principal_id")
      .notNull()
      .references(() => principalsTable.id, { onDelete: "restrict" }),
    checkerPrincipalId: uuid("checker_principal_id").references(
      () => principalsTable.id,
      { onDelete: "restrict" },
    ),
    targetScopeType: text("target_scope_type").notNull(),
    targetOrganizationId: uuid("target_organization_id"),
    targetLegacyBranchId: integer("target_legacy_branch_id").references(
      () => branchesTable.id,
      { onDelete: "restrict" },
    ),
    baseVersion: bigint("base_version", { mode: "number" }).notNull(),
    baseHash: text("base_hash").notNull(),
    proposedVersion: bigint("proposed_version", { mode: "number" }).notNull(),
    proposedHash: text("proposed_hash").notNull(),
    baseConfig: jsonb("base_config").$type<Record<string, unknown>>().notNull(),
    proposedConfig: jsonb("proposed_config")
      .$type<Record<string, unknown>>()
      .notNull(),
    dependencyVersions: jsonb("dependency_versions")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    compatibilityRange: text("compatibility_range").notNull(),
    riskTier: text("risk_tier").notNull().default("R1"),
    dataClass: text("data_class").notNull(),
    affectedTenantCount: integer("affected_tenant_count").notNull().default(1),
    affectedBranchCount: integer("affected_branch_count").notNull().default(0),
    affectedPrincipalCount: integer("affected_principal_count")
      .notNull()
      .default(0),
    affectedCaseCount: integer("affected_case_count").notNull().default(0),
    affectedIntegrationCount: integer("affected_integration_count")
      .notNull()
      .default(0),
    semanticDiff: jsonb("semantic_diff")
      .$type<Record<string, unknown>>()
      .notNull(),
    validationResult:
      jsonb("validation_result").$type<Record<string, unknown>>(),
    simulationResult:
      jsonb("simulation_result").$type<Record<string, unknown>>(),
    testEvidence: jsonb("test_evidence")
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default([]),
    approvalPolicyVersion: text("approval_policy_version").notNull(),
    rolloutStrategy: jsonb("rollout_strategy")
      .$type<Record<string, unknown>>()
      .notNull(),
    canaryScope: jsonb("canary_scope")
      .$type<Record<string, unknown>>()
      .notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    abortConditions: jsonb("abort_conditions")
      .$type<Array<Record<string, unknown>>>()
      .notNull(),
    observationWindowSeconds: integer("observation_window_seconds")
      .notNull()
      .default(3600),
    rollbackStrategy: jsonb("rollback_strategy")
      .$type<Record<string, unknown>>()
      .notNull(),
    linkedArtifacts: jsonb("linked_artifacts")
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default([]),
    status: text("status").notNull().default("DRAFT"),
    statusReason: text("status_reason"),
    reviewRound: integer("review_round").notNull().default(0),
    observationStartedAt: timestamp("observation_started_at", {
      withTimezone: true,
    }),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    effectiveAt: timestamp("effective_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    unique("change_sets_tenant_id_id_uq").on(table.tenantId, table.id),
    index("change_sets_tenant_status_created_idx").on(
      table.tenantId,
      table.status,
      table.createdAt,
    ),
    index("change_sets_checker_status_idx").on(
      table.checkerPrincipalId,
      table.status,
    ),
    foreignKey({
      columns: [table.tenantId, table.targetOrganizationId],
      foreignColumns: [organizationsTable.tenantId, organizationsTable.id],
      name: "change_sets_tenant_organization_fk",
    }).onDelete("restrict"),
    check("change_sets_id_uuidv7_chk", uuidV7(table.id)),
    check(
      "change_sets_type_chk",
      sql`${table.changeType} IN ('BRAND', 'LOCALE', 'NOTIFICATION_TEMPLATE', 'FEATURE_FLAG', 'MAINTENANCE_BANNER')`,
    ),
    check(
      "change_sets_scope_chk",
      sql`(
        (${table.targetScopeType} = 'TENANT' AND ${table.targetOrganizationId} IS NULL AND ${table.targetLegacyBranchId} IS NULL)
        OR (${table.targetScopeType} = 'ORGANIZATION' AND ${table.targetOrganizationId} IS NOT NULL AND ${table.targetLegacyBranchId} IS NULL)
        OR (${table.targetScopeType} = 'LEGACY_BRANCH' AND ${table.targetOrganizationId} IS NOT NULL AND ${table.targetLegacyBranchId} IS NOT NULL)
      )`,
    ),
    check(
      "change_sets_version_window_chk",
      sql`${table.baseVersion} >= 0 AND ${table.proposedVersion} = ${table.baseVersion} + 1`,
    ),
    check(
      "change_sets_hashes_chk",
      sql`${table.baseHash} ~ '^[0-9a-f]{64}$' AND ${table.proposedHash} ~ '^[0-9a-f]{64}$' AND ${table.baseHash} <> ${table.proposedHash}`,
    ),
    check("change_sets_risk_tier_chk", sql`${table.riskTier} = 'R1'`),
    check(
      "change_sets_data_class_chk",
      sql`${table.dataClass} IN ('PUBLIC', 'INTERNAL')`,
    ),
    check(
      "change_sets_single_tenant_impact_chk",
      sql`${table.affectedTenantCount} = 1 AND ${table.affectedBranchCount} >= 0 AND ${table.affectedPrincipalCount} >= 0 AND ${table.affectedCaseCount} >= 0 AND ${table.affectedIntegrationCount} >= 0`,
    ),
    check(
      "change_sets_checker_separation_chk",
      sql`${table.checkerPrincipalId} IS NULL OR ${table.checkerPrincipalId} <> ${table.makerPrincipalId}`,
    ),
    check(
      "change_sets_observation_window_chk",
      sql`${table.observationWindowSeconds} >= 3600`,
    ),
    check(
      "change_sets_status_chk",
      sql`${table.status} IN ('DRAFT', 'VALIDATED', 'SIMULATED', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'CANARY', 'PUBLISHED', 'OBSERVING', 'EFFECTIVE', 'RETURNED', 'REJECTED', 'FAILED', 'ROLLED_BACK', 'REVOKED')`,
    ),
    check("change_sets_review_round_chk", sql`${table.reviewRound} >= 0`),
    check("change_sets_version_chk", sql`${table.version} > 0`),
  ],
).enableRLS();

export const changeSetApprovalsTable = pgTable(
  "change_set_approvals",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "restrict" }),
    changeSetId: uuid("change_set_id").notNull(),
    reviewRound: integer("review_round").notNull(),
    checkerPrincipalId: uuid("checker_principal_id")
      .notNull()
      .references(() => principalsTable.id, { onDelete: "restrict" }),
    decision: text("decision").notNull(),
    reasonCode: text("reason_code").notNull(),
    approvalPolicyVersion: text("approval_policy_version").notNull(),
    stepUpReceiptId: uuid("step_up_receipt_id").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    decisionHash: text("decision_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("change_set_approvals_tenant_hash_uq").on(
      table.tenantId,
      table.decisionHash,
    ),
    unique("change_set_approvals_review_round_uq").on(
      table.tenantId,
      table.changeSetId,
      table.reviewRound,
    ),
    index("change_set_approvals_change_set_created_idx").on(
      table.tenantId,
      table.changeSetId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.tenantId, table.changeSetId],
      foreignColumns: [changeSetsTable.tenantId, changeSetsTable.id],
      name: "change_set_approvals_tenant_change_set_fk",
    }).onDelete("restrict"),
    check("change_set_approvals_id_uuidv7_chk", uuidV7(table.id)),
    check(
      "change_set_approvals_step_up_uuidv7_chk",
      uuidV7(table.stepUpReceiptId),
    ),
    check(
      "change_set_approvals_decision_chk",
      sql`${table.decision} IN ('APPROVED', 'RETURNED', 'REJECTED')`,
    ),
    check(
      "change_set_approvals_hash_chk",
      sql`${table.decisionHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "change_set_approvals_review_round_chk",
      sql`${table.reviewRound} > 0`,
    ),
  ],
).enableRLS();

export const changeSetTransitionReceiptsTable = pgTable(
  "change_set_transition_receipts",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "restrict" }),
    changeSetId: uuid("change_set_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    actorPrincipalId: uuid("actor_principal_id")
      .notNull()
      .references(() => principalsTable.id, { onDelete: "restrict" }),
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    reasonCode: text("reason_code").notNull(),
    policyVersion: text("policy_version").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    previousHash: text("previous_hash"),
    receiptHash: text("receipt_hash").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("change_set_transition_receipts_tenant_sequence_uq").on(
      table.tenantId,
      table.changeSetId,
      table.sequence,
    ),
    unique("change_set_transition_receipts_tenant_hash_uq").on(
      table.tenantId,
      table.receiptHash,
    ),
    index("change_set_transition_receipts_tenant_occurred_idx").on(
      table.tenantId,
      table.occurredAt,
    ),
    foreignKey({
      columns: [table.tenantId, table.changeSetId],
      foreignColumns: [changeSetsTable.tenantId, changeSetsTable.id],
      name: "change_set_transition_receipts_tenant_change_set_fk",
    }).onDelete("restrict"),
    check("change_set_transition_receipts_id_uuidv7_chk", uuidV7(table.id)),
    check(
      "change_set_transition_receipts_state_chk",
      sql`${table.fromState} IS NULL OR ${table.fromState} IN ('DRAFT', 'VALIDATED', 'SIMULATED', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'CANARY', 'PUBLISHED', 'OBSERVING', 'EFFECTIVE', 'RETURNED', 'REJECTED', 'FAILED', 'ROLLED_BACK', 'REVOKED')`,
    ),
    check(
      "change_set_transition_receipts_to_state_chk",
      sql`${table.toState} IN ('DRAFT', 'VALIDATED', 'SIMULATED', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'CANARY', 'PUBLISHED', 'OBSERVING', 'EFFECTIVE', 'RETURNED', 'REJECTED', 'FAILED', 'ROLLED_BACK', 'REVOKED')`,
    ),
    check(
      "change_set_transition_receipts_hashes_chk",
      sql`${table.evidenceHash} ~ '^[0-9a-f]{64}$' AND ${table.receiptHash} ~ '^[0-9a-f]{64}$' AND (${table.previousHash} IS NULL OR ${table.previousHash} ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      "change_set_transition_receipts_sequence_chk",
      sql`${table.sequence} > 0`,
    ),
  ],
).enableRLS();

export type ChangeSet = typeof changeSetsTable.$inferSelect;
export type ChangeSetApproval = typeof changeSetApprovalsTable.$inferSelect;
export type ChangeSetTransitionReceipt =
  typeof changeSetTransitionReceiptsTable.$inferSelect;
