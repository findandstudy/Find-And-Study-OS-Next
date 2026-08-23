// Unit tests for the AI agent working-hours schedule gate (botSchedule.ts).
// Pure logic — no DB required.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isAiAgentWithinWorkingHours,
  isWithinWeeklySchedule,
  localClock,
  isValidTimeZone,
} from "../src/lib/inbox/botSchedule";
import type { WeeklySchedule } from "../src/lib/inbox/aiAgentConfig";

function week(overrides: Partial<WeeklySchedule> = {}): WeeklySchedule {
  const off = { enabled: false, start: "09:00", end: "18:00" };
  return {
    mon: { ...off },
    tue: { ...off },
    wed: { ...off },
    thu: { ...off },
    fri: { ...off },
    sat: { ...off },
    sun: { ...off },
    ...overrides,
  };
}

// Weekday indices: 0=sun … 1=mon, 2=tue.
describe("isWithinWeeklySchedule", () => {
  it("same-day window: inside / edges / outside", () => {
    const s = week({ mon: { enabled: true, start: "09:00", end: "18:00" } });
    assert.equal(isWithinWeeklySchedule(s, 1, 9 * 60), true); // start inclusive
    assert.equal(isWithinWeeklySchedule(s, 1, 12 * 60), true);
    assert.equal(isWithinWeeklySchedule(s, 1, 18 * 60), false); // end exclusive
    assert.equal(isWithinWeeklySchedule(s, 1, 8 * 60 + 59), false);
    assert.equal(isWithinWeeklySchedule(s, 2, 12 * 60), false); // other day
  });

  it("overnight window belongs to the day it starts (Mon 09:00–04:00 covers Tue 03:00)", () => {
    const s = week({ mon: { enabled: true, start: "09:00", end: "04:00" } });
    assert.equal(isWithinWeeklySchedule(s, 1, 10 * 60), true); // Mon 10:00
    assert.equal(isWithinWeeklySchedule(s, 1, 23 * 60 + 59), true); // Mon 23:59
    assert.equal(isWithinWeeklySchedule(s, 2, 3 * 60), true); // Tue 03:00 spill
    assert.equal(isWithinWeeklySchedule(s, 2, 4 * 60), false); // Tue 04:00 end exclusive
    assert.equal(isWithinWeeklySchedule(s, 2, 5 * 60), false);
    assert.equal(isWithinWeeklySchedule(s, 1, 8 * 60), false); // Mon 08:00 before start
  });

  it("Tue early morning covered by Mon overnight even when Tue itself is disabled", () => {
    const s = week({ mon: { enabled: true, start: "22:00", end: "02:00" } });
    assert.equal(isWithinWeeklySchedule(s, 2, 1 * 60), true); // Tue 01:00
    assert.equal(isWithinWeeklySchedule(s, 2, 2 * 60), false);
  });

  it("disabled day never matches; start===end treated as invalid (no match)", () => {
    const off = week();
    assert.equal(isWithinWeeklySchedule(off, 1, 12 * 60), false);
    const eq = week({ mon: { enabled: true, start: "09:00", end: "09:00" } });
    assert.equal(isWithinWeeklySchedule(eq, 1, 9 * 60), false);
  });

  it("overlapping: today's own window and yesterday's spill both work", () => {
    const s = week({
      mon: { enabled: true, start: "20:00", end: "03:00" },
      tue: { enabled: true, start: "09:00", end: "18:00" },
    });
    assert.equal(isWithinWeeklySchedule(s, 2, 2 * 60), true); // Tue 02:00 via Mon
    assert.equal(isWithinWeeklySchedule(s, 2, 10 * 60), true); // Tue 10:00 own
    assert.equal(isWithinWeeklySchedule(s, 2, 5 * 60), false); // gap
  });
});

describe("localClock / timezone handling", () => {
  it("resolves Istanbul local time correctly (UTC+3, no DST)", () => {
    // 2026-07-15 was a Wednesday. 23:30 UTC = Thu 02:30 Istanbul.
    const now = new Date("2026-07-15T23:30:00Z");
    const { dayIdx, minutes } = localClock("Europe/Istanbul", now);
    assert.equal(dayIdx, 4); // thu
    assert.equal(minutes, 2 * 60 + 30);
  });

  it("is DST-correct for Europe/London (summer BST=UTC+1, winter GMT=UTC+0)", () => {
    const summer = localClock("Europe/London", new Date("2026-07-15T11:00:00Z"));
    assert.equal(summer.minutes, 12 * 60); // 12:00 BST
    const winter = localClock("Europe/London", new Date("2026-01-14T11:00:00Z"));
    assert.equal(winter.minutes, 11 * 60); // 11:00 GMT
  });

  it("validates IANA timezones", () => {
    assert.equal(isValidTimeZone("Europe/Istanbul"), true);
    assert.equal(isValidTimeZone("Not/AZone"), false);
    assert.equal(isValidTimeZone(""), false);
  });
});

describe("isAiAgentWithinWorkingHours", () => {
  const base = {
    timezone: "Europe/Istanbul",
    schedule: week({ mon: { enabled: true, start: "09:00", end: "18:00" } }),
  };

  it("scheduleEnabled=false → always active (backward-compatible 24/7)", () => {
    const cfg = { ...base, scheduleEnabled: false };
    // Sunday 03:00 Istanbul (all days off in `base` except Mon)
    assert.equal(isAiAgentWithinWorkingHours(cfg, new Date("2026-07-19T00:00:00Z")), true);
  });

  it("scheduleEnabled=true gates by the window in the configured tz", () => {
    const cfg = { ...base, scheduleEnabled: true };
    // Mon 2026-07-20 07:00 UTC = 10:00 Istanbul → inside
    assert.equal(isAiAgentWithinWorkingHours(cfg, new Date("2026-07-20T07:00:00Z")), true);
    // Mon 2026-07-20 16:00 UTC = 19:00 Istanbul → outside
    assert.equal(isAiAgentWithinWorkingHours(cfg, new Date("2026-07-20T16:00:00Z")), false);
    // Tue → outside (day disabled)
    assert.equal(isAiAgentWithinWorkingHours(cfg, new Date("2026-07-21T07:00:00Z")), false);
  });

  it("overnight acceptance case: Mon 09:00–04:00 active at Tue 03:00 local", () => {
    const cfg = {
      scheduleEnabled: true,
      timezone: "Europe/Istanbul",
      schedule: week({ mon: { enabled: true, start: "09:00", end: "04:00" } }),
    };
    // Tue 2026-07-21 00:00 UTC = Tue 03:00 Istanbul → active via Monday's window
    assert.equal(isAiAgentWithinWorkingHours(cfg, new Date("2026-07-21T00:00:00Z")), true);
    // Tue 01:30 UTC = Tue 04:30 Istanbul → inactive
    assert.equal(isAiAgentWithinWorkingHours(cfg, new Date("2026-07-21T01:30:00Z")), false);
  });

  it("invalid timezone falls back to Europe/Istanbul instead of crashing", () => {
    const cfg = {
      scheduleEnabled: true,
      timezone: "Broken/Zone",
      schedule: week({ mon: { enabled: true, start: "09:00", end: "18:00" } }),
    };
    assert.equal(isAiAgentWithinWorkingHours(cfg, new Date("2026-07-20T07:00:00Z")), true);
  });
});
