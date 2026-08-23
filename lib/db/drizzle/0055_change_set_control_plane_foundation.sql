-- Additive, default-unwired R1 ChangeSet control-plane foundation.
-- Only reversible, single-tenant typed configuration is admitted by this v0.

CREATE TABLE "change_sets" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL,
  "change_type" text NOT NULL,
  "title" text NOT NULL,
  "purpose" text NOT NULL,
  "owner_principal_id" uuid NOT NULL,
  "maker_principal_id" uuid NOT NULL,
  "checker_principal_id" uuid,
  "target_scope_type" text NOT NULL,
  "target_organization_id" uuid,
  "target_legacy_branch_id" integer,
  "base_version" bigint NOT NULL,
  "base_hash" text NOT NULL,
  "proposed_version" bigint NOT NULL,
  "proposed_hash" text NOT NULL,
  "base_config" jsonb NOT NULL,
  "proposed_config" jsonb NOT NULL,
  "dependency_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "compatibility_range" text NOT NULL,
  "risk_tier" text DEFAULT 'R1' NOT NULL,
  "data_class" text NOT NULL,
  "affected_tenant_count" integer DEFAULT 1 NOT NULL,
  "affected_branch_count" integer DEFAULT 0 NOT NULL,
  "affected_principal_count" integer DEFAULT 0 NOT NULL,
  "affected_case_count" integer DEFAULT 0 NOT NULL,
  "affected_integration_count" integer DEFAULT 0 NOT NULL,
  "semantic_diff" jsonb NOT NULL,
  "validation_result" jsonb,
  "simulation_result" jsonb,
  "test_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "approval_policy_version" text NOT NULL,
  "rollout_strategy" jsonb NOT NULL,
  "canary_scope" jsonb NOT NULL,
  "scheduled_at" timestamp with time zone,
  "abort_conditions" jsonb NOT NULL,
  "observation_window_seconds" integer DEFAULT 3600 NOT NULL,
  "rollback_strategy" jsonb NOT NULL,
  "linked_artifacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'DRAFT' NOT NULL,
  "status_reason" text,
  "review_round" integer DEFAULT 0 NOT NULL,
  "observation_started_at" timestamp with time zone,
  "version" bigint DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "published_at" timestamp with time zone,
  "effective_at" timestamp with time zone,
  "closed_at" timestamp with time zone,
  CONSTRAINT "change_sets_tenant_id_id_uq" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "change_sets_id_uuidv7_chk" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "change_sets_type_chk" CHECK ("change_type" IN ('BRAND', 'LOCALE', 'NOTIFICATION_TEMPLATE', 'FEATURE_FLAG', 'MAINTENANCE_BANNER')),
  CONSTRAINT "change_sets_scope_chk" CHECK (
    ("target_scope_type" = 'TENANT' AND "target_organization_id" IS NULL AND "target_legacy_branch_id" IS NULL)
    OR ("target_scope_type" = 'ORGANIZATION' AND "target_organization_id" IS NOT NULL AND "target_legacy_branch_id" IS NULL)
    OR ("target_scope_type" = 'LEGACY_BRANCH' AND "target_organization_id" IS NOT NULL AND "target_legacy_branch_id" IS NOT NULL)
  ),
  CONSTRAINT "change_sets_version_window_chk" CHECK ("base_version" >= 0 AND "proposed_version" = "base_version" + 1),
  CONSTRAINT "change_sets_hashes_chk" CHECK ("base_hash" ~ '^[0-9a-f]{64}$' AND "proposed_hash" ~ '^[0-9a-f]{64}$' AND "base_hash" <> "proposed_hash"),
  CONSTRAINT "change_sets_risk_tier_chk" CHECK ("risk_tier" = 'R1'),
  CONSTRAINT "change_sets_data_class_chk" CHECK ("data_class" IN ('PUBLIC', 'INTERNAL')),
  CONSTRAINT "change_sets_single_tenant_impact_chk" CHECK ("affected_tenant_count" = 1 AND "affected_branch_count" >= 0 AND "affected_principal_count" >= 0 AND "affected_case_count" >= 0 AND "affected_integration_count" >= 0),
  CONSTRAINT "change_sets_checker_separation_chk" CHECK ("checker_principal_id" IS NULL OR "checker_principal_id" <> "maker_principal_id"),
  CONSTRAINT "change_sets_observation_window_chk" CHECK ("observation_window_seconds" >= 3600),
  CONSTRAINT "change_sets_status_chk" CHECK ("status" IN ('DRAFT', 'VALIDATED', 'SIMULATED', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'CANARY', 'PUBLISHED', 'OBSERVING', 'EFFECTIVE', 'RETURNED', 'REJECTED', 'FAILED', 'ROLLED_BACK', 'REVOKED')),
  CONSTRAINT "change_sets_review_round_chk" CHECK ("review_round" >= 0),
  CONSTRAINT "change_sets_version_chk" CHECK ("version" > 0),
  CONSTRAINT "change_sets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
  CONSTRAINT "change_sets_owner_principal_id_principals_id_fk" FOREIGN KEY ("owner_principal_id") REFERENCES "principals"("id") ON DELETE RESTRICT,
  CONSTRAINT "change_sets_maker_principal_id_principals_id_fk" FOREIGN KEY ("maker_principal_id") REFERENCES "principals"("id") ON DELETE RESTRICT,
  CONSTRAINT "change_sets_checker_principal_id_principals_id_fk" FOREIGN KEY ("checker_principal_id") REFERENCES "principals"("id") ON DELETE RESTRICT,
  CONSTRAINT "change_sets_tenant_organization_fk" FOREIGN KEY ("tenant_id", "target_organization_id") REFERENCES "organizations"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "change_sets_target_legacy_branch_id_branches_id_fk" FOREIGN KEY ("target_legacy_branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT
);

