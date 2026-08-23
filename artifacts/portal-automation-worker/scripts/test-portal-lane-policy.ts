import { test } from "node:test";
import assert from "node:assert/strict";
import { concurrencyForPortalLane, loadPortalLanePolicy, parsePortalLaneConcurrency } from "../src/portalLanePolicy.js";

test("LP1: missing concurrency config preserves sequential worker behavior", () => {
  const policy = loadPortalLanePolicy({}, 300_000);
  assert.equal(policy.globalConcurrency, 1);
  assert.equal(policy.defaultLaneConcurrency, 1);
  assert.equal(policy.heartbeatMs, 30_000);
  assert.equal(policy.laneConcurrency.size, 0);
});

test("LP2: SIT can use two slots while other portal lanes remain single", () => {
  const policy = loadPortalLanePolicy(
    {
      WORKER_GLOBAL_CONCURRENCY: "3",
      WORKER_DEFAULT_LANE_CONCURRENCY: "1",
      WORKER_LANE_CONCURRENCY: "sit=2, topkapi=1",
      WORKER_HEARTBEAT_MS: "30000",
    },
    300_000,
  );

  assert.equal(concurrencyForPortalLane(policy, "SIT"), 2);
  assert.equal(concurrencyForPortalLane(policy, "topkapi"), 1);
  assert.equal(concurrencyForPortalLane(policy, "altinbas"), 1);
});

test("LP3: duplicate or malformed lane entries fail closed", () => {
  assert.throws(() => parsePortalLaneConcurrency("sit=2,sit=3"), /Duplicate portal lane/);
  assert.throws(() => parsePortalLaneConcurrency("sit:2"), /lane=slots/);
});

test("LP4: unsafe heartbeat and over-capacity overrides fail closed", () => {
  assert.throws(
    () =>
      loadPortalLanePolicy(
        {
          WORKER_GLOBAL_CONCURRENCY: "3",
          WORKER_LANE_CONCURRENCY: "sit=4",
        },
        300_000,
      ),
    /cannot exceed WORKER_GLOBAL_CONCURRENCY/,
  );
  assert.throws(() => loadPortalLanePolicy({ WORKER_HEARTBEAT_MS: "150000" }, 300_000), /less than half/);
});
