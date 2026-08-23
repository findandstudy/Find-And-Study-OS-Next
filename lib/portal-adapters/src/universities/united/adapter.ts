import type {
  UniversityAdapter,
  AdapterSession,
  SubmitProfile,
  SubmitFiles,
  SubmitResult,
  LoginOpts,
  PortalProgramOption,
} from "../../types.js";
import { launchPortal, logger } from "../../browser.js";
import { portalCreds } from "../../portalCreds.js";
import { fold, matchProgram } from "../../programMatch.js";

// ---------------------------------------------------------------------------
// United portal allowlist — EXACTLY 3 universities (do not add/remove)
// Credentials: UNITED_USER + UNITED_PASSWORD (or inject via opts.credentials
// which the worker resolves from the DB-backed portal_credentials table).
//
// United = Salesforce-backed, ASP.NET MVC + KT Stepper multi-step wizard on
// partner.unitededucation.com/Manage/newapplication (NOT a single webhook like
// SIT). The create is multi-step + stateful, so this adapter drives the UI and
// — on the first LIVE submission — instruments the page network to capture the
// real final `POST /Manage/newapplication` body (token-redacted) so a Phase-2
// HTTP replay can be written later.
// ---------------------------------------------------------------------------
export const UNITED_ALLOWLIST: readonly string[] = [
  "Biruni Üniversitesi",
  "Nişantaşı Üniversitesi",
  "Ankara Bilim Üniversitesi",
] as const;

/** Pre-folded entries for fast matches() lookup. */
const UNITED_ALLOWLIST_FOLDED: readonly string[] = UNITED_ALLOWLIST.map(fold);

/** True when `name` is one of the 3 United member universities. Resilient to
 * EN↔TR naming: `fold` only does Turkish→ASCII + lowercase, so English
 * "Istanbul Nisantasi University" never substring-matched Turkish "Nişantaşı
 * Üniversitesi" (word diff + extra "istanbul"). We additionally strip
 * institution/city stopwords and compare on the distinctive core tokens.
 * @param dynamicList  Live DB "Members" list (portal_account_universities,
 *   panel-managed) supplied by the runner for this submission. UNION'd with
 *   UNITED_ALLOWLIST — never removes a member the static list already grants.
 *   Undefined (e.g. direct adapter calls outside runSubmission, or dev CLI
 *   `matches()`) falls back to checking the static list alone.
 */
