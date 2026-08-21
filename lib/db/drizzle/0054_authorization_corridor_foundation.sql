-- Additive, default-unwired authorization corridor foundation.
-- UUID values are caller-generated UUIDv7; no database extension is assumed.

CREATE TABLE "tenants" (
  "id" uuid PRIMARY KEY NOT NULL,
  "slug" text NOT NULL,
  "legal_name" text NOT NULL,
  "display_name" text NOT NULL,
  "status" text DEFAULT 'PROVISIONING' NOT NULL,
  "home_region" text NOT NULL,
  "default_locale" text DEFAULT 'en' NOT NULL,
  "default_timezone" text DEFAULT 'UTC' NOT NULL,
  "reporting_currency" text DEFAULT 'USD' NOT NULL,
  "policy_version" bigint DEFAULT 1 NOT NULL,
  "version" bigint DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "suspended_at" timestamp with time zone,
  "closed_at" timestamp with time zone,
  CONSTRAINT "tenants_id_uuidv7_chk" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "tenants_status_chk" CHECK ("status" IN ('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'CLOSED')),
  CONSTRAINT "tenants_reporting_currency_chk" CHECK ("reporting_currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "tenants_policy_version_chk" CHECK ("policy_version" > 0),
  CONSTRAINT "tenants_version_chk" CHECK ("version" > 0)
);

CREATE UNIQUE INDEX "tenants_slug_lower_uidx" ON "tenants" (lower("slug"));

CREATE TABLE "organizations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL,
  "legal_name" text NOT NULL,
  "display_name" text NOT NULL,
  "registration_country" text,
  "registration_number" text,
  "organization_type" text NOT NULL,
  "status" text DEFAULT 'ACTIVE' NOT NULL,
  "version" bigint DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "closed_at" timestamp with time zone,
  CONSTRAINT "organizations_tenant_id_id_uq" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "organizations_id_uuidv7_chk" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "organizations_type_chk" CHECK ("organization_type" IN ('INTERNAL_LEGAL_ENTITY', 'OPERATING_ENTITY')),
  CONSTRAINT "organizations_status_chk" CHECK ("status" IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  CONSTRAINT "organizations_version_chk" CHECK ("version" > 0),
  CONSTRAINT "organizations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT
);

CREATE INDEX "organizations_tenant_status_idx" ON "organizations" ("tenant_id", "status");

CREATE TABLE "principals" (
  "id" uuid PRIMARY KEY NOT NULL,
  "principal_type" text NOT NULL,
  "issuer" text NOT NULL,
  "subject" text NOT NULL,
  "legacy_user_id" integer,
  "status" text DEFAULT 'ACTIVE' NOT NULL,
  "risk_state" text DEFAULT 'NORMAL' NOT NULL,
  "version" bigint DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "principals_issuer_subject_uq" UNIQUE ("issuer", "subject"),
  CONSTRAINT "principals_id_uuidv7_chk" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "principals_type_chk" CHECK ("principal_type" IN ('HUMAN', 'SERVICE', 'INTEGRATION', 'AI')),
  CONSTRAINT "principals_status_chk" CHECK ("status" IN ('ACTIVE', 'SUSPENDED', 'REVOKED')),
  CONSTRAINT "principals_risk_state_chk" CHECK ("risk_state" IN ('NORMAL', 'STEP_UP_REQUIRED', 'LOCKED')),
  CONSTRAINT "principals_version_chk" CHECK ("version" > 0),
  CONSTRAINT "principals_legacy_user_id_users_id_fk" FOREIGN KEY ("legacy_user_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX "principals_legacy_user_id_uidx" ON "principals" ("legacy_user_id") WHERE "legacy_user_id" IS NOT NULL;

CREATE TABLE "memberships" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL,
  "organization_id" uuid,
  "legacy_branch_id" integer,
  "principal_id" uuid NOT NULL,
  "status" text DEFAULT 'PENDING' NOT NULL,
  "valid_from" timestamp with time zone DEFAULT now() NOT NULL,
  "valid_until" timestamp with time zone,
  "version" bigint DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "memberships_tenant_id_id_uq" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "memberships_id_uuidv7_chk" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "memberships_status_chk" CHECK ("status" IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED')),
  CONSTRAINT "memberships_validity_chk" CHECK ("valid_until" IS NULL OR "valid_until" > "valid_from"),
  CONSTRAINT "memberships_version_chk" CHECK ("version" > 0),
  CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
  CONSTRAINT "memberships_tenant_organization_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "memberships_legacy_branch_id_branches_id_fk" FOREIGN KEY ("legacy_branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT,
  CONSTRAINT "memberships_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE RESTRICT
);

CREATE INDEX "memberships_principal_tenant_status_idx" ON "memberships" ("principal_id", "tenant_id", "status");

CREATE TABLE "capability_definitions" (
  "key" text PRIMARY KEY NOT NULL,
  "description" text NOT NULL,
  "risk_class" text DEFAULT 'LOW' NOT NULL,
  "delegable" boolean DEFAULT false NOT NULL,
  "step_up_required" boolean DEFAULT false NOT NULL,
  "approval_required" boolean DEFAULT false NOT NULL,
  "status" text DEFAULT 'ACTIVE' NOT NULL,
  "version" bigint DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "capability_definitions_key_chk" CHECK ("key" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,2}$'),
  CONSTRAINT "capability_definitions_risk_chk" CHECK ("risk_class" IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  CONSTRAINT "capability_definitions_status_chk" CHECK ("status" IN ('ACTIVE', 'DEPRECATED', 'REVOKED')),
  CONSTRAINT "capability_definitions_version_chk" CHECK ("version" > 0)
);

CREATE TABLE "role_definitions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "key" text NOT NULL UNIQUE,
  "display_name" text NOT NULL,
  "purpose" text NOT NULL,
  "principal_type" text NOT NULL,
  "status" text DEFAULT 'DRAFT' NOT NULL,
  "version" bigint DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "role_definitions_id_uuidv7_chk" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "role_definitions_key_chk" CHECK ("key" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  CONSTRAINT "role_definitions_principal_type_chk" CHECK ("principal_type" IN ('HUMAN', 'SERVICE', 'INTEGRATION', 'AI')),
  CONSTRAINT "role_definitions_status_chk" CHECK ("status" IN ('DRAFT', 'ACTIVE', 'DEPRECATED', 'REVOKED')),
  CONSTRAINT "role_definitions_version_chk" CHECK ("version" > 0)
);

CREATE TABLE "role_package_versions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "role_definition_id" uuid NOT NULL,
  "version_number" bigint NOT NULL,
  "status" text DEFAULT 'DRAFT' NOT NULL,
  "default_scope_type" text NOT NULL,
  "constraint_document" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "checksum" text NOT NULL,
  "effective_at" timestamp with time zone,
  "deprecated_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "role_package_versions_definition_version_uq" UNIQUE ("role_definition_id", "version_number"),
  CONSTRAINT "role_package_versions_id_uuidv7_chk" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "role_package_versions_status_chk" CHECK ("status" IN ('DRAFT', 'ACTIVE', 'DEPRECATED', 'REVOKED')),
  CONSTRAINT "role_package_versions_scope_chk" CHECK ("default_scope_type" IN ('TENANT', 'ORGANIZATION', 'LEGACY_BRANCH')),
  CONSTRAINT "role_package_versions_version_chk" CHECK ("version_number" > 0),
  CONSTRAINT "role_package_versions_effective_window_chk" CHECK ("deprecated_at" IS NULL OR "effective_at" IS NULL OR "deprecated_at" > "effective_at"),
  CONSTRAINT "role_package_versions_role_definition_id_role_definitions_id_fk" FOREIGN KEY ("role_definition_id") REFERENCES "role_definitions"("id") ON DELETE RESTRICT
);

CREATE TABLE "role_package_capabilities" (
  "role_package_version_id" uuid NOT NULL,
  "capability_key" text NOT NULL,
  "effect" text DEFAULT 'ALLOW' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "role_package_capabilities_role_package_version_id_capability_key_pk" PRIMARY KEY ("role_package_version_id", "capability_key"),
  CONSTRAINT "role_package_capabilities_effect_chk" CHECK ("effect" IN ('ALLOW', 'DENY')),
  CONSTRAINT "role_package_capabilities_role_package_version_id_role_package_versions_id_fk" FOREIGN KEY ("role_package_version_id") REFERENCES "role_package_versions"("id") ON DELETE CASCADE,
  CONSTRAINT "role_package_capabilities_capability_key_capability_definitions_key_fk" FOREIGN KEY ("capability_key") REFERENCES "capability_definitions"("key") ON DELETE RESTRICT
);

CREATE TABLE "policy_versions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL,
  "version_number" bigint NOT NULL,
  "checksum" text NOT NULL,
  "state" text DEFAULT 'DRAFT' NOT NULL,
  "predicate_document" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "effective_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "policy_versions_tenant_id_id_uq" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "policy_versions_tenant_version_uq" UNIQUE ("tenant_id", "version_number"),
  CONSTRAINT "policy_versions_id_uuidv7_chk" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "policy_versions_state_chk" CHECK ("state" IN ('DRAFT', 'ACTIVE', 'REVOKED')),
  CONSTRAINT "policy_versions_version_chk" CHECK ("version_number" > 0),
  CONSTRAINT "policy_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT
);

CREATE TABLE "authorization_change_receipts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL,
  "receipt_type" text NOT NULL,
  "actor_principal_id" uuid NOT NULL,
  "resource_type" text NOT NULL,
  "resource_id" uuid NOT NULL,
  "reason_code" text NOT NULL,
  "correlation_id" text NOT NULL,
  "evidence" jsonb NOT NULL,
  "previous_hash" text,
  "receipt_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "authorization_change_receipts_tenant_id_id_uq" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "authorization_change_receipts_tenant_hash_uq" UNIQUE ("tenant_id", "receipt_hash"),
  CONSTRAINT "authorization_change_receipts_grant_binding_uq" UNIQUE ("tenant_id", "id", "resource_id", "receipt_type"),
  CONSTRAINT "authorization_change_receipts_id_uuidv7_chk" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "authorization_change_receipts_resource_uuidv7_chk" CHECK (substring("resource_id"::text from 15 for 1) = '7'),
  CONSTRAINT "authorization_change_receipts_type_chk" CHECK ("receipt_type" IN ('GRANT', 'REVOKE', 'RENEW', 'SUSPEND')),
  CONSTRAINT "authorization_change_receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
  CONSTRAINT "authorization_change_receipts_actor_principal_id_principals_id_fk" FOREIGN KEY ("actor_principal_id") REFERENCES "principals"("id") ON DELETE RESTRICT
);

CREATE INDEX "authorization_change_receipts_tenant_created_idx" ON "authorization_change_receipts" ("tenant_id", "created_at");

CREATE TABLE "access_assignments" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL,
  "membership_id" uuid NOT NULL,
  "role_package_version_id" uuid NOT NULL,
  "scope_type" text NOT NULL,
  "organization_id" uuid,
  "legacy_branch_id" integer,
  "constraint_document" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'ACTIVE' NOT NULL,
  "valid_from" timestamp with time zone DEFAULT now() NOT NULL,
  "valid_until" timestamp with time zone,
  "granted_by_principal_id" uuid NOT NULL,
  "grant_receipt_id" uuid NOT NULL,
  "grant_receipt_type" text DEFAULT 'GRANT' NOT NULL,
  "version" bigint DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "access_assignments_tenant_id_id_uq" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "access_assignments_id_uuidv7_chk" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "access_assignments_grant_receipt_type_chk" CHECK ("grant_receipt_type" = 'GRANT'),
  CONSTRAINT "access_assignments_status_chk" CHECK ("status" IN ('ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED')),
  CONSTRAINT "access_assignments_scope_chk" CHECK (
    ("scope_type" = 'TENANT' AND "organization_id" IS NULL AND "legacy_branch_id" IS NULL)
    OR ("scope_type" = 'ORGANIZATION' AND "organization_id" IS NOT NULL AND "legacy_branch_id" IS NULL)
    OR ("scope_type" = 'LEGACY_BRANCH' AND "organization_id" IS NOT NULL AND "legacy_branch_id" IS NOT NULL)
  ),
  CONSTRAINT "access_assignments_validity_chk" CHECK ("valid_until" IS NULL OR "valid_until" > "valid_from"),
  CONSTRAINT "access_assignments_version_chk" CHECK ("version" > 0),
  CONSTRAINT "access_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
  CONSTRAINT "access_assignments_tenant_membership_fk" FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "memberships"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "access_assignments_role_package_version_id_role_package_versions_id_fk" FOREIGN KEY ("role_package_version_id") REFERENCES "role_package_versions"("id") ON DELETE RESTRICT,
  CONSTRAINT "access_assignments_tenant_organization_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "access_assignments_legacy_branch_id_branches_id_fk" FOREIGN KEY ("legacy_branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT,
  CONSTRAINT "access_assignments_granted_by_principal_id_principals_id_fk" FOREIGN KEY ("granted_by_principal_id") REFERENCES "principals"("id") ON DELETE RESTRICT,
  CONSTRAINT "access_assignments_tenant_grant_receipt_fk" FOREIGN KEY ("tenant_id", "grant_receipt_id", "id", "grant_receipt_type") REFERENCES "authorization_change_receipts"("tenant_id", "id", "resource_id", "receipt_type") ON DELETE RESTRICT
);

CREATE INDEX "access_assignments_membership_status_idx" ON "access_assignments" ("tenant_id", "membership_id", "status");

CREATE TABLE "access_decision_receipts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL,
  "context_id" uuid NOT NULL,
  "actor_principal_id" uuid NOT NULL,
  "membership_id" uuid NOT NULL,
  "assignment_ids" uuid[] NOT NULL,
  "role_package_version_ids" uuid[] NOT NULL,
  "capability_key" text NOT NULL,
  "resource_type" text NOT NULL,
  "resource_id" text NOT NULL,
  "decision" text NOT NULL,
  "reason_code" text NOT NULL,
  "policy_version_id" uuid NOT NULL,
  "correlation_id" text NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "access_decision_receipts_id_uuidv7_chk" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "access_decision_receipts_context_uuidv7_chk" CHECK (substring("context_id"::text from 15 for 1) = '7'),
  CONSTRAINT "access_decision_receipts_decision_chk" CHECK ("decision" IN ('ALLOW', 'DENY')),
  CONSTRAINT "access_decision_receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
  CONSTRAINT "access_decision_receipts_actor_principal_id_principals_id_fk" FOREIGN KEY ("actor_principal_id") REFERENCES "principals"("id") ON DELETE RESTRICT,
  CONSTRAINT "access_decision_receipts_tenant_membership_fk" FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "memberships"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "access_decision_receipts_capability_key_capability_definitions_key_fk" FOREIGN KEY ("capability_key") REFERENCES "capability_definitions"("key") ON DELETE RESTRICT,
  CONSTRAINT "access_decision_receipts_tenant_policy_fk" FOREIGN KEY ("tenant_id", "policy_version_id") REFERENCES "policy_versions"("tenant_id", "id") ON DELETE RESTRICT
);

CREATE INDEX "access_decision_receipts_tenant_occurred_idx" ON "access_decision_receipts" ("tenant_id", "occurred_at");
CREATE INDEX "access_decision_receipts_correlation_idx" ON "access_decision_receipts" ("correlation_id");

-- Tenant-owned authorization tables are fail-closed unless server-side code
-- has set app.tenant_id for the transaction. No client header/body value may
-- be copied into this setting.
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;
ALTER TABLE "policy_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "policy_versions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "authorization_change_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "authorization_change_receipts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "access_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "access_assignments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "access_decision_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "access_decision_receipts" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenants_select_same_tenant" ON "tenants" FOR SELECT
  USING ("id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "tenants_insert_same_tenant" ON "tenants" FOR INSERT
  WITH CHECK ("id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "tenants_update_same_tenant" ON "tenants" FOR UPDATE
  USING ("id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "organizations_select_same_tenant" ON "organizations" FOR SELECT
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "organizations_insert_same_tenant" ON "organizations" FOR INSERT
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "organizations_update_same_tenant" ON "organizations" FOR UPDATE
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "memberships_select_same_tenant" ON "memberships" FOR SELECT
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "memberships_insert_same_tenant" ON "memberships" FOR INSERT
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "memberships_update_same_tenant" ON "memberships" FOR UPDATE
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "policy_versions_select_same_tenant" ON "policy_versions" FOR SELECT
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "policy_versions_insert_same_tenant" ON "policy_versions" FOR INSERT
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "policy_versions_update_same_tenant" ON "policy_versions" FOR UPDATE
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "authorization_change_receipts_select_same_tenant" ON "authorization_change_receipts" FOR SELECT
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "authorization_change_receipts_insert_same_tenant" ON "authorization_change_receipts" FOR INSERT
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "access_assignments_select_same_tenant" ON "access_assignments" FOR SELECT
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "access_assignments_insert_same_tenant" ON "access_assignments" FOR INSERT
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "access_assignments_update_same_tenant" ON "access_assignments" FOR UPDATE
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "access_decision_receipts_select_same_tenant" ON "access_decision_receipts" FOR SELECT
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "access_decision_receipts_insert_same_tenant" ON "access_decision_receipts" FOR INSERT
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE FUNCTION "prevent_authorization_receipt_mutation"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'authorization receipts are immutable';
END;
$$;

CREATE TRIGGER "authorization_change_receipts_immutable"
  BEFORE UPDATE OR DELETE ON "authorization_change_receipts"
  FOR EACH ROW EXECUTE FUNCTION "prevent_authorization_receipt_mutation"();

CREATE TRIGGER "access_decision_receipts_immutable"
  BEFORE UPDATE OR DELETE ON "access_decision_receipts"
  FOR EACH ROW EXECUTE FUNCTION "prevent_authorization_receipt_mutation"();
