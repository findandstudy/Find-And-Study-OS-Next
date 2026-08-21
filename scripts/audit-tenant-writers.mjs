import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const registryPath = join(repoRoot, "security", "tenant-writer-registry.json");
const sourceRoots = [
  join(repoRoot, "artifacts", "api-server", "src"),
  join(repoRoot, "artifacts", "portal-automation-worker", "src"),
];

const surfacePatterns = [
  {
    kind: "database_orm_write",
    expression: /\b(?:db|tx|conn|pool|client)\s*\.(?:insert|update|delete|execute|query)\s*\(/g,
  },
  {
    kind: "database_raw_sql",
    expression:
      /\b(?:db|tx|conn|pool|client)\s*\.(?:query|execute)\s*\(\s*(?:sql\s*)?[`'"]\s*(?:alter|create|delete|drop|insert|merge|truncate|update)\b/gi,
  },
  {
    kind: "object_or_file_write",
    expression:
      /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|unlink|unlinkSync|rm|rmSync|mkdir|mkdirSync|writeLocalObjectBuffer|uploadObject|putObject|deleteObject|copyObject)\s*\(/g,
  },
  {
    kind: "external_side_effect",
    expression:
      /\b(?:sendWhatsApp\w*|sendMessenger\w*|sendInstagram\w*|sendZernio\w*|sendViaZernio|sendEmail\w*|sendSms\w*|dispatchNotification\w*|submitApplication\w*|startSubmission\w*|enqueue\w*|publish\w*)\s*\(/g,
  },
  {
    kind: "event_or_cache_write",
    expression:
      /(?:\b(?:inboxBus|feedBus|notificationBus|redis|cache)\s*\.(?:publish|emit|set|del|delete|invalidate)|\b(?:invalidate\w*Cache|set\w*Cache|delete\w*Cache|clear\w*Cache))\s*\(/g,
  },
  {
    kind: "scheduler_or_worker",
    expression: /\b(?:setInterval|cron\.schedule|start\w*(?:Worker|Scheduler)|run\w*Sweep)\s*\(/g,
  },
];

const allowedOwnership = new Set([
  "tenant_owned",
  "platform_global",
  "privileged_config",
  "public_ingress",
  "external_integration",
  "mixed_legacy",
]);
const allowedEnforcement = new Set([
  "db_enforced",
  "runtime_scoped",
  "allowlisted_global",
  "receipt_guarded",
  "quarantine_required",
]);
const allowedRisk = new Set(["critical", "high", "medium", "low"]);
const allowedExternalPilot = new Set(["allow", "quarantine"]);

function walk(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(absolute));
    else if (extname(entry.name) === ".ts") result.push(absolute);
  }
  return result;
}

function normalizedPath(absolute) {
  return relative(repoRoot, absolute).replaceAll("\\", "/");
}

function lineNumber(source, index) {
  let line = 1;
  for (let offset = 0; offset < index; offset += 1) {
    if (source.charCodeAt(offset) === 10) line += 1;
  }
  return line;
}

function discoverSurfaces() {
  const surfaces = [];
  for (const sourceRoot of sourceRoots) {
    for (const absolute of walk(sourceRoot)) {
      const path = normalizedPath(absolute);
      const source = readFileSync(absolute, "utf8");
      for (const pattern of surfacePatterns) {
        pattern.expression.lastIndex = 0;
        let match;
        while ((match = pattern.expression.exec(source)) !== null) {
          const line = lineNumber(source, match.index);
          const signature = match[0].replace(/\s+/g, " ").trim().slice(0, 120);
          const id = createHash("sha256")
            .update(`${path}\0${pattern.kind}\0${signature}\0${line}`)
            .digest("hex")
            .slice(0, 16);
          surfaces.push({ id, path, line, kind: pattern.kind, signature });
          if (match[0].length === 0) pattern.expression.lastIndex += 1;
        }
      }
    }
  }
  return surfaces.sort((a, b) =>
    a.path.localeCompare(b.path) || a.line - b.line || a.kind.localeCompare(b.kind),
  );
}

function loadRegistry() {
  if (!existsSync(registryPath)) return null;
  const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.files)) {
    throw new Error("tenant writer registry must use schemaVersion=1 and a files array");
  }
  return parsed;
}

function validateRegistry(registry, discoveredFiles) {
  const errors = [];
  const byPath = new Map();
  for (const entry of registry.files) {
    if (!entry || typeof entry.path !== "string") {
      errors.push("registry entry is missing path");
      continue;
    }
    if (byPath.has(entry.path)) errors.push(`duplicate registry path: ${entry.path}`);
    byPath.set(entry.path, entry);
    if (!allowedOwnership.has(entry.ownership)) {
      errors.push(`${entry.path}: invalid ownership ${String(entry.ownership)}`);
    }
    if (!allowedEnforcement.has(entry.enforcement)) {
      errors.push(`${entry.path}: invalid enforcement ${String(entry.enforcement)}`);
    }
    if (!allowedRisk.has(entry.risk)) {
      errors.push(`${entry.path}: invalid risk ${String(entry.risk)}`);
    }
    if (!allowedExternalPilot.has(entry.externalPilot)) {
      errors.push(`${entry.path}: invalid externalPilot ${String(entry.externalPilot)}`);
    }
    if (typeof entry.owner !== "string" || entry.owner.trim() === "") {
      errors.push(`${entry.path}: owner is required`);
    }
    if (entry.externalPilot === "allow" && entry.enforcement === "quarantine_required") {
      errors.push(`${entry.path}: an external-pilot allow entry cannot require quarantine`);
    }
  }

  for (const path of discoveredFiles) {
    if (!byPath.has(path)) errors.push(`unclassified writer file: ${path}`);
  }
  for (const path of byPath.keys()) {
    if (!discoveredFiles.has(path)) errors.push(`stale registry file: ${path}`);
  }
  return { errors, byPath };
}

function summarize(surfaces, registry, byPath) {
  const files = [...new Set(surfaces.map((surface) => surface.path))];
  const countsByKind = Object.fromEntries(
    surfacePatterns.map(({ kind }) => [
      kind,
      surfaces.filter((surface) => surface.kind === kind).length,
    ]),
  );
  const countsByEnforcement = {};
  const countsByOwnership = {};
  let allowlistedFiles = 0;
  let quarantinedFiles = 0;
  for (const path of files) {
    const entry = byPath?.get(path);
    if (!entry) continue;
    countsByEnforcement[entry.enforcement] = (countsByEnforcement[entry.enforcement] ?? 0) + 1;
    countsByOwnership[entry.ownership] = (countsByOwnership[entry.ownership] ?? 0) + 1;
    if (entry.externalPilot === "allow") allowlistedFiles += 1;
    else quarantinedFiles += 1;
  }
  return {
    schemaVersion: 1,
    roots: sourceRoots.map(normalizedPath),
    fileCount: files.length,
    surfaceCount: surfaces.length,
    classifiedFileCount: byPath?.size ?? 0,
    externalPilotAllowlistedFileCount: allowlistedFiles,
    externalPilotQuarantinedFileCount: quarantinedFiles,
    countsByKind,
    countsByOwnership,
    countsByEnforcement,
    precedence: registry?.precedence ?? null,
  };
}

const args = new Set(process.argv.slice(2));
const surfaces = discoverSurfaces();
const discoveredFiles = new Set(surfaces.map((surface) => surface.path));
const registry = loadRegistry();

if (!registry) {
  if (args.has("--files-only")) {
    console.log([...discoveredFiles].sort().join("\n"));
    process.exitCode = 2;
  } else {
  const discovery = {
    schemaVersion: 1,
    files: [...discoveredFiles].sort().map((path) => ({ path })),
    surfaces,
  };
  console.log(JSON.stringify(discovery, null, 2));
  process.exitCode = 2;
  }
} else {
  const { errors, byPath } = validateRegistry(registry, discoveredFiles);
  const summary = summarize(surfaces, registry, byPath);
  const strictErrors = args.has("--strict")
    ? registry.files
        .filter((entry) =>
          (entry.risk === "critical" || entry.risk === "high") &&
          entry.enforcement === "quarantine_required",
        )
        .map((entry) => `${entry.path}: ${entry.risk} writer is still quarantined`)
    : [];
  const allErrors = [...errors, ...strictErrors];

  if (args.has("--json")) {
    console.log(JSON.stringify({ summary, errors: allErrors, surfaces }, null, 2));
  } else {
    console.log("Find & Study OS tenant writer inventory");
    console.log(JSON.stringify(summary, null, 2));
    if (allErrors.length) {
      console.error("Inventory errors:");
      for (const error of allErrors) console.error(`- ${error}`);
    }
  }
  if (allErrors.length) process.exitCode = 1;
}
