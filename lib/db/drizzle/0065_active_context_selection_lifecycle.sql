-- Additive, default-unwired active-context selection lifecycle command foundation.
-- Runtime roles, HTTP routes, UI, cookie mutation and production bootstrap remain external.

LOCK TABLE public.active_session_context_selections IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.active_context_issuance_rate_limits IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.active_context_issuance_permits IN ACCESS EXCLUSIVE MODE;

-- The 0064 tables are FORCE RLS. The migration role must inspect them for
-- the empty-foundation preflight; this is transaction-local and restored
-- before any subsequent DDL (or rolled back with the failed migration).
ALTER TABLE public.active_session_context_selections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.active_context_issuance_rate_limits NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.active_context_issuance_permits NO FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.active_session_context_selections)
    OR EXISTS (SELECT 1 FROM public.active_context_issuance_rate_limits)
    OR EXISTS (SELECT 1 FROM public.active_context_issuance_permits)
  THEN
    RAISE EXCEPTION
      '0065 requires empty 0064 session-selection tables; use a reviewed adoption migration';
  END IF;
END;
$$;

ALTER TABLE public.active_session_context_selections FORCE ROW LEVEL SECURITY;
ALTER TABLE public.active_context_issuance_rate_limits FORCE ROW LEVEL SECURITY;
ALTER TABLE public.active_context_issuance_permits FORCE ROW LEVEL SECURITY;

ALTER TABLE public.active_session_context_selections
  ADD COLUMN previous_selection_id uuid,
  ADD COLUMN row_version bigint DEFAULT 1 NOT NULL,
  ADD COLUMN termination_reason text;

ALTER TABLE public.active_session_context_selections
  DROP CONSTRAINT active_session_context_selections_status_chk,
  DROP CONSTRAINT active_session_context_selections_revocation_chk;

