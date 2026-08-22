-- Default-unwired, EXECUTE-only authoritative active-context resolver.
-- Login roles and grants remain an environment bootstrap responsibility.

CREATE SCHEMA fas_auth_v1;
REVOKE ALL ON SCHEMA fas_auth_v1 FROM PUBLIC;

CREATE FUNCTION fas_auth_v1.resolve_active_context_for_issuance(
  p_tenant uuid,
  p_principal uuid,
  p_organization uuid,
  p_legacy_branch integer,
  p_observed_at bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  tenant_json jsonb;
  principal_json jsonb;
  membership_json jsonb;
  policy_json jsonb;
  assignments_json jsonb := '[]'::jsonb;
  tenant_policy_version bigint;
  membership_ids uuid[];
  assignment_ids uuid[];
  observed_at timestamptz;
BEGIN
  IF current_setting('transaction_isolation') <> 'serializable' THEN
    RAISE EXCEPTION 'active context issuance requires a serializable transaction';
  END IF;
  IF p_tenant IS NULL
    OR p_principal IS NULL
    OR p_observed_at IS NULL
    OR p_observed_at < 0
    OR p_observed_at > 253402300799999
    OR (p_legacy_branch IS NOT NULL AND (p_legacy_branch <= 0 OR p_organization IS NULL))
  THEN
    RAISE EXCEPTION 'active context issuance input is invalid';
  END IF;
  IF NULLIF(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'active context issuance tenant mismatch';
  END IF;
  observed_at := to_timestamp(p_observed_at / 1000.0);

  -- Deterministic authority lock order: tenant -> principal -> membership ->
  -- policy -> assignment -> package/definition/capability.
  SELECT jsonb_build_object(
           'id', tenant.id,
           'status', tenant.status,
           'policyVersion', tenant.policy_version
         ), tenant.policy_version
    INTO tenant_json, tenant_policy_version
  FROM public.tenants tenant
  WHERE tenant.id = p_tenant
  FOR SHARE;

  SELECT jsonb_build_object(
           'id', principal.id,
           'principalType', principal.principal_type,
           'status', principal.status,
           'riskState', principal.risk_state
         )
    INTO principal_json
  FROM public.principals principal
  WHERE principal.id = p_principal
  FOR SHARE;

  SELECT array_agg(membership.id ORDER BY membership.id)
    INTO membership_ids
  FROM public.memberships membership
  WHERE membership.tenant_id = p_tenant
    AND membership.principal_id = p_principal
    AND membership.organization_id IS NOT DISTINCT FROM p_organization
    AND membership.legacy_branch_id IS NOT DISTINCT FROM p_legacy_branch;

  IF coalesce(cardinality(membership_ids), 0) > 0 THEN
    PERFORM 1
    FROM public.memberships membership
    WHERE membership.tenant_id = p_tenant
      AND membership.id = ANY(membership_ids)
    ORDER BY membership.id
    FOR SHARE;
  END IF;

  IF cardinality(membership_ids) = 1 THEN
    SELECT jsonb_build_object(
             'id', membership.id,
             'tenantId', membership.tenant_id,
             'organizationId', membership.organization_id,
             'legacyBranchId', membership.legacy_branch_id,
             'principalId', membership.principal_id,
             'status', membership.status,
             'validFrom', floor(extract(epoch FROM membership.valid_from) * 1000)::bigint,
             'validUntil', CASE WHEN membership.valid_until IS NULL THEN NULL
               ELSE floor(extract(epoch FROM membership.valid_until) * 1000)::bigint END
           )
      INTO membership_json
    FROM public.memberships membership
    WHERE membership.tenant_id = p_tenant
      AND membership.id = membership_ids[1];
  ELSE
    -- The global principal catalog is never projected without one exact
    -- tenant-local membership, even to the dedicated resolver credential.
    principal_json := NULL;
  END IF;

  IF tenant_json IS NULL THEN
    principal_json := NULL;
    membership_json := NULL;
  END IF;

  IF tenant_policy_version IS NOT NULL THEN
    SELECT jsonb_build_object(
             'id', policy.id,
             'tenantId', policy.tenant_id,
             'version', policy.version_number,
             'state', policy.state,
             'effectiveAt', CASE WHEN policy.effective_at IS NULL THEN NULL
               ELSE floor(extract(epoch FROM policy.effective_at) * 1000)::bigint END,
             'revokedAt', CASE WHEN policy.revoked_at IS NULL THEN NULL
               ELSE floor(extract(epoch FROM policy.revoked_at) * 1000)::bigint END
           )
      INTO policy_json
    FROM public.policy_versions policy
    WHERE policy.tenant_id = p_tenant
      AND policy.version_number = tenant_policy_version
    FOR SHARE;
  END IF;

  IF cardinality(membership_ids) = 1 THEN
    SELECT array_agg(assignment.id ORDER BY assignment.id)
      INTO assignment_ids
    FROM public.access_assignments assignment
    JOIN public.role_package_versions package
      ON package.id = assignment.role_package_version_id
    JOIN public.role_definitions definition
      ON definition.id = package.role_definition_id
    WHERE assignment.tenant_id = p_tenant
      AND assignment.membership_id = membership_ids[1]
      AND assignment.status = 'ACTIVE'
      AND assignment.valid_from <= observed_at
      AND (assignment.valid_until IS NULL OR assignment.valid_until > observed_at)
      AND (
        assignment.scope_type = 'TENANT'
        OR (
          assignment.scope_type = 'ORGANIZATION'
          AND assignment.organization_id IS NOT DISTINCT FROM p_organization
        )
        OR (
          assignment.scope_type = 'LEGACY_BRANCH'
          AND assignment.organization_id IS NOT DISTINCT FROM p_organization
          AND assignment.legacy_branch_id IS NOT DISTINCT FROM p_legacy_branch
        )
      )
      AND package.status = 'ACTIVE'
      AND package.effective_at IS NOT NULL
      AND package.effective_at <= observed_at
      AND (package.deprecated_at IS NULL OR package.deprecated_at > observed_at)
      AND definition.status = 'ACTIVE'
      AND definition.principal_type = 'HUMAN'
      AND EXISTS (
        SELECT 1
        FROM public.role_package_capabilities package_capability
        JOIN public.capability_definitions capability
          ON capability.key = package_capability.capability_key
        WHERE package_capability.role_package_version_id = package.id
          AND capability.status = 'ACTIVE'
      );
  END IF;

  IF coalesce(cardinality(assignment_ids), 0) > 32 THEN
    RAISE EXCEPTION 'active context assignment set exceeds the issuance bound';
  END IF;

  IF coalesce(cardinality(assignment_ids), 0) > 0 THEN
    PERFORM 1
    FROM public.access_assignments assignment
    WHERE assignment.tenant_id = p_tenant
      AND assignment.id = ANY(assignment_ids)
    ORDER BY assignment.id
    FOR SHARE;

    PERFORM 1
    FROM public.role_package_versions package
    WHERE package.id IN (
      SELECT assignment.role_package_version_id
      FROM public.access_assignments assignment
      WHERE assignment.tenant_id = p_tenant
        AND assignment.id = ANY(assignment_ids)
    )
    ORDER BY package.id
    FOR SHARE;

    PERFORM 1
    FROM public.role_definitions definition
    WHERE definition.id IN (
      SELECT package.role_definition_id
      FROM public.role_package_versions package
      WHERE package.id IN (
        SELECT assignment.role_package_version_id
        FROM public.access_assignments assignment
        WHERE assignment.tenant_id = p_tenant
          AND assignment.id = ANY(assignment_ids)
      )
    )
    ORDER BY definition.id
    FOR SHARE;

    PERFORM 1
    FROM public.role_package_capabilities package_capability
    JOIN public.capability_definitions capability
      ON capability.key = package_capability.capability_key
    WHERE package_capability.role_package_version_id IN (
      SELECT assignment.role_package_version_id
      FROM public.access_assignments assignment
      WHERE assignment.tenant_id = p_tenant
        AND assignment.id = ANY(assignment_ids)
    )
    ORDER BY package_capability.role_package_version_id, package_capability.capability_key
    FOR SHARE OF package_capability, capability;

    SELECT jsonb_agg(
             jsonb_build_object(
               'id', assignment.id,
               'tenantId', assignment.tenant_id,
               'membershipId', assignment.membership_id,
               'status', assignment.status,
               'validFrom', floor(extract(epoch FROM assignment.valid_from) * 1000)::bigint,
               'validUntil', CASE WHEN assignment.valid_until IS NULL THEN NULL
                 ELSE floor(extract(epoch FROM assignment.valid_until) * 1000)::bigint END
             )
             ORDER BY assignment.id
           )
      INTO assignments_json
    FROM public.access_assignments assignment
    WHERE assignment.tenant_id = p_tenant
      AND assignment.id = ANY(assignment_ids);
  END IF;

  RETURN jsonb_build_object(
    'tenant', tenant_json,
    'principal', principal_json,
    'membership', membership_json,
    'policy', policy_json,
    'assignments', coalesce(assignments_json, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fas_auth_v1 FROM PUBLIC;

COMMENT ON SCHEMA fas_auth_v1 IS
  'Default-unwired EXECUTE-only active-context issuance facade; role bootstrap is external.';
COMMENT ON FUNCTION fas_auth_v1.resolve_active_context_for_issuance(uuid, uuid, uuid, integer, bigint) IS
  'Locks and projects server-authoritative active-context state in a tenant-local serializable transaction.';
