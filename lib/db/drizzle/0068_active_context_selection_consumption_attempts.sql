-- Additive, default-unwired outer-attempt ledger for selection consumption.
-- No login role or grant is created here; the reviewed harness/bootstrap owns
-- the function owner and EXECUTE-only credential contract.

ALTER TABLE public.active_session_context_selections
  ADD CONSTRAINT active_session_context_selections_attempt_binding_uq
  UNIQUE (tenant_id, id, session_generation, principal_id, membership_id);

CREATE TABLE public.active_context_selection_consumption_attempts (
  id uuid PRIMARY KEY NOT NULL,
  tenant_id uuid NOT NULL,
  context_id uuid NOT NULL,
  selection_id uuid NOT NULL,
  session_generation bigint NOT NULL,
  principal_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  idempotency_key_hash text NOT NULL,
  request_hash text NOT NULL,
  environment_id text NOT NULL,
  cell_id text NOT NULL,
  status text NOT NULL,
  outcome text,
  reason_code text,
  result_hash text,
  occurred_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
  updated_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
  CONSTRAINT active_context_selection_consumption_attempts_id_uuidv7_chk
    CHECK (substring(id::text from 15 for 1) = '7'),
  CONSTRAINT active_context_selection_consumption_attempts_context_uuidv7_chk
    CHECK (substring(context_id::text from 15 for 1) = '7'),
  CONSTRAINT active_context_selection_consumption_attempts_hashes_chk
    CHECK (
      idempotency_key_hash ~ '^[0-9a-f]{64}$'
      AND request_hash ~ '^[0-9a-f]{64}$'
      AND (result_hash IS NULL OR result_hash ~ '^[0-9a-f]{64}$')
    ),
  CONSTRAINT active_context_selection_consumption_attempts_generation_chk
    CHECK (session_generation > 0 AND session_generation <= 9007199254740991),
  CONSTRAINT active_context_selection_consumption_attempts_status_chk
    CHECK (status IN ('STARTED', 'PENDING', 'TERMINAL')),
  CONSTRAINT active_context_selection_consumption_attempts_outcome_chk
    CHECK (
      (status <> 'TERMINAL' AND outcome IS NULL AND reason_code IS NULL AND result_hash IS NULL)
      OR (
        status = 'TERMINAL'
        AND outcome IN ('COMPLETED', 'DENIED', 'CONFLICT', 'ERROR')
        AND reason_code IN (
          'COMMAND_COMPLETED', 'COMMAND_RECONCILED',
          'AUTHORIZATION_DENIED', 'IDEMPOTENCY_CONFLICT', 'INTERNAL_ERROR'
        )
        AND (result_hash IS NULL OR result_hash ~ '^[0-9a-f]{64}$')
      )
    ),
  CONSTRAINT active_context_selection_consumption_attempts_transition_chk
    CHECK (
      (status = 'STARTED' AND outcome IS NULL)
      OR (status = 'PENDING' AND outcome IS NULL)
      OR (
        status = 'TERMINAL'
        AND (
          (outcome = 'COMPLETED' AND reason_code IN ('COMMAND_COMPLETED', 'COMMAND_RECONCILED'))
          OR (outcome = 'DENIED' AND reason_code = 'AUTHORIZATION_DENIED')
          OR (outcome = 'CONFLICT' AND reason_code = 'IDEMPOTENCY_CONFLICT')
          OR (outcome = 'ERROR' AND reason_code = 'INTERNAL_ERROR')
        )
      )
    ),
  CONSTRAINT active_context_selection_consumption_attempts_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT active_context_selection_consumption_attempts_selection_fk
    FOREIGN KEY (
      tenant_id, selection_id, session_generation, principal_id, membership_id
    ) REFERENCES public.active_session_context_selections(
      tenant_id, id, session_generation, principal_id, membership_id
    ) ON DELETE RESTRICT,
  CONSTRAINT active_context_selection_consumption_attempts_idempotency_uq
    UNIQUE (tenant_id, idempotency_key_hash)
);

CREATE INDEX active_context_selection_consumption_attempts_pending_idx
  ON public.active_context_selection_consumption_attempts (tenant_id, status, occurred_at)
  WHERE status = 'PENDING';

