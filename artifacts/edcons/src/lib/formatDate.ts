/**
 * Locale-independent date helpers for use in components that don't have
 * the i18n lang context handy, or that bypass the central formatDate util.
 * Produces output in the org's configured date format (default DD.MM.YYYY).
 */

import { applyDateFormat } from "@workspace/i18n";

/** Format a date-like value using the org date format. Returns "—" for null/invalid. */
export function fmtDate(
  value: string | number | Date | null | undefined,
  dateFormat?: string | null,
): string {
  if (value == null || value === "") return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return "—";
  return applyDateFormat(d, dateFormat);
}

/** Format a date-like value as <date> HH:MM (24h). Returns "—" for null/invalid. */
export function fmtDateTime(
  value: string | number | Date | null | undefined,
  dateFormat?: string | null,
): string {
  if (value == null || value === "") return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return "—";
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${applyDateFormat(d, dateFormat)} ${hh}:${mi}`;
}
