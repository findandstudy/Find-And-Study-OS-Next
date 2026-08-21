import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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
import { branchesTable } from "./branches";
import { usersTable } from "./users";

const uuidV7 = (column: { name: string }) =>
  sql`substring(${sql.identifier(column.name)}::text from 15 for 1) = '7'`;

export const tenantsTable = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey(),
    slug: text("slug").notNull(),
    legalName: text("legal_name").notNull(),
    displayName: text("display_name").notNull(),
    status: text("status").notNull().default("PROVISIONING"),
    homeRegion: text("home_region").notNull(),
    defaultLocale: text("default_locale").notNull().default("en"),
    defaultTimezone: text("default_timezone").notNull().default("UTC"),
    reportingCurrency: text("reporting_currency").notNull().default("USD"),
    policyVersion: bigint("policy_version", { mode: "number" })
      .notNull()
      .default(1),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("tenants_slug_lower_uidx").on(sql`lower(${table.slug})`),
    check("tenants_id_uuidv7_chk", uuidV7(table.id)),
    check(
      "tenants_status_chk",
      sql`${table.status} IN ('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'CLOSED')`,
    ),
    check(
      "tenants_reporting_currency_chk",
      sql`${table.reportingCurrency} ~ '^[A-Z]{3}$'`,
    ),
    check("tenants_policy_version_chk", sql`${table.policyVersion} > 0`),
    check("tenants_version_chk", sql`${table.version} > 0`),
  ],
).enableRLS();

export const organizationsTable = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "restrict" }),
    legalName: text("legal_name").notNull(),
    displayName: text("display_name").notNull(),
    registrationCountry: text("registration_country"),
    registrationNumber: text("registration_number"),
    organizationType: text("organization_type").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    unique("organizations_tenant_id_id_uq").on(table.tenantId, table.id),
    index("organizations_tenant_status_idx").on(table.tenantId, table.status),
    check("organizations_id_uuidv7_chk", uuidV7(table.id)),
    check(
      "organizations_type_chk",
      sql`${table.organizationType} IN ('INTERNAL_LEGAL_ENTITY', 'OPERATING_ENTITY')`,
    ),
    check(
      "organizations_status_chk",
      sql`${table.status} IN ('ACTIVE', 'SUSPENDED', 'CLOSED')`,
    ),
    check("organizations_version_chk", sql`${table.version} > 0`),
  ],
).enableRLS();

export const tenantOrganizationLegacyBranchesTable = pgTable(
  "tenant_organization_legacy_branches",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id").notNull(),
    legacyBranchId: integer("legacy_branch_id")
      .notNull()
      .references(() => branchesTable.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.organizationId, table.legacyBranchId],
      name: "tenant_organization_legacy_branches_pk",
    }),
    unique("tenant_organization_legacy_branches_branch_uq").on(
      table.legacyBranchId,
    ),
    foreignKey({
      columns: [table.tenantId, table.organizationId],
      foreignColumns: [organizationsTable.tenantId, organizationsTable.id],
      name: "tenant_organization_legacy_branches_organization_fk",
    }).onDelete("restrict"),
  ],
).enableRLS();

export const principalsTable = pgTable(
  "principals",
  {
    id: uuid("id").primaryKey(),
    principalType: text("principal_type").notNull(),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    legacyUserId: integer("legacy_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("ACTIVE"),
    riskState: text("risk_state").notNull().default("NORMAL"),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("principals_issuer_subject_uq").on(table.issuer, table.subject),
    uniqueIndex("principals_legacy_user_id_uidx")
      .on(table.legacyUserId)
      .where(sql`${table.legacyUserId} IS NOT NULL`),
    check("principals_id_uuidv7_chk", uuidV7(table.id)),
    check(
      "principals_type_chk",
      sql`${table.principalType} IN ('HUMAN', 'SERVICE', 'INTEGRATION', 'AI')`,
    ),
    check(
      "principals_status_chk",
      sql`${table.status} IN ('ACTIVE', 'SUSPENDED', 'REVOKED')`,
    ),
    check(
      "principals_risk_state_chk",
      sql`${table.riskState} IN ('NORMAL', 'STEP_UP_REQUIRED', 'LOCKED')`,
    ),
    check("principals_version_chk", sql`${table.version} > 0`),
  ],
);

export const membershipsTable = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id"),
    legacyBranchId: integer("legacy_branch_id").references(
      () => branchesTable.id,
      { onDelete: "restrict" },
    ),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principalsTable.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("PENDING"),
    validFrom: timestamp("valid_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("memberships_tenant_id_id_uq").on(table.tenantId, table.id),
    unique("memberships_tenant_id_id_principal_id_uq").on(
      table.tenantId,
      table.id,
      table.principalId,
    ),
    index("memberships_principal_tenant_status_idx").on(
      table.principalId,
      table.tenantId,
      table.status,
    ),
    foreignKey({
      columns: [table.tenantId, table.organizationId],
      foreignColumns: [organizationsTable.tenantId, organizationsTable.id],
      name: "memberships_tenant_organization_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.organizationId, table.legacyBranchId],
      foreignColumns: [
        tenantOrganizationLegacyBranchesTable.tenantId,
        tenantOrganizationLegacyBranchesTable.organizationId,
        tenantOrganizationLegacyBranchesTable.legacyBranchId,
      ],
      name: "memberships_tenant_organization_branch_fk",
    }).onDelete("restrict"),
    check("memberships_id_uuidv7_chk", uuidV7(table.id)),
    check(
      "memberships_status_chk",
      sql`${table.status} IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED')`,
    ),
    check(
      "memberships_validity_chk",
      sql`${table.validUntil} IS NULL OR ${table.validUntil} > ${table.validFrom}`,
    ),
    check(
      "memberships_branch_requires_organization_chk",
      sql`${table.legacyBranchId} IS NULL OR ${table.organizationId} IS NOT NULL`,
    ),
    check("memberships_version_chk", sql`${table.version} > 0`),
  ],
).enableRLS();

