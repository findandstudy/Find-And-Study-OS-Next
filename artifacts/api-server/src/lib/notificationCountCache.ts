export interface NotificationSectionCounts {
  total: number;
  importantTotal: number;
  leads: number;
  students: number;
  applications: number;
  tasks: number;
}

interface CacheEntry {
  value: NotificationSectionCounts;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 10_000;
const MAX_ENTRIES = 1_000;
const countCache = new Map<number, CacheEntry>();

function ttlMs(): number {
  const configured = Number(process.env.NOTIFICATION_COUNT_CACHE_TTL_MS);
  if (!Number.isFinite(configured)) return DEFAULT_TTL_MS;
  return Math.max(1_000, Math.min(configured, 60_000));
}

export function getCachedNotificationCounts(userId: number): NotificationSectionCounts | null {
  const entry = countCache.get(userId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    countCache.delete(userId);
    return null;
  }
  // Never expose the mutable cache object to a route caller.
  return { ...entry.value };
}

export function cacheNotificationCounts(userId: number, value: NotificationSectionCounts): void {
  if (countCache.size >= MAX_ENTRIES && !countCache.has(userId)) {
    const oldestKey = countCache.keys().next().value as number | undefined;
    if (oldestKey !== undefined) countCache.delete(oldestKey);
  }
  countCache.delete(userId);
  countCache.set(userId, { value: { ...value }, expiresAt: Date.now() + ttlMs() });
}

export function invalidateNotificationCounts(userIds?: number | number[]): void {
  if (userIds === undefined) {
    countCache.clear();
    return;
  }
  for (const userId of Array.isArray(userIds) ? userIds : [userIds]) {
    countCache.delete(userId);
  }
}

export function clearNotificationCountCacheForTests(): void {
  countCache.clear();
}