CREATE INDEX "change_sets_tenant_status_created_idx" ON "change_sets" ("tenant_id", "status", "created_at");
CREATE INDEX "change_sets_checker_status_idx" ON "change_sets" ("checker_principal_id", "status");

CREATE TABLE "change_set_approvals" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL,
  "change_set_id" uuid NOT NULL,
  "review_round" integer NOT NULL,
  "checker_principal_id" uuid NOT NULL,
  "decision" text NOT NULL,
  "reason_code" text NOT NULL,
  "approval_policy_version" text NOT NULL,
  "step_up_receipt_id" uuid NOT NULL,
  "evidence" jsonb NOT NULL,
  "decision_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "change_set_approvals_tenant_hash_uq" UNIQUE ("tenant_id", "decision_hash"),
  CONSTRAINT "change_set_approvals_review_round_uq" UNIQUE ("tenant_id", "change_set_id", "review_round"),
  CONSTRAINT "change_set_approvals_id_uuidv7_chk" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "change_set_approvals_step_up_uuidv7_chk" CHECK (substring("step_up_receipt_id"::text from 15 for 1) = '7'),
  CONSTRAINT "change_set_approvals_decision_chk" CHECK ("decision" IN ('APPROVED', 'RETURNED', 'REJECTED')),
  CONSTRAINT "change_set_approvals_hash_chk" CHECK ("decision_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "change_set_approvals_review_round_chk" CHECK ("review_round" > 0),
  CONSTRAINT "change_set_approvals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
  CONSTRAINT "change_set_approvals_tenant_change_set_fk" FOREIGN KEY ("tenant_id", "change_set_id") REFERENCES "change_sets"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "change_set_approvals_checker_principal_id_principals_id_fk" FOREIGN KEY ("checker_principal_id") REFERENCES "principals"("id") ON DELETE RESTRICT
);