export const capabilityDefinitionsTable = pgTable(
  "capability_definitions",
  {
    key: text("key").primaryKey(),
    description: text("description").notNull(),
    riskClass: text("risk_class").notNull().default("LOW"),
    delegable: boolean("delegable").notNull().default(false),
    stepUpRequired: boolean("step_up_required").notNull().default(false),
    approvalRequired: boolean("approval_required").notNull().default(false),
    status: text("status").notNull().default("ACTIVE"),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check(
      "capability_definitions_key_chk",
      sql`${table.key} ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*){1,2}$'`,
    ),
    check(
      "capability_definitions_risk_chk",
      sql`${table.riskClass} IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')`,
    ),
    check(
      "capability_definitions_status_chk",
      sql`${table.status} IN ('ACTIVE', 'DEPRECATED', 'REVOKED')`,
    ),
    check("capability_definitions_version_chk", sql`${table.version} > 0`),
  ],
);

export const roleDefinitionsTable = pgTable(
  "role_definitions",
  {
    id: uuid("id").primaryKey(),
    key: text("key").notNull().unique(),
    displayName: text("display_name").notNull(),
    purpose: text("purpose").notNull(),
    principalType: text("principal_type").notNull(),
    status: text("status").notNull().default("DRAFT"),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check("role_definitions_id_uuidv7_chk", uuidV7(table.id)),
    check(
      "role_definitions_key_chk",
      sql`${table.key} ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$'`,
    ),
    check(
      "role_definitions_principal_type_chk",
      sql`${table.principalType} IN ('HUMAN', 'SERVICE', 'INTEGRATION', 'AI')`,
    ),
    check(
      "role_definitions_status_chk",
      sql`${table.status} IN ('DRAFT', 'ACTIVE', 'DEPRECATED', 'REVOKED')`,
    ),
    check("role_definitions_version_chk", sql`${table.version} > 0`),
  ],
);

export const rolePackageVersionsTable = pgTable(
  "role_package_versions",
  {
    id: uuid("id").primaryKey(),
    roleDefinitionId: uuid("role_definition_id")
      .notNull()
      .references(() => roleDefinitionsTable.id, { onDelete: "restrict" }),
    versionNumber: bigint("version_number", { mode: "number" }).notNull(),
    status: text("status").notNull().default("DRAFT"),
    defaultScopeType: text("default_scope_type").notNull(),
    constraintDocument: jsonb("constraint_document")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    checksum: text("checksum").notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }),
    deprecatedAt: timestamp("deprecated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("role_package_versions_definition_version_uq").on(
      table.roleDefinitionId,
      table.versionNumber,
    ),
    check("role_package_versions_id_uuidv7_chk", uuidV7(table.id)),
    check(
      "role_package_versions_status_chk",
      sql`${table.status} IN ('DRAFT', 'ACTIVE', 'DEPRECATED', 'REVOKED')`,
    ),
    check(
      "role_package_versions_scope_chk",
      sql`${table.defaultScopeType} IN ('TENANT', 'ORGANIZATION', 'LEGACY_BRANCH')`,
    ),
    check(
      "role_package_versions_version_chk",
      sql`${table.versionNumber} > 0`,
    ),
    check(
      "role_package_versions_effective_window_chk",
      sql`${table.deprecatedAt} IS NULL OR ${table.effectiveAt} IS NULL OR ${table.deprecatedAt} > ${table.effectiveAt}`,
    ),
  ],
);

