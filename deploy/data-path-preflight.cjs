#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function fail(message) {
  throw new Error(`[data-path-preflight] ${message}`);
}

function existingRealpath(target, label) {
  if (!fs.existsSync(target)) fail(`${label} does not exist`);
  return fs.realpathSync(target);
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function validateDataPaths({ releaseDir, storageDir }) {
  const release = existingRealpath(path.resolve(releaseDir), "release directory");
  if (!storageDir) fail("STORAGE_LOCAL_DIR is required when STORAGE_DRIVER=local");
  if (!path.isAbsolute(storageDir)) fail("STORAGE_LOCAL_DIR must be an absolute path");
  const storage = existingRealpath(storageDir, "storage directory");
  if (storage === release || isWithin(release, storage)) {
    fail("STORAGE_LOCAL_DIR must be outside the code release directory");
  }
  return { release, storage };
}

function validateReleaseRuntimePaths({ releaseDir, releasesDir, logDir, runtimeEnvFile }) {
  const release = existingRealpath(path.resolve(releaseDir), "release directory");
  if (!releasesDir || !path.isAbsolute(releasesDir)) fail("RELEASES_DIR must be absolute");
  if (!logDir || !path.isAbsolute(logDir)) fail("LOG_DIR must be absolute");
  if (!runtimeEnvFile || !path.isAbsolute(runtimeEnvFile)) fail("RUNTIME_ENV_FILE must be absolute");
  const releases = existingRealpath(releasesDir, "releases directory");
  const logs = existingRealpath(logDir, "log directory");
  const runtimeEnv = existingRealpath(runtimeEnvFile, "runtime env file");
  if (!isWithin(releases, release)) fail("release directory must be inside RELEASES_DIR");
  for (const [label, target] of [["LOG_DIR", logs], ["RUNTIME_ENV_FILE", runtimeEnv]]) {
    if (isWithin(release, target) || isWithin(releases, target)) {
      fail(`${label} must be outside immutable release storage`);
    }
  }
  return { release, releases, logs, runtimeEnv };
}

function main() {
  const inputIndex = process.argv.indexOf("--input");
  const inputPath = inputIndex === -1 ? undefined : process.argv[inputIndex + 1];
  let releaseDir = process.env.APP_RELEASE_DIR
    ? path.resolve(process.env.APP_RELEASE_DIR)
    : path.resolve(__dirname, "..");
  let storageDir = process.env.STORAGE_LOCAL_DIR;

  if (inputPath) {
    const fixture = JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8"));
    releaseDir = fixture.releaseDir;
    storageDir = fixture.storageDir;
  } else {
    validateReleaseRuntimePaths({
      releaseDir,
      releasesDir: process.env.RELEASES_DIR,
      logDir: process.env.LOG_DIR,
      runtimeEnvFile: process.env.RUNTIME_ENV_FILE,
    });
  }

  if (!inputPath && (process.env.STORAGE_DRIVER ?? "replit") !== "local") {
    console.log("[data-path-preflight] OK: non-local storage driver; no release-local persistent path");
    return;
  }

  validateDataPaths({ releaseDir, storageDir });
  console.log("[data-path-preflight] OK: persistent storage is absolute and outside the release directory");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = { isWithin, validateDataPaths, validateReleaseRuntimePaths };
