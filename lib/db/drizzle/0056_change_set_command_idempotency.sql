-- Additive, default-unwired idempotency ledger for ChangeSet commands.
-- Raw idempotency keys are never stored; only SHA-256 hashes are persisted.

CREATE TABLE "change_set_command_receipts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL,
  "idempotency_key_hash" text NOT NULL,
  "request_hash" text NOT NULL,
  "context_id" uuid NOT NULL,
  "actor_principal_id" uuid NOT NULL,
  "command_type" text NOT NULL,
  "change_set_id" uuid,
  "status" text DEFAULT 'CLAIMED' NOT NULL,
  "result" jsonb,
  "result_hash" text,
  "version" bigint DEFAULT 1 NOT NULL,
  "claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "change_set_command_receipts_tenant_key_uq" UNIQUE ("tenant_id", "idempotency_key_hash"),
  CONSTRAINT "change_set_command_receipts_id_uuidv7_chk" CHECK (substring("id"::text from 15 for 1) = '7'),
  CONSTRAINT "change_set_command_receipts_context_uuidv7_chk" CHECK (substring("context_id"::text from 15 for 1) = '7'),
  CONSTRAINT "change_set_command_receipts_hashes_chk" CHECK (
    "idempotency_key_hash" ~ '^[0-9a-f]{64}$'
    AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND ("result_hash" IS NULL OR "result_hash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "change_set_command_receipts_type_chk" CHECK ("command_type" IN ('CREATE', 'TRANSITION')),
  CONSTRAINT "change_set_command_receipts_status_chk" CHECK ("status" IN ('CLAIMED', 'COMPLETED')),
  CONSTRAINT "change_set_command_receipts_version_chk" CHECK ("version" > 0),
  CONSTRAINT "change_set_command_receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
  CONSTRAINT "change_set_command_receipts_actor_principal_id_principals_id_fk" FOREIGN KEY ("actor_principal_id") REFERENCES "principals"("id") ON DELETE RESTRICT,
  CONSTRAINT "change_set_command_receipts_tenant_change_set_fk" FOREIGN KEY ("tenant_id", "change_set_id") REFERENCES "change_sets"("tenant_id", "id") ON DELETE RESTRICT
);

CREATE INDEX "change_set_command_receipts_change_set_idx"
  ON "change_set_command_receipts" ("tenant_id", "change_set_id", "claimed_at");

ALTER TABLE "change_set_command_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "change_set_command_receipts" FORCE ROW LEVEL SECURITY;

CREATE POLICY "change_set_command_receipts_select_same_tenant"
  ON "change_set_command_receipts" FOR SELECT
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "change_set_command_receipts_insert_same_tenant"
  ON "change_set_command_receipts" FOR INSERT
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY "change_set_command_receipts_update_same_tenant"
  ON "change_set_command_receipts" FOR UPDATE
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE FUNCTION "enforce_change_set_command_initial_claim"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" <> 'CLAIMED'
    OR NEW."version" <> 1
    OR NEW."result" IS NOT NULL
    OR NEW."result_hash" IS NOT NULL
    OR NEW."completed_at" IS NOT NULL
  THEN
    RAISE EXCEPTION 'change set command must start as a clean claim';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "change_set_command_receipts_guard_initial_claim"
  BEFORE INSERT ON "change_set_command_receipts"
  FOR EACH ROW EXECUTE FUNCTION "enforce_change_set_command_initial_claim"();

CREATE FUNCTION "enforce_change_set_command_completion"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" <> 'CLAIMED' OR NEW."status" <> 'COMPLETED' THEN
    RAISE EXCEPTION 'change set command receipt permits only CLAIMED to COMPLETED';
  END IF;
  IF NEW."id" <> OLD."id"
    OR NEW."tenant_id" <> OLD."tenant_id"
    OR NEW."idempotency_key_hash" <> OLD."idempotency_key_hash"
    OR NEW."request_hash" <> OLD."request_hash"
    OR NEW."context_id" <> OLD."context_id"
    OR NEW."actor_principal_id" <> OLD."actor_principal_id"
    OR NEW."command_type" <> OLD."command_type"
    OR NEW."claimed_at" <> OLD."claimed_at"
    OR (OLD."change_set_id" IS NOT NULL AND NEW."change_set_id" IS DISTINCT FROM OLD."change_set_id")
  THEN
    RAISE EXCEPTION 'change set command claim identity is immutable';
  END IF;
  IF NEW."change_set_id" IS NULL
    OR NEW."result" IS NULL
    OR NEW."result_hash" IS NULL
    OR NEW."completed_at" IS NULL
    OR NEW."completed_at" < OLD."claimed_at"
    OR NEW."version" <> OLD."version" + 1
  THEN
    RAISE EXCEPTION 'change set command completion evidence is incomplete';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "change_set_command_receipts_guard_completion"
  BEFORE UPDATE ON "change_set_command_receipts"
  FOR EACH ROW EXECUTE FUNCTION "enforce_change_set_command_completion"();

CREATE TRIGGER "change_set_command_receipts_immutable_delete"
  BEFORE DELETE ON "change_set_command_receipts"
  FOR EACH ROW EXECUTE FUNCTION "prevent_authorization_receipt_mutation"();
