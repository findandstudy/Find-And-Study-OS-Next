-- Additive, default-unwired evidence authenticity and durable audit foundation.
-- No runtime role, route, publisher, private key, or production wiring is created here.
-- The existing evidence table must remain empty until this contract is adopted.

LOCK TABLE public.change_set_evidence_receipts IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF pg_relation_size('public.change_set_evidence_receipts'::regclass) > 0 THEN
    RAISE EXCEPTION '0058 requires an empty default-unwired evidence table; use an explicit reviewed adoption migration';
  END IF;
END;
$$;

CREATE TABLE public.change_set_evidence_issuers (
  id text PRIMARY KEY NOT NULL,
  principal_id uuid NOT NULL,
  environment_id text NOT NULL,
  cell_id text NOT NULL,
  state text DEFAULT 'ACTIVE' NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  revoked_at timestamp with time zone,
  CONSTRAINT change_set_evidence_issuers_principal_environment_uq
    UNIQUE (principal_id, environment_id, cell_id),
  CONSTRAINT change_set_evidence_issuers_principal_fk
    FOREIGN KEY (principal_id) REFERENCES public.principals(id) ON DELETE RESTRICT,
  CONSTRAINT change_set_evidence_issuers_identity_chk
    CHECK (
      id ~ '^[a-z][a-z0-9._:-]{2,95}$'
      AND environment_id ~ '^[a-z][a-z0-9._:-]{2,95}$'
      AND cell_id ~ '^[a-z][a-z0-9._:-]{2,95}$'
    ),
  CONSTRAINT change_set_evidence_issuers_state_chk
    CHECK (state IN ('ACTIVE', 'REVOKED')),
  CONSTRAINT change_set_evidence_issuers_revocation_chk
    CHECK (
      (state = 'ACTIVE' AND revoked_at IS NULL)
      OR (state = 'REVOKED' AND revoked_at IS NOT NULL)
    )
);

