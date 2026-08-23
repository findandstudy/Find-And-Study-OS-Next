import assert from "node:assert/strict";
import test from "node:test";
import {
  getInboxAttachmentPreviewKind,
  inboxAttachmentMediaUrl,
  normalizeInboxDownloadFilename,
  shouldProxyInboxAttachment,
} from "../src/components/inbox/attachmentMediaUrl";

test("historical production inbox objects use the authenticated local proxy", () => {
  const raw = "https://apply.findandstudy.com/api/storage/objects/inbox/document-id";
  assert.equal(shouldProxyInboxAttachment(raw), true);
  assert.equal(inboxAttachmentMediaUrl(raw, 42, 1), "/api/inbox/media/42/1");
});

test("legacy double-prefixed and relative inbox object URLs use the proxy", () => {
  assert.equal(
    inboxAttachmentMediaUrl(
      "/api/storage/public-objects//objects/inbox/document-id",
      7,
      0,
    ),
    "/api/inbox/media/7/0",
  );
});

test("Zernio media uses the proxy but lookalike hosts do not", () => {
  assert.equal(
    inboxAttachmentMediaUrl("https://zernio.com/api/v1/media/id", 9, 2),
    "/api/inbox/media/9/2",
  );
  assert.equal(
    shouldProxyInboxAttachment("https://zernio.com.example/api/v1/media/id"),
    false,
  );
});

test("ordinary external files remain direct URLs", () => {
  const raw = "https://cdn.example.edu/files/transcript.pdf";
  assert.equal(shouldProxyInboxAttachment(raw), false);
  assert.equal(inboxAttachmentMediaUrl(raw, 11, 0), raw);
});

test("provider files are previewed from MIME type or extension", () => {
  assert.equal(
    getInboxAttachmentPreviewKind({ type: "file", mimeType: "image/jpeg", name: "photo" }),
    "image",
  );
  assert.equal(
    getInboxAttachmentPreviewKind({ type: "file", mimeType: "application/octet-stream", name: "clip.mp4" }),
    "video",
  );
  assert.equal(
    getInboxAttachmentPreviewKind({ type: "file", mimeType: "audio/webm", name: "voice.webm" }),
    "audio",
  );
  assert.equal(
    getInboxAttachmentPreviewKind({ type: "document", mimeType: "application/pdf", name: "scan" }),
    "pdf",
  );
  assert.equal(
    getInboxAttachmentPreviewKind({ type: "file", mimeType: "application/msword", name: "letter.doc" }),
    "file",
  );
  assert.equal(
    getInboxAttachmentPreviewKind({ type: "file", mimeType: "application/octet-stream", name: "photo.jfif" }),
    "image",
  );
});

test("JFIF-family image downloads use the compatible JPG extension", () => {
  assert.equal(normalizeInboxDownloadFilename("WhatsApp Image.jfif"), "WhatsApp Image.jpg");
  assert.equal(normalizeInboxDownloadFilename("photo.JFI"), "photo.jpg");
  assert.equal(normalizeInboxDownloadFilename("photo.jpeg"), "photo.jpeg");
});
