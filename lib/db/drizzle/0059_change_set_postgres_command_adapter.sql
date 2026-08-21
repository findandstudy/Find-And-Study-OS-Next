CREATE TABLE public.r1_configuration_snapshots (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  change_type text NOT NULL,
  configuration_key text NOT NULL,
  target_scope_type text NOT NULL,
  target_organization_id uuid,
  target_legacy_branch_id integer,
  version bigint NOT NULL,
  config jsonb NOT NULL,
  config_hash text NOT NULL,
  source_change_set_id uuid,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT r1_configuration_snapshots_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT r1_configuration_snapshots_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT r1_configuration_snapshots_tenant_organization_fk
    FOREIGN KEY (tenant_id, target_organization_id)
    REFERENCES public.organizations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT r1_configuration_snapshots_tenant_organization_branch_fk
    FOREIGN KEY (tenant_id, target_organization_id, target_legacy_branch_id)
    REFERENCES public.tenant_organization_legacy_branches(
      tenant_id, organization_id, legacy_branch_id
    ) ON DELETE RESTRICT,
  CONSTRAINT r1_configuration_snapshots_source_change_set_fk
    FOREIGN KEY (tenant_id, source_change_set_id)
    REFERENCES public.change_sets(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT r1_configuration_snapshots_id_uuidv7_chk
    CHECK (substring(id::text from 15 for 1) = '7'),
  CONSTRAINT r1_configuration_snapshots_type_chk
    CHECK (change_type IN (
      'BRAND', 'LOCALE', 'NOTIFICATION_TEMPLATE', 'FEATURE_FLAG', 'MAINTENANCE_BANNER'
    )),
  CONSTRAINT r1_configuration_snapshots_key_chk
    CHECK (configuration_key ~ '^[a-z][a-z0-9_.:-]{0,127}$'),
  CONSTRAINT r1_configuration_snapshots_scope_chk CHECK (
    (target_scope_type = 'TENANT'
      AND target_organization_id IS NULL AND target_legacy_branch_id IS NULL)
    OR (target_scope_type = 'ORGANIZATION'
      AND target_organization_id IS NOT NULL AND target_legacy_branch_id IS NULL)
    OR (target_scope_type = 'LEGACY_BRANCH'
      AND target_organization_id IS NOT NULL AND target_legacy_branch_id IS NOT NULL)
  ),
  CONSTRAINT r1_configuration_snapshots_version_chk CHECK (version >= 0),
  CONSTRAINT r1_configuration_snapshots_config_chk CHECK (jsonb_typeof(config) = 'object'),
  CONSTRAINT r1_configuration_snapshots_hash_chk CHECK (config_hash ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX r1_configuration_snapshots_target_uidx
  ON public.r1_configuration_snapshots (
    tenant_id,
    change_type,
    configuration_key,
    target_scope_type,
    coalesce(target_organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(target_legacy_branch_id, -1)
  );

ALTER TABLE public.r1_configuration_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.r1_configuration_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY r1_configuration_snapshots_select_same_tenant
  ON public.r1_configuration_snapshots FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY r1_configuration_snapshots_insert_same_tenant
  ON public.r1_configuration_snapshots FOR INSERT
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY r1_configuration_snapshots_update_same_tenant
  ON public.r1_configuration_snapshots FOR UPDATE
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE SCHEMA fas_cp_v1;
REVOKE ALL ON SCHEMA fas_cp_v1 FROM PUBLIC;

CREATE FUNCTION fas_cp_v1.assert_tenant(p_tenant uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  bound_tenant text;
BEGIN
  bound_tenant := nullif(current_setting('app.tenant_id', true), '');
  IF bound_tenant IS NULL OR bound_tenant <> p_tenant::text THEN
    RAISE EXCEPTION 'change set RPC tenant context mismatch' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE FUNCTION fas_cp_v1.load_authoritative_configuration(
  p_tenant uuid,
  p_change_type text,
  p_configuration_key text,
  p_scope jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  snapshot_row public.r1_configuration_snapshots%ROWTYPE;
  active_proposal uuid;
BEGIN
  PERFORM fas_cp_v1.assert_tenant(p_tenant);
  IF jsonb_typeof(p_scope) <> 'object'
    OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_scope) key)
      IS DISTINCT FROM ARRAY['legacyBranchId', 'organizationId', 'scopeType']::text[]
  THEN
    RAISE EXCEPTION 'invalid configuration scope';
  END IF;

  SELECT * INTO snapshot_row
  FROM public.r1_configuration_snapshots snapshot
  WHERE snapshot.tenant_id = p_tenant
    AND snapshot.change_type = p_change_type
    AND snapshot.configuration_key = p_configuration_key
    AND snapshot.target_scope_type = p_scope->>'scopeType'
    AND snapshot.target_organization_id IS NOT DISTINCT FROM
      nullif(p_scope->>'organizationId', '')::uuid
    AND snapshot.target_legacy_branch_id IS NOT DISTINCT FROM
      nullif(p_scope->>'legacyBranchId', '')::integer
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT change_set.id INTO active_proposal
  FROM public.change_sets change_set
  WHERE change_set.tenant_id = p_tenant
    AND change_set.change_type = p_change_type
    AND change_set.configuration_key = p_configuration_key
    AND change_set.target_scope_type = p_scope->>'scopeType'
    AND change_set.target_organization_id IS NOT DISTINCT FROM
      nullif(p_scope->>'organizationId', '')::uuid
    AND change_set.target_legacy_branch_id IS NOT DISTINCT FROM
      nullif(p_scope->>'legacyBranchId', '')::integer
    AND change_set.status IN (
      'DRAFT', 'VALIDATED', 'SIMULATED', 'IN_REVIEW', 'APPROVED', 'SCHEDULED',
      'CANARY', 'PUBLISHED', 'OBSERVING', 'RETURNED'
    )
  ORDER BY change_set.created_at
  LIMIT 1
  FOR UPDATE;

  RETURN jsonb_build_object(
    'configurationKey', snapshot_row.configuration_key,
    'version', snapshot_row.version,
    'config', snapshot_row.config,
    'activeProposalId', active_proposal
  );
END;
$$;

CREATE FUNCTION fas_cp_v1.resolve_active_context(
  p_tenant uuid,
  p_principal uuid,
  p_membership uuid,
  p_policy uuid,
  p_assignment_ids uuid[]
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
  assignments_json jsonb;
BEGIN
  PERFORM fas_cp_v1.assert_tenant(p_tenant);
  IF p_assignment_ids IS NULL
    OR cardinality(p_assignment_ids) NOT BETWEEN 1 AND 32
    OR (SELECT count(DISTINCT assignment_id) FROM unnest(p_assignment_ids) assignment_id)
      <> cardinality(p_assignment_ids)
  THEN
    RAISE EXCEPTION 'invalid assignment set';
  END IF;

  SELECT jsonb_build_object(
    'id', tenant.id, 'status', tenant.status, 'policyVersion', tenant.policy_version
  ) INTO tenant_json
  FROM public.tenants tenant
  WHERE tenant.id = p_tenant
  FOR SHARE;

  SELECT jsonb_build_object(
    'id', principal.id,
    'principalType', principal.principal_type,
    'status', principal.status,
    'riskState', principal.risk_state
  ) INTO principal_json
  FROM public.principals principal
  JOIN public.memberships principal_membership
    ON principal_membership.principal_id = principal.id
   AND principal_membership.tenant_id = p_tenant
   AND principal_membership.id = p_membership
  WHERE principal.id = p_principal
  FOR SHARE OF principal, principal_membership;

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
  ) INTO membership_json
  FROM public.memberships membership
  WHERE membership.tenant_id = p_tenant
    AND membership.id = p_membership
    AND membership.principal_id = p_principal
  FOR SHARE;

  SELECT jsonb_build_object(
    'id', policy.id,
    'tenantId', policy.tenant_id,
    'version', policy.version_number,
    'state', policy.state,
    'effectiveAt', CASE WHEN policy.effective_at IS NULL THEN NULL
      ELSE floor(extract(epoch FROM policy.effective_at) * 1000)::bigint END,
    'revokedAt', CASE WHEN policy.revoked_at IS NULL THEN NULL
      ELSE floor(extract(epoch FROM policy.revoked_at) * 1000)::bigint END
  ) INTO policy_json
  FROM public.policy_versions policy
  WHERE policy.tenant_id = p_tenant AND policy.id = p_policy
  FOR SHARE;

  PERFORM 1
  FROM public.access_assignments assignment
  JOIN public.role_package_versions package
    ON package.id = assignment.role_package_version_id
  JOIN public.role_definitions definition
    ON definition.id = package.role_definition_id
  WHERE assignment.tenant_id = p_tenant
    AND assignment.membership_id = p_membership
    AND assignment.id = ANY(p_assignment_ids)
  FOR SHARE OF assignment, package, definition;

  PERFORM 1
  FROM public.role_package_capabilities package_capability
  JOIN public.capability_definitions capability
    ON capability.key = package_capability.capability_key
  WHERE package_capability.role_package_version_id IN (
    SELECT assignment.role_package_version_id
    FROM public.access_assignments assignment
    WHERE assignment.tenant_id = p_tenant
      AND assignment.membership_id = p_membership
      AND assignment.id = ANY(p_assignment_ids)
  )
  FOR SHARE OF package_capability, capability;

  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', assignment.id,
      'tenantId', assignment.tenant_id,
      'membershipId', assignment.membership_id,
      'status', assignment.status,
      'validFrom', floor(extract(epoch FROM assignment.valid_from) * 1000)::bigint,
      'validUntil', CASE WHEN assignment.valid_until IS NULL THEN NULL
        ELSE floor(extract(epoch FROM assignment.valid_until) * 1000)::bigint END,
      'scopeType', assignment.scope_type,
      'organizationId', assignment.organization_id,
      'legacyBranchId', assignment.legacy_branch_id,
      'constraintDocument', assignment.constraint_document,
      'rolePackageVersionId', package.id,
      'rolePackageStatus', package.status,
      'rolePackagePrincipalType', definition.principal_type,
      'rolePackageEffectiveAt', CASE WHEN package.effective_at IS NULL THEN NULL
        ELSE floor(extract(epoch FROM package.effective_at) * 1000)::bigint END,
      'rolePackageDeprecatedAt', CASE WHEN package.deprecated_at IS NULL THEN NULL
        ELSE floor(extract(epoch FROM package.deprecated_at) * 1000)::bigint END,
      'capabilities', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'key', capability.key,
          'effect', package_capability.effect,
          'status', capability.status,
          'stepUpRequired', capability.step_up_required,
          'approvalRequired', capability.approval_required
        ) ORDER BY capability.key)
        FROM public.role_package_capabilities package_capability
        JOIN public.capability_definitions capability
          ON capability.key = package_capability.capability_key
        WHERE package_capability.role_package_version_id = package.id
      ), '[]'::jsonb)
    ) ORDER BY assignment.id
  ), '[]'::jsonb) INTO assignments_json
  FROM public.access_assignments assignment
  JOIN public.role_package_versions package
    ON package.id = assignment.role_package_version_id
  JOIN public.role_definitions definition
    ON definition.id = package.role_definition_id
  WHERE assignment.tenant_id = p_tenant
    AND assignment.membership_id = p_membership
    AND assignment.id = ANY(p_assignment_ids);

  RETURN jsonb_build_object(
    'tenant', tenant_json,
    'principal', principal_json,
    'membership', membership_json,
    'policy', policy_json,
    'assignments', assignments_json
  );
