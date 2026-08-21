import crypto from "node:crypto";
import type { Pool, QueryResultRow } from "pg";

import {
  verifyChangeSetEvidenceEnvelope,
  type ChangeSetEvidenceClaims,
  type ChangeSetEvidenceTenantGrant,
  type ChangeSetEvidenceVerificationKey,
} from "./changeSetEvidenceEnvelope";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER_RE = /^[a-z][a-z0-9._:-]{2,95}$/;
const ROLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;

type VerificationContextRow = {
  issuerId: string;
  issuerPrincipalId: string;
  environmentId: string;
  cellId: string;
  issuerState: "ACTIVE" | "REVOKED";
  keyId: string;
  algorithm: "Ed25519";
  keyState: "ACTIVE" | "VERIFY_ONLY" | "REVOKED" | "COMPROMISED";
  validFrom: number;
  signUntil: number;
  verifyUntil: number;
  publicKeySpkiBase64: string;
  publicKeyFingerprintSha256: string;
  grantId: string;
  grantTenantId: string;
  grantKind: ChangeSetEvidenceTenantGrant["kind"];
  grantToolId: string;
  grantToolVersion: string;
  grantState: "ACTIVE" | "REVOKED";
  grantValidFrom: number;
  grantValidUntil: number | null;
};

type RpcRow = QueryResultRow & { result: unknown };

export type PostgresChangeSetEvidenceIssuerOptions = {
  pool: Pool;
  expectedRole: string;
  expectedEnvironmentId: string;
  expectedCellId: string;
  now?: () => number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function parseUntrustedHints(token: string): {
  canonical: string;
  signature: string;
  issuerId: string;
  keyId: string;
  tenantId: string;
  grantId: string;
} | null {
  if (typeof token !== "string" || Buffer.byteLength(token, "utf8") > 16_384) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const payload = Buffer.from(parts[0], "base64url");
    if (payload.toString("base64url") !== parts[0]) return null;
    const canonical = payload.toString("utf8");
    const claims = JSON.parse(canonical) as unknown;
    if (!isRecord(claims)) return null;
    const issuerId = claims.issuerId;
    const keyId = claims.keyId;
    const tenantId = claims.tenantId;
    const grantId = claims.issuerTenantGrantId;
    if (
      typeof issuerId !== "string" ||
      !IDENTIFIER_RE.test(issuerId) ||
      typeof keyId !== "string" ||
      !IDENTIFIER_RE.test(keyId) ||
      typeof tenantId !== "string" ||
      !UUID_RE.test(tenantId) ||
      typeof grantId !== "string" ||
      !UUID_RE.test(grantId)
    ) {
      return null;
    }
    return {
      canonical,
      signature: parts[1],
      issuerId,
      keyId,
      tenantId: tenantId.toLowerCase(),
      grantId: grantId.toLowerCase(),
    };
  } catch {
    return null;
  }
}

function verificationKey(row: VerificationContextRow): ChangeSetEvidenceVerificationKey {
  const grant: ChangeSetEvidenceTenantGrant = {
    id: row.grantId,
    tenantId: row.grantTenantId,
    kind: row.grantKind,
    toolId: row.grantToolId,
    toolVersion: row.grantToolVersion,
    state: row.grantState,
    validFrom: Number(row.grantValidFrom),
    validUntil: row.grantValidUntil === null ? null : Number(row.grantValidUntil),
  };
  return {
    issuerId: row.issuerId,
    issuerPrincipalId: row.issuerPrincipalId,
    keyId: row.keyId,
    algorithm: row.algorithm,
    environmentId: row.environmentId,
    cellId: row.cellId,
    issuerState: row.issuerState,
    state: row.keyState,
    validFrom: Number(row.validFrom),
    signUntil: Number(row.signUntil),
    verifyUntil: Number(row.verifyUntil),
    publicKey: crypto.createPublicKey({
      key: Buffer.from(row.publicKeySpkiBase64, "base64"),
      format: "der",
      type: "spki",
    }),
    publicKeyFingerprintSha256: row.publicKeyFingerprintSha256,
    tenantGrants: [grant],
  };
}

