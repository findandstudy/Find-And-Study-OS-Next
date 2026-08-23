import { AsyncLocalStorage } from "node:async_hooks";

type PendingRead = Promise<unknown>;

const pendingReads = new Map<string, PendingRead>();
const readMetricsStorage = new AsyncLocalStorage<{
  started: number;
  merged: number;
}>();

export function runWithReadPathMetrics<T>(callback: () => T): T {
  return readMetricsStorage.run({ started: 0, merged: 0 }, callback);
}

export function getReadPathMetricsSnapshot(): {
  started: number;
  merged: number;
} | null {
  const metrics = readMetricsStorage.getStore();
  return metrics ? { ...metrics } : null;
}

function isEnabled(): boolean {
  return process.env.READ_PATH_COALESCING_ENABLED === "true";
}

export async function coalesceRead<T>(options: {
  namespace: string;
  key: string;
  execute: () => Promise<T>;
  enabled?: boolean;
}): Promise<{ value: T; coalesced: boolean }> {
  if (!(options.enabled ?? isEnabled())) {
    return { value: await options.execute(), coalesced: false };
  }

  const fullKey = `${options.namespace}:${options.key}`;
  const existing = pendingReads.get(fullKey) as Promise<T> | undefined;
  if (existing) {
    const metrics = readMetricsStorage.getStore();
    if (metrics) metrics.merged += 1;
    return { value: await existing, coalesced: true };
  }

  const pending = options.execute();
  const metrics = readMetricsStorage.getStore();
  if (metrics) metrics.started += 1;
  pendingReads.set(fullKey, pending);
  try {
    return { value: await pending, coalesced: false };
  } finally {
    if (pendingReads.get(fullKey) === pending) {
      pendingReads.delete(fullKey);
    }
  }
}

export function clearPendingReadsForTests(): void {
  pendingReads.clear();
}
