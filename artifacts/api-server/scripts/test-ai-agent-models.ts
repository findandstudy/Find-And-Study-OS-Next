import test from "node:test";
import assert from "node:assert/strict";
import {
  loadAnthropicModelOptions,
  mergeAiAgentModelOptions,
} from "../src/lib/inbox/aiAgentModels.js";

test("provider models are normalized, deduplicated and current is marked", () => {
  const options = mergeAiAgentModelOptions(
    [
      {
        id: "claude-opus-4-1",
        display_name: "Claude Opus 4.1",
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "claude-sonnet-4-6",
        display_name: "Claude Sonnet 4.6",
        created_at: "2026-02-01T00:00:00Z",
      },
      {
        id: "claude-sonnet-4-6",
        display_name: "Duplicate",
        created_at: "2026-02-01T00:00:00Z",
      },
    ],
    "claude-sonnet-4-6",
  );

  assert.deepEqual(
    options.map(({ id, current }) => ({ id, current })),
    [
      { id: "claude-opus-4-1", current: false },
      { id: "claude-sonnet-4-6", current: true },
    ],
  );
});

test("saved legacy model is retained when provider no longer lists it", () => {
  const options = mergeAiAgentModelOptions(
    [
      {
        id: "claude-sonnet-4-6",
        display_name: "Claude Sonnet 4.6",
        created_at: "2026-02-01T00:00:00Z",
      },
    ],
    "claude-haiku-legacy-alias",
  );

  assert.equal(options[0]?.id, "claude-haiku-legacy-alias");
  assert.equal(options[0]?.current, true);
  assert.equal(options[1]?.current, false);
});

test("model loader requests a bounded live provider list", async () => {
  let requestedLimit = 0;
  const options = await loadAnthropicModelOptions(
    {
      models: {
        async list({ limit }) {
          requestedLimit = limit;
          return {
            data: [
              {
                id: "claude-opus-live",
                display_name: "Claude Opus Live",
                created_at: "2026-03-01T00:00:00Z",
              },
            ],
          };
        },
      },
    },
    "claude-opus-live",
  );

  assert.equal(requestedLimit, 100);
  assert.equal(options[0]?.displayName, "Claude Opus Live");
  assert.equal(options[0]?.current, true);
});
