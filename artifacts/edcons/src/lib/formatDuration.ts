/**
 * Human-readable duration from a raw seconds value.
 * Returns "—" when the value is zero or unavailable (e.g. page-leave never
 * fired so activeDurationSeconds stayed at 0).  Callers that need minutes
 * should multiply: formatDuration(minutes * 60).
 */
export function formatDuration(seconds: number): string {
  if (!seconds || seconds < 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
