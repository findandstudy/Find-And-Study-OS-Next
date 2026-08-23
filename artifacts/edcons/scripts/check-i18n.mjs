#!/usr/bin/env node
// Build-time i18n key check.
// 1) Every namespaced key used via t("ns.key") in src/ must exist in en.json.
//    (Bare keys without a dot are skipped — some components use local dicts.)
// 2) Every non-en language file must contain every key present in en.json
//    (getTranslation silently falls back to en, hiding missing translations).
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const trDir = join(root, "src/lib/i18n/translations");
const en = JSON.parse(readFileSync(join(trDir, "en.json"), "utf8"));

function flatten(obj, prefix = "", out = new Set()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, out);
    else out.add(key);
  }
  return out;
}
const enKeys = flatten(en);

// ── 1) scan source for t("ns.key") usages ─────────────────────────────────
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx?|jsx?)$/.test(e.name)) files.push(p);
  }
})(join(root, "src"));

const used = new Set();
const re = /\bt\(\s*["']([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)["']/g;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(re)) used.add(m[1]);
}

const missingInEn = [...used].filter((k) => !enKeys.has(k)).sort();

// ── 2) parity: every lang must contain every en key ───────────────────────
const parityErrors = [];
for (const file of readdirSync(trDir)) {
  if (!file.endsWith(".json") || file === "en.json") continue;
  const keys = flatten(JSON.parse(readFileSync(join(trDir, file), "utf8")));
  const missing = [...enKeys].filter((k) => !keys.has(k));
  if (missing.length) parityErrors.push({ file, missing });
}

let failed = false;
if (missingInEn.length) {
  failed = true;
  console.error(`\n[i18n-check] ${missingInEn.length} key(s) used in code but missing from en.json:`);
  for (const k of missingInEn) console.error(`  - ${k}`);
}
for (const { file, missing } of parityErrors) {
  failed = true;
  console.error(`\n[i18n-check] ${file} is missing ${missing.length} key(s) present in en.json:`);
  for (const k of missing.slice(0, 40)) console.error(`  - ${k}`);
  if (missing.length > 40) console.error(`  ... and ${missing.length - 40} more`);
}

if (failed) {
  console.error("\n[i18n-check] FAILED — add the missing keys to ALL language files.");
  process.exit(1);
}
console.log(`[i18n-check] OK — ${used.size} used keys, ${enKeys.size} en keys, ${readdirSync(trDir).filter((f) => f.endsWith(".json")).length} languages in sync.`);
