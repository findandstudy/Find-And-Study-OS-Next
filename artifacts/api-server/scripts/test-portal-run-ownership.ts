import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/routes/portalAutomation.ts", import.meta.url),
  "utf8",
);

test("a timed-out portal run keeps its original lock and heartbeat", () => {
  assert.match(source, /status:\s*"running"/);
  assert.match(source, /original lock retained/);
  assert.doesNotMatch(source, /requeueStuck\(sub\.id/);
  assert.match(source, /\.finally\(\(\) => \{\s*clearInterval\(hbInterval\)/s);
});

test("inline drains stop claiming rows while a browser continues", () => {
  const stopGuards = source.match(/if \(result\.status === "running"\) break;/g) ?? [];
  assert.equal(stopGuards.length, 2);
});

test("automatic enqueue leaves browser ownership to the dedicated worker", () => {
  const trigger = source.match(
    /export function triggerBackgroundDrain[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(trigger, "triggerBackgroundDrain implementation must exist");
  assert.match(trigger, /queued for dedicated portal worker/);
  assert.doesNotMatch(trigger, /drainQueue\(/);
});
