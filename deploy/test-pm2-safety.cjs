#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const configPath = path.join(__dirname, "ecosystem.config.cjs");
const preflightPath = path.join(__dirname, "pm2-preflight.cjs");
const nginxPreflightPath = path.join(__dirname, "nginx-preflight.cjs");
const nginxInstallerPath = path.join(__dirname, "install-nginx-failover.sh");

function processEntry(name, script, port) {
  return {
    name,
    pm2_env: {
      name,
      pm_exec_path: script,
      exec_mode: "fork_mode",
      ...(port ? { PORT: port } : {}),
    },
  };
}

function runPreflight(processes, releaseLink) {
  const directory = mkdtempSync(path.join(tmpdir(), "fasos-pm2-test-"));
  const fixture = path.join(directory, "jlist.json");
  writeFileSync(fixture, JSON.stringify(processes));
  const args = [preflightPath, "--input", fixture];
  if (releaseLink) args.push("--release-link", releaseLink);
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
  });
  rmSync(directory, { recursive: true, force: true });
  return result;
}

function runNginxPreflight(config, env = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "fasos-nginx-test-"));
  const fixture = path.join(directory, "nginx.conf");
  writeFileSync(fixture, config);
  const result = spawnSync(
    process.execPath,
    [
      nginxPreflightPath,
      "--input",
      fixture,
      "--host",
      "apply.findandstudy.com",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PORT: "5057", CANDIDATE_PORT: "5058", ...env },
    },
  );
  rmSync(directory, { recursive: true, force: true });
  return result;
}

const canonical = [
  processEntry(
    "fasos-apply-api",
    "/app/artifacts/api-server/dist/index.cjs",
    5000,
  ),
  processEntry(
    "findandstudy-portal-worker",
    "/app/artifacts/portal-automation-worker/src/worker.ts",
  ),
];

test("authoritative config uses canonical fork/1 topology", () => {
  const config = require(configPath);
  assert.deepEqual(config.processNames, {
    api: "fasos-apply-api",
    portalWorker: "findandstudy-portal-worker",
  });
  assert.equal(config.apps.length, 2);
  for (const app of config.apps) {
    assert.equal(app.exec_mode, "fork");
    assert.equal(app.instances, 1);
  }
  const api = config.apps.find((app) => app.name === config.processNames.api);
  const portalWorker = config.apps.find(
    (app) => app.name === config.processNames.portalWorker,
  );
  assert.equal(String(api?.env_production.PORT), process.env.PORT || "5000");
  assert.equal(portalWorker?.env_production.PORT, "");
  assert.equal(
    portalWorker?.interpreter,
    path.join(
      process.env.CURRENT_RELEASE_LINK
        ? path.resolve(process.env.CURRENT_RELEASE_LINK)
        : path.resolve(__dirname, ".."),
      "artifacts/portal-automation-worker/node_modules/.bin/tsx",
    ),
  );
});

test("valid existing canonical topology passes", () => {
  const result = runPreflight(canonical);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK: fasos-apply-api \(fork\/1/);
});

test("missing or duplicate canonical processes are rejected", () => {
  assert.equal(runPreflight(canonical.slice(0, 1)).status, 1);
  assert.equal(runPreflight([...canonical, canonical[0]]).status, 1);
  assert.equal(runPreflight([...canonical, canonical[1]]).status, 1);
});

test("legacy names, duplicate API port and alternate worker are rejected", () => {
  assert.equal(
    runPreflight([
      ...canonical,
      processEntry("edconsult-os-api", "/app/api.cjs"),
    ]).status,
    1,
  );
  assert.equal(
    runPreflight([
      ...canonical,
      processEntry("other-api", "/app/other.cjs", 5000),
    ]).status,
    1,
  );
  assert.equal(
    runPreflight([
      ...canonical,
      processEntry(
        "other-worker",
        "/app/artifacts/portal-automation-worker/src/worker.ts",
      ),
    ]).status,
    1,
  );
});

test("non-fork canonical process is rejected", () => {
  const clusterApi = structuredClone(canonical[0]);
  clusterApi.pm2_env.exec_mode = "cluster_mode";
  assert.equal(runPreflight([clusterApi, canonical[1]]).status, 1);
});

test("release cutover rejects canonical processes outside the current symlink", () => {
  const underCurrent = [
    processEntry(
      "fasos-apply-api",
      "/srv/fasos/current/artifacts/api-server/dist/index.cjs",
      5000,
    ),
    processEntry(
      "findandstudy-portal-worker",
      "/srv/fasos/current/artifacts/portal-automation-worker/src/worker.ts",
    ),
  ];
  assert.equal(runPreflight(underCurrent, "/srv/fasos/current").status, 0);
  assert.equal(runPreflight(canonical, "/srv/fasos/current").status, 1);
});

