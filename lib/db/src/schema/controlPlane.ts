import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  membershipsTable,
  organizationsTable,
  policyVersionsTable,
  principalsTable,
  tenantOrganizationLegacyBranchesTable,
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
    configurationKey: text("configuration_key").notNull(),
    title: text("title").notNull(),
    purpose: text("purpose").notNull(),
    ownerPrincipalId: uuid("owner_principal_id")
      .notNull()
      .references(() => principalsTable.id, { onDelete: "restrict" }),
    ownerMembershipId: uuid("owner_membership_id").notNull(),
    makerPrincipalId: uuid("maker_principal_id")
      .notNull()
      .references(() => principalsTable.id, { onDelete: "restrict" }),
    makerMembershipId: uuid("maker_membership_id").notNull(),
    checkerPrincipalId: uuid("checker_principal_id").references(
      () => principalsTable.id,
      { onDelete: "restrict" },
    ),
    checkerMembershipId: uuid("checker_membership_id"),
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
    approvalPolicyVersionId: uuid("approval_policy_version_id").notNull(),
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
    uniqueIndex("change_sets_one_active_proposal_per_target_uidx")
      .on(
        table.tenantId,
        table.changeType,
        table.configurationKey,
        table.targetScopeType,
        sql`coalesce(${table.targetOrganizationId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        sql`coalesce(${table.targetLegacyBranchId}, -1)`,
      )
      .where(
        sql`${table.status} IN ('DRAFT', 'VALIDATED', 'SIMULATED', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'CANARY', 'PUBLISHED', 'OBSERVING', 'RETURNED')`,
      ),
    foreignKey({
      columns: [table.tenantId, table.targetOrganizationId],
      foreignColumns: [organizationsTable.tenantId, organizationsTable.id],
      name: "change_sets_tenant_organization_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.tenantId,
        table.targetOrganizationId,
        table.targetLegacyBranchId,
      ],
      foreignColumns: [
        tenantOrganizationLegacyBranchesTable.tenantId,
        tenantOrganizationLegacyBranchesTable.organizationId,
        tenantOrganizationLegacyBranchesTable.legacyBranchId,
      ],
      name: "change_sets_tenant_organization_branch_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.tenantId,
        table.ownerMembershipId,
        table.ownerPrincipalId,
      ],
      foreignColumns: [
        membershipsTable.tenantId,
        membershipsTable.id,
        membershipsTable.principalId,
      ],
      name: "change_sets_owner_membership_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.tenantId,
        table.makerMembershipId,
        table.makerPrincipalId,
      ],
      foreignColumns: [
        membershipsTable.tenantId,
        membershipsTable.id,
        membershipsTable.principalId,
      ],
      name: "change_sets_maker_membership_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.tenantId,
        table.checkerMembershipId,
        table.checkerPrincipalId,
      ],
      foreignColumns: [
        membershipsTable.tenantId,
        membershipsTable.id,
        membershipsTable.principalId,
      ],
      name: "change_sets_checker_membership_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.approvalPolicyVersionId],
      foreignColumns: [policyVersionsTable.tenantId, policyVersionsTable.id],
      name: "change_sets_policy_version_fk",
    }).onDelete("restrict"),
    check("change_sets_id_uuidv7_chk", uuidV7(table.id)),
    check(
      "change_sets_type_chk",
      sql`${table.changeType} IN ('BRAND', 'LOCALE', 'NOTIFICATION_TEMPLATE', 'FEATURE_FLAG', 'MAINTENANCE_BANNER')`,
    ),
    check(
      "change_sets_configuration_key_chk",
      sql`${table.configurationKey} ~ '^[a-z][a-z0-9_.:-]{0,127}$'`,
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
      "change_sets_checker_membership_pair_chk",
      sql`(${table.checkerPrincipalId} IS NULL) = (${table.checkerMembershipId} IS NULL)`,
    ),
    check(
      "change_sets_checker_membership_separation_chk",
      sql`${table.checkerMembershipId} IS NULL OR ${table.checkerMembershipId} <> ${table.makerMembershipId}`,
    ),
    check(
      "change_sets_policy_identity_chk",
      sql`${table.approvalPolicyVersion} = ${table.approvalPolicyVersionId}::text`,
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

export const r1ConfigurationSnapshotsTable = pgTable(
  "r1_configuration_snapshots",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "restrict" }),
    changeType: text("change_type").notNull(),
    configurationKey: text("configuration_key").notNull(),
    targetScopeType: text("target_scope_type").notNull(),
    targetOrganizationId: uuid("target_organization_id"),
    targetLegacyBranchId: integer("target_legacy_branch_id"),
    version: bigint("version", { mode: "number" }).notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
    configHash: text("config_hash").notNull(),
    sourceChangeSetId: uuid("source_change_set_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("r1_configuration_snapshots_tenant_id_id_uq").on(
      table.tenantId,
      table.id,
    ),
    uniqueIndex("r1_configuration_snapshots_target_uidx").on(
      table.tenantId,
      table.changeType,
      table.configurationKey,
      table.targetScopeType,
      sql`coalesce(${table.targetOrganizationId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`coalesce(${table.targetLegacyBranchId}, -1)`,
    ),
    foreignKey({
      columns: [table.tenantId, table.targetOrganizationId],
      foreignColumns: [organizationsTable.tenantId, organizationsTable.id],
      name: "r1_configuration_snapshots_tenant_organization_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.tenantId,
        table.targetOrganizationId,
        table.targetLegacyBranchId,
      ],
      foreignColumns: [
        tenantOrganizationLegacyBranchesTable.tenantId,
        tenantOrganizationLegacyBranchesTable.organizationId,
        tenantOrganizationLegacyBranchesTable.legacyBranchId,
      ],
      name: "r1_configuration_snapshots_tenant_organization_branch_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.sourceChangeSetId],
      foreignColumns: [changeSetsTable.tenantId, changeSetsTable.id],
      name: "r1_configuration_snapshots_source_change_set_fk",
    }).onDelete("restrict"),
    check("r1_configuration_snapshots_id_uuidv7_chk", uuidV7(table.id)),
    check(
      "r1_configuration_snapshots_type_chk",
      sql`${table.changeType} IN ('BRAND', 'LOCALE', 'NOTIFICATION_TEMPLATE', 'FEATURE_FLAG', 'MAINTENANCE_BANNER')`,
    ),
    check(
      "r1_configuration_snapshots_key_chk",
      sql`${table.configurationKey} ~ '^[a-z][a-z0-9_.:-]{0,127}$'`,
    ),
    check(
      "r1_configuration_snapshots_scope_chk",
      sql`(
        (${table.targetScopeType} = 'TENANT' AND ${table.targetOrganizationId} IS NULL AND ${table.targetLegacyBranchId} IS NULL)
        OR (${table.targetScopeType} = 'ORGANIZATION' AND ${table.targetOrganizationId} IS NOT NULL AND ${table.targetLegacyBranchId} IS NULL)
        OR (${table.targetScopeType} = 'LEGACY_BRANCH' AND ${table.targetOrganizationId} IS NOT NULL AND ${table.targetLegacyBranchId} IS NOT NULL)
      )`,
    ),
    check("r1_configuration_snapshots_version_chk", sql`${table.version} >= 0`),
    check(
      "r1_configuration_snapshots_config_chk",
      sql`jsonb_typeof(${table.config}) = 'object'`,
    ),
    check(
      "r1_configuration_snapshots_hash_chk",
      sql`${table.configHash} ~ '^[0-9a-f]{64}$'`,
    ),
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
    checkerMembershipId: uuid("checker_membership_id").notNull(),
    decision: text("decision").notNull(),
    reasonCode: text("reason_code").notNull(),
    approvalPolicyVersion: text("approval_policy_version").notNull(),
    approvalPolicyVersionId: uuid("approval_policy_version_id").notNull(),
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
    foreignKey({
      columns: [
        table.tenantId,
        table.checkerMembershipId,
        table.checkerPrincipalId,
      ],
      foreignColumns: [
        membershipsTable.tenantId,
        membershipsTable.id,
        membershipsTable.principalId,
      ],
      name: "change_set_approvals_checker_membership_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.approvalPolicyVersionId],
      foreignColumns: [policyVersionsTable.tenantId, policyVersionsTable.id],
      name: "change_set_approvals_policy_version_fk",
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
      "change_set_approvals_policy_identity_chk",
      sql`${table.approvalPolicyVersion} = ${table.approvalPolicyVersionId}::text`,
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
    commandReceiptId: uuid("command_receipt_id").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "restrict" }),
    changeSetId: uuid("change_set_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    actorPrincipalId: uuid("actor_principal_id")
      .notNull()
      .references(() => principalsTable.id, { onDelete: "restrict" }),
    actorMembershipId: uuid("actor_membership_id").notNull(),
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    reasonCode: text("reason_code").notNull(),
    policyVersion: text("policy_version").notNull(),
    policyVersionId: uuid("policy_version_id").notNull(),
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
    unique("change_set_transition_receipts_tenant_command_uq").on(
      table.tenantId,
      table.commandReceiptId,
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
    foreignKey({
      columns: [table.tenantId, table.commandReceiptId],
      foreignColumns: [
        changeSetCommandReceiptsTable.tenantId,
        changeSetCommandReceiptsTable.id,
      ],
      name: "change_set_transition_receipts_command_receipt_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.tenantId,
        table.actorMembershipId,
        table.actorPrincipalId,
      ],
      foreignColumns: [
        membershipsTable.tenantId,
        membershipsTable.id,
        membershipsTable.principalId,
      ],
      name: "change_set_transition_receipts_actor_membership_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.policyVersionId],
      foreignColumns: [policyVersionsTable.tenantId, policyVersionsTable.id],
      name: "change_set_transition_receipts_policy_version_fk",
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
    check(
      "change_set_transition_receipts_policy_identity_chk",
      sql`${table.policyVersion} = ${table.policyVersionId}::text`,
    ),
  ],
).enableRLS();

export const changeSetCommandReceiptsTable = pgTable(
  "change_set_command_receipts",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "restrict" }),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    requestHash: text("request_hash").notNull(),
    contextId: uuid("context_id").notNull(),
    actorPrincipalId: uuid("actor_principal_id")
      .notNull()
      .references(() => principalsTable.id, { onDelete: "restrict" }),
    actorMembershipId: uuid("actor_membership_id").notNull(),
    commandType: text("command_type").notNull(),
    targetState: text("target_state"),
    changeSetId: uuid("change_set_id"),
    status: text("status").notNull().default("CLAIMED"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    resultHash: text("result_hash"),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    claimedAt: timestamp("claimed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("change_set_command_receipts_tenant_id_id_uq").on(
      table.tenantId,
      table.id,
    ),
    unique("change_set_command_receipts_tenant_key_uq").on(
      table.tenantId,
      table.idempotencyKeyHash,
    ),
    index("change_set_command_receipts_change_set_idx").on(
      table.tenantId,
      table.changeSetId,
      table.claimedAt,
    ),
    foreignKey({
      columns: [table.tenantId, table.changeSetId],
      foreignColumns: [changeSetsTable.tenantId, changeSetsTable.id],
      name: "change_set_command_receipts_tenant_change_set_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.tenantId,
        table.actorMembershipId,
        table.actorPrincipalId,
      ],
      foreignColumns: [
        membershipsTable.tenantId,
        membershipsTable.id,
        membershipsTable.principalId,
      ],
      name: "change_set_command_receipts_actor_membership_fk",
    }).onDelete("restrict"),
    check("change_set_command_receipts_id_uuidv7_chk", uuidV7(table.id)),
    check(
      "change_set_command_receipts_context_uuidv7_chk",
      uuidV7(table.contextId),
    ),
    check(
      "change_set_command_receipts_hashes_chk",
      sql`${table.idempotencyKeyHash} ~ '^[0-9a-f]{64}$' AND ${table.requestHash} ~ '^[0-9a-f]{64}$' AND (${table.resultHash} IS NULL OR ${table.resultHash} ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      "change_set_command_receipts_type_chk",
      sql`${table.commandType} IN ('CREATE', 'TRANSITION')`,
    ),
    check(
      "change_set_command_receipts_target_state_chk",
      sql`(${table.commandType} = 'CREATE' AND ${table.targetState} IS NULL) OR (${table.commandType} = 'TRANSITION' AND ${table.targetState} IS NOT NULL AND ${table.targetState} IN ('VALIDATED', 'SIMULATED', 'IN_REVIEW'))`,
    ),
    check(
      "change_set_command_receipts_status_chk",
      sql`${table.status} IN ('CLAIMED', 'COMPLETED')`,
    ),
    check("change_set_command_receipts_version_chk", sql`${table.version} > 0`),
  ],
).enableRLS();

export const changeSetEvidenceIssuersTable = pgTable(
  "change_set_evidence_issuers",
  {
    id: text("id").primaryKey(),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principalsTable.id, { onDelete: "restrict" }),
    environmentId: text("environment_id").notNull(),
    cellId: text("cell_id").notNull(),
    state: text("state").notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    unique("change_set_evidence_issuers_principal_environment_uq").on(
      table.principalId,
      table.environmentId,
      table.cellId,
    ),
    check(
      "change_set_evidence_issuers_identity_chk",
      sql`${table.id} ~ '^[a-z][a-z0-9._:-]{2,95}$' AND ${table.environmentId} ~ '^[a-z][a-z0-9._:-]{2,95}$' AND ${table.cellId} ~ '^[a-z][a-z0-9._:-]{2,95}$'`,
    ),
    check(
      "change_set_evidence_issuers_state_chk",
      sql`${table.state} IN ('ACTIVE', 'REVOKED')`,
    ),
    check(
      "change_set_evidence_issuers_revocation_chk",
      sql`(${table.state} = 'ACTIVE' AND ${table.revokedAt} IS NULL) OR (${table.state} = 'REVOKED' AND ${table.revokedAt} IS NOT NULL)`,
    ),
  ],
);

export const changeSetEvidenceSigningKeysTable = pgTable(
  "change_set_evidence_signing_keys",
  {
    issuerId: text("issuer_id")
      .notNull()
      .references(() => changeSetEvidenceIssuersTable.id, {
        onDelete: "restrict",
      }),
    keyId: text("key_id").notNull(),
    algorithm: text("algorithm").notNull(),
    publicKeySpkiBase64: text("public_key_spki_base64").notNull(),
    publicKeyFingerprintSha256: text("public_key_fingerprint_sha256").notNull(),
    state: text("state").notNull().default("PENDING"),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    signUntil: timestamp("sign_until", { withTimezone: true }).notNull(),
    verifyUntil: timestamp("verify_until", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.issuerId, table.keyId] }),
    check(
      "change_set_evidence_signing_keys_identity_chk",
      sql`${table.keyId} ~ '^[a-z][a-z0-9._:-]{2,95}$'`,
    ),
    check(
      "change_set_evidence_signing_keys_algorithm_chk",
      sql`${table.algorithm} = 'Ed25519'`,
    ),
    check(
      "change_set_evidence_signing_keys_fingerprint_chk",
      sql`${table.publicKeyFingerprintSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "change_set_evidence_signing_keys_state_chk",
      sql`${table.state} IN ('PENDING', 'ACTIVE', 'VERIFY_ONLY', 'REVOKED', 'COMPROMISED')`,
    ),
    check(
      "change_set_evidence_signing_keys_window_chk",
      sql`${table.signUntil} > ${table.validFrom} AND ${table.verifyUntil} >= ${table.signUntil}`,
    ),
    check(
      "change_set_evidence_signing_keys_revocation_chk",
      sql`(${table.state} IN ('PENDING', 'ACTIVE', 'VERIFY_ONLY') AND ${table.revokedAt} IS NULL) OR (${table.state} IN ('REVOKED', 'COMPROMISED') AND ${table.revokedAt} IS NOT NULL)`,
    ),
  ],
);

