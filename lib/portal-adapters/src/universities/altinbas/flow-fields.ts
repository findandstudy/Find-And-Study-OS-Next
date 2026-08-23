// ---------------------------------------------------------------------------
// Altınbaş Screen Flow — alan kontratı (canlı yakalandı 2026-07-10).
//
// Her ekran geçişi navigateFlow POST'unda DÜZ METİN `fields` taşır; bu modül
// bizim SubmitProfile verimizi o alan adlarına çevirir. Formatlar KRİTİK:
//   - Tarihler "d MMM yyyy" (e.g. "4 Sep 1989") — FIX-15C (Azenabor run doğruladı).
//   - Ülke picklist deseni ÜÇ alan birden:
//       <F>.<Group>.<CountryEn>.selected = true
//       <F>.selectedChoiceLabels = "<CountryEn>"
//       <F>.selectedChoiceValues = "<CountryEn>"
//   - Telefon: phoneWithCountryCode.selectedCountryCode = "93",
//     phoneWithCountryCode.phone = "706620293" (SADECE yerel numara, kod prefix YOK)
//     FIX-15C: ülke kodu prefix kaldırıldı (Azenabor run doğruladı).
//   - Email READ-ONLY pre-filled → HİÇ dokunulmaz.
// ---------------------------------------------------------------------------

import type { SubmitProfile } from "../../types.js";

/** One plain-text field entry inside navigateFlow params.request.fields. */
export interface FlowField {
  field: string;
  value: unknown;
  isVisible: boolean;
}

// ---------------------------------------------------------------------------
// Short English month names (locale-insensitive)
// ---------------------------------------------------------------------------
const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Format ISO "YYYY-MM-DD" to "d MMM yyyy" (e.g. "4 Sep 1989").
 * Required by Altınbaş portal date pickers (FIX-15C).
 */
export function formatDateDmy(iso: string | undefined): string {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  const [, y, mo, d] = m;
  const monthName = MONTHS_SHORT[parseInt(mo, 10) - 1];
  if (!monthName) return iso;
  return `${parseInt(d, 10)} ${monthName} ${y}`;
}

