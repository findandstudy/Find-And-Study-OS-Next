import test from "node:test";
import assert from "node:assert/strict";
import { buildAcademyDestinationDocument } from "../src/lib/inbox/academyKnowledge.js";

const countries = {
  success: true,
  countries: [
    { id: "tr", name: "Türkiye", code: "TR", status: "active" },
    { id: "lv", name: "Latvia", code: "LV", status: "active" },
    { id: "aa", name: "Find And Study", code: "AA", status: "active" },
    { id: "old", name: "Old destination", code: "ZZ", status: "inactive" },
  ],
};

test("Academy document includes only published lessons for active destinations", () => {
  const result = buildAcademyDestinationDocument(countries, {
    success: true,
    contents: [
      {
        id: "ok",
        title: "Student visa",
        type: "lesson",
        status: "published",
        countryId: "tr",
        content: "<style>.secret{display:none}</style><h2>Visa</h2><p>Apply with your passport.</p>",
      },
      {
        id: "draft",
        title: "Draft",
        type: "lesson",
        status: "draft",
        countryId: "tr",
        content: "<p>Do not expose this.</p>",
      },
      {
        id: "image",
        title: "Poster",
        type: "image",
        status: "published",
        countryId: "tr",
        content: "<p>Image metadata.</p>",
      },
      {
        id: "partner",
        title: "Partner model",
        type: "lesson",
        status: "published",
        countryId: "aa",
        content: "<p>Partner-only information.</p>",
      },
      {
        id: "inactive",
        title: "Inactive",
        type: "lesson",
        status: "published",
        countryId: "old",
        content: "<p>Inactive destination.</p>",
      },
      {
        id: "placeholder",
        title: "Coming Soon",
        type: "lesson",
        status: "published",
        countryId: "lv",
        content: "<p>Placeholder.</p>",
      },
    ],
  });

  assert.equal(result.countryCount, 1);
  assert.equal(result.contentCount, 1);
  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0].countryCode, "TR");
  assert.equal(result.documents[0].countryName, "Türkiye");
  assert.match(result.text, /Türkiye/);
  assert.match(result.text, /Apply with your passport/);
  assert.doesNotMatch(result.text, /Do not expose/);
  assert.doesNotMatch(result.text, /Partner-only/);
  assert.doesNotMatch(result.text, /Placeholder/);
  assert.doesNotMatch(result.text, /\.secret/);
});

test("Academy documents keep destination countries in separate records", () => {
  const result = buildAcademyDestinationDocument(countries, {
    success: true,
    contents: [
      {
        id: "tr-residence",
        title: "Student residence permit",
        type: "lesson",
        status: "published",
        countryId: "tr",
        content: "<p>Türkiye residence permit guidance.</p>",
      },
      {
        id: "lv-residence",
        title: "Residence permit",
        type: "lesson",
        status: "published",
        countryId: "lv",
        content: "<p>Latvia residence permit guidance.</p>",
      },
    ],
  });

  assert.deepEqual(result.documents.map((document) => document.countryCode), ["LV", "TR"]);
  const turkey = result.documents.find((document) => document.countryCode === "TR");
  const latvia = result.documents.find((document) => document.countryCode === "LV");
  assert.match(turkey?.text ?? "", /Türkiye residence permit guidance/);
  assert.doesNotMatch(turkey?.text ?? "", /Latvia residence permit guidance/);
  assert.match(latvia?.text ?? "", /Latvia residence permit guidance/);
  assert.doesNotMatch(latvia?.text ?? "", /Türkiye residence permit guidance/);
});

test("Academy document removes internal commission and credential blocks", () => {
  const result = buildAcademyDestinationDocument(countries, {
    success: true,
    contents: [
      {
        id: "safe",
        title: "Application process",
        type: "lesson",
        status: "published",
        countryId: "tr",
        content: [
          "<h2>Application steps</h2>",
          "<p>Students submit the required documents.</p>",
          "<p>Agency commission rate is 20 percent.</p>",
          "<p>Commission is paid by Find And Study to the partner agency.</p>",
          "<p>The agency pays 50% of the consultancy fee.</p>",
          "<p>Pay Remaining Consultancy Fee</p>",
          "<p>Agency completes the balance payment.</p>",
          "<p>Discounted partner rates</p>",
          "<li>Portal credentials: secret</li>",
          "<p>Students should verify Pakistan Medical Commission recognition.</p>",
          "<p>Wait for the admission decision.</p>",
        ].join(""),
      },
    ],
  });

  assert.match(result.text, /Students submit the required documents/);
  assert.match(result.text, /Wait for the admission decision/);
  assert.match(result.text, /Pakistan Medical Commission/);
  assert.doesNotMatch(result.text, /20 percent/);
  assert.doesNotMatch(result.text, /paid by Find And Study/i);
  assert.doesNotMatch(result.text, /agency pays/i);
  assert.doesNotMatch(result.text, /consultancy fee/i);
  assert.doesNotMatch(result.text, /balance payment/i);
  assert.doesNotMatch(result.text, /partner rates/i);
  assert.doesNotMatch(result.text, /credentials: secret/i);
});
