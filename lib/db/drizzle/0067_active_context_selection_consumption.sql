-- Additive, default-unwired selection-bound consumption lock.
-- The function deliberately returns only the authoritative selection row;
-- callers must keep the surrounding SERIALIZABLE transaction open while
-- performing the privileged operation.

CREATE FUNCTION fas_session_v1.lock_selection_for_consumption(
  p_tenant uuid,
  p_selection uuid,
  p_observed_at bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  selection_row public.active_session_context_selections%ROWTYPE;
  observed_at timestamp with time zone;
BEGIN
  IF current_setting('transaction_isolation') <> 'serializable' THEN
    RAISE EXCEPTION 'active context selection consumption requires a serializable transaction';
  END IF;
  IF NULLIF(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'active context selection consumption tenant mismatch';
  END IF;
  IF p_tenant IS NULL
    OR p_selection IS NULL
    OR substring(p_selection::text from 15 for 1) <> '7'
    OR p_observed_at IS NULL
    OR p_observed_at < 0
    OR p_observed_at > 253402300799999
  THEN
    RAISE EXCEPTION 'active context selection consumption input is invalid';
  END IF;

  observed_at := to_timestamp(p_observed_at / 1000.0);
  IF observed_at < statement_timestamp() - interval '30 seconds'
    OR observed_at > statement_timestamp() + interval '5 seconds'
  THEN
    RAISE EXCEPTION 'active context selection consumption observation is stale';
  END IF;

  SELECT * INTO selection_row
  FROM public.active_session_context_selections selection
  WHERE selection.tenant_id = p_tenant
    AND selection.id = p_selection
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'selectionId', selection_row.id,
    'tenantId', selection_row.tenant_id,
    'sessionGeneration', selection_row.session_generation,
    'principalId', selection_row.principal_id,
    'membershipId', selection_row.membership_id,
    'organizationId', selection_row.organization_id,
    'legacyBranchId', selection_row.legacy_branch_id,
    'status', selection_row.status
  );
END;
$$;

REVOKE ALL ON FUNCTION
  fas_session_v1.lock_selection_for_consumption(uuid, uuid, bigint)
FROM PUBLIC;

COMMENT ON FUNCTION fas_session_v1.lock_selection_for_consumption(uuid, uuid, bigint) IS
  'Default-unwired SERIALIZABLE row-lock facade for selection-bound privileged consumption.';
