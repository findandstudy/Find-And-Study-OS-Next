// ---------------------------------------------------------------------------
// fold — canonical string normalisation for program-name matching
//
// Order of operations (CRITICAL — do NOT reorder):
//   1. Repair a known portal defect where a trailing language marker is glued
//      to the programme name ("ManagementEnglish")
//   2. Turkish-specific char replacements BEFORE toLowerCase
//   3. toLowerCase
//   4. NFKD Unicode normalisation
//   5. Strip combining diacritics (0300-036F)
//   6. Replace any non-alphanumeric run with a single space
//   7. Trim & collapse interior whitespace
//   8. Compound-word normalisation (runs on clean ASCII from step 7)
// ---------------------------------------------------------------------------
function separateGluedTrailingTrack(s: string): string {
  // Some SIT/Salesforce catalog labels omit the separator before their final
  // language marker, e.g. "Industrial Product DesignEnglish". Keep this
  // deliberately narrow: only a terminal English/Turkish marker is repaired;
  // interior words and other programme-name compounds are never split.
  return s.replace(/([a-z])(?=(?:english|turkish)\s*(?:\)|$))/gi, "$1 ");
}

export function fold(s: string): string {
  return separateGluedTrailingTrack(s)
    // --- Step 2: Turkish chars → ASCII equivalents (must be BEFORE toLowerCase) ---
    .replace(/İ/g, "i")   // capital dotted I  → i
    .replace(/I/g,  "i")  // capital I (undotted, Turkish uppercase of ı) → i
    .replace(/ı/g,  "i")  // lowercase dotless i → i
    .replace(/Ş/g,  "s").replace(/ş/g, "s")
    .replace(/Ç/g,  "c").replace(/ç/g, "c")
    .replace(/Ö/g,  "o").replace(/ö/g, "o")
    .replace(/Ü/g,  "u").replace(/ü/g, "u")
    .replace(/Ğ/g,  "g").replace(/ğ/g, "g")
    // --- Step 3: to lower ---
    .toLowerCase()
    // --- Step 4: NFKD decomposition ---
    .normalize("NFKD")
    // --- Step 5: strip combining diacritics ---
    .replace(/[\u0300-\u036f]/g, "")
    // --- Step 6: non-alphanumeric → space ---
    .replace(/[^a-z0-9]+/g, " ")
    // --- Step 7: trim & collapse ---
    .trim()
    .replace(/\s+/g, " ")
    // --- Step 8: Compound-word normalisation ---
    // "yuksek lisans" is the Turkish two-word spelling of "Yüksek Lisans"
    // (master's degree). Without merging, the token "lisans" maps to the
    // ["lisans", "bachelor", "undergraduate"] synonym group, causing master's
    // portal options to score as near-matches for bachelor queries (and vice
    // versa). Merging into the single token "yukseklisans" correctly picks up
    // the ["yukseklisans", "master", "masters", "graduate"] synonym group.
    .replace(/\byuksek lisans\b/g, "yukseklisans");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface ProgramCandidate {
  id: string;
  name: string;
  /**
   * Optional catalog metadata (populated by the SIT GraphQL catalog) used to
   * build the create-application payload. Other adapters leave these undefined;
   * matching only ever relies on `id` + `name`.
   */
  universityName?: string;
  degreeName?: string;
  languageName?: string;
}

export interface MatchResult {
  match: ProgramCandidate;
  conf: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CONF_THRESHOLD   = 0.6;
const MARGIN_THRESHOLD = 0.15;

// ---------------------------------------------------------------------------
// EN↔TR synonym groups (sourced from data/fields.json)
//
// Each inner array is an equivalence class of folded tokens.
// When scoring Jaccard, if no primary match is found, tokens are expanded
// with all synonyms from their group before re-scoring (see expandTokens).
// ---------------------------------------------------------------------------
const SYNONYM_GROUPS: readonly string[][] = [
  ["bilgisayar", "computer", "computing"],
  ["muhendislik", "muhendisligi", "engineering"],
  ["isletme", "business", "management", "yonetim"],
  ["ekonomi", "economics"],
  ["iletisim", "communication", "communications"],
  ["hukuk", "law"],
  ["tip", "medicine", "medical", "tibbi"],
  ["mimarlik", "architecture", "architectural"],
  ["psikoloji", "psychology"],
  ["egitim", "education"],
  ["matematik", "mathematics", "math"],
  ["fizik", "physics"],
  ["kimya", "chemistry"],
  ["biyoloji", "biology"],
  ["sosyoloji", "sociology"],
  ["tarih", "history"],
  ["cografi", "geography"],
  ["felsefe", "philosophy"],
  ["sanat", "art", "arts"],
  ["muzik", "music"],
  ["tiyatro", "theater", "theatre"],
  ["uluslararasi", "international"],
  ["iliskiler", "relations"],
  ["siyasi", "political"],
  ["bilim", "science", "sciences"],
  ["yazilim", "software"],
  ["endustri", "industrial"],
  ["makine", "mechanical"],
  ["insaat", "civil", "construction"],
  ["elektrik", "electrical", "electric"],
  ["elektronik", "electronics", "electronic"],
  ["cevre", "environmental", "environment"],
  ["malzeme", "materials"],
  ["tekstil", "textile"],
  ["gida", "food"],
  ["tarim", "agriculture", "agricultural"],
  ["orman", "forestry", "forest"],
  ["basin", "media"],
  ["finans", "finance", "financial"],
  ["bankacilik", "banking"],
  ["muhasebe", "accounting"],
  ["saglik", "health"],
  ["hemsirelik", "nursing"],
  ["eczacilik", "pharmacy", "pharmaceutical"],
  ["teknoloji", "teknolojisi", "technology"],
  ["yonetim", "administration", "management"],
  ["halkla", "public"],
  ["grafik", "graphic"],
  ["tasarim", "design"],
  ["fotograf", "photography"],
  ["sinema", "cinema", "film"],
  ["gazetecilik", "journalism"],
  ["turizm", "tourism", "hospitality"],
  ["spor", "sports", "sport"],
  ["sosyal", "social"],
  ["siyaset", "politics", "political"],
  // Language-of-instruction synonyms (portal uses Turkish language names)
  ["ingilizce", "english"],
  ["turkce", "turkish"],
  ["fransizca", "french"],
  ["almanca", "german"],
  ["arapca", "arabic"],
  ["rusca", "russian"],
  // Degree-level synonyms
  ["lisans", "bachelor", "undergraduate"],
  ["onlisans", "associate"],
  ["yukseklisans", "master", "masters", "graduate"],  // NOTE: fold() merges "yuksek lisans" → "yukseklisans" (Step 7)
  ["doktora", "doctorate", "phd", "doctoral"],
  // Thesis mode synonyms (used by hasTez / hasTezsiz hard filters)
  ["tezli", "thesis"],
  ["tezsiz", "nothesis"],   // "non-thesis" → after fold step 5 becomes "non thesis" → two tokens; kept for safety
  // Subject-area additions (found in Topkapi programs not covered above)
  ["ticaret", "trade", "commerce", "commercial"],
  ["bilisim", "informatics", "information", "systems"],
  ["sistemleri", "systems"],

  // -------------------------------------------------------------------------
  // Extended EN↔TR coverage (cross-portal program-name matching).
  //
  // Additive only — these groups EXTEND the proven defaults above. Where a
  // group shares a token (hub) with an existing group, buildSynonymMap merges
  // their synonym sets so matching still bridges correctly. All tokens are in
  // folded form (lowercase ASCII, Turkish chars mapped, single words only:
  // multi-word/hyphenated forms never match because tokenize() splits on
  // spaces, so they are intentionally omitted).
  // -------------------------------------------------------------------------

  // --- Degree / study format ---
  ["lisansustu", "postgraduate", "graduate"],
  ["yuksek", "yukseklisans"],
  ["uzaktan", "distance", "online", "elearning"],
  ["orgun", "formal", "onsite"],
  ["hazirlik", "preparatory", "prep", "foundation"],
  ["sertifika", "certificate"],

  // --- Health sciences ---
  ["hekimlik", "medicine"],
  ["dis", "dental", "dentistry"],
  ["fizyoterapi", "physiotherapy", "rehabilitation"],
  ["beslenme", "nutrition", "dietetics"],
  ["ebelik", "midwifery"],
  ["odyoloji", "audiology"],
  ["veteriner", "veterinary"],
  ["biyomedikal", "biomedical"],
  ["saglik", "health", "healthcare"],
  ["laboratuvar", "laboratory", "laboratories"],
  ["anestezi", "anesthesia", "anaesthesia"],
  ["radyoloji", "radiology"],
  ["optisyenlik", "optician", "optometry"],
  ["agiz", "oral"],
  ["cocuk", "child", "pediatric"],
  ["gelisimi", "gelistirme", "development"],
  ["konusma", "speech"],
  ["terapi", "therapy", "therapies"],
  ["goruntuleme", "imaging"],
  ["ameliyathane", "surgery"],
  ["acil", "emergency"],
  ["yardim", "aid"],
  ["ilk", "first"],

  // --- Engineering & computing ---
  ["makine", "makina", "mechanical"],
  ["endustri", "endustriyel", "industrial"],
  ["kimya", "chemical", "chemistry"],
  ["mekatronik", "mechatronics"],
  ["otomotiv", "automotive"],
  ["havacilik", "aviation", "aeronautical", "aerospace"],
  ["uzay", "aerospace", "space"],
  ["yapay", "artificial"],
  ["zeka", "intelligence"],
  ["veri", "data"],
  ["bilim", "bilimi", "science", "sciences"],
  ["siber", "cyber"],
  ["guvenlik", "security"],
  ["aglar", "networks", "network"],
  ["biyomuhendislik", "bioengineering"],
  ["enerji", "energy"],

  // --- Business / economics / social management ---
  ["iktisat", "ekonomi", "economics"],
  ["sigortacilik", "sigorta", "insurance"],
  ["pazarlama", "marketing"],
  ["lojistik", "logistics"],
  ["tedarik", "supply"],
  ["girisimcilik", "entrepreneurship"],
  ["insan", "human"],
  ["kaynaklari", "resources"],
  ["calisma", "labor", "labour"],
  ["vergi", "taxation", "tax"],
  ["denetim", "audit", "auditing"],
  ["aktuerya", "actuarial"],
  ["maliye", "finance"],

  // --- Law / politics / public ---
  ["hukuk", "law", "legal"],
  ["adalet", "justice"],
  ["siyasal", "siyasi", "political", "politics"],
  ["kamu", "public"],
  ["diplomasi", "diplomacy"],
  ["adli", "forensic"],
  ["bilirkisi", "forensic"],
  ["yonetisim", "governance"],

  // --- Social sciences & humanities ---
  ["psikoloji", "psychology", "psychological"],
  ["psikolojik", "psychological"],
  ["antropoloji", "anthropology"],
  ["cografya", "cografi", "geography"],
  ["hizmet", "hizmeti", "work", "service"],
  ["edebiyat", "literature"],
  ["dil", "language", "linguistics"],
  ["dilbilimi", "linguistics"],
  ["ceviri", "translation", "interpreting"],
  ["mutercim", "translation", "translator"],
  ["tercumanlik", "interpreting", "interpretation"],
  ["ingiliz", "english"],
  ["rehberlik", "guidance", "counseling", "counselling"],
  ["danismanlik", "counseling", "consultancy"],

  // --- Architecture & design ---
  ["mimarlik", "mimarligi", "architecture", "architectural"],
  ["ic", "interior"],
  ["sehir", "urban", "city"],
  ["bolge", "regional"],
  ["planlama", "planning"],
  ["peyzaj", "landscape"],
  ["tasarim", "tasarimi", "design"],

  // --- Communication, media & arts ---
  ["medya", "media"],
  ["yeni", "new"],
  ["reklam", "reklamcilik", "advertising"],
  ["radyo", "radio"],
  ["televizyon", "television"],
  ["gorsel", "visual"],
  ["sanat", "sanatlar", "art", "arts"],
  ["resim", "painting"],
  ["grafik", "graphic", "graphics"],
  ["fotograf", "fotografcilik", "photography"],
  ["moda", "fashion"],
  ["tekstil", "textile", "textiles"],
  ["animasyon", "animation"],
  ["oyun", "game"],

  // --- Tourism & gastronomy ---
  ["otel", "otelcilik", "hotel", "hospitality"],
  ["gastronomi", "gastronomy", "culinary"],
  ["mutfak", "culinary", "cookery"],
  ["ascilik", "cookery", "cooking"],
  ["rekreasyon", "recreation"],
  ["seyahat", "travel"],

  // --- Education & sport ---
  ["ogretmenligi", "ogretmenlik", "teaching", "teacher"],
  ["egitim", "egitimi", "education", "educational"],
  ["okul", "school"],
  ["oncesi", "preschool"],
  ["ozel", "special"],
  ["antrenorluk", "coaching"],
  ["beden", "physical"],
  ["mesleki", "occupational", "vocational"],

  // --- Basic sciences ---
  ["biyoloji", "biology", "biological"],
  ["molekuler", "molecular"],
  ["genetik", "genetics", "genetic"],
  ["istatistik", "statistics"],
  ["biyokimya", "biochemistry"],
  ["biyoteknoloji", "biotechnology"],

  // --- General modifiers ---
  ["uygulamali", "applied"],
  ["teknikerligi", "teknik", "technician", "technical"],
  ["programciligi", "programming"],
];

/** Build a token→synonyms map from equivalence-class groups. */
function buildSynonymMap(
  groups: readonly (readonly string[])[],
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const group of groups) {
    for (const term of group) {
      const synonyms = map.get(term) ?? new Set<string>();
      for (const other of group) {
        if (other !== term) synonyms.add(other);
      }
      map.set(term, synonyms);
    }
  }
  return map;
}

/** Default token → Set<synonyms>, built once at module load from SYNONYM_GROUPS. */
const _synonymMap = buildSynonymMap(SYNONYM_GROUPS);

/**
 * Expand a token set by adding all dictionary synonyms of each token.
 *
 * @param synonymMap token→synonyms map. Defaults to the built-in map; callers
 *                   that pass DB-supplied groups receive a merged map so panel
 *                   synonyms EXTEND (never replace) the proven defaults.
 */
function expandTokens(
  tokens: Set<string>,
  synonymMap: ReadonlyMap<string, Set<string>>,
): Set<string> {
  const expanded = new Set<string>(tokens);
  for (const t of tokens) {
    const syns = synonymMap.get(t);
    if (syns) {
      for (const s of syns) expanded.add(s);
    }
  }
  return expanded;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Split folded string into tokens (keep only tokens with length > 1). */
function tokenize(s: string): Set<string> {
  return new Set(fold(s).split(" ").filter(t => t.length > 1));
}

/** Jaccard similarity between two token sets. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Non-thesis (tezsiz) — TR "tezsiz" or EN "non thesis"/"nonthesis". */
function hasTezsiz(f: string): boolean {
  return /\btezsiz\b/.test(f) || /\bnon ?thesis\b/.test(f) || /\bnonthesis\b/.test(f);
}
/** Thesis (tezli) — TR "tezli" or EN "thesis" (but NOT "non thesis"). */
function hasTez(f: string): boolean {
  if (hasTezsiz(f)) return false;          // "thesis" inside "non thesis" is NOT tezli
  return /\btezli\b/.test(f) || /\bthesis\b/.test(f);
}

// Re-exported (read-only, behaviour-unchanged) so adapter-local fallback
// matchers — e.g. Topkapi's noise-stripped fuzzy fallback — can reuse the
// SAME thesis-marker + synonym-expansion logic as the primary matcher instead
// of duplicating/drifting from this dictionary. Never called differently
// here; purely additive exports.
export const hasThesisMarker    = hasTez;
export const hasNonThesisMarker = hasTezsiz;

/**
 * Expand a folded-token set with the built-in EN↔TR synonym dictionary
 * (optionally extended with panel-managed DB groups), for callers that need
 * synonym-aware overlap scoring outside of matchProgram()'s own pipeline.
 */
export function expandProgramTokens(
  tokens: Set<string>,
  extraSynonyms?: readonly (readonly string[])[],
): Set<string> {
  const synonymMap =
    extraSynonyms && extraSynonyms.length > 0
      ? buildSynonymMap([...SYNONYM_GROUPS, ...extraSynonyms])
      : _synonymMap;
  return expandTokens(tokens, synonymMap);
}

// ---------------------------------------------------------------------------
// parseTrack — extract the language-of-instruction "track" from a program label
//
// Recognises the medium as a STRUCTURED marker (never a leading subject word),
// covering every format we handle:
//   • Portal English mode:  "International Trade and Business - English (Bachelor)"
//   • CRM English names:     "Bachelor of International Trade and Business (English)"
//   • CRM / portal Turkish:  "İşletme (Türkçe)", "... (İngilizce - Lisans - ...)"
//   • Synthetic trailing:    "Psikoloji English"
//
// A leading subject like "English Language and Literature", or a teaching
// programme ("İngilizce/Türkçe Öğretmenliği"), deliberately returns null — the
// language word there is the SUBJECT, not the medium. Returns null when no
// track is present OR when both are present (ambiguous → don't hard-filter).
// ---------------------------------------------------------------------------
function normLang(s: string): string {
  return separateGluedTrailingTrack(s)
    .replace(/İ/g, "i").replace(/I/g, "i").replace(/ı/g, "i")
    .replace(/[şŞ]/g, "s").replace(/[çÇ]/g, "c").replace(/[öÖ]/g, "o")
    .replace(/[üÜ]/g, "u").replace(/[ğĞ]/g, "g")
    .toLowerCase();
}

/**
 * Normalise a degree/level string into a coarse comparison group so program
 * candidates can be pre-filtered to the SAME level as the source application.
 * Turkish-aware (folds ç/ğ/ı/İ/ö/ş/ü). Unknown values fall back to their folded
 * form so equal strings still match; empty input returns "".
 *
 * Shared level helper — single source consumed by the fan-out (portalAutomation)
 * AND the ordered fallback-chain generator, so "same level always matches" is
 * applied identically everywhere.
 */
export function levelGroup(raw: string | null | undefined): string {
  const s = (raw ?? "")
    .replace(/İ/g, "i").replace(/I/g, "i").replace(/ı/g, "i")
    .replace(/[Şş]/g, "s").replace(/[Çç]/g, "c").replace(/[Öö]/g, "o")
    .replace(/[Üü]/g, "u").replace(/[Ğğ]/g, "g")
    .toLowerCase().trim();
  if (!s) return "";
  if (/(phd|ph\.d|doctora|doktora|doctoral|doctorate)/.test(s)) return "phd";
  if (/(master|yukseklisans|yuksek lisans|graduate|msc|m\.sc|mba|postgrad)/.test(s)) return "master";
  if (/(associate|onlisans|on lisans|foundation|hazirlik|preparatory)/.test(s)) return "associate";
  if (/(bachelor|lisans|undergrad|undergraduate|bsc|b\.sc|licence)/.test(s)) return "bachelor";
  return s;
}

export function parseTrack(name: string): "en" | "tr" | null {
  const s = normLang(name);
  const en =
    /[-(]\s*(?:english|ingilizce)\b/.test(s) ||
    /\benglish medium\b/.test(s) ||
    /\b(?:english|ingilizce)\s*\)?\s*$/.test(s);
  const tr =
    /[-(]\s*(?:turkish|turkce)\b/.test(s) ||
    /\bturkish medium\b/.test(s) ||
    /\b(?:turkish|turkce)\s*\)?\s*$/.test(s);
  if (en && !tr) return "en";
  if (tr && !en) return "tr";
  return null;
}

// ---------------------------------------------------------------------------
// Degree / thesis / language hard filter
//
// Applied BEFORE Jaccard scoring.  If applying a filter would eliminate all
// candidates the filter is skipped (open-world assumption for incomplete data).
// ---------------------------------------------------------------------------
function applyHardFilters(
  queryFolded: string,
  queryTrack: "en" | "tr" | null,
  candidates: ProgramCandidate[],
): ProgramCandidate[] {
  let pool = candidates;

  // Thesis mode
  if (hasTez(queryFolded) && !hasTezsiz(queryFolded)) {
    const f = pool.filter(c => hasTez(fold(c.name)));
    if (f.length > 0) pool = f;
  } else if (hasTezsiz(queryFolded)) {
    const f = pool.filter(c => hasTezsiz(fold(c.name)));
    if (f.length > 0) pool = f;
  }

  // Language-of-instruction track (English ↔ Turkish). Prevents an English CRM
  // program from matching a Turkish portal option (and vice versa). Only
  // applies when the QUERY declares an explicit track. Unlabeled candidates are
  // kept (open-world), but an explicit opposite-track option is NEVER matched —
  // if the pool is exclusively opposite-track the result is null (programMissing).
  if (queryTrack) {
    const opposite = queryTrack === "en" ? "tr" : "en";
    const same = pool.filter(c => parseTrack(c.name) === queryTrack);
    if (same.length > 0) {
      pool = same;
    } else {
      // No same-track candidate — drop the OPPOSITE explicit track entirely so
      // an EN query never lands on a TR-labeled option (and vice versa).
      // Unlabeled (null-track) candidates are kept. If EVERY candidate is the
      // opposite track this leaves the pool empty, and matchProgram returns
      // null (→ programMissing) rather than ever producing a cross-track match.
      pool = pool.filter(c => parseTrack(c.name) !== opposite);
    }
  }

  return pool;
}

// ---------------------------------------------------------------------------
// scorePool — score candidates with optional token expansion
// ---------------------------------------------------------------------------
type Scored = { candidate: ProgramCandidate; conf: number };

function scorePool(
  queryTokens: Set<string>,
  pool: ProgramCandidate[],
  expand: boolean,
  synonymMap: ReadonlyMap<string, Set<string>>,
): Scored[] {
  const qt = expand ? expandTokens(queryTokens, synonymMap) : queryTokens;
  return pool
    .map(c => {
      const ct = expand ? expandTokens(tokenize(c.name), synonymMap) : tokenize(c.name);
      return { candidate: c, conf: jaccard(qt, ct) };
    })
    .filter(x => x.conf >= CONF_THRESHOLD)
    .sort((a, b) => b.conf - a.conf);
}

// ---------------------------------------------------------------------------
// Name-based mapping options.
//   nameMap:  { "portal option label" → "CRM program name" }. The panel-managed
//             Program Mappings (General ∪ university, university wins), reverse-
//             looked-up here: given the applicant's CRM program name, find the
//             portal label whose mapped CRM name folds-equal, then resolve that
//             label to a live <option>. This REPLACES the old CRM-programId path
//             so re-syncing a catalog (which changes IDs) never breaks a mapping.
//   synonyms: EN↔TR equivalence groups that EXTEND the built-in dictionary.
// ---------------------------------------------------------------------------
export interface MatchOptions {
  /** { portal option label → CRM program name } — UNIVERSITY tier (checked FIRST). */
  nameMap?: Record<string, string>;
  /**
   * { portal option label → CRM program name } — GENERAL (all-schools) tier,
   * consulted only after `nameMap` misses (University > General). Callers must
   * have already shadowed same-label university entries out of this map.
   */
  nameMapGeneral?: Record<string, string>;
  /** EN↔TR synonym groups (folded single tokens) extending the built-ins. */
  synonyms?: readonly (readonly string[])[];
}

/**
 * Reverse-resolve a portal <option> from the panel-managed name mapping.
 * The mapping is stored portal-label → CRM-name; given the CRM program name we
 * find every label mapped to it (folded-equal) and return the first candidate
 * option that matches that label by folded text, by option value, or by folded
 * substring. Returns null when no mapping applies.
 */
function resolveByNameMap(
  programName: string,
  candidates: ProgramCandidate[],
  nameMap?: Record<string, string>,
): ProgramCandidate | null {
  if (!nameMap) return null;
  const qFold = fold(programName);
  if (!qFold) return null;
  for (const [portalLabel, crmName] of Object.entries(nameMap)) {
    if (fold(crmName) !== qFold) continue;
    const lblFold = fold(portalLabel);
    const found =
      candidates.find(c => c.id === portalLabel) ??
      candidates.find(c => fold(c.name) === lblFold) ??
      (lblFold ? candidates.find(c => fold(c.name).includes(lblFold)) : undefined);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// matchProgram — main entry point
//
// Resolution order (fully NAME-based — CRM program IDs are never consulted):
//   1. Name mapping (nameMap portal-label→CRM-name reverse lookup) → conf 1.0
//   2. Exact / folded-name match → conf 1.0
//   3. Hard degree/thesis/language filter
//   4. Token-Jaccard scoring (primary — no expansion)
//   5. EN↔TR synonym expansion (fallback — only when step 4 finds NO candidates)
//   6. Confidence gate: conf ≥ 0.6 AND (single candidate OR margin ≥ 0.15)
// ---------------------------------------------------------------------------
export function matchProgram(
  programName: string,
  candidates: ProgramCandidate[],
  opts?: MatchOptions,
): MatchResult | null {

  // --- 1. Name mapping (panel-managed, highest confidence) ---
  // University tier is consulted BEFORE the General (all-schools) tier so a
  // per-university mapping always wins (University > General > fuzzy).
  const mapped =
    resolveByNameMap(programName, candidates, opts?.nameMap) ??
    resolveByNameMap(programName, candidates, opts?.nameMapGeneral);
  if (mapped) return { match: mapped, conf: 1.0 };

  if (candidates.length === 0) return null;

  // --- 1.5 Exact / folded-name match always wins (bypasses the margin gate) ---
  // "prefer the identical programme, else the closest" rule. An identical folded
  // name implies the same track + same thesis mode, so it is safe to return
  // immediately at conf 1.0. Without this, near-identical siblings (Thesis vs
  // Non-Thesis) collapse the margin below MARGIN_THRESHOLD and swallow the
  // conf-1.0 exact hit, yielding a spurious "no program".
  const qFold = fold(programName);
  const exact = candidates.find(c => fold(c.name) === qFold);
  if (exact) return { match: exact, conf: 1.0 };

  // --- 2. Hard filters ---
  const queryFolded = fold(programName);
  const queryTrack  = parseTrack(programName);
  const pool = applyHardFilters(queryFolded, queryTrack, candidates);

  // --- 3. Primary Jaccard (no expansion) ---
  // Synonym map: built-in groups, optionally extended with DB-supplied groups
  // (panel-managed). DB groups EXTEND the proven defaults — they never remove
  // built-in coverage. With no extras the shared default map is reused (zero
  // allocation, behaviour identical to before this parameter existed).
  const synonyms = opts?.synonyms;
  const synonymMap =
    synonyms && synonyms.length > 0
      ? buildSynonymMap([...SYNONYM_GROUPS, ...synonyms])
      : _synonymMap;

  const queryTokens = tokenize(programName);
  let scored = scorePool(queryTokens, pool, false, synonymMap);

  // --- 4. EN↔TR expansion fallback ---
  // Only triggered when NO primary candidate scores ≥ CONF_THRESHOLD.
  // Deliberately NOT triggered for the ambiguity case (margin < 0.15) —
  // that ambiguity result is intentional and must not be overridden.
  if (scored.length === 0) {
    scored = scorePool(queryTokens, pool, true, synonymMap);
  }

  if (scored.length === 0) return null;

  // --- 5. Confidence gate ---
  if (scored.length === 1) {
    return { match: scored[0].candidate, conf: scored[0].conf };
  }

  const margin = scored[0].conf - scored[1].conf;
  if (margin >= MARGIN_THRESHOLD) {
    return { match: scored[0].candidate, conf: scored[0].conf };
  }

  // Two or more candidates within 0.15 of each other — refuse to guess
  return null;
}
