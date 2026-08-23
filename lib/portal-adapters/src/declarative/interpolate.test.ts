import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { interpolate } from "./interpolate.js";

const emptyCtx = { profile: {}, vars: {}, captured: {} };

describe("interpolate", () => {
  it("passes through a plain string with no placeholders", () => {
    assert.equal(interpolate("hello world", emptyCtx), "hello world");
  });

  it("resolves {{profile.x}}", () => {
    const ctx = { ...emptyCtx, profile: { email: "test@example.com" } };
    assert.equal(interpolate("user={{profile.email}}", ctx), "user=test@example.com");
  });

  it("resolves {{vars.y}}", () => {
    const ctx = { ...emptyCtx, vars: { token: "abc123" } };
    assert.equal(interpolate("Bearer {{vars.token}}", ctx), "Bearer abc123");
  });

  it("resolves {{captured.z}}", () => {
    const ctx = { ...emptyCtx, captured: { sessionId: "sess-99" } };
    assert.equal(interpolate("sid={{captured.sessionId}}", ctx), "sid=sess-99");
  });

  it("resolves multiple placeholders in one pass", () => {
    const ctx = {
      profile: { firstName: "Alice" },
      vars: { role: "admin" },
      captured: { id: "42" },
    };
    const tmpl = "{{profile.firstName}}:{{vars.role}}:{{captured.id}}";
    assert.equal(interpolate(tmpl, ctx), "Alice:admin:42");
  });

  it("expands unknown key to empty string", () => {
    assert.equal(interpolate("{{profile.nonexistent}}", emptyCtx), "");
  });

  it("leaves unknown namespace placeholder unchanged (regex only matches profile/vars/captured)", () => {
    assert.equal(interpolate("{{other.key}}", emptyCtx), "{{other.key}}");
  });

  it("handles missing ctx namespace gracefully (treats as empty bag)", () => {
    const ctx = { profile: {}, vars: {}, captured: {} };
    assert.equal(interpolate("{{vars.missing}}", ctx), "");
  });

  it("coerces non-string values to string", () => {
    const ctx = { ...emptyCtx, vars: { count: 7, flag: true } };
    assert.equal(interpolate("{{vars.count}}-{{vars.flag}}", ctx), "7-true");
  });

  it("leaves string unchanged when ctx bags are empty", () => {
    assert.equal(interpolate("no placeholders here", emptyCtx), "no placeholders here");
  });
});