export const changeSetEvidenceSigningKeyBindingsTable = pgTable(
  "change_set_evidence_signing_key_bindings",
  {
    issuerId: text("issuer_id").notNull(),
    keyId: text("key_id").notNull(),
    opaqueSigningKeyRef: text("opaque_signing_key_ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.issuerId, table.keyId] }),
    foreignKey({
      columns: [table.issuerId, table.keyId],
      foreignColumns: [
        changeSetEvidenceSigningKeysTable.issuerId,
        changeSetEvidenceSigningKeysTable.keyId,
      ],
      name: "change_set_evidence_signing_key_bindings_key_fk",
    }).onDelete("restrict"),
    check(
      "change_set_evidence_signing_key_bindings_ref_chk",
      sql`length(${table.opaqueSigningKeyRef}) BETWEEN 16 AND 255 AND ${table.opaqueSigningKeyRef} ~ '^(kms|hsm|test-memory)://[A-Za-z0-9][A-Za-z0-9._:/-]{8,240}$' AND ${table.opaqueSigningKeyRef} !~ '[[:space:]]'`,
    ),
  ],
);

export const changeSetEvidenceIssuerTenantGrantsTable = pgTable(
  "change_set_evidence_issuer_tenant_grants",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "restrict" }),
    issuerId: text("issuer_id")
      .notNull()
      .references(() => changeSetEvidenceIssuersTable.id, {
        onDelete: "restrict",
      }),
    kind: text("kind").notNull(),
    toolId: text("tool_id").notNull(),
    toolVersion: text("tool_version").notNull(),
    state: text("state").notNull().default("ACTIVE"),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    unique("change_set_evidence_issuer_tenant_grants_tenant_id_id_uq").on(
      table.tenantId,
      table.id,
    ),
    uniqueIndex("change_set_evidence_issuer_tenant_grants_active_uidx")
      .on(
        table.tenantId,
        table.issuerId,
        table.kind,
        table.toolId,
        table.toolVersion,
      )
      .where(sql`${table.state} = 'ACTIVE'`),
    check(
      "change_set_evidence_issuer_tenant_grants_id_uuidv7_chk",
      uuidV7(table.id),
    ),
    check(
      "change_set_evidence_issuer_tenant_grants_kind_chk",
      sql`${table.kind} IN ('VALIDATION', 'SIMULATION', 'TEST_ARTIFACT', 'ROLLBACK_PLAN', 'CANARY_PLAN')`,
    ),
    check(
      "change_set_evidence_issuer_tenant_grants_tool_chk",
      sql`${table.toolId} ~ '^[a-z][a-z0-9._:-]{2,95}$' AND ${table.toolVersion} ~ '^[a-z][a-z0-9._:-]{2,95}$'`,
    ),
    check(
      "change_set_evidence_issuer_tenant_grants_state_chk",
      sql`${table.state} IN ('ACTIVE', 'REVOKED')`,
    ),
    check(
      "change_set_evidence_issuer_tenant_grants_window_chk",
      sql`${table.validUntil} IS NULL OR ${table.validUntil} > ${table.validFrom}`,
    ),
    check(
      "change_set_evidence_issuer_tenant_grants_revocation_chk",
      sql`(${table.state} = 'ACTIVE' AND ${table.revokedAt} IS NULL) OR (${table.state} = 'REVOKED' AND ${table.revokedAt} IS NOT NULL)`,
    ),
  ],
).enableRLS();