// ---------------------------------------------------------------------------
// Country normalisation — portal picklists use plain ENGLISH country names.
//
// COUNTRY_EN_MAP handles two input conventions:
//   a) Adjective / demonym  (e.g. "Pakistani"  → "Pakistan")   ← legacy CRM
//   b) Country name         (e.g. "Pakistan")                   ← prod DB norm
//   c) ISO alpha-2 codes    (e.g. "tr" → "Turkey")              ← seen in prod
//
// mapCountry returns null (not "") when the input is empty/missing — callers
// MUST check for null and throw a submission-stopping error rather than
// silently substituting a default country (which would submit incorrect data).
// ---------------------------------------------------------------------------
const COUNTRY_EN_MAP: Record<string, string> = {
  // --- adjective / demonym forms (legacy) ----------------------------------
  afghan: "Afghanistan", algerian: "Algeria", azerbaijani: "Azerbaijan",
  bahraini: "Bahrain", bangladeshi: "Bangladesh", british: "United Kingdom",
  chinese: "China", egyptian: "Egypt", emirati: "United Arab Emirates",
  french: "France", german: "Germany", indian: "India", iranian: "Iran",
  iraqi: "Iraq", jordanian: "Jordan", kazakh: "Kazakhstan", kenyan: "Kenya",
  kuwaiti: "Kuwait", kyrgyz: "Kyrgyzstan", lebanese: "Lebanon",
  libyan: "Libya", moroccan: "Morocco", nigerian: "Nigeria", omani: "Oman",
  pakistani: "Pakistan", palestinian: "Palestine", qatari: "Qatar",
  russian: "Russia", saudi: "Saudi Arabia", somali: "Somalia",
  sudanese: "Sudan", syrian: "Syria", tajik: "Tajikistan",
  tunisian: "Tunisia", turk: "Turkey", turkish: "Turkey",
  turkmen: "Turkmenistan", ukrainian: "Ukraine", uzbek: "Uzbekistan",
  yemeni: "Yemen",
  // --- country name forms (lowercase, as stored in prod DB) ----------------
  afghanistan: "Afghanistan", albania: "Albania", algeria: "Algeria",
  armenia: "Armenia", azerbaijan: "Azerbaijan",
  bahrain: "Bahrain", bangladesh: "Bangladesh", burundi: "Burundi",
  china: "China", congo: "Congo",
  "democratic republic of the congo": "Democratic Republic of the Congo",
  egypt: "Egypt", ethiopia: "Ethiopia",
  france: "France", germany: "Germany", ghana: "Ghana",
  india: "India", indonesia: "Indonesia", iran: "Iran", iraq: "Iraq",
  "ivory coast": "Ivory Coast",
  japan: "Japan", jordan: "Jordan",
  kazakhstan: "Kazakhstan", kenya: "Kenya", kuwait: "Kuwait",
  kyrgyzstan: "Kyrgyzstan",
  lebanon: "Lebanon", libya: "Libya",
  malaysia: "Malaysia", mali: "Mali", morocco: "Morocco",
  niger: "Niger", nigeria: "Nigeria",
  oman: "Oman",
  pakistan: "Pakistan", palestine: "Palestine",
  qatar: "Qatar",
  russia: "Russia", rwanda: "Rwanda",
  "saudi arabia": "Saudi Arabia",
  senegal: "Senegal", somalia: "Somalia", "south africa": "South Africa",
  sudan: "Sudan", syria: "Syria",
  tajikistan: "Tajikistan", tanzania: "Tanzania", tunisia: "Tunisia",
  turkey: "Turkey", turkmenistan: "Turkmenistan",
  uganda: "Uganda", ukraine: "Ukraine",
  "united arab emirates": "United Arab Emirates",
  "united kingdom": "United Kingdom", "united states": "United States",
  "united states of america": "United States",
  uzbekistan: "Uzbekistan",
  vietnam: "Vietnam",
  yemen: "Yemen",
  zambia: "Zambia", zimbabwe: "Zimbabwe",
  // --- ISO alpha-2 codes seen in prod --------------------------------------
  tr: "Turkey", pk: "Pakistan", af: "Afghanistan", ng: "Nigeria",
  ma: "Morocco", uz: "Uzbekistan", kz: "Kazakhstan", az: "Azerbaijan",
  tz: "Tanzania", et: "Ethiopia", rw: "Rwanda", vn: "Vietnam",
  ly: "Libya", sd: "Sudan", in: "India", ke: "Kenya", dz: "Algeria",
  so: "Somalia", bi: "Burundi", zm: "Zambia", ne: "Niger",
  ci: "Ivory Coast", fr: "France", jp: "Japan", am: "Armenia",
  us: "United States", bd: "Bangladesh", zw: "Zimbabwe", tn: "Tunisia",
  id: "Indonesia", gh: "Ghana", za: "South Africa", sy: "Syria",
  lb: "Lebanon", ps: "Palestine", gb: "United Kingdom", ir: "Iran",
  al: "Albania", de: "Germany", cd: "Democratic Republic of the Congo",
  cg: "Congo", kg: "Kyrgyzstan",
};

/**
 * Normalise a nationality string to the English country name the portal expects.
 *
 * Returns null when the input is empty/missing — NEVER fall back to a default.
 * Returns the canonical portal name when found in the map.
 * Returns a title-cased version of the raw value when not in the map, and
 * logs a warning so staff can detect unrecognised nationalities.
 */