END;
$$;

CREATE FUNCTION fas_cp_v1.claim_command(p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  command_row public.change_set_command_receipts%ROWTYPE;
  inserted_count integer := 0;
  tenant uuid := (p_input->>'tenantId')::uuid;
BEGIN
  PERFORM fas_cp_v1.assert_tenant(tenant);
  IF jsonb_typeof(p_input) <> 'object' THEN RAISE EXCEPTION 'invalid command claim'; END IF;

  INSERT INTO public.change_set_command_receipts (
    id, tenant_id, idempotency_key_hash, request_hash, context_id,
    actor_principal_id, actor_membership_id, command_type, target_state,
    change_set_id, claimed_at
  ) VALUES (
    (p_input->>'id')::uuid, tenant, p_input->>'idempotencyKeyHash',
    p_input->>'requestHash', (p_input->>'contextId')::uuid,
    (p_input->>'actorPrincipalId')::uuid,
    (p_input->>'actorMembershipId')::uuid,
    p_input->>'commandType', p_input->>'targetState',
    nullif(p_input->>'changeSetId', '')::uuid,
    to_timestamp((p_input->>'claimedAt')::double precision / 1000.0)
  ) ON CONFLICT (tenant_id, idempotency_key_hash) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;

  SELECT * INTO command_row
  FROM public.change_set_command_receipts command
  WHERE command.tenant_id = tenant
    AND command.idempotency_key_hash = p_input->>'idempotencyKeyHash'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'command claim unavailable'; END IF;
  IF inserted_count = 1 THEN RETURN jsonb_build_object('kind', 'CLAIMED'); END IF;
  IF command_row.request_hash <> p_input->>'requestHash'
    OR command_row.context_id <> (p_input->>'contextId')::uuid
    OR command_row.actor_principal_id <> (p_input->>'actorPrincipalId')::uuid
    OR command_row.actor_membership_id <> (p_input->>'actorMembershipId')::uuid
  THEN
    RETURN jsonb_build_object('kind', 'CONFLICT', 'commandReceiptId', command_row.id);
  END IF;
  IF command_row.status <> 'COMPLETED' THEN
    RETURN jsonb_build_object('kind', 'IN_PROGRESS', 'commandReceiptId', command_row.id);
  END IF;
  RETURN jsonb_build_object(
    'kind', 'REPLAY',
    'commandReceiptId', command_row.id,
    'requestHash', command_row.request_hash,
    'contextId', command_row.context_id,
    'actorPrincipalId', command_row.actor_principal_id,
    'actorMembershipId', command_row.actor_membership_id,
    'result', command_row.result,
    'resultHash', command_row.result_hash
  );
END;
$$;

CREATE FUNCTION fas_cp_v1.load_change_set(p_tenant uuid, p_change_set uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE result jsonb;
BEGIN
  PERFORM fas_cp_v1.assert_tenant(p_tenant);
  SELECT jsonb_build_object(
    'id', change_set.id,
    'tenantId', change_set.tenant_id,
    'configurationKey', change_set.configuration_key,
    'makerPrincipalId', change_set.maker_principal_id,
    'targetScope', jsonb_build_object(
      'type', change_set.target_scope_type,
      'organizationId', change_set.target_organization_id,
      'legacyBranchId', change_set.target_legacy_branch_id
    ),
    'proposedHash', change_set.proposed_hash,
    'status', change_set.status,
    'version', change_set.version,
    'reviewRound', change_set.review_round,
    'riskTier', change_set.risk_tier,
    'approvalPolicyVersion', change_set.approval_policy_version,
    'observationWindowSeconds', change_set.observation_window_seconds,
    'scheduledAt', CASE WHEN change_set.scheduled_at IS NULL THEN NULL
      ELSE floor(extract(epoch FROM change_set.scheduled_at) * 1000)::bigint END,
    'publishedAt', CASE WHEN change_set.published_at IS NULL THEN NULL
      ELSE floor(extract(epoch FROM change_set.published_at) * 1000)::bigint END,
    'observationStartedAt', CASE WHEN change_set.observation_started_at IS NULL THEN NULL
      ELSE floor(extract(epoch FROM change_set.observation_started_at) * 1000)::bigint END
  ) INTO result
  FROM public.change_sets change_set
  WHERE change_set.tenant_id = p_tenant AND change_set.id = p_change_set
  FOR UPDATE;
  RETURN result;
END;
$$;

CREATE FUNCTION fas_cp_v1.load_transition_evidence(
  p_tenant uuid,
  p_change_set uuid,
  p_actor uuid,
  p_target text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE result jsonb;
BEGIN
  PERFORM fas_cp_v1.assert_tenant(p_tenant);
  PERFORM 1
  FROM public.change_set_evidence_receipts receipt
  JOIN public.change_set_evidence_issuers issuer ON issuer.id = receipt.issuer
  JOIN public.change_set_evidence_signing_keys signing_key
    ON signing_key.issuer_id = receipt.issuer
   AND signing_key.key_id = receipt.signing_key_id
  JOIN public.change_set_evidence_issuer_tenant_grants tenant_grant
    ON tenant_grant.tenant_id = receipt.tenant_id
   AND tenant_grant.id = receipt.issuer_tenant_grant_id
  JOIN public.change_set_evidence_requests evidence_request
    ON evidence_request.tenant_id = receipt.tenant_id
   AND evidence_request.id = receipt.evidence_request_id
  WHERE receipt.tenant_id = p_tenant
    AND receipt.change_set_id = p_change_set
    AND receipt.requested_by_principal_id = p_actor
    AND receipt.target_state = p_target
    AND receipt.consumed_at IS NULL
    AND evidence_request.state = 'ISSUED'
    AND evidence_request.issued_receipt_id = receipt.id
  FOR UPDATE OF receipt
  FOR SHARE OF issuer, signing_key, tenant_grant, evidence_request;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'signedClaimsCanonical', receipt.signed_claims_canonical,
    'signatureBase64Url', receipt.signature_base64url,
    'publicKeySpkiBase64', signing_key.public_key_spki_base64,
    'publicKeyFingerprintSha256', signing_key.public_key_fingerprint_sha256,
    'issuerId', issuer.id,
    'issuerPrincipalId', issuer.principal_id,
    'issuerEnvironmentId', issuer.environment_id,
    'issuerCellId', issuer.cell_id,
    'issuerState', issuer.state,
    'keyId', signing_key.key_id,
    'keyAlgorithm', signing_key.algorithm,
    'keyState', signing_key.state,
    'keyValidFrom', floor(extract(epoch FROM signing_key.valid_from) * 1000)::bigint,
    'keySignUntil', floor(extract(epoch FROM signing_key.sign_until) * 1000)::bigint,
    'keyVerifyUntil', floor(extract(epoch FROM signing_key.verify_until) * 1000)::bigint,
    'grantId', tenant_grant.id,
    'grantTenantId', tenant_grant.tenant_id,
    'grantKind', tenant_grant.kind,
    'grantToolId', tenant_grant.tool_id,
    'grantToolVersion', tenant_grant.tool_version,
    'grantState', tenant_grant.state,
    'grantValidFrom', floor(extract(epoch FROM tenant_grant.valid_from) * 1000)::bigint,
    'grantValidUntil', CASE WHEN tenant_grant.valid_until IS NULL THEN NULL
      ELSE floor(extract(epoch FROM tenant_grant.valid_until) * 1000)::bigint END
  ) ORDER BY receipt.kind), '[]'::jsonb) INTO result
  FROM public.change_set_evidence_receipts receipt
  JOIN public.change_set_evidence_issuers issuer ON issuer.id = receipt.issuer
  JOIN public.change_set_evidence_signing_keys signing_key
    ON signing_key.issuer_id = receipt.issuer
   AND signing_key.key_id = receipt.signing_key_id
  JOIN public.change_set_evidence_issuer_tenant_grants tenant_grant
    ON tenant_grant.tenant_id = receipt.tenant_id
   AND tenant_grant.id = receipt.issuer_tenant_grant_id
  JOIN public.change_set_evidence_requests evidence_request
    ON evidence_request.tenant_id = receipt.tenant_id
   AND evidence_request.id = receipt.evidence_request_id
  WHERE receipt.tenant_id = p_tenant
    AND receipt.change_set_id = p_change_set
    AND receipt.requested_by_principal_id = p_actor
    AND receipt.target_state = p_target
    AND receipt.consumed_at IS NULL
    AND evidence_request.state = 'ISSUED'
    AND evidence_request.issued_receipt_id = receipt.id;
  RETURN result;
