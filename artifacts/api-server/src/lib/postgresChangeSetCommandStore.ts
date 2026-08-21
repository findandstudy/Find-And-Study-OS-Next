import crypto from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  AccessDecisionReceiptInsert,
  AuthoritativeR1Configuration,
  ChangeSetApprovalInsert,
  ChangeSetCommandClaim,
  ChangeSetCommandClaimResult,
  ChangeSetCommandStore,
  ChangeSetCommandSuccess,
  ChangeSetCommandTransaction,
  ChangeSetCommandAttemptReceiptInsert,
  ChangeSetTransitionReceiptInsert,
  MutationAssurance,
  StoredR1ChangeSet,
  VerifiedTransitionEvidence,
} from "./changeSetCommand";
import {
  verifyChangeSetEvidenceEnvelope,
  type ChangeSetEvidenceTenantGrant,
  type ChangeSetEvidenceVerificationKey,
} from "./changeSetEvidenceEnvelope";
import type {
  ResolvedActiveContextState,
  VerifiedActiveTenantContext,
} from "./activeTenantContext";
import type { ChangeSetScope, ChangeSetState } from "./changeSetPolicy";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER_RE = /^[a-z][a-z0-9._:-]{2,95}$/;
const ROLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;

type RpcRow = QueryResultRow & { result: unknown };

type EvidenceRpcRow = {
  signedClaimsCanonical: string;
  signatureBase64Url: string;
  publicKeySpkiBase64: string;
  publicKeyFingerprintSha256: string;
  issuerId: string;
  issuerPrincipalId: string;
  issuerEnvironmentId: string;
  issuerCellId: string;
  issuerState: "ACTIVE" | "REVOKED";
  keyId: string;
  keyAlgorithm: "Ed25519";
  keyState: "ACTIVE" | "VERIFY_ONLY" | "REVOKED" | "COMPROMISED";
  keyValidFrom: number;
  keySignUntil: number;
  keyVerifyUntil: number;
  grantId: string;
  grantTenantId: string;
  grantKind: ChangeSetEvidenceTenantGrant["kind"];
  grantToolId: string;
  grantToolVersion: string;
  grantState: "ACTIVE" | "REVOKED";
  grantValidFrom: number;
  grantValidUntil: number | null;
};

export type PostgresMutationAssuranceResolver = (input: {
  context: VerifiedActiveTenantContext;
  client: PoolClient;
  now: number;
}) => Promise<MutationAssurance>;