export function mapCountry(nationality?: string): string | null {
  if (!nationality || !nationality.trim()) return null;
  const lower = nationality.trim().toLowerCase();
  const mapped = COUNTRY_EN_MAP[lower];
  if (mapped) return mapped;
  // Not in the map: title-case the raw value and warn so staff can act.
  // The portal MAY accept it if the picklist has a matching entry; if not,
  // the submission will surface an explicit form-fill error rather than
  // silently using the wrong country.
  const titleCased = nationality.trim().replace(/\b\w/g, (c) => c.toUpperCase());
  console.warn(
    `[altinbas/flow-fields] mapCountry: nationality "${nationality.trim()}" not in map` +
    ` — using title-cased raw value "${titleCased}". Update COUNTRY_EN_MAP if incorrect.`,
  );
  return titleCased;
}

/** Dial codes for phoneWithCountryCode.selectedCountryCode. */
export const DIAL_CODES: Record<string, string> = {
  Afghanistan: "93", Algeria: "213", Azerbaijan: "994", Bahrain: "973",
  Bangladesh: "880", "United Kingdom": "44", China: "86", Egypt: "20",
  "United Arab Emirates": "971", France: "33", Germany: "49", India: "91",
  Iran: "98", Iraq: "964", Jordan: "962", Kazakhstan: "7", Kenya: "254",
  Kuwait: "965", Kyrgyzstan: "996", Lebanon: "961", Libya: "218",
  Morocco: "212", Nigeria: "234", Oman: "968", Pakistan: "92",
  Palestine: "970", Qatar: "974", Russia: "7", "Saudi Arabia": "966",
  Somalia: "252", Sudan: "249", Syria: "963", Tajikistan: "992",
  Tunisia: "216", Turkey: "90", Turkmenistan: "993", Ukraine: "380",
  Uzbekistan: "998", Yemen: "967",
};

/** "+930706620293" + "93" → "706620293" (ülke kodu + baştaki trunk 0'lar atılır). */
export function toNationalNoTrunk(phone: string, dialCode: string): string {
  let n = (phone || "").replace(/[^\d]/g, "");
  const dc = (dialCode || "").replace(/[^\d]/g, "");
  if (dc && n.startsWith(dc)) n = n.slice(dc.length);
  n = n.replace(/^0+/, "");
  return n;
}

/** Ülke picklist ÜÇLÜ deseni — her ülke alanı için üç field birden gider. */
export function countryPick(fieldName: string, group: string, country: string): FlowField[] {
  return [
    { field: `${fieldName}.${group}.${country}.selected`, value: true, isVisible: true },
    { field: `${fieldName}.selectedChoiceLabels`, value: country, isVisible: true },
    { field: `${fieldName}.selectedChoiceValues`, value: country, isVisible: true },
  ];
}

// ---------------------------------------------------------------------------
// Screen 1 — Term Selection (action: NEXT)
// ---------------------------------------------------------------------------
export function buildTermFields(term: { label: string; id: string }): FlowField[] {
  return [
    { field: "pathLWC.currentStage", value: "Term Selection", isVisible: true },
    { field: "TermSelector.selectedOption", value: term.label, isVisible: true },
    { field: "TermSelector.selectedOptionId", value: term.id, isVisible: true },
    { field: "TermSelector.maxSelections", value: 3, isVisible: true },
    { field: "TermSelector.uniMaxSelection", value: 3, isVisible: true },
  ];
}

// ---------------------------------------------------------------------------
// Screen 2 — Degree Selection (action: NEXT)
// ---------------------------------------------------------------------------
export function buildDegreeFields(degree: { label: string; id: string }): FlowField[] {
  return [
    { field: "pathLWC2.currentStage", value: "Degree Selection", isVisible: true },
    { field: "DegreeSelector.selectedOption", value: degree.label, isVisible: true },
    { field: "DegreeSelector.selectedOptionId", value: degree.id, isVisible: true },
  ];
}

// ---------------------------------------------------------------------------
// Screen 3 — Program Selection (action: NEXT, sonra CONTINUE_AFTER_COMMIT)
// programRecord = flow'un client-side yüklediği eligible listeden BULUNAN kayıt
// (en az Id / Name / eduhub__Program__c taşır) — olduğu gibi geri gönderilir.
// ---------------------------------------------------------------------------
export function buildProgramFields(programRecord: Record<string, unknown>): FlowField[] {
  return [
    { field: "pathLWC3.currentStage", value: "Program Selection", isVisible: true },
    { field: "ProgramSelection.selectedPrograms", value: [programRecord], isVisible: true },
  ];
}

