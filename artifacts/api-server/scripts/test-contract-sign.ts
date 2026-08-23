import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSignatureImage, MAX_SIGNATURE_BYTES } from "../src/lib/signContract";
import {
  clearMainAgencySignatureCacheForTests,
  loadMainAgencySignatureDataUrl,
} from "../src/lib/mainAgencySignature";
import {
  renderTemplate,
  buildAgentContext,
  cleanupSignatureImages,
  toSignatureDataUrl,
  SIG_PLACEHOLDER,
  buildFinalSignedContractHtml,
  contractNumber,
  signedContractFilename,
} from "../src/lib/contractRenderer";
import { REGENERATE_PDF_CACHE_RESET } from "../src/routes/contracts";

// A real 1x1 transparent PNG (starts with the PNG magic 89 50 4E 47 0D 0A 1A 0A).
const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const MAIN_SIGNATURE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl7sAAAAASUVORK5CYII=";

const signatureFixtureDir = mkdtempSync(join(tmpdir(), "fas-main-signature-"));
const signatureFixturePath = join(signatureFixtureDir, "main-signature.png");
writeFileSync(signatureFixturePath, Buffer.from(MAIN_SIGNATURE_PNG_BASE64, "base64"));
const MAIN_AGENCY_SIGNATURE_DATA_URL = loadMainAgencySignatureDataUrl(signatureFixturePath);
process.once("exit", () => rmSync(signatureFixtureDir, { recursive: true, force: true }));

test("accepts a valid bare-base64 PNG and returns no data: prefix", () => {
  const r = validateSignatureImage(VALID_PNG_BASE64);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.base64.includes("data:"), false);
    assert.equal(r.base64, VALID_PNG_BASE64);
  }
});

test("accepts a legacy data-URL PNG and strips the data: prefix (normalize)", () => {
  const r = validateSignatureImage(`data:image/png;base64,${VALID_PNG_BASE64}`);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.base64, VALID_PNG_BASE64);
    assert.equal(r.base64.includes("data:"), false);
  }
});

test('rejects non-PNG garbage ("AAAA") with 400 Invalid PNG', () => {
  const r = validateSignatureImage("AAAA");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 400);
    assert.equal(r.error, "Invalid PNG");
  }
});

test("rejects an empty string with 400 Invalid PNG", () => {
  const r = validateSignatureImage("");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 400);
});

test("rejects an oversized (>2 MB decoded) PNG with 400", () => {
  // PNG magic followed by enough filler to exceed the decoded size cap.
  const big = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(MAX_SIGNATURE_BYTES + 1),
  ]);
  const r = validateSignatureImage(big.toString("base64"));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 400);
    assert.equal(r.error, "Signature image too large");
  }
});

// --- Render path: a stored bare-base64 signature must become a real
// data:image/png;base64 <img src> so it renders inside the signature box of the
// generated PDF (regression guard for the "broken image icon" prod incident,
// where the renderer received bare base64 without the data: prefix). ---

const SIG_TEMPLATE =
  `<p>Signer: {{signer_name}}</p><img src="{{signature}}" alt="signer signature">`;

function renderWithSignature(storedSig: string): string {
  const ctx = buildAgentContext(null, null, { signerName: "Test Agent" });
  ctx.signature = toSignatureDataUrl(storedSig);
  return cleanupSignatureImages(renderTemplate(SIG_TEMPLATE, ctx), SIG_PLACEHOLDER.en);
}

test("renders a bare-base64 signature as a data:image/png;base64 <img src>", () => {
  const html = renderWithSignature(VALID_PNG_BASE64);
  assert.ok(
    html.includes(`src="data:image/png;base64,${VALID_PNG_BASE64}"`),
    `expected a wrapped data-URL src, got: ${html}`,
  );
  // The filled signature must NOT be downgraded to the unfilled placeholder box.
  assert.equal(html.includes(SIG_PLACEHOLDER.en), false);
});

test("renders a legacy data-URL signature unchanged (idempotent wrap, no double prefix)", () => {
  const html = renderWithSignature(`data:image/png;base64,${VALID_PNG_BASE64}`);
  assert.ok(html.includes(`src="data:image/png;base64,${VALID_PNG_BASE64}"`));
  assert.equal((html.match(/data:image\/png;base64,/g) || []).length, 1);
});

test("an unfilled signature falls back to the styled placeholder box (no <img>)", () => {
  const ctx = buildAgentContext(null, null, { signerName: "Test Agent" });
  // signature left as "" (unsigned preview render). Use an alt-less <img> so the
  // placeholder box uses the per-language placeholder text (an alt attribute, if
  // present, would be reused as the box label instead — see cleanupSignatureImages).
  const html = cleanupSignatureImages(renderTemplate(`<img src="{{signature}}">`, ctx), SIG_PLACEHOLDER.en);
  assert.equal(html.includes("<img"), false);
  assert.ok(html.includes(SIG_PLACEHOLDER.en));
});

