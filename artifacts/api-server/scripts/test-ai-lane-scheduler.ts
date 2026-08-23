import assert from "node:assert/strict";
import test from "node:test";
import { AiLaneQueueError, AiLaneScheduler } from "../src/lib/aiLaneScheduler";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

test("runs different lanes fairly while serializing one lane", async () => {
  const scheduler = new AiLaneScheduler({
    globalConcurrency: 2,
    perLaneConcurrency: 1,
    perConnectionConcurrency: 2,
    maxQueued: 10,
    maxQueuedPerLane: 5,
    maxWaitMs: 1_000,
  });
  const a1 = deferred<string>();
  const a2 = deferred<string>();
  const b1 = deferred<string>();
  const started: string[] = [];

  const pA1 = scheduler.run({ laneKey: "widget:a", connectionKey: "claude" }, async () => {
    started.push("a1");
    return a1.promise;
  });
  const pA2 = scheduler.run({ laneKey: "widget:a", connectionKey: "claude" }, async () => {
    started.push("a2");
    return a2.promise;
  });
  const pB1 = scheduler.run({ laneKey: "widget:b", connectionKey: "claude" }, async () => {
    started.push("b1");
    return b1.promise;
  });

  await tick();
  assert.deepEqual(started, ["a1", "b1"]);
  assert.equal(scheduler.snapshot().active, 2);
  a1.resolve("a1");
  await tick();
  await tick();
  assert.deepEqual(started, ["a1", "b1", "a2"]);
  a2.resolve("a2");
  b1.resolve("b1");
  assert.deepEqual(await Promise.all([pA1, pA2, pB1]), ["a1", "a2", "b1"]);
});

test("enforces a shared connection budget across independent lanes", async () => {
  const scheduler = new AiLaneScheduler({
    globalConcurrency: 3,
    perLaneConcurrency: 1,
    perConnectionConcurrency: 1,
    maxQueued: 10,
    maxQueuedPerLane: 5,
    maxWaitMs: 1_000,
  });
  const first = deferred<void>();
  const started: string[] = [];
  const p1 = scheduler.run({ laneKey: "website", connectionKey: "shared" }, async () => {
    started.push("website");
    await first.promise;
  });
  const p2 = scheduler.run({ laneKey: "widget:1", connectionKey: "shared" }, async () => {
    started.push("widget");
  });
  await tick();
  assert.deepEqual(started, ["website"]);
  first.resolve();
  await p1;
  await p2;
  assert.deepEqual(started, ["website", "widget"]);
});

test("allows separate API connections to use independent budgets", async () => {
  const scheduler = new AiLaneScheduler({
    globalConcurrency: 2,
    perLaneConcurrency: 1,
    perConnectionConcurrency: 1,
    maxQueued: 10,
    maxQueuedPerLane: 5,
    maxWaitMs: 1_000,
  });
  const release = deferred<void>();
  const started: string[] = [];
  const first = scheduler.run({ laneKey: "widget:1", connectionKey: "claude:widget1" }, async () => {
    started.push("widget1");
    await release.promise;
  });
  const second = scheduler.run({ laneKey: "widget:2", connectionKey: "claude:widget2" }, async () => {
    started.push("widget2");
    await release.promise;
  });
  await tick();
  assert.deepEqual(started, ["widget1", "widget2"]);
  release.resolve();
  await Promise.all([first, second]);
});

test("rejects overflow instead of retaining unbounded document payloads", async () => {
  const scheduler = new AiLaneScheduler({
    globalConcurrency: 1,
    perLaneConcurrency: 1,
    perConnectionConcurrency: 1,
    maxQueued: 1,
    maxQueuedPerLane: 1,
    maxWaitMs: 1_000,
  });
  const hold = deferred<void>();
  const first = scheduler.run({ laneKey: "website", connectionKey: "claude" }, () => hold.promise);
  await tick();
  const queued = scheduler.run({ laneKey: "widget:1", connectionKey: "claude" }, async () => undefined);
  await assert.rejects(
    scheduler.run({ laneKey: "widget:2", connectionKey: "claude" }, async () => undefined),
    (error: unknown) => error instanceof AiLaneQueueError && error.code === "AI_QUEUE_FULL",
  );
  hold.resolve();
  await first;
  await queued;
});

test("expires queued work when capacity does not become available", async () => {
  const scheduler = new AiLaneScheduler({
    globalConcurrency: 1,
    perLaneConcurrency: 1,
    perConnectionConcurrency: 1,
    maxQueued: 5,
    maxQueuedPerLane: 5,
    maxWaitMs: 20,
  });
  const hold = deferred<void>();
  const active = scheduler.run({ laneKey: "website", connectionKey: "claude" }, () => hold.promise);
  await tick();
  await assert.rejects(
    scheduler.run({ laneKey: "widget:1", connectionKey: "claude" }, async () => undefined),
    (error: unknown) => error instanceof AiLaneQueueError && error.code === "AI_QUEUE_TIMEOUT",
  );
  hold.resolve();
  await active;
  assert.equal(scheduler.snapshot().queued, 0);
});
