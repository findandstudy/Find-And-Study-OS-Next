/**
 * Backend date formatting helpers — locale-independent, always dd.mm.yyyy.
 * Use these for emails, PDF content, logs, and any user-visible date output.
 * Do NOT use for portal submission payloads — those must keep their own format.
 */

/** Format a date as dd.mm.yyyy (e.g. 15.07.2026). Returns "" for null/invalid. */
export function formatDateDMY(value: Date | string | number | null | undefined): string {
  if (value == null || value === "") return "";
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return "";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

/** Format a date+time as dd.mm.yyyy HH:MM 24h. Returns "" for null/invalid. */
export function formatDateTimeDMY(value: Date | string | number | null | undefined): string {
  if (value == null || value === "") return "";
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return "";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd}.${mm}.${yyyy} ${hh}:${mi}`;
}
