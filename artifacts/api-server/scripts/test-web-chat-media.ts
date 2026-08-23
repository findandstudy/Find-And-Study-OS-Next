import assert from "node:assert/strict";
import test from "node:test";
import {
  WEB_CHAT_MEDIA_MAX_BYTES,
  WebChatMediaValidationError,
  readWebChatAttachments,
  validateWebChatMedia,
  webChatObjectPath,
} from "../src/lib/inbox/webChatMedia";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
  "base64",
);

test("web-chat media accepts a real supported image and classifies it", async () => {
  assert.deepEqual(await validateWebChatMedia(png, "camera image.png", "image/png"), {
    filename: "camera image.png",
    mimeType: "image/png",
    kind: "image",
    size: png.length,
  });
});

test("web-chat media rejects declared MIME and magic-byte mismatches", async () => {
  await assert.rejects(
    validateWebChatMedia(png, "passport.pdf", "application/pdf"),
    (error: unknown) => error instanceof WebChatMediaValidationError && /do not match/i.test(error.message),
  );
});

test("web-chat media rejects files larger than 5 MB before content sniffing", async () => {
  await assert.rejects(
    validateWebChatMedia(Buffer.alloc(WEB_CHAT_MEDIA_MAX_BYTES + 1), "large.png", "image/png"),
    (error: unknown) => error instanceof WebChatMediaValidationError && error.statusCode === 413,
  );
});

test("web-chat storage keys are conversation-scoped and traversal-safe", () => {
  assert.equal(
    webChatObjectPath("/api/storage/objects/inbox/web-chat/42/uuid-passport.pdf", 42),
    "/objects/inbox/web-chat/42/uuid-passport.pdf",
  );
  assert.equal(
    webChatObjectPath("/api/storage/objects/inbox/web-chat/41/uuid-passport.pdf", 42),
    null,
  );
  assert.equal(
    webChatObjectPath("/api/storage/objects/inbox/web-chat/42/%2e%2e/passport.pdf", 42),
    null,
  );
});

test("public attachment serialization accepts only complete descriptors", () => {
  const rows = readWebChatAttachments({
    attachments: [
      {
        url: "/api/storage/objects/inbox/web-chat/42/a.png",
        type: "image",
        name: "a.png",
        mimeType: "image/png",
        fileType: "image/png",
        fileSize: 123,
      },
      { url: "javascript:alert(1)", type: "file" },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "a.png");
});
