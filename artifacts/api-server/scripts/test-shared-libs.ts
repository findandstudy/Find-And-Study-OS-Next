/**
 * Unit tests for the shared @workspace lib packages introduced in Task #144.
 *
 * Uses node:test (built-in, no install) — same pattern as the rest of the
 * api-server scripts/test-*.ts suite.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  STAFF_ROLES,
  ADMIN_ROLES,
  AGENT_ROLES,
  MANAGER_ROLES,
  isAgentRole,
  isStaffRole,
} from "@workspace/roles";
import {
  parsePaginationParams,
  buildPageMeta,
  MAX_LIMIT_BY_SIZE,
} from "@workspace/pagination";
import { formatDate, formatRelativeTime } from "@workspace/i18n";
import {
  APPLICATION_DOCUMENT_MAX_SIZE,
  validateApplicationDocumentFile,
} from "@workspace/file-upload-validation";
import {
  buildOrganizationSchema,
  CORPORATE_FACTS,
  renderLlmsText,
} from "@workspace/corporate-facts";

test("corporate schema and llms.txt use the same canonical facts", () => {
  const schema = buildOrganizationSchema() as Record<string, unknown>;
  const llms = renderLlmsText();
  assert.equal(schema.name, CORPORATE_FACTS.name);
  assert.equal(schema.url, CORPORATE_FACTS.canonicalUrl);
  assert.match(llms, new RegExp(CORPORATE_FACTS.name));
  assert.match(llms, new RegExp(CORPORATE_FACTS.applicationUrl.replaceAll(".", "\\.")));
  assert.doesNotMatch(llms, /Founded|founded|2010|2018|500\+|70\+/);
});

test("portal routing rejects stale SIT memberships before enqueue", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/lib/portalAutoTrigger.ts", import.meta.url)),
    "utf8",
  );
  assert.match(source, /aggregator\.adapterKey === "sit"/);
  assert.match(source, /isSitExcludedUniversity\(memberName\)/);
  assert.match(source, /ignored excluded SIT membership/);
});

test("@workspace/roles: STAFF_ROLES contains the canonical set", () => {
  assert.ok(STAFF_ROLES.includes("super_admin"));
  assert.ok(STAFF_ROLES.includes("admin"));
  assert.ok(STAFF_ROLES.includes("manager"));
  assert.ok(STAFF_ROLES.includes("staff"));
});

test("@workspace/roles: ADMIN_ROLES is a subset of STAFF_ROLES", () => {
  const staff: string[] = [...STAFF_ROLES];
  for (const r of ADMIN_ROLES) assert.ok(staff.includes(r), `${r} missing from staff`);
});

test("@workspace/roles: AGENT_ROLES contains the agent family", () => {
  assert.ok(AGENT_ROLES.includes("agent"));
  assert.ok(AGENT_ROLES.includes("sub_agent"));
});

test("@workspace/roles: MANAGER_ROLES contains manager + admins", () => {
  assert.ok(MANAGER_ROLES.includes("manager"));
  assert.ok(MANAGER_ROLES.includes("admin"));
});

test("@workspace/roles: isAgentRole / isStaffRole behaviour", () => {
  assert.equal(isAgentRole("agent"), true);
  assert.equal(isAgentRole("sub_agent"), true);
  assert.equal(isAgentRole("staff"), false);
  assert.equal(isAgentRole(undefined), false);
  assert.equal(isStaffRole("staff"), true);
  assert.equal(isStaffRole("agent"), false);
});

test("@workspace/pagination: defaults when no query supplied", () => {
  const p = parsePaginationParams({ query: {} });
  assert.equal(p.page, 1);
  assert.equal(p.limit, 20);
  assert.equal(p.offset, 0);
});

test("@workspace/pagination: clamps limit to maxLimit (named size)", () => {
  const p = parsePaginationParams({ query: { page: "2", limit: "9999" } }, { maxLimit: "small" });
  assert.equal(p.page, 2);
  assert.equal(p.limit, MAX_LIMIT_BY_SIZE.small);
  assert.equal(p.offset, MAX_LIMIT_BY_SIZE.small);
});

test("@workspace/pagination: clamps page to >=1 and parses garbage as fallback", () => {
  const p = parsePaginationParams({ query: { page: "-3", limit: "abc" } }, { defaultLimit: 25 });
  assert.equal(p.page, 1);
  assert.equal(p.limit, 25);
  assert.equal(p.offset, 0);
});

test("@workspace/pagination: numeric maxLimit override works", () => {
  const p = parsePaginationParams({ query: { limit: "1000" } }, { maxLimit: 75 });
  assert.equal(p.limit, 75);
});

test("@workspace/pagination: buildPageMeta produces stable shape", () => {
  const params = parsePaginationParams({ query: { page: "3", limit: "20" } });
  const meta = buildPageMeta(143, params);
  assert.deepEqual(meta, { total: 143, page: 3, limit: 20, totalPages: 8 });
});

test("@workspace/pagination: buildPageMeta returns 0 totalPages when total=0", () => {
  const params = parsePaginationParams({ query: {} });
  assert.equal(buildPageMeta(0, params).totalPages, 0);
});

test("@workspace/i18n: formatDate returns empty for null/invalid", () => {
  assert.equal(formatDate(null), "");
  assert.equal(formatDate(undefined), "");
  assert.equal(formatDate(""), "");
  assert.equal(formatDate("not-a-date"), "");
});

test("@workspace/i18n: formatDate('tr', 'date') produces dd.mm.yyyy", () => {
  const d = new Date("2026-05-13T12:00:00Z");
  assert.equal(formatDate(d, "tr", "date"), "13.05.2026");
});

test("@workspace/i18n: formatDate accepts custom Intl options", () => {
  const d = new Date("2026-05-13T12:00:00Z");
  const out = formatDate(d, "tr", { day: "2-digit", month: "2-digit", year: "numeric" });
  // tr-TR formats DD.MM.YYYY
  assert.match(out, /^\d{2}\.\d{2}\.\d{4}$/);
});

test("@workspace/i18n: formatRelativeTime handles seconds-ago", () => {
  const now = new Date();
  const tenSecAgo = new Date(now.getTime() - 10_000);
  const out = formatRelativeTime(tenSecAgo, "en", now);
  assert.match(out, /second/);
});

test("@workspace/i18n: formatRelativeTime handles future days", () => {
  const now = new Date();
  const inFiveDays = new Date(now.getTime() + 5 * 86_400_000);
  const out = formatRelativeTime(inFiveDays, "en", now);
  assert.match(out, /day/);
});

test("application documents accept supported files up to exactly 5 MB", () => {
  assert.equal(
    validateApplicationDocumentFile("passport.pdf", "application/pdf", APPLICATION_DOCUMENT_MAX_SIZE),
    null,
  );
  assert.equal(
    validateApplicationDocumentFile("photo.jpg", "image/jpeg", APPLICATION_DOCUMENT_MAX_SIZE),
    null,
  );
});

test("application documents reject files over 5 MB and mismatched extensions", () => {
  assert.equal(
    validateApplicationDocumentFile("passport.pdf", "application/pdf", APPLICATION_DOCUMENT_MAX_SIZE + 1)?.type,
    "size_exceeded",
  );
  assert.equal(
    validateApplicationDocumentFile("passport.jpg", "application/pdf", 1024)?.type,
    "mime_extension_mismatch",
  );
});
