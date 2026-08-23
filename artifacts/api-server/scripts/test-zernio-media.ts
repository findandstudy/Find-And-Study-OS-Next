import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  __setZernioApiKeyOverrideForTests,
  sendViaZernio,
} from "../src/lib/inbox/zernioSend";
import {
  decideWhatsAppTemplateDeletion,
  deleteZernioWhatsAppTemplate,
} from "../src/lib/inbox/zernioTemplates";
import {
  configuredInboxMediaHosts,
  resolveLocalInboxStorageKey,
  zernioMediaFailureStatus,
} from "../src/lib/inbox/mediaSource";

type FetchCall = { url: string; init?: RequestInit };
const realFetch = globalThis.fetch;
let calls: FetchCall[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  calls = [];
  __setZernioApiKeyOverrideForTests("test-key");
});

after(() => {
  __setZernioApiKeyOverrideForTests(null);
  globalThis.fetch = realFetch;
});

test("voice recordings are delivered as WhatsApp voice notes", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "https://files.example/voice.webm") {
      return new Response(new Uint8Array([26, 69, 223, 163]), {
        status: 200,
        headers: { "Content-Type": "audio/webm" },
      });
    }
    if (url.includes("/api/v1/inbox/conversations/conv-1/messages")) {
      assert.ok(init?.body instanceof FormData);
      const form = init.body;
      assert.equal(form.get("accountId"), "acct-1");
      assert.equal(form.get("voiceNote"), "true");
      const attachment = form.get("attachment");
      assert.ok(attachment instanceof File);
      assert.equal(attachment.name, "voice-note.webm");
      assert.equal(attachment.type, "audio/webm");
      return json(200, { data: { messageId: "msg-voice" } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  const outcome = await sendViaZernio({
    externalThreadId: "conv-1",
    externalAccountId: "acct-1",
    attachments: [{
      url: "https://files.example/voice.webm",
      type: "audio",
      name: "voice-note.webm",
      voiceNote: true,
    }],
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.externalMessageId, "msg-voice");
  assert.equal(calls.some((call) => call.url.endsWith("/api/v1/media/upload-direct")), false);
});

test("document attachments preserve their visible filename", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "https://files.example/transcript.pdf") {
      return new Response(new Uint8Array([37, 80, 68, 70]), {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    }
    if (url.endsWith("/api/v1/media/upload-direct")) {
      return json(200, {
        url: "https://zernio.com/media/transcript.pdf",
        contentType: "application/pdf",
      });
    }
    if (url.includes("/api/v1/inbox/conversations/conv-2/messages")) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.attachmentType, "file");
      assert.equal(body.attachmentName, "Diploma Transcript.pdf");
      assert.equal("voiceNote" in body, false);
      return json(200, { data: { messageId: "msg-document" } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  const outcome = await sendViaZernio({
    externalThreadId: "conv-2",
    externalAccountId: "acct-1",
    attachments: [{
      url: "https://files.example/transcript.pdf",
      type: "file",
      name: "Diploma Transcript.pdf",
    }],
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.externalMessageId, "msg-document");
});

test("historical production inbox media resolves to the canonical storage key", () => {
  const hosts = configuredInboxMediaHosts();
  assert.equal(hosts.has("apply.findandstudy.com"), true);
  assert.equal(
    resolveLocalInboxStorageKey(
      "https://apply.findandstudy.com/api/storage/objects/inbox/document-id",
      hosts,
    ),
    "inbox/document-id",
  );
});

test("expired or deleted Zernio media is not reported as a gateway outage", () => {
  assert.equal(zernioMediaFailureStatus(400, "Media has expired"), 410);
  assert.equal(zernioMediaFailureStatus(400, "Attachment was deleted"), 410);
  assert.equal(zernioMediaFailureStatus(404, "Not found"), 404);
  assert.equal(zernioMediaFailureStatus(401, "Invalid API key"), 502);
  assert.equal(zernioMediaFailureStatus(429, "Rate limited"), 502);
});

test("a missing remote template is a successful stale-cache cleanup", async () => {
  globalThis.fetch = (async () =>
    json(400, { error: "Template not found" })) as typeof fetch;

  const outcome = await deleteZernioWhatsAppTemplate("acct-1", "old-template");
  assert.equal(outcome.ok, true);
  assert.equal(outcome.notFound, true);
});

test("an exact Unknown cache row can be removed when Zernio management is unavailable", () => {
  const decision = decideWhatsAppTemplateDeletion({
    localApprovalStatus: "unknown",
    hasExactLocalTemplate: true,
    remoteOutcome: { ok: false, error: "Zernio template list failed (401)" },
  });

  assert.deepEqual(decision, {
    ok: true,
    localOnly: true,
    remoteNotFound: false,
  });
});

test("authoritative template statuses remain fail-closed on provider failure", () => {
  for (const localApprovalStatus of ["approved", "pending", "rejected"]) {
    const decision = decideWhatsAppTemplateDeletion({
      localApprovalStatus,
      hasExactLocalTemplate: true,
      remoteOutcome: { ok: false, error: "provider unavailable" },
    });

    assert.equal(decision.ok, false);
    assert.equal(decision.error, "provider unavailable");
  }
});

test("a caller cannot request local-only deletion without an exact local row", () => {
  const decision = decideWhatsAppTemplateDeletion({
    localApprovalStatus: "unknown",
    hasExactLocalTemplate: false,
    remoteOutcome: { ok: false, error: "provider unavailable" },
  });

  assert.equal(decision.ok, false);
  assert.equal(decision.error, "provider unavailable");
});
