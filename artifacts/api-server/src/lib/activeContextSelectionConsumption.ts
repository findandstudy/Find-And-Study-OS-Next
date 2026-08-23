import {
  isSelectionBoundActiveTenantContext,
  type VerifiedActiveTenantContext,
} from "./activeTenantContext";

const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ActiveContextSelectionLockInput = {
  tenantId: string;
  selectionId: string;
  sessionGeneration: number;
  principalId: string;
  membershipId: string;
  organizationId: string | null;
  legacyBranchId: number | null;
  observedAt: number;
};

export type ActiveContextSelectionState = {
  selectionId: string;
  tenantId: string;
  sessionGeneration: number;
  principalId: string;
  membershipId: string;
  organizationId: string | null;
  legacyBranchId: number | null;
  status: "ACTIVE" | "ROTATED" | "REVOKED" | "EXPIRED";
};

/**
 * A deliberately narrow view of the transaction that holds the selection
 * lock. It exposes parameterized queries only; commit, rollback and release
 * remain owned by the repository implementation.
 */
export type ActiveContextSelectionTransaction = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
};

export interface ActiveContextSelectionLockRepository {
  /**
   * The callback must run before the repository releases its row/transaction
   * lock. Implementations must re-read the authoritative row and never trust
   * the caller's selection state.
   */
  withLockedSelection<T>(
    input: ActiveContextSelectionLockInput,
    operation: (
      state: ActiveContextSelectionState,
      transaction?: ActiveContextSelectionTransaction,
    ) => Promise<T>,
  ): Promise<T>;
}

export type SelectionBoundActiveContextConsumptionOptions<T> = {
  context: unknown;
  repository: ActiveContextSelectionLockRepository;
  operation: (
    context: VerifiedActiveTenantContext & {
      tokenVersion: 2;
      selectionId: string;
      sessionGeneration: number;
    },
    state: ActiveContextSelectionState,
    transaction?: ActiveContextSelectionTransaction,
  ) => Promise<T>;
  now?: () => number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function isUuidV7(value: unknown): value is string {
  return typeof value === "string" && UUID_V7_RE.test(value);
}

function isBranch(value: unknown): value is number | null {
  return (
    value === null ||
    (Number.isSafeInteger(value) && Number(value) > 0)
  );
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseSelectionState(value: unknown): ActiveContextSelectionState | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "legacyBranchId",
      "membershipId",
      "organizationId",
      "principalId",
      "selectionId",
      "sessionGeneration",
      "status",
      "tenantId",
    ]) ||
    !isUuidV7(value.selectionId) ||
    !isUuidV7(value.tenantId) ||
    !Number.isSafeInteger(value.sessionGeneration) ||
    Number(value.sessionGeneration) < 1 ||
    !isUuidV7(value.principalId) ||
    !isUuidV7(value.membershipId) ||
    !(
      value.organizationId === null || isUuidV7(value.organizationId)
    ) ||
    !isBranch(value.legacyBranchId) ||
    (value.legacyBranchId !== null && value.organizationId === null) ||
    !["ACTIVE", "ROTATED", "REVOKED", "EXPIRED"].includes(
      String(value.status),
    )
  ) {
    return null;
  }
  return {
    selectionId: value.selectionId.toLowerCase(),
    tenantId: value.tenantId.toLowerCase(),
    sessionGeneration: Number(value.sessionGeneration),
    principalId: value.principalId.toLowerCase(),
    membershipId: value.membershipId.toLowerCase(),
    organizationId: value.organizationId?.toLowerCase() ?? null,
    legacyBranchId:
      value.legacyBranchId === null ? null : Number(value.legacyBranchId),
    status: value.status as ActiveContextSelectionState["status"],
  };
}

function selectionInput(
  context: VerifiedActiveTenantContext & {
    tokenVersion: 2;
    selectionId: string;
    sessionGeneration: number;
  },
  observedAt: number,
): ActiveContextSelectionLockInput {
  return {
    tenantId: context.tenantId,
    selectionId: context.selectionId,
    sessionGeneration: context.sessionGeneration,
    principalId: context.principalId,
    membershipId: context.membershipId,
    organizationId: context.organizationId,
    legacyBranchId: context.legacyBranchId,
    observedAt,
  };
}

export async function withLockedSelectionBoundActiveContext<T>(
  options: SelectionBoundActiveContextConsumptionOptions<T>,
): Promise<T> {
  if (
    !options ||
    typeof options.now !== "undefined" && typeof options.now !== "function" ||
    !isRecord(options.repository) ||
    typeof options.repository.withLockedSelection !== "function" ||
    typeof options.operation !== "function"
  ) {
    throw new Error("active_context_selection_consumption_configuration_invalid");
  }
  const now = options.now ?? Date.now;
  const observedAt = now();
  if (!isTimestamp(observedAt)) {
    throw new Error("active_context_selection_consumption_clock_invalid");
  }
  if (!isSelectionBoundActiveTenantContext(options.context, observedAt)) {
    throw new Error("active_context_selection_consumption_context_invalid");
  }
  const context = options.context;
  const input = selectionInput(context, observedAt);
  return options.repository.withLockedSelection(input, async (rawState, transaction) => {
    const state = parseSelectionState(rawState);
    if (!state) {
      throw new Error("active_context_selection_consumption_state_invalid");
    }
    if (
      state.status !== "ACTIVE" ||
      state.selectionId !== input.selectionId ||
      state.tenantId !== input.tenantId ||
      state.sessionGeneration !== input.sessionGeneration ||
      state.principalId !== input.principalId ||
      state.membershipId !== input.membershipId ||
      state.organizationId !== input.organizationId ||
      state.legacyBranchId !== input.legacyBranchId
    ) {
      throw new Error("active_context_selection_consumption_binding_stale");
    }
    return options.operation(context, state, transaction);
  });
}
