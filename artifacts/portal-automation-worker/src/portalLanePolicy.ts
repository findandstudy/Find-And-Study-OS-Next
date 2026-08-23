const MAX_PORTAL_CONCURRENCY = 8;

export interface PortalLanePolicy {
  globalConcurrency: number;
  defaultLaneConcurrency: number;
  laneConcurrency: ReadonlyMap<string, number>;
  heartbeatMs: number;
}

function parsePositiveInteger(name: string, value: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be between 1 and ${max}`);
  }
  return parsed;
}

export function normalizePortalLaneKey(value: string): string {
  return value.trim().toLowerCase();
}

export function parsePortalLaneConcurrency(value: string | undefined): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  if (!value?.trim()) return result;

  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0 || separator === trimmed.length - 1) {
      throw new Error("WORKER_LANE_CONCURRENCY must use comma-separated lane=slots entries");
    }
    const laneKey = normalizePortalLaneKey(trimmed.slice(0, separator));
    if (!/^[a-z0-9._:-]+$/.test(laneKey)) {
      throw new Error(`Invalid portal lane key: ${laneKey || "<empty>"}`);
    }
    if (result.has(laneKey)) {
      throw new Error(`Duplicate portal lane concurrency entry: ${laneKey}`);
    }
    const slots = parsePositiveInteger(`WORKER_LANE_CONCURRENCY(${laneKey})`, trimmed.slice(separator + 1), 1, MAX_PORTAL_CONCURRENCY);
    result.set(laneKey, slots);
  }

  return result;
}

export function loadPortalLanePolicy(env: NodeJS.ProcessEnv, staleMs: number): PortalLanePolicy {
  const globalConcurrency = parsePositiveInteger("WORKER_GLOBAL_CONCURRENCY", env.WORKER_GLOBAL_CONCURRENCY, 1, MAX_PORTAL_CONCURRENCY);
  const defaultLaneConcurrency = parsePositiveInteger("WORKER_DEFAULT_LANE_CONCURRENCY", env.WORKER_DEFAULT_LANE_CONCURRENCY, 1, MAX_PORTAL_CONCURRENCY);
  const laneConcurrency = parsePortalLaneConcurrency(env.WORKER_LANE_CONCURRENCY);
  const heartbeatMs = parsePositiveInteger("WORKER_HEARTBEAT_MS", env.WORKER_HEARTBEAT_MS, 30_000, Math.max(1, staleMs - 1));

  if (defaultLaneConcurrency > globalConcurrency) {
    throw new Error("WORKER_DEFAULT_LANE_CONCURRENCY cannot exceed WORKER_GLOBAL_CONCURRENCY");
  }
  for (const [laneKey, slots] of laneConcurrency) {
    if (slots > globalConcurrency) {
      throw new Error(`WORKER_LANE_CONCURRENCY(${laneKey}) cannot exceed WORKER_GLOBAL_CONCURRENCY`);
    }
  }
  if (heartbeatMs * 2 >= staleMs) {
    throw new Error("WORKER_HEARTBEAT_MS must be less than half of WORKER_STALE_MS");
  }

  return {
    globalConcurrency,
    defaultLaneConcurrency,
    laneConcurrency,
    heartbeatMs,
  };
}

export function concurrencyForPortalLane(policy: PortalLanePolicy, laneKey: string): number {
  return policy.laneConcurrency.get(normalizePortalLaneKey(laneKey)) ?? policy.defaultLaneConcurrency;
}