CREATE INDEX "change_set_approvals_change_set_created_idx" ON "change_set_approvals" ("tenant_id", "change_set_id", "created_at");

CREATE TABLE "change_set_transition_receipts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL,
  "change_set_id" uuid NOT NULL,
  "sequence" bigint NOT NULL,
  "actor_principal_id" uuid NOT NULL,
  "from_state" text,
  "to_state" text NOT NULL,
  "reason_code" text NOT NULL,
  "policy_version" text NOT NULL,
  "evidence" jsonb NOT NULL,
  "evidence_hash" text NOT NULL,
  "previous_hash" text,
  "receipt_hash" text NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "change_set_transition_receipts_tenant_sequence_uq" UNIQUE ("tenant_id", "change_set_id", "sequence"),
  CONSTRAINT "change_set_transition_receipts_tenant_hash_uq" UNIQUE ("tenant_id", "receipt_hash"),
  CONSTRAINT "change_set_transition_receipts_id_uuidv7_chk" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "change_set_transition_receipts_state_chk" CHECK ("from_state" IS NULL OR "from_state" IN ('DRAFT', 'VALIDATED', 'SIMULATED', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'CANARY', 'PUBLISHED', 'OBSERVING', 'EFFECTIVE', 'RETURNED', 'REJECTED', 'FAILED', 'ROLLED_BACK', 'REVOKED')),
  CONSTRAINT "change_set_transition_receipts_to_state_chk" CHECK ("to_state" IN ('DRAFT', 'VALIDATED', 'SIMULATED', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'CANARY', 'PUBLISHED', 'OBSERVING', 'EFFECTIVE', 'RETURNED', 'REJECTED', 'FAILED', 'ROLLED_BACK', 'REVOKED')),
  CONSTRAINT "change_set_transition_receipts_hashes_chk" CHECK ("evidence_hash" ~ '^[0-9a-f]{64}$' AND "receipt_hash" ~ '^[0-9a-f]{64}$' AND ("previous_hash" IS NULL OR "previous_hash" ~ '^[0-9a-f]{64}$')),
  CONSTRAINT "change_set_transition_receipts_sequence_chk" CHECK ("sequence" > 0),
  CONSTRAINT "change_set_transition_receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
  CONSTRAINT "change_set_transition_receipts_tenant_change_set_fk" FOREIGN KEY ("tenant_id", "change_set_id") REFERENCES "change_sets"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "change_set_transition_receipts_actor_principal_id_principals_id_fk" FOREIGN KEY ("actor_principal_id") REFERENCES "principals"("id") ON DELETE RESTRICT
);

CREATE INDEX "change_set_transition_receipts_tenant_occurred_idx" ON "change_set_transition_receipts" ("tenant_id", "occurred_at");

ALTER TABLE "change_sets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "change_sets" FORCE ROW LEVEL SECURITY;
ALTER TABLE "change_set_approvals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "change_set_approvals" FORCE ROW LEVEL SECURITY;
ALTER TABLE "change_set_transition_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "change_set_transition_receipts" FORCE ROW LEVEL SECURITY;

CREATE POLICY "change_sets_select_same_tenant" ON "change_sets" FOR SELECT
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "change_sets_insert_same_tenant" ON "change_sets" FOR INSERT
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "change_sets_update_same_tenant" ON "change_sets" FOR UPDATE
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "change_set_approvals_select_same_tenant" ON "change_set_approvals" FOR SELECT
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "change_set_approvals_insert_same_tenant" ON "change_set_approvals" FOR INSERT
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "change_set_transition_receipts_select_same_tenant" ON "change_set_transition_receipts" FOR SELECT
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "change_set_transition_receipts_insert_same_tenant" ON "change_set_transition_receipts" FOR INSERT
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE FUNCTION "enforce_change_set_checker_separation"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_maker uuid;
  current_status text;
  current_policy_version text;
  current_review_round integer;
