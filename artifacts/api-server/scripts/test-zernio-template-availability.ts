import assert from "node:assert/strict";
import test from "node:test";
import {
  findApprovedZernioTemplate,
  type NormalizedZernioTemplate,
} from "../src/lib/inbox/zernioTemplates";

function template(
  name: string,
  language: string,
  status: NormalizedZernioTemplate["status"] = "approved",
): NormalizedZernioTemplate {
  return {
    id: `${name}:${language}:${status}`,
    name,
    language,
    category: "utility",
    status,
    bodyText: "Hello",
    components: [],
    variableCount: 0,
  };
}

test("uses only templates approved on the target account", () => {
  const firstLine = [template("offer_letter", "en_US", "approved")];
  const secondLine = [template("offer_letter", "en_US", "pending")];

  assert.equal(findApprovedZernioTemplate(firstLine, "offer_letter", "en")?.language, "en_US");
  assert.equal(findApprovedZernioTemplate(secondLine, "offer_letter", "en"), null);
});

test("matches template names case-insensitively but never by substring", () => {
  const templates = [template("offer_letter", "en_US")];
  assert.ok(findApprovedZernioTemplate(templates, "OFFER_LETTER", "en_US"));
  assert.equal(findApprovedZernioTemplate(templates, "offer", "en_US"), null);
});

test("returns the provider language for a unique base-language match", () => {
  const result = findApprovedZernioTemplate([template("process_en", "en_US")], "process_en", "en");
  assert.equal(result?.language, "en_US");
});

test("fails closed when a base language is ambiguous", () => {
  const templates = [
    template("welcome", "en_US"),
    template("welcome", "en_GB"),
  ];
  assert.equal(findApprovedZernioTemplate(templates, "welcome", "en"), null);
});

test("prefers the exact requested locale when multiple approved locales exist", () => {
  const templates = [
    template("welcome", "en_US"),
    template("welcome", "en_GB"),
  ];
  assert.equal(findApprovedZernioTemplate(templates, "welcome", "en-GB")?.language, "en_GB");
});
