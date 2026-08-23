import { AsyncLocalStorage } from "node:async_hooks";

export type DbRequestMetricsSnapshot = {
  queryCount: number;
  queryDurationMs: number;
  acquireCount: number;
  acquireWaitMs: number;
  retryCount: number;
};

type MutableDbRequestMetrics = DbRequestMetricsSnapshot;

const requestMetricsStorage = new AsyncLocalStorage<MutableDbRequestMetrics>();

export function runWithDbRequestMetrics<T>(callback: () => T): T {
  return requestMetricsStorage.run(
    {
      queryCount: 0,
      queryDurationMs: 0,
      acquireCount: 0,
      acquireWaitMs: 0,
      retryCount: 0,
    },
    callback,
  );
}

export function recordDbQuery(durationMs: number): void {
  const metrics = requestMetricsStorage.getStore();
  if (!metrics) return;
  metrics.queryCount += 1;
  metrics.queryDurationMs += Math.max(0, durationMs);
}

export function recordDbAcquire(durationMs: number): void {
  const metrics = requestMetricsStorage.getStore();
  if (!metrics) return;
  metrics.acquireCount += 1;
  metrics.acquireWaitMs += Math.max(0, durationMs);
}

export function recordDbRetry(): void {
  const metrics = requestMetricsStorage.getStore();
  if (!metrics) return;
  metrics.retryCount += 1;
}

export function getDbRequestMetricsSnapshot(): DbRequestMetricsSnapshot | null {
  const metrics = requestMetricsStorage.getStore();
  return metrics ? { ...metrics } : null;
}