export const rolePackageCapabilitiesTable = pgTable(
  "role_package_capabilities",
  {
    rolePackageVersionId: uuid("role_package_version_id")
      .notNull()
      .references(() => rolePackageVersionsTable.id, { onDelete: "cascade" }),
    capabilityKey: text("capability_key")
      .notNull()
      .references(() => capabilityDefinitionsTable.key, {
        onDelete: "restrict",
      }),
    effect: text("effect").notNull().default("ALLOW"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.rolePackageVersionId, table.capabilityKey],
    }),
    check(
      "role_package_capabilities_effect_chk",
      sql`${table.effect} IN ('ALLOW', 'DENY')`,
    ),
  ],
);

export const policyVersionsTable = pgTable(
  "policy_versions",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "restrict" }),
    versionNumber: bigint("version_number", { mode: "number" }).notNull(),
    checksum: text("checksum").notNull(),
    state: text("state").notNull().default("DRAFT"),
    predicateDocument: jsonb("predicate_document")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    effectiveAt: timestamp("effective_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("policy_versions_tenant_id_id_uq").on(table.tenantId, table.id),
    unique("policy_versions_tenant_version_uq").on(
      table.tenantId,
      table.versionNumber,
    ),
    check("policy_versions_id_uuidv7_chk", uuidV7(table.id)),
    check(
      "policy_versions_state_chk",
      sql`${table.state} IN ('DRAFT', 'ACTIVE', 'REVOKED')`,
    ),
    check("policy_versions_version_chk", sql`${table.versionNumber} > 0`),
  ],
).enableRLS();

export const authorizationChangeReceiptsTable = pgTable(
  "authorization_change_receipts",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "restrict" }),
    receiptType: text("receipt_type").notNull(),
    actorPrincipalId: uuid("actor_principal_id")
      .notNull()
      .references(() => principalsTable.id, { onDelete: "restrict" }),
    actorMembershipId: uuid("actor_membership_id").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    reasonCode: text("reason_code").notNull(),
    correlationId: text("correlation_id").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    previousHash: text("previous_hash"),
    receiptHash: text("receipt_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("authorization_change_receipts_tenant_id_id_uq").on(
      table.tenantId,
      table.id,
    ),
    unique("authorization_change_receipts_tenant_hash_uq").on(
      table.tenantId,
      table.receiptHash,
    ),
    unique("authorization_change_receipts_grant_binding_uq").on(
      table.tenantId,
      table.id,
      table.resourceId,
      table.receiptType,
    ),
    index("authorization_change_receipts_tenant_created_idx").on(
      table.tenantId,
      table.createdAt,
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
      name: "authorization_change_receipts_actor_membership_fk",
    }).onDelete("restrict"),
    check("authorization_change_receipts_id_uuidv7_chk", uuidV7(table.id)),
    check(
      "authorization_change_receipts_resource_uuidv7_chk",
      uuidV7(table.resourceId),
    ),
    check(
      "authorization_change_receipts_type_chk",
      sql`${table.receiptType} IN ('GRANT', 'REVOKE', 'RENEW', 'SUSPEND')`,
    ),
  ],
).enableRLS();