CREATE TABLE public.active_context_selection_consumption_attempt_receipts (
  tenant_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  sequence integer NOT NULL,
  phase text NOT NULL,
  outcome text NOT NULL,
  reason_code text NOT NULL,
  result_hash text,
  occurred_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
  PRIMARY KEY (tenant_id, attempt_id, sequence),
  CONSTRAINT active_context_selection_consumption_receipts_sequence_chk
    CHECK (sequence >= 1 AND sequence <= 3),
  CONSTRAINT active_context_selection_consumption_receipts_phase_chk
    CHECK (phase IN ('ATTEMPT_STARTED', 'RECONCILIATION', 'TERMINAL')),
  CONSTRAINT active_context_selection_consumption_receipts_outcome_chk
    CHECK (
      (phase = 'ATTEMPT_STARTED' AND outcome = 'STARTED' AND reason_code = 'REQUEST_ACCEPTED')
      OR (phase = 'RECONCILIATION' AND outcome = 'PENDING' AND reason_code = 'COMMIT_OUTCOME_UNKNOWN')
      OR (
        phase = 'TERMINAL'
        AND (
          (outcome = 'COMPLETED' AND reason_code IN ('COMMAND_COMPLETED', 'COMMAND_RECONCILED'))
          OR (outcome = 'DENIED' AND reason_code = 'AUTHORIZATION_DENIED')
          OR (outcome = 'CONFLICT' AND reason_code = 'IDEMPOTENCY_CONFLICT')
          OR (outcome = 'ERROR' AND reason_code = 'INTERNAL_ERROR')
        )
      )
    ),
  CONSTRAINT active_context_selection_consumption_receipts_hash_chk
    CHECK (result_hash IS NULL OR result_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT active_context_selection_consumption_receipts_attempt_fk
    FOREIGN KEY (tenant_id, attempt_id)
    REFERENCES public.active_context_selection_consumption_attempts(tenant_id, id)
    ON DELETE RESTRICT
);

ALTER TABLE public.active_context_selection_consumption_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.active_context_selection_consumption_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.active_context_selection_consumption_attempt_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.active_context_selection_consumption_attempt_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY active_context_selection_consumption_attempts_owner_or_tenant
  ON public.active_context_selection_consumption_attempts FOR SELECT
  USING (
    current_user = 'fas_session_owner'
    OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
CREATE POLICY active_context_selection_consumption_attempts_owner
  ON public.active_context_selection_consumption_attempts FOR ALL
  USING (current_user = 'fas_session_owner')
  WITH CHECK (current_user = 'fas_session_owner');
CREATE POLICY active_context_selection_consumption_receipts_owner_or_tenant
  ON public.active_context_selection_consumption_attempt_receipts FOR SELECT
  USING (
    current_user = 'fas_session_owner'
    OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
CREATE POLICY active_context_selection_consumption_receipts_owner
  ON public.active_context_selection_consumption_attempt_receipts FOR ALL
  USING (current_user = 'fas_session_owner')
  WITH CHECK (current_user = 'fas_session_owner');

CREATE FUNCTION public.reject_active_context_selection_consumption_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'active context selection consumption receipts are immutable';
END;
$$;

CREATE TRIGGER active_context_selection_consumption_receipts_immutable
BEFORE UPDATE OR DELETE ON public.active_context_selection_consumption_attempt_receipts
FOR EACH ROW EXECUTE FUNCTION public.reject_active_context_selection_consumption_receipt_mutation();
REVOKE ALL ON FUNCTION public.reject_active_context_selection_consumption_receipt_mutation() FROM PUBLIC;

CREATE FUNCTION fas_session_v1.start_selection_consumption_attempt(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  attempt_row public.active_context_selection_consumption_attempts%ROWTYPE;
  v_tenant uuid;
  v_attempt uuid;
  v_context uuid;
  v_selection uuid;
  v_generation bigint;
  v_principal uuid;
  v_membership uuid;
  v_idempotency text;
  v_request text;
  v_environment text;
  v_cell text;
BEGIN
  IF current_setting('transaction_isolation') <> 'serializable'
    OR current_setting('app.tenant_id', true) IS NULL
    OR p_payload IS NULL
    OR (SELECT count(*) FROM jsonb_object_keys(p_payload)) <> 11
    OR NOT (p_payload ?& ARRAY[
      'attemptId', 'tenantId', 'contextId', 'selectionId',
      'sessionGeneration', 'principalId', 'membershipId',
      'idempotencyKeyHash', 'requestHash', 'environmentId', 'cellId'
    ])
  THEN
    RAISE EXCEPTION 'selection consumption attempt input is invalid';
  END IF;
  v_tenant := (p_payload->>'tenantId')::uuid;
  v_attempt := (p_payload->>'attemptId')::uuid;
  v_context := (p_payload->>'contextId')::uuid;
  v_selection := (p_payload->>'selectionId')::uuid;
  v_generation := (p_payload->>'sessionGeneration')::bigint;
  v_principal := (p_payload->>'principalId')::uuid;
  v_membership := (p_payload->>'membershipId')::uuid;
  v_idempotency := p_payload->>'idempotencyKeyHash';
  v_request := p_payload->>'requestHash';
  v_environment := p_payload->>'environmentId';
  v_cell := p_payload->>'cellId';
  IF NULLIF(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM v_tenant
    OR substring(v_attempt::text from 15 for 1) <> '7'
    OR substring(v_context::text from 15 for 1) <> '7'
    OR v_generation <= 0
    OR v_generation > 9007199254740991
    OR v_idempotency !~ '^[0-9a-f]{64}$'
    OR v_request !~ '^[0-9a-f]{64}$'
    OR v_environment !~ '^[a-z][a-z0-9-]{1,62}$'
    OR v_cell !~ '^[a-z][a-z0-9-]{1,62}$'
  THEN
    RAISE EXCEPTION 'selection consumption attempt identity is invalid';
  END IF;
  SELECT * INTO attempt_row
  FROM public.active_context_selection_consumption_attempts
  WHERE tenant_id = v_tenant AND idempotency_key_hash = v_idempotency
  FOR UPDATE;
  IF FOUND THEN
    IF attempt_row.request_hash IS DISTINCT FROM v_request
      OR attempt_row.context_id IS DISTINCT FROM v_context
      OR attempt_row.selection_id IS DISTINCT FROM v_selection
      OR attempt_row.session_generation IS DISTINCT FROM v_generation
      OR attempt_row.principal_id IS DISTINCT FROM v_principal
      OR attempt_row.membership_id IS DISTINCT FROM v_membership
    THEN
      RAISE EXCEPTION 'selection consumption attempt idempotency conflict';
    END IF;
    RETURN jsonb_build_object(
      'attemptId', attempt_row.id,
      'status', attempt_row.status,
      'replayed', true
    );
  END IF;
  INSERT INTO public.active_context_selection_consumption_attempts (
    id, tenant_id, context_id, selection_id, session_generation,
    principal_id, membership_id, idempotency_key_hash, request_hash,
    environment_id, cell_id, status
  ) VALUES (
    v_attempt, v_tenant, v_context, v_selection, v_generation,
    v_principal, v_membership, v_idempotency, v_request,
    v_environment, v_cell, 'STARTED'
  );
  INSERT INTO public.active_context_selection_consumption_attempt_receipts (
    tenant_id, attempt_id, sequence, phase, outcome, reason_code
  ) VALUES (v_tenant, v_attempt, 1, 'ATTEMPT_STARTED', 'STARTED', 'REQUEST_ACCEPTED');
  RETURN jsonb_build_object('attemptId', v_attempt, 'status', 'STARTED', 'replayed', false);
END;
$$;

CREATE FUNCTION fas_session_v1.finish_selection_consumption_attempt(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  attempt_row public.active_context_selection_consumption_attempts%ROWTYPE;
  v_tenant uuid;
  v_attempt uuid;
  v_phase text;
  v_outcome text;
  v_reason text;
  v_result text;
  v_sequence integer;
BEGIN
  IF current_setting('transaction_isolation') <> 'serializable'
    OR current_setting('app.tenant_id', true) IS NULL
    OR p_payload IS NULL
    OR (SELECT count(*) FROM jsonb_object_keys(p_payload)) <> 6
    OR NOT (p_payload ?& ARRAY[
      'attemptId', 'tenantId', 'phase', 'outcome', 'reasonCode', 'resultHash'
    ])
  THEN
    RAISE EXCEPTION 'selection consumption attempt result is invalid';
  END IF;
  v_tenant := (p_payload->>'tenantId')::uuid;
  v_attempt := (p_payload->>'attemptId')::uuid;
  v_phase := p_payload->>'phase';
  v_outcome := p_payload->>'outcome';
  v_reason := p_payload->>'reasonCode';
  v_result := p_payload->>'resultHash';
  IF NULLIF(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM v_tenant
    OR v_phase NOT IN ('RECONCILIATION', 'TERMINAL')
    OR (v_phase = 'TERMINAL' AND (v_result IS NULL OR v_result !~ '^[0-9a-f]{64}$'))
    OR NOT (
      (v_phase = 'RECONCILIATION' AND v_outcome = 'PENDING' AND v_reason = 'COMMIT_OUTCOME_UNKNOWN')
      OR (v_phase = 'TERMINAL' AND v_outcome = 'COMPLETED' AND v_reason IN ('COMMAND_COMPLETED', 'COMMAND_RECONCILED'))
      OR (v_phase = 'TERMINAL' AND v_outcome = 'DENIED' AND v_reason = 'AUTHORIZATION_DENIED')
      OR (v_phase = 'TERMINAL' AND v_outcome = 'CONFLICT' AND v_reason = 'IDEMPOTENCY_CONFLICT')
      OR (v_phase = 'TERMINAL' AND v_outcome = 'ERROR' AND v_reason = 'INTERNAL_ERROR')
    )
  THEN
    RAISE EXCEPTION 'selection consumption attempt result semantics are invalid';
  END IF;
  SELECT * INTO attempt_row
  FROM public.active_context_selection_consumption_attempts
  WHERE tenant_id = v_tenant AND id = v_attempt
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'selection consumption attempt not found'; END IF;
  IF v_phase = 'RECONCILIATION' THEN
    IF attempt_row.status = 'PENDING' THEN
      RETURN jsonb_build_object('attemptId', v_attempt, 'status', 'PENDING', 'replayed', true);
    END IF;
    IF attempt_row.status <> 'STARTED' THEN
      RAISE EXCEPTION 'selection consumption attempt transition invalid';
    END IF;
    v_sequence := 2;
    UPDATE public.active_context_selection_consumption_attempts
      SET status = 'PENDING', updated_at = statement_timestamp()
      WHERE tenant_id = v_tenant AND id = v_attempt;
  ELSE
    IF attempt_row.status = 'TERMINAL' THEN
      IF attempt_row.outcome IS NOT DISTINCT FROM v_outcome
        AND attempt_row.reason_code IS NOT DISTINCT FROM v_reason
        AND attempt_row.result_hash IS NOT DISTINCT FROM v_result
      THEN
        RETURN jsonb_build_object('attemptId', v_attempt, 'status', 'TERMINAL', 'replayed', true);
      END IF;
      RAISE EXCEPTION 'selection consumption attempt terminal conflict';
    END IF;
    IF attempt_row.status NOT IN ('STARTED', 'PENDING') THEN
      RAISE EXCEPTION 'selection consumption attempt transition invalid';
    END IF;
    v_sequence := CASE WHEN attempt_row.status = 'PENDING' THEN 3 ELSE 2 END;
    UPDATE public.active_context_selection_consumption_attempts
      SET status = 'TERMINAL', outcome = v_outcome, reason_code = v_reason,
          result_hash = v_result, updated_at = statement_timestamp()
      WHERE tenant_id = v_tenant AND id = v_attempt;
  END IF;
  INSERT INTO public.active_context_selection_consumption_attempt_receipts (
    tenant_id, attempt_id, sequence, phase, outcome, reason_code, result_hash
  ) VALUES (v_tenant, v_attempt, v_sequence, v_phase, v_outcome, v_reason,
            CASE WHEN v_phase = 'RECONCILIATION' THEN NULL ELSE v_result END);
  RETURN jsonb_build_object('attemptId', v_attempt, 'status',
    CASE WHEN v_phase = 'RECONCILIATION' THEN 'PENDING' ELSE 'TERMINAL' END,
    'replayed', false);
END;
$$;

REVOKE ALL ON FUNCTION fas_session_v1.start_selection_consumption_attempt(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION fas_session_v1.finish_selection_consumption_attempt(jsonb) FROM PUBLIC;

COMMENT ON TABLE public.active_context_selection_consumption_attempts IS
  'Default-unwired outer attempt identity and non-PII status for selection-bound consumption.';
COMMENT ON TABLE public.active_context_selection_consumption_attempt_receipts IS
  'Append-only PENDING/terminal receipts for selection-bound consumption reconciliation.';