export type PostgresChangeSetCommandStoreOptions = {
  pool: Pool;
  expectedRole: string;
  expectedEnvironmentId: string;
  expectedCellId: string;
  resolveMutationAssurance: PostgresMutationAssuranceResolver;
  now?: () => number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asFiniteTimestamp(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function validAssurance(value: unknown): value is MutationAssurance {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort().join("\0");
  return (
    keys ===
      ["impersonating", "stepUpReceiptId", "stepUpSatisfied"]
        .sort()
        .join("\0") &&
    typeof value.impersonating === "boolean" &&
    typeof value.stepUpSatisfied === "boolean" &&
    (value.stepUpReceiptId === null ||
      (typeof value.stepUpReceiptId === "string" &&
        UUID_RE.test(value.stepUpReceiptId))) &&
    (!value.stepUpSatisfied || value.stepUpReceiptId !== null)
  );
}

function rpcResult<T>(value: unknown): T {
  if (value === undefined) throw new Error("change_set_rpc_missing_result");
  return value as T;
}

function normalizeScope(scope: ChangeSetScope) {
  return {
    scopeType: scope.type,
    organizationId: scope.organizationId,
    legacyBranchId: scope.legacyBranchId,
  };
}

class PostgresChangeSetCommandTransaction
  implements ChangeSetCommandTransaction
{
  private tenantId: string | null = null;

  constructor(
    private readonly client: PoolClient,
    private readonly options: Omit<PostgresChangeSetCommandStoreOptions, "pool">,
  ) {}

  private requireTenant(tenantId: string) {
    if (this.tenantId !== tenantId) {
      throw new Error("change_set_transaction_tenant_mismatch");
    }
  }

  private async rpc<T>(name: string, values: readonly unknown[]): Promise<T> {
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(name)) {
      throw new Error("change_set_rpc_name_invalid");
    }
    const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");
    const result = await this.client.query<RpcRow>(
      `SELECT fas_cp_v1.${name}(${placeholders}) AS result`,
      [...values],
    );
    if (result.rowCount !== 1) throw new Error("change_set_rpc_cardinality");
    return rpcResult<T>(result.rows[0]?.result);
  }

  async setLocalTenant(tenantId: string): Promise<void> {
    if (!UUID_RE.test(tenantId)) throw new Error("invalid_tenant_id");
    if (this.tenantId !== null && this.tenantId !== tenantId) {
      throw new Error("change_set_transaction_tenant_rebind");
    }
    const result = await this.client.query<{ tenant_id: string }>(
      `SELECT set_config('app.tenant_id', $1, true) AS tenant_id`,
      [tenantId],
    );
    if (result.rows[0]?.tenant_id !== tenantId) {
      throw new Error("change_set_transaction_tenant_not_set");
    }
    this.tenantId = tenantId;
  }

  async loadAuthoritativeR1ConfigurationForUpdate(input: {
    tenantId: string;
    changeType: string;
    configurationKey: string;
    targetScope: ChangeSetScope;
  }): Promise<AuthoritativeR1Configuration | null> {
    this.requireTenant(input.tenantId);
    return this.rpc<AuthoritativeR1Configuration | null>(
      "load_authoritative_configuration",
      [
        input.tenantId,
        input.changeType,
        input.configurationKey,
        JSON.stringify(normalizeScope(input.targetScope)),
      ],
    );
  }

  async resolveActiveContextStateForUpdate(
    context: VerifiedActiveTenantContext,
  ): Promise<ResolvedActiveContextState> {
    this.requireTenant(context.tenantId);
    return this.rpc<ResolvedActiveContextState>("resolve_active_context", [
      context.tenantId,
      context.principalId,
      context.membershipId,
      context.policyVersionId,
      context.assignmentIds,
    ]);
  }

  async resolveMutationAssuranceForUpdate(
    context: VerifiedActiveTenantContext,
  ): Promise<MutationAssurance> {
    this.requireTenant(context.tenantId);
    const now = this.options.now?.() ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("change_set_assurance_clock_invalid");
    }
    const assurance = await this.options.resolveMutationAssurance({
      context,
      client: this.client,
      now,
    });
    if (!validAssurance(assurance)) {
      throw new Error("change_set_assurance_invalid");
    }
    return assurance;
  }

  async claimCommand(
    claim: ChangeSetCommandClaim,
  ): Promise<ChangeSetCommandClaimResult> {
    this.requireTenant(claim.tenantId);
    return this.rpc<ChangeSetCommandClaimResult>("claim_command", [
      JSON.stringify(claim),
    ]);
  }

  async loadChangeSetForUpdate(
    tenantId: string,
    changeSetId: string,
  ): Promise<StoredR1ChangeSet | null> {
    this.requireTenant(tenantId);
    return this.rpc<StoredR1ChangeSet | null>("load_change_set", [
      tenantId,
      changeSetId,
    ]);
  }

  async loadVerifiedTransitionEvidenceForUpdate(input: {
    tenantId: string;
    changeSetId: string;
    actorPrincipalId: string;
    toState: ChangeSetState;
  }): Promise<VerifiedTransitionEvidence | null> {
    this.requireTenant(input.tenantId);
    const rows = await this.rpc<EvidenceRpcRow[]>("load_transition_evidence", [
      input.tenantId,
      input.changeSetId,
      input.actorPrincipalId,
      input.toState,
    ]);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const now = this.options.now?.() ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) return null;

    const receipts: VerifiedTransitionEvidence["receipts"] = [];
    for (const row of rows) {
      if (!isRecord(row)) return null;
      try {
        const publicKey = crypto.createPublicKey({
          key: Buffer.from(String(row.publicKeySpkiBase64), "base64"),
          format: "der",
          type: "spki",
        });
        const grant: ChangeSetEvidenceTenantGrant = {
          id: String(row.grantId),
          tenantId: String(row.grantTenantId),
          kind: row.grantKind,
          toolId: String(row.grantToolId),
          toolVersion: String(row.grantToolVersion),
          state: row.grantState,
          validFrom: Number(row.grantValidFrom),
          validUntil:
            row.grantValidUntil === null ? null : Number(row.grantValidUntil),
        };
        const key: ChangeSetEvidenceVerificationKey = {
          issuerId: String(row.issuerId),
          issuerPrincipalId: String(row.issuerPrincipalId),
          keyId: String(row.keyId),
          algorithm: row.keyAlgorithm,
          environmentId: String(row.issuerEnvironmentId),
          cellId: String(row.issuerCellId),
          issuerState: row.issuerState,
          state: row.keyState,
          validFrom: Number(row.keyValidFrom),
          signUntil: Number(row.keySignUntil),
          verifyUntil: Number(row.keyVerifyUntil),
          publicKey,
          publicKeyFingerprintSha256: String(
            row.publicKeyFingerprintSha256,
          ),
          tenantGrants: [grant],
        };
        const token = `${Buffer.from(
          String(row.signedClaimsCanonical),
          "utf8",
        ).toString("base64url")}.${String(row.signatureBase64Url)}`;
        const verified = verifyChangeSetEvidenceEnvelope(token, [key], {
          now,
          expectedEnvironmentId: this.options.expectedEnvironmentId,
          expectedCellId: this.options.expectedCellId,
        });
        if (!verified.ok) return null;
        const claims = verified.claims;
        receipts.push({
          id: claims.receiptId,
          kind: claims.kind,
          issuer: claims.issuerId,
          toolVersion: claims.toolVersion,
          tenantId: claims.tenantId,
          changeSetId: claims.changeSetId,
          targetState: claims.targetState,
          requestedByPrincipalId: claims.requestedByPrincipalId,
          requestedByMembershipId: claims.requestedByMembershipId,
          subjectHash: claims.subjectHash,
          policyVersionId: claims.policyVersionId,
          outcome: claims.outcome,
          artifactCount: claims.artifactCount,
          outcomeHash: claims.outcomeHash,
          issuedAt: claims.issuedAt,
          expiresAt: claims.expiresAt,
          consumedAt: null,
        });
      } catch {
        return null;
      }
    }
    return { receipts };
  }

  async loadLatestTransitionReceiptHash(
    tenantId: string,
    changeSetId: string,
  ): Promise<string | null> {
    this.requireTenant(tenantId);
    return this.rpc<string | null>("load_latest_transition_hash", [
      tenantId,
      changeSetId,
    ]);
  }

  async insertAccessDecisionReceipt(
    input: AccessDecisionReceiptInsert,
  ): Promise<void> {
    this.requireTenant(input.tenantId);
    await this.rpc<boolean>("insert_access_decision", [JSON.stringify(input)]);
  }

  async insertCommandAttemptReceipt(
    input: ChangeSetCommandAttemptReceiptInsert,
  ): Promise<void> {
    this.requireTenant(input.tenantId);
    await this.rpc<boolean>("insert_command_attempt", [JSON.stringify(input)]);
  }

  async consumeVerifiedTransitionEvidence(input: {
    tenantId: string;
    changeSetId: string;
    commandReceiptId: string;
    receiptIds: string[];
    consumedAt: number;
  }): Promise<boolean> {
    this.requireTenant(input.tenantId);
    return this.rpc<boolean>("consume_transition_evidence", [
      input.tenantId,
      input.changeSetId,
      input.commandReceiptId,
      input.receiptIds,
      input.consumedAt,
    ]);
  }

  async insertChangeSet(input: {
    id: string;
    draft: Parameters<ChangeSetCommandTransaction["insertChangeSet"]>[0]["draft"];
  }): Promise<void> {
    this.requireTenant(input.draft.tenantId);
    await this.rpc<boolean>("insert_change_set", [JSON.stringify(input)]);
  }

  async insertApproval(input: ChangeSetApprovalInsert): Promise<void> {
    this.requireTenant(input.tenantId);
    await this.rpc<boolean>("insert_approval", [JSON.stringify(input)]);
  }

  async insertTransitionReceipt(
    input: ChangeSetTransitionReceiptInsert,
  ): Promise<void> {
    this.requireTenant(input.tenantId);
    await this.rpc<boolean>("insert_transition_receipt", [
      JSON.stringify(input),
    ]);
  }

  async updateChangeSet(input: {
    tenantId: string;
    changeSetId: string;
    expectedVersion: number;
    next: Parameters<ChangeSetCommandTransaction["updateChangeSet"]>[0]["next"];
    statusReason: string;
  }): Promise<void> {
    this.requireTenant(input.tenantId);
    const updated = await this.rpc<boolean>("update_change_set", [
      JSON.stringify(input),
    ]);
    if (!updated) throw new Error("change_set_optimistic_conflict");
  }

  async completeCommand(input: {
    commandReceiptId: string;
    changeSetId: string;
    result: ChangeSetCommandSuccess;
    resultHash: string;
    completedAt: number;
  }): Promise<void> {
    if (!this.tenantId) throw new Error("change_set_transaction_tenant_missing");
    const completed = await this.rpc<boolean>("complete_command", [
      this.tenantId,
      JSON.stringify(input),
    ]);
    if (!completed) throw new Error("change_set_command_completion_conflict");
  }
}

