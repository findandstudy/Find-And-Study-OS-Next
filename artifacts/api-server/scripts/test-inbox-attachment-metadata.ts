import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  contentDispositionWithFilename,
  ensureAttachmentFilenameExtension,
  normalizeJpegDownloadFilename,
  readNestedZernioAttachmentMetadata,
} from "../src/lib/inboxAttachmentMetadata";
import {
  isZernioMediaUrl,
  resolveLocalInboxStorageKey,
} from "../src/lib/inbox/mediaSource";

const inboxRouteSource = readFileSync(new URL("../src/routes/inbox.ts", import.meta.url), "utf8");

test("reads the real Zernio WhatsApp image metadata shape", () => {
  const metadata = {
    attachments: [{ type: "image", name: "image" }],
    raw: {
      message: {
        attachments: [{
          type: "image",
          payload: { mimeType: "image/jpeg" },
        }],
      },
    },
  };

  const nested = readNestedZernioAttachmentMetadata(metadata, 0);
  assert.equal(nested.mimeType, "image/jpeg");
  assert.equal(ensureAttachmentFilenameExtension("image", nested.mimeType!), "image.jpg");
});

test("preserves an already-valid filename", () => {
  assert.equal(
    ensureAttachmentFilenameExtension("degree.pdf", "application/pdf"),
    "degree.pdf",
  );
});

test("normalizes JFIF transport aliases to a JPG download name", () => {
  assert.equal(normalizeJpegDownloadFilename("WhatsApp Image.JFIF"), "WhatsApp Image.jpg");
  assert.equal(normalizeJpegDownloadFilename("photo.jfi"), "photo.jpg");
  assert.equal(normalizeJpegDownloadFilename("photo.jpeg"), "photo.jpeg");
});

test("rewrites Content-Disposition without changing its disposition mode", () => {
  const header = contentDispositionWithFilename(
    'attachment; filename="WhatsApp Image.jfif"',
    "WhatsApp Image.jpg",
  );
  assert.match(header, /^attachment;/);
  assert.match(header, /filename="WhatsApp Image\.jpg"/);
  assert.match(header, /filename\*=UTF-8''WhatsApp%20Image\.jpg/);
});

test("adds Office extensions for generic document placeholders", () => {
  assert.equal(
    ensureAttachmentFilenameExtension(
      "document",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
    "document.docx",
  );
});

test("recovers historical double-prefixed outbound inbox object URLs", () => {
  assert.equal(
    resolveLocalInboxStorageKey(
      "https://apply.findandstudy.com/api/storage/public-objects//objects/inbox/6b57aa65-7818-4e2b-a677-af1f8c76c175",
      ["apply.findandstudy.com"],
    ),
    "inbox/6b57aa65-7818-4e2b-a677-af1f8c76c175",
  );
});

test("accepts new authenticated inbox object URLs", () => {
  assert.equal(
    resolveLocalInboxStorageKey(
      "https://apply.findandstudy.com/api/storage/objects/inbox/file-id",
      ["apply.findandstudy.com"],
    ),
    "inbox/file-id",
  );
});

test("local media resolver rejects foreign hosts, traversal and non-inbox objects", () => {
  assert.equal(
    resolveLocalInboxStorageKey(
      "https://evil.example/api/storage/objects/inbox/file-id",
      ["apply.findandstudy.com"],
    ),
    null,
  );
  assert.equal(
    resolveLocalInboxStorageKey(
      "/api/storage/objects/inbox/%2e%2e/passport.pdf",
      [],
    ),
    null,
  );
  assert.equal(
    resolveLocalInboxStorageKey(
      "/api/storage/objects/staff-documents/1/contract.pdf",
      [],
    ),
    null,
  );
});

test("external media proxy accepts only the exact HTTPS Zernio host", () => {
  assert.equal(isZernioMediaUrl("https://zernio.com/api/v1/media/1"), true);
  assert.equal(isZernioMediaUrl("http://zernio.com/api/v1/media/1"), false);
  assert.equal(isZernioMediaUrl("https://zernio.com.evil.example/media/1"), false);
});

test("private inbox media is readable by save-as-document and extraction flows", () => {
  const localReads = inboxRouteSource.match(
    /getObjectEntityFile\(`\/objects\/\$\{localKey\}`\)/g,
  ) ?? [];
  assert.ok(localReads.length >= 3, "proxy, save-as-document and extraction should use private object storage");
  assert.match(inboxRouteSource, /\/web-chat-media/);
  assert.match(inboxRouteSource, /Invalid web chat attachment/);
});