// ---------------------------------------------------------------------------
// Screen 4 — Personal Information (action: NEXT)
//
// FIX-15C değişiklikleri (Azenabor run):
//   - Date_of_Birth + Passport dates → "d MMM yyyy" formatı
//   - phoneWithCountryCode.phone → SADECE yerel numara (kod prefix YOK)
// ---------------------------------------------------------------------------
export function buildPersonalFields(profile: SubmitProfile): FlowField[] {
  const country = mapCountry(profile.nationality);
  if (country === null) {
    throw new Error(
      `MISSING_NATIONALITY: profile.nationality is empty or missing — cannot fill` +
      ` country picklists on the Altınbaş portal. Update the student record before retrying.`,
    );
  }
  const dial = DIAL_CODES[country] || "";
  const national = toNationalNoTrunk(profile.phone || "", dial);
  const gender = (profile.gender || "").trim();
  const female = /^f(?:emale)?$/i.test(gender);
  const male = /^m(?:ale)?$/i.test(gender);
  if (!female && !male) {
    throw new Error("DATA_MISSING: gender must be explicitly Male or Female");
  }
  const street = profile.addressStreet?.trim() || "";
  const city = profile.addressCity?.trim() || "";
  const zip = profile.addressZip?.trim() || "";
  const missing = [
    !formatDateDmy(profile.dateOfBirth) && "dateOfBirth",
    !formatDateDmy(profile.passportIssueDate) && "passportIssueDate",
    !formatDateDmy(profile.passportExpiryDate) && "passportExpiryDate",
    !street && "addressStreet",
    !city && "addressCity",
    !zip && "postalCode",
  ].filter((value): value is string => !!value);
  if (missing.length) {
    throw new Error(`DATA_MISSING: ${missing.join(", ")}`);
  }

  return [
    { field: "path.currentStage", value: "Personal Information", isVisible: true },
    { field: "First_Name", value: profile.firstName, isVisible: true },
    { field: "Last_Name", value: profile.lastName, isVisible: true },
    { field: "Preferred_Name", value: null, isVisible: true },
    { field: `Gender.GenderChoice.${female ? "Female" : "Male"}.selected`, value: true, isVisible: true },
    // FIX-15C: "d MMM yyyy" format (e.g. "4 Sep 1989")
    { field: "Date_of_Birth", value: formatDateDmy(profile.dateOfBirth), isVisible: true },
    ...countryPick("Country_of_Birth", "CountryList", country),
    { field: "City_of_Birth", value: profile.cityOfBirth?.trim() || "", isVisible: true },
    ...countryPick("Citizenship_CL", "CountryList", country),
    { field: "Secondary_Citizenship.selectedChoiceLabels", value: "", isVisible: true },
    { field: "Secondary_Citizenship.selectedChoiceValues", value: "", isVisible: true },
    { field: "National_Identity_Number", value: null, isVisible: true },
    { field: "Passport", value: profile.passportNumber, isVisible: true },
    // FIX-15C: Passport dates also use "d MMM yyyy"
    { field: "Passport_Date_of_Issue", value: formatDateDmy(profile.passportIssueDate), isVisible: true },
    { field: "Passport_Date_of_Expiry", value: formatDateDmy(profile.passportExpiryDate), isVisible: true },
    ...countryPick("Passport_Issuing_Country", "IssuingCountry", country),
    // Email READ-ONLY pre-filled — kontrata göre HİÇ gönderilmez/dokunulmaz.
    { field: "phoneWithCountryCode.selectedCountryCode", value: dial, isVisible: true },
    // FIX-15C: SADECE yerel numara — ülke kodu prefix KALDIRILDI
    { field: "phoneWithCountryCode.phone", value: national, isVisible: true },
    { field: "Father_Name", value: profile.fatherName || "", isVisible: true },
    { field: "Mother_Name", value: profile.motherName || "", isVisible: true },
    ...countryPick("Address_Country", "CountryList", country),
    { field: "Address_City", value: city, isVisible: true },
    { field: "Address_Street", value: street, isVisible: true },
    { field: "Address_Zip_Code", value: zip, isVisible: true },
    { field: "I_am_Alumni", value: null, isVisible: true },
  ];
}