CREATE TABLE public.change_set_evidence_signing_keys (
  issuer_id text NOT NULL,
  key_id text NOT NULL,
  algorithm text NOT NULL,
  public_key_spki_base64 text NOT NULL,
  public_key_fingerprint_sha256 text NOT NULL,
  opaque_signing_key_ref text NOT NULL,
  state text DEFAULT 'PENDING' NOT NULL,
  valid_from timestamp with time zone NOT NULL,
  sign_until timestamp with time zone NOT NULL,
  verify_until timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  revoked_at timestamp with time zone,
  CONSTRAINT change_set_evidence_signing_keys_pk PRIMARY KEY (issuer_id, key_id),
  CONSTRAINT change_set_evidence_signing_keys_issuer_fk
    FOREIGN KEY (issuer_id) REFERENCES public.change_set_evidence_issuers(id) ON DELETE RESTRICT,
  CONSTRAINT change_set_evidence_signing_keys_identity_chk
    CHECK (key_id ~ '^[a-z][a-z0-9._:-]{2,95}$'),
  CONSTRAINT change_set_evidence_signing_keys_algorithm_chk
    CHECK (algorithm = 'Ed25519'),
  CONSTRAINT change_set_evidence_signing_keys_fingerprint_chk
    CHECK (public_key_fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT change_set_evidence_signing_keys_state_chk
    CHECK (state IN ('PENDING', 'ACTIVE', 'VERIFY_ONLY', 'REVOKED', 'COMPROMISED')),
  CONSTRAINT change_set_evidence_signing_keys_window_chk
    CHECK (sign_until > valid_from AND verify_until >= sign_until),
  CONSTRAINT change_set_evidence_signing_keys_revocation_chk
    CHECK (
      (state IN ('PENDING', 'ACTIVE', 'VERIFY_ONLY') AND revoked_at IS NULL)
      OR (state IN ('REVOKED', 'COMPROMISED') AND revoked_at IS NOT NULL)
    )
);

CREATE TABLE public.change_set_evidence_issuer_tenant_grants (
  id uuid PRIMARY KEY NOT NULL,
  tenant_id uuid NOT NULL,
  issuer_id text NOT NULL,
  kind text NOT NULL,
  tool_id text NOT NULL,
  tool_version text NOT NULL,
  state text DEFAULT 'ACTIVE' NOT NULL,
  valid_from timestamp with time zone NOT NULL,
  valid_until timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  revoked_at timestamp with time zone,
  CONSTRAINT change_set_evidence_issuer_tenant_grants_tenant_id_id_uq
    UNIQUE (tenant_id, id),
  CONSTRAINT change_set_evidence_issuer_tenant_grants_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT change_set_evidence_issuer_tenant_grants_issuer_fk
    FOREIGN KEY (issuer_id) REFERENCES public.change_set_evidence_issuers(id) ON DELETE RESTRICT,
  CONSTRAINT change_set_evidence_issuer_tenant_grants_id_uuidv7_chk
    CHECK (substring(id::text from 15 for 1) = '7'),
  CONSTRAINT change_set_evidence_issuer_tenant_grants_kind_chk
    CHECK (kind IN ('VALIDATION', 'SIMULATION', 'TEST_ARTIFACT', 'ROLLBACK_PLAN', 'CANARY_PLAN')),
  CONSTRAINT change_set_evidence_issuer_tenant_grants_tool_chk
    CHECK (
      tool_id ~ '^[a-z][a-z0-9._:-]{2,95}$'
      AND tool_version ~ '^[a-z][a-z0-9._:-]{2,95}$'
    ),
  CONSTRAINT change_set_evidence_issuer_tenant_grants_state_chk
    CHECK (state IN ('ACTIVE', 'REVOKED')),
  CONSTRAINT change_set_evidence_issuer_tenant_grants_window_chk
    CHECK (valid_until IS NULL OR valid_until > valid_from),
  CONSTRAINT change_set_evidence_issuer_tenant_grants_revocation_chk
    CHECK (
      (state = 'ACTIVE' AND revoked_at IS NULL)
      OR (state = 'REVOKED' AND revoked_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX change_set_evidence_issuer_tenant_grants_active_uidx
  ON public.change_set_evidence_issuer_tenant_grants
  (tenant_id, issuer_id, kind, tool_id, tool_version)
  WHERE state = 'ACTIVE';

CREATE TABLE public.change_set_evidence_requests (
  id uuid PRIMARY KEY NOT NULL,
  tenant_id uuid NOT NULL,
  change_set_id uuid NOT NULL,
  target_state text NOT NULL,
  kind text NOT NULL,
  challenge_nonce_hash text NOT NULL,
  requested_by_principal_id uuid NOT NULL,
  requested_by_membership_id uuid NOT NULL,
  subject_hash text NOT NULL,
  policy_version_id uuid NOT NULL,
  tool_id text NOT NULL,
  tool_version text NOT NULL,
  state text DEFAULT 'OPEN' NOT NULL,
  issued_receipt_id uuid,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  closed_at timestamp with time zone,
  CONSTRAINT change_set_evidence_requests_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT change_set_evidence_requests_tenant_receipt_uq UNIQUE (tenant_id, issued_receipt_id),
  CONSTRAINT change_set_evidence_requests_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT change_set_evidence_requests_change_set_fk
    FOREIGN KEY (tenant_id, change_set_id)
    REFERENCES public.change_sets(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT change_set_evidence_requests_requester_membership_fk
    FOREIGN KEY (tenant_id, requested_by_membership_id, requested_by_principal_id)
    REFERENCES public.memberships(tenant_id, id, principal_id) ON DELETE RESTRICT,
  CONSTRAINT change_set_evidence_requests_policy_version_fk
    FOREIGN KEY (tenant_id, policy_version_id)
    REFERENCES public.policy_versions(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT change_set_evidence_requests_id_uuidv7_chk
    CHECK (substring(id::text from 15 for 1) = '7'),
  CONSTRAINT change_set_evidence_requests_target_state_chk
    CHECK (target_state IN ('VALIDATED', 'SIMULATED', 'IN_REVIEW')),
  CONSTRAINT change_set_evidence_requests_kind_chk
    CHECK (kind IN ('VALIDATION', 'SIMULATION', 'TEST_ARTIFACT', 'ROLLBACK_PLAN', 'CANARY_PLAN')),
  CONSTRAINT change_set_evidence_requests_hashes_chk
    CHECK (challenge_nonce_hash ~ '^[0-9a-f]{64}$' AND subject_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT change_set_evidence_requests_tool_chk
    CHECK (
      tool_id ~ '^[a-z][a-z0-9._:-]{2,95}$'
      AND tool_version ~ '^[a-z][a-z0-9._:-]{2,95}$'
    ),
  CONSTRAINT change_set_evidence_requests_state_chk
    CHECK (state IN ('OPEN', 'ISSUED', 'EXPIRED', 'REVOKED')),
  CONSTRAINT change_set_evidence_requests_state_receipt_chk
    CHECK ((state = 'ISSUED') = (issued_receipt_id IS NOT NULL)),
  CONSTRAINT change_set_evidence_requests_window_chk
    CHECK (expires_at > created_at)
);

CREATE INDEX change_set_evidence_requests_lookup_idx
  ON public.change_set_evidence_requests
  (tenant_id, change_set_id, target_state, kind, state);

ALTER TABLE public.change_set_evidence_receipts
  ADD COLUMN issuer_principal_id uuid NOT NULL,
  ADD COLUMN signing_key_id text NOT NULL,
  ADD COLUMN algorithm text NOT NULL,
  ADD COLUMN schema_version integer NOT NULL,
  ADD COLUMN audience text NOT NULL,
  ADD COLUMN environment_id text NOT NULL,
  ADD COLUMN cell_id text NOT NULL,
  ADD COLUMN evidence_request_id uuid NOT NULL,
  ADD COLUMN challenge_nonce_hash text NOT NULL,
  ADD COLUMN tool_id text NOT NULL,
  ADD COLUMN artifact_manifest_hash text,
  ADD COLUMN signed_claims_hash text NOT NULL,
  ADD COLUMN signature_base64url text NOT NULL,
  ADD CONSTRAINT change_set_evidence_receipts_issuer_principal_fk
    FOREIGN KEY (issuer_principal_id) REFERENCES public.principals(id) ON DELETE RESTRICT,
  ADD CONSTRAINT change_set_evidence_receipts_signing_key_fk
    FOREIGN KEY (issuer, signing_key_id)
    REFERENCES public.change_set_evidence_signing_keys(issuer_id, key_id) ON DELETE RESTRICT,
  ADD CONSTRAINT change_set_evidence_receipts_request_fk
    FOREIGN KEY (tenant_id, evidence_request_id)
    REFERENCES public.change_set_evidence_requests(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT change_set_evidence_receipts_envelope_identity_chk
    CHECK (
      schema_version = 1
      AND audience = 'fas.change-set.transition'
      AND algorithm = 'Ed25519'
      AND environment_id ~ '^[a-z][a-z0-9._:-]{2,95}$'
      AND cell_id ~ '^[a-z][a-z0-9._:-]{2,95}$'
      AND tool_id ~ '^[a-z][a-z0-9._:-]{2,95}$'
      AND tool_version ~ '^[a-z][a-z0-9._:-]{2,95}$'
    ),
  ADD CONSTRAINT change_set_evidence_receipts_signed_hashes_chk
    CHECK (
      challenge_nonce_hash ~ '^[0-9a-f]{64}$'
      AND signed_claims_hash ~ '^[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT change_set_evidence_receipts_signature_chk
    CHECK (signature_base64url ~ '^[A-Za-z0-9_-]{86}$'),
  DROP CONSTRAINT change_set_evidence_receipts_artifact_count_chk,
  ADD CONSTRAINT change_set_evidence_receipts_artifact_count_chk
    CHECK (
      (
        kind = 'TEST_ARTIFACT'
        AND artifact_count IS NOT NULL
        AND artifact_count > 0
        AND artifact_manifest_hash ~ '^[0-9a-f]{64}$'
      )
      OR (
        kind <> 'TEST_ARTIFACT'
        AND artifact_count IS NULL
        AND artifact_manifest_hash IS NULL
      )
    );

CREATE TABLE public.change_set_command_audit_events (
  id uuid PRIMARY KEY NOT NULL,
  tenant_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  sequence integer NOT NULL,
  context_id uuid NOT NULL,
  actor_principal_id uuid NOT NULL,
  actor_membership_id uuid NOT NULL,
  change_set_id uuid,
  command_type text NOT NULL,
  target_state text,
  capability text NOT NULL,
  policy_version_id uuid,
  phase text NOT NULL,
  outcome text NOT NULL,
  reason_code text NOT NULL,
  idempotency_key_fingerprint text NOT NULL,
  request_fingerprint text NOT NULL,
  fingerprint_key_id text NOT NULL,
  previous_hash text,
  event_hash text NOT NULL,
  occurred_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT change_set_command_audit_events_attempt_sequence_uq
    UNIQUE (tenant_id, attempt_id, sequence),
  CONSTRAINT change_set_command_audit_events_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT,
  CONSTRAINT change_set_command_audit_events_id_uuidv7_chk
    CHECK (substring(id::text from 15 for 1) = '7'),
  CONSTRAINT change_set_command_audit_events_attempt_uuidv7_chk
    CHECK (substring(attempt_id::text from 15 for 1) = '7'),
  CONSTRAINT change_set_command_audit_events_context_uuidv7_chk
    CHECK (substring(context_id::text from 15 for 1) = '7'),
  CONSTRAINT change_set_command_audit_events_sequence_chk CHECK (sequence > 0),
  CONSTRAINT change_set_command_audit_events_command_chk
    CHECK (
      command_type IN ('CREATE', 'TRANSITION')
      AND (
        (command_type = 'CREATE' AND target_state IS NULL)
        OR (
          command_type = 'TRANSITION'
          AND target_state IS NOT NULL
          AND target_state IN ('VALIDATED', 'SIMULATED', 'IN_REVIEW')
        )
      )
    ),
  CONSTRAINT change_set_command_audit_events_capability_chk
    CHECK (capability ~ '^[a-z][a-z0-9._:-]{2,95}$'),
  CONSTRAINT change_set_command_audit_events_phase_chk
    CHECK (phase IN ('ATTEMPT_STARTED', 'AUTHORIZATION', 'CLAIM', 'EVIDENCE', 'MUTATION', 'COMMIT', 'TERMINAL')),
  CONSTRAINT change_set_command_audit_events_outcome_chk
    CHECK (outcome IN ('STARTED', 'ALLOW', 'DENY', 'REJECT', 'CONFLICT', 'ERROR', 'SUCCESS')),
  CONSTRAINT change_set_command_audit_events_reason_chk
    CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT change_set_command_audit_events_hashes_chk
    CHECK (
      idempotency_key_fingerprint ~ '^[0-9a-f]{64}$'
      AND request_fingerprint ~ '^[0-9a-f]{64}$'
      AND event_hash ~ '^[0-9a-f]{64}$'
      AND (previous_hash IS NULL OR previous_hash ~ '^[0-9a-f]{64}$')
    ),
  CONSTRAINT change_set_command_audit_events_key_id_chk
    CHECK (fingerprint_key_id ~ '^[a-z][a-z0-9._:-]{2,95}$')
);

CREATE INDEX change_set_command_audit_events_actor_idx
  ON public.change_set_command_audit_events (tenant_id, actor_principal_id, occurred_at);
CREATE INDEX change_set_command_audit_events_change_set_idx
  ON public.change_set_command_audit_events (tenant_id, change_set_id, occurred_at);

ALTER TABLE public.change_set_evidence_issuer_tenant_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.change_set_evidence_issuer_tenant_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE public.change_set_evidence_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.change_set_evidence_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.change_set_command_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.change_set_command_audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY change_set_evidence_issuer_tenant_grants_select_same_tenant
  ON public.change_set_evidence_issuer_tenant_grants FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY change_set_evidence_issuer_tenant_grants_insert_same_tenant
  ON public.change_set_evidence_issuer_tenant_grants FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY change_set_evidence_issuer_tenant_grants_update_same_tenant
  ON public.change_set_evidence_issuer_tenant_grants FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY change_set_evidence_requests_select_same_tenant
  ON public.change_set_evidence_requests FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY change_set_evidence_requests_insert_same_tenant
  ON public.change_set_evidence_requests FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY change_set_evidence_requests_update_same_tenant
  ON public.change_set_evidence_requests FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY change_set_command_audit_events_select_same_tenant
  ON public.change_set_command_audit_events FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY change_set_command_audit_events_insert_same_tenant
  ON public.change_set_command_audit_events FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE FUNCTION public.guard_change_set_evidence_issuer_update() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.principal_id <> OLD.principal_id
    OR NEW.environment_id <> OLD.environment_id
    OR NEW.cell_id <> OLD.cell_id
    OR NEW.created_at <> OLD.created_at
    OR OLD.state <> 'ACTIVE'
    OR NEW.state <> 'REVOKED'
  THEN
    RAISE EXCEPTION 'evidence issuer identity is immutable and can only be revoked';
  END IF;
  NEW.revoked_at := statement_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.guard_change_set_evidence_signing_key_update() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF NEW.issuer_id <> OLD.issuer_id
    OR NEW.key_id <> OLD.key_id
    OR NEW.algorithm <> OLD.algorithm
    OR NEW.public_key_spki_base64 <> OLD.public_key_spki_base64
    OR NEW.public_key_fingerprint_sha256 <> OLD.public_key_fingerprint_sha256
    OR NEW.opaque_signing_key_ref <> OLD.opaque_signing_key_ref
    OR NEW.valid_from <> OLD.valid_from
    OR NEW.sign_until <> OLD.sign_until
    OR NEW.verify_until <> OLD.verify_until
    OR NEW.created_at <> OLD.created_at
    OR NOT (
      (OLD.state = 'PENDING' AND NEW.state IN ('ACTIVE', 'REVOKED', 'COMPROMISED'))
      OR (OLD.state = 'ACTIVE' AND NEW.state IN ('VERIFY_ONLY', 'REVOKED', 'COMPROMISED'))
      OR (OLD.state = 'VERIFY_ONLY' AND NEW.state IN ('REVOKED', 'COMPROMISED'))
    )
  THEN
    RAISE EXCEPTION 'evidence signing key material and lifecycle are immutable';
  END IF;
  IF NEW.state IN ('REVOKED', 'COMPROMISED') THEN
    NEW.revoked_at := statement_timestamp();
  ELSE
    NEW.revoked_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.guard_change_set_evidence_tenant_grant_update() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.issuer_id <> OLD.issuer_id
    OR NEW.kind <> OLD.kind
    OR NEW.tool_id <> OLD.tool_id
    OR NEW.tool_version <> OLD.tool_version
    OR NEW.valid_from <> OLD.valid_from
    OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
    OR NEW.created_at <> OLD.created_at
    OR OLD.state <> 'ACTIVE'
    OR NEW.state <> 'REVOKED'
  THEN
    RAISE EXCEPTION 'evidence tenant grant identity is immutable and can only be revoked';
  END IF;
  NEW.revoked_at := statement_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.guard_change_set_evidence_request_initial() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF NEW.state <> 'OPEN'
    OR NEW.issued_receipt_id IS NOT NULL
    OR NEW.closed_at IS NOT NULL
    OR NEW.expires_at <= statement_timestamp()
  THEN
    RAISE EXCEPTION 'evidence request must start as an unbound future OPEN request';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.bind_change_set_signed_evidence() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  request_row public.change_set_evidence_requests%ROWTYPE;
BEGIN
  IF NEW.issued_at > statement_timestamp() + interval '30 seconds'
    OR NEW.expires_at <= statement_timestamp()
  THEN
    RAISE EXCEPTION 'signed evidence is outside its accepted database time window';
  END IF;

  SELECT * INTO request_row
  FROM public.change_set_evidence_requests request
  WHERE request.tenant_id = NEW.tenant_id
    AND request.id = NEW.evidence_request_id
  FOR UPDATE;

  IF NOT FOUND
    OR request_row.state <> 'OPEN'
    OR request_row.expires_at <= statement_timestamp()
    OR NEW.issued_at < request_row.created_at
    OR NEW.issued_at >= request_row.expires_at
    OR request_row.change_set_id <> NEW.change_set_id
    OR request_row.target_state <> NEW.target_state
    OR request_row.kind <> NEW.kind
    OR request_row.challenge_nonce_hash <> NEW.challenge_nonce_hash
    OR request_row.requested_by_principal_id <> NEW.requested_by_principal_id
    OR request_row.requested_by_membership_id <> NEW.requested_by_membership_id
    OR request_row.subject_hash <> NEW.subject_hash
    OR request_row.policy_version_id <> NEW.policy_version_id
    OR request_row.tool_id <> NEW.tool_id
    OR request_row.tool_version <> NEW.tool_version
  THEN
    RAISE EXCEPTION 'signed evidence does not match its single-use request';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.change_set_evidence_issuers issuer
    JOIN public.change_set_evidence_signing_keys signing_key
      ON signing_key.issuer_id = issuer.id
    WHERE issuer.id = NEW.issuer
      AND issuer.principal_id = NEW.issuer_principal_id
      AND issuer.environment_id = NEW.environment_id
      AND issuer.cell_id = NEW.cell_id
      AND issuer.state = 'ACTIVE'
      AND signing_key.key_id = NEW.signing_key_id
      AND signing_key.algorithm = NEW.algorithm
      AND signing_key.state = 'ACTIVE'
      AND signing_key.valid_from <= NEW.issued_at
      AND signing_key.sign_until >= NEW.issued_at
  ) THEN
    RAISE EXCEPTION 'signed evidence issuer or signing key is not active';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.change_set_evidence_issuer_tenant_grants tenant_grant
    WHERE tenant_grant.tenant_id = NEW.tenant_id
      AND tenant_grant.issuer_id = NEW.issuer
      AND tenant_grant.kind = NEW.kind
      AND tenant_grant.tool_id = NEW.tool_id
      AND tenant_grant.tool_version = NEW.tool_version
      AND tenant_grant.state = 'ACTIVE'
      AND tenant_grant.valid_from <= NEW.issued_at
      AND (tenant_grant.valid_until IS NULL OR tenant_grant.valid_until > NEW.issued_at)
  ) THEN
    RAISE EXCEPTION 'signed evidence issuer has no active tenant grant';
  END IF;

  UPDATE public.change_set_evidence_requests
  SET state = 'ISSUED', issued_receipt_id = NEW.id, closed_at = statement_timestamp()
  WHERE tenant_id = NEW.tenant_id AND id = NEW.evidence_request_id;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.guard_change_set_signed_evidence_identity() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF NEW.issuer_principal_id <> OLD.issuer_principal_id
    OR NEW.signing_key_id <> OLD.signing_key_id
    OR NEW.algorithm <> OLD.algorithm
    OR NEW.schema_version <> OLD.schema_version
    OR NEW.audience <> OLD.audience
    OR NEW.environment_id <> OLD.environment_id
    OR NEW.cell_id <> OLD.cell_id
    OR NEW.evidence_request_id <> OLD.evidence_request_id
    OR NEW.challenge_nonce_hash <> OLD.challenge_nonce_hash
    OR NEW.tool_id <> OLD.tool_id
    OR NEW.artifact_manifest_hash IS DISTINCT FROM OLD.artifact_manifest_hash
    OR NEW.signed_claims_hash <> OLD.signed_claims_hash
    OR NEW.signature_base64url <> OLD.signature_base64url
  THEN
    RAISE EXCEPTION 'signed evidence envelope identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.guard_change_set_evidence_request_update() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.change_set_id <> OLD.change_set_id
    OR NEW.target_state <> OLD.target_state
    OR NEW.kind <> OLD.kind
    OR NEW.challenge_nonce_hash <> OLD.challenge_nonce_hash
    OR NEW.requested_by_principal_id <> OLD.requested_by_principal_id
    OR NEW.requested_by_membership_id <> OLD.requested_by_membership_id
    OR NEW.subject_hash <> OLD.subject_hash
    OR NEW.policy_version_id <> OLD.policy_version_id
    OR NEW.tool_id <> OLD.tool_id
    OR NEW.tool_version <> OLD.tool_version
    OR NEW.expires_at <> OLD.expires_at
    OR NEW.created_at <> OLD.created_at
    OR OLD.state <> 'OPEN'
    OR NEW.state NOT IN ('ISSUED', 'EXPIRED', 'REVOKED')
  THEN
    RAISE EXCEPTION 'evidence request identity is immutable and closes once';
  END IF;
  IF NEW.state = 'ISSUED' AND (
    NEW.issued_receipt_id IS NULL OR NEW.closed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'issued evidence request requires its receipt and close time';
  END IF;
  IF NEW.state IN ('EXPIRED', 'REVOKED') AND (
    NEW.issued_receipt_id IS NOT NULL OR NEW.closed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'closed unissued evidence request cannot bind a receipt';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.enforce_change_set_evidence_request_finalization() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF NEW.state = 'ISSUED' AND NOT EXISTS (
    SELECT 1
    FROM public.change_set_evidence_receipts receipt
    WHERE receipt.tenant_id = NEW.tenant_id
      AND receipt.id = NEW.issued_receipt_id
      AND receipt.evidence_request_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'issued evidence request requires its exact signed receipt';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.enforce_change_set_command_audit_chain() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  prior_sequence integer;
  prior_hash text;
BEGIN
  NEW.occurred_at := statement_timestamp();
  -- The audit table intentionally has no UPDATE policy. Serialize each
  -- tenant/attempt chain without requiring row-update visibility or DML.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(NEW.tenant_id::text || ':' || NEW.attempt_id::text, 0)
  );
  SELECT sequence, event_hash INTO prior_sequence, prior_hash
  FROM public.change_set_command_audit_events
  WHERE tenant_id = NEW.tenant_id AND attempt_id = NEW.attempt_id
  ORDER BY sequence DESC
  LIMIT 1;

  IF prior_sequence IS NULL THEN
    IF NEW.sequence <> 1 OR NEW.previous_hash IS NOT NULL OR NEW.phase <> 'ATTEMPT_STARTED' THEN
      RAISE EXCEPTION 'audit chain must begin with ATTEMPT_STARTED at sequence one';
    END IF;
  ELSIF NEW.sequence <> prior_sequence + 1 OR NEW.previous_hash IS DISTINCT FROM prior_hash THEN
    RAISE EXCEPTION 'audit event sequence or previous hash mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER change_set_evidence_receipts_bind_signed
  BEFORE INSERT ON public.change_set_evidence_receipts
  FOR EACH ROW EXECUTE FUNCTION public.bind_change_set_signed_evidence();
CREATE TRIGGER change_set_evidence_receipts_guard_signed_identity
  BEFORE UPDATE ON public.change_set_evidence_receipts
  FOR EACH ROW EXECUTE FUNCTION public.guard_change_set_signed_evidence_identity();
CREATE TRIGGER change_set_evidence_requests_guard_update
  BEFORE UPDATE ON public.change_set_evidence_requests
  FOR EACH ROW EXECUTE FUNCTION public.guard_change_set_evidence_request_update();
CREATE TRIGGER change_set_evidence_requests_guard_initial
  BEFORE INSERT ON public.change_set_evidence_requests
  FOR EACH ROW EXECUTE FUNCTION public.guard_change_set_evidence_request_initial();
CREATE CONSTRAINT TRIGGER change_set_evidence_requests_require_signed_receipt
  AFTER UPDATE ON public.change_set_evidence_requests
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.enforce_change_set_evidence_request_finalization();
CREATE TRIGGER change_set_evidence_requests_immutable_delete
  BEFORE DELETE ON public.change_set_evidence_requests
  FOR EACH ROW EXECUTE FUNCTION public.prevent_authorization_receipt_mutation();
CREATE TRIGGER change_set_command_audit_events_chain
  BEFORE INSERT ON public.change_set_command_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_change_set_command_audit_chain();
CREATE TRIGGER change_set_command_audit_events_immutable
  BEFORE UPDATE OR DELETE ON public.change_set_command_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.prevent_authorization_receipt_mutation();
CREATE TRIGGER change_set_evidence_issuers_guard_update
  BEFORE UPDATE ON public.change_set_evidence_issuers
  FOR EACH ROW EXECUTE FUNCTION public.guard_change_set_evidence_issuer_update();
CREATE TRIGGER change_set_evidence_issuers_immutable_delete
  BEFORE DELETE ON public.change_set_evidence_issuers
  FOR EACH ROW EXECUTE FUNCTION public.prevent_authorization_receipt_mutation();
CREATE TRIGGER change_set_evidence_signing_keys_guard_update
  BEFORE UPDATE ON public.change_set_evidence_signing_keys
  FOR EACH ROW EXECUTE FUNCTION public.guard_change_set_evidence_signing_key_update();
CREATE TRIGGER change_set_evidence_signing_keys_immutable_delete
  BEFORE DELETE ON public.change_set_evidence_signing_keys
  FOR EACH ROW EXECUTE FUNCTION public.prevent_authorization_receipt_mutation();
CREATE TRIGGER change_set_evidence_issuer_tenant_grants_guard_update
  BEFORE UPDATE ON public.change_set_evidence_issuer_tenant_grants
  FOR EACH ROW EXECUTE FUNCTION public.guard_change_set_evidence_tenant_grant_update();
CREATE TRIGGER change_set_evidence_issuer_tenant_grants_immutable_delete
  BEFORE DELETE ON public.change_set_evidence_issuer_tenant_grants
  FOR EACH ROW EXECUTE FUNCTION public.prevent_authorization_receipt_mutation();

REVOKE ALL ON TABLE public.change_set_evidence_issuers FROM PUBLIC;
REVOKE ALL ON TABLE public.change_set_evidence_signing_keys FROM PUBLIC;
REVOKE ALL ON TABLE public.change_set_evidence_issuer_tenant_grants FROM PUBLIC;
REVOKE ALL ON TABLE public.change_set_evidence_requests FROM PUBLIC;
REVOKE ALL ON TABLE public.change_set_command_audit_events FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bind_change_set_signed_evidence() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_change_set_evidence_issuer_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_change_set_evidence_signing_key_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_change_set_evidence_tenant_grant_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_change_set_evidence_request_initial() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_change_set_evidence_request_finalization() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_change_set_signed_evidence_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_change_set_evidence_request_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_change_set_command_audit_chain() FROM PUBLIC;