function persistenceInput(
  claims: Readonly<ChangeSetEvidenceClaims>,
  canonical: string,
  signature: string,
) {
  return {
    id: claims.receiptId,
    tenantId: claims.tenantId,
    changeSetId: claims.changeSetId,
    targetState: claims.targetState,
    kind: claims.kind,
    issuer: claims.issuerId,
    issuerPrincipalId: claims.issuerPrincipalId,
    signingKeyId: claims.keyId,
    algorithm: claims.algorithm,
    schemaVersion: claims.schemaVersion,
    audience: claims.audience,
    environmentId: claims.environmentId,
    cellId: claims.cellId,
    evidenceRequestId: claims.evidenceRequestId,
    issuerTenantGrantId: claims.issuerTenantGrantId,
    challengeNonceHash: sha256(claims.challengeNonce),
    toolId: claims.toolId,
    toolVersion: claims.toolVersion,
    requestedByPrincipalId: claims.requestedByPrincipalId,
    requestedByMembershipId: claims.requestedByMembershipId,
    subjectHash: claims.subjectHash,
    policyVersionId: claims.policyVersionId,
    outcome: claims.outcome,
    artifactCount: claims.artifactCount,
    artifactManifestHash: claims.artifactManifestHash,
    outcomeHash: claims.outcomeHash,
    signedClaims: claims,
    signedClaimsCanonical: canonical,
    signedClaimsHash: sha256(canonical),
    signatureBase64Url: signature,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  };
}

export class PostgresChangeSetEvidenceIssuer {
  constructor(private readonly options: PostgresChangeSetEvidenceIssuerOptions) {
    if (
      !ROLE_RE.test(options.expectedRole) ||
      !IDENTIFIER_RE.test(options.expectedEnvironmentId) ||
      !IDENTIFIER_RE.test(options.expectedCellId)
    ) {
      throw new Error("change_set_evidence_issuer_configuration_invalid");
    }
  }

  async persistVerifiedEnvelope(input: {
    expectedTenantId: string;
    token: string;
  }): Promise<{ receiptId: string }> {
    if (!UUID_RE.test(input.expectedTenantId)) {
      throw new Error("change_set_evidence_expected_tenant_invalid");
    }
    const hints = parseUntrustedHints(input.token);
    if (!hints || hints.tenantId !== input.expectedTenantId.toLowerCase()) {
      throw new Error("change_set_evidence_envelope_hint_invalid");
    }
    const client = await this.options.pool.connect();
    let inTransaction = false;
    let releaseWithError: Error | undefined;
    try {
      const identity = await client.query<{
        current_user: string;
        tenant_setting: string | null;
      }>(
        `SELECT current_user, nullif(current_setting('app.tenant_id', true), '') AS tenant_setting`,
      );
      if (
        identity.rows[0]?.current_user !== this.options.expectedRole ||
        identity.rows[0]?.tenant_setting !== null
      ) {
        throw new Error("change_set_evidence_issuer_identity_invalid");
      }
      await client.query("BEGIN");
      inTransaction = true;
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        input.expectedTenantId,
      ]);
      const contextResult = await client.query<RpcRow>(
        `SELECT fas_evidence_v1.load_verification_context($1, $2, $3, $4) AS result`,
        [
          input.expectedTenantId,
          hints.issuerId,
          hints.keyId,
          hints.grantId,
        ],
      );
      const row = contextResult.rows[0]?.result as VerificationContextRow | null;
      if (!row || !isRecord(row)) {
        throw new Error("change_set_evidence_verification_context_unavailable");
      }
      const now = this.options.now?.() ?? Date.now();
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new Error("change_set_evidence_clock_invalid");
      }
      const verified = verifyChangeSetEvidenceEnvelope(
        input.token,
        [verificationKey(row)],
        {
          now,
          expectedEnvironmentId: this.options.expectedEnvironmentId,
          expectedCellId: this.options.expectedCellId,
        },
      );
      if (!verified.ok || verified.claims.tenantId !== input.expectedTenantId.toLowerCase()) {
        throw new Error(
          `change_set_evidence_verification_failed:${
            verified.ok ? "tenant_mismatch" : verified.reason
          }`,
        );
      }
      const persisted = await client.query<RpcRow>(
        `SELECT fas_evidence_v1.persist_receipt($1, $2::jsonb) AS result`,
        [
          input.expectedTenantId,
          JSON.stringify(
            persistenceInput(verified.claims, hints.canonical, hints.signature),
          ),
        ],
      );
      if (persisted.rows[0]?.result !== true) {
        throw new Error("change_set_evidence_persistence_failed");
      }
      await client.query("COMMIT");
      inTransaction = false;
      return { receiptId: verified.claims.receiptId };
    } catch (error) {
      if (inTransaction) {
        try {
          await client.query("ROLLBACK");
          inTransaction = false;
        } catch (rollbackError) {
          releaseWithError =
            rollbackError instanceof Error
              ? rollbackError
              : new Error("change_set_evidence_rollback_failed");
        }
      }
      throw error;
    } finally {
      client.release(releaseWithError);
    }
  }
}