ALTER TABLE public.active_session_context_selections
  ADD CONSTRAINT active_session_context_selections_previous_fk
    FOREIGN KEY (tenant_id, previous_selection_id)
    REFERENCES public.active_session_context_selections(tenant_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT active_session_context_selections_previous_uq
    UNIQUE (previous_selection_id),
  ADD CONSTRAINT active_session_context_selections_expected_binding_uq
    UNIQUE (tenant_id, id, session_fingerprint, session_generation, principal_id),
  ADD CONSTRAINT active_session_context_selections_result_binding_uq
    UNIQUE (tenant_id, id, session_fingerprint, session_generation, principal_id, membership_id),
  ADD CONSTRAINT active_session_context_selections_rate_binding_uq
    UNIQUE (tenant_id, session_fingerprint, session_generation, principal_id),
  ADD CONSTRAINT active_session_context_selections_status_chk
    CHECK (status IN ('ACTIVE', 'ROTATED', 'REVOKED', 'EXPIRED')),
  ADD CONSTRAINT active_session_context_selections_row_version_chk
    CHECK (row_version > 0),
  ADD CONSTRAINT active_session_context_selections_generation_safe_chk
    CHECK (session_generation <= 9007199254740991),
  ADD CONSTRAINT active_session_context_selections_termination_reason_chk
    CHECK (
      (status = 'ACTIVE' AND revoked_at IS NULL AND termination_reason IS NULL)
      OR (
        status = 'ROTATED'
        AND revoked_at IS NOT NULL
        AND termination_reason IS NOT NULL
        AND termination_reason = 'SELF_SWITCH'
      )
      OR (
        status = 'REVOKED'
        AND revoked_at IS NOT NULL
        AND termination_reason IS NOT NULL
        AND termination_reason IN ('SELF_REVOKE', 'SESSION_REVOKED', 'SECURITY_REVOKE')
      )
      OR (
        status = 'EXPIRED'
        AND revoked_at IS NOT NULL
        AND termination_reason IS NOT NULL
        AND termination_reason = 'SESSION_EXPIRED'
      )
    ),
  ADD CONSTRAINT active_session_context_selections_lineage_shape_chk
    CHECK (
      (session_generation = 1 AND previous_selection_id IS NULL)
      OR (session_generation > 1 AND previous_selection_id IS NOT NULL)
    );

CREATE FUNCTION public.harden_active_session_context_selection()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  previous_row public.active_session_context_selections%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'active session context selections are append-only';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ACTIVE'
      OR NEW.revoked_at IS NOT NULL
      OR NEW.termination_reason IS NOT NULL
      OR NEW.row_version <> 1
    THEN
      RAISE EXCEPTION 'new active session context selection must be active version one';
    END IF;
    IF NEW.previous_selection_id IS NULL THEN
      IF NEW.session_generation <> 1 THEN
        RAISE EXCEPTION 'initial active session context selection generation must be one';
      END IF;
    ELSE
      SELECT * INTO previous_row
      FROM public.active_session_context_selections selection
      WHERE selection.tenant_id = NEW.tenant_id
        AND selection.id = NEW.previous_selection_id
      FOR SHARE;
      IF NOT FOUND
        OR previous_row.session_fingerprint IS DISTINCT FROM NEW.session_fingerprint
        OR previous_row.legacy_user_id IS DISTINCT FROM NEW.legacy_user_id
        OR previous_row.principal_id IS DISTINCT FROM NEW.principal_id
        OR previous_row.status <> 'ROTATED'
        OR previous_row.session_generation + 1 IS DISTINCT FROM NEW.session_generation
      THEN
        RAISE EXCEPTION 'active session context selection lineage is invalid';
      END IF;
    END IF;
    NEW.selected_at := statement_timestamp();
    NEW.updated_at := statement_timestamp();
    RETURN NEW;
  END IF;

  IF OLD.status <> 'ACTIVE'
    OR NEW.status NOT IN ('ROTATED', 'REVOKED', 'EXPIRED')
  THEN
    RAISE EXCEPTION 'active session context selection terminal transition is invalid';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.session_fingerprint IS DISTINCT FROM OLD.session_fingerprint
    OR NEW.session_generation IS DISTINCT FROM OLD.session_generation
    OR NEW.legacy_user_id IS DISTINCT FROM OLD.legacy_user_id
    OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
    OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.legacy_branch_id IS DISTINCT FROM OLD.legacy_branch_id
    OR NEW.impersonator_principal_id IS DISTINCT FROM OLD.impersonator_principal_id
    OR NEW.original_session_fingerprint IS DISTINCT FROM OLD.original_session_fingerprint
    OR NEW.previous_selection_id IS DISTINCT FROM OLD.previous_selection_id
    OR NEW.selected_at IS DISTINCT FROM OLD.selected_at
    OR NEW.row_version IS DISTINCT FROM OLD.row_version + 1
  THEN
    RAISE EXCEPTION 'active session context selection identity is immutable';
  END IF;
  IF (NEW.status = 'ROTATED' AND NEW.termination_reason IS DISTINCT FROM 'SELF_SWITCH')
    OR (
      NEW.status = 'REVOKED'
      AND (
        NEW.termination_reason IS NULL
        OR NEW.termination_reason NOT IN (
          'SELF_REVOKE', 'SESSION_REVOKED', 'SECURITY_REVOKE'
        )
      )
    )
    OR (NEW.status = 'EXPIRED' AND NEW.termination_reason IS DISTINCT FROM 'SESSION_EXPIRED')
  THEN
    RAISE EXCEPTION 'active session context selection termination reason is invalid';
  END IF;
  NEW.revoked_at := statement_timestamp();
  NEW.updated_at := statement_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER active_session_context_selections_harden
BEFORE INSERT OR UPDATE OR DELETE ON public.active_session_context_selections
FOR EACH ROW EXECUTE FUNCTION public.harden_active_session_context_selection();

ALTER TABLE public.active_context_issuance_rate_limits
  ADD CONSTRAINT active_context_issuance_rate_limits_exact_selection_fk
    FOREIGN KEY (tenant_id, session_fingerprint, session_generation, principal_id)
    REFERENCES public.active_session_context_selections(
      tenant_id, session_fingerprint, session_generation, principal_id
    ) ON DELETE RESTRICT;

ALTER TABLE public.active_context_issuance_permits
  ADD CONSTRAINT active_context_issuance_permits_exact_selection_fk
    FOREIGN KEY (tenant_id, session_fingerprint, session_generation, principal_id)
    REFERENCES public.active_session_context_selections(
      tenant_id, session_fingerprint, session_generation, principal_id
    ) ON DELETE RESTRICT;

CREATE TABLE public.active_session_context_selection_command_receipts (
  id uuid PRIMARY KEY NOT NULL,
  tenant_id uuid NOT NULL,
  session_fingerprint text NOT NULL,
  actor_principal_id uuid NOT NULL,
  actor_membership_id uuid NOT NULL,
  command_type text NOT NULL,
  requested_tenant_id uuid,
  requested_membership_id uuid,
  expected_selection_id uuid,
  expected_generation bigint NOT NULL,
  outcome text NOT NULL,
  previous_selection_id uuid,
  result_selection_id uuid NOT NULL,
  result_generation bigint NOT NULL,
  result_status text NOT NULL,
  idempotency_key_hash text NOT NULL,
  request_hash text NOT NULL,
  result_hash text NOT NULL,
  environment_id text NOT NULL,
  cell_id text NOT NULL,
  occurred_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
  CONSTRAINT active_session_context_selection_commands_tenant_id_id_uq
    UNIQUE (tenant_id, id),
  CONSTRAINT active_session_context_selection_commands_idempotency_uq
    UNIQUE (session_fingerprint, idempotency_key_hash),
  CONSTRAINT active_session_context_selection_commands_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT active_session_context_selection_commands_actor_membership_fk
    FOREIGN KEY (tenant_id, actor_membership_id, actor_principal_id)
    REFERENCES public.memberships(tenant_id, id, principal_id) ON DELETE RESTRICT,
  CONSTRAINT active_session_context_selection_commands_requested_membership_fk
    FOREIGN KEY (requested_tenant_id, requested_membership_id, actor_principal_id)
    REFERENCES public.memberships(tenant_id, id, principal_id) ON DELETE RESTRICT,
  CONSTRAINT active_session_context_selection_commands_previous_selection_fk
    FOREIGN KEY (tenant_id, previous_selection_id)
    REFERENCES public.active_session_context_selections(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT active_session_context_selection_commands_expected_selection_fk
    FOREIGN KEY (tenant_id, expected_selection_id)
    REFERENCES public.active_session_context_selections(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT active_session_context_selection_commands_expected_binding_fk
    FOREIGN KEY (
      tenant_id, expected_selection_id, session_fingerprint,
      expected_generation, actor_principal_id
    )
    REFERENCES public.active_session_context_selections(
      tenant_id, id, session_fingerprint, session_generation, principal_id
    ) ON DELETE RESTRICT,
  CONSTRAINT active_session_context_selection_commands_result_selection_fk
    FOREIGN KEY (tenant_id, result_selection_id)
    REFERENCES public.active_session_context_selections(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT active_session_context_selection_commands_result_binding_fk
    FOREIGN KEY (
      tenant_id, result_selection_id, session_fingerprint,
      result_generation, actor_principal_id, actor_membership_id
    )
    REFERENCES public.active_session_context_selections(
      tenant_id, id, session_fingerprint, session_generation, principal_id, membership_id
    ) ON DELETE RESTRICT,
  CONSTRAINT active_session_context_selection_commands_id_uuidv7_chk
    CHECK (substring(id::text from 15 for 1) = '7'),
  CONSTRAINT active_session_context_selection_commands_fingerprint_chk
    CHECK (session_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT active_session_context_selection_commands_type_chk
    CHECK (command_type IN ('SELECT', 'REVOKE')),
  CONSTRAINT active_session_context_selection_commands_target_chk
    CHECK (
      (
        command_type = 'SELECT'
        AND requested_tenant_id IS NOT NULL
        AND requested_membership_id IS NOT NULL
        AND (
          (expected_selection_id IS NULL AND expected_generation = 0)
          OR (expected_selection_id IS NOT NULL AND expected_generation > 0)
        )
      )
      OR (
        command_type = 'REVOKE'
        AND requested_tenant_id IS NULL
        AND requested_membership_id IS NULL
        AND expected_selection_id IS NOT NULL
        AND expected_generation > 0
      )
    ),
  CONSTRAINT active_session_context_selection_commands_outcome_chk
    CHECK (outcome IN ('SELECTED', 'UNCHANGED', 'REVOKED')),
  CONSTRAINT active_session_context_selection_commands_semantics_chk
    CHECK (
      (
        command_type = 'SELECT'
        AND outcome IN ('SELECTED', 'UNCHANGED')
        AND tenant_id IS NOT DISTINCT FROM requested_tenant_id
        AND actor_membership_id IS NOT DISTINCT FROM requested_membership_id
      )
      OR (command_type = 'REVOKE' AND outcome = 'REVOKED')
    ),
  CONSTRAINT active_session_context_selection_commands_result_chk
    CHECK (
      result_generation > 0
      AND result_generation <= 9007199254740991
      AND expected_generation <= 9007199254740991
      AND (
        (
          outcome = 'SELECTED'
          AND result_status = 'ACTIVE'
          AND (
            (
              expected_selection_id IS NULL
              AND expected_generation = 0
              AND previous_selection_id IS NULL
              AND result_generation = 1
            )
            OR (
              expected_selection_id IS NOT NULL
              AND expected_generation > 0
              AND previous_selection_id IS NOT DISTINCT FROM expected_selection_id
              AND result_generation = expected_generation + 1
            )
          )
        )
        OR (
          outcome = 'UNCHANGED'
          AND result_status = 'ACTIVE'
          AND expected_selection_id IS NOT NULL
          AND previous_selection_id IS NULL
          AND result_selection_id IS NOT DISTINCT FROM expected_selection_id
          AND result_generation = expected_generation
        )
        OR (
          outcome = 'REVOKED'
          AND result_status = 'REVOKED'
          AND previous_selection_id IS NOT DISTINCT FROM expected_selection_id
          AND result_selection_id IS NOT DISTINCT FROM expected_selection_id
          AND result_generation = expected_generation
        )
      )
    ),
  CONSTRAINT active_session_context_selection_commands_hashes_chk
    CHECK (
      idempotency_key_hash ~ '^[0-9a-f]{64}$'
      AND request_hash ~ '^[0-9a-f]{64}$'
      AND result_hash ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT active_session_context_selection_commands_deployment_chk
    CHECK (
      environment_id ~ '^[a-z][a-z0-9-]{1,62}$'
      AND cell_id ~ '^[a-z][a-z0-9-]{1,62}$'
    )
);

CREATE INDEX active_session_context_selection_commands_tenant_actor_idx
  ON public.active_session_context_selection_command_receipts
  (tenant_id, actor_principal_id, occurred_at);

ALTER TABLE public.active_session_context_selection_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.active_session_context_selection_command_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY active_session_context_selection_commands_owner_or_tenant
  ON public.active_session_context_selection_command_receipts FOR SELECT
  USING (
    current_user = 'fas_session_owner'
    OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

CREATE POLICY active_session_context_selection_commands_lifecycle_owner
  ON public.active_session_context_selection_command_receipts FOR ALL
  USING (current_user = 'fas_session_lifecycle_owner')
  WITH CHECK (current_user = 'fas_session_lifecycle_owner');

CREATE POLICY active_session_context_selections_lifecycle_owner
  ON public.active_session_context_selections FOR ALL
  USING (current_user = 'fas_session_lifecycle_owner')
  WITH CHECK (current_user = 'fas_session_lifecycle_owner');

CREATE FUNCTION public.reject_active_session_context_selection_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'active session context selection command receipts are immutable';
END;
$$;

CREATE TRIGGER active_session_context_selection_commands_immutable
BEFORE UPDATE OR DELETE ON public.active_session_context_selection_command_receipts
FOR EACH ROW EXECUTE FUNCTION public.reject_active_session_context_selection_receipt_mutation();

CREATE SCHEMA fas_session_lifecycle_v1;
REVOKE ALL ON SCHEMA fas_session_lifecycle_v1 FROM PUBLIC;

CREATE FUNCTION fas_session_lifecycle_v1.apply_self_selection_command(
  p_session_id text,
  p_session_fingerprint text,
  p_command_type text,
  p_target_tenant uuid,
  p_target_membership uuid,
  p_expected_selection uuid,
  p_expected_generation bigint,
  p_idempotency_key_hash text,
  p_request_hash text,
  p_command_id uuid,
  p_selection_id uuid,
  p_environment_id text,
  p_cell_id text,
  p_observed_at bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  session_row public.sessions%ROWTYPE;
  user_row public.users%ROWTYPE;
  principal_row public.principals%ROWTYPE;
  membership_row public.memberships%ROWTYPE;
  tenant_row public.tenants%ROWTYPE;
  organization_status text;
  latest_selection public.active_session_context_selections%ROWTYPE;
  active_selection public.active_session_context_selections%ROWTYPE;
  replay_row public.active_session_context_selection_command_receipts%ROWTYPE;
  observed_at timestamp with time zone;
  session_user_id integer;
  issued_at bigint;
  expected_request_hash text;
  computed_result_hash text;
  result_selection_id uuid;
  result_generation bigint;
  result_status text;
  result_outcome text;
  previous_selection_id uuid;
BEGIN
  IF current_setting('transaction_isolation') <> 'serializable' THEN
    RAISE EXCEPTION 'active context selection lifecycle requires a serializable transaction';
  END IF;
  IF NULLIF(current_setting('app.tenant_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'active context selection lifecycle requires a clean tenant context';
  END IF;
  IF p_session_id IS NULL
    OR p_session_id !~ '^[0-9a-f]{64}$'
    OR p_session_fingerprint IS NULL
    OR p_session_fingerprint !~ '^[0-9a-f]{64}$'
    OR encode(sha256(convert_to(p_session_id, 'UTF8')), 'hex')
       IS DISTINCT FROM p_session_fingerprint
    OR p_command_type IS NULL
    OR p_command_type NOT IN ('SELECT', 'REVOKE')
    OR (p_command_type = 'SELECT' AND (p_target_tenant IS NULL OR p_target_membership IS NULL))
    OR (p_command_type = 'REVOKE' AND (p_target_tenant IS NOT NULL OR p_target_membership IS NOT NULL))
    OR p_expected_generation IS NULL
    OR p_expected_generation < 0
    OR p_expected_generation > 9007199254740991
    OR (
      p_command_type = 'SELECT'
      AND NOT (
        (p_expected_selection IS NULL AND p_expected_generation = 0)
        OR (
          p_expected_selection IS NOT NULL
          AND substring(p_expected_selection::text from 15 for 1) = '7'
          AND p_expected_generation > 0
        )
      )
    )
    OR (
      p_command_type = 'REVOKE'
      AND (
        p_expected_selection IS NULL
        OR substring(p_expected_selection::text from 15 for 1) <> '7'
        OR p_expected_generation <= 0
      )
    )
    OR p_idempotency_key_hash IS NULL
    OR p_idempotency_key_hash !~ '^[0-9a-f]{64}$'
    OR p_request_hash IS NULL
    OR p_request_hash !~ '^[0-9a-f]{64}$'
    OR p_command_id IS NULL
    OR substring(p_command_id::text from 15 for 1) <> '7'
    OR p_selection_id IS NULL
    OR substring(p_selection_id::text from 15 for 1) <> '7'
    OR p_environment_id IS NULL
    OR p_environment_id !~ '^[a-z][a-z0-9-]{1,62}$'
    OR p_cell_id IS NULL
    OR p_cell_id !~ '^[a-z][a-z0-9-]{1,62}$'
    OR p_observed_at IS NULL
    OR p_observed_at < 0
    OR p_observed_at > 253402300799999
  THEN
    RAISE EXCEPTION 'active context selection lifecycle input is invalid';
  END IF;
  observed_at := to_timestamp(p_observed_at / 1000.0);
  IF observed_at < statement_timestamp() - interval '30 seconds'
    OR observed_at > statement_timestamp() + interval '5 seconds'
  THEN
    RAISE EXCEPTION 'active context selection lifecycle observation is stale';
  END IF;

  expected_request_hash := encode(sha256(
    convert_to('fas.active-context-selection-request.v1', 'UTF8')
    || decode('00', 'hex') || convert_to(p_session_fingerprint, 'UTF8')
    || decode('00', 'hex') || convert_to(p_command_type, 'UTF8')
    || decode('00', 'hex') || convert_to(coalesce(p_target_tenant::text, ''), 'UTF8')
    || decode('00', 'hex') || convert_to(coalesce(p_target_membership::text, ''), 'UTF8')
    || decode('00', 'hex') || convert_to(coalesce(p_expected_selection::text, ''), 'UTF8')
    || decode('00', 'hex') || convert_to(p_expected_generation::text, 'UTF8')
  ), 'hex');
  IF expected_request_hash IS DISTINCT FROM p_request_hash THEN
    RAISE EXCEPTION 'active context selection lifecycle request hash mismatch';
  END IF;

  SELECT * INTO session_row
  FROM public.sessions session
  WHERE session.sid = p_session_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active context selection lifecycle session missing';
  END IF;
  IF jsonb_typeof(session_row.sess -> 'user' -> 'id') IS DISTINCT FROM 'number'
    OR jsonb_typeof(session_row.sess -> 'issued_at') IS DISTINCT FROM 'number'
    OR session_row.sess ? 'originalSid'
  THEN
    RAISE EXCEPTION 'active context selection lifecycle session invalid';
  END IF;
  BEGIN
    session_user_id := (session_row.sess -> 'user' ->> 'id')::integer;
    issued_at := (session_row.sess ->> 'issued_at')::bigint;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'active context selection lifecycle session invalid';
  END;
  IF session_user_id <= 0
    OR session_user_id IS NULL
    OR issued_at IS NULL
    OR issued_at <= 0
    OR issued_at > p_observed_at
    OR session_row.user_id IS DISTINCT FROM session_user_id
    OR session_row.expire IS NULL
    OR floor(
      extract(epoch FROM session_row.expire AT TIME ZONE 'UTC') * 1000
    )::bigint <= p_observed_at
    OR to_timestamp((issued_at + 86400000) / 1000.0) <= observed_at
  THEN
    RAISE EXCEPTION 'active context selection lifecycle session inactive';
  END IF;

  SELECT * INTO user_row
  FROM public.users account
  WHERE account.id = session_user_id
  FOR SHARE;
  SELECT * INTO principal_row
  FROM public.principals principal
  WHERE principal.legacy_user_id = session_user_id
  FOR SHARE;
  IF user_row.id IS NULL
    OR user_row.deleted_at IS NOT NULL
    OR user_row.is_active = false
    OR (user_row.role = 'student' AND user_row.email_verified = false)
    OR principal_row.id IS NULL
    OR principal_row.principal_type <> 'HUMAN'
    OR principal_row.status <> 'ACTIVE'
    OR principal_row.risk_state <> 'NORMAL'
  THEN
    RAISE EXCEPTION 'active context selection lifecycle actor inactive';
  END IF;

  SELECT * INTO replay_row
  FROM public.active_session_context_selection_command_receipts receipt
  WHERE receipt.session_fingerprint = p_session_fingerprint
    AND receipt.idempotency_key_hash = p_idempotency_key_hash
  FOR SHARE;
  IF FOUND THEN
    IF replay_row.request_hash IS DISTINCT FROM p_request_hash
      OR replay_row.command_type IS DISTINCT FROM p_command_type
      OR replay_row.actor_principal_id IS DISTINCT FROM principal_row.id
      OR replay_row.environment_id IS DISTINCT FROM p_environment_id
      OR replay_row.cell_id IS DISTINCT FROM p_cell_id
    THEN
      RAISE EXCEPTION 'active context selection lifecycle idempotency conflict';
    END IF;
    RETURN jsonb_build_object(
      'commandId', replay_row.id,
      'outcome', replay_row.outcome,
      'selectionId', replay_row.result_selection_id,
      'sessionGeneration', replay_row.result_generation,
      'tenantId', replay_row.tenant_id,
      'principalId', replay_row.actor_principal_id,
      'membershipId', replay_row.actor_membership_id,
      'requestHash', replay_row.request_hash,
      'resultHash', replay_row.result_hash,
      'replayed', true
    );
  END IF;

  SELECT * INTO latest_selection
  FROM public.active_session_context_selections selection
  WHERE selection.session_fingerprint = p_session_fingerprint
  ORDER BY selection.session_generation DESC
  LIMIT 1
  FOR UPDATE;
  SELECT * INTO active_selection
  FROM public.active_session_context_selections selection
  WHERE selection.session_fingerprint = p_session_fingerprint
    AND selection.status = 'ACTIVE'
  FOR UPDATE;

  IF (
      latest_selection.id IS NOT NULL
      AND (
        latest_selection.impersonator_principal_id IS NOT NULL
        OR latest_selection.original_session_fingerprint IS NOT NULL
      )
    )
    OR (
      active_selection.id IS NOT NULL
      AND (
        active_selection.impersonator_principal_id IS NOT NULL
        OR active_selection.original_session_fingerprint IS NOT NULL
      )
    )
  THEN
    RAISE EXCEPTION 'active context selection lifecycle impersonation denied';
  END IF;

  IF p_command_type = 'SELECT' THEN
    IF (active_selection.id IS NULL AND p_expected_selection IS NOT NULL)
      OR (
        active_selection.id IS NOT NULL
        AND (
          active_selection.id IS DISTINCT FROM p_expected_selection
          OR active_selection.session_generation IS DISTINCT FROM p_expected_generation
        )
      )
    THEN
      RAISE EXCEPTION 'active context selection lifecycle stale expectation';
    END IF;
    IF active_selection.id IS NOT NULL
      AND active_selection.tenant_id IS DISTINCT FROM p_target_tenant
    THEN
      RAISE EXCEPTION 'active context selection lifecycle cross tenant switch denied';
    END IF;
    PERFORM set_config('app.tenant_id', p_target_tenant::text, true);
    SELECT * INTO tenant_row
    FROM public.tenants tenant
    WHERE tenant.id = p_target_tenant
    FOR SHARE;
    SELECT * INTO membership_row
    FROM public.memberships membership
    WHERE membership.tenant_id = p_target_tenant
      AND membership.id = p_target_membership
      AND membership.principal_id = principal_row.id
    FOR SHARE;
    IF tenant_row.id IS NULL
      OR tenant_row.status <> 'ACTIVE'
      OR membership_row.id IS NULL
      OR membership_row.status <> 'ACTIVE'
      OR membership_row.valid_from > observed_at
      OR (membership_row.valid_until IS NOT NULL AND membership_row.valid_until <= observed_at)
    THEN
      RAISE EXCEPTION 'active context selection lifecycle target inactive';
    END IF;
    IF membership_row.organization_id IS NOT NULL THEN
      SELECT organization.status INTO organization_status
      FROM public.organizations organization
      WHERE organization.tenant_id = p_target_tenant
        AND organization.id = membership_row.organization_id
      FOR SHARE;
      IF organization_status IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'active context selection lifecycle organization inactive';
      END IF;
    END IF;
    IF membership_row.legacy_branch_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.tenant_organization_legacy_branches branch_map
        WHERE branch_map.tenant_id = p_target_tenant
          AND branch_map.organization_id = membership_row.organization_id
          AND branch_map.legacy_branch_id = membership_row.legacy_branch_id
      )
    THEN
      RAISE EXCEPTION 'active context selection lifecycle branch inactive';
    END IF;

    IF active_selection.id IS NOT NULL
      AND active_selection.principal_id IS DISTINCT FROM principal_row.id
    THEN
      RAISE EXCEPTION 'active context selection lifecycle session principal mismatch';
    END IF;
    IF active_selection.id IS NOT NULL
      AND active_selection.tenant_id = p_target_tenant
      AND active_selection.membership_id = p_target_membership
      AND active_selection.organization_id IS NOT DISTINCT FROM membership_row.organization_id
      AND active_selection.legacy_branch_id IS NOT DISTINCT FROM membership_row.legacy_branch_id
    THEN
      result_outcome := 'UNCHANGED';
      result_selection_id := active_selection.id;
      result_generation := active_selection.session_generation;
      result_status := active_selection.status;
      previous_selection_id := NULL;
    ELSE
      IF active_selection.id IS NOT NULL THEN
        UPDATE public.active_session_context_selections
        SET status = 'ROTATED', termination_reason = 'SELF_SWITCH',
            row_version = row_version + 1
        WHERE tenant_id = active_selection.tenant_id
          AND id = active_selection.id;
        previous_selection_id := active_selection.id;
        result_generation := active_selection.session_generation + 1;
      ELSIF latest_selection.id IS NULL THEN
        previous_selection_id := NULL;
        result_generation := 1;
      ELSE
        RAISE EXCEPTION 'active context selection lifecycle lineage inactive';
      END IF;
      INSERT INTO public.active_session_context_selections (
        id, tenant_id, session_fingerprint, session_generation,
        legacy_user_id, principal_id, membership_id, organization_id,
        legacy_branch_id, status, previous_selection_id, row_version
      ) VALUES (
        p_selection_id, p_target_tenant, p_session_fingerprint, result_generation,
        session_user_id, principal_row.id, membership_row.id,
        membership_row.organization_id, membership_row.legacy_branch_id,
        'ACTIVE', previous_selection_id, 1
      );
      result_outcome := 'SELECTED';
      result_selection_id := p_selection_id;
      result_status := 'ACTIVE';
    END IF;
  ELSE
    IF active_selection.id IS NULL
      OR active_selection.principal_id IS DISTINCT FROM principal_row.id
      OR active_selection.legacy_user_id IS DISTINCT FROM session_user_id
      OR active_selection.id IS DISTINCT FROM p_expected_selection
      OR active_selection.session_generation IS DISTINCT FROM p_expected_generation
    THEN
      RAISE EXCEPTION 'active context selection lifecycle active selection missing';
    END IF;
    PERFORM set_config('app.tenant_id', active_selection.tenant_id::text, true);
    SELECT * INTO membership_row
    FROM public.memberships membership
    WHERE membership.tenant_id = active_selection.tenant_id
      AND membership.id = active_selection.membership_id
      AND membership.principal_id = principal_row.id
    FOR SHARE;
    IF membership_row.id IS NULL THEN
      RAISE EXCEPTION 'active context selection lifecycle membership missing';
    END IF;
    UPDATE public.active_session_context_selections
    SET status = 'REVOKED', termination_reason = 'SELF_REVOKE',
        row_version = row_version + 1
    WHERE tenant_id = active_selection.tenant_id
      AND id = active_selection.id;
    result_outcome := 'REVOKED';
    result_selection_id := active_selection.id;
    result_generation := active_selection.session_generation;
    result_status := 'REVOKED';
    previous_selection_id := active_selection.id;
  END IF;

  computed_result_hash := encode(sha256(
    convert_to('fas.active-context-selection-result.v1', 'UTF8')
    || decode('00', 'hex') || convert_to(p_command_id::text, 'UTF8')
    || decode('00', 'hex') || convert_to(result_outcome, 'UTF8')
    || decode('00', 'hex') || convert_to(result_selection_id::text, 'UTF8')
    || decode('00', 'hex') || convert_to(result_generation::text, 'UTF8')
    || decode('00', 'hex') || convert_to(coalesce(p_target_tenant, active_selection.tenant_id)::text, 'UTF8')
    || decode('00', 'hex') || convert_to(principal_row.id::text, 'UTF8')
    || decode('00', 'hex') || convert_to(membership_row.id::text, 'UTF8')
  ), 'hex');

  INSERT INTO public.active_session_context_selection_command_receipts (
    id, tenant_id, session_fingerprint, actor_principal_id, actor_membership_id,
    command_type, requested_tenant_id, requested_membership_id, outcome,
    expected_selection_id, expected_generation,
    previous_selection_id, result_selection_id, result_generation, result_status,
    idempotency_key_hash, request_hash, result_hash, environment_id, cell_id
  ) VALUES (
    p_command_id, coalesce(p_target_tenant, active_selection.tenant_id),
    p_session_fingerprint, principal_row.id, membership_row.id,
    p_command_type, p_target_tenant, p_target_membership, result_outcome,
    p_expected_selection, p_expected_generation,
    previous_selection_id, result_selection_id, result_generation, result_status,
    p_idempotency_key_hash, p_request_hash, computed_result_hash,
    p_environment_id, p_cell_id
  );

  RETURN jsonb_build_object(
    'commandId', p_command_id,
    'outcome', result_outcome,
    'selectionId', result_selection_id,
    'sessionGeneration', result_generation,
    'tenantId', coalesce(p_target_tenant, active_selection.tenant_id),
    'principalId', principal_row.id,
    'membershipId', membership_row.id,
    'requestHash', p_request_hash,
    'resultHash', computed_result_hash,
    'replayed', false
  );
END;
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fas_session_lifecycle_v1 FROM PUBLIC;

COMMENT ON SCHEMA fas_session_lifecycle_v1 IS
  'Default-unwired EXECUTE-only self-session active-context selection lifecycle facade.';
COMMENT ON FUNCTION fas_session_lifecycle_v1.apply_self_selection_command(
  text, text, text, uuid, uuid, uuid, bigint, text, text, uuid, uuid, text, text, bigint
) IS
  'Atomically selects or revokes only the current non-impersonated session principal membership with immutable idempotent receipt.';
