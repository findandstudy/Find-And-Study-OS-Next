import { db, aiDefaultConfigsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { ExtractorFieldDef } from "@workspace/db";

export const HARDCODED_EXTRACTOR_FIELDS: ExtractorFieldDef[] = [
  { key: "firstName", label: "First name", type: "string", description: "Latin-alphabet version from the document (e.g. 'ELMIR' not 'ELMİR'). Use the dedicated Latin/transliteration line or MRZ — never the local-script line." },
  { key: "lastName", label: "Last name", type: "string", description: "Latin-alphabet version from the document (e.g. 'ALIZADA' not 'ƏLİZADƏ'). Use the dedicated Latin/transliteration line or MRZ — never the local-script line." },
  { key: "dateOfBirth", label: "Date of birth", type: "date", normalize: "dateYmd", format: "YYYY-MM-DD" },
  { key: "gender", label: "Gender", type: "enum", enumValues: ["male", "female"], description: "Read the passport sex/gender marker. Convert M to male and F to female." },
  { key: "nationality", label: "Nationality", type: "string", description: "Full country name (e.g. 'Turkey' not 'Turkish')" },
  { key: "passportNumber", label: "Passport number", type: "string" },
  { key: "passportIssueDate", label: "Passport issue date", type: "date", normalize: "dateYmd", format: "YYYY-MM-DD" },
  { key: "passportExpiry", label: "Passport expiry", type: "date", normalize: "dateYmd", format: "YYYY-MM-DD" },
  { key: "passportExpired", label: "Passport expired", type: "boolean" },
  { key: "motherName", label: "Mother's name", type: "string" },
  { key: "fatherName", label: "Father's name", type: "string" },
  { key: "email", label: "Email", type: "string" },
  { key: "phone", label: "Phone", type: "string" },
  { key: "address", label: "Address", type: "string" },
  { key: "highSchool", label: "High school", type: "string" },
  { key: "graduationYear", label: "Graduation year", type: "number" },
  { key: "gpa", label: "GPA", type: "string", normalize: "gpa100", description: "Overall marks exactly as printed. Include numerator and denominator (e.g. 955/1200); never return the numerator alone." },
  { key: "languageScore", label: "Language score", type: "string" },
  { key: "documentType", label: "Document type", type: "enum", enumValues: ["passport", "diploma", "transcript", "photo", "other"] },
  { key: "confidence", label: "Confidence", type: "enum", enumValues: ["high", "medium", "low"] },
  { key: "extractedNotes", label: "Notes", type: "string" },
  // Education record fields — extracted from diploma / transcript documents.
  // Only populated when documentType is "diploma" or "transcript".
  { key: "eduLevel", label: "Education level", type: "enum", enumValues: ["high_school", "bachelor", "master"], description: "Level of the degree shown on this document (high_school / bachelor / master)." },
  // Primary keys read by the ai-extract upsert block:
  { key: "institutionName", label: "Institution name", type: "string", description: "Official name of the school or university as printed on the document." },
  { key: "country", label: "Institution country", type: "string", description: "Country where the institution is located (diploma/transcript)." },
  { key: "eduCity", label: "Institution city", type: "string", description: "City where the institution is located (diploma/transcript)." },
  { key: "fieldOfStudy", label: "Field of study / major", type: "string", description: "Degree programme or major (e.g. 'Computer Engineering')." },
  { key: "eduStartMonth", label: "Study start month", type: "string", description: "English month name when studies started (e.g. 'September')." },
  { key: "eduStartYear", label: "Study start year", type: "number", description: "4-digit year when studies started." },
  { key: "eduEndMonth", label: "Graduation month", type: "string", description: "English month name of graduation/completion (e.g. 'June')." },
  { key: "eduLanguageScore", label: "Language test score", type: "string", description: "Language proficiency test score visible on the document (e.g. 'IELTS 6.5', 'TOEFL 90')." },
  // Legacy keys kept for backwards-compat with custom DB-configured extractors:
  { key: "eduSchoolName", label: "School / university name (legacy)", type: "string", description: "Alias for institutionName — prefer institutionName." },
  { key: "eduCountry", label: "School country (legacy)", type: "string", description: "Alias for country — prefer country." },
  { key: "eduFieldOfStudy", label: "Field of study (legacy)", type: "string", description: "Alias for fieldOfStudy — prefer fieldOfStudy." },
  { key: "eduGraduationYear", label: "Graduation year", type: "number", description: "4-digit year of graduation / degree completion." },
  { key: "eduGpa", label: "GPA / grade", type: "string", description: "Raw GPA or overall grade as printed on the document (e.g. '3.5', '85.4', 'A')." },
  { key: "eduGpaType", label: "GPA scale type", type: "enum", enumValues: ["4.0", "percentage", "letter"], description: "Scale the GPA is expressed on: 4.0 for 0–4 scale, percentage for 0–100, letter for letter grade." },
];

export const HARDCODED_EXTRACTOR_RULES: string[] = [
  "CRITICAL - Names: Passports often show the name in TWO scripts: the local/national script (e.g. Cyrillic, Arabic, Azerbaijani Ə-letters) AND a Latin-alphabet transliteration. ALWAYS prefer the Latin-alphabet version. If a dedicated 'Given name / Ad' or 'Surname / Soyad' Latin line exists, use that. If not, fall back to the MRZ (bottom lines, always Latin). Never return characters from non-Latin scripts (e.g. Ə, İ, Ğ, Ş, Ç, Ö, Ü with cedilla/breve from Azerbaijani/Turkish local script, Cyrillic, Arabic etc.) in firstName or lastName — use the plain-ASCII Latin equivalent shown elsewhere on the document.",
  "CRITICAL - Date format awareness: Different countries use different date formats. Most countries use DD/MM/YYYY; USA uses MM/DD/YYYY; East Asia uses YYYY/MM/DD. Use the issuing country's convention; always output YYYY-MM-DD.",
  "CRITICAL - Passport expiry: Compare expiry date to today; set passportExpired true if past.",
  "For nationality: always return the full official country name. Convert any demonym or adjective form to the country name (e.g. 'Afghan' → 'Afghanistan', 'Turkish' → 'Turkey').",
  "Always normalize dates to YYYY-MM-DD format.",
  "For marks/GPA, extract the overall obtained marks together with the printed total/out-of denominator. Never return a numerator such as 955 without its denominator, and never invent a 4-point scale.",
  "Return ONLY the JSON object, no other text.",
  "Set null for fields you cannot find or are not sure about.",
];

export type AiDefaultKey =
  | "extractor.builtin.systemPrompt"
  | "extractor.builtin.fields"
  | "extractor.builtin.rules"
  | "persona.builtin.systemPrompt"
  | "persona.builtin.guidelines";

export type AiDefaultValueMap = {
  "extractor.builtin.systemPrompt": { text: string };
  "extractor.builtin.fields": { fields: ExtractorFieldDef[] };
  "extractor.builtin.rules": { globalRules: string[] };
  "persona.builtin.systemPrompt": { text: string };
  "persona.builtin.guidelines": { text: string };
};

export const HARDCODED_DEFAULTS: AiDefaultValueMap = {
  "extractor.builtin.systemPrompt": { text: "" },
  "extractor.builtin.fields": { fields: HARDCODED_EXTRACTOR_FIELDS },
  "extractor.builtin.rules": { globalRules: HARDCODED_EXTRACTOR_RULES },
  "persona.builtin.systemPrompt": { text: "" },
  "persona.builtin.guidelines": { text: "" },
};

export const ALL_DEFAULT_KEYS: AiDefaultKey[] = Object.keys(HARDCODED_DEFAULTS) as AiDefaultKey[];

export async function readDefaultConfig<K extends AiDefaultKey>(
  key: K
): Promise<AiDefaultValueMap[K]> {
  try {
    const [row] = await db
      .select()
      .from(aiDefaultConfigsTable)
      .where(eq(aiDefaultConfigsTable.key, key));
    if (row?.value != null) {
      return row.value as AiDefaultValueMap[K];
    }
  } catch {
    // DB unavailable — fall back to hardcoded
  }
  return HARDCODED_DEFAULTS[key];
}
