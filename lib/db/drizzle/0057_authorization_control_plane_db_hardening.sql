-- Additive hardening for the default-unwired authorization and R1 ChangeSet foundations.
-- This migration intentionally refuses guessed backfills. The 0054-0056 tables must
-- still be empty until an explicit, reviewed adoption migration is prepared.

LOCK TABLE
  public.memberships,
  public.authorization_change_receipts,
  public.access_assignments,
  public.access_decision_receipts,
  public.change_sets,
  public.change_set_approvals,
  public.change_set_transition_receipts,
  public.change_set_command_receipts
IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  -- These foundations already FORCE RLS, so a no-context SELECT by their owner
  -- could falsely appear empty. Heap allocation is a conservative, RLS-neutral
  -- guard: even rolled-back or deleted adoption data requires an explicit plan.
  IF pg_relation_size('public.memberships'::regclass) > 0
    OR pg_relation_size('public.authorization_change_receipts'::regclass) > 0
    OR pg_relation_size('public.access_assignments'::regclass) > 0
    OR pg_relation_size('public.access_decision_receipts'::regclass) > 0
    OR pg_relation_size('public.change_sets'::regclass) > 0
    OR pg_relation_size('public.change_set_approvals'::regclass) > 0
    OR pg_relation_size('public.change_set_transition_receipts'::regclass) > 0
    OR pg_relation_size('public.change_set_command_receipts'::regclass) > 0
  THEN
    RAISE EXCEPTION '0057 requires empty default-unwired authorization/control-plane tables; use an explicit reviewed adoption migration';
  END IF;
END;
$$;

CREATE TABLE public.tenant_organization_legacy_branches (
  tenant_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  legacy_branch_id integer NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT tenant_organization_legacy_branches_pk
    PRIMARY KEY (tenant_id, organization_id, legacy_branch_id),
  CONSTRAINT tenant_organization_legacy_branches_branch_uq
    UNIQUE (legacy_branch_id),
  CONSTRAINT tenant_organization_legacy_branches_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT tenant_organization_legacy_branches_organization_fk
    FOREIGN KEY (tenant_id, organization_id)
    REFERENCES public.organizations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tenant_organization_legacy_branches_legacy_fk
    FOREIGN KEY (legacy_branch_id) REFERENCES public.branches(id) ON DELETE RESTRICT
);

ALTER TABLE public.tenant_organization_legacy_branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_organization_legacy_branches FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_organization_legacy_branches_select_same_tenant
  ON public.tenant_organization_legacy_branches FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_organization_legacy_branches_insert_same_tenant
  ON public.tenant_organization_legacy_branches FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_organization_legacy_branches_update_same_tenant
  ON public.tenant_organization_legacy_branches FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE public.memberships
  ADD CONSTRAINT memberships_tenant_id_id_principal_id_uq
    UNIQUE (tenant_id, id, principal_id),
  ADD CONSTRAINT memberships_branch_requires_organization_chk
    CHECK (legacy_branch_id IS NULL OR organization_id IS NOT NULL),
  ADD CONSTRAINT memberships_tenant_organization_branch_fk
    FOREIGN KEY (tenant_id, organization_id, legacy_branch_id)
    REFERENCES public.tenant_organization_legacy_branches(tenant_id, organization_id, legacy_branch_id)
    ON DELETE RESTRICT;

ALTER TABLE public.authorization_change_receipts
  ADD COLUMN actor_membership_id uuid NOT NULL,
  ADD CONSTRAINT authorization_change_receipts_actor_membership_fk
    FOREIGN KEY (tenant_id, actor_membership_id, actor_principal_id)
    REFERENCES public.memberships(tenant_id, id, principal_id) ON DELETE RESTRICT;

ALTER TABLE public.access_assignments
  ADD COLUMN granted_by_membership_id uuid NOT NULL,
  ADD CONSTRAINT access_assignments_grantor_membership_fk
    FOREIGN KEY (tenant_id, granted_by_membership_id, granted_by_principal_id)
    REFERENCES public.memberships(tenant_id, id, principal_id) ON DELETE RESTRICT,
  ADD CONSTRAINT access_assignments_tenant_organization_branch_fk
    FOREIGN KEY (tenant_id, organization_id, legacy_branch_id)
    REFERENCES public.tenant_organization_legacy_branches(tenant_id, organization_id, legacy_branch_id)
    ON DELETE RESTRICT;

ALTER TABLE public.access_decision_receipts
  ADD CONSTRAINT access_decision_receipts_actor_membership_fk
    FOREIGN KEY (tenant_id, membership_id, actor_principal_id)
    REFERENCES public.memberships(tenant_id, id, principal_id) ON DELETE RESTRICT;

