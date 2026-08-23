// Pool type from pg — resolved via actual usage (pool.query)

/**
 * Seed the master list of document types into `catalog_options` under
 * category="documents". Idempotent per-row. Each row stores:
 *   - value: canonical snake_case key (used as documentType FK across DB)
 *   - metadata: { label, icon, accept } for human-readable display + upload filter
 *
 * Also wipes any legacy rows from the v1 seeder (value = label, metadata
 * is NULL) so the catalog ends up clean. User-created rows (any value
 * not in our canonical key list) are preserved.
 */
type DocSeed = { key: string; label: string; icon: string; accept: string };

const PDF_IMG = ".pdf,.jpg,.jpeg,.png";
const IMG = ".jpg,.jpeg,.png";

const DOCUMENT_TYPES: DocSeed[] = [
  { key: "high_school_diploma_translation", label: "HS Diploma (Translation)", icon: "🎓", accept: PDF_IMG },
  { key: "class_10th_ssc_marks_sheet", label: "Class 10 / SSC Marks Sheet", icon: "📋", accept: PDF_IMG },
  { key: "class_12th_hsc_certificate", label: "Class 12 / HSC Certificate", icon: "🎓", accept: PDF_IMG },
  { key: "class_12th_hsc_marks_sheet", label: "Class 12 / HSC Marks Sheet", icon: "📋", accept: PDF_IMG },
  { key: "diploma_certificate", label: "Diploma Certificate", icon: "🎓", accept: PDF_IMG },
  { key: "diploma_transcript", label: "Diploma Transcript", icon: "📋", accept: PDF_IMG },
  { key: "bachelors_certificate", label: "Bachelor's Certificate", icon: "🎓", accept: PDF_IMG },
  { key: "bachelors_transcript", label: "Bachelor's Transcript", icon: "📋", accept: PDF_IMG },
  { key: "bachelors_provisional_certificate", label: "Bachelor's Provisional Cert.", icon: "🎓", accept: PDF_IMG },
  { key: "bachelors_transcript_all_semesters", label: "Bachelor's Transcript (All Sem.)", icon: "📋", accept: PDF_IMG },
  { key: "masters_certificate", label: "Master's Certificate", icon: "🎓", accept: PDF_IMG },
  { key: "masters_transcript", label: "Master's Transcript", icon: "📋", accept: PDF_IMG },
  { key: "masters_provisional_certificate", label: "Master's Provisional Cert.", icon: "🎓", accept: PDF_IMG },
  { key: "masters_transcript_all_semesters", label: "Master's Transcript (All Sem.)", icon: "📋", accept: PDF_IMG },
  { key: "passport", label: "Passport", icon: "🛂", accept: PDF_IMG },
  { key: "cv", label: "CV / Resume", icon: "📄", accept: PDF_IMG },
  { key: "lor", label: "Recommendation Letter", icon: "📝", accept: PDF_IMG },
  { key: "sop", label: "Statement of Purpose", icon: "✍️", accept: PDF_IMG },
  { key: "essay", label: "Essay", icon: "📝", accept: PDF_IMG },
  { key: "experience_letters", label: "Experience Letters", icon: "💼", accept: PDF_IMG },
  { key: "other_certificates_documents", label: "Other Certificates", icon: "📑", accept: PDF_IMG },
  { key: "ielts_pte_gre_gmat_toefl_duolingo", label: "Language/Test Score", icon: "🌐", accept: PDF_IMG },
  { key: "photo", label: "Photograph", icon: "📷", accept: PDF_IMG },
  { key: "diploma_recognition", label: "Diploma Recognition", icon: "📜", accept: PDF_IMG },
  { key: "portfolio", label: "Portfolio", icon: "🎨", accept: PDF_IMG },
  { key: "research_proposal", label: "Research Proposal", icon: "🔬", accept: PDF_IMG },
  { key: "publication_list", label: "Publication List", icon: "📚", accept: PDF_IMG },
  { key: "writing_sample", label: "Writing Sample", icon: "✍️", accept: PDF_IMG },
  { key: "subject_specific_test_score", label: "Subject-Specific Test Score (SAT/ACT/GRE/GMAT/LSAT/MCAT/BMAT)", icon: "📊", accept: PDF_IMG },
  { key: "transcript_evaluation_report", label: "Transcript Evaluation Report (WES/ENIC-NARIC)", icon: "📊", accept: PDF_IMG },
  { key: "medium_of_instruction_letter", label: "Medium of Instruction Letter", icon: "🌐", accept: PDF_IMG },
  { key: "predicted_grades", label: "Predicted Grades (UK)", icon: "📈", accept: PDF_IMG },
  { key: "gap_year_explanation_letter", label: "Gap Year Explanation Letter", icon: "📝", accept: PDF_IMG },
  { key: "academic_reference_form", label: "Academic Reference Form", icon: "📝", accept: PDF_IMG },
  { key: "bank_statement", label: "Bank Statement", icon: "🏦", accept: PDF_IMG },
  { key: "financial_evidence_28_days", label: "Financial Evidence (28 Days, UK)", icon: "🏦", accept: PDF_IMG },
  { key: "financial_documents_3_months", label: "Financial Documents (3 Months, USA)", icon: "🏦", accept: PDF_IMG },
  { key: "gic_certificate", label: "GIC Certificate (Canada SDS)", icon: "💳", accept: PDF_IMG },
  { key: "sponsor_letter", label: "Sponsor Letter", icon: "💰", accept: PDF_IMG },
  { key: "affidavit_of_support", label: "Affidavit of Support (I-134/I-864)", icon: "💰", accept: PDF_IMG },
  { key: "sponsor_id_proof", label: "Sponsor ID / Passport", icon: "🪪", accept: PDF_IMG },
  { key: "sponsor_relationship_proof", label: "Sponsor Relationship Proof", icon: "👨‍👩‍👧", accept: PDF_IMG },
  { key: "sponsor_employment_letter", label: "Sponsor Employment Letter", icon: "💼", accept: PDF_IMG },
  { key: "sponsor_tax_returns", label: "Sponsor Tax Returns", icon: "🧾", accept: PDF_IMG },
  { key: "scholarship_award_letter", label: "Scholarship Award Letter", icon: "🏆", accept: PDF_IMG },
  { key: "proof_of_tuition_payment", label: "Proof of Tuition Payment", icon: "🧾", accept: PDF_IMG },
  { key: "education_loan_approval_letter", label: "Education Loan Approval Letter", icon: "💳", accept: PDF_IMG },
  { key: "fixed_deposit_receipt", label: "Fixed Deposit Receipt", icon: "🏦", accept: PDF_IMG },
  { key: "medical_examination_report", label: "Medical Examination Report", icon: "🏥", accept: PDF_IMG },
  { key: "hiv_test_certificate", label: "HIV Test Certificate", icon: "🧪", accept: PDF_IMG },
  { key: "tb_test_certificate", label: "TB Test Certificate", icon: "🧪", accept: PDF_IMG },
  { key: "hepatitis_b_test", label: "Hepatitis B Test", icon: "🧪", accept: PDF_IMG },
  { key: "hepatitis_c_test", label: "Hepatitis C Test", icon: "🧪", accept: PDF_IMG },
  { key: "vaccination_record", label: "Vaccination Record", icon: "💉", accept: PDF_IMG },
  { key: "covid_vaccination_certificate", label: "COVID-19 Vaccination Certificate", icon: "💉", accept: PDF_IMG },
  { key: "panel_physician_medical_exam", label: "Panel Physician Medical Exam (Canada)", icon: "🏥", accept: PDF_IMG },
  { key: "mental_health_clearance", label: "Mental Health Clearance", icon: "🧠", accept: PDF_IMG },
  { key: "physical_fitness_certificate", label: "Physical Fitness Certificate", icon: "💪", accept: PDF_IMG },
  { key: "visa_application_form", label: "Visa Application Form", icon: "🛂", accept: PDF_IMG },
  { key: "i20_form", label: "I-20 Form (USA F-1)", icon: "🛂", accept: PDF_IMG },
  { key: "ds160_confirmation", label: "DS-160 Confirmation (USA)", icon: "🛂", accept: PDF_IMG },
  { key: "sevis_fee_receipt", label: "SEVIS I-901 Fee Receipt", icon: "🧾", accept: PDF_IMG },
  { key: "cas_letter", label: "CAS Letter (UK)", icon: "📋", accept: PDF_IMG },
  { key: "atas_certificate", label: "ATAS Certificate (UK)", icon: "📋", accept: PDF_IMG },
  { key: "pal_tal_letter", label: "PAL / TAL Letter (Canada)", icon: "📋", accept: PDF_IMG },
  { key: "letter_of_acceptance_dli", label: "Letter of Acceptance from DLI (Canada)", icon: "📋", accept: PDF_IMG },
  { key: "biometrics_appointment_receipt", label: "Biometrics Appointment Receipt", icon: "📅", accept: PDF_IMG },
  { key: "previous_visa_copies", label: "Previous Visa Copies", icon: "🛂", accept: PDF_IMG },
  { key: "visa_refusal_history", label: "Visa Refusal History / Explanation", icon: "📝", accept: PDF_IMG },
  { key: "travel_history", label: "Travel History", icon: "✈️", accept: PDF_IMG },
  { key: "residence_permit", label: "Residence Permit", icon: "🪪", accept: PDF_IMG },
  { key: "police_clearance_certificate", label: "Police Clearance Certificate", icon: "👮", accept: PDF_IMG },
  { key: "good_conduct_certificate", label: "Good Conduct Certificate", icon: "👮", accept: PDF_IMG },
  { key: "birth_certificate", label: "Birth Certificate", icon: "👶", accept: PDF_IMG },
  { key: "national_id_card", label: "National ID Card", icon: "🪪", accept: PDF_IMG },
  { key: "family_book", label: "Family Book", icon: "👨‍👩‍👧", accept: PDF_IMG },
  { key: "marriage_certificate", label: "Marriage Certificate", icon: "💍", accept: PDF_IMG },
  { key: "name_change_affidavit", label: "Name Change Affidavit", icon: "📝", accept: PDF_IMG },
  { key: "passport_size_photo_specifications", label: "Passport-Size Photo (Spec-Compliant)", icon: "📷", accept: PDF_IMG },
  { key: "no_objection_certificate", label: "No Objection Certificate (NOC)", icon: "📝", accept: PDF_IMG },
  { key: "employer_letter", label: "Employer Letter", icon: "💼", accept: PDF_IMG },
  { key: "work_experience_certificate", label: "Work Experience Certificate", icon: "💼", accept: PDF_IMG },
  { key: "internship_certificates", label: "Internship Certificates", icon: "💼", accept: PDF_IMG },
  { key: "professional_license", label: "Professional License", icon: "🪪", accept: PDF_IMG },
  { key: "business_registration", label: "Business Registration", icon: "🏢", accept: PDF_IMG },
  { key: "military_status_document", label: "Military Status Document (Türkiye)", icon: "🪖", accept: PDF_IMG },
  { key: "yos_score_report", label: "YÖS Score Report (Türkiye)", icon: "📊", accept: PDF_IMG },
  { key: "sat_score_report", label: "SAT Score Report", icon: "📊", accept: PDF_IMG },
  { key: "gaokao_score_report", label: "Gaokao Score Report (China)", icon: "📊", accept: PDF_IMG },
  { key: "abitur_certificate", label: "Abitur Certificate (Germany)", icon: "🎓", accept: PDF_IMG },
  { key: "a_level_certificate", label: "A-Level Certificate (UK)", icon: "🎓", accept: PDF_IMG },
  { key: "ib_diploma", label: "IB Diploma", icon: "🎓", accept: PDF_IMG },
  { key: "olympiad_certificates", label: "Olympiad Certificates", icon: "🏆", accept: PDF_IMG },
  { key: "accommodation_proof", label: "Accommodation Proof", icon: "🏠", accept: PDF_IMG },
  { key: "custodian_declaration", label: "Custodian Declaration", icon: "👨‍👩‍👧", accept: PDF_IMG },
  { key: "parental_consent", label: "Parental Consent", icon: "👨‍👩‍👧", accept: PDF_IMG },
  { key: "dependents_documents", label: "Dependents' Documents", icon: "👨‍👩‍👧", accept: PDF_IMG },
  { key: "ukvi_approved_english_test", label: "UKVI-Approved English Test", icon: "🌐", accept: PDF_IMG },
  { key: "statement_of_finance", label: "Statement of Finance", icon: "💰", accept: PDF_IMG },
  { key: "personal_statement", label: "Personal Statement", icon: "✍️", accept: PDF_IMG },
  { key: "diversity_statement", label: "Diversity Statement", icon: "✍️", accept: PDF_IMG },
  { key: "ai_usage_declaration", label: "AI Usage Declaration", icon: "✍️", accept: PDF_IMG },
  { key: "gdpr_consent_form", label: "GDPR Consent Form", icon: "📝", accept: PDF_IMG },
  { key: "fraud_declaration", label: "Fraud Declaration", icon: "📝", accept: PDF_IMG },
];

