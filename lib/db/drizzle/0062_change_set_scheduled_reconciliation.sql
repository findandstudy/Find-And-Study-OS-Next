CREATE TABLE public.change_set_reconciliation_jobs (
  id uuid PRIMARY KEY NOT NULL,
  tenant_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  context_id uuid NOT NULL,
  actor_principal_id uuid NOT NULL,
  actor_membership_id uuid NOT NULL,
  policy_version_id uuid NOT NULL,
  command_type text NOT NULL,
  target_state text,
  capability text NOT NULL,
  idempotency_key_hash text NOT NULL,
  request_hash text NOT NULL,
  status text DEFAULT 'PENDING' NOT NULL,
  attempt_count integer DEFAULT 0 NOT NULL,
  max_attempts integer DEFAULT 6 NOT NULL,
  available_at timestamp with time zone DEFAULT (statement_timestamp() + interval '1 minute') NOT NULL,
  lease_token_hash text,
  leased_at timestamp with time zone,
  lease_expires_at timestamp with time zone,
  resolution text,
  resolved_change_set_id uuid,
  last_error_code text,
  created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
  updated_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
  resolved_at timestamp with time zone,
  CONSTRAINT change_set_reconciliation_jobs_tenant_attempt_uq
    UNIQUE (tenant_id, attempt_id),
  CONSTRAINT change_set_reconciliation_jobs_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT change_set_reconciliation_jobs_actor_membership_fk
    FOREIGN KEY (tenant_id, actor_membership_id, actor_principal_id)
    REFERENCES public.memberships(tenant_id, id, principal_id) ON DELETE RESTRICT,
  CONSTRAINT change_set_reconciliation_jobs_policy_version_fk
    FOREIGN KEY (tenant_id, policy_version_id)
    REFERENCES public.policy_versions(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT change_set_reconciliation_jobs_resolved_change_set_fk
    FOREIGN KEY (tenant_id, resolved_change_set_id)
    REFERENCES public.change_sets(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT change_set_reconciliation_jobs_id_uuidv7_chk
    CHECK (substring(id::text from 15 for 1) = '7'),
  CONSTRAINT change_set_reconciliation_jobs_attempt_uuidv7_chk
    CHECK (substring(attempt_id::text from 15 for 1) = '7'),
  CONSTRAINT change_set_reconciliation_jobs_context_uuidv7_chk
    CHECK (substring(context_id::text from 15 for 1) = '7'),
  CONSTRAINT change_set_reconciliation_jobs_command_chk
    CHECK (
      (command_type = 'CREATE' AND target_state IS NULL)
      OR (
        command_type = 'TRANSITION'
        AND target_state IS NOT NULL
        AND target_state IN ('VALIDATED', 'SIMULATED', 'IN_REVIEW')
      )
    ),
  CONSTRAINT change_set_reconciliation_jobs_capability_chk
    CHECK (capability ~ '^[a-z][a-z0-9._:-]{2,95}$'),
  CONSTRAINT change_set_reconciliation_jobs_hashes_chk
    CHECK (
      idempotency_key_hash ~ '^[0-9a-f]{64}$'
      AND request_hash ~ '^[0-9a-f]{64}$'
      AND (lease_token_hash IS NULL OR lease_token_hash ~ '^[0-9a-f]{64}$')
    ),
  CONSTRAINT change_set_reconciliation_jobs_status_chk
    CHECK (status IN ('PENDING', 'LEASED', 'RESOLVED', 'ESCALATED')),
  CONSTRAINT change_set_reconciliation_jobs_attempts_chk
    CHECK (max_attempts BETWEEN 1 AND 12 AND attempt_count BETWEEN 0 AND max_attempts),
  CONSTRAINT change_set_reconciliation_jobs_lease_chk
    CHECK (
      (status = 'LEASED') =
      (lease_token_hash IS NOT NULL AND leased_at IS NOT NULL AND lease_expires_at IS NOT NULL)
      AND (lease_expires_at IS NULL OR lease_expires_at > leased_at)
    ),
  CONSTRAINT change_set_reconciliation_jobs_resolution_chk
    CHECK (
      (
        status IN ('PENDING', 'LEASED')
        AND resolution IS NULL
        AND resolved_change_set_id IS NULL
        AND resolved_at IS NULL
      )
      OR (
        status = 'RESOLVED'
        AND resolution = 'COMMITTED'
        AND resolved_change_set_id IS NOT NULL
        AND resolved_at IS NOT NULL
      )
      OR (
        status = 'ESCALATED'
        AND resolution IN ('NO_COMMAND', 'INCOMPLETE_COMMAND', 'INVALID_COMMAND')
        AND resolved_change_set_id IS NULL
        AND resolved_at IS NOT NULL
      )
    ),
  CONSTRAINT change_set_reconciliation_jobs_error_chk
    CHECK (
      last_error_code IS NULL
      OR last_error_code IN (
        'COMMAND_NOT_FOUND', 'COMMAND_IN_PROGRESS', 'COMMAND_INVALID',
        'AUDIT_FINALIZATION_FAILED'
      )
    )
);

CREATE INDEX change_set_reconciliation_jobs_due_idx
  ON public.change_set_reconciliation_jobs (tenant_id, status, available_at, created_at);

ALTER TABLE public.change_set_reconciliation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.change_set_reconciliation_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY change_set_reconciliation_jobs_select_same_tenant
  ON public.change_set_reconciliation_jobs FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY change_set_reconciliation_jobs_insert_same_tenant
  ON public.change_set_reconciliation_jobs FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY change_set_reconciliation_jobs_update_same_tenant
  ON public.change_set_reconciliation_jobs FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE FUNCTION fas_audit_v1.schedule_reconciliation_job(
  p_tenant uuid,
  p_job jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  audit_row public.change_set_command_audit_events%ROWTYPE;
  job_row public.change_set_reconciliation_jobs%ROWTYPE;
BEGIN
  PERFORM fas_audit_v1.assert_tenant(p_tenant);
  IF jsonb_typeof(p_job) <> 'object'
    OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_job) key)
      IS DISTINCT FROM ARRAY[
        'actorMembershipId', 'actorPrincipalId', 'attemptId', 'capability',
        'commandType', 'contextId', 'idempotencyKeyHash', 'jobId',
        'policyVersionId', 'requestHash', 'targetState', 'tenantId'
      ]::text[]
    OR p_job->>'tenantId' IS DISTINCT FROM p_tenant::text
    OR p_job->>'idempotencyKeyHash' !~ '^[0-9a-f]{64}$'
    OR p_job->>'requestHash' !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'invalid change set reconciliation job envelope';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_tenant::text || ':' || (p_job->>'attemptId'), 0)
  );
  SELECT * INTO audit_row
  FROM public.change_set_command_audit_events event
  WHERE event.tenant_id = p_tenant
    AND event.attempt_id = (p_job->>'attemptId')::uuid
  ORDER BY event.sequence DESC
  LIMIT 1;

  IF NOT FOUND
    OR audit_row.phase <> 'RECONCILIATION'
    OR audit_row.outcome <> 'PENDING'
    OR audit_row.reason_code <> 'COMMIT_OUTCOME_UNKNOWN'
    OR audit_row.context_id <> (p_job->>'contextId')::uuid
    OR audit_row.actor_principal_id <> (p_job->>'actorPrincipalId')::uuid
    OR audit_row.actor_membership_id <> (p_job->>'actorMembershipId')::uuid
    OR audit_row.policy_version_id <> (p_job->>'policyVersionId')::uuid
    OR audit_row.command_type <> p_job->>'commandType'
    OR audit_row.target_state IS DISTINCT FROM nullif(p_job->>'targetState', '')
    OR audit_row.capability <> p_job->>'capability'
  THEN
    RAISE EXCEPTION 'reconciliation job does not match a pending audit attempt';
  END IF;

  INSERT INTO public.change_set_reconciliation_jobs (
    id, tenant_id, attempt_id, context_id, actor_principal_id,
    actor_membership_id, policy_version_id, command_type, target_state,
    capability, idempotency_key_hash, request_hash
  ) VALUES (
    (p_job->>'jobId')::uuid,
    p_tenant,
    (p_job->>'attemptId')::uuid,
    (p_job->>'contextId')::uuid,
    (p_job->>'actorPrincipalId')::uuid,
    (p_job->>'actorMembershipId')::uuid,
    (p_job->>'policyVersionId')::uuid,
    p_job->>'commandType',
    nullif(p_job->>'targetState', ''),
    p_job->>'capability',
    p_job->>'idempotencyKeyHash',
    p_job->>'requestHash'
  ) ON CONFLICT (tenant_id, attempt_id) DO NOTHING;

  SELECT * INTO job_row
  FROM public.change_set_reconciliation_jobs job
  WHERE job.tenant_id = p_tenant
    AND job.attempt_id = (p_job->>'attemptId')::uuid;
  IF NOT FOUND
    OR job_row.context_id <> (p_job->>'contextId')::uuid
    OR job_row.actor_principal_id <> (p_job->>'actorPrincipalId')::uuid
    OR job_row.actor_membership_id <> (p_job->>'actorMembershipId')::uuid
    OR job_row.policy_version_id <> (p_job->>'policyVersionId')::uuid
    OR job_row.command_type <> p_job->>'commandType'
    OR job_row.target_state IS DISTINCT FROM nullif(p_job->>'targetState', '')
    OR job_row.capability <> p_job->>'capability'
    OR job_row.idempotency_key_hash <> p_job->>'idempotencyKeyHash'
    OR job_row.request_hash <> p_job->>'requestHash'
  THEN
    RAISE EXCEPTION 'reconciliation job identity conflict';
  END IF;
