import type { SubmitFiles } from "../../types.js";

// ---------------------------------------------------------------------------
// Per-school Salesforce portal configuration
// ---------------------------------------------------------------------------
export interface SalesforceSchoolConfig {
  key: string;
  label: string;
  portalUrl: string;
  /** Lower-cased, fold()-normalised fragments used by matches(). */
  namePatterns: string[];
  requiredDocs: (keyof SubmitFiles)[];
  /**
   * Uses exact profile/program/document/final-state proof and never substitutes
   * guessed portal values. Enable only after the school's current flow has the
   * shared Salesforce verification contract.
   */
  strictContract: boolean;
}

export const SALESFORCE_SCHOOLS: SalesforceSchoolConfig[] = [
  {
    key: "halic",
    label: "Haliç Üniversitesi",
    portalUrl: "https://applyonline.halic.edu.tr/agency/s",
    namePatterns: ["halic"],
    requiredDocs: ["diploma", "transcript", "passport"],
    // Haliç is a new independent lane. Keep strict readback/upload/completion
    // proof enabled so an uncalibrated portal difference fails closed instead
    // of being recorded as a successful application.
    strictContract: true,
  },
  {
    key: "uskudar",
    label: "Üsküdar Üniversitesi",
    portalUrl: "https://apply.uskudar.edu.tr/agency/s",
    namePatterns: ["uskudar"],
    requiredDocs: ["diploma", "transcript", "passport"],
    strictContract: true,
  },
  {
    key: "aydin",
    label: "İstanbul Aydın Üniversitesi",
    portalUrl: "https://applyonline.aydin.edu.tr/agency/s",
    namePatterns: ["aydin","istanbul aydin"],
    requiredDocs: ["diploma", "transcript", "passport"],
    strictContract: false,
  },
  {
    key: "bau",
    label: "Bahçeşehir Üniversitesi",
    portalUrl: "https://applyonline.bau.edu.tr/agency/s",
    namePatterns: ["bahcesehir","bau"],
    requiredDocs: ["diploma", "transcript", "passport"],
    strictContract: true,
  },
  {
    key: "atlas",
    label: "Atlas Üniversitesi",
    portalUrl: "https://apply.atlas.edu.tr/agency/s",
    namePatterns: ["atlas"],
    requiredDocs: ["diploma", "transcript", "passport"],
    strictContract: false,
  },
  {
    key: "dogus",
    label: "Doğuş Üniversitesi",
    portalUrl: "https://apply.dogus.edu.tr/agency/s",
    namePatterns: ["dogus"],
    requiredDocs: ["diploma", "transcript", "passport"],
    strictContract: false,
  },
  {
    key: "ozyegin",
    label: "Özyeğin Üniversitesi",
    portalUrl: "https://apply.ozyegin.edu.tr/agency/s",
    namePatterns: ["ozyegin"],
    requiredDocs: ["diploma", "transcript", "passport"],
    strictContract: true,
  },
  {
    key: "pirireis",
    label: "Piri Reis Üniversitesi",
    portalUrl: "https://apply.pirireis.edu.tr/partner/s",
    namePatterns: ["piri reis","pirireis"],
    requiredDocs: ["diploma", "transcript", "passport"],
    strictContract: false,
  },
  {
    key: "sabanci",
    label: "Sabancı Üniversitesi",
    portalUrl: "https://apply.sabanciuniv.edu/partner/s",
    namePatterns: ["sabanci"],
    requiredDocs: ["diploma", "transcript", "passport"],
    strictContract: true,
  },
  {
    key: "yeditepe",
    label: "Yeditepe Üniversitesi",
    portalUrl: "https://apply.yeditepe.edu.tr/partner/s",
    namePatterns: ["yeditepe"],
    requiredDocs: ["diploma", "transcript", "passport"],
    strictContract: true,
  },
  {
    key: "beykent",
    label: "İstanbul Beykent Üniversitesi",
    portalUrl: "https://beykent.my.site.com/agency/s",
    namePatterns: ["beykent"],
    requiredDocs: ["diploma", "transcript", "passport"],
    strictContract: true,
  },
  {
    key: "isik",
    label: "Işık Üniversitesi",
    portalUrl: "https://isikuniversity.my.site.com/agency/s",
    namePatterns: ["isik"],
    requiredDocs: ["diploma", "transcript", "passport"],
    strictContract: true,
  },
];