BEGIN
  SELECT "maker_principal_id", "status", "approval_policy_version", "review_round"
    INTO current_maker, current_status, current_policy_version, current_review_round
  FROM "change_sets"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."change_set_id"
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'change set is not visible in the active tenant';
  END IF;
  IF current_maker = NEW."checker_principal_id" THEN
    RAISE EXCEPTION 'change set maker cannot act as checker';
  END IF;
  IF current_status <> 'IN_REVIEW' THEN
    RAISE EXCEPTION 'change set decision requires IN_REVIEW state';
  END IF;
  IF NEW."review_round" <> current_review_round THEN
    RAISE EXCEPTION 'change set decision review round mismatch';
  END IF;
  IF NEW."approval_policy_version" <> current_policy_version THEN
    RAISE EXCEPTION 'change set decision policy version mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "change_set_approvals_checker_separation"
  BEFORE INSERT ON "change_set_approvals"
  FOR EACH ROW EXECUTE FUNCTION "enforce_change_set_checker_separation"();

CREATE FUNCTION "enforce_change_set_initial_state"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" <> 'DRAFT'
    OR NEW."version" <> 1
    OR NEW."review_round" <> 0
    OR NEW."checker_principal_id" IS NOT NULL
    OR NEW."scheduled_at" IS NOT NULL
    OR NEW."observation_started_at" IS NOT NULL
    OR NEW."published_at" IS NOT NULL
    OR NEW."effective_at" IS NOT NULL
    OR NEW."closed_at" IS NOT NULL
  THEN
    RAISE EXCEPTION 'change set must be inserted in a clean DRAFT state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "change_sets_guard_initial_state"
  BEFORE INSERT ON "change_sets"
  FOR EACH ROW EXECUTE FUNCTION "enforce_change_set_initial_state"();

CREATE FUNCTION "enforce_change_set_receipt_chain"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_status text;
  current_version bigint;
  current_policy_version text;
  latest_hash text;
BEGIN
  SELECT "status", "version", "approval_policy_version"
    INTO current_status, current_version, current_policy_version
  FROM "change_sets"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "id" = NEW."change_set_id"
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'change set is not visible in the active tenant';
  END IF;
  IF NEW."sequence" <> current_version + 1 THEN
    RAISE EXCEPTION 'change set transition receipt sequence must follow current version';
  END IF;
  IF NEW."from_state" IS DISTINCT FROM current_status THEN
    RAISE EXCEPTION 'change set transition receipt source state mismatch';
  END IF;
  IF NEW."policy_version" <> current_policy_version THEN
    RAISE EXCEPTION 'change set transition receipt policy version mismatch';
  END IF;

  SELECT "receipt_hash"
    INTO latest_hash
  FROM "change_set_transition_receipts"
  WHERE "tenant_id" = NEW."tenant_id"
    AND "change_set_id" = NEW."change_set_id"
  ORDER BY "sequence" DESC
  LIMIT 1;

  IF latest_hash IS NULL AND NEW."previous_hash" IS NOT NULL THEN
    RAISE EXCEPTION 'first change set transition receipt cannot have a previous hash';
  END IF;
  IF latest_hash IS NOT NULL AND NEW."previous_hash" IS DISTINCT FROM latest_hash THEN
    RAISE EXCEPTION 'change set transition receipt previous hash mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "change_set_transition_receipts_chain"
  BEFORE INSERT ON "change_set_transition_receipts"
  FOR EACH ROW EXECUTE FUNCTION "enforce_change_set_receipt_chain"();

