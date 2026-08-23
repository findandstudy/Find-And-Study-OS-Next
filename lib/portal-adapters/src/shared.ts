/**
 * shared.ts — dependency-free primitives shared by the flat declarative engine
 * (dbLoader) and the richer spec engine (declarative/schema). Kept in its own
 * leaf module so both can import it WITHOUT creating an import cycle
 * (dbLoader ↔ specLoader ↔ interpreter ↔ schema).
 *
 * Contains: the canonical SubmitProfile/SubmitFiles field-name lists (kept in
 * lockstep with types.ts) and the SSRF URL guard mirrored from the api-server
 * subresource filter (https only; no loopback/private/link-local/metadata).
 */

// ---------------------------------------------------------------------------
// Field enums — kept in lockstep with SubmitProfile / SubmitFiles keys.
// A drift here means valid configs get rejected, so update these when the
// profile/file shapes change.
// ---------------------------------------------------------------------------

export const PROFILE_FIELDS = [
  "email", "passportNumber", "firstName", "lastName", "dateOfBirth", "gender",
  "fatherName", "motherName", "nationality", "address", "phone", "level",
  "programName", "programId", "universityName", "schoolName", "gpa",
  "graduationYear", "languageScore", "passportIssueDate", "passportExpiryDate",
  // Additive — Altınbaş Faz-B (do NOT reorder the 21 fields above)
  "cityOfBirth", "addressStreet", "addressCity", "addressZip",
  "phoneCountry", "eduDegree", "eduField",
  "eduStartMonth", "eduStartYear", "eduEndMonth", "eduEndYear",
  "eduGpaType", "visaSupport", "intakeTerm",
] as const;

export const FILE_FIELDS = ["photo", "passport", "transcript", "diploma"] as const;

// ---------------------------------------------------------------------------
// URL safety / SSRF — mirrors the api-server subresource guard
// (artifacts/api-server/src/lib/pdf/brandedBase.ts): require https + block
// loopback / private / link-local / metadata hosts.
// ---------------------------------------------------------------------------

/** True for an IPv4 dotted-quad that lives in a loopback/private/link-local range. */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const n = parts.map((p) => Number(p));
  if (n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  const [a, b] = n;
  if (a === 0) return true; //               0.0.0.0/8  (unspecified)
  if (a === 127) return true; //             127.0.0.0/8 (loopback)
  if (a === 10) return true; //              10.0.0.0/8 (private)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (private)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (private)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local + metadata)
  return false;
}

/**
 * Classify a URL hostname as private/loopback/link-local/metadata.
 * Handles bare hostnames, IPv4 (incl. the integer/hex forms the WHATWG URL
 * parser normalizes to dotted-quad), and IPv6 — including the bracketed forms
 * (`[::1]`, `[fd00::1]`, `[fe80::1]`) that a naive regex on `hostname` misses.
 */
function isPrivateHost(hostnameRaw: string): boolean {
  let host = hostnameRaw.trim().toLowerCase();
  if (!host) return true;

  // Strip IPv6 brackets and any zone id (e.g. fe80::1%eth0).
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const zone = host.indexOf("%");
  if (zone !== -1) host = host.slice(0, zone);

  if (host === "localhost" || host.endsWith(".localhost")) return true;

  if (host.includes(":")) {
    // IPv6.
    if (host === "::" || host === "::1") return true; // unspecified / loopback
    const firstHextet = host.split(":")[0];
    if (/^f[cd][0-9a-f]{0,2}$/.test(firstHextet)) return true; // fc00::/7  (ULA)
    if (/^fe[89ab][0-9a-f]?$/.test(firstHextet)) return true; // fe80::/10 (link-local)
    // IPv4-mapped / -embedded. The URL parser may serialize the trailing v4 as
    // dotted (::ffff:127.0.0.1) or as two hextets (::ffff:7f00:1); cover both.
    const dotted = host.match(/((?:\d{1,3}\.){3}\d{1,3})$/);
    if (dotted && isPrivateIPv4(dotted[1])) return true;
    const hexPair = host.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexPair) {
      const hi = parseInt(hexPair[1], 16);
      const lo = parseInt(hexPair[2], 16);
      const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      if (isPrivateIPv4(v4)) return true;
    }
    return false;
  }

  // IPv4 dotted-quad (the URL parser normalizes integer/hex forms to this).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isPrivateIPv4(host);

  return false;
}

/** True when `raw` is an https URL that does not target a private host. */
export function isSafePortalUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (isPrivateHost(u.hostname)) return false;
  return true;
}
