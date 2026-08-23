/**
 * test-db-loader.ts — unit tests for the DB declarative adapter loader.
 *
 * Covers (no real DB, no real browser):
 *   - parseDeclarativeConfig: valid config, empty {}, malformed, URL safety, fill xor
 *   - isSafePortalUrl: https/public allowed; http, private/loopback/link-local blocked
 *   - buildDeclarativeAdaptersFromRows: merge, code-priority skip, skip-invalid
 *     without crashing, inactive/deleted/code-kind skipped, zero-rows == empty
 *   - rowToRawConfig: config_json source-of-truth with column fallbacks
 *
 * Run:
 *   pnpm --filter @workspace/portal-adapters test:db-loader
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";

import {
  parseDeclarativeConfig,
  isSafePortalUrl,
  rowToRawConfig,
  buildDeclarativeAdaptersFromRows,
  staticAdapterKeys,
  type DeclarativeAdapterRow,
} from "../src/dbLoader.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validConfig = {
  key: "uskudar",
  label: "Üsküdar Üniversitesi",
  matches: ["uskudar", "üsküdar"],
  loginUrl: "https://apply.uskudar.edu.tr/login",
  credentials: {
    userSelector: "#email",
    passSelector: "#password",
    submitSelector: "button[type=submit]",
    afterSelector: ".dashboard",
  },
  steps: [
    { type: "navigate", url: "https://apply.uskudar.edu.tr/new" },
    { type: "fill", selector: "#firstName", field: "firstName" },
    { type: "fill", selector: "#note", value: "static text" },
    { type: "select", selector: "#gender", field: "gender" },
    { type: "upload", selector: "#passport", fileField: "passport" },
    { type: "wait", selector: ".loaded" },
    { type: "screenshot" },
    { type: "click", selector: "#submitBtn" },
  ],
  submitCheck: { successText: "başvurunuz alınmıştır" },
};

function makeRow(over: Partial<DeclarativeAdapterRow> = {}): DeclarativeAdapterRow {
  return {
    key: "testportal",
    label: "Üsküdar Üniversitesi",
    baseUrl: "https://apply.uskudar.edu.tr/login",
    matchNames: "uskudar, üsküdar",
    kind: "declarative",
    configJson: {
      loginUrl: "https://apply.uskudar.edu.tr/login",
      credentials: {
        userSelector: "#email",
        passSelector: "#password",
        submitSelector: "button[type=submit]",
      },
      steps: [
        { type: "navigate", url: "https://apply.uskudar.edu.tr/new" },
        { type: "click", selector: "#submitBtn" },
      ],
      submitCheck: { successText: "ok" },
    },
    isActive: true,
    deletedAt: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// parseDeclarativeConfig
// ---------------------------------------------------------------------------

test("parse: valid config is accepted", () => {
  const res = parseDeclarativeConfig(validConfig);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.config.key, "uskudar");
    assert.equal(res.config.steps.length, 8);
  }
});

test("parse: empty {} is rejected", () => {
  const res = parseDeclarativeConfig({});
  assert.equal(res.ok, false);
});

test("parse: missing credentials is rejected", () => {
  const { credentials: _omit, ...rest } = validConfig;
  const res = parseDeclarativeConfig(rest);
  assert.equal(res.ok, false);
});

test("parse: empty steps array is rejected", () => {
  const res = parseDeclarativeConfig({ ...validConfig, steps: [] });
  assert.equal(res.ok, false);
});

test("parse: empty matches array is rejected", () => {
  const res = parseDeclarativeConfig({ ...validConfig, matches: [] });
  assert.equal(res.ok, false);
});

test("parse: uppercase key is rejected", () => {
  const res = parseDeclarativeConfig({ ...validConfig, key: "Uskudar" });
  assert.equal(res.ok, false);
});

test("parse: http loginUrl is rejected (URL safety)", () => {
  const res = parseDeclarativeConfig({
    ...validConfig,
    loginUrl: "http://apply.uskudar.edu.tr/login",
  });
  assert.equal(res.ok, false);
});

test("parse: private-host loginUrl is rejected (SSRF)", () => {
  for (const host of [
    "https://localhost/login",
    "https://127.0.0.1/login",
    "https://10.0.0.5/login",
    "https://169.254.169.254/latest/meta-data",
    "https://192.168.1.10/login",
  ]) {
    const res = parseDeclarativeConfig({ ...validConfig, loginUrl: host });
    assert.equal(res.ok, false, `expected ${host} to be rejected`);
  }
});

test("parse: navigate step with unsafe URL is rejected", () => {
  const res = parseDeclarativeConfig({
    ...validConfig,
    steps: [{ type: "navigate", url: "http://10.0.0.1/x" }, { type: "click", selector: "#s" }],
  });
  assert.equal(res.ok, false);
});

test("parse: fill step requires exactly one of field/value", () => {
  const both = parseDeclarativeConfig({
    ...validConfig,
    steps: [{ type: "fill", selector: "#a", field: "firstName", value: "x" }],
  });
  assert.equal(both.ok, false);

  const neither = parseDeclarativeConfig({
    ...validConfig,
    steps: [{ type: "fill", selector: "#a" }],
  });
  assert.equal(neither.ok, false);
});

test("parse: unknown profile field is rejected", () => {
  const res = parseDeclarativeConfig({
    ...validConfig,
    steps: [{ type: "select", selector: "#g", field: "notARealField" }],
  });
  assert.equal(res.ok, false);
});

// ---------------------------------------------------------------------------
// isSafePortalUrl
// ---------------------------------------------------------------------------

test("isSafePortalUrl: https public allowed, unsafe rejected", () => {
  assert.equal(isSafePortalUrl("https://apply.uskudar.edu.tr/x"), true);
  assert.equal(isSafePortalUrl("http://apply.uskudar.edu.tr/x"), false);
  assert.equal(isSafePortalUrl("https://localhost/x"), false);
  assert.equal(isSafePortalUrl("https://127.0.0.1/x"), false);
  assert.equal(isSafePortalUrl("https://169.254.169.254/x"), false);
  assert.equal(isSafePortalUrl("ftp://example.com/x"), false);
  assert.equal(isSafePortalUrl("not a url"), false);
});

test("isSafePortalUrl: bracketed IPv6 loopback/private/link-local blocked", () => {
  for (const url of [
    "https://[::1]/x", //          loopback
    "https://[::]/x", //           unspecified
    "https://[fd00::1]/x", //      ULA (fc00::/7)
    "https://[fc00::1]/x", //      ULA
    "https://[fe80::1]/x", //      link-local
    "https://[fe80::1%25eth0]/x", // link-local with zone id
    "https://[::ffff:127.0.0.1]/x", // IPv4-mapped loopback
    "https://[::ffff:169.254.169.254]/x", // IPv4-mapped metadata
  ]) {
    assert.equal(isSafePortalUrl(url), false, `expected ${url} to be blocked`);
  }
  // A public IPv6 host must still be allowed.
  assert.equal(isSafePortalUrl("https://[2606:4700:4700::1111]/x"), true);
});

test("isSafePortalUrl: integer/hex IPv4 loopback forms blocked", () => {
  // The WHATWG URL parser normalizes these to dotted-quad 127.0.0.1.
  assert.equal(isSafePortalUrl("https://2130706433/x"), false);
  assert.equal(isSafePortalUrl("https://0x7f000001/x"), false);
});

// ---------------------------------------------------------------------------
// rowToRawConfig
// ---------------------------------------------------------------------------

test("rowToRawConfig: matches falls back to matchNames column", () => {
  const raw = rowToRawConfig(makeRow());
  assert.deepEqual(raw.matches, ["uskudar", "üsküdar"]);
});

test("rowToRawConfig: config_json.matches wins over column", () => {
  const row = makeRow({
    configJson: { ...(makeRow().configJson as object), matches: ["override"] },
  });
  const raw = rowToRawConfig(row);
  assert.deepEqual(raw.matches, ["override"]);
});

test("rowToRawConfig: loginUrl falls back to baseUrl column", () => {
  const row = makeRow({
    baseUrl: "https://fallback.example.edu/login",
    configJson: {
      credentials: {
        userSelector: "#e",
        passSelector: "#p",
        submitSelector: "#s",
      },
      steps: [{ type: "click", selector: "#s" }],
    },
  });
  const raw = rowToRawConfig(row);
  assert.equal(raw.loginUrl, "https://fallback.example.edu/login");
});

// ---------------------------------------------------------------------------
// buildDeclarativeAdaptersFromRows
// ---------------------------------------------------------------------------

test("build: zero rows yields empty list", () => {
  assert.deepEqual(buildDeclarativeAdaptersFromRows([]), []);
});

test("build: a valid declarative row becomes a working adapter", () => {
  const list = buildDeclarativeAdaptersFromRows([makeRow()]);
  assert.equal(list.length, 1);
  assert.equal(list[0].key, "testportal");
  assert.equal(list[0].matches("Uskudar Universitesi"), true);
  assert.equal(list[0].matches("Bogazici"), false);
});

test("build: key reserved by a code adapter is skipped (code wins)", () => {
  const reserved = new Set(["testportal"]);
  const list = buildDeclarativeAdaptersFromRows([makeRow()], reserved);
  assert.equal(list.length, 0);
});

test("build: real static code keys are reserved by default", () => {
  const codeKeys = staticAdapterKeys();
  assert.ok(codeKeys.length > 0, "expected at least one static code adapter");
  const row = makeRow({ key: codeKeys[0] });
  const list = buildDeclarativeAdaptersFromRows([row]);
  assert.equal(list.length, 0);
});

test("build: inactive / soft-deleted / code-kind rows are skipped", () => {
  assert.equal(buildDeclarativeAdaptersFromRows([makeRow({ isActive: false })]).length, 0);
  assert.equal(buildDeclarativeAdaptersFromRows([makeRow({ deletedAt: new Date() })]).length, 0);
  assert.equal(buildDeclarativeAdaptersFromRows([makeRow({ kind: "code" })]).length, 0);
});

test("build: invalid config (demo_portal {}) is skipped without crashing", () => {
  const bad = makeRow({ key: "demo_portal", matchNames: "demo", configJson: {} });
  const list = buildDeclarativeAdaptersFromRows([bad]);
  assert.deepEqual(list, []);
});

test("build: one bad row never blocks the good rows", () => {
  const good = makeRow({ key: "good_portal", matchNames: "good" });
  const bad = makeRow({ key: "bad_portal", matchNames: "bad", configJson: {} });
  const list = buildDeclarativeAdaptersFromRows([bad, good]);
  assert.equal(list.length, 1);
  assert.equal(list[0].key, "good_portal");
});

test("build: duplicate DB keys keep only the first", () => {
  const a = makeRow({ key: "dup", matchNames: "dup" });
  const b = makeRow({ key: "dup", matchNames: "dup", label: "Second" });
  const list = buildDeclarativeAdaptersFromRows([a, b]);
  assert.equal(list.length, 1);
  assert.equal(list[0].label, "Üsküdar Üniversitesi");
});

// pg Pool (via @workspace/db) keeps the event loop alive; force a clean exit.
after(() => {
  setImmediate(() => process.exit(process.exitCode ?? 0));
});
