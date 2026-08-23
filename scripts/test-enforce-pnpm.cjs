const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { afterEach, test } = require("node:test");

const { enforcePnpm } = require("./enforce-pnpm.cjs");

const temporaryRoots = [];

function createFixture({ withForeignLockfiles = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "fas-pnpm-guard-"));
  temporaryRoots.push(root);
  if (withForeignLockfiles) {
    writeFileSync(path.join(root, "package-lock.json"), "{}\n");
    writeFileSync(path.join(root, "yarn.lock"), "fixture\n");
  }
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts the repository-pinned pnpm user agent", () => {
  const repoRoot = createFixture();
  const result = enforcePnpm({ repoRoot, userAgent: "pnpm/10.33.2 npm/? node/v24" });

  assert.deepEqual(result, { allowed: true });
});

for (const userAgent of [
  undefined,
  "npm/11.0.0 node/v24",
  "yarn/1.22.22 npm/? node/v24",
  "pnpm/11.19.0 npm/? node/v24",
]) {
  test(`rejects a non-pnpm user agent: ${userAgent ?? "missing"}`, () => {
    const repoRoot = createFixture();
    const result = enforcePnpm({ repoRoot, userAgent });

    assert.equal(result.allowed, false);
    assert.match(result.message, /Use pnpm instead/);
  });
}

test("rejects and preserves foreign lockfiles instead of deleting them", () => {
  const repoRoot = createFixture({ withForeignLockfiles: true });
  const result = enforcePnpm({ repoRoot, userAgent: "pnpm/10.33.2 npm/? node/v24" });

  assert.equal(result.allowed, false);
  assert.match(result.message, /package-lock\.json/);
  assert.equal(existsSync(path.join(repoRoot, "package-lock.json")), true);
  assert.equal(existsSync(path.join(repoRoot, "yarn.lock")), true);
});
