import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument, rgb } from "pdf-lib";
import sharp from "sharp";
import {
  DocumentPartMergeError,
  mergeDocumentParts,
} from "../src/lib/documentPartMerge";

async function createPdf(pageCount: number, color: [number, number, number]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) {
    const page = pdf.addPage([300, 400]);
    page.drawRectangle({ x: 20, y: 20, width: 260, height: 360, color: rgb(...color) });
  }
  return Buffer.from(await pdf.save());
}

test("merges PDF pieces in upload order into one canonical PDF", async () => {
  const first = await createPdf(1, [1, 0, 0]);
  const second = await createPdf(2, [0, 0, 1]);
  const merged = await mergeDocumentParts("diploma_certificate", "Diploma Certificate", [
    { data: first.toString("base64"), mediaType: "application/pdf", fileName: "part-1.pdf" },
    { data: second.toString("base64"), mediaType: "application/pdf", fileName: "part-2.pdf" },
  ]);

  const loaded = await PDFDocument.load(Buffer.from(merged.data, "base64"));
  assert.equal(merged.mediaType, "application/pdf");
  assert.equal(merged.partCount, 2);
  assert.equal(merged.pageCount, 3);
  assert.equal(loaded.getPageCount(), 3);
  assert.ok(merged.sizeBytes > 0);
  assert.match(merged.fileName, /Diploma-Certificate\.pdf$/);
});

test("converts an image piece and combines it with a PDF", async () => {
  const image = await sharp({
    create: { width: 640, height: 480, channels: 3, background: "#ffffff" },
  }).png().toBuffer();
  const pdf = await createPdf(1, [0, 1, 0]);
  const merged = await mergeDocumentParts("diploma_transcript", "Diploma Transcript", [
    { data: image.toString("base64"), mediaType: "image/png", fileName: "scan.png" },
    { data: pdf.toString("base64"), mediaType: "application/pdf", fileName: "page.pdf" },
  ]);

  assert.equal(merged.pageCount, 2);
  const loaded = await PDFDocument.load(Buffer.from(merged.data, "base64"));
  assert.equal(loaded.getPageCount(), 2);
});

test("keeps the photograph slot single-file", async () => {
  const image = await sharp({
    create: { width: 100, height: 100, channels: 3, background: "#ffffff" },
  }).jpeg().toBuffer();

  await assert.rejects(
    () => mergeDocumentParts("photo", "Photograph", [
      { data: image.toString("base64"), mediaType: "image/jpeg", fileName: "one.jpg" },
      { data: image.toString("base64"), mediaType: "image/jpeg", fileName: "two.jpg" },
    ]),
    (error: unknown) => error instanceof DocumentPartMergeError && /single JPG/i.test(error.message),
  );
});
test("rejects invalid and oversized pieces before merge", async () => {
  const pdf = await createPdf(1, [0, 0, 0]);
  await assert.rejects(
    () => mergeDocumentParts("diploma_certificate", "Diploma", [
      { data: "not-base64!", mediaType: "application/pdf", fileName: "invalid.pdf" },
      { data: pdf.toString("base64"), mediaType: "application/pdf", fileName: "valid.pdf" },
    ]),
    (error: unknown) => error instanceof DocumentPartMergeError && error.statusCode === 400,
  );

  const tooLarge = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
  await assert.rejects(
    () => mergeDocumentParts("diploma_certificate", "Diploma", [
      { data: tooLarge.toString("base64"), mediaType: "application/pdf", fileName: "large.pdf" },
      { data: pdf.toString("base64"), mediaType: "application/pdf", fileName: "valid.pdf" },
    ]),
    (error: unknown) => error instanceof DocumentPartMergeError && error.statusCode === 413,
  );
});
