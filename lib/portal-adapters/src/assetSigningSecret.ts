// ---------------------------------------------------------------------------
// Shared signing-secret resolution for auth-free external-webhook asset URLs
// (student documents + student photo).
// ---------------------------------------------------------------------------
// Both documentSigning.ts and studentPhotoSigning.ts need the SAME secret
// precedence so a signature produced by one process (portal worker) always
// verifies on another (api-server) even when only a subset of these env vars
// is configured on a given deploy target.
//
// Precedence: ASSET_URL_SIGNING_SECRET (dedicated, preferred) → SESSION_SECRET
// → EMBED_TOKEN_SECRET (both already required elsewhere, so this never forces
// a NEW production env var — ASSET_URL_SIGNING_SECRET is an optional upgrade).
// Returns "" when none are configured; callers then skip signing entirely
// (documents/photo become best-effort-omitted, never a hard failure).
// ---------------------------------------------------------------------------
export function getAssetSigningSecret(): string {
  return (
    process.env.ASSET_URL_SIGNING_SECRET ||
    process.env.SESSION_SECRET ||
    process.env.EMBED_TOKEN_SECRET ||
    ""
  ).trim();
}
