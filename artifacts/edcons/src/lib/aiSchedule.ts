// Client-side mirror of the AI agent working-hours logic (api-server
// lib/inbox/botSchedule.ts). Used only for the live ACTIVE/PASSIVE badge and
// "next change" preview in the admin panel — the server remains the single
// authority for actual gating.
//
// RULE: a window belongs to the day it STARTS on. An overnight window
// (end < start, e.g. Mon 09:00–04:00) spills into the next day (covers Tue
// 00:00–03:59). All math is done on tz-local wall-clock components obtained
// via Intl.DateTimeFormat — never fixed UTC offsets — so DST is correct.
import type { AiAgentWeeklySchedule, AiAgentScheduleDay } from "@workspace/api-client-react";

export type WeekDayKey = keyof AiAgentWeeklySchedule;

export const WEEK_DAY_KEYS: WeekDayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
/** Monday-first order for the admin UI rows. */
export const UI_DAY_ORDER: WeekDayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** All IANA timezones the browser knows, with a safe fallback list. */
export function listTimeZones(): string[] {
  try {
    const zones = Intl.supportedValuesOf("timeZone");
    if (zones.length > 0) return zones;
  } catch {
    // older engines
  }
  return ["Europe/Istanbul", "Europe/London", "Europe/Berlin", "America/New_York", "Asia/Dubai", "UTC"];
}

function parseMinutes(hhmm: string): number | null {
  if (!TIME_RE.test(hhmm)) return null;
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  return h * 60 + m;
}

/** Local wall-clock position (weekday index 0=Sun + minutes) inside tz. */
export function localClock(tz: string, now: Date = new Date()): { dayIdx: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const wd = get("weekday").toLowerCase().slice(0, 3) as WeekDayKey;
  const dayIdx = Math.max(0, WEEK_DAY_KEYS.indexOf(wd));
  const hour = parseInt(get("hour"), 10) % 24;
  const minute = parseInt(get("minute"), 10);
  return { dayIdx, minutes: hour * 60 + minute };
}

/** Same window rule as the server: today's window + yesterday's overnight spill. */
export function isWithinWeeklySchedule(
  schedule: AiAgentWeeklySchedule,
  dayIdx: number,
  minutes: number,
): boolean {
  const today: AiAgentScheduleDay | undefined = schedule[WEEK_DAY_KEYS[dayIdx]];
  if (today?.enabled) {
    const s = parseMinutes(today.start);
    const e = parseMinutes(today.end);
    if (s !== null && e !== null && s !== e) {
      if (s < e && minutes >= s && minutes < e) return true;
      if (s > e && minutes >= s) return true;
    }
  }
  const yesterday = schedule[WEEK_DAY_KEYS[(dayIdx + 6) % 7]];
  if (yesterday?.enabled) {
    const s = parseMinutes(yesterday.start);
    const e = parseMinutes(yesterday.end);
    if (s !== null && e !== null && s > e && minutes < e) return true;
  }
  return false;
}

export interface ScheduleStatus {
  active: boolean;
  /** Next state flip, if any within the coming week (null = state never changes). */
  next: { dayOffset: number; time: string } | null;
}

/**
 * Current active state + the next transition (scanning window boundaries over
 * the next 8 days in tz-local space).
 */
export function scheduleStatus(
  schedule: AiAgentWeeklySchedule,
  tz: string,
  now: Date = new Date(),
): ScheduleStatus {
  const zone = isValidTimeZone(tz) ? tz : "Europe/Istanbul";
  const { dayIdx, minutes } = localClock(zone, now);
  const active = isWithinWeeklySchedule(schedule, dayIdx, minutes);
  const nowAbs = minutes;

  // Collect candidate boundary instants (absolute minutes from today 00:00).
  const events: number[] = [];
  for (let o = -1; o <= 7; o++) {
    const day = schedule[WEEK_DAY_KEYS[((dayIdx + o) % 7 + 7) % 7]];
    if (!day?.enabled) continue;
    const s = parseMinutes(day.start);
    const e = parseMinutes(day.end);
    if (s === null || e === null || s === e) continue;
    events.push(o * 1440 + s);
    events.push((o + (e <= s ? 1 : 0)) * 1440 + e);
  }
  const sorted = [...new Set(events)].filter((t) => t > nowAbs).sort((a, b) => a - b);
  for (const t of sorted) {
    const d = (dayIdx + Math.floor(t / 1440)) % 7;
    const m = t % 1440;
    if (isWithinWeeklySchedule(schedule, d, m) !== active) {
      const hh = String(Math.floor(m / 60)).padStart(2, "0");
      const mm = String(m % 60).padStart(2, "0");
      return { active, next: { dayOffset: Math.floor(t / 1440), time: `${hh}:${mm}` } };
    }
  }
  return { active, next: null };
}

/** Localized long weekday name for a UI day key (uses a fixed reference week). */
export function weekdayLabel(key: WeekDayKey, locale: string): string {
  // 2024-01-07 was a Sunday; index into that week.
  const ref = new Date(Date.UTC(2024, 0, 7 + WEEK_DAY_KEYS.indexOf(key)));
  return new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(ref);
}

/** Localized weekday name `dayOffset` days ahead of "now" in tz. */
export function weekdayLabelAtOffset(tz: string, dayOffset: number, locale: string, now: Date = new Date()): string {
  const { dayIdx } = localClock(isValidTimeZone(tz) ? tz : "Europe/Istanbul", now);
  return weekdayLabel(WEEK_DAY_KEYS[(dayIdx + dayOffset) % 7], locale);
}

/** "HH:mm" current wall-clock time in tz for the live preview. */
export function currentTimeInZone(tz: string, locale: string, now: Date = new Date()): string {
  const zone = isValidTimeZone(tz) ? tz : "Europe/Istanbul";
  return new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
}