// ---------------------------------------------------------------------------
// Screen 5 — Educational Information (action: NEXT) — FIX-15C: education
// records artık DB'den yükleniyor ve bachelor kaydı varsa gönderiliyor.
// ---------------------------------------------------------------------------
export interface FlowIds {
  applicantId?: string;
  applicationId?: string;
  accountId?: string;
  contactId?: string;
}

/** Minimal education record shape passed from profile builder (education_records table). */
export interface EduRecord {
  level: string;
  schoolName?: string | null;
  country?: string | null;
  city?: string | null;
  fieldOfStudy?: string | null;
  startMonth?: string | null;
  startYear?: number | null;
  endMonth?: string | null;
  endYear?: number | null;
  gpa?: string | null;
  gpaType?: string | null;
  languageScore?: string | null;
}

/**
 * Classify a profile level string into one of the four degree tiers the adapter
 * understands. Turkish equivalents are recognised:
 *   "yüksek lisans" / "yuksek lisans" → "master"
 *   "lisans"                           → "bachelor"   (exact — not "yüksek lisans")
 *   "önlisans" / "onlisans" / "ön lisans" → "associate"
 *   "doktora"                          → "phd"
 *
 * Returns "unknown" only if no pattern matches — the caller should treat this as
 * an unsupported level (the upstream guard already rejects it, so in practice
 * "unknown" should never reach here after the guard runs).
 */
export function classifyProfileLevel(
  level: string,
): "master" | "phd" | "bachelor" | "associate" | "unknown" {
  const n = (level ?? "").trim().toLowerCase();
  if (/phd|doctor|doktora/.test(n)) return "phd";
  if (/master|yüksek\s*lisans|yuksek\s*lisans/.test(n)) return "master";
  if (/bachelor|^lisans$/.test(n)) return "bachelor";
  if (/associate|önlisans|onlisans|ön\s*lisans/.test(n)) return "associate";
  return "unknown";
}

/**
 * Returns the first missing required education record level key, or null.
 *   Master        → must have a "bachelor" record on file.
 *   PhD           → must have both "bachelor" and "master" records on file.
 *   Bachelor / Associate → must have a "high_school" record on file.
 */
export function checkMissingEduRecord(
  eduRecords: EduRecord[] | undefined,
  profileLevel: string,
): string | null {
  const cls = classifyProfileLevel(profileLevel);
  if ((cls === "master" || cls === "phd") && !eduRecords?.some((r) => r.level === "bachelor")) {
    return "bachelor_education_record";
  }
  if (cls === "phd" && !eduRecords?.some((r) => r.level === "master")) {
    return "master_education_record";
  }
  if (
    (cls === "bachelor" || cls === "associate") &&
    !eduRecords?.some((r) => r.level === "high_school")
  ) {
    return "high_school_education_record";
  }
  return null;
}

