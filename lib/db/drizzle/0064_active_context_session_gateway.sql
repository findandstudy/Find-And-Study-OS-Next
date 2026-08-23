-- Additive, default-unwired browser-session selection and issuance-rate foundation.
-- Runtime roles, route registration and production configuration remain external.

ALTER TABLE public.principals
  ADD CONSTRAINT principals_id_legacy_user_id_uq UNIQUE (id, legacy_user_id);

CREATE TABLE public.active_session_context_selections (
  id uuid PRIMARY KEY NOT NULL,
  tenant_id uuid NOT NULL,
  session_fingerprint text NOT NULL,
  session_generation bigint NOT NULL,
  legacy_user_id integer NOT NULL,
  principal_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  organization_id uuid,
  legacy_branch_id integer,
  status text DEFAULT 'ACTIVE' NOT NULL,
  impersonator_principal_id uuid,
  original_session_fingerprint text,
  selected_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
  updated_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
  revoked_at timestamp with time zone,
  CONSTRAINT active_session_context_selections_tenant_id_id_uq
    UNIQUE (tenant_id, id),
  CONSTRAINT active_session_context_selections_fingerprint_generation_uq
    UNIQUE (session_fingerprint, session_generation),
  CONSTRAINT active_session_context_selections_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT active_session_context_selections_principal_user_fk
    FOREIGN KEY (principal_id, legacy_user_id)
    REFERENCES public.principals(id, legacy_user_id) ON DELETE RESTRICT,
  CONSTRAINT active_session_context_selections_membership_fk
    FOREIGN KEY (tenant_id, membership_id, principal_id)
    REFERENCES public.memberships(tenant_id, id, principal_id) ON DELETE RESTRICT,
  CONSTRAINT active_session_context_selections_organization_fk
    FOREIGN KEY (tenant_id, organization_id)
    REFERENCES public.organizations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT active_session_context_selections_branch_fk
    FOREIGN KEY (tenant_id, organization_id, legacy_branch_id)
    REFERENCES public.tenant_organization_legacy_branches(
      tenant_id, organization_id, legacy_branch_id
    ) ON DELETE RESTRICT,
  CONSTRAINT active_session_context_selections_impersonator_fk
    FOREIGN KEY (impersonator_principal_id)
    REFERENCES public.principals(id) ON DELETE RESTRICT,
  CONSTRAINT active_session_context_selections_id_uuidv7_chk
    CHECK (substring(id::text from 15 for 1) = '7'),
  CONSTRAINT active_session_context_selections_fingerprint_chk
    CHECK (session_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT active_session_context_selections_generation_chk
    CHECK (session_generation > 0),
  CONSTRAINT active_session_context_selections_status_chk
    CHECK (status IN ('ACTIVE', 'ROTATED', 'REVOKED')),
  CONSTRAINT active_session_context_selections_scope_chk
    CHECK (legacy_branch_id IS NULL OR organization_id IS NOT NULL),
  CONSTRAINT active_session_context_selections_impersonation_chk
    CHECK (
      (impersonator_principal_id IS NULL AND original_session_fingerprint IS NULL)
      OR (
        impersonator_principal_id IS NOT NULL
        AND original_session_fingerprint ~ '^[0-9a-f]{64}$'
      )
    ),
  CONSTRAINT active_session_context_selections_revocation_chk
    CHECK (
      (status = 'ACTIVE' AND revoked_at IS NULL)
      OR (status IN ('ROTATED', 'REVOKED') AND revoked_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX active_session_context_selections_one_active_uidx
  ON public.active_session_context_selections (session_fingerprint)
  WHERE status = 'ACTIVE';
CREATE INDEX active_session_context_selections_tenant_principal_idx
  ON public.active_session_context_selections
  (tenant_id, principal_id, membership_id, status);

CREATE TABLE public.active_context_issuance_rate_limits (
  tenant_id uuid NOT NULL,
  subject_hash text NOT NULL,
  session_fingerprint text NOT NULL,
  session_generation bigint NOT NULL,
  principal_id uuid NOT NULL,
  window_started_at timestamp with time zone NOT NULL,
  request_count integer DEFAULT 1 NOT NULL,
  updated_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
  PRIMARY KEY (tenant_id, subject_hash),
  CONSTRAINT active_context_issuance_rate_limits_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT active_context_issuance_rate_limits_principal_fk
    FOREIGN KEY (principal_id) REFERENCES public.principals(id) ON DELETE RESTRICT,
  CONSTRAINT active_context_issuance_rate_limits_selection_fk
    FOREIGN KEY (session_fingerprint, session_generation)
    REFERENCES public.active_session_context_selections(
      session_fingerprint, session_generation
    ) ON DELETE RESTRICT,
  CONSTRAINT active_context_issuance_rate_limits_hashes_chk
    CHECK (
      subject_hash ~ '^[0-9a-f]{64}$'
      AND session_fingerprint ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT active_context_issuance_rate_limits_generation_chk
    CHECK (session_generation > 0),
  CONSTRAINT active_context_issuance_rate_limits_count_chk
    CHECK (request_count BETWEEN 1 AND 1000000)
);

CREATE TABLE public.active_context_issuance_permits (
  id uuid PRIMARY KEY NOT NULL,
  tenant_id uuid NOT NULL,
  subject_hash text NOT NULL,
  session_fingerprint text NOT NULL,
  session_generation bigint NOT NULL,
  principal_id uuid NOT NULL,
  issued_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  CONSTRAINT active_context_issuance_permits_tenant_id_id_uq
    UNIQUE (tenant_id, id),
  CONSTRAINT active_context_issuance_permits_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT active_context_issuance_permits_principal_fk
    FOREIGN KEY (principal_id) REFERENCES public.principals(id) ON DELETE RESTRICT,
  CONSTRAINT active_context_issuance_permits_selection_fk
    FOREIGN KEY (session_fingerprint, session_generation)
    REFERENCES public.active_session_context_selections(
      session_fingerprint, session_generation
    ) ON DELETE RESTRICT,
  CONSTRAINT active_context_issuance_permits_id_uuidv7_chk
    CHECK (substring(id::text from 15 for 1) = '7'),
  CONSTRAINT active_context_issuance_permits_hashes_chk
    CHECK (
      subject_hash ~ '^[0-9a-f]{64}$'
      AND session_fingerprint ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT active_context_issuance_permits_generation_chk
    CHECK (session_generation > 0),
  CONSTRAINT active_context_issuance_permits_expiry_chk
    CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '15 seconds')
);

ALTER TABLE public.active_session_context_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.active_session_context_selections FORCE ROW LEVEL SECURITY;
ALTER TABLE public.active_context_issuance_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.active_context_issuance_rate_limits FORCE ROW LEVEL SECURITY;
ALTER TABLE public.active_context_issuance_permits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.active_context_issuance_permits FORCE ROW LEVEL SECURITY;

CREATE POLICY active_session_context_selections_owner_or_tenant
  ON public.active_session_context_selections FOR ALL
  USING (
    current_user = 'fas_session_owner'
    OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    current_user = 'fas_session_owner'
    OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
CREATE POLICY active_context_issuance_rate_limits_owner_or_tenant
  ON public.active_context_issuance_rate_limits FOR ALL
  USING (
    current_user = 'fas_rate_limit_owner'
    OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    current_user = 'fas_rate_limit_owner'
    OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
CREATE POLICY active_context_issuance_permits_owner_or_tenant
  ON public.active_context_issuance_permits FOR ALL
  USING (
    current_user = 'fas_rate_limit_owner'
    OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    current_user = 'fas_rate_limit_owner'
    OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

CREATE SCHEMA fas_session_v1;
REVOKE ALL ON SCHEMA fas_session_v1 FROM PUBLIC;

CREATE FUNCTION fas_session_v1.resolve_session_for_active_context(
  p_session_id text,
  p_session_fingerprint text,
  p_observed_at bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  session_row public.sessions%ROWTYPE;
  selection_row public.active_session_context_selections%ROWTYPE;
  user_row public.users%ROWTYPE;
  principal_row public.principals%ROWTYPE;
  membership_row public.memberships%ROWTYPE;
  observed_at timestamp with time zone;
  issued_at bigint;
  idle_expires_at bigint;
  absolute_expires_at bigint;
  session_user_id integer;
  session_original_id text;
  account_status text;
BEGIN
  IF current_setting('transaction_isolation') <> 'serializable' THEN
    RAISE EXCEPTION 'active context session resolution requires a serializable transaction';
  END IF;
  IF NULLIF(current_setting('app.tenant_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'active context session resolver requires a clean tenant context';
  END IF;
  IF p_session_id IS NULL
    OR p_session_id !~ '^[0-9a-f]{64}$'
    OR p_session_fingerprint IS NULL
    OR p_session_fingerprint !~ '^[0-9a-f]{64}$'
    OR encode(sha256(convert_to(p_session_id, 'UTF8')), 'hex')
       IS DISTINCT FROM p_session_fingerprint
    OR p_observed_at IS NULL
    OR p_observed_at < 0
    OR p_observed_at > 253402300799999
  THEN
    RAISE EXCEPTION 'active context session resolution input is invalid';
  END IF;
  observed_at := to_timestamp(p_observed_at / 1000.0);

  SELECT * INTO session_row
  FROM public.sessions session
  WHERE session.sid = p_session_id
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(session_row.sess -> 'user' -> 'id') <> 'number'
    OR jsonb_typeof(session_row.sess -> 'issued_at') <> 'number'
    OR (session_row.sess ? 'originalSid'
        AND jsonb_typeof(session_row.sess -> 'originalSid') <> 'string')
  THEN
    RAISE EXCEPTION 'active context session payload is invalid';
  END IF;
  BEGIN
    session_user_id := (session_row.sess -> 'user' ->> 'id')::integer;
    issued_at := (session_row.sess ->> 'issued_at')::bigint;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'active context session payload is invalid';
  END;
  IF session_user_id <= 0 OR issued_at <= 0 OR issued_at > p_observed_at THEN
    RAISE EXCEPTION 'active context session payload is invalid';
  END IF;
  session_original_id := NULLIF(session_row.sess ->> 'originalSid', '');
  IF session_original_id IS NOT NULL
    AND (session_original_id !~ '^[0-9a-f]{64}$' OR session_original_id = p_session_id)
  THEN
    RAISE EXCEPTION 'active context session impersonation payload is invalid';
  END IF;

  SELECT * INTO selection_row
  FROM public.active_session_context_selections selection
  WHERE selection.session_fingerprint = p_session_fingerprint
  ORDER BY selection.session_generation DESC
  LIMIT 1
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  PERFORM set_config('app.tenant_id', selection_row.tenant_id::text, true);

  SELECT * INTO user_row
  FROM public.users account
  WHERE account.id = selection_row.legacy_user_id
  FOR SHARE;
  SELECT * INTO principal_row
  FROM public.principals principal
  WHERE principal.id = selection_row.principal_id
    AND principal.legacy_user_id = selection_row.legacy_user_id
  FOR SHARE;
  SELECT * INTO membership_row
  FROM public.memberships membership
  WHERE membership.tenant_id = selection_row.tenant_id
    AND membership.id = selection_row.membership_id
    AND membership.principal_id = selection_row.principal_id
    AND membership.organization_id IS NOT DISTINCT FROM selection_row.organization_id
    AND membership.legacy_branch_id IS NOT DISTINCT FROM selection_row.legacy_branch_id
  FOR SHARE;

  IF user_row.id IS NULL OR principal_row.id IS NULL OR membership_row.id IS NULL THEN
    RETURN NULL;
  END IF;
  IF session_user_id IS DISTINCT FROM selection_row.legacy_user_id
    OR (
      session_original_id IS NULL
      AND session_row.user_id IS DISTINCT FROM selection_row.legacy_user_id
    )
    OR (
      session_original_id IS NOT NULL
      AND (
        session_row.user_id IS NOT NULL
        OR selection_row.impersonator_principal_id IS NULL
        OR selection_row.original_session_fingerprint
           IS DISTINCT FROM encode(sha256(convert_to(session_original_id, 'UTF8')), 'hex')
      )
    )
    OR (
      session_original_id IS NULL
      AND (
        selection_row.impersonator_principal_id IS NOT NULL
        OR selection_row.original_session_fingerprint IS NOT NULL
      )
    )
    OR principal_row.principal_type <> 'HUMAN'
    OR principal_row.status <> 'ACTIVE'
    OR principal_row.risk_state = 'LOCKED'
    OR membership_row.status <> 'ACTIVE'
    OR membership_row.valid_from > observed_at
    OR (membership_row.valid_until IS NOT NULL AND membership_row.valid_until <= observed_at)
  THEN
    RETURN NULL;
  END IF;

  idle_expires_at := floor(extract(epoch FROM session_row.expire AT TIME ZONE 'UTC') * 1000)::bigint;
  absolute_expires_at := issued_at + 86400000;
  account_status := CASE
    WHEN user_row.deleted_at IS NOT NULL THEN 'DELETED'
    WHEN user_row.is_active = false THEN 'INACTIVE'
    WHEN user_row.role = 'student' AND user_row.email_verified = false THEN 'UNVERIFIED'
    ELSE 'ACTIVE'
  END;

  RETURN jsonb_build_object(
    'sessionFingerprint', selection_row.session_fingerprint,
    'sessionGeneration', selection_row.session_generation,
    'status', selection_row.status,
    'accountStatus', account_status,
    'authenticatedPrincipalId', selection_row.principal_id,
    'tenantId', selection_row.tenant_id,
    'organizationId', selection_row.organization_id,
    'legacyBranchId', selection_row.legacy_branch_id,
    'issuedAt', issued_at,
    'idleExpiresAt', idle_expires_at,
    'absoluteExpiresAt', absolute_expires_at,
    'impersonatorPrincipalId', selection_row.impersonator_principal_id,
    'originalSessionFingerprint', selection_row.original_session_fingerprint
  );
END;
$$;

CREATE SCHEMA fas_rate_limit_v1;
REVOKE ALL ON SCHEMA fas_rate_limit_v1 FROM PUBLIC;

CREATE FUNCTION fas_rate_limit_v1.consume_active_context_issuance(
  p_tenant uuid,
  p_subject_hash text,
  p_session_fingerprint text,
  p_session_generation bigint,
  p_principal uuid,
  p_observed_at bigint,
  p_permit_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  observed_at timestamp with time zone;
  window_started_at timestamp with time zone;
  current_count integer;
  expected_subject_hash text;
  permit_expires_at timestamp with time zone;
BEGIN
  IF current_setting('transaction_isolation') <> 'serializable' THEN
    RAISE EXCEPTION 'active context rate limit requires a serializable transaction';
  END IF;
  IF NULLIF(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'active context rate limit tenant mismatch';
  END IF;
  IF p_tenant IS NULL
    OR p_principal IS NULL
    OR p_subject_hash IS NULL
    OR p_subject_hash !~ '^[0-9a-f]{64}$'
    OR p_session_fingerprint IS NULL
    OR p_session_fingerprint !~ '^[0-9a-f]{64}$'
    OR p_session_generation IS NULL
    OR p_session_generation <= 0
    OR p_observed_at IS NULL
    OR p_observed_at < 0
    OR p_observed_at > 253402300799999
    OR p_permit_id IS NULL
    OR substring(p_permit_id::text from 15 for 1) <> '7'
  THEN
    RAISE EXCEPTION 'active context rate limit input is invalid';
  END IF;
  observed_at := to_timestamp(p_observed_at / 1000.0);
  IF observed_at < statement_timestamp() - interval '30 seconds'
    OR observed_at > statement_timestamp() + interval '5 seconds'
  THEN
    RAISE EXCEPTION 'active context rate limit observation is stale';
  END IF;
  expected_subject_hash := encode(sha256(
    convert_to('fas.active-context-issuance-rate-limit.v1', 'UTF8')
    || decode('00', 'hex')
    || convert_to(p_session_fingerprint, 'UTF8')
    || decode('00', 'hex')
    || convert_to(p_session_generation::text, 'UTF8')
    || decode('00', 'hex')
    || convert_to(p_principal::text, 'UTF8')
    || decode('00', 'hex')
    || convert_to(p_tenant::text, 'UTF8')
  ), 'hex');
  IF expected_subject_hash IS DISTINCT FROM p_subject_hash THEN
    RAISE EXCEPTION 'active context rate limit subject mismatch';
  END IF;

  PERFORM 1
  FROM public.active_session_context_selections selection
  WHERE selection.tenant_id = p_tenant
    AND selection.session_fingerprint = p_session_fingerprint
    AND selection.session_generation = p_session_generation
    AND selection.principal_id = p_principal
    AND selection.status = 'ACTIVE'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active context rate limit selection inactive';
  END IF;

  window_started_at := to_timestamp(floor(extract(epoch FROM observed_at) / 60) * 60);
  INSERT INTO public.active_context_issuance_rate_limits (
    tenant_id, subject_hash, session_fingerprint, session_generation,
    principal_id, window_started_at, request_count, updated_at
  ) VALUES (
    p_tenant, p_subject_hash, p_session_fingerprint, p_session_generation,
    p_principal, window_started_at, 1, statement_timestamp()
  )
  ON CONFLICT (tenant_id, subject_hash) DO UPDATE SET
    session_fingerprint = EXCLUDED.session_fingerprint,
    session_generation = EXCLUDED.session_generation,
    principal_id = EXCLUDED.principal_id,
    window_started_at = EXCLUDED.window_started_at,
    request_count = CASE
      WHEN public.active_context_issuance_rate_limits.window_started_at
           = EXCLUDED.window_started_at
      THEN public.active_context_issuance_rate_limits.request_count + 1
      ELSE 1
    END,
    updated_at = statement_timestamp()
  RETURNING request_count INTO current_count;

  IF current_count > 5 THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'retryAfterMs', greatest(
        1,
        floor(extract(epoch FROM (window_started_at + interval '1 minute' - observed_at)) * 1000)::bigint
      )
    );
  END IF;

  permit_expires_at := observed_at + interval '15 seconds';
  INSERT INTO public.active_context_issuance_permits (
    id, tenant_id, subject_hash, session_fingerprint, session_generation,
    principal_id, issued_at, expires_at
  ) VALUES (
    p_permit_id, p_tenant, p_subject_hash, p_session_fingerprint,
    p_session_generation, p_principal, observed_at, permit_expires_at
  );

  RETURN jsonb_build_object(
    'allowed', true,
    'permitId', p_permit_id,
    'subjectHash', p_subject_hash,
    'issuedAt', p_observed_at,
    'expiresAt', p_observed_at + 15000
  );
END;
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fas_session_v1 FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fas_rate_limit_v1 FROM PUBLIC;

COMMENT ON SCHEMA fas_session_v1 IS
  'Default-unwired EXECUTE-only browser session to active-context selection facade.';
COMMENT ON SCHEMA fas_rate_limit_v1 IS
  'Default-unwired EXECUTE-only durable active-context issuance limiter.';
COMMENT ON FUNCTION fas_session_v1.resolve_session_for_active_context(text, text, bigint) IS
  'Locks one server session and its server-selected HUMAN tenant context without trusting request scope.';
COMMENT ON FUNCTION fas_rate_limit_v1.consume_active_context_issuance(uuid, text, text, bigint, uuid, bigint, uuid) IS
  'Atomically limits active-context issuance and appends a short-lived UUIDv7 permit receipt.';