CREATE FUNCTION "enforce_change_set_identity_and_version"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."id" <> OLD."id"
    OR NEW."tenant_id" <> OLD."tenant_id"
    OR NEW."maker_principal_id" <> OLD."maker_principal_id"
    OR NEW."change_type" <> OLD."change_type"
  THEN
    RAISE EXCEPTION 'change set identity and maker are immutable';
  END IF;

  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'change set update must increment version exactly once';
  END IF;

  IF NEW."status" = OLD."status" AND NEW."review_round" <> OLD."review_round" THEN
    RAISE EXCEPTION 'change set review round is engine managed';
  END IF;
  IF NEW."status" = OLD."status" AND NEW."checker_principal_id" IS DISTINCT FROM OLD."checker_principal_id" THEN
    RAISE EXCEPTION 'change set checker is engine managed';
  END IF;

  IF (OLD."status" <> 'DRAFT' OR NEW."status" <> 'DRAFT') AND (
    NEW."title" IS DISTINCT FROM OLD."title"
    OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
    OR NEW."owner_principal_id" IS DISTINCT FROM OLD."owner_principal_id"
    OR NEW."target_scope_type" IS DISTINCT FROM OLD."target_scope_type"
    OR NEW."target_organization_id" IS DISTINCT FROM OLD."target_organization_id"
    OR NEW."target_legacy_branch_id" IS DISTINCT FROM OLD."target_legacy_branch_id"
    OR NEW."base_version" IS DISTINCT FROM OLD."base_version"
    OR NEW."base_hash" IS DISTINCT FROM OLD."base_hash"
    OR NEW."proposed_version" IS DISTINCT FROM OLD."proposed_version"
    OR NEW."proposed_hash" IS DISTINCT FROM OLD."proposed_hash"
    OR NEW."base_config" IS DISTINCT FROM OLD."base_config"
    OR NEW."proposed_config" IS DISTINCT FROM OLD."proposed_config"
    OR NEW."semantic_diff" IS DISTINCT FROM OLD."semantic_diff"
    OR NEW."dependency_versions" IS DISTINCT FROM OLD."dependency_versions"
    OR NEW."compatibility_range" IS DISTINCT FROM OLD."compatibility_range"
    OR NEW."risk_tier" IS DISTINCT FROM OLD."risk_tier"
    OR NEW."data_class" IS DISTINCT FROM OLD."data_class"
    OR NEW."affected_tenant_count" IS DISTINCT FROM OLD."affected_tenant_count"
    OR NEW."affected_branch_count" IS DISTINCT FROM OLD."affected_branch_count"
    OR NEW."affected_principal_count" IS DISTINCT FROM OLD."affected_principal_count"
    OR NEW."affected_case_count" IS DISTINCT FROM OLD."affected_case_count"
    OR NEW."affected_integration_count" IS DISTINCT FROM OLD."affected_integration_count"
    OR NEW."approval_policy_version" IS DISTINCT FROM OLD."approval_policy_version"
    OR NEW."rollout_strategy" IS DISTINCT FROM OLD."rollout_strategy"
    OR NEW."canary_scope" IS DISTINCT FROM OLD."canary_scope"
    OR NEW."abort_conditions" IS DISTINCT FROM OLD."abort_conditions"
    OR NEW."observation_window_seconds" IS DISTINCT FROM OLD."observation_window_seconds"
    OR NEW."rollback_strategy" IS DISTINCT FROM OLD."rollback_strategy"
  ) THEN
    RAISE EXCEPTION 'validated change set payload and scope are immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "change_sets_guard_identity_and_version"
  BEFORE UPDATE ON "change_sets"
  FOR EACH ROW EXECUTE FUNCTION "enforce_change_set_identity_and_version"();

