LOCK TABLE public.change_set_command_audit_events IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.change_set_command_audit_events
  DROP CONSTRAINT change_set_command_audit_events_command_chk,
  ADD CONSTRAINT change_set_command_audit_events_command_chk
    CHECK (
      (command_type = 'CREATE' AND target_state IS NULL)
      OR (
        command_type = 'TRANSITION'
        AND target_state IS NOT NULL
        AND target_state IN ('VALIDATED', 'SIMULATED', 'IN_REVIEW')
      )
    ),
  ADD CONSTRAINT change_set_command_audit_events_terminal_success_change_set_chk
    CHECK (
      phase <> 'TERMINAL'
      OR outcome <> 'SUCCESS'
      OR change_set_id IS NOT NULL
    );

CREATE OR REPLACE FUNCTION public.enforce_change_set_command_audit_chain() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  prior_event public.change_set_command_audit_events%ROWTYPE;
BEGIN
  NEW.occurred_at := statement_timestamp();
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(NEW.tenant_id::text || ':' || NEW.attempt_id::text, 0)
  );
  SELECT * INTO prior_event
  FROM public.change_set_command_audit_events
  WHERE tenant_id = NEW.tenant_id AND attempt_id = NEW.attempt_id
  ORDER BY sequence DESC
  LIMIT 1;

  IF prior_event.sequence IS NULL THEN
    IF NEW.sequence <> 1
      OR NEW.previous_hash IS NOT NULL
      OR NEW.change_set_id IS NOT NULL
      OR NEW.phase <> 'ATTEMPT_STARTED'
      OR NEW.outcome <> 'STARTED'
      OR NEW.reason_code <> 'REQUEST_ACCEPTED'
    THEN
      RAISE EXCEPTION 'audit chain must begin unbound with ATTEMPT_STARTED at sequence one';
    END IF;
  ELSE
    IF prior_event.phase = 'TERMINAL' THEN
      RAISE EXCEPTION 'audit chain is terminal and cannot accept another event';
    END IF;
    IF NEW.sequence <> prior_event.sequence + 1
      OR NEW.previous_hash IS DISTINCT FROM prior_event.event_hash
    THEN
      RAISE EXCEPTION 'audit event sequence or previous hash mismatch';
    END IF;
    IF NEW.context_id <> prior_event.context_id
      OR NEW.actor_principal_id <> prior_event.actor_principal_id
      OR NEW.actor_membership_id <> prior_event.actor_membership_id
      OR NEW.command_type <> prior_event.command_type
      OR NEW.target_state IS DISTINCT FROM prior_event.target_state
      OR NEW.capability <> prior_event.capability
      OR NEW.policy_version_id IS DISTINCT FROM prior_event.policy_version_id
      OR NEW.idempotency_key_fingerprint <> prior_event.idempotency_key_fingerprint
      OR NEW.request_fingerprint <> prior_event.request_fingerprint
      OR NEW.fingerprint_key_id <> prior_event.fingerprint_key_id
    THEN
      RAISE EXCEPTION 'audit event identity drift is forbidden';
    END IF;
    IF prior_event.change_set_id IS NOT NULL
      AND NEW.change_set_id IS DISTINCT FROM prior_event.change_set_id
    THEN
      RAISE EXCEPTION 'audit change set identity cannot be cleared or changed';
    END IF;
    IF prior_event.change_set_id IS NULL
      AND NEW.change_set_id IS NOT NULL
      AND NEW.phase <> 'TERMINAL'
    THEN
      RAISE EXCEPTION 'audit change set identity may be bound only by the terminal event';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE SCHEMA fas_audit_v1;
REVOKE ALL ON SCHEMA fas_audit_v1 FROM PUBLIC;