export async function seedDocumentTypes(pool: { query: (...args: any[]) => Promise<any> }): Promise<void> {
  try {
    // Race-safe uniqueness: ensure (category, value) is unique BEFORE any
    // INSERT runs. Drops any pre-existing duplicates first (keeps lowest id).
    // Then the per-row upsert below uses ON CONFLICT, so concurrent workers
    // cannot create duplicates.
    await pool.query(`
      DELETE FROM catalog_options a USING catalog_options b
      WHERE a.id > b.id AND a.category = b.category AND a.value = b.value
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS catalog_options_category_value_uq
      ON catalog_options (category, value)
    `);

    const canonicalLabels = DOCUMENT_TYPES.map(d => d.label);
    // Clean up v1 legacy rows: value=label, metadata IS NULL. User-added
    // rows (any other shape) are preserved.
    const cleanup = await pool.query(
      `DELETE FROM catalog_options
       WHERE category = 'documents'
         AND metadata IS NULL
         AND value = ANY($1::text[])`,
      [canonicalLabels],
    );
    if (cleanup.rowCount && cleanup.rowCount > 0) {
      console.log(`[seed] Document types: cleaned up ${cleanup.rowCount} legacy v1 rows`);
    }

    let touched = 0;
    for (let i = 0; i < DOCUMENT_TYPES.length; i++) {
      const { key, label, icon, accept } = DOCUMENT_TYPES[i];
      const metadata = { label, icon, accept };
      // Atomic upsert. If a row exists with NULL metadata (e.g. seeded by
      // an older version), backfill it. Otherwise leave admin edits alone.
      const res = await pool.query(
        `INSERT INTO catalog_options (category, value, sort_order, is_active, metadata)
         VALUES ('documents', $1, $2, true, $3::jsonb)
         ON CONFLICT (category, value) DO UPDATE
           SET metadata = COALESCE(catalog_options.metadata, EXCLUDED.metadata)`,
        [key, i, JSON.stringify(metadata)],
      );
      if (res.rowCount && res.rowCount > 0) touched++;
    }
    if (touched > 0) {
      console.log(`[seed] Document types: ${touched} rows upserted (insert or metadata-backfill)`);
    }
  } catch (err) {
    console.error("[seed] seedDocumentTypes error:", err);
  }
}
