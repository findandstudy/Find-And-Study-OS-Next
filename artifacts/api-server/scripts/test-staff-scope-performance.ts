import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  applyPermissionOverrides,
  getAssignmentVisibility,
  getEffectivePermissionSet,
} from "../src/lib/permissions";
import { getVisibleBranchIds } from "../src/lib/branchScope";

const applicationsRouteSource = readFileSync(
  new URL("../src/routes/applications.ts", import.meta.url),
  "utf8",
);
const leadsRouteSource = readFileSync(
  new URL("../src/routes/leads.ts", import.meta.url),
  "utf8",
);
const studentsRouteSource = readFileSync(
  new URL("../src/routes/students.ts", import.meta.url),
  "utf8",
);
const applicationsPageSource = readFileSync(
  new URL("../../edcons/src/pages/staff/Applications.tsx", import.meta.url),
  "utf8",
);
const authMiddlewareSource = readFileSync(
  new URL("../src/middlewares/authMiddleware.ts", import.meta.url),
  "utf8",
);
const studentPhotoSource = readFileSync(
  new URL("../src/lib/studentPhoto.ts", import.meta.url),
  "utf8",
);

test("pre-resolved request permissions preserve grants and revocations without a DB lookup", async () => {
  const permissions = await getEffectivePermissionSet({
    id: 42,
    role: "staff",
    effectivePermissions: ["students.view", "records.view_unassigned"],
  });

  assert.deepEqual(
    [...permissions].sort(),
    ["records.view_unassigned", "students.view"],
  );
});

test("permission overrides remain authoritative over role permissions", () => {
  const permissions = applyPermissionOverrides(
    ["students.view", "records.view_others"],
    {
      "records.view_others": false,
      "documents.view": true,
    },
  );

  assert.equal(permissions.has("students.view"), true);
  assert.equal(permissions.has("records.view_others"), false);
  assert.equal(permissions.has("documents.view"), true);
});

test("record visibility grants remain independent", () => {
  assert.equal(getAssignmentVisibility(new Set()), "own");
  assert.equal(
    getAssignmentVisibility(new Set(["records.view_unassigned"])),
    "own_or_unassigned",
  );
  assert.equal(
    getAssignmentVisibility(new Set(["records.view_others"])),
    "assigned",
  );
  assert.equal(
    getAssignmentVisibility(new Set([
      "records.view_others",
      "records.view_unassigned",
    ])),
    "all",
  );
});

test("request branch context avoids re-reading the user row", async () => {
  assert.deepEqual(
    await getVisibleBranchIds(42, "staff", {
      branchId: 7,
      managingAgentId: null,
    }),
    [7],
  );
  assert.deepEqual(
    await getVisibleBranchIds(42, "staff", {
      branchId: null,
      managingAgentId: null,
    }),
    [],
  );
  assert.equal(await getVisibleBranchIds(1, "super_admin"), null);
});

test("application pipeline uses one grouped summary and skips repeated totals", () => {
  assert.match(applicationsRouteSource, /pipelineSummaryOnly/);
  assert.match(applicationsRouteSource, /groupBy\(filteredApplications\.stage\)/);
  assert.match(applicationsPageSource, /pipelineSummaryParams/);
  assert.match(applicationsPageSource, /params\.set\("includeTotals", "0"\)/);
  assert.match(applicationsPageSource, /visiblePipelineStages\.has\(stageDef\.key\)/);
});

test("list avatars use short-lived signed URLs without repeating session auth", () => {
  assert.match(applicationsRouteSource, /studentPhotoUrl: rest\.studentHasPhoto/);
  assert.match(authMiddlewareSource, /signedPhotoMatch/);
  assert.match(authMiddlewareSource, /verifyStudentPhotoSignature\(studentId, exp, sig\)/);
});

test("student avatar lists derive photo availability from the canonical document record", () => {
  assert.match(studentPhotoSource, /studentHasServablePhotoSql/);
  assert.match(studentPhotoSource, /IN \('photo', 'photograph'\)/);
  assert.match(studentPhotoSource, /deletedAt\} IS NULL/);
  assert.match(studentPhotoSource, /ORDER BY .*createdAt\} DESC, .*id\} DESC/s);
  for (const source of [applicationsRouteSource, leadsRouteSource, studentsRouteSource]) {
    assert.match(source, /studentHasServablePhotoSql\(\)/);
  }
});

test("facet caches are keyed by freshly resolved authorization outputs", () => {
  for (const source of [leadsRouteSource, studentsRouteSource, applicationsRouteSource]) {
    assert.match(source, /loadFacetValue\(/);
    assert.match(source, /userId: user\.id/);
    assert.match(source, /role: user\.role/);
    assert.match(source, /visibleBranchIds:/);
    assert.match(source, /agentVisibleIds:/);
  }
  assert.match(leadsRouteSource, /permissions: staffPerms \? \[\.\.\.staffPerms\]\.sort\(\) : null/);
  assert.match(studentsRouteSource, /permissions: permissionKeys/);
  assert.match(applicationsRouteSource, /permissions: permissionKeys/);
  assert.match(studentsRouteSource, /agencyAgentIds:/);
  assert.match(applicationsRouteSource, /agencyAgentIds:/);
});
