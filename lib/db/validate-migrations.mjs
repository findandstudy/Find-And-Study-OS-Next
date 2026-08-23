#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const defaultMigrationsDir = path.join(root, "drizzle");
const defaultJournalPath = path.join(
  defaultMigrationsDir,
  "meta",
  "_journal.json",
);

export function validateMigrationLedger({
  migrationsDir = defaultMigrationsDir,
  journalPath = defaultJournalPath,
} = {}) {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  const byId = new Map();
  for (const file of files) {
    const id = file.slice(0, 4);
    byId.set(id, [...(byId.get(id) ?? []), file]);
  }
  const duplicates = [...byId.entries()].filter(
    ([, names]) => names.length > 1,
  );
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  const entries = Array.isArray(journal.entries) ? journal.entries : [];
  const tags = new Set(entries.map((entry) => entry.tag));
  const missingFromJournal = files
    .map((file) => file.replace(/\.sql$/, ""))
    .filter((tag) => !tags.has(tag));
  const missingFiles = entries
    .map((entry) => `${entry.tag}.sql`)
    .filter((file) => !files.includes(file));
  const problems = [];
  if (duplicates.length)
    problems.push(
      `duplicate ids: ${duplicates.map(([id, names]) => `${id}=[${names.join(",")}]`).join("; ")}`,
    );
  if (missingFromJournal.length)
    problems.push(
      `SQL files absent from journal: ${missingFromJournal.join(", ")}`,
    );
  if (missingFiles.length)
    problems.push(
      `journal entries without SQL files: ${missingFiles.join(", ")}`,
    );
  const ids = files.map((file) => Number(file.slice(0, 4)));
  const discontinuity = ids.findIndex((id, index) => id !== index);
  if (discontinuity >= 0)
    problems.push(
      `migration ids must be contiguous from 0000 (found ${files[discontinuity]})`,
    );
  if (journal.version !== "7" || journal.dialect !== "postgresql") {
    problems.push("journal must use Drizzle version 7 and postgresql dialect");
  }
  const journalTags = entries.map((entry) => entry.tag);
  const expectedTags = files.map((file) => file.replace(/\.sql$/, ""));
  if (journalTags.join("\0") !== expectedTags.join("\0")) {
    problems.push("journal order must exactly match migration filename order");
  }
  for (const [index, entry] of entries.entries()) {
    if (entry.idx !== index)
      problems.push(
        `journal idx mismatch at ${entry.tag}: expected ${index}, got ${entry.idx}`,
      );
    if (entry.version !== "7")
      problems.push(`journal entry ${entry.tag} must use version 7`);
    if (!Number.isSafeInteger(entry.when))
      problems.push(`journal entry ${entry.tag} has an invalid timestamp`);
    if (index > 0 && entry.when <= entries[index - 1].when) {
      problems.push(
        `journal timestamps must increase: ${entries[index - 1].tag} -> ${entry.tag}`,
      );
    }
  }
  const adoptionPath = path.join(
    migrationsDir,
    "0038_adopt_runtime_schema.sql",
  );
  if (fs.existsSync(adoptionPath)) {
    const statements = fs
      .readFileSync(adoptionPath, "utf8")
      .replace(/^\s*--.*$/gm, "")
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);
    const unsafe = statements.filter((statement) =>
      /^(?:DROP|TRUNCATE|DELETE|UPDATE|INSERT)\b/i.test(statement),
    );
    if (unsafe.length)
      problems.push(
        "0038 adoption migration must remain additive and data-preserving",
      );
  }
  if (problems.length)
    throw new Error(`[migration-validation] ${problems.join(" | ")}`);
  return { files: files.length, journalEntries: entries.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = validateMigrationLedger();
    console.log(
      `[migration-validation] OK: ${result.files} files, ${result.journalEntries} journal entries`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
