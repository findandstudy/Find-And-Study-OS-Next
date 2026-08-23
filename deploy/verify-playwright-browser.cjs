#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

function fail(message) {
  console.error(`[playwright-preflight] ${message}`);
  process.exit(1);
}

let chromium;
try {
  const portalRequire = createRequire(
    path.resolve(__dirname, "../lib/portal-adapters/package.json"),
  );
  ({ chromium } = portalRequire("playwright-core"));
} catch {
  fail("playwright-core is not installed; run pnpm install before this check");
}

const executable = chromium.executablePath();
if (!executable || !fs.existsSync(executable)) {
  fail(
    "Chromium is not provisioned. Install it in the host/image provisioning step; " +
    "release builds never install OS packages or browser binaries",
  );
}

console.log("[playwright-preflight] OK: Chromium executable is pre-provisioned");
