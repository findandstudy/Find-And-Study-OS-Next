import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasContractCompanySignature,
  publicContractBranding,
  sanitizeContractBranding,
  validateCompanySignatureDataUrl,
} from "../src/lib/contractBranding";

const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const VALID_PNG_DATA_URL = `data:image/png;base64,${VALID_PNG_BASE64}`;

test("accepts a valid admin-managed PNG signature", () => {
  assert.equal(validateCompanySignatureDataUrl(VALID_PNG_DATA_URL), null);
  assert.equal(hasContractCompanySignature({ companySignatureDataUrl: VALID_PNG_DATA_URL }), true);
});

test("rejects MIME-spoofed signature content", () => {
  const spoofed = `data:image/png;base64,${Buffer.from("not-an-image").toString("base64")}`;
  assert.equal(
    validateCompanySignatureDataUrl(spoofed),
    "Company signature content does not match its image type",
  );
});

test("rejects signatures larger than the decoded 2 MB limit", () => {
  const oversized = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(2 * 1024 * 1024 + 1),
  ]);
  assert.equal(
    validateCompanySignatureDataUrl(`data:image/png;base64,${oversized.toString("base64")}`),
    "Company signature must be 2 MB or smaller",
  );
});

test("public branding never returns the pre-approved company signature", () => {
  const publicConfig = publicContractBranding({
    brandName: "Find and Study",
    primaryColor: "#1e3a8a",
    companySignatureDataUrl: VALID_PNG_DATA_URL,
  });
  assert.equal(publicConfig?.brandName, "Find and Study");
  assert.equal(publicConfig?.primaryColor, "#1e3a8a");
  assert.equal("companySignatureDataUrl" in (publicConfig || {}), false);
});

test("sanitization keeps valid presentation fields and drops invalid colors", () => {
  assert.deepEqual(sanitizeContractBranding({
    brandName: "  Find and Study  ",
    primaryColor: "blue",
    accentColor: "#21b6cc",
  }), {
    brandName: "Find and Study",
    logoUrl: undefined,
    primaryColor: undefined,
    accentColor: "#21b6cc",
    pageTitle: undefined,
    pageSubtitle: undefined,
    pdfHeaderText: undefined,
    pdfFooterText: undefined,
    companySignatureDataUrl: undefined,
  });
});
