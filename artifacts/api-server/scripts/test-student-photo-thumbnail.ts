import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { PDFDocument, rgb } from "pdf-lib";
import sharp from "sharp";
import {
  clearStudentPhotoThumbnailCacheForTests,
  getStudentPhotoThumbnail,
} from "../src/lib/studentPhotoThumbnail";

test("large source images become small cacheable JPEG thumbnails", async () => {
  clearStudentPhotoThumbnailCacheForTests();
  const source = await sharp({
    create: { width: 1800, height: 2400, channels: 3, background: "#2f6ad9" },
  }).png().toBuffer();
  const first = await getStudentPhotoThumbnail("doc-1", {
    fileData: source.toString("base64"),
    mimeType: "image/png",
  }, "Test Student");
  const metadata = await sharp(first.buffer).metadata();
  assert.equal(first.cacheStatus, "miss");
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, 128);
  assert.equal(metadata.height, 128);
  assert.ok(first.buffer.length < source.length / 10);

  const second = await getStudentPhotoThumbnail("doc-1", {
    fileData: source.toString("base64"),
    mimeType: "image/png",
  }, "Test Student");
  assert.equal(second.cacheStatus, "hit");
  assert.deepEqual(second.buffer, first.buffer);
});

test("PDF photographs render their first page into a bounded JPEG thumbnail", async (context) => {
  const hasPdfRenderer = spawnSync("pdftoppm", ["-v"]).status === 0
    || spawnSync("gs", ["--version"]).status === 0;
  if (!hasPdfRenderer) {
    context.skip("pdftoppm or ghostscript is required for PDF thumbnail rendering");
    return;
  }

  clearStudentPhotoThumbnailCacheForTests();
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([200, 200]);
  page.drawRectangle({ x: 0, y: 0, width: 200, height: 200, color: rgb(0.85, 0.05, 0.05) });
  const source = Buffer.from(await pdf.save());
  const result = await getStudentPhotoThumbnail("pdf-1", {
    fileData: source.toString("base64"),
    mimeType: "application/pdf",
  }, "Test Student");
  const metadata = await sharp(result.buffer).metadata();
  const stats = await sharp(result.buffer).stats();
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, 128);
  assert.ok(stats.channels[0].mean > stats.channels[1].mean * 2);
  assert.ok(result.buffer.length < 50_000);
});
