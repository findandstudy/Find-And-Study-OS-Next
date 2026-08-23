import { AsyncLocalStorage } from "node:async_hooks";

type MutableRequestTelemetry = {
  spans: Record<string, number>;
  responseBytes: number;
  caches: Record<string, { hit: number; miss: number }>;
};

export type RequestTelemetrySnapshot = {
  spans: Record<string, number>;
  responseBytes: number;
  caches: Record<string, { hit: number; miss: number }>;
};

const requestTelemetryStorage = new AsyncLocalStorage<MutableRequestTelemetry>();

export function runWithRequestTelemetry<T>(callback: () => T): T {
  return requestTelemetryStorage.run({ spans: {}, responseBytes: 0, caches: {} }, callback);
}

export function recordRequestSpan(name: string, durationMs: number): void {
  const telemetry = requestTelemetryStorage.getStore();
  if (!telemetry || !Number.isFinite(durationMs)) return;
  telemetry.spans[name] = (telemetry.spans[name] ?? 0) + Math.max(0, durationMs);
}

export function recordResponseBytes(chunk: unknown, encoding?: BufferEncoding): void {
  const telemetry = requestTelemetryStorage.getStore();
  if (!telemetry || chunk == null) return;
  if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
    telemetry.responseBytes += chunk.byteLength;
  } else if (typeof chunk === "string") {
    telemetry.responseBytes += Buffer.byteLength(chunk, encoding);
  }
}

export function recordCacheEvent(name: string, result: "hit" | "miss"): void {
  const telemetry = requestTelemetryStorage.getStore();
  if (!telemetry) return;
  const cache = telemetry.caches[name] ?? { hit: 0, miss: 0 };
  cache[result] += 1;
  telemetry.caches[name] = cache;
}

export function getRequestTelemetrySnapshot(): RequestTelemetrySnapshot | null {
  const telemetry = requestTelemetryStorage.getStore();
  return telemetry
    ? {
        spans: { ...telemetry.spans },
        responseBytes: telemetry.responseBytes,
        caches: Object.fromEntries(
          Object.entries(telemetry.caches).map(([name, value]) => [name, { ...value }]),
        ),
      }
    : null;
}
