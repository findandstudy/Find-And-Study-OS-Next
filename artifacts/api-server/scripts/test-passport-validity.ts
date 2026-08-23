/**
 * passportValidity — unit tests (FAZ 2).
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:passport-validity
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFlexibleDate, isPassportExpired } from "../src/lib/passportValidity.js";

describe("parseFlexibleDate", () => {
  it("parses YYYY-MM-DD", () => {
    const d = parseFlexibleDate("2030-05-03");
    assert.ok(d);
    assert.equal(d!.toISOString().slice(0, 10), "2030-05-03");
  });
  it("parses DD.MM.YYYY", () => {
    const d = parseFlexibleDate("03.05.2035");
    assert.ok(d);
    assert.equal(d!.toISOString().slice(0, 10), "2035-05-03");
  });
  it("parses DD/MM/YYYY", () => {
    const d = parseFlexibleDate("15/08/2028");
    assert.ok(d);
    assert.equal(d!.toISOString().slice(0, 10), "2028-08-15");
  });
  it("rejects garbage and overflow dates", () => {
    assert.equal(parseFlexibleDate("garbage"), null);
    assert.equal(parseFlexibleDate(""), null);
    assert.equal(parseFlexibleDate("31.02.2030"), null);
    assert.equal(parseFlexibleDate("2030-13-01"), null);
  });
});

describe("isPassportExpired", () => {
  it("2020-01-01 → expired (true)", () => {
    assert.equal(isPassportExpired("2020-01-01"), true);
  });
  it("2099-12-31 → not expired (false)", () => {
    assert.equal(isPassportExpired("2099-12-31"), false);
  });
  it("03.05.2035 → not expired (false)", () => {
    assert.equal(isPassportExpired("03.05.2035"), false);
  });
  it("garbage → false (unparseable never blocks)", () => {
    assert.equal(isPassportExpired("garbage"), false);
  });
  it("null/undefined/empty → false", () => {
    assert.equal(isPassportExpired(null), false);
    assert.equal(isPassportExpired(undefined), false);
    assert.equal(isPassportExpired(""), false);
  });
  it("boundary: expiry today → NOT expired; yesterday → expired", () => {
    const now = new Date("2026-07-22T14:30:00Z");
    assert.equal(isPassportExpired("2026-07-22", now), false);
    assert.equal(isPassportExpired("2026-07-21", now), true);
    assert.equal(isPassportExpired("21.07.2026", now), true);
  });
});
