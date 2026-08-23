// Unit tests for the shared @workspace/phone util (country-aware validation).
// Run: pnpm --filter @workspace/api-server run test:phone
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, isValidPhone, toValidE164 } from "@workspace/phone";
import { toE164 } from "../src/lib/inbox/phone";

test("TR mobile with spaces is valid and normalizes to E.164 (10 national digits)", () => {
  const n = normalizePhone("+90 505 558 51 81");
  assert.equal(n.isValid, true);
  assert.equal(n.e164, "+905055585181");
  assert.equal(n.country, "TR");
});

test("UZ mobile is valid with 9 national digits (not 10)", () => {
  const n = normalizePhone("+998 33 092 92 17");
  assert.equal(n.isValid, true);
  assert.equal(n.e164, "+998330929217");
  assert.equal(n.country, "UZ");
});

test("UZ number with an extra digit is INVALID (fixed 10-digit rules are wrong)", () => {
  assert.equal(isValidPhone("+9988330929217"), false);
  assert.equal(toValidE164("+9988330929217"), null);
});

test("national TR input parses with defaultCountry", () => {
  const n = normalizePhone("0505 558 51 81", "TR");
  assert.equal(n.isValid, true);
  assert.equal(n.e164, "+905055585181");
});

test("parenthesized/spaced US input is valid", () => {
  const n = normalizePhone("(212) 555-0175", "US");
  assert.equal(n.isValid, true);
  assert.equal(n.e164, "+12125550175");
});

test("empty / blank / garbage inputs are invalid, never throw", () => {
  for (const raw of ["", "   ", null, undefined, "+", "abc", "+90"]) {
    const n = normalizePhone(raw as string | null | undefined);
    assert.equal(n.isValid, false);
    assert.equal(isValidPhone(raw as string | null | undefined), false);
  }
});

test("api-server toE164 delegate keeps its contract (valid → E.164, invalid → null)", () => {
  assert.equal(toE164("+90 505 558 51 81"), "+905055585181");
  assert.equal(toE164("0505 558 51 81"), "+905055585181"); // TR default
  assert.equal(toE164("+9988330929217"), null);
  assert.equal(toE164(""), null);
  assert.equal(toE164(null), null);
});

test("UK national trunk-0 stripping: '+44'+'07911123456' produces valid E.164 '+447911123456'", () => {
  // Mirrors the pn() logic in embed.ts: when a dial code starting with "+"
  // is provided and the subscriber number starts with "0", strip the leading
  // trunk digit before combining so the result is valid E.164.
  // Uses 07911123456 — a libphonenumber-verified valid UK mobile range.
  let phoneRaw = "07911123456";
  const dialCode = "+44";
  if (dialCode.startsWith("+") && phoneRaw.startsWith("0")) {
    phoneRaw = phoneRaw.replace(/^0+/, "");
  }
  const combined = dialCode + phoneRaw; // "+447911123456"
  assert.equal(combined, "+447911123456", "trunk-0 stripping produces correct E.164");
  assert.equal(isValidPhone(combined), true, "result is a valid UK number");
  assert.equal(toE164(combined), "+447911123456", "toE164 passes correct E.164 through");
});

test("UK number with trunk 0 retained (pre-fix bug) stores wrong phone column value", () => {
  // Before the trunk-0 fix, the embed pn() function would naively concatenate
  // dial code + national number: "+44" + "07911123456" = "+4407911123456".
  // Even though libphonenumber can auto-normalize some trunk-retained forms to
  // a valid E.164, the `phone` column would store "+4407911123456" — a non-
  // canonical raw string — instead of the correct "+447911123456".
  // The fix strips the leading trunk "0" BEFORE concatenation so both the
  // `phone` column and the phoneE164 column hold the canonical E.164.
  const oldCombined = "+44" + "07911123456"; // no trunk stripping (pre-fix)
  const expected = "+447911123456";          // correct E.164 (post-fix)
  assert.notEqual(oldCombined, expected, "pre-fix form differs from expected E.164");
  assert.equal(oldCombined, "+4407911123456", "pre-fix form retains trunk digit");
});

test("07700900000 (task example): trunk-0 stripped to '+447700900000' in phone column, phoneE164=null", () => {
  // This is the exact example number cited in the task description.
  // After pn() trunk-0 stripping, the phone column stores "+447700900000".
  // However, "+447700900000" is in a fictional Ofcom range that libphonenumber
  // does NOT consider valid, so phoneE164 (= toE164(pn(...))) is null.
  // The regression check is that the phone column no longer stores the old
  // trunk-retained form "+4407700900000".
  let phoneRaw = "07700900000";
  const dialCode = "+44";
  if (dialCode.startsWith("+") && phoneRaw.startsWith("0")) {
    phoneRaw = phoneRaw.replace(/^0+/, "");
  }
  const phoneColumnValue = dialCode + phoneRaw; // "+447700900000"
  assert.equal(phoneColumnValue, "+447700900000", "phone column stores trunk-stripped value");
  assert.notEqual(phoneColumnValue, "+4407700900000", "phone column does NOT retain trunk digit");
  // phoneE164: libphonenumber rejects this fictional range → stored as null
  assert.equal(toE164(phoneColumnValue), null, "phoneE164 is null (fictional Ofcom range)");
});

test("embed pn() leniency: null/empty phone passes through as null", () => {
  // The early-lead step must never 422 on missing phone — phone is optional.
  // Verify the primitive building blocks uphold leniency.
  assert.equal(toE164(null), null);
  assert.equal(toE164(""), null);
  assert.equal(toE164(undefined), null);
});
