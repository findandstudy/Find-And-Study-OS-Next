import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_AI_AGENT_CONFIG,
  __setAiAgentConfigOverrideForTests,
  aiAgentPatchRequiresSuperAdmin,
  getExternalAiDeliveryBlockReason,
  getAiAgentConfig,
  isExternalAutoReplyEmergencyStopped,
} from "../src/lib/inbox/aiAgentConfig.js";

test("legacy and default configs keep customer-facing delivery off", async () => {
  assert.equal(DEFAULT_AI_AGENT_CONFIG.externalAutoReplyEnabled, false);
  __setAiAgentConfigOverrideForTests({ enabled: true });
  try {
    assert.equal((await getAiAgentConfig()).externalAutoReplyEnabled, false);
  } finally {
    __setAiAgentConfigOverrideForTests(null);
  }
});

test("activation transitions require Super Admin but stop transitions do not", () => {
  const safe = { ...DEFAULT_AI_AGENT_CONFIG };
  assert.equal(aiAgentPatchRequiresSuperAdmin(safe, { externalAutoReplyEnabled: true }), true);
  assert.equal(aiAgentPatchRequiresSuperAdmin({ ...safe, enabled: false }, { enabled: true }), true);
  assert.equal(aiAgentPatchRequiresSuperAdmin(safe, { defaultOnForNew: true }), true);
  assert.equal(
    aiAgentPatchRequiresSuperAdmin(
      { ...safe, externalAutoReplyEnabled: true },
      { externalAutoReplyEnabled: false },
    ),
    false,
  );
  assert.equal(aiAgentPatchRequiresSuperAdmin(safe, { enabled: false }), false);
});

test("the infrastructure kill switch recognizes only explicit stop values", () => {
  const previous = process.env.AI_EXTERNAL_AUTO_REPLY_KILL_SWITCH;
  try {
    for (const value of ["1", "true", "TRUE", "yes", "on"]) {
      process.env.AI_EXTERNAL_AUTO_REPLY_KILL_SWITCH = value;
      assert.equal(isExternalAutoReplyEmergencyStopped(), true, value);
    }
    for (const value of ["", "0", "false", "off", "unexpected"]) {
      process.env.AI_EXTERNAL_AUTO_REPLY_KILL_SWITCH = value;
      assert.equal(isExternalAutoReplyEmergencyStopped(), false, value);
    }
  } finally {
    if (previous === undefined) delete process.env.AI_EXTERNAL_AUTO_REPLY_KILL_SWITCH;
    else process.env.AI_EXTERNAL_AUTO_REPLY_KILL_SWITCH = previous;
  }
});

test("the provider boundary rejects unapproved and emergency-stopped sends", () => {
  assert.equal(
    getExternalAiDeliveryBlockReason(false),
    "external_ai_delivery_not_approved",
  );
  const previous = process.env.AI_EXTERNAL_AUTO_REPLY_KILL_SWITCH;
  try {
    process.env.AI_EXTERNAL_AUTO_REPLY_KILL_SWITCH = "true";
    assert.equal(
      getExternalAiDeliveryBlockReason(true),
      "external_ai_delivery_killed",
    );
  } finally {
    if (previous === undefined) delete process.env.AI_EXTERNAL_AUTO_REPLY_KILL_SWITCH;
    else process.env.AI_EXTERNAL_AUTO_REPLY_KILL_SWITCH = previous;
  }
});