CREATE FUNCTION "enforce_change_set_state_transition"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" = OLD."status" THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD."status" = 'DRAFT' AND NEW."status" = 'VALIDATED')
    OR (OLD."status" = 'VALIDATED' AND NEW."status" IN ('SIMULATED', 'FAILED'))
    OR (OLD."status" = 'SIMULATED' AND NEW."status" IN ('IN_REVIEW', 'FAILED'))
    OR (OLD."status" = 'IN_REVIEW' AND NEW."status" IN ('APPROVED', 'RETURNED', 'REJECTED', 'FAILED'))
    OR (OLD."status" = 'RETURNED' AND NEW."status" = 'DRAFT')
    OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('SCHEDULED', 'REVOKED', 'FAILED'))
    OR (OLD."status" = 'SCHEDULED' AND NEW."status" IN ('CANARY', 'REVOKED', 'FAILED'))
    OR (OLD."status" = 'CANARY' AND NEW."status" IN ('PUBLISHED', 'ROLLED_BACK', 'FAILED'))
    OR (OLD."status" = 'PUBLISHED' AND NEW."status" IN ('OBSERVING', 'ROLLED_BACK', 'FAILED'))
    OR (OLD."status" = 'OBSERVING' AND NEW."status" IN ('EFFECTIVE', 'ROLLED_BACK', 'FAILED'))
    OR (OLD."status" = 'EFFECTIVE' AND NEW."status" IN ('ROLLED_BACK', 'REVOKED'))
  ) THEN
    RAISE EXCEPTION 'invalid change set state transition: % -> %', OLD."status", NEW."status";
  END IF;

  IF NEW."status" = 'IN_REVIEW' THEN
    IF NEW."review_round" <> OLD."review_round" + 1 THEN
      RAISE EXCEPTION 'entering review must increment the review round exactly once';
    END IF;
    IF NEW."checker_principal_id" IS NOT NULL THEN
      RAISE EXCEPTION 'entering review must clear the prior checker';
    END IF;
  ELSIF NEW."review_round" <> OLD."review_round" THEN
    RAISE EXCEPTION 'change set review round can only change when entering review';
  END IF;

  IF NEW."status" NOT IN ('IN_REVIEW', 'APPROVED', 'RETURNED', 'REJECTED')
    AND NEW."checker_principal_id" IS DISTINCT FROM OLD."checker_principal_id"
  THEN
    RAISE EXCEPTION 'change set checker can only change on a review decision';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "change_set_transition_receipts"
    WHERE "tenant_id" = NEW."tenant_id"
      AND "change_set_id" = NEW."id"
      AND "sequence" = NEW."version"
      AND "from_state" = OLD."status"
      AND "to_state" = NEW."status"
  ) THEN
    RAISE EXCEPTION 'change set transition receipt must be written before state mutation';
  END IF;

  IF NEW."status" IN ('APPROVED', 'RETURNED', 'REJECTED') AND NOT EXISTS (
    SELECT 1
    FROM "change_set_approvals"
    WHERE "tenant_id" = NEW."tenant_id"
      AND "change_set_id" = NEW."id"
      AND "decision" = NEW."status"
      AND "checker_principal_id" <> NEW."maker_principal_id"
      AND "checker_principal_id" = NEW."checker_principal_id"
      AND "checker_principal_id" = (
        SELECT "actor_principal_id"
        FROM "change_set_transition_receipts"
        WHERE "tenant_id" = NEW."tenant_id"
          AND "change_set_id" = NEW."id"
          AND "sequence" = NEW."version"
      )
      AND "approval_policy_version" = NEW."approval_policy_version"
      AND "review_round" = NEW."review_round"
  ) THEN
    RAISE EXCEPTION 'independent current-round decision receipt is required';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "change_sets_guard_state_transition"
  BEFORE UPDATE OF "status" ON "change_sets"
  FOR EACH ROW EXECUTE FUNCTION "enforce_change_set_state_transition"();

CREATE TRIGGER "change_set_approvals_immutable"
  BEFORE UPDATE OR DELETE ON "change_set_approvals"
  FOR EACH ROW EXECUTE FUNCTION "prevent_authorization_receipt_mutation"();

CREATE TRIGGER "change_set_transition_receipts_immutable"
  BEFORE UPDATE OR DELETE ON "change_set_transition_receipts"
  FOR EACH ROW EXECUTE FUNCTION "prevent_authorization_receipt_mutation"();
