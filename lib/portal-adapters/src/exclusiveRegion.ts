/**
 * exclusiveRegion.ts — reactive exclusive-region detection.
 *
 * Some portals reject an application for restricted nationalities with a
 * message like "Exclusive bölge" or "... acenta/acente üzerinden başvurulmalı"
 * instead of saving it. This helper detects that signal in a response body so
 * an adapter can return a structured `exclusiveRegion` result rather than a
 * generic failure. Pure + case-insensitive.
 *
 * This is the reactive safety net. The primary, preventive path lives in the
 * runner (portal_university_exclusions lookup before the portal is ever run).
 */
export function detectExclusiveRegion(body: string | null | undefined): boolean {
  if (!body) return false;
  const lc = body.toLowerCase();
  return (
    lc.includes("exclusive") ||
    lc.includes("acenta üzerinden") ||
    lc.includes("acente üzerinden")
  );
}
