import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseAdapterSpec } from "../src/declarative/schema.js";

const specDir = fileURLToPath(
  new URL("../../../docs/portal-specs/", import.meta.url),
);
const expectedKeys = [
  "united",
  "multico",
  "uskudar",
  "okan",
  "beykent",
  "isik",
].sort();

test("six live-mapped advanced specs are valid v2, strict and non-active fallbacks", async () => {
  const files = (await fs.readdir(specDir))
    .filter((name) => name.endsWith(".v2.json"))
    .sort();
  const parsedKeys: string[] = [];

  for (const file of files) {
    const raw = JSON.parse(
      await fs.readFile(path.join(specDir, file), "utf8"),
    );
    const parsed = parseAdapterSpec(raw);
    assert.equal(
      parsed.ok,
      true,
      `${file}: ${parsed.ok ? "" : parsed.error}`,
    );
    if (!parsed.ok) continue;
    assert.equal(parsed.spec.specVersion, 2, file);
    assert.equal(parsed.spec.meta.dryRunPolicy, "strict", file);
    assert.equal(parsed.spec.meta.resolution, "fallback", file);
    assert.equal(parsed.spec.meta.experimental, true, file);
    assert.ok(parsed.spec.outcomes?.length, `${file}: outcomes missing`);
    parsedKeys.push(parsed.spec.meta.key);
  }

  assert.deepEqual(parsedKeys.sort(), expectedKeys);
});