export class PostgresChangeSetCommandStore implements ChangeSetCommandStore {
  private readonly options: Omit<PostgresChangeSetCommandStoreOptions, "pool">;

  constructor(private readonly pool: Pool, options: Omit<PostgresChangeSetCommandStoreOptions, "pool">) {
    if (!ROLE_RE.test(options.expectedRole)) {
      throw new Error("change_set_executor_role_invalid");
    }
    if (
      !IDENTIFIER_RE.test(options.expectedEnvironmentId) ||
      !IDENTIFIER_RE.test(options.expectedCellId) ||
      typeof options.resolveMutationAssurance !== "function"
    ) {
      throw new Error("change_set_store_configuration_invalid");
    }
    this.options = options;
  }

  async transaction<T>(
    operation: (transaction: ChangeSetCommandTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let transactionStarted = false;
    let releaseWithError: Error | undefined;
    try {
      const identity = await client.query<{
        current_user: string;
        tenant_setting: string | null;
      }>(
        `SELECT current_user, nullif(current_setting('app.tenant_id', true), '') AS tenant_setting`,
      );
      if (
        identity.rowCount !== 1 ||
        identity.rows[0]?.current_user !== this.options.expectedRole ||
        identity.rows[0]?.tenant_setting !== null
      ) {
        throw new Error("change_set_executor_identity_invalid");
      }
      await client.query("BEGIN");
      transactionStarted = true;
      const tx = new PostgresChangeSetCommandTransaction(client, this.options);
      const result = await operation(tx);
      await client.query("COMMIT");
      transactionStarted = false;
      return result;
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error("change_set_transaction_failed");
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
          transactionStarted = false;
        } catch (rollbackError) {
          releaseWithError =
            rollbackError instanceof Error
              ? rollbackError
              : new Error("change_set_rollback_failed");
        }
      }
      throw normalized;
    } finally {
      client.release(releaseWithError);
    }
  }
}

export function createPostgresChangeSetCommandStore(
  options: PostgresChangeSetCommandStoreOptions,
): PostgresChangeSetCommandStore {
  return new PostgresChangeSetCommandStore(options.pool, {
    expectedRole: options.expectedRole,
    expectedEnvironmentId: options.expectedEnvironmentId,
    expectedCellId: options.expectedCellId,
    resolveMutationAssurance: options.resolveMutationAssurance,
    now: options.now,
  });
}

export function failClosedMutationAssurance(): MutationAssurance {
  return {
    impersonating: true,
    stepUpSatisfied: false,
    stepUpReceiptId: null,
  };
}

export function isValidPostgresChangeSetStoreTimestamp(
  value: unknown,
): value is number {
  return asFiniteTimestamp(value) !== null;
}
