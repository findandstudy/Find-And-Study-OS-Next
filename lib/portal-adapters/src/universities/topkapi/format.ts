import { fold } from "../../programMatch.js";

// ---------------------------------------------------------------------------
// Topkapı Step 3 — graduation-date formatting.
//
// The CRM stores graduation as a year-only integer (e.g. 2025), but the portal
// field `GraduationDate[]` may render as a plain text/number input OR a native
// date/month/week picker. A native <input type="date"> silently rejects a bare
// "2025" (its .value stays empty), which the Step-3 verify/retry gate then
// reports as "empty after retry".
//
// We therefore detect the REAL DOM widget type at runtime and expand the
// year-only value into the format that widget accepts, instead of guessing.
// ---------------------------------------------------------------------------

/**
 * Expands a year-only graduation value into the string the portal's graduation
 * input accepts, based on the input's runtime `type` attribute.
 *
 *   type="date"  → "YYYY-01-01"   (HTML date value format)
 *   type="month" → "YYYY-01"
 *   type="week"  → "YYYY-W01"
 *   text/number/unknown → "YYYY"  (plain year)
 *
 * Returns "-" when no year is available so the caller's existing placeholder /
 * gate behaviour is unchanged.
 */
export function formatGraduationForInput(
  year: number | null | undefined,
  inputType: string,
): string {
  if (year == null || !Number.isFinite(Number(year))) return "-";
  const y = String(year);
  switch ((inputType || "").trim().toLowerCase()) {
    case "date":
      return `${y}-01-01`;
    case "month":
      return `${y}-01`;
    case "week":
      return `${y}-W01`;
    default:
      return y;
  }
}

/**
 * Expands a year-only graduation value into a FULL date string for a jQuery-style
 * datepicker (Topkapı's `twopulse-datepicker`), whose native input type is
 * "text" so {@link formatGraduationForInput} would return a bare year that the
 * picker silently clears.
 *
 * The format is driven by the input's runtime `data-date-format` attribute when
 * present (token map: y→year, m→"01", d→"01", separators preserved); otherwise
 * it defaults to the common Turkish `dd.mm.yyyy` shape ("01.01.YYYY").
 *
 * Returns "-" when no year is available so the caller's placeholder / gate
 * behaviour is unchanged.
 */
export function formatGraduationForDatepicker(
  year: number | null | undefined,
  dateFormat?: string | null,
): string {
  if (year == null || !Number.isFinite(Number(year))) return "-";
  const y = String(year);
  const fmt = (dateFormat || "").trim();
  if (!fmt) return `01.01.${y}`;
  return fmt
    .replace(/y{2,4}/i, y)
    .replace(/m{1,2}/i, "01")
    .replace(/d{1,2}/i, "01");
}

// ---------------------------------------------------------------------------
// CRM education level → Topkapı program-level label (the level of the program
// being APPLIED to). Used for Step 4's program-level radio. Thesis vs non-thesis
// is encoded in the CRM program NAME, not the level, so both are folded together.
// ---------------------------------------------------------------------------
export function mapEduLevel(level: string, programName = ""): string {
  const f = level.toLowerCase();
  if (/associate|önlisans|onlisans|foundation/.test(f)) return "Associate";
  if (/master|yüksek|yuksek/.test(f)) {
    const combined = fold(`${level} ${programName}`);
    if (/non[- ]?thesis|tezsiz/.test(combined)) return "Masters (Non Thesis)";
    return "Masters (Thesis)";
  }
  if (/phd|doctor|doktora/.test(f)) return "Doctorate";
  return "Bachelor";
}

// ---------------------------------------------------------------------------
// Step 3's education-level dropdown is the DEGREE LEVEL OF THE PROGRAM BEING
// APPLIED TO (Associate/Bachelor/Masters/Doctorate) — NOT the applicant's prior
// schooling. The live widget dump confirms the option set is
// exactly the applied degree levels (option VALUE is the English key, the
// visible label is Turkish):
//
//   Associate            :: Önlisans
//   Bachelor             :: Lisans
//   Masters (Non Thesis) :: Yüksek Lisans (Tezsiz)
//   Masters (Thesis)     :: Yüksek Lisans (Tezli)
//   Doctorate            :: Doktora
//
// So map the applied level straight to the option VALUE (via mapEduLevel) and
// return the Turkish label as a secondary candidate, letting the matcher hit
// the value exactly with the visible label as a fallback.
// ---------------------------------------------------------------------------
export function eduLevelCandidates(level: string, programName = ""): string[] {
  const applied = mapEduLevel(level, programName);
  const turkish: Record<string, string> = {
    Associate: "Önlisans",
    Bachelor: "Lisans",
    "Masters (Thesis)": "Yüksek Lisans (Tezli)",
    "Masters (Non Thesis)": "Yüksek Lisans (Tezsiz)",
    Doctorate: "Doktora",
  };
  const out: string[] = [];
  for (const c of [applied, turkish[applied]]) {
    if (c && !out.some((x) => fold(x) === fold(c))) out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// True when a <select>'s current value/text is a non-selection placeholder
// (e.g. "Seçim Yapın", "Seçiniz", "Please Select", "0", empty). Prevents the
// Step-3 verify from accepting an unselected dropdown as a real choice — the
// root cause of "educationLevel=Seçim Yapın" followed by missing dependent
// fields.
// ---------------------------------------------------------------------------
export function isPlaceholderChoice(value: string, text: string): boolean {
  const v = (value || "").trim();
  if (!v || v === "0") return true;
  const t = fold(text || "");
  if (!t || t === "-") return true;
  return /^(secim yapin|seciniz|secin|lutfen secim yapin|lutfen seciniz|please select|select one|select|choose)$/.test(
    t,
  );
}