// --- Main-agency seal: the final, post-signature PDF render must stamp the
// Find And Study seal into the {{main_agency_signature}} box, while the
// preview / signing-screen render (which never sets ctx.main_agency_signature)
// must leave that box empty -- no broken image, no leaked seal before signing.
// {{signature}} -> Alt Acente; {{main_agency_signature}} -> Ana Acente. ---

const DUAL_SIG_TEMPLATE =
  `<img src="{{signature}}" alt="Alt Acente İmzası">` +
  `<img src="{{main_agency_signature}}" alt="Ana Acente İmzası">`;

test("final render stamps the main-agency seal into {{main_agency_signature}}", () => {
  const ctx = buildAgentContext(null, null, { signerName: "Test Agent" });
  ctx.signature = toSignatureDataUrl(VALID_PNG_BASE64);
  // Mirror ensureSignedContractPdf's final-render injection.
  ctx.main_agency_signature = MAIN_AGENCY_SIGNATURE_DATA_URL;
  const html = cleanupSignatureImages(renderTemplate(DUAL_SIG_TEMPLATE, ctx), SIG_PLACEHOLDER.en);
  assert.ok(
    html.includes(`src="${MAIN_AGENCY_SIGNATURE_DATA_URL}"`),
    "expected the main-agency seal data URL in the final render",
  );
  assert.ok(MAIN_AGENCY_SIGNATURE_DATA_URL.startsWith("data:image/png;base64,"));
  // The two signature boxes must carry DIFFERENT images (sub vs main agency).
  assert.ok(html.includes(`src="data:image/png;base64,${VALID_PNG_BASE64}"`));
  assert.notEqual(MAIN_AGENCY_SIGNATURE_DATA_URL, toSignatureDataUrl(VALID_PNG_BASE64));
});

test("main-agency seal loader rejects relative paths and invalid image bytes", () => {
  assert.throws(
    () => loadMainAgencySignatureDataUrl("relative/signature.png"),
    /absolute path/,
  );
  const invalidPath = join(signatureFixtureDir, "invalid.png");
  writeFileSync(invalidPath, "not an image");
  clearMainAgencySignatureCacheForTests();
  assert.throws(
    () => loadMainAgencySignatureDataUrl(invalidPath),
    /valid PNG or JPEG/,
  );
  clearMainAgencySignatureCacheForTests();
});

test("main-agency seal uses a local placeholder but remains fail-closed in production", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousSignaturePath = process.env.MAIN_AGENCY_SIGNATURE_FILE;
  try {
    delete process.env.MAIN_AGENCY_SIGNATURE_FILE;
    process.env.NODE_ENV = "test";
    const localValue = loadMainAgencySignatureDataUrl();
    assert.match(localValue, /^data:image\/png;base64,/);

    process.env.NODE_ENV = "production";
    assert.throws(
      () => loadMainAgencySignatureDataUrl(),
      /MAIN_AGENCY_SIGNATURE_FILE is required/,
    );
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousSignaturePath === undefined) delete process.env.MAIN_AGENCY_SIGNATURE_FILE;
    else process.env.MAIN_AGENCY_SIGNATURE_FILE = previousSignaturePath;
    clearMainAgencySignatureCacheForTests();
  }
});

test("preview render leaves {{main_agency_signature}} empty (no seal, no <img>)", () => {
  const ctx = buildAgentContext(null, null, { signerName: "Test Agent" });
  ctx.signature = toSignatureDataUrl(VALID_PNG_BASE64);
  // Preview path never sets main_agency_signature -> buildAgentContext default "".
  const html = cleanupSignatureImages(renderTemplate(DUAL_SIG_TEMPLATE, ctx), SIG_PLACEHOLDER.en);
  assert.equal(html.includes(MAIN_AGENCY_SIGNATURE_DATA_URL), false);
  // The Ana Acente box collapses to the styled placeholder using its alt label,
  // so there is exactly ONE real <img> (the sub-agent's signature) in preview.
  assert.equal((html.match(/<img/g) || []).length, 1);
});

// --- Sign-time render path (the ACTUAL function the delivery worker, backfill
// sweep, and admin regenerate all funnel through). Guards SORUN 1: at sign time
// the auto-generated PDF must contain the main-agency seal, not an empty box.
// Because ensureSignedContractPdf calls THIS exact function, asserting on its
// output guarantees the seal is present in the sign-time render, not just a
// hand-mirrored copy of the injection. ---