test("deploy entrypoints use preflight and contain no blind fallback", () => {
  const deploy = readFileSync(
    path.join(__dirname, "deploy.sh"),
    "utf8",
  ).replace(/\r\n?/g, "\n");
  const compatibility = readFileSync(
    path.join(root, "scripts/deploy.sh"),
    "utf8",
  ).replace(/\r\n?/g, "\n");
  assert.match(deploy, /node deploy\/pm2-preflight\.cjs/);
  assert.match(deploy, /node deploy\/nginx-preflight\.cjs/);
  assert.match(deploy, /CANDIDATE_PORT/);
  assert.match(deploy, /Keep the validated candidate alive/);
  assert.match(deploy, /Reloading Nginx with the healthy candidate available/);
  assert.match(deploy, /nginx -s reload/);
  assert.match(
    deploy,
    /cleanup_candidate\n+candidate_pid=""\n+trap - EXIT INT TERM/,
  );
  assert.match(deploy, /rollback_code/);
  assert.match(deploy, /release_health_ready/);
  assert.match(deploy, /EXPECTED_RELEASE_ID/);
  assert.match(deploy, /git archive/);
  assert.doesNotMatch(deploy, /pm2 start|startOrRestart|pm2 restart all/);

  const nginx = readFileSync(path.join(__dirname, "nginx.conf"), "utf8");
  assert.match(nginx, /server 127\.0\.0\.1:5057 backup max_fails=0;/);
  assert.doesNotMatch(
    nginx,
    /^\s*proxy_next_upstream\s+[^;\n]*non_idempotent/m,
  );
  assert.match(
    deploy,
    /restart_pm2_process "\$PORTAL_WORKER_PROCESS_NAME" true/,
  );
  assert.match(deploy, /restart_pm2_process "\$API_PROCESS_NAME"/);
  assert.match(deploy, /pm2_process_exists_once/);
  assert.match(compatibility, /exec bash .*deploy\/deploy\.sh/);
  assert.doesNotMatch(compatibility, /pm2|migrate/);

  const standaloneWorker = readFileSync(
    path.join(root, "start-portal-worker.sh"),
    "utf8",
  );
  assert.match(
    standaloneWorker,
    /Standalone portal worker startup is disabled/,
  );
  assert.doesNotMatch(standaloneWorker, /pnpm run start|worker\.ts/);
});

test("Nginx preflight accepts a protected host route", () => {
  const result = runNginxPreflight(`
    upstream fasos_backend {
      server 127.0.0.1:5057 max_fails=0;
      server 127.0.0.1:5058 backup max_fails=0;
    }
    server {
      server_name apply.findandstudy.com;
      location / { proxy_pass http://fasos_backend; }
    }
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /uses protected upstream/);
});

test("Nginx preflight rejects direct, missing-backup and unrelated host routes", () => {
  assert.equal(
    runNginxPreflight(`
      server {
        server_name apply.findandstudy.com;
        location / { proxy_pass http://127.0.0.1:5057; }
      }
    `).status,
    1,
  );
  assert.equal(
    runNginxPreflight(`
      upstream fasos_backend { server 127.0.0.1:5057; }
      server {
        server_name apply.findandstudy.com;
        location / { proxy_pass http://fasos_backend; }
      }
    `).status,
    1,
  );
  assert.equal(
    runNginxPreflight(`
      upstream fasos_backend {
        server 127.0.0.1:5057;
        server 127.0.0.1:5058 backup;
      }
      server {
        server_name other.example.com;
        location / { proxy_pass http://fasos_backend; }
      }
    `).status,
    1,
  );
});

test("Nginx installer changes only explicit files and keeps rollback copies", (t) => {
  const bashProbe = spawnSync("bash", ["-c", "exit 0"], {
    encoding: "utf8",
  });
  if (bashProbe.error || bashProbe.status !== 0) {
    t.skip("a working bash runtime is unavailable on this host");
    return;
  }

  const directory = mkdtempSync(
    path.join(tmpdir(), "fasos-nginx-install-test-"),
  );
  const binDirectory = path.join(directory, "bin");
  const siteConfig = path.join(directory, "apply.conf");
  const unrelatedConfig = path.join(directory, "unrelated.conf");
  const upstreamConfig = path.join(directory, "findandstudy-upstream.conf");
  const envFile = path.join(directory, "runtime.env");
  const backupDirectory = path.join(directory, "backup");
  require("node:fs").mkdirSync(binDirectory);
  writeFileSync(
    siteConfig,
    "server { server_name apply.findandstudy.com; location / { proxy_pass http://127.0.0.1:5057; } }\n",
  );
  writeFileSync(
    unrelatedConfig,
    "server { server_name unrelated.example.com; location / { proxy_pass http://127.0.0.1:5057; } }\n",
  );
  writeFileSync(
    envFile,
    "PORT=5057\nCANDIDATE_PORT=5058\nAPP_BASE_URL=https://apply.findandstudy.com\n",
  );
  const fakeCommands = {
    id: '#!/bin/sh\n[ "$1" = "-u" ] && echo 0\n',
    nginx:
      '#!/bin/sh\nif [ "$1" = "-T" ]; then cat "$TEST_UPSTREAM" "$TEST_SITE"; fi\nexit 0\n',
    systemctl: "#!/bin/sh\nexit 0\n",
  };
  for (const [name, source] of Object.entries(fakeCommands)) {
    const commandPath = path.join(binDirectory, name);
    writeFileSync(commandPath, source);
    chmodSync(commandPath, 0o755);
  }

  const result = spawnSync("bash", [nginxInstallerPath], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH}`,
      RUNTIME_ENV_FILE: envFile,
      NGINX_SITE_CONFIGS: siteConfig,
      NGINX_UPSTREAM_FILE: upstreamConfig,
      NGINX_CONFIG_BACKUP_DIR: backupDirectory,
      TEST_UPSTREAM: upstreamConfig,
      TEST_SITE: siteConfig,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    readFileSync(siteConfig, "utf8"),
    /proxy_pass http:\/\/fasos_backend;/,
  );
  assert.match(
    readFileSync(upstreamConfig, "utf8"),
    /127\.0\.0\.1:5058 backup max_fails=0;/,
  );
  assert.match(
    readFileSync(upstreamConfig, "utf8"),
    /127\.0\.0\.1:5057 max_fails=0;/,
  );
  assert.match(
    readFileSync(path.join(backupDirectory, "site-0.conf"), "utf8"),
    /proxy_pass http:\/\/127\.0\.0\.1:5057;/,
  );
  assert.match(readFileSync(unrelatedConfig, "utf8"), /127\.0\.0\.1:5057/);
  rmSync(directory, { recursive: true, force: true });
});
