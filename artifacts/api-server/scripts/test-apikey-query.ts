import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const middlewareSource = readFileSync(
  new URL("../src/middlewares/authMiddleware.ts", import.meta.url),
  "utf8",
);
const tokenAuthSource = readFileSync(
  new URL("../src/lib/apiTokenAuth.ts", import.meta.url),
  "utf8",
);

test("API authentication never reads tokens from URL query parameters", () => {
  assert.doesNotMatch(middlewareSource, /extractQueryToken/);
  assert.doesNotMatch(middlewareSource, /req\.query/);
  assert.doesNotMatch(tokenAuthSource, /api_key|apiKey/);
});

test("Bearer API token authentication remains available", () => {
  assert.match(tokenAuthSource, /header\.startsWith\("Bearer "\)/);
  assert.match(tokenAuthSource, /token\.startsWith\("fas_live_"\)/);
  assert.match(middlewareSource, /extractBearerToken\(req\.headers\.authorization\)/);
});
