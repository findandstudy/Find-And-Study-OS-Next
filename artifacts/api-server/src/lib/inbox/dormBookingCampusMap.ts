export interface DormBookingCampusRule {
  university: string;
  aliases: string[];
  departmentAliases?: string[];
  campus: string;
  district: string;
  side: "European" | "Anatolian" | "mixed";
  requiresCampusConfirmation?: boolean;
}

/**
 * Verified routing facts supplied in Dorm Booking AI Operating Knowledge v2.
 * This list is deliberately closed: an unknown university/department must
 * produce a clarification request, never a guessed campus.
 */
export const DORMBOOKING_CAMPUS_RULES: DormBookingCampusRule[] = [
  {
    university: "Bahçeşehir University (BAU)",
    aliases: ["bahcesehir university", "bahçeşehir university", "bau"],
    departmentAliases: ["business", "işletme", "isletme"],
    campus: "South/North Campus",
    district: "Beşiktaş",
    side: "European",
  },
  {
    university: "İstanbul Kültür University",
    aliases: ["istanbul kultur university", "istanbul kültür university", "istanbul kultur universitesi", "istanbul kültür üniversitesi"],
    campus: "Ataköy–Bakırköy / Şirinevler–Bahçelievler",
    district: "Bakırköy / Bahçelievler",
    side: "European",
  },
  {
    university: "Koç University",
    aliases: ["koc university", "koç university", "koc universitesi", "koç üniversitesi"],
    campus: "Rumelifeneri Campus",
    district: "Sarıyer",
    side: "European",
  },
  {
    university: "Beykent University",
    aliases: ["beykent university", "beykent universitesi", "beykent üniversitesi"],
    campus: "Multiple campuses",
    district: "Unknown until programme/campus is confirmed",
    side: "mixed",
    requiresCampusConfirmation: true,
  },
  {
    university: "İstanbul Gelişim University",
    aliases: ["istanbul gelisim university", "istanbul gelişim university", "istanbul gelisim universitesi", "istanbul gelişim üniversitesi"],
    campus: "Avcılar Campus",
    district: "Avcılar",
    side: "European",
  },
];

function normalize(value: string): string {
  return value.toLocaleLowerCase("tr-TR").normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

export function resolveDormBookingCampusGuidance(query: string): string | null {
  const normalized = normalize(query);
  const candidates = DORMBOOKING_CAMPUS_RULES.filter((rule) =>
    rule.aliases.some((alias) => normalized.includes(normalize(alias))),
  );
  if (!candidates.length) return null;
  const exactDepartment = candidates.find((rule) =>
    !rule.departmentAliases || rule.departmentAliases.some((alias) => normalized.includes(normalize(alias))),
  );
  const rule = exactDepartment ?? candidates[0];
  if (rule.requiresCampusConfirmation || (rule.departmentAliases && !exactDepartment)) {
    return `VERIFIED CAMPUS ROUTING: ${rule.university} has multiple or programme-dependent campuses. Ask for the department/programme and exact campus. Do not recommend a district or dormitory until confirmed.`;
  }
  return `VERIFIED CAMPUS ROUTING: ${rule.university} — ${rule.campus}; district: ${rule.district}; Istanbul side: ${rule.side}. Do not describe an opposite-side dormitory as nearby. Exact commute time still requires catalog/map data.`;
}
