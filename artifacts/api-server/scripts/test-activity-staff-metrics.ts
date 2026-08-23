import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const statsSource = readFileSync(new URL("../src/routes/stats.ts", import.meta.url), "utf8");
const activitySource = readFileSync(new URL("../src/routes/activityV1.ts", import.meta.url), "utf8");
const activityUiSource = readFileSync(
  new URL("../../edcons/src/pages/admin/Activity.tsx", import.meta.url),
  "utf8",
);
const taskSchemaSource = readFileSync(
  new URL("../../../lib/db/src/schema/tasks.ts", import.meta.url),
  "utf8",
);

test("staff message totals use assignee for inbound and actual sender for outbound", () => {
  assert.match(
    statsSource,
    /m\.direction = 'inbound' AND c\.assigned_to_id = \$\{staffFilter\}/,
  );
  assert.match(
    statsSource,
    /m\.direction = 'outbound' AND m\.sender_id = \$\{staffFilter\}/,
  );
  assert.match(
    statsSource,
    /m\.direction = 'outbound' AND m\.sender_id IS NOT NULL/,
    "All Staff must not credit sender-less AI/system replies to people",
  );
});

test("response time is first unanswered inbound to a sender-backed human reply", () => {
  assert.match(statsSource, /WITH human_replies AS \([\s\S]*?m\.sender_id IS NOT NULL/);
  assert.match(
    statsSource,
    /ORDER BY mi\.created_at ASC, mi\.id ASC[\s\S]*?LIMIT 1/,
    "A burst of customer messages must start timing at its first unanswered message",
  );
  assert.match(
    statsSource,
    /first_unanswered[\s\S]*?\(mi\.created_at, mi\.id\) > \(last_human\.created_at, last_human\.id\)/,
  );
  assert.match(statsSource, /p\.first_reply_sender_id = \$\{staffFilter\}/);
});

test("task and follow-up success metrics are explicit and completion timestamps are stored", () => {
  assert.match(statsSource, /completionRate: percentage\(taskRow\.completed_due, taskRow\.due_in_period\)/);
  assert.match(statsSource, /onTimeRate: percentage\(taskRow\.on_time, taskRow\.completed_due\)/);
  assert.match(statsSource, /completionRate: percentage\(followUpRow\.completed_scheduled, followUpRow\.scheduled\)/);
  assert.match(statsSource, /onTimeRate: percentage\(followUpRow\.on_time, followUpRow\.completed_scheduled\)/);
  assert.match(taskSchemaSource, /completedAt: timestamp\("completed_at"/);
});

test("panel applies the same exact date range and staff filter to activity and performance data", () => {
  assert.match(activitySource, /from: z\.string\(\)\.datetime\(\)\.optional\(\)/);
  assert.match(activitySource, /to: z\.string\(\)\.datetime\(\)\.optional\(\)/);
  assert.match(
    activityUiSource,
    /useGetActivitySummary\(\{[\s\S]*?staffId,[\s\S]*?from: from\.toISOString\(\),[\s\S]*?to: to\.toISOString\(\)/,
  );
  assert.match(
    activityUiSource,
    /useGetKommoSummary\(\{ from: from\.toISOString\(\), to: to\.toISOString\(\), staffId \}\)/,
  );
  assert.match(activityUiSource, /kom\?\.tasks\?\.completionRate/);
  assert.match(activityUiSource, /kom\?\.followUps\?\.onTimeRate/);
});