const FINAL_RENDER_TEMPLATE =
  `<p>No: {{contract_number}}</p>` +
  `<img src="{{signature}}" alt="Alt Acente İmzası">` +
  `<img src="{{main_agency_signature}}" alt="Ana Acente İmzası">`;

test("sign-time render (buildFinalSignedContractHtml) stamps the main-agency seal", () => {
  process.env.MAIN_AGENCY_SIGNATURE_FILE = signatureFixturePath;
  clearMainAgencySignatureCacheForTests();
  const html = buildFinalSignedContractHtml({
    bodyHtml: FINAL_RENDER_TEMPLATE,
    templateLanguage: "tr",
    agent: null,
    intakeData: null,
    signerEmail: "agent@example.com",
    signerName: "Test Agent",
    signedAt: new Date("2026-06-08T10:00:00Z"),
    signatureBase64: VALID_PNG_BASE64,
    contractNumber: contractNumber(25, new Date("2026-06-08T10:00:00Z")),
  });
  // The seal data URL must be present in the sign-time PDF HTML.
  assert.ok(
    html.includes(`src="${MAIN_AGENCY_SIGNATURE_DATA_URL}"`),
    "sign-time render is missing the main-agency seal data URL",
  );
  // The sub-agent signature and the main-agency seal are DISTINCT images.
  assert.ok(html.includes(`src="data:image/png;base64,${VALID_PNG_BASE64}"`));
  assert.notEqual(MAIN_AGENCY_SIGNATURE_DATA_URL, toSignatureDataUrl(VALID_PNG_BASE64));
  // The final PDF must also carry the contract number (previously empty because
  // the finalizer passed no number to buildAgentContext).
  assert.ok(html.includes("FAS-2026-00025"), `expected contract number in body, got: ${html}`);
  delete process.env.MAIN_AGENCY_SIGNATURE_FILE;
  clearMainAgencySignatureCacheForTests();
});

// --- Contract number / download filename (SORUN 2). The filename is derived
// from the SAME contractNumber() source as the document body, so the two can
// never drift. Pattern: FAS-{YYYY}-{NNNNN}_signed.pdf. ---

test("contractNumber uses 4-digit year + zero-padded session id", () => {
  assert.equal(contractNumber(25, new Date("2026-06-08T10:00:00Z")), "FAS-2026-00025");
  assert.equal(contractNumber(7, new Date("2027-01-02T00:00:00Z")), "FAS-2027-00007");
});

test("signedContractFilename = <contract_number>_signed.pdf (same source as {{contract_number}})", () => {
  const signedAt = new Date("2026-06-08T10:00:00Z");
  assert.equal(signedContractFilename(25, signedAt), "FAS-2026-00025_signed.pdf");
  // Filename's number must equal the value rendered into the document body.
  assert.equal(signedContractFilename(25, signedAt), `${contractNumber(25, signedAt)}_signed.pdf`);
});

// --- Regenerate is status-neutral. POST /api/contracts/signed/:id/regenerate
// clears ONLY the rendered-PDF cache fields so the background sweep re-renders
// the PDF. It must NEVER mutate any status: signed_contracts has no status
// column, and a signed contract's "signed" state lives on
// signing_sessions.status, which the regenerate payload does not touch. This
// guards the prod incident where clearing the PDF cache made an already-signed
// agent look unsigned and re-triggered the onboarding gate/banner. ---

test("regenerate clears EXACTLY the three PDF-cache fields (no extras)", () => {
  assert.deepEqual(
    Object.keys(REGENERATE_PDF_CACHE_RESET).sort(),
    ["deliveryClaimedAt", "evidenceHash", "pdfObjectKey"],
  );
});

test("regenerate payload sets every PDF-cache field to null (cache reset, not a value write)", () => {
  for (const v of Object.values(REGENERATE_PDF_CACHE_RESET)) {
    assert.equal(v, null);
  }
});

test("regenerate payload never touches a signing-session or signed-contract status field", () => {
  const keys = Object.keys(REGENERATE_PDF_CACHE_RESET);
  // signing_sessions status fields that must never be flipped by a PDF regen.
  for (const forbidden of ["status", "signedAt", "revokedAt", "expiresAt"]) {
    assert.equal(keys.includes(forbidden), false, `regenerate must not mutate ${forbidden}`);
  }
});

// NOTE: the "second sign -> 409" case is enforced by finalizeSign's session
// status guard (a session already in status "signed" returns 409) and is
// exercised end-to-end by scripts/test-contract-sign-smoke.ts; it requires a
// live DB session fixture so it is intentionally not duplicated as a unit test
// here, which targets the pure signature validation/normalization logic.