export const changeSetEvidenceRequestsTable = pgTable(
  "change_set_evidence_requests",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "restrict" }),
    changeSetId: uuid("change_set_id").notNull(),
    targetState: text("target_state").notNull(),
    kind: text("kind").notNull(),
    challengeNonceHash: text("challenge_nonce_hash").notNull(),
    requestedByPrincipalId: uuid("requested_by_principal_id")
      .notNull()
      .references(() => principalsTable.id, { onDelete: "restrict" }),
    requestedByMembershipId: uuid("requested_by_membership_id").notNull(),
    subjectHash: text("subject_hash").notNull(),
    policyVersionId: uuid("policy_version_id").notNull(),
    toolId: text("tool_id").notNull(),
    toolVersion: text("tool_version").notNull(),
    state: text("state").notNull().default("OPEN"),
    issuedReceiptId: uuid("issued_receipt_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    unique("change_set_evidence_requests_tenant_id_id_uq").on(
      table.tenantId,
      table.id,
    ),
    unique("change_set_evidence_requests_tenant_receipt_uq").on(
      table.tenantId,
      table.issuedReceiptId,
    ),
    index("change_set_evidence_requests_lookup_idx").on(
      table.tenantId,
      table.changeSetId,
      table.targetState,
      table.kind,
      table.state,
    ),
    foreignKey({
      columns: [table.tenantId, table.changeSetId],
      foreignColumns: [changeSetsTable.tenantId, changeSetsTable.id],
      name: "change_set_evidence_requests_change_set_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.tenantId,
        table.requestedByMembershipId,
        table.requestedByPrincipalId,
      ],
      foreignColumns: [
        membershipsTable.tenantId,
        membershipsTable.id,
        membershipsTable.principalId,
      ],
      name: "change_set_evidence_requests_requester_membership_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.policyVersionId],
      foreignColumns: [policyVersionsTable.tenantId, policyVersionsTable.id],
      name: "change_set_evidence_requests_policy_version_fk",
    }).onDelete("restrict"),
    check("change_set_evidence_requests_id_uuidv7_chk", uuidV7(table.id)),
    check(
      "change_set_evidence_requests_target_state_chk",
      sql`${table.targetState} IN ('VALIDATED', 'SIMULATED', 'IN_REVIEW')`,
    ),
    check(
      "change_set_evidence_requests_kind_chk",
      sql`${table.kind} IN ('VALIDATION', 'SIMULATION', 'TEST_ARTIFACT', 'ROLLBACK_PLAN', 'CANARY_PLAN')`,
    ),
    check(
      "change_set_evidence_requests_kind_target_chk",
      sql`(${table.kind} = 'VALIDATION' AND ${table.targetState} = 'VALIDATED') OR (${table.kind} = 'SIMULATION' AND ${table.targetState} = 'SIMULATED') OR (${table.kind} IN ('TEST_ARTIFACT', 'ROLLBACK_PLAN', 'CANARY_PLAN') AND ${table.targetState} = 'IN_REVIEW')`,
    ),
    check(
      "change_set_evidence_requests_hashes_chk",
      sql`${table.challengeNonceHash} ~ '^[0-9a-f]{64}$' AND ${table.subjectHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "change_set_evidence_requests_tool_chk",
      sql`${table.toolId} ~ '^[a-z][a-z0-9._:-]{2,95}$' AND ${table.toolVersion} ~ '^[a-z][a-z0-9._:-]{2,95}$'`,
    ),
    check(
      "change_set_evidence_requests_state_chk",
      sql`${table.state} IN ('OPEN', 'ISSUED', 'EXPIRED', 'REVOKED')`,
    ),
    check(
      "change_set_evidence_requests_state_receipt_chk",
      sql`(${table.state} = 'ISSUED') = (${table.issuedReceiptId} IS NOT NULL)`,
    ),
    check(
      "change_set_evidence_requests_window_chk",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
).enableRLS();

export const changeSetEvidenceReceiptsTable = pgTable(
  "change_set_evidence_receipts",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "restrict" }),
    changeSetId: uuid("change_set_id").notNull(),
    targetState: text("target_state").notNull(),
    kind: text("kind").notNull(),
    issuer: text("issuer").notNull(),
    issuerPrincipalId: uuid("issuer_principal_id")
      .notNull()
      .references(() => principalsTable.id, { onDelete: "restrict" }),
    signingKeyId: text("signing_key_id").notNull(),
    algorithm: text("algorithm").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    audience: text("audience").notNull(),
    environmentId: text("environment_id").notNull(),
    cellId: text("cell_id").notNull(),
    evidenceRequestId: uuid("evidence_request_id").notNull(),
    issuerTenantGrantId: uuid("issuer_tenant_grant_id").notNull(),
    challengeNonceHash: text("challenge_nonce_hash").notNull(),
    toolId: text("tool_id").notNull(),
    toolVersion: text("tool_version").notNull(),
    requestedByPrincipalId: uuid("requested_by_principal_id")
      .notNull()
      .references(() => principalsTable.id, { onDelete: "restrict" }),
    requestedByMembershipId: uuid("requested_by_membership_id").notNull(),
    subjectHash: text("subject_hash").notNull(),
    policyVersionId: uuid("policy_version_id").notNull(),
    outcome: text("outcome").notNull(),
    artifactCount: integer("artifact_count"),
    artifactManifestHash: text("artifact_manifest_hash"),
    outcomeHash: text("outcome_hash").notNull(),
    signedClaims: jsonb("signed_claims").notNull(),
    signedClaimsCanonical: text("signed_claims_canonical").notNull(),
    signedClaimsHash: text("signed_claims_hash").notNull(),
    signatureBase64Url: text("signature_base64url").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    consumedByCommandReceiptId: uuid("consumed_by_command_receipt_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("change_set_evidence_receipts_tenant_id_id_uq").on(
      table.tenantId,
      table.id,
    ),
    index("change_set_evidence_receipts_lookup_idx").on(
      table.tenantId,
      table.changeSetId,
      table.targetState,
      table.requestedByPrincipalId,
      table.consumedAt,
      table.expiresAt,
    ),
    foreignKey({
      columns: [table.issuer, table.signingKeyId],
      foreignColumns: [
        changeSetEvidenceSigningKeysTable.issuerId,
        changeSetEvidenceSigningKeysTable.keyId,
      ],
      name: "change_set_evidence_receipts_signing_key_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.evidenceRequestId],
      foreignColumns: [
        changeSetEvidenceRequestsTable.tenantId,
        changeSetEvidenceRequestsTable.id,
      ],
      name: "change_set_evidence_receipts_request_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.issuerTenantGrantId],
      foreignColumns: [
        changeSetEvidenceIssuerTenantGrantsTable.tenantId,
        changeSetEvidenceIssuerTenantGrantsTable.id,
      ],
      name: "change_set_evidence_receipts_issuer_tenant_grant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.changeSetId],
      foreignColumns: [changeSetsTable.tenantId, changeSetsTable.id],
      name: "change_set_evidence_receipts_change_set_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.tenantId,
        table.requestedByMembershipId,
        table.requestedByPrincipalId,
      ],
      foreignColumns: [
        membershipsTable.tenantId,
        membershipsTable.id,
        membershipsTable.principalId,
      ],
      name: "change_set_evidence_receipts_requester_membership_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.policyVersionId],
      foreignColumns: [policyVersionsTable.tenantId, policyVersionsTable.id],
      name: "change_set_evidence_receipts_policy_version_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.consumedByCommandReceiptId],
      foreignColumns: [
        changeSetCommandReceiptsTable.tenantId,
        changeSetCommandReceiptsTable.id,
      ],
      name: "change_set_evidence_receipts_consuming_command_fk",
    }).onDelete("restrict"),
    check("change_set_evidence_receipts_id_uuidv7_chk", uuidV7(table.id)),
    check(
      "change_set_evidence_receipts_target_state_chk",
      sql`${table.targetState} IN ('VALIDATED', 'SIMULATED', 'IN_REVIEW')`,
    ),
    check(
      "change_set_evidence_receipts_kind_chk",
      sql`${table.kind} IN ('VALIDATION', 'SIMULATION', 'TEST_ARTIFACT', 'ROLLBACK_PLAN', 'CANARY_PLAN')`,
    ),
    check(
      "change_set_evidence_receipts_kind_target_chk",
      sql`(${table.kind} = 'VALIDATION' AND ${table.targetState} = 'VALIDATED') OR (${table.kind} = 'SIMULATION' AND ${table.targetState} = 'SIMULATED') OR (${table.kind} IN ('TEST_ARTIFACT', 'ROLLBACK_PLAN', 'CANARY_PLAN') AND ${table.targetState} = 'IN_REVIEW')`,
    ),
    check(
      "change_set_evidence_receipts_outcome_chk",
      sql`${table.outcome} IN ('PASSED', 'FAILED')`,
    ),
    check(
      "change_set_evidence_receipts_hashes_chk",
      sql`${table.challengeNonceHash} ~ '^[0-9a-f]{64}$' AND ${table.subjectHash} ~ '^[0-9a-f]{64}$' AND ${table.outcomeHash} ~ '^[0-9a-f]{64}$' AND ${table.signedClaimsHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "change_set_evidence_receipts_signed_claims_chk",
      sql`jsonb_typeof(${table.signedClaims}) = 'object' AND length(${table.signedClaimsCanonical}) BETWEEN 2 AND 8192`,
    ),
    check(
      "change_set_evidence_receipts_envelope_identity_chk",
      sql`${table.schemaVersion} = 1 AND ${table.audience} = 'fas.change-set.transition' AND ${table.algorithm} = 'Ed25519' AND ${table.environmentId} ~ '^[a-z][a-z0-9._:-]{2,95}$' AND ${table.cellId} ~ '^[a-z][a-z0-9._:-]{2,95}$' AND ${table.toolId} ~ '^[a-z][a-z0-9._:-]{2,95}$' AND ${table.toolVersion} ~ '^[a-z][a-z0-9._:-]{2,95}$'`,
    ),
    check(
      "change_set_evidence_receipts_signature_chk",
      sql`${table.signatureBase64Url} ~ '^[A-Za-z0-9_-]{86}$'`,
    ),
    check(
      "change_set_evidence_receipts_window_chk",
      sql`${table.expiresAt} > ${table.issuedAt} AND ${table.expiresAt} <= ${table.issuedAt} + interval '1 hour'`,
    ),
    check(
      "change_set_evidence_receipts_consumption_pair_chk",
      sql`(${table.consumedAt} IS NULL) = (${table.consumedByCommandReceiptId} IS NULL)`,
    ),
    check(
      "change_set_evidence_receipts_artifact_count_chk",
      sql`(${table.kind} = 'TEST_ARTIFACT' AND ${table.artifactCount} IS NOT NULL AND ${table.artifactCount} > 0 AND ${table.artifactManifestHash} IS NOT NULL AND ${table.artifactManifestHash} ~ '^[0-9a-f]{64}$') OR (${table.kind} <> 'TEST_ARTIFACT' AND ${table.artifactCount} IS NULL AND ${table.artifactManifestHash} IS NULL)`,
    ),
  ],
).enableRLS();

