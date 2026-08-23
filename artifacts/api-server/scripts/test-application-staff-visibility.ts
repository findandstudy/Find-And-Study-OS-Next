import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const routeSource = readFileSync(
  fileURLToPath(new URL("../src/routes/applications.ts", import.meta.url)),
  "utf8",
);

test("staff application list applies branch scope while admin roles stay global", () => {
  const listStart = routeSource.indexOf('router.get("/applications"');
  const detailStart = routeSource.indexOf('router.get("/applications/:id"');
  assert.ok(listStart >= 0 && detailStart > listStart);
  const listRoute = routeSource.slice(listStart, detailStart);

  const staffScopeStart = listRoute.indexOf("if (isStaff)");
  const studentScopeStart = listRoute.indexOf('} else if (user.role === "student")');
  assert.ok(staffScopeStart >= 0 && studentScopeStart > staffScopeStart);
  const staffScope = listRoute.slice(staffScopeStart, studentScopeStart);

  assert.doesNotMatch(staffScope, /getAssignmentVisibility|records\.view_others|applicationsTable\.agentId/);
  assert.match(staffScope, /GLOBAL_APPLICATION_STAFF_ROLES/);
  assert.match(staffScope, /applicationInStaffBranchScope/);
  assert.match(listRoute, /if \(!isStaff && user\.role !== "student"\)/);
});

test("legacy and effective-assignee signals keep historical applications visible", () => {
  const helperStart = routeSource.indexOf("function applicationInStaffBranchScope");
  const helperEnd = routeSource.indexOf("async function isStageFileUploadMandatory");
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = routeSource.slice(helperStart, helperEnd);

  assert.match(helper, /isNull\(applicationsTable\.branchId\)/);
  assert.match(helper, /application_assignee\.branch_id/);
  assert.match(helper, /student_assignee\.branch_id/);
  assert.match(helper, /studentsTable\.branchId/);
  assert.match(helper, /NOT EXISTS[\s\S]*branch_staff/);
});

test("staff application detail uses the same branch visibility policy", () => {
  const detailStart = routeSource.indexOf('router.get("/applications/:id"');
  const patchStart = routeSource.indexOf('router.patch("/applications/:id"');
  assert.ok(detailStart >= 0 && patchStart > detailStart);
  const detailRoute = routeSource.slice(detailStart, patchStart);

  assert.doesNotMatch(detailRoute, /isAgentSourcedAndBlockedForStaff|records\.view_others/);
  assert.match(detailRoute, /applicationInStaffBranchScope/);
  assert.match(detailRoute, /if \(!isStaff\)/);
});

test("staff application notes use the same branch read visibility", () => {
  const notesStart = routeSource.indexOf('router.get("/applications/:id/notes"');
  const notesEnd = routeSource.indexOf('router.post("/applications/:id/notes"');
  assert.ok(notesStart >= 0 && notesEnd > notesStart);
  const notesRoute = routeSource.slice(notesStart, notesEnd);

  assert.doesNotMatch(notesRoute, /isAgentSourcedAndBlockedForStaff|records\.view_others/);
  assert.match(notesRoute, /applicationInStaffBranchScope/);
  assert.match(notesRoute, /Application not found/);
});
