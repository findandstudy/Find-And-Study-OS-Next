import test from "node:test";
import assert from "node:assert/strict";
import {
  canChangeInboxStatus,
  inboxStatusPermission,
} from "../lib/inboxStatusPermissions";

test("inbox status controls use the same permission keys as entity detail pages", () => {
  assert.equal(inboxStatusPermission("lead"), "leads.change_stage");
  assert.equal(inboxStatusPermission("student"), "students.change_stage");
  assert.equal(inboxStatusPermission("application"), "applications.change_stage");
});

test("admin-tier roles can change all inbox statuses", () => {
  for (const role of ["super_admin", "admin", "manager"]) {
    assert.equal(canChangeInboxStatus(role, [], "lead"), true);
    assert.equal(canChangeInboxStatus(role, [], "student"), true);
    assert.equal(canChangeInboxStatus(role, [], "application"), true);
  }
});

test("non-admin roles only receive the explicitly granted entity permission", () => {
  const permissions = ["leads.change_stage"];
  assert.equal(canChangeInboxStatus("staff", permissions, "lead"), true);
  assert.equal(canChangeInboxStatus("staff", permissions, "student"), false);
  assert.equal(canChangeInboxStatus("staff", permissions, "application"), false);
  assert.equal(canChangeInboxStatus("staff", [], "lead"), false);
});