ALTER TABLE public.change_sets
  ADD COLUMN configuration_key text NOT NULL,
  ADD COLUMN owner_membership_id uuid NOT NULL,
  ADD COLUMN maker_membership_id uuid NOT NULL,
  ADD COLUMN checker_membership_id uuid,
  ADD COLUMN approval_policy_version_id uuid NOT NULL,
  ADD CONSTRAINT change_sets_configuration_key_chk
    CHECK (configuration_key ~ '^[a-z][a-z0-9_.:-]{0,127}$'),
  ADD CONSTRAINT change_sets_checker_membership_pair_chk
    CHECK ((checker_principal_id IS NULL) = (checker_membership_id IS NULL)),
  ADD CONSTRAINT change_sets_checker_membership_separation_chk
    CHECK (checker_membership_id IS NULL OR checker_membership_id <> maker_membership_id),
  ADD CONSTRAINT change_sets_policy_identity_chk
    CHECK (approval_policy_version = approval_policy_version_id::text),
  ADD CONSTRAINT change_sets_owner_membership_fk
    FOREIGN KEY (tenant_id, owner_membership_id, owner_principal_id)
    REFERENCES public.memberships(tenant_id, id, principal_id) ON DELETE RESTRICT,
  ADD CONSTRAINT change_sets_maker_membership_fk
    FOREIGN KEY (tenant_id, maker_membership_id, maker_principal_id)
    REFERENCES public.memberships(tenant_id, id, principal_id) ON DELETE RESTRICT,
  ADD CONSTRAINT change_sets_checker_membership_fk
    FOREIGN KEY (tenant_id, checker_membership_id, checker_principal_id)
    REFERENCES public.memberships(tenant_id, id, principal_id) ON DELETE RESTRICT,
  ADD CONSTRAINT change_sets_policy_version_fk
    FOREIGN KEY (tenant_id, approval_policy_version_id)
    REFERENCES public.policy_versions(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT change_sets_tenant_organization_branch_fk
    FOREIGN KEY (tenant_id, target_organization_id, target_legacy_branch_id)
    REFERENCES public.tenant_organization_legacy_branches(tenant_id, organization_id, legacy_branch_id)
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX change_sets_one_active_proposal_per_target_uidx
  ON public.change_sets (
    tenant_id,
    change_type,
    configuration_key,
    target_scope_type,
    coalesce(target_organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(target_legacy_branch_id, -1)
  )
  WHERE status IN (
    'DRAFT', 'VALIDATED', 'SIMULATED', 'IN_REVIEW', 'APPROVED',
    'SCHEDULED', 'CANARY', 'PUBLISHED', 'OBSERVING', 'RETURNED'
  );

ALTER TABLE public.change_set_approvals
  ADD COLUMN checker_membership_id uuid NOT NULL,
  ADD COLUMN approval_policy_version_id uuid NOT NULL,
  ADD CONSTRAINT change_set_approvals_policy_identity_chk
    CHECK (approval_policy_version = approval_policy_version_id::text),
  ADD CONSTRAINT change_set_approvals_checker_membership_fk
    FOREIGN KEY (tenant_id, checker_membership_id, checker_principal_id)
    REFERENCES public.memberships(tenant_id, id, principal_id) ON DELETE RESTRICT,
  ADD CONSTRAINT change_set_approvals_policy_version_fk
    FOREIGN KEY (tenant_id, approval_policy_version_id)
    REFERENCES public.policy_versions(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE public.change_set_transition_receipts
  ADD COLUMN actor_membership_id uuid NOT NULL,
  ADD COLUMN policy_version_id uuid NOT NULL,
  ADD CONSTRAINT change_set_transition_receipts_policy_identity_chk
    CHECK (policy_version = policy_version_id::text),
  ADD CONSTRAINT change_set_transition_receipts_actor_membership_fk
    FOREIGN KEY (tenant_id, actor_membership_id, actor_principal_id)
    REFERENCES public.memberships(tenant_id, id, principal_id) ON DELETE RESTRICT,
  ADD CONSTRAINT change_set_transition_receipts_policy_version_fk
    FOREIGN KEY (tenant_id, policy_version_id)
    REFERENCES public.policy_versions(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE public.change_set_command_receipts
  ADD COLUMN actor_membership_id uuid NOT NULL,
  ADD COLUMN target_state text,
  ADD CONSTRAINT change_set_command_receipts_tenant_id_id_uq
    UNIQUE (tenant_id, id),
  ADD CONSTRAINT change_set_command_receipts_actor_membership_fk
    FOREIGN KEY (tenant_id, actor_membership_id, actor_principal_id)
    REFERENCES public.memberships(tenant_id, id, principal_id) ON DELETE RESTRICT,
  ADD CONSTRAINT change_set_command_receipts_target_state_chk
    CHECK (
      (command_type = 'CREATE' AND target_state IS NULL)
      OR (command_type = 'TRANSITION' AND target_state IS NOT NULL AND target_state IN ('VALIDATED', 'SIMULATED', 'IN_REVIEW'))
    );

ALTER TABLE public.change_set_transition_receipts
  ADD COLUMN command_receipt_id uuid NOT NULL,
  ADD CONSTRAINT change_set_transition_receipts_tenant_command_uq
    UNIQUE (tenant_id, command_receipt_id),
  ADD CONSTRAINT change_set_transition_receipts_command_receipt_fk
    FOREIGN KEY (tenant_id, command_receipt_id)
    REFERENCES public.change_set_command_receipts(tenant_id, id) ON DELETE RESTRICT;

CREATE TABLE public.change_set_evidence_receipts (
  id uuid PRIMARY KEY NOT NULL,
  tenant_id uuid NOT NULL,
  change_set_id uuid NOT NULL,
  target_state text NOT NULL,
  kind text NOT NULL,
  issuer text NOT NULL,
  tool_version text NOT NULL,
  requested_by_principal_id uuid NOT NULL,
  requested_by_membership_id uuid NOT NULL,
  subject_hash text NOT NULL,
  policy_version_id uuid NOT NULL,
  outcome text NOT NULL,
  artifact_count integer,
  outcome_hash text NOT NULL,
  issued_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  consumed_at timestamp with time zone,
  consumed_by_command_receipt_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT change_set_evidence_receipts_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT change_set_evidence_receipts_id_uuidv7_chk
    CHECK (substring(id::text from 15 for 1) = '7'),
  CONSTRAINT change_set_evidence_receipts_target_state_chk
    CHECK (target_state IN ('VALIDATED', 'SIMULATED', 'IN_REVIEW')),
  CONSTRAINT change_set_evidence_receipts_kind_chk
    CHECK (kind IN ('VALIDATION', 'SIMULATION', 'TEST_ARTIFACT', 'ROLLBACK_PLAN', 'CANARY_PLAN')),
  CONSTRAINT change_set_evidence_receipts_outcome_chk
    CHECK (outcome IN ('PASSED', 'FAILED')),
  CONSTRAINT change_set_evidence_receipts_hashes_chk
    CHECK (subject_hash ~ '^[0-9a-f]{64}$' AND outcome_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT change_set_evidence_receipts_window_chk
    CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '1 hour'),
  CONSTRAINT change_set_evidence_receipts_consumption_pair_chk
    CHECK ((consumed_at IS NULL) = (consumed_by_command_receipt_id IS NULL)),
  CONSTRAINT change_set_evidence_receipts_artifact_count_chk
    CHECK (
      (kind = 'TEST_ARTIFACT' AND artifact_count IS NOT NULL AND artifact_count > 0)
      OR (kind <> 'TEST_ARTIFACT' AND artifact_count IS NULL)
    ),
  CONSTRAINT change_set_evidence_receipts_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT change_set_evidence_receipts_change_set_fk
    FOREIGN KEY (tenant_id, change_set_id)
    REFERENCES public.change_sets(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT change_set_evidence_receipts_requester_membership_fk
    FOREIGN KEY (tenant_id, requested_by_membership_id, requested_by_principal_id)
    REFERENCES public.memberships(tenant_id, id, principal_id) ON DELETE RESTRICT,
  CONSTRAINT change_set_evidence_receipts_policy_version_fk
    FOREIGN KEY (tenant_id, policy_version_id)
    REFERENCES public.policy_versions(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT change_set_evidence_receipts_consuming_command_fk
    FOREIGN KEY (tenant_id, consumed_by_command_receipt_id)
    REFERENCES public.change_set_command_receipts(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX change_set_evidence_receipts_lookup_idx
  ON public.change_set_evidence_receipts
  (tenant_id, change_set_id, target_state, requested_by_principal_id, consumed_at, expires_at);

CREATE TABLE public.change_set_command_attempt_receipts (
  id uuid PRIMARY KEY NOT NULL,
  tenant_id uuid NOT NULL,
  context_id uuid NOT NULL,
  actor_principal_id uuid NOT NULL,
  actor_membership_id uuid NOT NULL,
  command_receipt_id uuid NOT NULL,
  request_hash text NOT NULL,
  outcome text NOT NULL,
  occurred_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT change_set_command_attempt_receipts_id_uuidv7_chk
    CHECK (substring(id::text from 15 for 1) = '7'),
  CONSTRAINT change_set_command_attempt_receipts_context_uuidv7_chk
    CHECK (substring(context_id::text from 15 for 1) = '7'),
  CONSTRAINT change_set_command_attempt_receipts_request_hash_chk
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT change_set_command_attempt_receipts_outcome_chk
    CHECK (outcome IN ('CONFLICT', 'IN_PROGRESS')),
  CONSTRAINT change_set_command_attempt_receipts_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT change_set_command_attempt_receipts_actor_membership_fk
    FOREIGN KEY (tenant_id, actor_membership_id, actor_principal_id)
    REFERENCES public.memberships(tenant_id, id, principal_id) ON DELETE RESTRICT,
  CONSTRAINT change_set_command_attempt_receipts_command_fk
    FOREIGN KEY (tenant_id, command_receipt_id)
    REFERENCES public.change_set_command_receipts(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX change_set_command_attempt_receipts_command_idx
  ON public.change_set_command_attempt_receipts (tenant_id, command_receipt_id, occurred_at);

ALTER TABLE public.change_set_evidence_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.change_set_evidence_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.change_set_command_attempt_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.change_set_command_attempt_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY change_set_evidence_receipts_select_same_tenant
  ON public.change_set_evidence_receipts FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY change_set_evidence_receipts_insert_same_tenant
  ON public.change_set_evidence_receipts FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY change_set_evidence_receipts_update_same_tenant
  ON public.change_set_evidence_receipts FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY change_set_command_attempt_receipts_select_same_tenant
  ON public.change_set_command_attempt_receipts FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY change_set_command_attempt_receipts_insert_same_tenant
  ON public.change_set_command_attempt_receipts FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION public.enforce_change_set_checker_separation() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_maker uuid;
  current_maker_membership uuid;
  current_status text;
  current_policy_version uuid;
  current_review_round integer;
BEGIN
  SELECT maker_principal_id, maker_membership_id, status, approval_policy_version_id, review_round
    INTO current_maker, current_maker_membership, current_status, current_policy_version, current_review_round
  FROM public.change_sets
  WHERE tenant_id = NEW.tenant_id AND id = NEW.change_set_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'change set is not visible in the active tenant';
  END IF;
  IF current_maker = NEW.checker_principal_id
    OR current_maker_membership = NEW.checker_membership_id
  THEN
    RAISE EXCEPTION 'change set maker cannot act as checker';
  END IF;
  IF current_status <> 'IN_REVIEW' THEN
    RAISE EXCEPTION 'change set decision requires IN_REVIEW state';
  END IF;
  IF NEW.review_round <> current_review_round THEN
    RAISE EXCEPTION 'change set decision review round mismatch';
  END IF;
  IF NEW.approval_policy_version_id <> current_policy_version THEN
    RAISE EXCEPTION 'change set decision policy version mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_change_set_initial_state() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> 'DRAFT'
    OR NEW.version <> 1
    OR NEW.review_round <> 0
    OR NEW.checker_principal_id IS NOT NULL
    OR NEW.checker_membership_id IS NOT NULL
    OR NEW.scheduled_at IS NOT NULL
    OR NEW.observation_started_at IS NOT NULL
    OR NEW.published_at IS NOT NULL
    OR NEW.effective_at IS NOT NULL
    OR NEW.closed_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'change set must be inserted in a clean DRAFT state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_change_set_receipt_chain() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_status text;
  current_version bigint;
  current_policy_version uuid;
  latest_hash text;
BEGIN
  SELECT status, version, approval_policy_version_id
    INTO current_status, current_version, current_policy_version
  FROM public.change_sets
  WHERE tenant_id = NEW.tenant_id AND id = NEW.change_set_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'change set is not visible in the active tenant';
  END IF;
  IF NEW.sequence <> current_version + 1 THEN
    RAISE EXCEPTION 'change set transition receipt sequence must follow current version';
  END IF;
  IF NEW.from_state IS DISTINCT FROM current_status THEN
    RAISE EXCEPTION 'change set transition receipt source state mismatch';
  END IF;
  IF NEW.policy_version_id <> current_policy_version THEN
    RAISE EXCEPTION 'change set transition receipt policy version mismatch';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.change_set_command_receipts command
    JOIN public.memberships membership
      ON membership.tenant_id = command.tenant_id
     AND membership.id = command.actor_membership_id
     AND membership.principal_id = command.actor_principal_id
    JOIN public.policy_versions policy
      ON policy.tenant_id = command.tenant_id
     AND policy.id = NEW.policy_version_id
    WHERE command.tenant_id = NEW.tenant_id
      AND command.id = NEW.command_receipt_id
      AND command.status = 'CLAIMED'
      AND command.command_type = 'TRANSITION'
      AND command.change_set_id = NEW.change_set_id
      AND command.target_state = NEW.to_state
      AND command.actor_principal_id = NEW.actor_principal_id
      AND command.actor_membership_id = NEW.actor_membership_id
      AND membership.status = 'ACTIVE'
      AND membership.valid_from <= statement_timestamp()
      AND (membership.valid_until IS NULL OR membership.valid_until > statement_timestamp())
      AND policy.state = 'ACTIVE'
      AND policy.effective_at IS NOT NULL
      AND policy.effective_at <= statement_timestamp()
      AND policy.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'change set transition receipt requires its current claimed command';
  END IF;

  SELECT receipt_hash INTO latest_hash
  FROM public.change_set_transition_receipts
  WHERE tenant_id = NEW.tenant_id AND change_set_id = NEW.change_set_id
  ORDER BY sequence DESC
  LIMIT 1;

  IF latest_hash IS NULL AND NEW.previous_hash IS NOT NULL THEN
    RAISE EXCEPTION 'first change set transition receipt cannot have a previous hash';
  END IF;
  IF latest_hash IS NOT NULL AND NEW.previous_hash IS DISTINCT FROM latest_hash THEN
    RAISE EXCEPTION 'change set transition receipt previous hash mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_change_set_identity_and_version() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.change_type <> OLD.change_type
    OR NEW.configuration_key <> OLD.configuration_key
    OR NEW.owner_principal_id <> OLD.owner_principal_id
    OR NEW.owner_membership_id <> OLD.owner_membership_id
    OR NEW.maker_principal_id <> OLD.maker_principal_id
    OR NEW.maker_membership_id <> OLD.maker_membership_id
    OR NEW.approval_policy_version_id <> OLD.approval_policy_version_id
  THEN
    RAISE EXCEPTION 'change set identity, memberships, maker and policy are immutable';
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'change set update must increment version exactly once';
  END IF;
  IF NEW.status = OLD.status AND NEW.review_round <> OLD.review_round THEN
    RAISE EXCEPTION 'change set review round is engine managed';
  END IF;
  IF NEW.status = OLD.status AND (
    NEW.checker_principal_id IS DISTINCT FROM OLD.checker_principal_id
    OR NEW.checker_membership_id IS DISTINCT FROM OLD.checker_membership_id
  ) THEN
    RAISE EXCEPTION 'change set checker is engine managed';
  END IF;

  IF (OLD.status <> 'DRAFT' OR NEW.status <> 'DRAFT') AND (
    NEW.title IS DISTINCT FROM OLD.title
    OR NEW.purpose IS DISTINCT FROM OLD.purpose
    OR NEW.target_scope_type IS DISTINCT FROM OLD.target_scope_type
    OR NEW.target_organization_id IS DISTINCT FROM OLD.target_organization_id
    OR NEW.target_legacy_branch_id IS DISTINCT FROM OLD.target_legacy_branch_id
    OR NEW.base_version IS DISTINCT FROM OLD.base_version
    OR NEW.base_hash IS DISTINCT FROM OLD.base_hash
    OR NEW.proposed_version IS DISTINCT FROM OLD.proposed_version
    OR NEW.proposed_hash IS DISTINCT FROM OLD.proposed_hash
    OR NEW.base_config IS DISTINCT FROM OLD.base_config
    OR NEW.proposed_config IS DISTINCT FROM OLD.proposed_config
    OR NEW.semantic_diff IS DISTINCT FROM OLD.semantic_diff
    OR NEW.dependency_versions IS DISTINCT FROM OLD.dependency_versions
    OR NEW.compatibility_range IS DISTINCT FROM OLD.compatibility_range
    OR NEW.risk_tier IS DISTINCT FROM OLD.risk_tier
    OR NEW.data_class IS DISTINCT FROM OLD.data_class
    OR NEW.affected_tenant_count IS DISTINCT FROM OLD.affected_tenant_count
    OR NEW.affected_branch_count IS DISTINCT FROM OLD.affected_branch_count
    OR NEW.affected_principal_count IS DISTINCT FROM OLD.affected_principal_count
    OR NEW.affected_case_count IS DISTINCT FROM OLD.affected_case_count
    OR NEW.affected_integration_count IS DISTINCT FROM OLD.affected_integration_count
    OR NEW.approval_policy_version IS DISTINCT FROM OLD.approval_policy_version
    OR NEW.rollout_strategy IS DISTINCT FROM OLD.rollout_strategy
    OR NEW.canary_scope IS DISTINCT FROM OLD.canary_scope
    OR NEW.abort_conditions IS DISTINCT FROM OLD.abort_conditions
    OR NEW.observation_window_seconds IS DISTINCT FROM OLD.observation_window_seconds
    OR NEW.rollback_strategy IS DISTINCT FROM OLD.rollback_strategy
  ) THEN
    RAISE EXCEPTION 'validated change set payload and scope are immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_change_set_state_transition() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.status = 'DRAFT' AND NEW.status = 'VALIDATED')
    OR (OLD.status = 'VALIDATED' AND NEW.status IN ('SIMULATED', 'FAILED'))
    OR (OLD.status = 'SIMULATED' AND NEW.status IN ('IN_REVIEW', 'FAILED'))
    OR (OLD.status = 'IN_REVIEW' AND NEW.status IN ('APPROVED', 'RETURNED', 'REJECTED', 'FAILED'))
    OR (OLD.status = 'RETURNED' AND NEW.status = 'DRAFT')
    OR (OLD.status = 'APPROVED' AND NEW.status IN ('SCHEDULED', 'REVOKED', 'FAILED'))
    OR (OLD.status = 'SCHEDULED' AND NEW.status IN ('CANARY', 'REVOKED', 'FAILED'))
    OR (OLD.status = 'CANARY' AND NEW.status IN ('PUBLISHED', 'ROLLED_BACK', 'FAILED'))
    OR (OLD.status = 'PUBLISHED' AND NEW.status IN ('OBSERVING', 'ROLLED_BACK', 'FAILED'))
    OR (OLD.status = 'OBSERVING' AND NEW.status IN ('EFFECTIVE', 'ROLLED_BACK', 'FAILED'))
    OR (OLD.status = 'EFFECTIVE' AND NEW.status IN ('ROLLED_BACK', 'REVOKED'))
  ) THEN
    RAISE EXCEPTION 'invalid change set state transition: % -> %', OLD.status, NEW.status;
  END IF;

  IF NEW.status = 'IN_REVIEW' THEN
    IF NEW.review_round <> OLD.review_round + 1 THEN
      RAISE EXCEPTION 'entering review must increment the review round exactly once';
    END IF;
    IF NEW.checker_principal_id IS NOT NULL OR NEW.checker_membership_id IS NOT NULL THEN
      RAISE EXCEPTION 'entering review must clear the prior checker';
    END IF;
  ELSIF NEW.review_round <> OLD.review_round THEN
    RAISE EXCEPTION 'change set review round can only change when entering review';
  END IF;

  IF NEW.status NOT IN ('IN_REVIEW', 'APPROVED', 'RETURNED', 'REJECTED')
    AND (
      NEW.checker_principal_id IS DISTINCT FROM OLD.checker_principal_id
      OR NEW.checker_membership_id IS DISTINCT FROM OLD.checker_membership_id
    )
  THEN
    RAISE EXCEPTION 'change set checker can only change on a review decision';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.change_set_transition_receipts
    WHERE tenant_id = NEW.tenant_id
      AND change_set_id = NEW.id
      AND sequence = NEW.version
      AND from_state = OLD.status
      AND to_state = NEW.status
      AND policy_version_id = NEW.approval_policy_version_id
  ) THEN
    RAISE EXCEPTION 'change set transition receipt must be written before state mutation';
  END IF;

  IF NEW.status IN ('APPROVED', 'RETURNED', 'REJECTED') AND NOT EXISTS (
    SELECT 1 FROM public.change_set_approvals approval
    WHERE approval.tenant_id = NEW.tenant_id
      AND approval.change_set_id = NEW.id
      AND approval.decision = NEW.status
      AND approval.checker_principal_id <> NEW.maker_principal_id
      AND approval.checker_membership_id <> NEW.maker_membership_id
      AND approval.checker_principal_id = NEW.checker_principal_id
      AND approval.checker_membership_id = NEW.checker_membership_id
      AND approval.approval_policy_version_id = NEW.approval_policy_version_id
      AND approval.review_round = NEW.review_round
      AND EXISTS (
        SELECT 1 FROM public.change_set_transition_receipts transition
        WHERE transition.tenant_id = NEW.tenant_id
          AND transition.change_set_id = NEW.id
          AND transition.sequence = NEW.version
          AND transition.actor_principal_id = approval.checker_principal_id
          AND transition.actor_membership_id = approval.checker_membership_id
          AND transition.policy_version_id = approval.approval_policy_version_id
      )
  ) THEN
    RAISE EXCEPTION 'independent current-round decision receipt is required';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_change_set_command_initial_claim() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> 'CLAIMED'
    OR NEW.version <> 1
    OR NEW.result IS NOT NULL
    OR NEW.result_hash IS NOT NULL
    OR NEW.completed_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'change set command must start as a clean claim';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_change_set_command_completion() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  evidence_count integer;
  validation_count integer;
  simulation_count integer;
  test_count integer;
  rollback_count integer;
  canary_count integer;
BEGIN
  IF OLD.status <> 'CLAIMED' OR NEW.status <> 'COMPLETED' THEN
    RAISE EXCEPTION 'change set command receipt permits only CLAIMED to COMPLETED';
  END IF;
  IF NEW.id <> OLD.id
    OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.idempotency_key_hash <> OLD.idempotency_key_hash
    OR NEW.request_hash <> OLD.request_hash
    OR NEW.context_id <> OLD.context_id
    OR NEW.actor_principal_id <> OLD.actor_principal_id
    OR NEW.actor_membership_id <> OLD.actor_membership_id
    OR NEW.command_type <> OLD.command_type
    OR NEW.target_state IS DISTINCT FROM OLD.target_state
    OR NEW.claimed_at <> OLD.claimed_at
    OR (OLD.change_set_id IS NOT NULL AND NEW.change_set_id IS DISTINCT FROM OLD.change_set_id)
  THEN
    RAISE EXCEPTION 'change set command claim identity is immutable';
  END IF;
  IF NEW.change_set_id IS NULL
    OR NEW.result IS NULL
    OR NEW.result_hash IS NULL
    OR NEW.completed_at IS NULL
    OR NEW.completed_at < OLD.claimed_at
    OR NEW.version <> OLD.version + 1
  THEN
    RAISE EXCEPTION 'change set command completion evidence is incomplete';
  END IF;
  IF NEW.command_type = 'TRANSITION' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.change_set_transition_receipts transition
      WHERE transition.tenant_id = NEW.tenant_id
        AND transition.command_receipt_id = NEW.id
        AND transition.change_set_id = NEW.change_set_id
        AND transition.to_state = NEW.target_state
        AND transition.actor_principal_id = NEW.actor_principal_id
        AND transition.actor_membership_id = NEW.actor_membership_id
        AND transition.policy_version_id = (
          SELECT approval_policy_version_id
          FROM public.change_sets
          WHERE tenant_id = NEW.tenant_id AND id = NEW.change_set_id
        )
    ) THEN
      RAISE EXCEPTION 'transition command completion requires its exact transition receipt';
    END IF;

    SELECT
      count(*)::integer,
      count(*) FILTER (WHERE kind = 'VALIDATION')::integer,
      count(*) FILTER (WHERE kind = 'SIMULATION')::integer,
      count(*) FILTER (WHERE kind = 'TEST_ARTIFACT' AND artifact_count >= 1)::integer,
      count(*) FILTER (WHERE kind = 'ROLLBACK_PLAN')::integer,
      count(*) FILTER (WHERE kind = 'CANARY_PLAN')::integer
    INTO evidence_count, validation_count, simulation_count,
      test_count, rollback_count, canary_count
    FROM public.change_set_evidence_receipts
    WHERE tenant_id = NEW.tenant_id
      AND change_set_id = NEW.change_set_id
      AND target_state = NEW.target_state
      AND requested_by_principal_id = NEW.actor_principal_id
      AND requested_by_membership_id = NEW.actor_membership_id
      AND consumed_by_command_receipt_id = NEW.id
      AND consumed_at IS NOT NULL
      AND outcome = 'PASSED';

    IF (NEW.target_state = 'VALIDATED' AND NOT (evidence_count = 1 AND validation_count = 1))
      OR (NEW.target_state = 'SIMULATED' AND NOT (evidence_count = 1 AND simulation_count = 1))
      OR (NEW.target_state = 'IN_REVIEW' AND NOT (
        evidence_count = 3 AND test_count = 1 AND rollback_count = 1 AND canary_count = 1
      ))
    THEN
      RAISE EXCEPTION 'transition command completion requires the exact typed evidence set';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.enforce_change_set_transition_finalization() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.change_set_command_receipts command
    JOIN public.change_sets change_set
      ON change_set.tenant_id = command.tenant_id
     AND change_set.id = command.change_set_id
    WHERE command.tenant_id = NEW.tenant_id
      AND command.id = NEW.command_receipt_id
      AND command.status = 'COMPLETED'
      AND command.command_type = 'TRANSITION'
      AND command.change_set_id = NEW.change_set_id
      AND command.target_state = NEW.to_state
      AND command.actor_principal_id = NEW.actor_principal_id
      AND command.actor_membership_id = NEW.actor_membership_id
      AND change_set.status = NEW.to_state
      AND change_set.version = NEW.sequence
      AND change_set.approval_policy_version_id = NEW.policy_version_id
  ) THEN
    RAISE EXCEPTION 'transition receipt requires its atomically completed command and state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.enforce_change_set_evidence_initial() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.consumed_at IS NOT NULL OR NEW.consumed_by_command_receipt_id IS NOT NULL THEN
    RAISE EXCEPTION 'change set evidence must be inserted unconsumed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.enforce_change_set_evidence_consumption() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.consumed_at IS NOT NULL OR OLD.consumed_by_command_receipt_id IS NOT NULL THEN
    RAISE EXCEPTION 'change set evidence is single-use';
  END IF;
  IF NEW.consumed_at IS NULL OR NEW.consumed_by_command_receipt_id IS NULL THEN
    RAISE EXCEPTION 'change set evidence consumption evidence is incomplete';
  END IF;
  -- Consumption time is database authority, never a caller-selected timestamp.
  NEW.consumed_at := statement_timestamp();
  IF OLD.outcome <> 'PASSED' THEN
    RAISE EXCEPTION 'failed change set evidence cannot be consumed';
  END IF;
  IF NEW.id <> OLD.id
    OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.change_set_id <> OLD.change_set_id
    OR NEW.target_state <> OLD.target_state
    OR NEW.kind <> OLD.kind
    OR NEW.issuer <> OLD.issuer
    OR NEW.tool_version <> OLD.tool_version
    OR NEW.requested_by_principal_id <> OLD.requested_by_principal_id
    OR NEW.requested_by_membership_id <> OLD.requested_by_membership_id
    OR NEW.subject_hash <> OLD.subject_hash
    OR NEW.policy_version_id <> OLD.policy_version_id
    OR NEW.outcome <> OLD.outcome
    OR NEW.artifact_count IS DISTINCT FROM OLD.artifact_count
    OR NEW.outcome_hash <> OLD.outcome_hash
    OR NEW.issued_at <> OLD.issued_at
    OR NEW.expires_at <> OLD.expires_at
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'change set evidence identity and outcome are immutable';
  END IF;
  IF NEW.consumed_at < OLD.issued_at OR NEW.consumed_at >= OLD.expires_at THEN
    RAISE EXCEPTION 'change set evidence cannot be consumed outside its validity window';
  END IF;
  PERFORM 1
  FROM public.policy_versions policy
  WHERE policy.tenant_id = NEW.tenant_id
    AND policy.id = NEW.policy_version_id
    AND policy.state = 'ACTIVE'
    AND policy.effective_at IS NOT NULL
    AND policy.effective_at <= statement_timestamp()
    AND policy.revoked_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'change set evidence policy is not current';
  END IF;
  PERFORM 1
  FROM public.memberships membership
  WHERE membership.tenant_id = NEW.tenant_id
    AND membership.id = NEW.requested_by_membership_id
    AND membership.principal_id = NEW.requested_by_principal_id
    AND membership.status = 'ACTIVE'
    AND membership.valid_from <= statement_timestamp()
    AND (membership.valid_until IS NULL OR membership.valid_until > statement_timestamp())
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'change set evidence requester membership is not current';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.change_set_command_receipts command
    JOIN public.change_sets change_set
      ON change_set.tenant_id = command.tenant_id
     AND change_set.id = command.change_set_id
    JOIN public.policy_versions policy
      ON policy.tenant_id = change_set.tenant_id
     AND policy.id = change_set.approval_policy_version_id
    JOIN public.memberships membership
      ON membership.tenant_id = command.tenant_id
     AND membership.id = command.actor_membership_id
     AND membership.principal_id = command.actor_principal_id
    WHERE command.tenant_id = NEW.tenant_id
      AND command.id = NEW.consumed_by_command_receipt_id
      AND command.command_type = 'TRANSITION'
      AND command.status = 'CLAIMED'
      AND command.change_set_id = NEW.change_set_id
      AND command.target_state = NEW.target_state
      AND command.actor_principal_id = NEW.requested_by_principal_id
      AND command.actor_membership_id = NEW.requested_by_membership_id
      AND change_set.proposed_hash = NEW.subject_hash
      AND change_set.approval_policy_version_id = NEW.policy_version_id
      AND policy.state = 'ACTIVE'
      AND policy.effective_at IS NOT NULL
      AND policy.effective_at <= statement_timestamp()
      AND policy.revoked_at IS NULL
      AND membership.status = 'ACTIVE'
      AND membership.valid_from <= statement_timestamp()
      AND (membership.valid_until IS NULL OR membership.valid_until > statement_timestamp())
  ) THEN
    RAISE EXCEPTION 'change set evidence must be consumed by its bound transition command';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.enforce_change_set_evidence_finalization() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.consumed_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.change_set_command_receipts command
    JOIN public.change_sets change_set
      ON change_set.tenant_id = command.tenant_id
     AND change_set.id = command.change_set_id
    JOIN public.change_set_transition_receipts transition
      ON transition.tenant_id = command.tenant_id
     AND transition.command_receipt_id = command.id
     AND transition.change_set_id = command.change_set_id
     AND transition.to_state = command.target_state
    JOIN public.policy_versions policy
      ON policy.tenant_id = change_set.tenant_id
     AND policy.id = change_set.approval_policy_version_id
    JOIN public.memberships membership
      ON membership.tenant_id = command.tenant_id
     AND membership.id = command.actor_membership_id
     AND membership.principal_id = command.actor_principal_id
    WHERE command.tenant_id = NEW.tenant_id
      AND command.id = NEW.consumed_by_command_receipt_id
      AND command.status = 'COMPLETED'
      AND command.command_type = 'TRANSITION'
      AND command.target_state = NEW.target_state
      AND command.actor_principal_id = NEW.requested_by_principal_id
      AND command.actor_membership_id = NEW.requested_by_membership_id
      AND change_set.id = NEW.change_set_id
      AND change_set.status = NEW.target_state
      AND change_set.proposed_hash = NEW.subject_hash
      AND change_set.approval_policy_version_id = NEW.policy_version_id
      AND transition.actor_principal_id = NEW.requested_by_principal_id
      AND transition.actor_membership_id = NEW.requested_by_membership_id
      AND transition.policy_version_id = NEW.policy_version_id
      AND policy.state = 'ACTIVE'
      AND policy.effective_at IS NOT NULL
      AND policy.effective_at <= statement_timestamp()
      AND policy.revoked_at IS NULL
      AND membership.status = 'ACTIVE'
      AND membership.valid_from <= statement_timestamp()
      AND (membership.valid_until IS NULL OR membership.valid_until > statement_timestamp())
  ) THEN
    RAISE EXCEPTION 'consumed change set evidence requires an atomically completed bound transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER change_set_evidence_receipts_guard_initial
  BEFORE INSERT ON public.change_set_evidence_receipts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_change_set_evidence_initial();
CREATE TRIGGER change_set_evidence_receipts_guard_consumption
  BEFORE UPDATE ON public.change_set_evidence_receipts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_change_set_evidence_consumption();
CREATE CONSTRAINT TRIGGER change_set_evidence_receipts_require_completed_transition
  AFTER UPDATE ON public.change_set_evidence_receipts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.enforce_change_set_evidence_finalization();
CREATE CONSTRAINT TRIGGER change_set_transition_receipts_require_completed_command
  AFTER INSERT ON public.change_set_transition_receipts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.enforce_change_set_transition_finalization();
CREATE TRIGGER change_set_evidence_receipts_immutable_delete
  BEFORE DELETE ON public.change_set_evidence_receipts
  FOR EACH ROW EXECUTE FUNCTION public.prevent_authorization_receipt_mutation();
CREATE TRIGGER change_set_command_attempt_receipts_immutable
  BEFORE UPDATE OR DELETE ON public.change_set_command_attempt_receipts
  FOR EACH ROW EXECUTE FUNCTION public.prevent_authorization_receipt_mutation();

ALTER FUNCTION public.prevent_authorization_receipt_mutation() SECURITY INVOKER;
ALTER FUNCTION public.prevent_authorization_receipt_mutation() SET search_path TO pg_catalog, public;
ALTER FUNCTION public.enforce_change_set_checker_separation() SECURITY INVOKER;
ALTER FUNCTION public.enforce_change_set_checker_separation() SET search_path TO pg_catalog, public;
ALTER FUNCTION public.enforce_change_set_initial_state() SECURITY INVOKER;
ALTER FUNCTION public.enforce_change_set_initial_state() SET search_path TO pg_catalog, public;
ALTER FUNCTION public.enforce_change_set_receipt_chain() SECURITY INVOKER;
ALTER FUNCTION public.enforce_change_set_receipt_chain() SET search_path TO pg_catalog, public;
ALTER FUNCTION public.enforce_change_set_identity_and_version() SECURITY INVOKER;
ALTER FUNCTION public.enforce_change_set_identity_and_version() SET search_path TO pg_catalog, public;
ALTER FUNCTION public.enforce_change_set_state_transition() SECURITY INVOKER;
ALTER FUNCTION public.enforce_change_set_state_transition() SET search_path TO pg_catalog, public;
ALTER FUNCTION public.enforce_change_set_command_initial_claim() SECURITY INVOKER;
ALTER FUNCTION public.enforce_change_set_command_initial_claim() SET search_path TO pg_catalog, public;
ALTER FUNCTION public.enforce_change_set_command_completion() SECURITY INVOKER;
ALTER FUNCTION public.enforce_change_set_command_completion() SET search_path TO pg_catalog, public;
ALTER FUNCTION public.enforce_change_set_transition_finalization() SECURITY INVOKER;
ALTER FUNCTION public.enforce_change_set_transition_finalization() SET search_path TO pg_catalog, public;
ALTER FUNCTION public.enforce_change_set_evidence_initial() SECURITY INVOKER;
ALTER FUNCTION public.enforce_change_set_evidence_initial() SET search_path TO pg_catalog, public;
ALTER FUNCTION public.enforce_change_set_evidence_consumption() SECURITY INVOKER;
ALTER FUNCTION public.enforce_change_set_evidence_consumption() SET search_path TO pg_catalog, public;
ALTER FUNCTION public.enforce_change_set_evidence_finalization() SECURITY INVOKER;
ALTER FUNCTION public.enforce_change_set_evidence_finalization() SET search_path TO pg_catalog, public;
