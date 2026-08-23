/**
 * Normalize a free-text GPA value into a 0-100 scale for eligibility checks.
 *
 * Accepts inputs like:
 *   "804/1100"            -> 73.09
 *   "3.5/4"               -> 87.5
 *   "85"                  -> 85   (already on 100 scale)
 *   "3.5"                 -> 87.5 (auto: <=4 -> /4)
 *   "4.2"                 -> 84   (auto: <=5 -> /5)
 *   "8.5"                 -> 85   (auto: <=10 -> /10)
 *   "15/20"               -> 75
 *   "85 (Grade A)"        -> 85   (text in parens stripped)
 *
 * Returns NaN if no numeric value can be extracted.
 */
export function normalizeGpaTo100(raw: string | null | undefined): number {
  if (raw == null) return NaN;
  const cleaned = String(raw)
    .replace(/\([^)]*\)/g, "")
    .trim();
  if (!cleaned) return NaN;

  const fraction = cleaned.match(
    /(-?\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)/,
  );
  if (fraction) {
    const num = parseFloat(fraction[1].replace(",", "."));
    const den = parseFloat(fraction[2].replace(",", "."));
    if (!isNaN(num) && !isNaN(den) && den > 0) {
      return (num / den) * 100;
    }
  }

  const single = cleaned.match(/-?\d+(?:[.,]\d+)?/);
  if (!single) return NaN;
  const value = parseFloat(single[0].replace(",", "."));
  if (isNaN(value)) return NaN;

  if (value <= 4) return (value / 4) * 100;
  if (value <= 5) return (value / 5) * 100;
  if (value <= 10) return (value / 10) * 100;
  if (value <= 20) return (value / 20) * 100;
  return value;
}

/**
 * Strict variant for document evidence. A score above 100 is only meaningful
 * when the source includes its denominator (for example 955/1200). This avoids
 * turning an OCR-extracted numerator into a fake 100%.
 */
export function normalizeGpaEvidenceTo100(
  raw: string | null | undefined,
): number {
  if (raw == null) return NaN;
  const cleaned = String(raw)
    .replace(/\([^)]*\)/g, "")
    .trim();
  if (!cleaned) return NaN;

  const hasExplicitScale = /-?\d+(?:[.,]\d+)?\s*\/\s*\d+(?:[.,]\d+)?/.test(
    cleaned,
  );
  const percentageMarked = cleaned.includes("%");
  const result = normalizeGpaTo100(cleaned);
  if (!Number.isFinite(result) || result < 0 || result > 100) return NaN;

  const single = cleaned.match(/-?\d+(?:[.,]\d+)?/);
  const rawValue = single ? Number(single[0].replace(",", ".")) : NaN;
  if (
    !hasExplicitScale &&
    !percentageMarked &&
    Number.isFinite(rawValue) &&
    rawValue > 100
  ) {
    return NaN;
  }
  return result;
}