export const accessAssignmentsTable = pgTable(
  "access_assignments",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "restrict" }),
    membershipId: uuid("membership_id").notNull(),
    rolePackageVersionId: uuid("role_package_version_id")
      .notNull()
      .references(() => rolePackageVersionsTable.id, { onDelete: "restrict" }),
    scopeType: text("scope_type").notNull(),
    organizationId: uuid("organization_id"),
    legacyBranchId: integer("legacy_branch_id").references(
      () => branchesTable.id,
      { onDelete: "restrict" },
    ),
    constraintDocument: jsonb("constraint_document")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: text("status").notNull().default("ACTIVE"),
    validFrom: timestamp("valid_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    grantedByPrincipalId: uuid("granted_by_principal_id")
      .notNull()
      .references(() => principalsTable.id, { onDelete: "restrict" }),
    grantedByMembershipId: uuid("granted_by_membership_id").notNull(),
    grantReceiptId: uuid("grant_receipt_id").notNull(),
    grantReceiptType: text("grant_receipt_type").notNull().default("GRANT"),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("access_assignments_tenant_id_id_uq").on(table.tenantId, table.id),
    index("access_assignments_membership_status_idx").on(
      table.tenantId,
      table.membershipId,
      table.status,
    ),
    foreignKey({
      columns: [table.tenantId, table.membershipId],
      foreignColumns: [membershipsTable.tenantId, membershipsTable.id],
      name: "access_assignments_tenant_membership_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.organizationId],
      foreignColumns: [organizationsTable.tenantId, organizationsTable.id],
      name: "access_assignments_tenant_organization_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.organizationId, table.legacyBranchId],
      foreignColumns: [
        tenantOrganizationLegacyBranchesTable.tenantId,
        tenantOrganizationLegacyBranchesTable.organizationId,
        tenantOrganizationLegacyBranchesTable.legacyBranchId,
      ],
      name: "access_assignments_tenant_organization_branch_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.tenantId,
        table.grantedByMembershipId,
        table.grantedByPrincipalId,
      ],
      foreignColumns: [
        membershipsTable.tenantId,
        membershipsTable.id,
        membershipsTable.principalId,
      ],
      name: "access_assignments_grantor_membership_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.tenantId,
        table.grantReceiptId,
        table.id,
        table.grantReceiptType,
      ],
      foreignColumns: [
        authorizationChangeReceiptsTable.tenantId,
        authorizationChangeReceiptsTable.id,
        authorizationChangeReceiptsTable.resourceId,
        authorizationChangeReceiptsTable.receiptType,
      ],
      name: "access_assignments_tenant_grant_receipt_fk",
    }).onDelete("restrict"),
    check("access_assignments_id_uuidv7_chk", uuidV7(table.id)),
    check(
      "access_assignments_grant_receipt_type_chk",
      sql`${table.grantReceiptType} = 'GRANT'`,
    ),
    check(
      "access_assignments_status_chk",
      sql`${table.status} IN ('ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED')`,
    ),
    check(
      "access_assignments_scope_chk",
      sql`(
        (${table.scopeType} = 'TENANT' AND ${table.organizationId} IS NULL AND ${table.legacyBranchId} IS NULL)
        OR (${table.scopeType} = 'ORGANIZATION' AND ${table.organizationId} IS NOT NULL AND ${table.legacyBranchId} IS NULL)
        OR (${table.scopeType} = 'LEGACY_BRANCH' AND ${table.organizationId} IS NOT NULL AND ${table.legacyBranchId} IS NOT NULL)
      )`,
    ),
    check(
      "access_assignments_validity_chk",
      sql`${table.validUntil} IS NULL OR ${table.validUntil} > ${table.validFrom}`,
    ),
    check("access_assignments_version_chk", sql`${table.version} > 0`),
  ],
).enableRLS();

export const accessDecisionReceiptsTable = pgTable(
  "access_decision_receipts",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "restrict" }),
    contextId: uuid("context_id").notNull(),
    actorPrincipalId: uuid("actor_principal_id")
      .notNull()
      .references(() => principalsTable.id, { onDelete: "restrict" }),
    membershipId: uuid("membership_id").notNull(),
    assignmentIds: uuid("assignment_ids").array().notNull(),
    rolePackageVersionIds: uuid("role_package_version_ids").array().notNull(),
    capabilityKey: text("capability_key")
      .notNull()
      .references(() => capabilityDefinitionsTable.key, {
        onDelete: "restrict",
      }),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    decision: text("decision").notNull(),
    reasonCode: text("reason_code").notNull(),
    policyVersionId: uuid("policy_version_id").notNull(),
    correlationId: text("correlation_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.membershipId],
      foreignColumns: [membershipsTable.tenantId, membershipsTable.id],
      name: "access_decision_receipts_tenant_membership_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.membershipId, table.actorPrincipalId],
      foreignColumns: [
        membershipsTable.tenantId,
        membershipsTable.id,
        membershipsTable.principalId,
      ],
      name: "access_decision_receipts_actor_membership_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.policyVersionId],
      foreignColumns: [policyVersionsTable.tenantId, policyVersionsTable.id],
      name: "access_decision_receipts_tenant_policy_fk",
    }).onDelete("restrict"),
    index("access_decision_receipts_tenant_occurred_idx").on(
      table.tenantId,
      table.occurredAt,
    ),
    index("access_decision_receipts_correlation_idx").on(table.correlationId),
    check("access_decision_receipts_id_uuidv7_chk", uuidV7(table.id)),
    check("access_decision_receipts_context_uuidv7_chk", uuidV7(table.contextId)),
    check(
      "access_decision_receipts_decision_chk",
      sql`${table.decision} IN ('ALLOW', 'DENY')`,
    ),
  ],
).enableRLS();

export type Tenant = typeof tenantsTable.$inferSelect;
export type Organization = typeof organizationsTable.$inferSelect;
export type TenantOrganizationLegacyBranch =
  typeof tenantOrganizationLegacyBranchesTable.$inferSelect;
export type Principal = typeof principalsTable.$inferSelect;
export type Membership = typeof membershipsTable.$inferSelect;
export type AccessAssignment = typeof accessAssignmentsTable.$inferSelect;
export type PolicyVersion = typeof policyVersionsTable.$inferSelect;