function isUnitedMember(
  name: string | undefined | null,
  dynamicList?: readonly string[],
): boolean {
  if (/^united\s+education$/i.test(String(name ?? "").trim())) return true;
  const strip = (s: string) =>
    fold(String(s || ""))
      .replace(/\b(university|universitesi|universite|univ|istanbul|the|of)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const f = strip(name ?? "");
  if (!f) return false;
  const fTokens = new Set(f.split(" ").filter((t) => t.length > 1));
  const matches = (list: readonly string[]) =>
    list.some((entry) => {
      const e = strip(entry);
      if (!e) return false;
      // Only name-contains-entry (NOT the reverse): the reverse would let a single
      // token like "ankara" (from non-member "Ankara University") match the entry
      // "ankara bilim" — a false positive. Multi-token entries need ALL tokens.
      if (f.includes(e)) return true;
      // token-subset: member if ALL distinctive tokens of the entry appear in the name
      const eTokens = e.split(" ").filter((t) => t.length > 1);
      return eTokens.length > 0 && eTokens.every((t) => fTokens.has(t));
    });
  if (matches(UNITED_ALLOWLIST)) return true;
  return dynamicList !== undefined && dynamicList.length > 0 && matches(dynamicList);
}

const PORTAL_URL = "https://partner.unitededucation.com";

// Endpoints whose requests we mirror to the log during a live submission so the
// first real run reveals the exact create contract (field names + Salesforce
// contactid/programid/appid) for a future Phase-2 HTTP replay.
const NETLOG_URL_RE =
  /\/Manage\/(newapplication|uploadfilesone(?:tek)?|selectprogram|Degreelist|test1)|\/Account\/searchapp/i;

/** Redact the ASP.NET MVC anti-forgery token out of a captured request body. */
function redactToken(body: string): string {
  if (!body) return body;
  return body
    // form-urlencoded: __RequestVerificationToken=....(&|end)
    .replace(/(__RequestVerificationToken=)[^&]*/gi, "$1<redacted>")
    // JSON: "__RequestVerificationToken":"...."
    .replace(/("__RequestVerificationToken"\s*:\s*")[^"]*"/gi, '$1<redacted>"');
}

// Body-capture redaction. The instrumentation exists to reveal the create
// CONTRACT — i.e. every field NAME plus the structural Salesforce ids
// (contactid/programid/appid + the cascade select ids) needed to write a
// Phase-2 HTTP replay. It must NEVER leak applicant PII values, so we log all
// keys but redact VALUES by default (default-deny), showing values only for a
// safe allowlist of structural/id fields and always redacting known-PII keys.
const SAFE_VALUE_KEY =
  /(^|_)id$|^select(university|program|degree|lang|campus)$|^(regtype|country|destination|degree|program|lang|campus)$|^university/i;
const PII_KEY =
  /(name|passport|kimlik|phone|mail|address|birth|dob|dateinput|school|father|mother|national|tckn)/i;

/** Sanitize a captured request body: keys kept, PII values redacted, token redacted. */
function sanitizeBody(raw: string): string {
  if (!raw) return raw;
  const body = redactToken(raw);
  const keepValue = (key: string): boolean => {
    const k = key.trim();
    if (/token/i.test(k)) return true; // already redacted by redactToken
    return SAFE_VALUE_KEY.test(k) && !PII_KEY.test(k);
  };
  // form-urlencoded (the ASP.NET MVC create POST): k1=v1&k2=v2...
  if (/^[^{[]*=/.test(body)) {
    return body
      .split("&")
      .map((pair) => {
        const eq = pair.indexOf("=");
        if (eq < 0) return pair;
        const rawKey = pair.slice(0, eq);
        let decoded = rawKey;
        try { decoded = decodeURIComponent(rawKey); } catch {}
        return keepValue(decoded) ? pair : rawKey + "=<redacted>";
      })
      .join("&")
      .slice(0, 4000);
  }
  // JSON body — redact string values of non-allowlisted keys recursively.
  try {
    const walk = (o: any): any => {
      if (o && typeof o === "object") {
        for (const key of Object.keys(o)) {
          if (o[key] && typeof o[key] === "object") walk(o[key]);
          else if (!keepValue(key)) o[key] = "<redacted>";
        }
      }
      return o;
    };
    return JSON.stringify(walk(JSON.parse(body))).slice(0, 4000);
  } catch {
    // Unknown format — do not risk logging raw PII.
    return "<unparsed body redacted>";
  }
}

// ---------------------------------------------------------------------------
// Flexible option matching (fixes programMissing false-positives)
//
// United's select2 <option> labels carry parenthetical qualifiers the CRM name
// omits, e.g. "Computer Engineering (Non-Thesis) (Turkish)". A strict
// text.includes(programName) then never matches. normLabel() drops the
// parentheticals and Turkish-folds; looseMatchIndex() then tries, in order:
// (a) normalized substring (either direction for longer strings), then
// (b) token overlap ≥ 60%. It NEVER guesses when nothing clears the bar.
// ---------------------------------------------------------------------------
function normLabel(s: string): string {
  return fold(
    String(s || "")
      .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/\([^)]*\)/g, " "),
  );
}

function looseMatchIndex(optTexts: string[], want: string): number {
  const w = normLabel(want);
  if (!w) return -1;
  const N = optTexts.map(normLabel);
  // (a) normalized substring — direct, and reverse for longer strings.
  let idx = N.findIndex((o) => o && (o.includes(w) || (w.length > 4 && o.length > 4 && w.includes(o))));
  if (idx >= 0) return idx;
  // (b) token overlap ≥ 60% of the wanted tokens.
  const wt = new Set(w.split(" ").filter((x) => x.length > 2));
  if (wt.size === 0) return -1;
  let best = -1, bestScore = 0;
  N.forEach((o, i) => {
    const ot = o.split(" ").filter((x) => x.length > 2);
    const hit = ot.filter((x) => wt.has(x)).length;
    const sc = hit / wt.size;
    if (sc > bestScore) { bestScore = sc; best = i; }
  });
  return bestScore >= 0.6 ? best : -1;
}

// Selects whose value MUST be an intentional match — never auto-pick the first
// option (would submit the wrong university/program/degree/language). A critical
// select with exactly one real option is still auto-selected (forced, unambiguous).
const CRITICAL_SELECT_IDS = new Set(["selectuniversity", "selectprogram", "selectdegree", "selectlang"]);

/** Map CRM levels to the exact degree-card values observed in United. */
export function resolveUnitedDegreeLabel(level: string): string | null {
  const value = fold(level);
  if (/\b(associate|onlisans|vocational)\b/.test(value)) return "Vocational School";
  if (/\b(bachelor|lisans|undergraduate)\b/.test(value)) return "Bachelor";
  if (/\b(master|masters|yukseklisans|graduate)\b/.test(value)) return "Master";
  if (/\b(phd|doctorate|doctoral|doktora)\b/.test(value)) return "PhD";
  return null;
}

export function resolveUnitedDocumentSlots(level: string): {
  diploma: string[];
  transcript: string[];
} | null {
  const degree = resolveUnitedDegreeLabel(level);
  if (degree === "Vocational School" || degree === "Bachelor") {
    return { diploma: ["cer"], transcript: ["trans"] };
  }
  if (degree === "Master") {
    return { diploma: ["cerb"], transcript: ["transb"] };
  }
  if (degree === "PhD") {
    return { diploma: ["cerp"], transcript: ["transp"] };
  }
  return null;
}

const UNITED_UNIVERSITY_ALIASES: ReadonlyArray<{
  aliases: readonly string[];
  portal: string;
}> = [
  {
    aliases: [
      "Ankara Bilim University",
      "Ankara Bilim Üniversitesi",
      "Ankara Science University",
    ],
    portal: "Ankara Science University",
  },
  {
    aliases: [
      "Nişantaşı Üniversitesi",
      "Nisantasi University",
      "Istanbul Nisantasi University",
    ],
    portal: "Nisantasi University",
  },
  {
    aliases: ["Biruni Üniversitesi", "Biruni University"],
    portal: "Biruni University",
  },
];

function normalizeUnitedUniversity(value: string): string {
  return fold(
    String(value || "").replace(
      /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
      "",
    ),
  )
    .replace(
      /\b(university|universitesi|universite|istanbul|the|of)\b/g,
      " ",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Resolve CRM university aliases to the exact labels shown by United. */
export function resolveUnitedUniversityLabel(name: string): string | null {
  const normalized = normalizeUnitedUniversity(name);
  if (!normalized) return null;
  for (const entry of UNITED_UNIVERSITY_ALIASES) {
    if (
      entry.aliases.some(
        (alias) => normalizeUnitedUniversity(alias) === normalized,
      )
    ) {
      return entry.portal;
    }
  }
  return String(name || "").trim() || null;
}

/** Resolve one and only one live United university option. Never guesses. */
export function resolveUnitedUniversityOption(
  optionTexts: readonly string[],
  requestedUniversity: string,
): string | null {
  const requestedPortalLabel = resolveUnitedUniversityLabel(requestedUniversity);
  if (!requestedPortalLabel) return null;
  const expected = normalizeUnitedUniversity(requestedPortalLabel);
  const matches = optionTexts.filter(
    (option) => normalizeUnitedUniversity(option) === expected,
  );
  return matches.length === 1 ? matches[0] : null;
}

/**
 * The legacy /Account/searchapp endpoint is eventually consistent and has
 * returned zero for profiles already visible in My Students. Exact-email
 * profile rows are therefore the authoritative dedup signal. A positive
 * searchapp count without an exact-email row remains unknown/fail-closed.
 */
export function resolveUnitedProfileLookupAction(
  searchCount: number,
  exactEmailProfileCount: number,
): "inspect" | "new" | "unknown" {
  if (exactEmailProfileCount > 0) return "inspect";
  return searchCount > 0 ? "unknown" : "new";
}

/**
 * Selecting a university does not hide every unrelated pagination/staging
 * card in the current United build. It is enough to prove that at least one
 * visible card belongs to the exact selected university; the subsequent
 * university+programme+degree card proof is still unique and fail-closed.
 */
export function hasExactUnitedUniversityCard(
  visibleUniversityLabels: readonly string[],
  expectedUniversity: string,
): boolean {
  const expected = normalizeUnitedUniversity(expectedUniversity);
  return (
    !!expected &&
    visibleUniversityLabels.some(
      (label) => normalizeUnitedUniversity(label) === expected,
    )
  );
}

function normalizeUnitedProgram(value: string): string {
  return fold(
    String(value || "").replace(
      /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
      "",
    ),
  )
    .replace(
      /^\s*(associate|bachelor|master|masters|phd|doctorate)\s+(degree\s+)?(of|in)\s+/,
      "",
    )
    .replace(
      /\s+\b(vocational school|associate|bachelor|master|phd|doctorate)\b\s*$/,
      "",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Resolve the CRM programme to one unique live United option. */
export function resolveUnitedProgramOption(
  optionTexts: readonly string[],
  requestedProgram: string,
): string | null {
  const expected = normalizeUnitedProgram(requestedProgram);
  if (!expected) return null;
  const matches = optionTexts.filter(
    (option) => normalizeUnitedProgram(option) === expected,
  );
  return matches.length === 1 ? matches[0] : null;
}

export interface UnitedApplicationIdentity {
  href: string;
  ref: string;
  program: string;
  university: string;
  profileHref?: string;
}

/** Exact server-side target proof used for both dedup and post-create checks. */
export function findUniqueUnitedTargetApplication(
  applications: readonly UnitedApplicationIdentity[],
  requestedUniversity: string,
  requestedProgram: string,
): UnitedApplicationIdentity | null {
  const expectedUniversity = normalizeUnitedUniversity(
    resolveUnitedUniversityLabel(requestedUniversity) || "",
  );
  const expectedProgram = normalizeUnitedProgram(requestedProgram);
  if (!expectedUniversity || !expectedProgram) return null;
  const matches = applications.filter(
    (application) =>
      normalizeUnitedUniversity(
        resolveUnitedUniversityLabel(application.university) || "",
      ) === expectedUniversity &&
      normalizeUnitedProgram(application.program) === expectedProgram,
  );
  return matches.length === 1 ? matches[0] : null;
}

export function resolveUnitedProfileDocumentKeys(level: string): {
  diploma: string;
  transcript: string;
} | null {
  const degree = resolveUnitedDegreeLabel(level);
  if (degree === "Vocational School" || degree === "Bachelor") {
    return {
      diploma: "HighSchoolDiploma",
      transcript: "HighSchoolTranscript",
    };
  }
  if (degree === "Master") {
    return {
      diploma: "Bachelor'sDiploma",
      transcript: "Bachelor'sTranscript",
    };
  }
  if (degree === "PhD") {
    return {
      diploma: "Master'sDiploma",
      transcript: "Master'sTranscript",
    };
  }
  return null;
}

/** Extract the final document key from United's uploadfile(...) onclick. */
export function parseUnitedProfileUploadKey(onclick: string): string | null {
  const match = String(onclick || "").match(
    /,\s*'((?:\\'|[^'])*)'\s*\)\s*;?\s*$/,
  );
  return match ? match[1].replace(/\\'/g, "'") : null;
}

function unitedApplicationIdFromHref(href: string): string | null {
  const match = String(href || "").match(
    /\/Manage\/applicationdetails\/([0-9A-Za-z_-]+)/i,
  );
  return match?.[1] || null;
}

/**
 * Resolve a duplicate exact-email student to one profile using the external
 * application reference already persisted for this same submission.
 *
 * The previous application may be the wrong university/program (the repair
 * case), so this proves only which duplicate profile owns the prior write. It
 * never proves target success and never chooses a profile when the reference
 * is absent or ambiguous.
 */
export function findUnitedProfileHrefByExternalRef(
  applications: readonly UnitedApplicationIdentity[],
  externalRef: string | undefined,
): string | null {
  const wanted = String(externalRef || "").trim().toLowerCase();
  if (!wanted) return null;
  const matchingProfiles = [
    ...new Set(
      applications
        .filter((application) => {
          const hrefId = unitedApplicationIdFromHref(application.href);
          return (
            String(hrefId || "").toLowerCase() === wanted ||
            String(application.ref || "").trim().toLowerCase() === wanted
          );
        })
        .map((application) => application.profileHref || "")
        .filter(Boolean),
    ),
  ];
  return matchingProfiles.length === 1 ? matchingProfiles[0] : null;
}

export const unitedAdapter: UniversityAdapter = {
  key:       "united",
  label:     "United Portal",
  allowlist: [...UNITED_ALLOWLIST],

  matches(name: string): boolean {
    return isUnitedMember(name);
  },

  async login(opts?: LoginOpts): Promise<AdapterSession> {
    // ---- Pre-flight: resolve creds + log SOURCE ONLY (never the value) ------
    let user = "";
    let password = "";
    let source = "MISSING";
    if (opts?.credentials?.user && opts?.credentials?.password) {
      user = opts.credentials.user;
      password = opts.credentials.password;
      source = "opts/db"; // worker-injected from DB portal_credentials
    } else {
      // portalCreds() reads UNITED_EMAIL / UNITED_USER + UNITED_PASSWORD env.
      try {
        const env = portalCreds("united");
        user = env.user;
        password = env.password;
        source = "env";
      } catch {
        source = "MISSING";
      }
    }
    logger.info(`[united] creds: ${source}`);
    if (!user || !password) {
      throw new Error(
        "[united] MISSING credentials — set UNITED_USER/UNITED_PASSWORD or portal_credentials row",
      );
    }

    const session = await launchPortal({ headless: opts?.headless ?? true });
    logger.info("[united] login — navigating to portal");

    const page: any = session.page;
    try {
      await page.goto(PORTAL_URL + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(3500);
      await page.locator("input[name*=user i], input[placeholder*=user i], input[id*=user i], input[type=text]").first().fill(user);
      await page.locator("input[type=password]").first().fill(password);
      await page.getByRole("button", { name: /sign ?in|log ?in|giris/i }).first().click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(6000);
      if (await page.locator("input[type=password]").first().isVisible().catch(() => false)) throw new Error("[united] login failed - wrong creds or captcha");
      logger.info("[united] login successful -> " + page.url());
    } catch (err) { await session.close().catch(() => {}); throw err; }
    return session;
  },

  async submit(
    session: AdapterSession,
    profile: SubmitProfile,
    _files: SubmitFiles,
    doSubmit?: boolean,
  ): Promise<SubmitResult> {
    logger.info("[united] submit — program:", profile.programName, "| university:", profile.universityName);
    const page: any = session.page;
    // Dry boundary: EITHER the runner passing doSubmit=false OR PORTAL_DRYRUN=1.
    const dryRun = doSubmit === false || process.env.PORTAL_DRYRUN === "1";
    const result: any = { alreadyExists: false, submitted: false, programMissing: false };
    const wait = (ms: number) => page.waitForTimeout(ms);
    const missingProfile = [
      ["firstName", profile.firstName],
      ["lastName", profile.lastName],
      ["passportNumber", profile.passportNumber],
      ["email", profile.email],
      ["dateOfBirth", profile.dateOfBirth],
      ["gender", profile.gender],
      ["fatherName", profile.fatherName],
      ["motherName", profile.motherName],
      ["nationality", profile.nationality],
      ["phone", profile.phone],
      ["level", profile.level],
      ["programName", profile.programName],
      ["universityName", profile.universityName],
      ["schoolName", profile.schoolName],
    ]
      .filter(([, value]) => value == null || String(value).trim() === "")
      .map(([field]) => String(field));
    const resolvedDegree = resolveUnitedDegreeLabel(profile.level);
    const documentSlots = resolveUnitedDocumentSlots(profile.level);
    const profileDocumentKeys = resolveUnitedProfileDocumentKeys(profile.level);
    const resolvedPortalUniversity = resolveUnitedUniversityLabel(
      profile.universityName || "",
    );
    if (!resolvedDegree) missingProfile.push("level(unmapped)");
    if (!documentSlots) missingProfile.push("documentSlots(unmapped)");
    if (!profileDocumentKeys) {
      missingProfile.push("profileDocumentKeys(unmapped)");
    }
    if (!resolvedPortalUniversity) {
      missingProfile.push("universityName(unmapped)");
    }
    if (missingProfile.length > 0) {
      throw new Error(
        `United data_missing: ${missingProfile.join(", ")}`,
      );
    }
    if (
      !dryRun &&
      (!_files.passport || !_files.diploma || !_files.transcript)
    ) {
      const missingDocuments = (
        ["passport", "diploma", "transcript"] as const
      ).filter((slot) => !_files[slot]);
      return {
        submitted: false,
        alreadyExists: false,
        programMissing: false,
        missingDocuments,
        detail:
          "United: passport, diploma and transcript are required before application creation",
      };
    }

    // ---- §0 Member gate: never push a non-member university into United ------
    // profile.memberUniversities is the LIVE DB "Members" list (panel-managed,
    // portal_account_universities) loaded by the runner for this submission's
    // routed aggregator — a university added there is recognized immediately,
    // no code change needed. UNION'd with the static UNITED_ALLOWLIST inside
    // isUnitedMember for resilience to a transient DB read failure.
    if (!isUnitedMember(profile.universityName, profile.memberUniversities)) {
      logger.warn(
        `[united] SKIP — "${profile.universityName || "(none)"}" is not a United member ` +
        `(allowlist: ${UNITED_ALLOWLIST.join(" / ")}` +
        (profile.memberUniversities?.length ? ` + DB members: ${profile.memberUniversities.join(" / ")}` : "") +
        `); routing to direct`,
      );
      result.skippedNotMember = true;
      result.routeTo = "direct";
      result.detail = "university not in United allowlist";
      return result;
    }

    // ---- §1 Instrumentation: capture the REAL create contract (redacted) ----
    // Attach BEFORE any navigation/submit so the final POST /Manage/newapplication
    // body (all field names + Salesforce ids) lands in the logs for Phase-2 replay.
    const netlog: Array<{ url: string; method: string; status: string; post: string }> = [];
    const onFinished = async (req: any) => {
      try {
        const url = String(req.url());
        if (!NETLOG_URL_RE.test(url)) return;
        const method = req.method();
        let post = "";
        if (method === "POST") { try { post = sanitizeBody((req.postData() || "").slice(0, 4000)); } catch {} }
        let status = ""; try { const res = await req.response(); status = res ? String(res.status()) : ""; } catch {}
        const shortUrl = url.split("?")[0];
        netlog.push({ url: shortUrl, method, status, post });
        logger.info(`[united][net] ${method} ${shortUrl} -> ${status}` + (post ? ` body=${post}` : ""));
      } catch {}
    };
    page.on("requestfinished", onFinished);

    // Select a native/select2 <select> by id. Waits for the option list to
    // populate (AJAX cascade), LOGS the option texts (first-run reality check),
    // and flexibly matches `want` (see looseMatchIndex). Fires change + select2
    // jQuery trigger so the next cascade step fetches. Returns true only when
    // `want` matched. For CRITICAL_SELECT_IDS it never auto-picks the first
    // option on a miss (would submit the wrong value) — only a lone real option.
    const selById = async (id: string, want?: string): Promise<boolean> => {
      try {
        const loc = page.locator("#" + id);
        if (!(await loc.count())) return false;
        // Wait for AJAX-populated options before matching (cascade).
        await page
          .waitForFunction((sid: string) => {
            const el = document.getElementById(sid) as any;
            return !!el && el.options && el.options.length > 0;
          }, id, { timeout: 12000 })
          .catch(() => {});
        const opts = (await loc.locator("option").allInnerTexts().catch(() => [])) as string[];
        logger.info(`[united] ${id} options(${opts.length}): ` + JSON.stringify(opts.slice(0, 40)));
        const isReal = (o: string) => !!o.trim() && !/^(please\s+)?(select|se\u00e7)/i.test(o.trim());
        const w = String(want || "").trim();
        let idx = -1, matched = false;
        if (w) { idx = looseMatchIndex(opts, w); if (idx >= 0) matched = true; }
        // No explicit target (e.g. selectlang/selectcampus): the cascade usually
        // pre-selects the program-derived value — respect it rather than guess or
        // stall. Keeps critical selectlang from blocking the Program→Personal step.
        if (idx < 0 && !w) {
          const sel = (await loc.evaluate((el: any) => el.selectedIndex).catch(() => -1)) as number;
          if (typeof sel === "number" && sel >= 0 && isReal(opts[sel] || "")) idx = sel;
        }
        if (idx < 0) {
          const realIdx = opts.map((o, i) => (isReal(o) ? i : -1)).filter((i) => i >= 0);
          if (!CRITICAL_SELECT_IDS.has(id)) idx = realIdx.length ? realIdx[0] : -1; // optional: first real
          else if (realIdx.length === 1) idx = realIdx[0];                          // critical + lone real: forced
          // critical + multiple options + no target/match → leave unselected
        }
        if (idx >= 0) {
          await page.evaluate(([sid, i]: [string, number]) => {
            const el: any = document.getElementById(sid);
            if (!el) return;
            el.selectedIndex = i;
            el.dispatchEvent(new Event("change", { bubbles: true }));
            const jq = (window as any).jQuery;
            if (jq) jq(el).trigger("change"); // select2
          }, [id, idx]);
          await wait(1200); // cascade AJAX
          logger.info(`[united] select ${id} -> index ${idx} "${opts[idx]}"${matched ? " (matched)" : " (fallback)"}`);
        } else {
          logger.warn(`[united] select ${id}: no match for "${w}" (left unselected)`);
        }
        return matched;
      } catch (e) { return false; }
    };
    // Scan all selects, pick the one with an option matching `re`, select it.
    const selByOpt = async (re: RegExp): Promise<boolean> => {
      try {
        const sels = page.locator("select");
        const n = await sels.count();
        for (let i = 0; i < n; i++) {
          const sl = sels.nth(i);
          const opts = (await sl.locator("option").allInnerTexts().catch(() => [])) as string[];
          const idx = opts.findIndex((o) => re.test(o));
          if (idx >= 0) { await sl.selectOption({ index: idx }).catch(() => {}); await wait(800); return true; }
        }
      } catch (e) {}
      return false;
    };
    // Read every <option> {value,text} of a select (for logging + matchProgram).
    const readOptions = async (id: string): Promise<Array<{ value: string; text: string }>> => {
      try {
        return (await page.$$eval(`#${id} option`, (opts: any[]) =>
          opts.map((o) => ({ value: String(o.value || ""), text: String(o.textContent || "").replace(/\s+/g, " ").trim() })),
        )) as Array<{ value: string; text: string }>;
      } catch { return []; }
    };
    // esbuild/tsx wraps named functions passed to page.evaluate with __name(fn, "…");
    // that helper is NOT defined in the browser context, so any evaluate containing a
    // named inner arrow throws "__name is not defined". Shim it in the page context.
    // The KT-Stepper swaps steps client-side (no reload), so once is usually enough,
    // but we re-assert after each Continue in case a step remount clears globals.
    const ensureNameShim = async () => {
      try { await page.evaluate(() => { (globalThis as any).__name = (globalThis as any).__name || ((f: any) => f); }); } catch {}
    };

    let profileDocumentControlsReady: boolean | undefined;
    const findProfileDocumentTarget = async (
      documentKey: string,
    ): Promise<{ index: number; state: string } | null> => {
      // Student profile details render after the surrounding page shell. Do
      // not classify all slots as missing during that short hydration window.
      if (profileDocumentControlsReady === undefined) {
        profileDocumentControlsReady = await page
          .waitForSelector('button[onclick*="uploadfile("]', {
            state: "attached",
            timeout: 15000,
          })
          .then(() => true)
          .catch(() => false);
        const controlCount = await page
          .locator('button[onclick*="uploadfile("]')
          .count()
          .catch(() => 0);
        logger.info(
          `[united] profile document controls ready=${profileDocumentControlsReady} count=${controlCount}`,
        );
      }
      if (!profileDocumentControlsReady) return null;
      const targets = (await page
        .locator('button[onclick*="uploadfile("]')
        .evaluateAll((buttons: Element[], wantedKey: string) => {
          return buttons
            .map((button, index) => {
              // Keep the parser inline: esbuild names locally-declared
              // functions with __name(), which does not exist after a fresh
              // profile navigation inside Playwright's browser context.
              const match = String(
                button.getAttribute("onclick") || "",
              ).match(/,\s*'((?:\\'|[^'])*)'\s*\)\s*;?\s*$/);
              return {
                index,
                key: match ? match[1].replace(/\\'/g, "'") : null,
                state: (button.parentElement?.textContent || "")
                  .replace(/\s+/g, " ")
                  .trim(),
              };
            })
            .filter((entry) => entry.key === wantedKey);
        }, documentKey)
        .catch(() => [])) as Array<{
        index: number;
        key: string;
        state: string;
      }>;
      return targets.length === 1
        ? { index: targets[0].index, state: targets[0].state }
        : null;
    };
    const isUploadedState = (state: string) =>
      /\buploaded\b/i.test(state) && !/\bnot uploaded\b/i.test(state);
    const uploadProfileDocument = async (
      documentKey: string,
      localPath?: string,
    ): Promise<boolean> => {
      let target = await findProfileDocumentTarget(documentKey);
      if (!target) {
        logger.warn(
          `[united] profile document target ${documentKey} is missing or ambiguous`,
        );
        return false;
      }
      if (isUploadedState(target.state)) {
        logger.info(
          `[united] profile document ${documentKey} already uploaded — repair skipped`,
        );
        return true;
      }
      if (dryRun) return false;
      if (!localPath) {
        logger.warn(`[united] no local file for profile slot ${documentKey}`);
        return false;
      }
      try {
        const uploadButtons = page.locator('button[onclick*="uploadfile("]');
        await uploadButtons.nth(target.index).click({ timeout: 8000 });
        await page
          .waitForFunction(
            (wantedKey: string) =>
              Array.from(document.querySelectorAll<HTMLInputElement>(
                'input[type="file"]',
              )).some((input) => input.id === wantedKey),
            documentKey,
            { timeout: 8000 },
          )
          .catch(() => {});
        const fileInputs = page.locator('input[type="file"]');
        const inputIds = (await fileInputs
          .evaluateAll((inputs: HTMLInputElement[]) =>
            inputs.map((input) => input.id),
          )
          .catch(() => [])) as string[];
        const fileInputIndex = inputIds.findIndex(
          (inputId) => inputId === documentKey,
        );
        if (fileInputIndex < 0) {
          logger.warn(
            `[united] modal file input ${documentKey} was not uniquely exposed`,
          );
          return false;
        }
        const responsePromise = page
          .waitForResponse(
            (response: any) =>
              /\/Manage\/uploadfilesonetek(?:[/?]|$)/i.test(response.url()) &&
              response.request().method() === "POST",
            { timeout: 30000 },
          )
          .catch(() => null);
        await fileInputs.nth(fileInputIndex).setInputFiles(localPath);
        const uploadResponse = await responsePromise;
        if (!uploadResponse || !uploadResponse.ok()) {
          logger.warn(
            `[united] profile upload ${documentKey} lacked a proved 2xx response`,
          );
          return false;
        }
        let responseOk = false;
        try {
          const payload = await uploadResponse.json();
          responseOk = String(payload?.msg || "").toLowerCase() === "ok";
        } catch {}
        if (!responseOk) {
          logger.warn(
            `[united] profile upload ${documentKey} returned 2xx without msg=ok`,
          );
          return false;
        }
        await page
          .waitForURL(/\/Manage\/studentprofile\//i, { timeout: 12000 })
          .catch(() => {});
        await wait(1000);
        profileDocumentControlsReady = undefined;
        target = await findProfileDocumentTarget(documentKey);
        if (!target || !isUploadedState(target.state)) {
          logger.warn(
            `[united] profile upload ${documentKey} passed network proof but failed exact row readback`,
          );
          return false;
        }
        logger.info(
          `[united] uploaded ${documentKey} with msg=ok + exact profile-row readback`,
        );
        return true;
      } catch (e: any) {
        logger.warn(
          `[united] profile upload ${documentKey} failed: ${String(
            e?.message || e,
          ).slice(0, 140)}`,
        );
        return false;
      }
    };
    const uploadRequiredDocuments = async (): Promise<string[]> => {
      const uploadedSlots: string[] = [];
      if (await uploadProfileDocument("Photograph", _files.photo)) {
        uploadedSlots.push("photo");
      }
      if (await uploadProfileDocument("Passport", _files.passport)) {
        uploadedSlots.push("passport");
      }
      if (
        await uploadProfileDocument(
          profileDocumentKeys!.diploma,
          _files.diploma,
        )
      ) {
        uploadedSlots.push("diploma");
      }
      if (
        await uploadProfileDocument(
          profileDocumentKeys!.transcript,
          _files.transcript,
        )
      ) {
        uploadedSlots.push("transcript");
      }
      return uploadedSlots;
    };
    const clickContinue = async (): Promise<boolean> => {
      let b = page.getByRole("button", { name: /continue|next|ileri|devam/i }).first();
      if (await b.count()) { await b.click({ timeout: 8000 }).catch(() => {}); await wait(2800); await ensureNameShim(); return true; }
      b = page.locator("button:has-text('Continue'), a:has-text('Continue'), input[value*='Continue' i]").first();
      if (await b.count()) { await b.click({ timeout: 8000 }).catch(() => {}); await wait(2800); await ensureNameShim(); return true; }
      return false;
    };

    try {
      await page.goto(PORTAL_URL + "/Manage/newapplication", { waitUntil: "domcontentloaded", timeout: 60000 });
      await wait(5000);
      await ensureNameShim();
      const txt0 = (await page.evaluate("(()=>document.body?document.body.innerText:'')()")) as string;
      if (/already.*application|zaten.*basvuru/i.test(txt0)) {
        logger.warn("[united] generic already-application banner observed; target-specific dedup will decide");
      }

      // ---- §3 Dedup: GET /Account/searchapp?word=<email|name> --------------
      // Salesforce-backed search. Log ONLY the count + Id (never PII values).
      const searchWord = (profile.email || `${profile.firstName || ""} ${profile.lastName || ""}`).trim();
      // Reusable: returns {count, id} from /Account/searchapp (logs count+Id only, never PII).
      const searchApp = async (tag: string): Promise<{ count: number; ids: string[] }> => {
        if (!searchWord) return { count: 0, ids: [] };
        const res = await page.request.get(
          `${PORTAL_URL}/Account/searchapp?word=${encodeURIComponent(searchWord)}`,
          { timeout: 20000 },
        );
        const status = res.status();
        let json: any = null;
        try { json = await res.json(); } catch {}
        const count = typeof json?.totalSize === "number" ? json.totalSize : (Array.isArray(json?.records) ? json.records.length : 0);
        const records = Array.isArray(json?.records) ? json.records : [];
        const ids = [
          ...new Set(
            records
              .map((rec: any) =>
                String(
                  rec?.AccountId ||
                    rec?.Account?.Id ||
                    rec?.StudentAccountId ||
                    rec?.Student_Account__c ||
                    "",
                ),
              )
              .filter((id: string) => /^001[0-9A-Za-z]{12,}$/.test(id)),
          ),
        ] as string[];
        logger.info(
          `[united] ${tag} searchapp -> status=${status} count=${count} accountIds=${ids.length}`,
        );
        return { count, ids };
      };
      const getExactEmailProfileHrefs = async (): Promise<string[]> => {
        await page.goto(PORTAL_URL + "/Manage/mystudents", {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await wait(2500);
        const emailFilter = page
          .locator('input[placeholder="Email"], input[aria-label="Email"]')
          .first();
        if (await emailFilter.count()) {
          await emailFilter.fill(profile.email);
          await wait(1800);
        }
        return (await page
          .$$eval(
            "a[href*='/Manage/studentprofile/']",
            (links: HTMLAnchorElement[], email: string) => [
              ...new Set(
                links
                  .filter((anchor) =>
                    (anchor.closest("tr")?.innerText || "")
                      .toLowerCase()
                      .includes(email.toLowerCase()),
                  )
                  .map((anchor) => anchor.getAttribute("href") || "")
                  .filter(Boolean),
              ),
            ],
            profile.email,
          )
          .catch(() => [])) as string[];
      };
      const inspectProfiles = async (
        profileHrefs: string[],
      ): Promise<{
        applications: UnitedApplicationIdentity[];
        createHrefs: string[];
        createTargets: Array<{
          profileHref: string;
          createHref: string;
        }>;
      }> => {
        const applications: UnitedApplicationIdentity[] = [];
        const createHrefs: string[] = [];
        const createTargets: Array<{
          profileHref: string;
          createHref: string;
        }> = [];
        for (const profileHref of profileHrefs) {
          await page.goto(new URL(profileHref, PORTAL_URL).href, {
            waitUntil: "domcontentloaded",
            timeout: 60000,
          });
          await wait(1000);
          const createHref = await page
            .locator("a[href*='/Manage/newapplication?contactid=']")
            .first()
            .getAttribute("href")
            .catch(() => null);
          if (createHref) {
            createHrefs.push(createHref);
            createTargets.push({ profileHref, createHref });
          }
          const rows = (await page
            .$$eval(
              "a[href*='/Manage/applicationdetails/']",
              (links: HTMLAnchorElement[]) =>
                links.map((anchor) => {
                  const row = anchor.closest("tr");
                  const cells = row
                    ? Array.from(row.querySelectorAll("td")).map((cell) =>
                        (cell.textContent || "")
                          .replace(/\s+/g, " ")
                          .trim(),
                      )
                    : [];
                  return {
                    href: anchor.getAttribute("href") || "",
                    ref: (anchor.textContent || "").trim(),
                    program: cells[1] || "",
                    university: cells[2] || "",
                  };
                }),
            )
            .catch(() => [])) as UnitedApplicationIdentity[];
          applications.push(
            ...rows.map((application) => ({
              ...application,
              profileHref,
            })),
          );
        }
        return {
          applications,
          createHrefs: [...new Set(createHrefs)],
          createTargets,
        };
      };
      const exactTargetMatches = (
        applications: UnitedApplicationIdentity[],
      ) =>
        applications.filter(
          (application) =>
            findUniqueUnitedTargetApplication(
              [application],
              profile.universityName || "",
              profile.programName,
            ) !== null,
        );
      let dedupCountBefore = -1; // -1 = search failed/skipped (recheck can't compare)
      try {
        const s = await searchApp("dedup");
        dedupCountBefore = s.count;
      } catch (e: any) {
        throw new Error(
          "United dedup_unknown: searchapp verification failed",
        );
      }
      const profileHrefs = await getExactEmailProfileHrefs();
      const profileLookupAction = resolveUnitedProfileLookupAction(
        dedupCountBefore,
        profileHrefs.length,
      );
      logger.info(
        `[united] dedup profile lookup -> exactEmailProfiles=${profileHrefs.length} action=${profileLookupAction}`,
      );
      if (profileLookupAction === "unknown") {
        result.detail =
          "United dedup_unknown: searchapp found records but no exact-email student profile could be verified";
        return result;
      }
      if (profileLookupAction === "inspect") {
        if (profileHrefs.length === 0) {
          result.detail =
            "United dedup_unknown: searchapp found records but no exact-email student profile could be verified";
          return result;
        }
        const inspected = await inspectProfiles(profileHrefs);
        const matches = exactTargetMatches(inspected.applications);
        if (matches.length > 1) {
          result.detail =
            "United dedup_ambiguous: multiple exact target applications exist; automatic mutation blocked";
          return result;
        }
        if (matches.length === 1) {
          await page.goto(new URL(matches[0].profileHref!, PORTAL_URL).href, {
            waitUntil: "domcontentloaded",
            timeout: 60000,
          });
          await wait(1200);
          const uploadedSlots = await uploadRequiredDocuments();
          result.uploadedSlots = uploadedSlots;
          result.missingDocuments = (
            ["passport", "diploma", "transcript"] as const
          ).filter((slot) => !uploadedSlots.includes(slot));
          result.submitted =
            !dryRun && result.missingDocuments.length === 0;
          result.externalRef =
            unitedApplicationIdFromHref(matches[0].href) ||
            matches[0].ref;
          result.detail = dryRun
            ? "United DRY: existing target application and document presence inspected; no mutation"
            : result.submitted
            ? "United: existing target application verified and required documents repaired"
            : "United: target application exists, but required document repair is incomplete";
          return result;
        }
        let createHref: string | null = null;
        if (profileHrefs.length === 1 && inspected.createHrefs.length === 1) {
          createHref = inspected.createHrefs[0];
        } else {
          const provedProfileHref = findUnitedProfileHrefByExternalRef(
            inspected.applications,
            profile.portalSubmissionExternalRef,
          );
          const provedCreateTargets = inspected.createTargets.filter(
            (target) => target.profileHref === provedProfileHref,
          );
          if (provedProfileHref && provedCreateTargets.length === 1) {
            createHref = provedCreateTargets[0].createHref;
            logger.info(
              "[united] duplicate exact-email profiles resolved by prior submission externalRef ownership",
            );
          }
        }
        if (!createHref) {
          result.detail =
            "United dedup_ambiguous: existing student has no target application and no unique profile ownership proof";
          return result;
        }
        await page.goto(new URL(createHref, PORTAL_URL).href, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await wait(2500);
      }
      if (profileLookupAction === "new") {
        // getExactEmailProfileHrefs() necessarily visited My Students. Restore
        // the clean wizard only after both dedup sources proved no profile.
        await page.goto(PORTAL_URL + "/Manage/newapplication", {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await wait(2500);
        await ensureNameShim();
      }

      // ===== United 6-step wizard (Term → Degree card → Program grid → Personal) =====
      // The portal was redesigned into a 6-step KT-Stepper. The old single-page
      // #selectuniversity/#selectprogram model never advanced past Step 1, so no
      // cascade select ever populated. Steps 1–3 below drive the real wizard
      // (verified live 2026-07-06, Nişantaşı/Master); Step 4 Personal is unchanged.
      const norm = (s: string) =>
        fold(String(s || "")).replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
      void norm;

      // --- PROVEN wizard recipe (driven live end-to-end → "Selected Majors (1)"):
      // Continue overshoots forward UNPREDICTABLY (1–3 steps); Back (#btnback) is a
      // reliable SINGLE step back. So: Continue forward, then backUntil(<marker>) to
      // land exactly on the wanted step. Step detection is visibility-based:
      //   Step1 = term radio visible; Step2 = visible label.form-check-image (the
      //   degree radio INPUTs are CSS-hidden, offsetParent=null — input-based
      //   detection always read "no cards"); Step3 = visible div.single-table card
      //   (or visible "Reset Filter"); Step4 = #firstname visible.
      const wantDegree = resolvedDegree!;
      const readStep = async () => {
        await ensureNameShim();
        return (await page.evaluate(() => {
          const vis = (el: Element | null) => !!(el && (el as HTMLElement).offsetParent);
          const uni = document.getElementById("selectuniversity") as HTMLSelectElement | null;
          return {
            term: vis(document.querySelector('input[name="radio_buttons_2"]')),
            degree: [...document.querySelectorAll("label.form-check-image")].some(l => !!(l as HTMLElement).offsetParent),
            step3: [...document.querySelectorAll("div.single-table")].some(c => !!(c as HTMLElement).offsetParent)
              || [...document.querySelectorAll("button,a")].some(b => /reset filter/i.test(b.textContent || "") && !!(b as HTMLElement).offsetParent),
            uniOpts: uni ? uni.options.length : 0,
            firstname: vis(document.querySelector("#firstname")),
          };
        })) as { term: boolean; degree: boolean; step3: boolean; uniOpts: number; firstname: boolean };
      };
      const clickBack = async () => {
        await page.evaluate(() => {
          const b = document.getElementById("btnback") as HTMLElement | null;
          if (b && b.offsetParent) b.click();
        });
        await page.waitForTimeout(1800);
      };
      const clickCont = async () => {
        await page.evaluate(() => {
          const b = [...document.querySelectorAll("button,a,input[type=button]")].find(
            (x: any) => /continue/i.test((x.textContent || x.value || "")) && (x as HTMLElement).offsetParent
          ) as HTMLElement | undefined;
          if (b) b.click();
        });
        await page.waitForTimeout(1800);
        await ensureNameShim();
      };
      // Continue overshoots; walk BACK one reliable step at a time until the
      // target step's marker is visible. Bounded — returns false if not reached.
      const backUntil = async (key: "term" | "degree" | "step3" | "firstname", max = 8) => {
        for (let i = 0; i < max; i++) {
          const s = await readStep();
          logger.info(`[united] backUntil ${key} i=${i} ` + JSON.stringify(s));
          if ((s as any)[key]) return true;
          await clickBack();
        }
        logger.warn(`[united] backUntil ${key} did NOT converge after ${max} steps`);
        return false;
      };

      // Baseline for increment-based confirmation: a stale draft can already show
      // "Selected Majors (1)", so an absolute >0 check could false-positive. Only
      // a counter INCREASE above this baseline confirms OUR selection.
      const selectedBaseline = await page.evaluate(() =>
        Number((document.body.innerText.match(/Selected Majors\s*\((\d+)\)/) || [])[1] || "0")).catch(() => 0);
      logger.info(`[united] selected-majors baseline=${selectedBaseline}`);

      // --- Step 1: pick term + Continue (may overshoot; backUntil corrects) ---
      await page.waitForSelector('input[name="radio_buttons_2"]', { timeout: 20000 }).catch(() => {});
      const termOk = await page.evaluate(() => {
        const radios = Array.from(
          document.querySelectorAll<HTMLInputElement>('input[name="radio_buttons_2"]'),
        );
        if (radios.length !== 1) return false;
        const r = radios[0];
        r.checked = true; r.click(); r.dispatchEvent(new Event("change", { bubbles: true }));
        try { (window as any).clickradio && (window as any).clickradio(); } catch {}
        return r.checked;
      });
      logger.info(`[united] step1 term selected=${termOk}`);
      if (!termOk) throw new Error("United term target was not unique or could not be verified");
      await clickCont();

      // --- Step 2: land on Degree, pick via HIDDEN input + clickradio1 + label ---
      await backUntil("degree");
      const degOk = await page.evaluate((want: string) => {
        const nrm = (s: string) => (s || "").toLowerCase().replace(/[^a-z]/g, "");
        const w = nrm(want);
        const r = [...document.querySelectorAll('input[type=radio]')].find(
          (x: any) => x.value && (nrm(x.value) === w || nrm(x.value).includes(w) || w.includes(nrm(x.value)))
        ) as HTMLInputElement | undefined;
        if (!r) return null;
        r.checked = true; try { r.click(); } catch {}
        r.dispatchEvent(new Event("change", { bubbles: true }));
        try { (window as any).clickradio1 && (window as any).clickradio1(); } catch {}
        const l = r.closest("label"); if (l) { try { (l as HTMLElement).click(); } catch {} }
        return r.value;
      }, wantDegree);
      logger.info(`[united] step2 degree want="${wantDegree}" selected=${JSON.stringify(degOk)}`);
      if (degOk !== wantDegree) {
        throw new Error(`United degree target could not be verified: ${wantDegree}`);
      }
      await clickCont();

      // --- Step 3: land on Program step; if uni list still empty → one retry via Degree ---
      await backUntil("step3");
      let st = await readStep();
      if (st.uniOpts === 0) {
        await backUntil("degree");
        await clickCont();
        await backUntil("step3");
        st = await readStep();
      }

      const select2Exact = async (
        id: string,
        exactLabel: string,
      ): Promise<boolean> => {
        const native = page.locator(`#${id}`);
        const container = page.locator(`#select2-${id}-container`);
        if ((await native.count()) !== 1 || (await container.count()) !== 1) {
          return false;
        }
        await container.click({ timeout: 8000 });
        const search = page
          .locator(".select2-container--open input.select2-search__field")
          .last();
        if (await search.count()) {
          await search.fill(exactLabel);
          await wait(500);
        }
        const options = page.locator(
          ".select2-container--open .select2-results__option",
        );
        const optionTexts = (await options
          .allInnerTexts()
          .catch(() => [])) as string[];
        const normalizeExact = (value: string) =>
          fold(
            String(value || "").replace(
              /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
              "",
            ),
          )
            .replace(/\s+/g, " ")
            .trim();
        const expected = normalizeExact(exactLabel);
        const indexes = optionTexts
          .map((text, index) =>
            normalizeExact(text) === expected ? index : -1,
          )
          .filter((index) => index >= 0);
        if (indexes.length !== 1) {
          await page.keyboard.press("Escape").catch(() => {});
          return false;
        }
        await options.nth(indexes[0]).click({ timeout: 8000 });
        await wait(1800);
        const selectedText = await native.evaluate(
          (select: HTMLSelectElement) =>
            select.selectedOptions[0]?.textContent || "",
        );
        return normalizeExact(selectedText) === expected;
      };

      // 3a) Resolve the CRM alias to ONE exact live portal option and select it
      // through Select2's real UI. Native change alone does not reliably render
      // the filtered cards in this build.
      const universityOptionTexts = (await readOptions(
        "selectuniversity",
      )).map((option) => option.text);
      const exactUniversityOption = resolveUnitedUniversityOption(
        universityOptionTexts,
        profile.universityName || "",
      );
      if (!exactUniversityOption) {
        result.programMissing = true;
        result.detail =
          "United program_missing: university alias did not resolve to one exact live portal option";
        return result;
      }
      const universitySelected = await select2Exact(
        "selectuniversity",
        exactUniversityOption,
      );
      logger.info(
        `[united] step3 university exact=${JSON.stringify(
          exactUniversityOption,
        )} selected=${universitySelected}`,
      );
      if (!universitySelected) {
        result.programMissing = true;
        result.detail =
          "United program_missing: exact university Select2 readback failed";
        return result;
      }
      const universityCardsRendered = await page
        .waitForFunction(
          (expectedUniversity: string) => {
            const normalize = (value: string) =>
              (value || "")
                .toLowerCase()
                .replace(
                  /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
                  "",
                )
                .replace(/[^a-z0-9]+/g, " ")
                .trim();
            const visible = Array.from(
              document.querySelectorAll<HTMLElement>("div.single-table"),
            ).filter((card) => !!card.offsetParent);
            return (
              visible.length > 0 &&
              visible.some(
                (card) =>
                  normalize(card.querySelector("h4")?.textContent || "") ===
                  normalize(expectedUniversity),
              )
            );
          },
          exactUniversityOption,
          { timeout: 15000 },
        )
        .then(() => true)
        .catch(() => false);
      if (!universityCardsRendered) {
        result.programMissing = true;
        result.detail =
          "United program_missing: university filter did not render an exact target-university card";
        return result;
      }

      // 3b) Resolve the programme to ONE exact portal option (degree prefix
      // removed, but language/thesis qualifiers preserved) and apply the real
      // Select2 filter so programmes beyond the first pagination page work.
      const programOptionTexts = (await readOptions("selectprogram")).map(
        (option) => option.text,
      );
      const exactProgramOption = resolveUnitedProgramOption(
        programOptionTexts,
        profile.programName,
      );
      if (!exactProgramOption) {
        result.programMissing = true;
        result.detail =
          "United program_missing: requested programme did not resolve to one exact live option";
        result.availablePrograms = programOptionTexts
          .filter(Boolean)
          .map((name) => ({ name, value: name, enabled: true }));
        result.resolution = "not_in_dropdown";
        return result;
      }
      const programFilterSelected = await select2Exact(
        "selectprogram",
        exactProgramOption,
      );
      if (!programFilterSelected) {
        result.programMissing = true;
        result.detail =
          "United program_missing: exact programme Select2 readback failed";
        return result;
      }
      await wait(1200);
      const cardProof = (await page.evaluate(
        ({
          university,
          program,
          degree,
        }: {
          university: string;
          program: string;
          degree: string;
        }) => {
          const normalizeUniversity = (value: string) =>
            (value || "")
              .toLowerCase()
              .replace(
                /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
                "",
              )
              .replace(/[^a-z0-9]+/g, " ")
              .trim();
          const normalizeProgram = (value: string) =>
            (value || "")
              .toLowerCase()
              .replace(
                /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
                "",
              )
              .replace(
                /^\s*(associate|bachelor|master|masters|phd|doctorate)\s+(degree\s+)?(of|in)\s+/,
                "",
              )
              .replace(
                /\s+\b(vocational school|associate|bachelor|master|phd|doctorate)\b\s*$/,
                "",
              )
              .replace(/[^a-z0-9]+/g, " ")
              .trim();
          const cards = Array.from(
            document.querySelectorAll<HTMLElement>("div.single-table"),
          )
            .filter((card) => !!card.offsetParent)
            .map((card, index) => ({
              index,
              university: (
                card.querySelector("h4")?.textContent || ""
              ).trim(),
              program: (card.querySelector("h3")?.textContent || "").trim(),
              state: (card.textContent || "").replace(/\s+/g, " ").trim(),
              checked: !!(
                card.querySelector(
                  "input.plan-submit-checkbox:checked",
                ) as HTMLInputElement | null
              ),
            }));
          const matches = cards.filter(
            (card) =>
              normalizeUniversity(card.university) ===
                normalizeUniversity(university) &&
              normalizeProgram(card.program) === normalizeProgram(program) &&
              card.program.toLowerCase().includes(degree.toLowerCase()),
          );
          return {
            cards,
            matches,
            checkedTotal: cards.filter((card) => card.checked).length,
          };
        },
        {
          university: exactUniversityOption,
          program: exactProgramOption,
          degree:
            resolvedDegree === "Vocational School"
              ? "Associate"
              : resolvedDegree!,
        },
      )) as {
        cards: Array<{
          index: number;
          university: string;
          program: string;
          state: string;
          checked: boolean;
        }>;
        matches: Array<{
          index: number;
          university: string;
          program: string;
          state: string;
          checked: boolean;
        }>;
        checkedTotal: number;
      };
      logger.info(
        `[united] step3 exact card proof matches=${cardProof.matches.length} visible=${cardProof.cards.length} checked=${cardProof.checkedTotal}`,
      );
      if (cardProof.matches.length !== 1) {
        result.programMissing = true;
        result.detail =
          "United program_missing: exact university+programme+degree card was missing or ambiguous";
        return result;
      }
      if (/quota full/i.test(cardProof.matches[0].state)) {
        result.programMissing = false;
        result.programFull = true;
        result.requestedProgram = {
          value: exactProgramOption,
          name: profile.programName,
        };
        result.openPrograms = cardProof.cards.map((card) => ({
          value: card.program,
          name: card.program,
          enabled: !/quota full/i.test(card.state),
        }));
        result.detail = "United: exact requested programme is quota full";
        return result;
      }
      if (selectedBaseline !== 0 || cardProof.checkedTotal !== 0) {
        result.programMissing = true;
        result.detail =
          "United dedup_unknown: stale Selected Majors state detected; automatic selection blocked";
        return result;
      }
      const pick = await page.evaluate((targetIndex: number) => {
        const cards = Array.from(
          document.querySelectorAll<HTMLElement>("div.single-table"),
        ).filter((card) => !!card.offsetParent);
        const target = cards[targetIndex];
        const checkbox = target?.querySelector(
          "input.plan-submit-checkbox",
        ) as HTMLInputElement | null;
        if (!checkbox) return false;
        checkbox.checked = true;
        try {
          if (typeof (window as any).alert9 === "function") {
            (window as any).alert9(checkbox.value);
          } else {
            checkbox.click();
          }
        } catch {
          return false;
        }
        return true;
      }, cardProof.matches[0].index);
      let programSelected = false;
      if (pick) {
        programSelected = await page
          .waitForFunction(
            (targetIndex: number) => {
              const cards = Array.from(
                document.querySelectorAll<HTMLElement>("div.single-table"),
              ).filter((card) => !!card.offsetParent);
              const checked = cards.filter((card) =>
                card.querySelector(
                  "input.plan-submit-checkbox:checked",
                ),
              );
              const selectedCount = Number(
                (
                  document.body.innerText.match(
                    /Selected Majors\s*\((\d+)\)/,
                  ) || []
                )[1] || "0",
              );
              return (
                selectedCount === 1 &&
                checked.length === 1 &&
                checked[0] === cards[targetIndex]
              );
            },
            cardProof.matches[0].index,
            { timeout: 8000 },
          )
          .then(() => true)
          .catch(() => false);
      }
      logger.info(`[united] wizard nav done programSelected=${programSelected}`);
      // Fail-closed: only a counter-confirmed selection clears programMissing —
      // a false negative is safe; a false positive submits the wrong program.
      result.programMissing = !programSelected;
      // Toward Personal (Continue may overshoot), then land exactly on it.
      await clickCont();
      await backUntil("firstname");
      // ===== end wizard steps 1–3; Step 4 Personal starts below (unchanged) =====

      // We should now be at Personal Information.
      const atPersonal = await page.locator("#firstname, #lastname").first().count().catch(() => 0);
      if (dryRun && !atPersonal) {
        result.dryReachedFinal = false;
        result.stuckStep = 3;
        logger.warn("[united] DRY: Personal step NOT reached (atPersonal=0) — stopping; no student created");
        logger.info("[united] netlog summary: " + JSON.stringify(netlog.map((n) => ({ u: n.url, m: n.method, s: n.status }))));
        return result;
      }
      // Fail-closed (REAL mode only): never fill/submit a real application without
      // a confirmed program. Dry mode continues — client-side fill creates nothing
      // server-side and validates the field mapping even on a program miss.
      if (!dryRun && result.programMissing) {
        logger.warn("[united] program not confirmed — aborting before Personal fill (fail-closed)");
        return result;
      }

      // ---- §4 Personal information (LIVE-mapped field ids, Step 4) ----------
      // All plain <input>/<select> (no select2). THREE distinct 233-option
      // country dropdowns: DropDownList4 = Country of Residence,
      // DropDownList5 = Citizenship, school = Secondary School Country.
      // Hidden Salesforce linkage (#contactid/#accountid/#appid) auto-fills as
      // the wizard progresses — do not touch it.
      const setText = async (id: string, val: any) => {
        if (val == null) return;
        await page.evaluate(({ id, val }: { id: string; val: string }) => {
          const el = document.getElementById(id) as HTMLInputElement | null;
          if (el) {
            el.value = val;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }, { id, val: String(val) });
      };
      // Normalizes a raw phone value to a single, non-duplicated E.164 string
      // before handing it to intlTelInputGlobals.setNumber(). "phone11" is an
      // intl-tel-input widget: filling it via a plain setText() (raw .value
      // assignment, bypassing the widget's own state) combined with the
      // widget re-deriving/prepending the selected country's dial code
      // produced a DOUBLED country code (e.g. "+90+905XXXXXXXXX"). normPhone
      // strips all non-digits, collapses an already-doubled Turkish code
      // ("90905..." / "0090..."), and re-adds exactly one "+"+country code so
      // setNumber sees ONE valid international number and never re-prepends
      // on top of an existing one.
      const normPhone = (raw: any): string => {
        let digits = String(raw ?? "").replace(/[^\d]/g, "");
        if (!digits) return "";
        if (digits.startsWith("9090")) digits = digits.slice(2);       // doubled "90"
        else if (digits.startsWith("00")) digits = digits.slice(2);    // "00" intl prefix
        if (digits.startsWith("0") && digits.length > 10) digits = digits.slice(1); // domestic trunk "0"
        if (digits.length === 10 && digits.startsWith("5")) digits = `90${digits}`; // bare TR mobile
        return `+${digits}`;
      };
      // Fills an intl-tel-input phone field via the widget's own setNumber()
      // API (handles country-flag + dial-code state internally) instead of a
      // raw .value assignment, so the country code is applied exactly once.
      const setPhone = async (id: string, raw: any) => {
        const normalized = normPhone(raw);
        if (!normalized) return;
        const viaWidget = await page.evaluate(({ id, normalized }: { id: string; normalized: string }) => {
          const el = document.getElementById(id) as HTMLInputElement | null;
          if (!el) return false;
          const iti = (window as any).intlTelInputGlobals?.getInstance?.(el);
          if (iti && typeof iti.setNumber === "function") {
            iti.setNumber(normalized);
            return true;
          }
          // No intl-tel-input instance found (unexpected DOM) — fall back to a
          // plain assignment so the field is never silently left empty.
          el.value = normalized;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return false;
        }, { id, normalized });
        logger.info(`[united] ${id} filled via ${viaWidget ? "intlTelInputGlobals.setNumber" : "fallback setText"}`);
      };
      const selText = async (id: string, want: string): Promise<string | null> => {
        if (!want) return null;
        return page.evaluate(({ id, want }: { id: string; want: string }) => {
          const el = document.getElementById(id) as HTMLSelectElement | null;
          if (!el) return null;
          const nrm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
          const w = nrm(want);
          const opt = [...el.options].find(o => o.value && nrm(o.text) === w)
            || [...el.options].find(o => o.value && (nrm(o.text).includes(w) || w.includes(nrm(o.text))));
          if (opt) { el.value = opt.value; el.dispatchEvent(new Event("change", { bubbles: true })); return opt.text; }
          return null;
        }, { id, want });
      };
      // DOB → GG.AA.YYYY (portal hint: "5.5.1986 or 05/05/1986"); ISO passthrough otherwise.
      const fmtDob = (d: any) => {
        if (!d) return "";
        const s = String(d);
        const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
        return m ? `${m[3]}.${m[2]}.${m[1]}` : s;
      };
      // DRY safety: synthetic change events could trigger WebForms postbacks if
      // any control has __doPostBack wired to onchange. Neutralize the postback
      // entry points for the remainder of the dry session (the page is abandoned
      // right after the snapshot) so the fill is provably client-side only.
      if (dryRun) {
        await page.evaluate(() => {
          try { (window as any).__doPostBack = () => {}; } catch {}
          try { (window as any).WebForm_DoPostBackWithOptions = () => {}; } catch {}
          try { const f = document.forms[0] as HTMLFormElement | undefined; if (f) f.onsubmit = () => false; } catch {}
        });
      }
      const netlogBeforeFill = netlog.length;
      const p: any = profile;
      await setText("firstname", p.firstName);
      await setText("lastname", p.lastName);
      await setText("passport", p.passportNumber || p.passport || "");
      await setText("dateInput", fmtDob(p.dateOfBirth || p.dob));
      await setText("kimlik", p.tcNumber || p.nationalId || ""); // foreigners: blank
      await setText("fathername", p.fatherName || "");
      await setText("mothername", p.motherName || "");
      await setText("SecondarySchoolName", p.secondarySchoolName || p.highSchoolName || p.schoolName || p.lastSchool || "");
      await setPhone("phone11", p.phone || p.mobile || "");
      await setText("emailaddress", p.email || "");
      const gRes = await selText("gender", String(p.gender || ""));
      const corRes = await selText("ContentPlaceHolder1_DropDownList4", p.countryOfResidence || p.country || p.nationality || "");
      const citRes = await selText("ContentPlaceHolder1_DropDownList5", p.citizenship || p.nationality || p.country || "");
      // isTransfer may arrive as a string ("false" is truthy!) — only explicit
      // boolean true or "true"/"1"/"yes" counts as a transfer student.
      const isTransfer = /transfer/i.test(String(p.studentType || p.registrationType || ""))
        || p.isTransfer === true || /^(true|1|yes)$/i.test(String(p.isTransfer ?? ""));
      const regRes = await selText("regtype", isTransfer ? "Transfer Student" : "New Student");
      const schCtry = await selText("school", p.schoolCountry || p.schoolCountryName || p.country || p.nationality || "");
      logger.info(`[united] personal filled: gender=${JSON.stringify(gRes)} cor=${JSON.stringify(corRes)} cit=${JSON.stringify(citRes)} reg=${JSON.stringify(regRes)} schCtry=${JSON.stringify(schCtry)}`);

      // DRY mode: fill but DO NOT advance — a client-side fill creates nothing
      // server-side, so the mapping is validated without creating an application.
      if (dryRun) {
        const snap = await page.evaluate(() => {
          const g = (id: string) => {
            const e = document.getElementById(id) as any;
            return e ? (e.tagName === "SELECT" ? e.options[e.selectedIndex]?.text : e.value) : null;
          };
          return {
            firstname: g("firstname"), lastname: g("lastname"), passport: g("passport"),
            dob: g("dateInput") ? "SET" : "", kimlik: g("kimlik") ? "SET" : "", father: g("fathername") ? "SET" : "", mother: g("mothername") ? "SET" : "",
            gender: g("gender"), cor: g("ContentPlaceHolder1_DropDownList4"), cit: g("ContentPlaceHolder1_DropDownList5"),
            reg: g("regtype"), schCtry: g("school"), school: g("SecondarySchoolName") ? "SET" : "",
            // PII-light: prove filled without logging the full value
            phone: g("phone11") ? String(g("phone11")).slice(0, 4) + "***" : "",
            email: g("emailaddress") ? String(g("emailaddress")).slice(0, 3) + "***" : "",
          };
        });
        logger.info(`[united] DRY personal snapshot: ` + JSON.stringify(snap));
        // Dry-safety telemetry: the fill must not have produced any POST. If it
        // did (postback slipped past the neutralizer), surface it loudly.
        const fillPosts = netlog.slice(netlogBeforeFill).filter((n) => n.method === "POST");
        if (fillPosts.length) {
          logger.warn("[united] DRY SAFETY: POST(s) observed DURING personal fill (should be none): " +
            JSON.stringify(fillPosts.map((n) => ({ u: n.url, s: n.status }))));
        } else {
          logger.info("[united] DRY safety: no POST during personal fill (client-side only, confirmed)");
        }
        result.dryReachedFinal = true;
        logger.warn("[united] DRY: Personal filled — stopping before Documents/Submit (no application created)");
        logger.info("[united] netlog summary: " + JSON.stringify(netlog.map((n) => ({ u: n.url, m: n.method, s: n.status }))));
        return result;
      }

      // ===== REAL submission (requires explicit approval; first-real gating handled by worker) =====
      // ---- §5 Personal → Continue: THE APPLICATION IS CREATED HERE ----------
      // Live-mapped: there is NO separate final Submit — the Personal→Documents
      // transition creates the Salesforce application and shows an
      // "Application created successfully" popup with an OK button.
      await clickCont();
      await wait(2500);
      // Deterministic create evidence only — the specific popup phrase, NOT a
      // bare "successfully" (unrelated success copy would false-pass).
      const createdSeen = /application (?:has been |was )?created(?: successfully)?|ba\u015fvuru(?:nuz)? (?:olu\u015fturuldu|al\u0131nd\u0131)/i.test(
        String(await page.evaluate("(()=>document.body?document.body.innerText:'')()")));
      // Dismiss the popup (OK / Tamam), then verify it actually closed.
      const okClicked = await page.evaluate(() => {
        const ok = [...document.querySelectorAll("button,a,input[type=button],input[type=submit]")].find(
          (b) => /^(ok|okay|tamam)$/i.test(((b as HTMLInputElement).value || b.textContent || "").trim()) && (b as HTMLElement).offsetParent) as HTMLElement | undefined;
        if (ok) { ok.click(); return true; }
        return false;
      });
      await wait(1500);
      if (okClicked) {
        const stillOpen = await page.evaluate(() => {
          const ok = [...document.querySelectorAll("button,a,input[type=button],input[type=submit]")].find(
            (b) => /^(ok|okay|tamam)$/i.test(((b as HTMLInputElement).value || b.textContent || "").trim()) && (b as HTMLElement).offsetParent);
          return !!ok;
        });
        if (stillOpen) { logger.warn("[united] create popup may still be open after OK click"); await page.keyboard.press("Escape").catch(() => {}); await wait(800); }
      } else {
        logger.info("[united] no OK/Tamam popup button found (popup may auto-dismiss)");
      }
      // Capture the created ApplicationId (Salesforce a0vP...) for writeback.
      let appIdText = (await page.evaluate(
        "(()=>{const m=document.body?document.body.innerText.match(/a0vP[0-9A-Za-z]{10,}/):null;return m?m[0]:null})()")) as string | null;
      if (!appIdText) {
        try { const a = page.locator("#appid"); if (await a.count()) appIdText = (await a.inputValue().catch(() => "")) || null; } catch {}
      }
      logger.info("[united] application created id=" + appIdText + " createdSeen=" + createdSeen + " okClicked=" + okClicked);
      if (!appIdText && !createdSeen) {
        // Uncertain create state (popup transient/localized, #appid unreadable).
        // Before failing, re-query searchapp: a count INCREASE vs the pre-create
        // baseline is server-side proof the application exists — returning
        // "failed" on a real create would risk a duplicate on retry.
        let recheckCreated = false;
        try {
          const after = await searchApp("post-create recheck");
          if (dedupCountBefore >= 0 && after.count > dedupCountBefore) recheckCreated = true;
        } catch (e: any) { logger.warn("[united] post-create recheck failed: " + (e?.message || e)); }
        if (!recheckCreated) {
          // Fail-closed on writeback: no evidence the create happened — do not
          // report submitted; surface diagnostics instead.
          result.stuckStep = 4;
          logger.warn("[united] no evidence of application create after Personal\u2192Continue (popup/appid/recheck all negative) \u2014 NOT marking submitted");
          return result;
        }
        logger.info("[united] create confirmed via searchapp count increase \u2014 continuing to documents");
      }

      // ---- §6 Server-side identity proof + student-profile document repair --
      // The create popup/#appid only proves that SOMETHING was created. It does
      // not prove the selected university/programme. Re-open My Students,
      // inspect the exact-email profile(s), and require one exact target
      // application before any success writeback. This is the guard that
      // prevents Ankara Bilim requests from being reported as Kent Dentistry.
      await wait(1800);
      const postCreateProfileHrefs = await getExactEmailProfileHrefs();
      if (postCreateProfileHrefs.length === 0) {
        result.detail =
          "United created_target_unverified: no exact-email profile was visible after create";
        result.submitted = false;
        return result;
      }
      const postCreateInspection = await inspectProfiles(
        postCreateProfileHrefs,
      );
      const verifiedTargets = exactTargetMatches(
        postCreateInspection.applications,
      );
      if (verifiedTargets.length !== 1) {
        result.detail =
          verifiedTargets.length > 1
            ? "United created_target_ambiguous: multiple exact university+programme applications found"
            : "United created_target_mismatch: created application did not match the requested university+programme";
        result.submitted = false;
        return result;
      }
      const verifiedTarget = verifiedTargets[0];
      const verifiedApplicationId = unitedApplicationIdFromHref(
        verifiedTarget.href,
      );
      if (
        appIdText &&
        verifiedApplicationId &&
        appIdText !== verifiedApplicationId
      ) {
        result.detail =
          "United created_target_mismatch: popup application id and exact server-side target disagree";
        result.submitted = false;
        return result;
      }
      await page.goto(
        new URL(verifiedTarget.profileHref!, PORTAL_URL).href,
        {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        },
      );
      await wait(1200);

      // Existing-student uploads use /Manage/uploadfilesonetek from the profile
      // modal. Each required slot needs msg=ok plus its own profile-row
      // "Uploaded" readback. HTTP 2xx or a selected filename alone is not proof.
      const uploadedSlots = await uploadRequiredDocuments();
      result.uploadedSlots = uploadedSlots;
      result.missingDocuments = (
        ["passport", "diploma", "transcript"] as const
      ).filter((slot) => !uploadedSlots.includes(slot));
      // NationalID slot is optional and SubmitFiles has no national-id source — skipped.

      result.submitted = result.missingDocuments.length === 0;
      if (result.missingDocuments.length > 0) {
        result.detail =
          "United application was created, but one or more required document uploads could not be proved";
      }
      result.externalRef =
        verifiedApplicationId || verifiedTarget.ref;
      logger.info(
        "[united] submission complete exactTargetId=" +
          result.externalRef,
      );
    } catch (e: any) { result.error = e.message; }
    finally {
      try { page.off("requestfinished", onFinished); } catch {}
    }
    logger.info("[united] netlog summary: " + JSON.stringify(netlog.map((n) => ({ u: n.url, m: n.method, s: n.status }))));
    logger.info("[united] submit " + JSON.stringify(result));
    return result;
  },
};
