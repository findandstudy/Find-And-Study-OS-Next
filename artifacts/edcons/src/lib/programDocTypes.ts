import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

export type ProgramDocMeta = {
  key: string;
  label: string;
  icon: string;
  accept: string;
};

export const PROGRAM_DOC_META: Record<string, ProgramDocMeta> = {
  high_school_diploma_translation: { key: "high_school_diploma_translation", label: "HS Diploma (Translation)", icon: "🎓", accept: ".pdf,.jpg,.jpeg,.png" },
  class_10th_ssc_marks_sheet:       { key: "class_10th_ssc_marks_sheet",       label: "Class 10 / SSC Marks Sheet", icon: "📋", accept: ".pdf,.jpg,.jpeg,.png" },
  class_12th_hsc_certificate:       { key: "class_12th_hsc_certificate",       label: "Class 12 / HSC Certificate", icon: "🎓", accept: ".pdf,.jpg,.jpeg,.png" },
  class_12th_hsc_marks_sheet:       { key: "class_12th_hsc_marks_sheet",       label: "Class 12 / HSC Marks Sheet", icon: "📋", accept: ".pdf,.jpg,.jpeg,.png" },
  diploma_certificate:              { key: "diploma_certificate",              label: "Diploma Certificate", icon: "🎓", accept: ".pdf,.jpg,.jpeg,.png" },
  diploma_transcript:               { key: "diploma_transcript",               label: "Diploma Transcript", icon: "📋", accept: ".pdf,.jpg,.jpeg,.png" },
  bachelors_certificate:            { key: "bachelors_certificate",            label: "Bachelor's Certificate", icon: "🎓", accept: ".pdf,.jpg,.jpeg,.png" },
  bachelors_transcript:             { key: "bachelors_transcript",             label: "Bachelor's Transcript", icon: "📋", accept: ".pdf,.jpg,.jpeg,.png" },
  bachelors_provisional_certificate:{ key: "bachelors_provisional_certificate",label: "Bachelor's Provisional Cert.", icon: "🎓", accept: ".pdf,.jpg,.jpeg,.png" },
  bachelors_transcript_all_semesters:{ key: "bachelors_transcript_all_semesters",label: "Bachelor's Transcript (All Sem.)", icon: "📋", accept: ".pdf,.jpg,.jpeg,.png" },
  masters_certificate:              { key: "masters_certificate",              label: "Master's Certificate", icon: "🎓", accept: ".pdf,.jpg,.jpeg,.png" },
  masters_transcript:               { key: "masters_transcript",               label: "Master's Transcript", icon: "📋", accept: ".pdf,.jpg,.jpeg,.png" },
  masters_provisional_certificate:  { key: "masters_provisional_certificate",  label: "Master's Provisional Cert.", icon: "🎓", accept: ".pdf,.jpg,.jpeg,.png" },
  masters_transcript_all_semesters: { key: "masters_transcript_all_semesters", label: "Master's Transcript (All Sem.)", icon: "📋", accept: ".pdf,.jpg,.jpeg,.png" },
  passport:                         { key: "passport",                         label: "Passport", icon: "🛂", accept: ".pdf,.jpg,.jpeg,.png" },
  cv:                               { key: "cv",                               label: "CV / Resume", icon: "📄", accept: ".pdf,.jpg,.jpeg,.png" },
  lor:                              { key: "lor",                              label: "Recommendation Letter", icon: "📝", accept: ".pdf,.jpg,.jpeg,.png" },
  sop:                              { key: "sop",                              label: "Statement of Purpose", icon: "✍️", accept: ".pdf,.jpg,.jpeg,.png" },
  essay:                            { key: "essay",                            label: "Essay", icon: "📝", accept: ".pdf,.jpg,.jpeg,.png" },
  experience_letters:               { key: "experience_letters",               label: "Experience Letters", icon: "💼", accept: ".pdf,.jpg,.jpeg,.png" },
  other_certificates_documents:     { key: "other_certificates_documents",     label: "Other Certificates", icon: "📑", accept: ".pdf,.jpg,.jpeg,.png" },
  ielts_pte_gre_gmat_toefl_duolingo:{ key: "ielts_pte_gre_gmat_toefl_duolingo",label: "Language/Test Score", icon: "🌐", accept: ".pdf,.jpg,.jpeg,.png" },
  photo:                            { key: "photo",                            label: "Photograph", icon: "📷", accept: ".pdf,.jpg,.jpeg,.png" },
  diploma_recognition:              { key: "diploma_recognition",              label: "Diploma Recognition", icon: "📜", accept: ".pdf,.jpg,.jpeg,.png" },
  portfolio: { key: "portfolio", label: "Portfolio", icon: "🎨", accept: ".pdf,.jpg,.jpeg,.png" },
  research_proposal: { key: "research_proposal", label: "Research Proposal", icon: "🔬", accept: ".pdf,.jpg,.jpeg,.png" },
  publication_list: { key: "publication_list", label: "Publication List", icon: "📚", accept: ".pdf,.jpg,.jpeg,.png" },
  writing_sample: { key: "writing_sample", label: "Writing Sample", icon: "✍️", accept: ".pdf,.jpg,.jpeg,.png" },
  subject_specific_test_score: { key: "subject_specific_test_score", label: "Subject-Specific Test Score (SAT/ACT/GRE/GMAT/LSAT/MCAT/BMAT)", icon: "📊", accept: ".pdf,.jpg,.jpeg,.png" },
  transcript_evaluation_report: { key: "transcript_evaluation_report", label: "Transcript Evaluation Report (WES/ENIC-NARIC)", icon: "📊", accept: ".pdf,.jpg,.jpeg,.png" },
  medium_of_instruction_letter: { key: "medium_of_instruction_letter", label: "Medium of Instruction Letter", icon: "🌐", accept: ".pdf,.jpg,.jpeg,.png" },
  predicted_grades: { key: "predicted_grades", label: "Predicted Grades (UK)", icon: "📈", accept: ".pdf,.jpg,.jpeg,.png" },
  gap_year_explanation_letter: { key: "gap_year_explanation_letter", label: "Gap Year Explanation Letter", icon: "📝", accept: ".pdf,.jpg,.jpeg,.png" },
  academic_reference_form: { key: "academic_reference_form", label: "Academic Reference Form", icon: "📝", accept: ".pdf,.jpg,.jpeg,.png" },
  bank_statement: { key: "bank_statement", label: "Bank Statement", icon: "🏦", accept: ".pdf,.jpg,.jpeg,.png" },
  financial_evidence_28_days: { key: "financial_evidence_28_days", label: "Financial Evidence (28 Days, UK)", icon: "🏦", accept: ".pdf,.jpg,.jpeg,.png" },
  financial_documents_3_months: { key: "financial_documents_3_months", label: "Financial Documents (3 Months, USA)", icon: "🏦", accept: ".pdf,.jpg,.jpeg,.png" },
  gic_certificate: { key: "gic_certificate", label: "GIC Certificate (Canada SDS)", icon: "💳", accept: ".pdf,.jpg,.jpeg,.png" },
  sponsor_letter: { key: "sponsor_letter", label: "Sponsor Letter", icon: "💰", accept: ".pdf,.jpg,.jpeg,.png" },
  affidavit_of_support: { key: "affidavit_of_support", label: "Affidavit of Support (I-134/I-864)", icon: "💰", accept: ".pdf,.jpg,.jpeg,.png" },
  sponsor_id_proof: { key: "sponsor_id_proof", label: "Sponsor ID / Passport", icon: "🪪", accept: ".pdf,.jpg,.jpeg,.png" },
  sponsor_relationship_proof: { key: "sponsor_relationship_proof", label: "Sponsor Relationship Proof", icon: "👨‍👩‍👧", accept: ".pdf,.jpg,.jpeg,.png" },
  sponsor_employment_letter: { key: "sponsor_employment_letter", label: "Sponsor Employment Letter", icon: "💼", accept: ".pdf,.jpg,.jpeg,.png" },
  sponsor_tax_returns: { key: "sponsor_tax_returns", label: "Sponsor Tax Returns", icon: "🧾", accept: ".pdf,.jpg,.jpeg,.png" },
  scholarship_award_letter: { key: "scholarship_award_letter", label: "Scholarship Award Letter", icon: "🏆", accept: ".pdf,.jpg,.jpeg,.png" },
  proof_of_tuition_payment: { key: "proof_of_tuition_payment", label: "Proof of Tuition Payment", icon: "🧾", accept: ".pdf,.jpg,.jpeg,.png" },
  education_loan_approval_letter: { key: "education_loan_approval_letter", label: "Education Loan Approval Letter", icon: "💳", accept: ".pdf,.jpg,.jpeg,.png" },
  fixed_deposit_receipt: { key: "fixed_deposit_receipt", label: "Fixed Deposit Receipt", icon: "🏦", accept: ".pdf,.jpg,.jpeg,.png" },
  medical_examination_report: { key: "medical_examination_report", label: "Medical Examination Report", icon: "🏥", accept: ".pdf,.jpg,.jpeg,.png" },
  hiv_test_certificate: { key: "hiv_test_certificate", label: "HIV Test Certificate", icon: "🧪", accept: ".pdf,.jpg,.jpeg,.png" },
  tb_test_certificate: { key: "tb_test_certificate", label: "TB Test Certificate", icon: "🧪", accept: ".pdf,.jpg,.jpeg,.png" },
  hepatitis_b_test: { key: "hepatitis_b_test", label: "Hepatitis B Test", icon: "🧪", accept: ".pdf,.jpg,.jpeg,.png" },
  hepatitis_c_test: { key: "hepatitis_c_test", label: "Hepatitis C Test", icon: "🧪", accept: ".pdf,.jpg,.jpeg,.png" },
  vaccination_record: { key: "vaccination_record", label: "Vaccination Record", icon: "💉", accept: ".pdf,.jpg,.jpeg,.png" },
  covid_vaccination_certificate: { key: "covid_vaccination_certificate", label: "COVID-19 Vaccination Certificate", icon: "💉", accept: ".pdf,.jpg,.jpeg,.png" },
  panel_physician_medical_exam: { key: "panel_physician_medical_exam", label: "Panel Physician Medical Exam (Canada)", icon: "🏥", accept: ".pdf,.jpg,.jpeg,.png" },
  mental_health_clearance: { key: "mental_health_clearance", label: "Mental Health Clearance", icon: "🧠", accept: ".pdf,.jpg,.jpeg,.png" },
  physical_fitness_certificate: { key: "physical_fitness_certificate", label: "Physical Fitness Certificate", icon: "💪", accept: ".pdf,.jpg,.jpeg,.png" },
  visa_application_form: { key: "visa_application_form", label: "Visa Application Form", icon: "🛂", accept: ".pdf,.jpg,.jpeg,.png" },
  i20_form: { key: "i20_form", label: "I-20 Form (USA F-1)", icon: "🛂", accept: ".pdf,.jpg,.jpeg,.png" },
  ds160_confirmation: { key: "ds160_confirmation", label: "DS-160 Confirmation (USA)", icon: "🛂", accept: ".pdf,.jpg,.jpeg,.png" },
  sevis_fee_receipt: { key: "sevis_fee_receipt", label: "SEVIS I-901 Fee Receipt", icon: "🧾", accept: ".pdf,.jpg,.jpeg,.png" },
  cas_letter: { key: "cas_letter", label: "CAS Letter (UK)", icon: "📋", accept: ".pdf,.jpg,.jpeg,.png" },
  atas_certificate: { key: "atas_certificate", label: "ATAS Certificate (UK)", icon: "📋", accept: ".pdf,.jpg,.jpeg,.png" },
  pal_tal_letter: { key: "pal_tal_letter", label: "PAL / TAL Letter (Canada)", icon: "📋", accept: ".pdf,.jpg,.jpeg,.png" },
  letter_of_acceptance_dli: { key: "letter_of_acceptance_dli", label: "Letter of Acceptance from DLI (Canada)", icon: "📋", accept: ".pdf,.jpg,.jpeg,.png" },
  biometrics_appointment_receipt: { key: "biometrics_appointment_receipt", label: "Biometrics Appointment Receipt", icon: "📅", accept: ".pdf,.jpg,.jpeg,.png" },
  previous_visa_copies: { key: "previous_visa_copies", label: "Previous Visa Copies", icon: "🛂", accept: ".pdf,.jpg,.jpeg,.png" },
  visa_refusal_history: { key: "visa_refusal_history", label: "Visa Refusal History / Explanation", icon: "📝", accept: ".pdf,.jpg,.jpeg,.png" },
  travel_history: { key: "travel_history", label: "Travel History", icon: "✈️", accept: ".pdf,.jpg,.jpeg,.png" },
  residence_permit: { key: "residence_permit", label: "Residence Permit", icon: "🪪", accept: ".pdf,.jpg,.jpeg,.png" },
  police_clearance_certificate: { key: "police_clearance_certificate", label: "Police Clearance Certificate", icon: "👮", accept: ".pdf,.jpg,.jpeg,.png" },
  good_conduct_certificate: { key: "good_conduct_certificate", label: "Good Conduct Certificate", icon: "👮", accept: ".pdf,.jpg,.jpeg,.png" },
  birth_certificate: { key: "birth_certificate", label: "Birth Certificate", icon: "👶", accept: ".pdf,.jpg,.jpeg,.png" },
  national_id_card: { key: "national_id_card", label: "National ID Card", icon: "🪪", accept: ".pdf,.jpg,.jpeg,.png" },
  family_book: { key: "family_book", label: "Family Book", icon: "👨‍👩‍👧", accept: ".pdf,.jpg,.jpeg,.png" },
  marriage_certificate: { key: "marriage_certificate", label: "Marriage Certificate", icon: "💍", accept: ".pdf,.jpg,.jpeg,.png" },
  name_change_affidavit: { key: "name_change_affidavit", label: "Name Change Affidavit", icon: "📝", accept: ".pdf,.jpg,.jpeg,.png" },
  passport_size_photo_specifications: { key: "passport_size_photo_specifications", label: "Passport-Size Photo (Spec-Compliant)", icon: "📷", accept: ".pdf,.jpg,.jpeg,.png" },
  no_objection_certificate: { key: "no_objection_certificate", label: "No Objection Certificate (NOC)", icon: "📝", accept: ".pdf,.jpg,.jpeg,.png" },
  employer_letter: { key: "employer_letter", label: "Employer Letter", icon: "💼", accept: ".pdf,.jpg,.jpeg,.png" },
  work_experience_certificate: { key: "work_experience_certificate", label: "Work Experience Certificate", icon: "💼", accept: ".pdf,.jpg,.jpeg,.png" },
  internship_certificates: { key: "internship_certificates", label: "Internship Certificates", icon: "💼", accept: ".pdf,.jpg,.jpeg,.png" },
  professional_license: { key: "professional_license", label: "Professional License", icon: "🪪", accept: ".pdf,.jpg,.jpeg,.png" },
  business_registration: { key: "business_registration", label: "Business Registration", icon: "🏢", accept: ".pdf,.jpg,.jpeg,.png" },
  military_status_document: { key: "military_status_document", label: "Military Status Document (Türkiye)", icon: "🪖", accept: ".pdf,.jpg,.jpeg,.png" },
  yos_score_report: { key: "yos_score_report", label: "YÖS Score Report (Türkiye)", icon: "📊", accept: ".pdf,.jpg,.jpeg,.png" },
  sat_score_report: { key: "sat_score_report", label: "SAT Score Report", icon: "📊", accept: ".pdf,.jpg,.jpeg,.png" },
  gaokao_score_report: { key: "gaokao_score_report", label: "Gaokao Score Report (China)", icon: "📊", accept: ".pdf,.jpg,.jpeg,.png" },
  abitur_certificate: { key: "abitur_certificate", label: "Abitur Certificate (Germany)", icon: "🎓", accept: ".pdf,.jpg,.jpeg,.png" },
  a_level_certificate: { key: "a_level_certificate", label: "A-Level Certificate (UK)", icon: "🎓", accept: ".pdf,.jpg,.jpeg,.png" },
  ib_diploma: { key: "ib_diploma", label: "IB Diploma", icon: "🎓", accept: ".pdf,.jpg,.jpeg,.png" },
  olympiad_certificates: { key: "olympiad_certificates", label: "Olympiad Certificates", icon: "🏆", accept: ".pdf,.jpg,.jpeg,.png" },
  accommodation_proof: { key: "accommodation_proof", label: "Accommodation Proof", icon: "🏠", accept: ".pdf,.jpg,.jpeg,.png" },
  custodian_declaration: { key: "custodian_declaration", label: "Custodian Declaration", icon: "👨‍👩‍👧", accept: ".pdf,.jpg,.jpeg,.png" },
  parental_consent: { key: "parental_consent", label: "Parental Consent", icon: "👨‍👩‍👧", accept: ".pdf,.jpg,.jpeg,.png" },
  dependents_documents: { key: "dependents_documents", label: "Dependents' Documents", icon: "👨‍👩‍👧", accept: ".pdf,.jpg,.jpeg,.png" },
  ukvi_approved_english_test: { key: "ukvi_approved_english_test", label: "UKVI-Approved English Test", icon: "🌐", accept: ".pdf,.jpg,.jpeg,.png" },
  statement_of_finance: { key: "statement_of_finance", label: "Statement of Finance", icon: "💰", accept: ".pdf,.jpg,.jpeg,.png" },
  personal_statement: { key: "personal_statement", label: "Personal Statement", icon: "✍️", accept: ".pdf,.jpg,.jpeg,.png" },
  diversity_statement: { key: "diversity_statement", label: "Diversity Statement", icon: "✍️", accept: ".pdf,.jpg,.jpeg,.png" },
  ai_usage_declaration: { key: "ai_usage_declaration", label: "AI Usage Declaration", icon: "✍️", accept: ".pdf,.jpg,.jpeg,.png" },
  gdpr_consent_form: { key: "gdpr_consent_form", label: "GDPR Consent Form", icon: "📝", accept: ".pdf,.jpg,.jpeg,.png" },
  fraud_declaration: { key: "fraud_declaration", label: "Fraud Declaration", icon: "📝", accept: ".pdf,.jpg,.jpeg,.png" },
};

