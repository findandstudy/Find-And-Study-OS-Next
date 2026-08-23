/**
 * Unit tests for the Zernio template-send BROADCAST flow (zernioSend.ts).
 * Mocks global fetch — no network, no DB writes (getZernioApiKey is stubbed
 * by intercepting the profiles/broadcasts URLs; the api key comes from a
 * module-level override of the integrations read via a fake fetch chain is
 * not possible, so we test resolveZernioProfileId + sendZernioTemplate with
 * fetch mocked and the API key injected through the exported test helpers).
 *
 * Run: npx tsx --test scripts/test-zernio-broadcast.ts
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  resolveZernioProfileId,
  __clearZernioProfileCacheForTests,
} from "../src/lib/inbox/zernioSend";
import { buildZernioTemplateComponents } from "../src/lib/inbox/zernioTemplates";

type FetchCall = { url: string; init?: RequestInit };
let calls: FetchCall[] = [];
let responders: Array<(url: string, init?: RequestInit) => Response | null> = [];

const realFetch = globalThis.fetch;
function mockFetch() {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init });
    for (const r of responders) {
      const resp = r(url, init);
      if (resp) return resp;
    }
    throw new Error(`unmocked fetch: ${url}`);
  }) as typeof fetch;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  calls = [];
  responders = [];
  __clearZernioProfileCacheForTests();
  mockFetch();
});

test("WhatsApp template components use Zernio's lowercase discriminators", () => {
  const components = buildZernioTemplateComponents({
    mode: "custom",
    bodyText: "Hello {{1}}",
    bodyExamples: ["John Smith"],
    footerText: "Find And Study",
    quickReplyButtons: [{ text: "I Will Make Payment" }],
  });

  assert.deepEqual(components, [
    {
      type: "body",
      text: "Hello {{1}}",
      example: { body_text: [["John Smith"]] },
    },
    { type: "footer", text: "Find And Study" },
    {
      type: "buttons",
      buttons: [{ type: "quick_reply", text: "I Will Make Payment" }],
    },
  ]);
});

test("resolveZernioProfileId picks isDefault and caches", async () => {
  let profileCalls = 0;
  responders.push((url) => {
    if (url.endsWith("/api/v1/profiles")) {
      profileCalls++;
      return json(200, { profiles: [{ _id: "p1", name: "A" }, { _id: "p2", name: "B", isDefault: true }] });
    }
    return null;
  });
  const r1 = await resolveZernioProfileId("key");
  assert.equal(r1.id, "p2");
  const r2 = await resolveZernioProfileId("key");
  assert.equal(r2.id, "p2");
  assert.equal(profileCalls, 1, "second call must hit the cache");
});

test("resolveZernioProfileId falls back to first profile and reports empty list", async () => {
  responders.push((url) => (url.endsWith("/profiles") ? json(200, { profiles: [{ _id: "only" }] }) : null));
  const r = await resolveZernioProfileId("key");
  assert.equal(r.id, "only");

  __clearZernioProfileCacheForTests();
  responders = [(url) => (url.endsWith("/profiles") ? json(200, { profiles: [] }) : null)];
  const r2 = await resolveZernioProfileId("key");
  assert.equal(r2.id, null);
  assert.match(r2.error || "", /profil bulunamadı/);
});

test("resolveZernioProfileId resolves and caches the profile that owns each WhatsApp account", async () => {
  let accountCalls = 0;
  responders.push((url) => {
    if (url.includes("/api/v1/accounts?")) {
      accountCalls++;
      return json(200, {
        accounts: [
          { _id: "acct-old", profileId: { _id: "profile-default", name: "Default" } },
          { _id: "acct-new", profileId: { _id: "profile-second", name: "Find And Study WhatsApp 2" } },
        ],
      });
    }
    return null;
  });

  const oldAccount = await resolveZernioProfileId("key", "acct-old");
  const newAccount = await resolveZernioProfileId("key", "acct-new");
  const newAccountCached = await resolveZernioProfileId("key", "acct-new");

  assert.equal(oldAccount.id, "profile-default");
  assert.equal(newAccount.id, "profile-second");
  assert.equal(newAccountCached.id, "profile-second");
  assert.equal(accountCalls, 2, "each account is resolved once, then cached independently");
});

test("resolveZernioProfileId supports string profileId and fails closed for an unknown account", async () => {
  responders.push((url) => {
    if (url.includes("/api/v1/accounts?")) {
      return json(200, { data: [{ id: "acct-new", profileId: "profile-second" }] });
    }
    if (url.endsWith("/profiles")) {
      assert.fail("account-aware resolution must not fall back to the default profile");
    }
    return null;
  });

  const resolved = await resolveZernioProfileId("key", "acct-new");
  assert.equal(resolved.id, "profile-second");

  const unknown = await resolveZernioProfileId("key", "acct-missing");
  assert.equal(unknown.id, null);
  assert.match(unknown.error || "", /WhatsApp hesabı bulunamadı/);
});

// sendZernioTemplate reads the API key from the DB — test the broadcast flow
// through a local reimplementation harness is NOT acceptable; instead we
// import the module and monkey-patch the DB read is not exposed. So the flow
// tests below hit sendZernioTemplate with the DB-backed key absent and assert
// the guard, then test the full flow via a fetch-level key injection by
// stubbing the integrations query through the profiles mock is impossible —
// therefore the flow is exercised through the exported function ONLY when a
// key exists. To keep this deterministic we test the pure helper behavior
// (variableMapping shape + sent/failed contract) by driving fetch and
// injecting the key via the test-only override below.
import { sendZernioTemplate, __setZernioApiKeyOverrideForTests } from "../src/lib/inbox/zernioSend";

test("broadcast flow: create → recipients → send, ok on sent=1", async () => {
  __setZernioApiKeyOverrideForTests("test-key");
  try {
    responders.push((url, init) => {
      if (url.includes("/api/v1/accounts?")) {
        return json(200, {
          accounts: [
            { _id: "acct1", profileId: { _id: "prof1" } },
            { _id: "acct2", profileId: { _id: "prof2" } },
          ],
        });
      }
      if (url.endsWith("/api/v1/broadcasts")) {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.profileId, "prof2");
        assert.equal(body.accountId, "acct2");
        assert.equal(body.platform, "whatsapp");
        assert.equal(body.template.name, "welcome");
        assert.equal(body.template.language, "en");
        assert.deepEqual(body.template.variableMapping, { "1": { field: "custom", customValue: "Ali" } });
        assert.match(body.name, /^CRM template — welcome — Ali Veli — \d{4}-/);
        return json(200, { broadcast: { id: "bc1" } });
      }
      if (url.endsWith("/broadcasts/bc1/recipients")) {
        assert.deepEqual(JSON.parse(String(init?.body)), { phones: ["+905551112233"] });
        return json(200, { added: 1 });
      }
      if (url.endsWith("/broadcasts/bc1/send")) return json(200, { sent: 1, failed: 0 });
      return null;
    });
    const r = await sendZernioTemplate({
      externalAccountId: "acct2",
      templateName: "welcome",
      language: "en",
      toPhoneE164: "+905551112233",
      parameters: ["Ali"],
      recipientLabel: "Ali Veli",
    });
    assert.equal(r.ok, true);
    assert.equal(r.broadcastId, "bc1");
    assert.equal(r.sent, 1);
  } finally {
    __setZernioApiKeyOverrideForTests(null);
  }
});

test("sent:0 failed:1 is NOT ok", async () => {
  __setZernioApiKeyOverrideForTests("test-key");
  try {
    responders.push((url) => {
      if (url.includes("/api/v1/accounts?")) {
        return json(200, { accounts: [{ _id: "acct1", profileId: { _id: "prof1" } }] });
      }
      if (url.endsWith("/api/v1/broadcasts")) return json(200, { broadcast: { id: "bc2" } });
      if (url.endsWith("/recipients")) return json(200, {});
      if (url.endsWith("/send")) return json(200, { sent: 0, failed: 1 });
      return null;
    });
    const r = await sendZernioTemplate({
      externalAccountId: "acct1",
      templateName: "welcome",
      language: "en",
      toPhoneE164: "+905551112233",
    });
    assert.equal(r.ok, false);
    assert.equal(r.broadcastId, "bc2");
    assert.match(r.error || "", /Template gönderilemedi/);
  } finally {
    __setZernioApiKeyOverrideForTests(null);
  }
});

test("create failure surfaces friendly error, no recipients call", async () => {
  __setZernioApiKeyOverrideForTests("test-key");
  try {
    responders.push((url) => {
      if (url.includes("/api/v1/accounts?")) {
        return json(200, { accounts: [{ _id: "acct1", profileId: { _id: "prof1" } }] });
      }
      if (url.endsWith("/api/v1/broadcasts")) return json(400, { error: "Template not found" });
      return null;
    });
    const r = await sendZernioTemplate({
      externalAccountId: "acct1",
      templateName: "nope",
      language: "en",
      toPhoneE164: "+905551112233",
    });
    assert.equal(r.ok, false);
    assert.match(r.error || "", /onaylı değil|bulunamadı/);
    assert.equal(calls.some((c) => c.url.includes("/recipients")), false);
  } finally {
    __setZernioApiKeyOverrideForTests(null);
  }
});

test("missing E.164 phone rejected before any network call", async () => {
  __setZernioApiKeyOverrideForTests("test-key");
  try {
    const r = await sendZernioTemplate({
      externalAccountId: "acct1",
      templateName: "welcome",
      language: "en",
      toPhoneE164: "05551112233",
    });
    assert.equal(r.ok, false);
    assert.match(r.error || "", /E\.164/);
    assert.equal(calls.length, 0);
  } finally {
    __setZernioApiKeyOverrideForTests(null);
  }
});

test.after?.(() => {
  globalThis.fetch = realFetch;
});