export function buildEducationalFields(ids: FlowIds, edu?: EduRecord): FlowField[] {
  const lists: Array<{ name: string; cvType: string }> = [
    { name: "EducationalInformationList", cvType: "Educational_Information" },
    { name: "ExamInformationList", cvType: "Proficiency_Exam" },
    { name: "ExperienceList", cvType: "Job_Information" },
    { name: "ReferenceList", cvType: "Reference" },
  ];
  const fields: FlowField[] = [
    { field: "path1.currentStage", value: "Educational Information", isVisible: true },
  ];
  for (const l of lists) {
    fields.push(
      { field: `${l.name}.applicantId`, value: ids.applicantId ?? "", isVisible: true },
      { field: `${l.name}.applicationId`, value: ids.applicationId ?? "", isVisible: true },
      { field: `${l.name}.cvType`, value: l.cvType, isVisible: true },
      { field: `${l.name}.language`, value: "en_US", isVisible: true },
    );
  }
  fields.push(
    { field: "SetCookie.accountId", value: ids.accountId ?? "", isVisible: true },
    { field: "SetCookie.contactId", value: ids.contactId ?? "", isVisible: true },
  );

  // FIX-15C: If we have a bachelor/master education record, inject its data
  // into the EducationalInformationList modal fields. Field names are based on
  // the Altınbaş Salesforce Screen Flow schema (verify with ALTINBAS_CAPTURE=1).
  if (edu) {
    const degreeLabel =
      edu.level === "master" ? "Master" :
      edu.level === "bachelor" ? "Bachelor" :
      edu.level === "high_school" ? "High School" :
      edu.level;
    fields.push(
      { field: "EducationalInformationList.records.0.School__c",         value: edu.schoolName ?? "",    isVisible: true },
      { field: "EducationalInformationList.records.0.Country__c",        value: edu.country ?? "",       isVisible: true },
      { field: "EducationalInformationList.records.0.Degree__c",         value: degreeLabel,             isVisible: true },
      { field: "EducationalInformationList.records.0.Field_of_Study__c", value: edu.fieldOfStudy ?? "",  isVisible: true },
      { field: "EducationalInformationList.records.0.Start_Month__c",    value: edu.startMonth ?? "",    isVisible: true },
      { field: "EducationalInformationList.records.0.Start_Year__c",     value: edu.startYear ?? "",     isVisible: true },
      { field: "EducationalInformationList.records.0.End_Month__c",      value: edu.endMonth ?? "",      isVisible: true },
      { field: "EducationalInformationList.records.0.End_Year__c",       value: edu.endYear ?? "",       isVisible: true },
      { field: "EducationalInformationList.records.0.GPA_Type__c",       value: edu.gpaType ?? "",       isVisible: true },
      { field: "EducationalInformationList.records.0.GPA__c",            value: edu.gpa ?? "",           isVisible: true },
      { field: "EducationalInformationList.records.0.City__c",           value: edu.city ?? "",          isVisible: true },
      { field: "ExamInformationList.records.0.Exam_Score__c",            value: edu.languageScore ?? "", isVisible: true },
    );
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Screen 6 — Questionnaire (action: NEXT).
// Visa Support must be an explicit CRM answer; nationality is not a proxy.
// ---------------------------------------------------------------------------
export function buildQuestionnaireFields(visaSupport?: string): FlowField[] {
  const raw = visaSupport?.trim() || "";
  if (!/^(yes|no)$/i.test(raw)) {
    throw new Error(
      "DATA_MISSING: needsVisaSupport must be explicitly Yes or No",
    );
  }
  const vs = /^yes$/i.test(raw) ? "Yes" : "No";
  // Field names based on Altınbaş portal Questionnaire step.
  // Verify exact names with ALTINBAS_CAPTURE=1 if issues arise.
  return [
    { field: "VisaSupportQuestion.selectedChoiceLabels", value: vs, isVisible: true },
    { field: "VisaSupportQuestion.selectedChoiceValues", value: vs, isVisible: true },
  ];
}

// ---------------------------------------------------------------------------
// Screen 7 — Documents (action: NEXT). Belge upload = Salesforce ContentVersion
// insert (base64) — FIX-15C: slot mapping tanımlandı, upload HENÜZ yok.
// ---------------------------------------------------------------------------
/** CRM document type keys that satisfy each portal slot. */
export const DOCUMENT_SLOT_TYPES: Record<string, string[]> = {
  passport:   ["passport"],
  diploma:    ["diploma", "degree", "graduation_certificate"],
  transcript: ["transcript", "academic_transcript"],
  photo:      ["photo", "photograph"],
};

export function buildDocumentsFields(): FlowField[] {
  return [];
}
