#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function fail(message) {
  throw new Error(`[nginx-preflight] ${message}`);
}

function readEffectiveConfig(inputPath) {
  if (inputPath) return fs.readFileSync(path.resolve(inputPath), "utf8");
  try {
    return execFileSync("nginx", ["-T"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim();
    fail(
      `could not read the effective Nginx configuration${detail ? `: ${detail}` : ""}`,
    );
  }
}

function stripComments(source) {
  return source.replace(/(^|\n)\s*#[^\n]*/g, "$1");
}

function balancedBody(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  fail("unbalanced braces in Nginx configuration");
}

function namedBlocks(source, directive) {
  const blocks = [];
  const pattern = new RegExp(`\\b${directive}\\s+([^\\s{]+)\\s*\\{`, "g");
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const openIndex = source.indexOf("{", match.index);
    blocks.push({ name: match[1], body: balancedBody(source, openIndex) });
  }
  return blocks;
}

function anonymousBlocks(source, directive) {
  const blocks = [];
  const pattern = new RegExp(`\\b${directive}\\s*\\{`, "g");
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const openIndex = source.indexOf("{", match.index);
    blocks.push(balancedBody(source, openIndex));
  }
  return blocks;
}

function validPort(value, label) {
  const port = String(value || "");
  if (!/^\d{2,5}$/.test(port)) fail(`${label} must be a numeric TCP port`);
  return port;
}

function hostMatches(serverName, host) {
  if (serverName === host) return true;
  if (!serverName.startsWith("*.")) return false;
  return host.endsWith(serverName.slice(1));
}

function validate(source, options) {
  const canonicalPort = validPort(options.canonicalPort, "PORT");
  const candidatePort = validPort(options.candidatePort, "CANDIDATE_PORT");
  if (canonicalPort === candidatePort)
    fail("canonical and candidate ports must differ");

  const host = String(options.host || "")
    .trim()
    .toLowerCase();
  if (!host) fail("host is required");

  const config = stripComments(source);
  const upstreams = new Map(
    namedBlocks(config, "upstream").map((block) => [block.name, block.body]),
  );
  const matchingServers = anonymousBlocks(config, "server").filter((body) => {
    const declarations = [...body.matchAll(/\bserver_name\s+([^;]+);/g)];
    return declarations.some((declaration) =>
      declaration[1]
        .trim()
        .split(/\s+/)
        .some((serverName) => hostMatches(serverName.toLowerCase(), host)),
    );
  });
  if (!matchingServers.length) fail(`no server block found for ${host}`);

  const proxyServers = matchingServers.filter((body) =>
    /\bproxy_pass\s+http:\/\//.test(body),
  );
  if (!proxyServers.length)
    fail(`server blocks for ${host} do not proxy application traffic`);

  const referencedUpstreams = new Set();
  for (const body of proxyServers) {
    const directCanonical = new RegExp(
      `\\bproxy_pass\\s+http://(?:127\\.0\\.0\\.1|localhost):${canonicalPort}(?:[/;])`,
    );
    if (directCanonical.test(body)) {
      fail(`${host} still proxies directly to canonical port ${canonicalPort}`);
    }
    for (const match of body.matchAll(
      /\bproxy_pass\s+http:\/\/([^/;\s]+)[^;]*;/g,
    )) {
      if (upstreams.has(match[1])) referencedUpstreams.add(match[1]);
    }
  }
  if (!referencedUpstreams.size)
    fail(`${host} does not reference a named Nginx upstream`);

  const protectedUpstreams = [];
  for (const upstreamName of referencedUpstreams) {
    const body = upstreams.get(upstreamName);
    const primary = new RegExp(
      `\\bserver\\s+(?:127\\.0\\.0\\.1|localhost):${canonicalPort}(?:\\s+[^;]*)?;`,
    );
    const backup = new RegExp(
      `\\bserver\\s+(?:127\\.0\\.0\\.1|localhost):${candidatePort}\\s+[^;]*\\bbackup\\b[^;]*;`,
    );
    if (primary.test(body) && backup.test(body))
      protectedUpstreams.push(upstreamName);
  }
  if (!protectedUpstreams.length) {
    fail(
      `${host} has no upstream with primary port ${canonicalPort} and backup port ${candidatePort}`,
    );
  }

  return { host, protectedUpstreams };
}

try {
  const inputIndex = process.argv.indexOf("--input");
  const inputPath =
    inputIndex === -1 ? undefined : process.argv[inputIndex + 1];
  if (inputIndex !== -1 && !inputPath) fail("--input requires a file path");
  const hostIndex = process.argv.indexOf("--host");
  const host = hostIndex === -1 ? undefined : process.argv[hostIndex + 1];
  if (hostIndex !== -1 && !host) fail("--host requires a hostname");
  const result = validate(readEffectiveConfig(inputPath), {
    host: host || process.env.NGINX_APP_HOST,
    canonicalPort: process.env.PORT,
    candidatePort: process.env.CANDIDATE_PORT,
  });
  console.log(
    `[nginx-preflight] OK: ${result.host} uses protected upstream(s): ` +
      result.protectedUpstreams.join(", "),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

module.exports = { validate };
