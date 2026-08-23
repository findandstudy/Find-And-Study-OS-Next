import { gzipSync } from "node:zlib";
import { and, asc, eq } from "drizzle-orm";
import {
  db,
  pool,
  programsTable,
  universitiesTable,
} from "@workspace/db";

type ProgramOption = {
  universityId: number;
  degree: string | null;
  field: string | null;
  language: string | null;
  duration: string | null;
};

const rows = await db
  .select({
    country: universitiesTable.country,
    universityId: universitiesTable.id,
    universityName: universitiesTable.name,
    programId: programsTable.id,
    degree: programsTable.degree,
    field: programsTable.field,
    language: programsTable.language,
    duration: programsTable.duration,
  })
  .from(programsTable)
  .innerJoin(universitiesTable, eq(programsTable.universityId, universitiesTable.id))
  .where(and(eq(programsTable.isActive, true), eq(universitiesTable.isActive, true)))
  .orderBy(asc(universitiesTable.country), asc(universitiesTable.name), asc(programsTable.id));

const countryMap = new Map<string, Map<number, { name: string; programIds: number[] }>>();
const programs: Record<number, ProgramOption> = {};

for (const row of rows) {
  const universities = countryMap.get(row.country) ?? new Map();
  countryMap.set(row.country, universities);
  const university = universities.get(row.universityId) ?? {
    name: row.universityName,
    programIds: [],
  };
  universities.set(row.universityId, university);
  university.programIds.push(row.programId);
  programs[row.programId] = {
    universityId: row.universityId,
    degree: row.degree,
    field: row.field,
    language: row.language,
    duration: row.duration,
  };
}

const countries = [...countryMap.entries()].map(([country, universities]) => ({
  country,
  universities: [...universities.entries()].map(([id, value]) => ({ id, ...value })),
}));
const payload = { countries, programs };
const jsonBytes = Buffer.byteLength(JSON.stringify(payload));
const gzipBytes = gzipSync(JSON.stringify(payload), { level: 6 }).byteLength;
const countryPayloads = countries.map((country) => ({
  country: country.country,
  gzipBytes: gzipSync(JSON.stringify(country), { level: 6 }).byteLength,
}));
const largestCountry = countryPayloads.sort((a, b) => b.gzipBytes - a.gzipBytes)[0] ?? null;

console.log(JSON.stringify({
  activePrograms: rows.length,
  activeUniversities: new Set(rows.map((row) => row.universityId)).size,
  countries: countries.length,
  jsonBytes,
  gzipBytes,
  averageJsonBytesPerProgram: rows.length > 0 ? Math.round(jsonBytes / rows.length) : 0,
  largestCountry,
  recommendation: gzipBytes <= 250_000
    ? "single-payload"
    : gzipBytes <= 600_000
      ? "split-reference-payload"
      : "country-scoped-options",
}, null, 2));

await pool.end();
