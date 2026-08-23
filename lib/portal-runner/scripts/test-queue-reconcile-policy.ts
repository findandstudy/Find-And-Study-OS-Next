import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStaleIneligibleQueueStatement } from "../src/queueReconcilePolicy.js";

test("empty portal allowlist performs no reconciliation", () => {
  assert.equal(buildStaleIneligibleQueueStatement([" ", ""], ["inquiry"], 86_400_000), null);
});

test("portal keys are trimmed/deduplicated and trigger stages are preserved", () => {
  const statement = buildStaleIneligibleQueueStatement(
    [" topkapi_university ", "topkapi", "topkapi"],
    ["inquiry", "documents_check"],
    86_400_000,
  );
  assert.ok(statement);
  assert.deepEqual(statement.values, [
    ["topkapi_university", "topkapi"],
    ["inquiry", "documents_check"],
    86_400_000,
  ]);
});

test("age threshold is clamped to one minute and invalid input defaults to one day", () => {
  const clamped = buildStaleIneligibleQueueStatement(["topkapi"], [], 1);
  const defaulted = buildStaleIneligibleQueueStatement(["topkapi"], [], Number.NaN);
  assert.equal(clamped?.values[2], 60_000);
  assert.equal(defaulted?.values[2], 86_400_000);
});

test("SQL contract excludes manual runs and requires stale, queued, stage-ineligible rows", () => {
  const statement = buildStaleIneligibleQueueStatement(["topkapi"], ["inquiry"], 86_400_000);
  assert.ok(statement);
  assert.match(statement.text, /ps\.status = 'queued'/);
  assert.match(statement.text, /ps\.created_at < NOW\(\)/);
  assert.match(statement.text, /ps\.meta->>'manual'.*<> 'true'/s);
  assert.match(statement.text, /a\.deleted_at IS NOT NULL/);
  assert.match(statement.text, /NOT \(a\.stage = ANY\(\$2::text\[\]\)\)/);
  assert.match(statement.text, /RETURNING ps\.id/);
});