export const changeSetCommandAttemptReceiptsTable = pgTable(
  "change_set_command_attempt_receipts",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "restrict" }),
    contextId: uuid("context_id").notNull(),
    actorPrincipalId: uuid("actor_principal_id")
      .notNull()
      .references(() => principalsTable.id, { onDelete: "restrict" }),
    actorMembershipId: uuid("actor_membership_id").notNull(),
    commandReceiptId: uuid("command_receipt_id").notNull(),
    requestHash: text("request_hash").notNull(),
    outcome: text("outcome").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("change_set_command_attempt_receipts_command_idx").on(
      table.tenantId,
      table.commandReceiptId,
      table.occurredAt,
    ),
    foreignKey({
      columns: [
        table.tenantId,
        table.actorMembershipId,
        table.actorPrincipalId,
      ],
      foreignColumns: [
        membershipsTable.tenantId,
        membershipsTable.id,
        membershipsTable.principalId,
      ],
      name: "change_set_command_attempt_receipts_actor_membership_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.commandReceiptId],
      foreignColumns: [
        changeSetCommandReceiptsTable.tenantId,
        changeSetCommandReceiptsTable.id,
      ],
      name: "change_set_command_attempt_receipts_command_fk",
    }).onDelete("restrict"),
    check(
      "change_set_command_attempt_receipts_id_uuidv7_chk",
      uuidV7(table.id),
    ),
    check(
      "change_set_command_attempt_receipts_context_uuidv7_chk",
      uuidV7(table.contextId),
    ),
    check(
      "change_set_command_attempt_receipts_request_hash_chk",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "change_set_command_attempt_receipts_outcome_chk",
      sql`${table.outcome} IN ('CONFLICT', 'IN_PROGRESS')`,
    ),
  ],
).enableRLS();