CREATE FUNCTION fas_audit_v1.assert_tenant(p_tenant uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  bound_tenant text;
BEGIN
  bound_tenant := nullif(current_setting('app.tenant_id', true), '');
  IF bound_tenant IS NULL OR bound_tenant <> p_tenant::text THEN
    RAISE EXCEPTION 'change set audit RPC tenant context mismatch' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE FUNCTION fas_audit_v1.load_attempt_tail(
  p_tenant uuid,
  p_attempt uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  audit_row public.change_set_command_audit_events%ROWTYPE;
BEGIN
  PERFORM fas_audit_v1.assert_tenant(p_tenant);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_tenant::text || ':' || p_attempt::text, 0)
  );
  SELECT * INTO audit_row
  FROM public.change_set_command_audit_events audit_event
  WHERE audit_event.tenant_id = p_tenant
    AND audit_event.attempt_id = p_attempt
  ORDER BY audit_event.sequence DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'id', audit_row.id,
    'tenantId', audit_row.tenant_id,
    'attemptId', audit_row.attempt_id,
    'sequence', audit_row.sequence,
    'contextId', audit_row.context_id,
    'actorPrincipalId', audit_row.actor_principal_id,
    'actorMembershipId', audit_row.actor_membership_id,
    'changeSetId', audit_row.change_set_id,
    'commandType', audit_row.command_type,
    'targetState', audit_row.target_state,
    'capability', audit_row.capability,
    'policyVersionId', audit_row.policy_version_id,
    'phase', audit_row.phase,
    'outcome', audit_row.outcome,
    'reasonCode', audit_row.reason_code,
    'idempotencyKeyFingerprint', audit_row.idempotency_key_fingerprint,
    'requestFingerprint', audit_row.request_fingerprint,
    'fingerprintKeyId', audit_row.fingerprint_key_id,
    'previousHash', audit_row.previous_hash,
    'eventHash', audit_row.event_hash
  );
END;
$$;

CREATE FUNCTION fas_audit_v1.append_event(
  p_tenant uuid,
  p_event jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM fas_audit_v1.assert_tenant(p_tenant);
  IF jsonb_typeof(p_event) <> 'object'
    OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_event) key)
      IS DISTINCT FROM ARRAY[
        'actorMembershipId', 'actorPrincipalId', 'attemptId', 'capability',
        'changeSetId', 'commandType', 'contextId', 'eventHash',
        'fingerprintKeyId', 'id', 'idempotencyKeyFingerprint', 'outcome',
        'phase', 'policyVersionId', 'previousHash', 'reasonCode',
        'requestFingerprint', 'sequence', 'targetState', 'tenantId'
      ]::text[]
    OR p_event->>'tenantId' IS DISTINCT FROM p_tenant::text
  THEN
    RAISE EXCEPTION 'invalid change set audit event envelope';
  END IF;

  INSERT INTO public.change_set_command_audit_events (
    id, tenant_id, attempt_id, sequence, context_id, actor_principal_id,
    actor_membership_id, change_set_id, command_type, target_state, capability,
    policy_version_id, phase, outcome, reason_code,
    idempotency_key_fingerprint, request_fingerprint, fingerprint_key_id,
    previous_hash, event_hash
  ) VALUES (
    (p_event->>'id')::uuid,
    p_tenant,
    (p_event->>'attemptId')::uuid,
    (p_event->>'sequence')::integer,
    (p_event->>'contextId')::uuid,
    (p_event->>'actorPrincipalId')::uuid,
    (p_event->>'actorMembershipId')::uuid,
    nullif(p_event->>'changeSetId', '')::uuid,
    p_event->>'commandType',
    nullif(p_event->>'targetState', ''),
    p_event->>'capability',
    nullif(p_event->>'policyVersionId', '')::uuid,
    p_event->>'phase',
    p_event->>'outcome',
    p_event->>'reasonCode',
    p_event->>'idempotencyKeyFingerprint',
    p_event->>'requestFingerprint',
    p_event->>'fingerprintKeyId',
    nullif(p_event->>'previousHash', ''),
    p_event->>'eventHash'
  );
END;
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fas_audit_v1 FROM PUBLIC;
