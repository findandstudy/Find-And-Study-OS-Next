import assert from "node:assert/strict";
import test from "node:test";

import { createDocumentRecord } from "../src/lib/uploadDocumentFile";

const input = {
  name: "passport-test",
  type: "passport",
  status: "pending",
  studentId: 123,
  fileKey: "student-documents/test.pdf",
  mimeType: "application/pdf",
  sizeBytes: 128,
};

Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: { cookie: "csrf_token=test-token" },
});

test("registers documents through the non-redirecting collection URL", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  globalThis.fetch = async (url, init) => {
    requestUrl = String(url);
    requestInit = init;
    return new Response(JSON.stringify({ id: 42, fileKey: input.fileKey }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  };

  const result = await createDocumentRecord(input);

  assert.equal(requestUrl, "/api/documents/");
  assert.equal(requestInit?.method, "POST");
  assert.equal(requestInit?.redirect, "error");
  assert.equal(new Headers(requestInit?.headers).get("x-csrf-token"), "test-token");
  assert.equal(result.id, 42);
});

test("does not accept a redirected or GET-shaped success response", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify([]), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  await assert.rejects(
    createDocumentRecord(input),
    /Document registration failed \(200\)/,
  );
});

test("requires the API to confirm the stored object", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ id: 43, fileKey: "different.pdf" }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });

  await assert.rejects(
    createDocumentRecord(input),
    /did not confirm the uploaded file/,
  );
});
