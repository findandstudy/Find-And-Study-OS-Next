import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const routesRoot = join(root, "artifacts", "api-server", "src", "routes");
const registryPath = join(root, "security", "legacy-role-gate-registry.json");
const writeMode = process.argv.includes("--write");
const jsonMode = process.argv.includes("--json");
const strictMode = process.argv.includes("--strict");

function walk(dir) {
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    })
    .filter((path) => path.endsWith(".ts"));
}

function count(source, pattern) {
  return Array.from(source.matchAll(pattern)).length;
}

function routePrefixes(source) {
  const starts = Array.from(source.matchAll(/\brouter\.(?:get|post|put|patch|delete)\s*\(/g));
  return starts.map((match, index) => {
    const start = match.index ?? 0;
    const next = starts[index + 1]?.index ?? source.length;
    const candidate = source.slice(start, Math.min(next, start + 2_000));
    const handler = candidate.search(/\basync\s*\(/);
    return handler >= 0 ? candidate.slice(0, handler) : candidate;
  });
}

function scanFile(path, previous) {
  const source = readFileSync(path, "utf8").replace(/\r\n?/g, "\n");
  const prefixes = routePrefixes(source);
  const routeRegistrations = prefixes.length;
  const authOnlyRouteCandidates = prefixes.filter((prefix) =>
    /\brequireAuth\b/.test(prefix) &&
    !/\brequireRole\s*\(/.test(prefix) &&
    !/\brequirePermission\s*\(/.test(prefix) &&
    !/\brequireScope\s*\(/.test(prefix)
  ).length;
  const publicRouteCandidates = prefixes.filter((prefix) => !/\brequireAuth\b/.test(prefix)).length;
  return {
    path: relative(root, path).replaceAll("\\", "/"),
    sha256: createHash("sha256").update(source).digest("hex"),
    routeRegistrations,
    requireAuth: count(source, /\brequireAuth\b/g),
    requireRole: count(source, /\brequireRole\s*\(/g),
    requirePermission: count(source, /\brequirePermission\s*\(/g),
    requireScope: count(source, /\brequireScope\s*\(/g),
    directRoleChecks: count(
      source,
      /(?:req\.user!?\.role\s*(?:===|!==)|(?:ADMIN|MANAGER|STAFF|AGENT|FINANCE|CONTENT|STUDENT)_ROLES\.includes\s*\(\s*req\.user!?\.role)/g,
    ),
    authOnlyRouteCandidates,
    publicRouteCandidates,
    enforcement: previous?.enforcement ?? "legacy_quarantine",
    owner: previous?.owner ?? "Platform Engineering",
    note: previous?.note ?? "Route-local review required before corridor migration.",
  };
}

const previousRegistry = existsSync(registryPath)
  ? JSON.parse(readFileSync(registryPath, "utf8"))
  : null;
const previousByPath = new Map((previousRegistry?.files ?? []).map((file) => [file.path, file]));
const files = walk(routesRoot)
  .map((path) => scanFile(path, previousByPath.get(relative(root, path).replaceAll("\\", "/"))))
  .sort((a, b) => a.path.localeCompare(b.path));

const totals = files.reduce((acc, file) => {
  for (const key of [
    "routeRegistrations",
    "requireAuth",
    "requireRole",
    "requirePermission",
    "requireScope",
    "directRoleChecks",
    "authOnlyRouteCandidates",
    "publicRouteCandidates",
  ]) acc[key] += file[key];
  return acc;
}, {
  routeRegistrations: 0,
  requireAuth: 0,
  requireRole: 0,
  requirePermission: 0,
  requireScope: 0,
  directRoleChecks: 0,
  authOnlyRouteCandidates: 0,
  publicRouteCandidates: 0,
});

const registry = {
  schemaVersion: 1,
  generatedFrom: "scripts/audit-legacy-role-gates.mjs",
  policy: {
    denominator: "Every TypeScript route file and every router registration in artifacts/api-server/src/routes.",
    meaning: "Counts are conservative review surfaces, not proof that a route is vulnerable or authorized.",
    migrationTarget: "Signed active context plus versioned access assignment/capability; users.role becomes compatibility projection only.",
    defaultEnforcement: "legacy_quarantine",
  },
  totals,
  files,
};

if (writeMode) {
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

const errors = [];
if (!previousRegistry && !writeMode) {
  errors.push("registry is missing; run with --write after review");
} else if (!writeMode) {
  const actualByPath = new Map(files.map((file) => [file.path, file]));
  const frozenByPath = new Map((previousRegistry.files ?? []).map((file) => [file.path, file]));
  for (const [path, actual] of actualByPath) {
    const frozen = frozenByPath.get(path);
    if (!frozen) {
      errors.push(`unclassified route file: ${path}`);
      continue;
    }
    for (const key of [
      "sha256",
      "routeRegistrations",
      "requireAuth",
      "requireRole",
      "requirePermission",
      "requireScope",
      "directRoleChecks",
      "authOnlyRouteCandidates",
      "publicRouteCandidates",
    ]) {
      if (actual[key] !== frozen[key]) errors.push(`drift ${path} ${key}: registry=${frozen[key]} actual=${actual[key]}`);
    }
    if (!["legacy_quarantine", "corridor_migrated", "public_reviewed"].includes(frozen.enforcement)) {
      errors.push(`invalid enforcement ${path}: ${frozen.enforcement}`);
    }
    if (!frozen.owner) errors.push(`missing owner: ${path}`);
  }
  for (const path of frozenByPath.keys()) {
    if (!actualByPath.has(path)) errors.push(`stale route registry entry: ${path}`);
  }
}

if (strictMode) {
  const remaining = (writeMode ? files : previousRegistry?.files ?? [])
    .filter((file) => file.routeRegistrations > 0 && file.enforcement === "legacy_quarantine");
  if (remaining.length > 0) errors.push(`${remaining.length} route files remain in legacy quarantine`);
}

const summary = {
  schemaVersion: registry.schemaVersion,
  routeFileCount: files.length,
  ...totals,
  enforcement: Object.fromEntries(
    ["legacy_quarantine", "corridor_migrated", "public_reviewed"].map((state) => [
      state,
      files.filter((file) => file.enforcement === state).length,
    ]),
  ),
  errors,
};

if (jsonMode) console.log(JSON.stringify(summary, null, 2));
else {
  console.log("Find & Study OS legacy role-gate inventory");
  console.log(JSON.stringify(summary, null, 2));
}

if (errors.length > 0) process.exitCode = 1;
