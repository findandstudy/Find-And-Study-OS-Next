import type { SearchProgramsToolInput } from "./programSearchTool";

// The model may pass the student's original wording to the live catalog tool.
// Expand common multilingual study-field words deterministically so a vague
// phrase such as "bilgisayar bölümü" can still match English catalog rows.
// The original phrase is always retained; aliases only broaden the OR search.
const FIELD_ALIASES: Array<{ needles: string[]; alias: string }> = [
  {
    alias: "Computer",
    needles: [
      "computer", "computing", "bilgisayar", "bilişim", "bilisim",
      "informatique", "informática", "informatica", "computación", "computacion",
      "компьютер", "计算机", "कंप्यूटर", "komputer", "حاسوب", "الحاسوب", "کامپیوتر",
    ],
  },
  {
    alias: "Engineering",
    needles: [
      "engineering", "mühendislik", "muhendislik", "ingénierie", "ingenierie",
      "ingeniería", "ingenieria", "инженер", "工程", "इंजीनियरिंग", "teknik",
      "هندسة", "مهندسی",
    ],
  },
  {
    alias: "Business",
    needles: [
      "business", "işletme", "isletme", "commerce", "gestion", "negocios",
      "бизнес", "商业", "व्यवसाय", "bisnis", "أعمال", "تجارت",
    ],
  },
  {
    alias: "Medicine",
    needles: ["medicine", "medical", "tıp", "tip", "médecine", "medicina", "медицина", "医学", "चिकित्सा", "kedokteran", "طب", "پزشکی"],
  },
  {
    alias: "Dentistry",
    needles: ["dentistry", "dental", "diş", "dis", "dentaire", "odontología", "odontologia", "стоматолог", "牙科", "दंत", "kedokteran gigi", "أسنان", "دندانپزشکی"],
  },
  {
    alias: "Psychology",
    needles: ["psychology", "psikoloji", "psychologie", "psicología", "psicologia", "психология", "心理学", "मनोविज्ञान", "psikologi", "علم النفس", "روانشناسی"],
  },
  {
    alias: "Law",
    needles: ["law", "hukuk", "droit", "derecho", "право", "法律", "कानून", "hukum", "قانون", "حقوق"],
  },
  {
    alias: "Architecture",
    needles: ["architecture", "mimarlık", "mimarlik", "arquitectura", "архитектура", "建筑", "वास्तुकला", "arsitektur", "عمارة", "معماری"],
  },
  {
    alias: "Nursing",
    needles: ["nursing", "hemşirelik", "hemsirelik", "soins infirmiers", "enfermería", "enfermeria", "сестрин", "护理", "नर्सिंग", "keperawatan", "تمريض", "پرستاری"],
  },
  {
    alias: "Pharmacy",
    needles: ["pharmacy", "eczacılık", "eczacilik", "pharmacie", "farmacia", "фармация", "药学", "फार्मेसी", "farmasi", "صيدلة", "داروسازی"],
  },
];

function comparable(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function matchesNeedle(haystack: string, words: Set<string>, needle: string): boolean {
  const normalizedNeedle = comparable(needle);
  if (/\s/u.test(normalizedNeedle) || /\p{Script=Han}/u.test(normalizedNeedle)) {
    return haystack.includes(normalizedNeedle);
  }
  return words.has(normalizedNeedle);
}

export function expandProgramFieldIntent(...values: Array<string | undefined>): string | undefined {
  const originals = values
    .flatMap((value) => value?.split(",") ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  if (originals.length === 0) return undefined;

  const haystack = comparable(originals.join(" "));
  const words = new Set(haystack.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const expanded = [...originals];
  for (const group of FIELD_ALIASES) {
    if (group.needles.some((needle) => matchesNeedle(haystack, words, needle))) {
      expanded.push(group.alias);
    }
  }
  return [...new Set(expanded)].join(",");
}

/**
 * A university widget already has a server-enforced university ID. In that
 * scope, free-text `search` is program intent, not a university selector, so
 * merge it into the fuzzy field matcher instead of AND-ing two filters that
 * can accidentally eliminate valid rows.
 */
export function normalizeProgramSearchInput(
  input: SearchProgramsToolInput,
  enforcedUniversityIds?: number[],
): SearchProgramsToolInput {
  const isUniversityScoped = Array.isArray(enforcedUniversityIds) && enforcedUniversityIds.some(
    (id) => Number.isInteger(id) && id > 0,
  );
  if (isUniversityScoped) {
    return {
      ...input,
      field: expandProgramFieldIntent(input.field, input.search),
      search: undefined,
    };
  }
  return {
    ...input,
    field: expandProgramFieldIntent(input.field),
  };
}
