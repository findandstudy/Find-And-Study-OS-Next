// AI Agent working-hours schedule (per weekday, IANA timezone aware).
//
// RULE — which day's window applies at, say, 02:00?
// A window BELONGS TO THE DAY IT STARTS ON. An overnight window (end < start,
// e.g. Monday 09:00–04:00) spills into the next day: it covers Monday
// 09:00→23:59 AND Tuesday 00:00→03:59. So at Tuesday 02:00 the MONDAY row is
// the one that decides. Tuesday's own row only matters from its own start
// time onward.
//
// All calculations are done in the configured IANA timezone via
// Intl.DateTimeFormat — never with a fixed UTC offset — so DST transitions
// (e.g. Europe/London) are handled correctly by the platform tz database.
import type { AiAgentConfig, ScheduleDayConfig, WeekDayKey, WeeklySchedule } from "./aiAgentConfig";

export const WEEK_DAY_KEYS: WeekDayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTimeZone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parseMinutes(hhmm: string): number | null {
  if (!TIME_RE.test(hhmm)) return null;
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  return h * 60 + m;
}

/** Local wall-clock position inside the given timezone. */
export function localClock(tz: string, now: Date): { dayIdx: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const wd = get("weekday").toLowerCase().slice(0, 3);
  const dayIdx = Math.max(0, WEEK_DAY_KEYS.indexOf(wd as WeekDayKey));
  // "24" can appear for midnight in some ICU versions; normalize to 0.
  const hour = parseInt(get("hour"), 10) % 24;
  const minute = parseInt(get("minute"), 10);
  return { dayIdx, minutes: hour * 60 + minute };
}

/**
 * Pure window check: is the local (dayIdx, minutes) inside the weekly
 * schedule? Covers same-day windows (start < end) and overnight windows
 * (end < start → spills into the following day; owned by the START day).
 */
export function isWithinWeeklySchedule(
  schedule: WeeklySchedule,
  dayIdx: number,
  minutes: number,
): boolean {
  const today: ScheduleDayConfig | undefined = schedule[WEEK_DAY_KEYS[dayIdx]];
  if (today?.enabled) {
    const s = parseMinutes(today.start);
    const e = parseMinutes(today.end);
    if (s !== null && e !== null && s !== e) {
      if (s < e && minutes >= s && minutes < e) return true;
      // Overnight window starting today: active from start until midnight.
      if (s > e && minutes >= s) return true;
    }
  }
  // Overnight spill from YESTERDAY's window (e.g. Mon 09:00–04:00 covers
  // Tue 00:00–03:59).
  const yesterday = schedule[WEEK_DAY_KEYS[(dayIdx + 6) % 7]];
  if (yesterday?.enabled) {
    const s = parseMinutes(yesterday.start);
    const e = parseMinutes(yesterday.end);
    if (s !== null && e !== null && s > e && minutes < e) return true;
  }
  return false;
}

/**
 * SINGLE gate for "is the AI agent allowed to act right now?" as far as the
 * working-hours schedule is concerned. Order of checks lives in the caller
 * (enabled → schedule → per-conversation toggle); this helper only answers
 * the schedule question. When the schedule feature is off (scheduleEnabled
 * false — the backward-compatible default) it always returns true, i.e. the
 * pre-existing 24/7 behavior is preserved bit-for-bit.
 */
export function isAiAgentWithinWorkingHours(
  config: Pick<AiAgentConfig, "scheduleEnabled" | "timezone" | "schedule">,
  now: Date = new Date(),
): boolean {
  if (!config.scheduleEnabled) return true;
  const tz = isValidTimeZone(config.timezone) ? config.timezone : "Europe/Istanbul";
  const { dayIdx, minutes } = localClock(tz, now);
  return isWithinWeeklySchedule(config.schedule, dayIdx, minutes);
}