export type ProgramDocReq = { documentType: string; mandatory: boolean; sortOrder?: number };

const PHOTO_DOCUMENT_KEYS = new Set(["photo", "photograph", "passport_photo", "passport_size_photo_specifications"]);

function canonicalAccept(key: string, configured: unknown): string {
  if (PHOTO_DOCUMENT_KEYS.has(key.trim().toLowerCase())) return ".pdf,.jpg,.jpeg,.png";
  return typeof configured === "string" && configured.trim()
    ? configured
    : ".pdf,.jpg,.jpeg,.png";
}

/**
 * Fetch the admin-managed document-type catalog from the server.
 * Returns a map of `key → ProgramDocMeta` (label/icon/accept).
 * Used as the authoritative source for available document types and
 * their display metadata — `PROGRAM_DOC_META` above is only a fallback
 * for keys the catalog doesn't know about yet.
 */
type CatalogOptionRow = {
  id: number;
  category: string;
  value: string;
  isActive: boolean;
  sortOrder: number;
  metadata?: { label?: unknown; icon?: unknown; accept?: unknown } | null;
};

export function useDocumentTypeCatalog() {
  return useQuery<Record<string, ProgramDocMeta>>({
    queryKey: ["document-type-catalog"],
    queryFn: async () => {
      try {
        const res = await customFetch(`${BASE_URL}/api/catalog-options`) as unknown;
        const grouped = (res as { grouped?: Record<string, CatalogOptionRow[]> } | null)?.grouped;
        const rows = grouped?.documents ?? [];
        const map: Record<string, ProgramDocMeta> = {};
        for (const r of rows) {
          if (!r.isActive) continue;
          const md = r.metadata || {};
          map[r.value] = {
            key: r.value,
            label: typeof md.label === "string" ? md.label : humaniseKey(r.value),
            icon: typeof md.icon === "string" ? md.icon : "📄",
            accept: canonicalAccept(r.value, md.accept),
          };
        }
        return map;
      } catch {
        return {};
      }
    },
    staleTime: 60_000,
  });
}

function humaniseKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * React hook that returns a `resolveDocMeta(key)` function backed by the
 * admin-managed catalog. Falls back to the static `PROGRAM_DOC_META` map
 * (and finally to a humanised key) for unknown keys.
 *
 * Use this in any component that displays document labels/icons/accepts
 * for end-users (CourseFinder, Programs, DegreeDocsEditor, etc.) so newly
 * added catalog entries appear without a code change.
 */
export function useResolveDocMeta(): (key: string) => ProgramDocMeta {
  const { data: catalog } = useDocumentTypeCatalog();
  return (key: string) => {
    const resolved = catalog?.[key] ?? resolveDocMeta(key);
    return { ...resolved, accept: canonicalAccept(key, resolved.accept) };
  };
}

export function useProgramDocRequirements(programId: number | null | undefined) {
  return useQuery<ProgramDocReq[]>({
    queryKey: ["program-document-requirements", programId],
    queryFn: async () => {
      if (!programId) return [];
      // Use the public endpoint so this hook also resolves doc requirements
      // for non-logged-in visitors. Errors deliberately propagate to the
      // caller: an unknown requirement set must fail closed, not become an
      // empty/fallback checklist.
      const res = await customFetch(`${BASE_URL}/api/public/programs/${programId}/document-requirements`) as unknown;
      if (!Array.isArray(res)) throw new Error("Invalid document requirements response");
      return res
        .filter((r): r is { documentType: unknown; mandatory: unknown; sortOrder?: unknown } =>
          !!r && typeof r === "object" && typeof (r as any).documentType === "string")
        .map(r => ({
          documentType: r.documentType as string,
          mandatory: !!r.mandatory,
          sortOrder: typeof (r as any).sortOrder === "number" ? (r as any).sortOrder : undefined,
        }));
    },
    enabled: !!programId,
    staleTime: 60_000,
  });
}

/**
 * Resolve the canonical doc-type meta for a `documentType` key. Falls back
 * to a humanised label/generic icon when the key isn't in the canonical
 * PROGRAM_DOC_META map (forwards-compatible if the backend adds new types).
 */
export function resolveDocMeta(documentType: string): ProgramDocMeta {
  const known = PROGRAM_DOC_META[documentType];
  if (known) return known;
  const label = documentType
    .replace(/_/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
  return { key: documentType, label, icon: "📄", accept: ".pdf,.jpg,.jpeg,.png" };
}