END;
$$;

CREATE SCHEMA fas_repair_v1;
REVOKE ALL ON SCHEMA fas_repair_v1 FROM PUBLIC;

CREATE FUNCTION fas_repair_v1.assert_tenant(p_tenant uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  bound_tenant text;
BEGIN
  bound_tenant := nullif(current_setting('app.tenant_id', true), '');
  IF bound_tenant IS NULL OR bound_tenant <> p_tenant::text THEN
    RAISE EXCEPTION 'change set repair RPC tenant context mismatch' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE FUNCTION fas_repair_v1.claim_due_job(
  p_tenant uuid,
  p_lease_token_hash text,
  p_lease_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  job_row public.change_set_reconciliation_jobs%ROWTYPE;
BEGIN
  PERFORM fas_repair_v1.assert_tenant(p_tenant);
  IF p_lease_token_hash IS NULL
    OR p_lease_token_hash !~ '^[0-9a-f]{64}$'
    OR p_lease_seconds NOT BETWEEN 30 AND 300
  THEN
    RAISE EXCEPTION 'invalid reconciliation lease request';
  END IF;

  SELECT * INTO job_row
  FROM public.change_set_reconciliation_jobs job
  WHERE job.tenant_id = p_tenant
    AND job.available_at <= statement_timestamp()
    AND (
      (job.status = 'PENDING' AND job.attempt_count < job.max_attempts)
      OR (job.status = 'LEASED' AND job.lease_expires_at <= statement_timestamp())
    )
  ORDER BY job.available_at, job.created_at, job.id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE public.change_set_reconciliation_jobs
  SET status = 'LEASED',
      attempt_count = CASE
        WHEN job_row.status = 'LEASED' THEN attempt_count
        ELSE attempt_count + 1
      END,
      lease_token_hash = p_lease_token_hash,
      leased_at = statement_timestamp(),
      lease_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds),
      updated_at = statement_timestamp()
  WHERE tenant_id = p_tenant AND id = job_row.id
  RETURNING * INTO job_row;

  RETURN jsonb_build_object(
    'id', job_row.id,
    'tenantId', job_row.tenant_id,
    'attemptId', job_row.attempt_id,
    'contextId', job_row.context_id,
    'actorPrincipalId', job_row.actor_principal_id,
    'actorMembershipId', job_row.actor_membership_id,
    'policyVersionId', job_row.policy_version_id,
    'commandType', job_row.command_type,
    'targetState', job_row.target_state,
    'capability', job_row.capability,
    'idempotencyKeyHash', job_row.idempotency_key_hash,
    'requestHash', job_row.request_hash,
    'attemptCount', job_row.attempt_count,
    'maxAttempts', job_row.max_attempts
  );
END;
$$;

CREATE FUNCTION fas_repair_v1.load_command_outcome(
  p_tenant uuid,
  p_job uuid,
  p_lease_token_hash text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  job_row public.change_set_reconciliation_jobs%ROWTYPE;
  command_row public.change_set_command_receipts%ROWTYPE;
BEGIN
  PERFORM fas_repair_v1.assert_tenant(p_tenant);
  SELECT * INTO job_row
  FROM public.change_set_reconciliation_jobs job
  WHERE job.tenant_id = p_tenant AND job.id = p_job
  FOR UPDATE;
  IF NOT FOUND
    OR job_row.status <> 'LEASED'
    OR job_row.lease_token_hash <> p_lease_token_hash
    OR job_row.lease_expires_at <= statement_timestamp()
  THEN
    RAISE EXCEPTION 'reconciliation lease is not active';
  END IF;

  SELECT * INTO command_row
  FROM public.change_set_command_receipts command
  WHERE command.tenant_id = p_tenant
    AND command.idempotency_key_hash = job_row.idempotency_key_hash;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'NOT_FOUND');
  END IF;
  IF command_row.request_hash <> job_row.request_hash
    OR command_row.context_id <> job_row.context_id
    OR command_row.actor_principal_id <> job_row.actor_principal_id
    OR command_row.actor_membership_id <> job_row.actor_membership_id
    OR command_row.command_type <> job_row.command_type
    OR command_row.target_state IS DISTINCT FROM job_row.target_state
  THEN
    RETURN jsonb_build_object('state', 'INVALID');
  END IF;
  IF command_row.status = 'CLAIMED' THEN
    RETURN jsonb_build_object('state', 'CLAIMED');
  END IF;
  IF command_row.status <> 'COMPLETED'
    OR command_row.result IS NULL
    OR command_row.result_hash IS NULL
    OR command_row.change_set_id IS NULL
  THEN
    RETURN jsonb_build_object('state', 'INVALID');
  END IF;
  RETURN jsonb_build_object(
    'state', 'COMPLETED',
    'changeSetId', command_row.change_set_id,
    'result', command_row.result,
    'resultHash', command_row.result_hash
  );
END;
$$;

CREATE FUNCTION fas_repair_v1.reschedule_job(
  p_tenant uuid,
  p_job uuid,
  p_lease_token_hash text,
  p_delay_seconds integer,
  p_error_code text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM fas_repair_v1.assert_tenant(p_tenant);
  IF p_delay_seconds IS NULL
    OR p_delay_seconds NOT BETWEEN 1 AND 3600
    OR p_error_code IS NULL
    OR p_error_code NOT IN ('COMMAND_NOT_FOUND', 'COMMAND_IN_PROGRESS')
  THEN
    RAISE EXCEPTION 'invalid reconciliation retry request';
  END IF;
  UPDATE public.change_set_reconciliation_jobs job
  SET status = 'PENDING',
      available_at = statement_timestamp() + make_interval(secs => p_delay_seconds),
      lease_token_hash = NULL,
      leased_at = NULL,
      lease_expires_at = NULL,
      last_error_code = p_error_code,
      updated_at = statement_timestamp()
  WHERE job.tenant_id = p_tenant
    AND job.id = p_job
    AND job.status = 'LEASED'
    AND job.lease_token_hash = p_lease_token_hash
    AND job.lease_expires_at > statement_timestamp()
    AND job.attempt_count < job.max_attempts;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reconciliation retry lease is not active';
  END IF;
END;
$$;

CREATE FUNCTION fas_repair_v1.complete_job(
  p_tenant uuid,
  p_job uuid,
  p_lease_token_hash text,
  p_status text,
  p_resolution text,
  p_change_set uuid,
  p_error_code text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM fas_repair_v1.assert_tenant(p_tenant);
  IF ((
    (p_status = 'RESOLVED' AND p_resolution = 'COMMITTED'
      AND p_change_set IS NOT NULL AND p_error_code IS NULL)
    OR (p_status = 'ESCALATED'
      AND p_resolution IN ('NO_COMMAND', 'INCOMPLETE_COMMAND', 'INVALID_COMMAND')
      AND p_change_set IS NULL
      AND p_error_code IN ('COMMAND_NOT_FOUND', 'COMMAND_IN_PROGRESS', 'COMMAND_INVALID', 'AUDIT_FINALIZATION_FAILED'))
  )) IS NOT TRUE THEN
    RAISE EXCEPTION 'invalid reconciliation completion';
  END IF;
  UPDATE public.change_set_reconciliation_jobs job
  SET status = p_status,
      resolution = p_resolution,
      resolved_change_set_id = p_change_set,
      last_error_code = p_error_code,
      lease_token_hash = NULL,
      leased_at = NULL,
      lease_expires_at = NULL,
      resolved_at = statement_timestamp(),
      updated_at = statement_timestamp()
  WHERE job.tenant_id = p_tenant
    AND job.id = p_job
    AND job.status = 'LEASED'
    AND job.lease_token_hash = p_lease_token_hash
    AND job.lease_expires_at > statement_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reconciliation completion lease is not active';
  END IF;
END;
$$;

REVOKE ALL ON TABLE public.change_set_reconciliation_jobs FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fas_repair_v1 FROM PUBLIC;
REVOKE ALL ON FUNCTION fas_audit_v1.schedule_reconciliation_job(uuid, jsonb) FROM PUBLIC;