END;
$$;

CREATE FUNCTION fas_cp_v1.load_latest_transition_hash(
  p_tenant uuid, p_change_set uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE result text;
BEGIN
  PERFORM fas_cp_v1.assert_tenant(p_tenant);
  SELECT receipt.receipt_hash INTO result
  FROM public.change_set_transition_receipts receipt
  WHERE receipt.tenant_id = p_tenant AND receipt.change_set_id = p_change_set
  ORDER BY receipt.sequence DESC LIMIT 1;
  RETURN to_jsonb(result);
END;
$$;

CREATE FUNCTION fas_cp_v1.insert_access_decision(p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE tenant uuid := (p_input->>'tenantId')::uuid;
BEGIN
  PERFORM fas_cp_v1.assert_tenant(tenant);
  INSERT INTO public.access_decision_receipts (
    id, tenant_id, context_id, actor_principal_id, membership_id,
    assignment_ids, role_package_version_ids, capability_key, resource_type,
    resource_id, decision, reason_code, policy_version_id, correlation_id, occurred_at
  ) VALUES (
    (p_input->>'id')::uuid, tenant, (p_input->>'contextId')::uuid,
    (p_input->>'actorPrincipalId')::uuid, (p_input->>'membershipId')::uuid,
    ARRAY(SELECT jsonb_array_elements_text(p_input->'assignmentIds'))::uuid[],
    ARRAY(SELECT jsonb_array_elements_text(p_input->'rolePackageVersionIds'))::uuid[],
    p_input->>'capabilityKey', p_input->>'resourceType', p_input->>'resourceId',
    p_input->>'decision', p_input->>'reasonCode', (p_input->>'policyVersionId')::uuid,
    p_input->>'correlationId', to_timestamp((p_input->>'occurredAt')::double precision / 1000.0)
  );
  RETURN 'true'::jsonb;
END;
$$;

CREATE FUNCTION fas_cp_v1.insert_command_attempt(p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE tenant uuid := (p_input->>'tenantId')::uuid;
BEGIN
  PERFORM fas_cp_v1.assert_tenant(tenant);
  INSERT INTO public.change_set_command_attempt_receipts (
    id, tenant_id, context_id, actor_principal_id, actor_membership_id,
    command_receipt_id, request_hash, outcome, occurred_at
  ) VALUES (
    (p_input->>'id')::uuid, tenant, (p_input->>'contextId')::uuid,
    (p_input->>'actorPrincipalId')::uuid, (p_input->>'actorMembershipId')::uuid,
    (p_input->>'commandReceiptId')::uuid, p_input->>'requestHash',
    p_input->>'outcome', to_timestamp((p_input->>'occurredAt')::double precision / 1000.0)
  );
  RETURN 'true'::jsonb;
END;
$$;

CREATE FUNCTION fas_cp_v1.consume_transition_evidence(
  p_tenant uuid,
  p_change_set uuid,
  p_command uuid,
  p_receipts uuid[],
  p_consumed_at bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE updated_count integer;
BEGIN
  PERFORM fas_cp_v1.assert_tenant(p_tenant);
  IF p_receipts IS NULL OR cardinality(p_receipts) NOT IN (1, 3)
    OR (SELECT count(DISTINCT item) FROM unnest(p_receipts) item) <> cardinality(p_receipts)
    OR p_consumed_at < 0
  THEN RETURN 'false'::jsonb; END IF;
  UPDATE public.change_set_evidence_receipts receipt
  SET consumed_at = to_timestamp(p_consumed_at::double precision / 1000.0),
      consumed_by_command_receipt_id = p_command
  WHERE receipt.tenant_id = p_tenant
    AND receipt.change_set_id = p_change_set
    AND receipt.id = ANY(p_receipts)
    AND receipt.consumed_at IS NULL;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN to_jsonb(updated_count = cardinality(p_receipts));
END;
$$;

CREATE FUNCTION fas_cp_v1.insert_change_set(p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE draft jsonb := p_input->'draft'; tenant uuid := (p_input->'draft'->>'tenantId')::uuid;
BEGIN
  PERFORM fas_cp_v1.assert_tenant(tenant);
  INSERT INTO public.change_sets (
    id, tenant_id, change_type, configuration_key, title, purpose,
    owner_principal_id, owner_membership_id, maker_principal_id, maker_membership_id,
    target_scope_type, target_organization_id, target_legacy_branch_id,
    base_version, base_hash, proposed_version, proposed_hash, base_config, proposed_config,
    dependency_versions, compatibility_range, risk_tier, data_class,
    affected_tenant_count, affected_branch_count, affected_principal_count,
    affected_case_count, affected_integration_count, semantic_diff,
    approval_policy_version, approval_policy_version_id, rollout_strategy,
    canary_scope, abort_conditions, observation_window_seconds, rollback_strategy,
    status, review_round, version
  ) VALUES (
    (p_input->>'id')::uuid, tenant, draft->>'changeType', draft->>'configurationKey',
    draft->>'title', draft->>'purpose', (draft->>'ownerPrincipalId')::uuid,
    (draft->>'ownerMembershipId')::uuid, (draft->>'makerPrincipalId')::uuid,
    (draft->>'makerMembershipId')::uuid, draft->'targetScope'->>'type',
    nullif(draft->'targetScope'->>'organizationId', '')::uuid,
    nullif(draft->'targetScope'->>'legacyBranchId', '')::integer,
    (draft->>'baseVersion')::bigint, draft->>'baseHash',
    (draft->>'proposedVersion')::bigint, draft->>'proposedHash',
    draft->'baseConfig', draft->'proposedConfig', draft->'dependencyVersions',
    draft->>'compatibilityRange', draft->>'riskTier', draft->>'dataClass',
    (draft->>'affectedTenantCount')::integer, (draft->>'affectedBranchCount')::integer,
    (draft->>'affectedPrincipalCount')::integer, (draft->>'affectedCaseCount')::integer,
    (draft->>'affectedIntegrationCount')::integer, draft->'semanticDiff',
    draft->>'approvalPolicyVersion', (draft->>'approvalPolicyVersion')::uuid,
    draft->'rolloutStrategy', draft->'canaryScope', draft->'abortConditions',
    (draft->>'observationWindowSeconds')::integer, draft->'rollbackStrategy',
    draft->>'status', (draft->>'reviewRound')::integer, (draft->>'version')::bigint
  );
  RETURN 'true'::jsonb;
END;
$$;

CREATE FUNCTION fas_cp_v1.insert_approval(p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE tenant uuid := (p_input->>'tenantId')::uuid;
BEGIN
  PERFORM fas_cp_v1.assert_tenant(tenant);
  INSERT INTO public.change_set_approvals (
    id, tenant_id, change_set_id, review_round, checker_principal_id,
    checker_membership_id, decision, reason_code, approval_policy_version,
    approval_policy_version_id, step_up_receipt_id, evidence, decision_hash, created_at
  ) VALUES (
    (p_input->>'id')::uuid, tenant, (p_input->>'changeSetId')::uuid,
    (p_input->>'reviewRound')::integer, (p_input->>'checkerPrincipalId')::uuid,
    (p_input->>'checkerMembershipId')::uuid, p_input->>'decision',
    p_input->>'reasonCode', p_input->>'approvalPolicyVersion',
    (p_input->>'approvalPolicyVersionId')::uuid, (p_input->>'stepUpReceiptId')::uuid,
    p_input->'evidence', p_input->>'decisionHash',
    to_timestamp((p_input->>'createdAt')::double precision / 1000.0)
  );
  RETURN 'true'::jsonb;
END;
$$;

CREATE FUNCTION fas_cp_v1.insert_transition_receipt(p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE tenant uuid := (p_input->>'tenantId')::uuid;
BEGIN
  PERFORM fas_cp_v1.assert_tenant(tenant);
  INSERT INTO public.change_set_transition_receipts (
    id, command_receipt_id, tenant_id, change_set_id, sequence,
    actor_principal_id, actor_membership_id, from_state, to_state, reason_code,
    policy_version, policy_version_id, evidence, evidence_hash, previous_hash,
    receipt_hash, occurred_at
  ) VALUES (
    (p_input->>'id')::uuid, (p_input->>'commandReceiptId')::uuid, tenant,
    (p_input->>'changeSetId')::uuid, (p_input->>'sequence')::bigint,
    (p_input->>'actorPrincipalId')::uuid, (p_input->>'actorMembershipId')::uuid,
    p_input->>'fromState', p_input->>'toState', p_input->>'reasonCode',
    p_input->>'policyVersion', (p_input->>'policyVersionId')::uuid,
    p_input->'evidence', p_input->>'evidenceHash', p_input->>'previousHash',
    p_input->>'receiptHash', to_timestamp((p_input->>'occurredAt')::double precision / 1000.0)
  );
  RETURN 'true'::jsonb;
END;
$$;

CREATE FUNCTION fas_cp_v1.update_change_set(p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE tenant uuid := (p_input->>'tenantId')::uuid; next_state jsonb := p_input->'next'; updated_count integer;
BEGIN
  PERFORM fas_cp_v1.assert_tenant(tenant);
  UPDATE public.change_sets change_set SET
    status = next_state->>'status',
    version = (next_state->>'version')::bigint,
    review_round = coalesce((next_state->>'reviewRound')::integer, change_set.review_round),
    checker_principal_id = CASE WHEN next_state ? 'checkerPrincipalId'
      THEN nullif(next_state->>'checkerPrincipalId', '')::uuid ELSE change_set.checker_principal_id END,
    scheduled_at = CASE WHEN next_state ? 'scheduledAt'
      THEN to_timestamp((next_state->>'scheduledAt')::double precision / 1000.0) ELSE change_set.scheduled_at END,
    published_at = CASE WHEN next_state ? 'publishedAt'
      THEN to_timestamp((next_state->>'publishedAt')::double precision / 1000.0) ELSE change_set.published_at END,
    observation_started_at = CASE WHEN next_state ? 'observationStartedAt'
      THEN to_timestamp((next_state->>'observationStartedAt')::double precision / 1000.0) ELSE change_set.observation_started_at END,
    effective_at = CASE WHEN next_state ? 'effectiveAt'
      THEN to_timestamp((next_state->>'effectiveAt')::double precision / 1000.0) ELSE change_set.effective_at END,
    closed_at = CASE WHEN next_state ? 'closedAt'
      THEN to_timestamp((next_state->>'closedAt')::double precision / 1000.0) ELSE change_set.closed_at END,
    status_reason = p_input->>'statusReason',
    updated_at = statement_timestamp()
  WHERE change_set.tenant_id = tenant
    AND change_set.id = (p_input->>'changeSetId')::uuid
    AND change_set.version = (p_input->>'expectedVersion')::bigint;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN to_jsonb(updated_count = 1);
END;
$$;

CREATE FUNCTION fas_cp_v1.complete_command(p_tenant uuid, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE updated_count integer;
BEGIN
  PERFORM fas_cp_v1.assert_tenant(p_tenant);
  UPDATE public.change_set_command_receipts command SET
    change_set_id = (p_input->>'changeSetId')::uuid,
    status = 'COMPLETED',
    result = p_input->'result',
    result_hash = p_input->>'resultHash',
    completed_at = to_timestamp((p_input->>'completedAt')::double precision / 1000.0),
    version = command.version + 1
  WHERE command.tenant_id = p_tenant
    AND command.id = (p_input->>'commandReceiptId')::uuid
    AND command.status = 'CLAIMED';
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN to_jsonb(updated_count = 1);
END;
$$;

CREATE SCHEMA fas_evidence_v1;
REVOKE ALL ON SCHEMA fas_evidence_v1 FROM PUBLIC;

CREATE FUNCTION fas_evidence_v1.assert_tenant(p_tenant uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE bound_tenant text;
BEGIN
  bound_tenant := nullif(current_setting('app.tenant_id', true), '');
  IF bound_tenant IS NULL OR bound_tenant <> p_tenant::text THEN
    RAISE EXCEPTION 'evidence RPC tenant context mismatch' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE FUNCTION fas_evidence_v1.load_verification_context(
  p_tenant uuid,
  p_issuer text,
  p_key text,
  p_grant uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE result jsonb;
BEGIN
  PERFORM fas_evidence_v1.assert_tenant(p_tenant);
  PERFORM 1
  FROM public.change_set_evidence_issuers issuer
  JOIN public.change_set_evidence_signing_keys signing_key
    ON signing_key.issuer_id = issuer.id
  JOIN public.change_set_evidence_issuer_tenant_grants tenant_grant
    ON tenant_grant.issuer_id = issuer.id
  WHERE issuer.id = p_issuer
    AND signing_key.key_id = p_key
    AND tenant_grant.tenant_id = p_tenant
    AND tenant_grant.id = p_grant
  FOR SHARE OF issuer, signing_key, tenant_grant;

  SELECT jsonb_build_object(
    'issuerId', issuer.id,
    'issuerPrincipalId', issuer.principal_id,
    'environmentId', issuer.environment_id,
    'cellId', issuer.cell_id,
    'issuerState', issuer.state,
    'keyId', signing_key.key_id,
    'algorithm', signing_key.algorithm,
    'keyState', signing_key.state,
    'validFrom', floor(extract(epoch FROM signing_key.valid_from) * 1000)::bigint,
    'signUntil', floor(extract(epoch FROM signing_key.sign_until) * 1000)::bigint,
    'verifyUntil', floor(extract(epoch FROM signing_key.verify_until) * 1000)::bigint,
    'publicKeySpkiBase64', signing_key.public_key_spki_base64,
    'publicKeyFingerprintSha256', signing_key.public_key_fingerprint_sha256,
    'grantId', tenant_grant.id,
    'grantTenantId', tenant_grant.tenant_id,
    'grantKind', tenant_grant.kind,
    'grantToolId', tenant_grant.tool_id,
    'grantToolVersion', tenant_grant.tool_version,
    'grantState', tenant_grant.state,
    'grantValidFrom', floor(extract(epoch FROM tenant_grant.valid_from) * 1000)::bigint,
    'grantValidUntil', CASE WHEN tenant_grant.valid_until IS NULL THEN NULL
      ELSE floor(extract(epoch FROM tenant_grant.valid_until) * 1000)::bigint END
  ) INTO result
  FROM public.change_set_evidence_issuers issuer
  JOIN public.change_set_evidence_signing_keys signing_key
    ON signing_key.issuer_id = issuer.id
  JOIN public.change_set_evidence_issuer_tenant_grants tenant_grant
    ON tenant_grant.issuer_id = issuer.id
  WHERE issuer.id = p_issuer
    AND signing_key.key_id = p_key
    AND tenant_grant.tenant_id = p_tenant
    AND tenant_grant.id = p_grant;
  RETURN result;
END;
$$;

CREATE FUNCTION fas_evidence_v1.persist_receipt(p_tenant uuid, p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM fas_evidence_v1.assert_tenant(p_tenant);
  IF jsonb_typeof(p_input) <> 'object'
    OR (p_input->>'tenantId')::uuid <> p_tenant
  THEN
    RAISE EXCEPTION 'invalid signed evidence persistence request';
  END IF;
  INSERT INTO public.change_set_evidence_receipts (
    id, tenant_id, change_set_id, target_state, kind, issuer,
    issuer_principal_id, signing_key_id, algorithm, schema_version, audience,
    environment_id, cell_id, evidence_request_id, issuer_tenant_grant_id,
    challenge_nonce_hash, tool_id, tool_version, requested_by_principal_id,
    requested_by_membership_id, subject_hash, policy_version_id, outcome,
    artifact_count, artifact_manifest_hash, outcome_hash, signed_claims,
    signed_claims_canonical, signed_claims_hash, signature_base64url,
    issued_at, expires_at
  ) VALUES (
    (p_input->>'id')::uuid, p_tenant, (p_input->>'changeSetId')::uuid,
    p_input->>'targetState', p_input->>'kind', p_input->>'issuer',
    (p_input->>'issuerPrincipalId')::uuid, p_input->>'signingKeyId',
    p_input->>'algorithm', (p_input->>'schemaVersion')::integer,
    p_input->>'audience', p_input->>'environmentId', p_input->>'cellId',
    (p_input->>'evidenceRequestId')::uuid,
    (p_input->>'issuerTenantGrantId')::uuid, p_input->>'challengeNonceHash',
    p_input->>'toolId', p_input->>'toolVersion',
    (p_input->>'requestedByPrincipalId')::uuid,
    (p_input->>'requestedByMembershipId')::uuid, p_input->>'subjectHash',
    (p_input->>'policyVersionId')::uuid, p_input->>'outcome',
    nullif(p_input->>'artifactCount', '')::integer,
    p_input->>'artifactManifestHash', p_input->>'outcomeHash',
    p_input->'signedClaims', p_input->>'signedClaimsCanonical',
    p_input->>'signedClaimsHash', p_input->>'signatureBase64Url',
    to_timestamp((p_input->>'issuedAt')::double precision / 1000.0),
    to_timestamp((p_input->>'expiresAt')::double precision / 1000.0)
  );
  RETURN 'true'::jsonb;
END;
$$;

REVOKE ALL ON TABLE public.r1_configuration_snapshots FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fas_cp_v1 FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fas_evidence_v1 FROM PUBLIC;

COMMENT ON SCHEMA fas_cp_v1 IS
  'Default-unwired ChangeSet command RPC facade. Function ownership and EXECUTE grants require a separate reviewed authority bootstrap.';
COMMENT ON TABLE public.r1_configuration_snapshots IS
  'Authoritative R1 baseline snapshots. This additive table is not a publisher or production adoption path.';
COMMENT ON SCHEMA fas_evidence_v1 IS
  'Default-unwired signed-evidence verification and persistence facade. It contains no private signing key.';