export const changeSetCommandAuditEventsTable = pgTable(
  "change_set_command_audit_events",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "restrict" }),
    attemptId: uuid("attempt_id").notNull(),
    sequence: integer("sequence").notNull(),
    contextId: uuid("context_id").notNull(),
    actorPrincipalId: uuid("actor_principal_id").notNull(),
    actorMembershipId: uuid("actor_membership_id").notNull(),
    changeSetId: uuid("change_set_id"),
    commandType: text("command_type").notNull(),
    targetState: text("target_state"),
    capability: text("capability").notNull(),
    policyVersionId: uuid("policy_version_id"),
    phase: text("phase").notNull(),
    outcome: text("outcome").notNull(),
    reasonCode: text("reason_code").notNull(),
    idempotencyKeyFingerprint: text("idempotency_key_fingerprint").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    fingerprintKeyId: text("fingerprint_key_id").notNull(),
    previousHash: text("previous_hash"),
    eventHash: text("event_hash").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("change_set_command_audit_events_attempt_sequence_uq").on(
      table.tenantId,
      table.attemptId,
      table.sequence,
    ),
    index("change_set_command_audit_events_actor_idx").on(
      table.tenantId,
      table.actorPrincipalId,
      table.occurredAt,
    ),
    index("change_set_command_audit_events_change_set_idx").on(
      table.tenantId,
      table.changeSetId,
      table.occurredAt,
    ),
    foreignKey({
      columns: [
        table.tenantId,
        table.actorMembershipId,
        table.actorPrincipalId,
      ],
      foreignColumns: [
        membershipsTable.tenantId,
        membershipsTable.id,
        membershipsTable.principalId,
      ],
      name: "change_set_command_audit_events_actor_membership_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.policyVersionId],
      foreignColumns: [policyVersionsTable.tenantId, policyVersionsTable.id],
      name: "change_set_command_audit_events_policy_version_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.changeSetId],
      foreignColumns: [changeSetsTable.tenantId, changeSetsTable.id],
      name: "change_set_command_audit_events_change_set_fk",
    }).onDelete("restrict"),
    check("change_set_command_audit_events_id_uuidv7_chk", uuidV7(table.id)),
    check(
      "change_set_command_audit_events_attempt_uuidv7_chk",
      uuidV7(table.attemptId),
    ),
    check(
      "change_set_command_audit_events_context_uuidv7_chk",
      uuidV7(table.contextId),
    ),
    check(
      "change_set_command_audit_events_sequence_chk",
      sql`${table.sequence} > 0`,
    ),
    check(
      "change_set_command_audit_events_command_chk",
      sql`${table.commandType} IN ('CREATE', 'TRANSITION') AND ((${table.commandType} = 'CREATE' AND ${table.targetState} IS NULL) OR (${table.commandType} = 'TRANSITION' AND ${table.targetState} IS NOT NULL AND ${table.changeSetId} IS NOT NULL AND ${table.targetState} IN ('VALIDATED', 'SIMULATED', 'IN_REVIEW')))`,
    ),
    check(
      "change_set_command_audit_events_capability_chk",
      sql`${table.capability} ~ '^[a-z][a-z0-9._:-]{2,95}$'`,
    ),
    check(
      "change_set_command_audit_events_phase_chk",
      sql`${table.phase} IN ('ATTEMPT_STARTED', 'AUTHORIZATION', 'CLAIM', 'EVIDENCE', 'MUTATION', 'COMMIT', 'TERMINAL')`,
    ),
    check(
      "change_set_command_audit_events_outcome_chk",
      sql`(${table.phase} = 'ATTEMPT_STARTED' AND ${table.outcome} = 'STARTED') OR (${table.phase} = 'AUTHORIZATION' AND ${table.outcome} = 'ALLOW') OR (${table.phase} IN ('CLAIM', 'EVIDENCE', 'MUTATION', 'COMMIT') AND ${table.outcome} = 'SUCCESS') OR (${table.phase} = 'TERMINAL' AND ${table.outcome} IN ('DENY', 'REJECT', 'CONFLICT', 'ERROR', 'SUCCESS'))`,
    ),
    check(
      "change_set_command_audit_events_reason_chk",
      sql`(${table.phase} = 'ATTEMPT_STARTED' AND ${table.outcome} = 'STARTED' AND ${table.reasonCode} = 'REQUEST_ACCEPTED') OR (${table.phase} = 'AUTHORIZATION' AND ${table.outcome} = 'ALLOW' AND ${table.reasonCode} = 'AUTHORIZED') OR (${table.phase} = 'CLAIM' AND ${table.outcome} = 'SUCCESS' AND ${table.reasonCode} = 'CLAIMED') OR (${table.phase} = 'EVIDENCE' AND ${table.outcome} = 'SUCCESS' AND ${table.reasonCode} = 'EVIDENCE_ACCEPTED') OR (${table.phase} = 'MUTATION' AND ${table.outcome} = 'SUCCESS' AND ${table.reasonCode} = 'MUTATION_APPLIED') OR (${table.phase} = 'COMMIT' AND ${table.outcome} = 'SUCCESS' AND ${table.reasonCode} = 'COMMIT_CONFIRMED') OR (${table.phase} = 'TERMINAL' AND ${table.outcome} = 'SUCCESS' AND ${table.reasonCode} = 'COMMAND_COMPLETED') OR (${table.phase} = 'TERMINAL' AND ${table.outcome} = 'DENY' AND ${table.reasonCode} = 'AUTHORIZATION_DENIED') OR (${table.phase} = 'TERMINAL' AND ${table.outcome} = 'REJECT' AND ${table.reasonCode} IN ('EVIDENCE_REJECTED', 'MUTATION_REJECTED')) OR (${table.phase} = 'TERMINAL' AND ${table.outcome} = 'CONFLICT' AND ${table.reasonCode} IN ('IDEMPOTENCY_CONFLICT', 'COMMAND_IN_PROGRESS')) OR (${table.phase} = 'TERMINAL' AND ${table.outcome} = 'ERROR' AND ${table.reasonCode} = 'INTERNAL_ERROR')`,
    ),
    check(
      "change_set_command_audit_events_hashes_chk",
      sql`${table.idempotencyKeyFingerprint} ~ '^[0-9a-f]{64}$' AND ${table.requestFingerprint} ~ '^[0-9a-f]{64}$' AND ${table.eventHash} ~ '^[0-9a-f]{64}$' AND (${table.previousHash} IS NULL OR ${table.previousHash} ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      "change_set_command_audit_events_key_id_chk",
      sql`${table.fingerprintKeyId} ~ '^[a-z][a-z0-9._:-]{2,95}$'`,
    ),
  ],
).enableRLS();

export type ChangeSet = typeof changeSetsTable.$inferSelect;
export type ChangeSetApproval = typeof changeSetApprovalsTable.$inferSelect;
export type ChangeSetTransitionReceipt =
  typeof changeSetTransitionReceiptsTable.$inferSelect;
export type ChangeSetCommandReceipt =
  typeof changeSetCommandReceiptsTable.$inferSelect;
export type ChangeSetEvidenceReceipt =
  typeof changeSetEvidenceReceiptsTable.$inferSelect;
export type ChangeSetEvidenceIssuer =
  typeof changeSetEvidenceIssuersTable.$inferSelect;
export type ChangeSetEvidenceSigningKey =
  typeof changeSetEvidenceSigningKeysTable.$inferSelect;
export type ChangeSetEvidenceSigningKeyBinding =
  typeof changeSetEvidenceSigningKeyBindingsTable.$inferSelect;
export type ChangeSetEvidenceIssuerTenantGrant =
  typeof changeSetEvidenceIssuerTenantGrantsTable.$inferSelect;
export type ChangeSetEvidenceRequest =
  typeof changeSetEvidenceRequestsTable.$inferSelect;
export type ChangeSetCommandAttemptReceipt =
  typeof changeSetCommandAttemptReceiptsTable.$inferSelect;
export type ChangeSetCommandAuditEvent =
  typeof changeSetCommandAuditEventsTable.$inferSelect;
