import type { Locator, Page } from "playwright-core";
import { launchPortal, logger } from "../../browser.js";
import { portalCreds } from "../../portalCreds.js";
import { fold, matchProgram } from "../../programMatch.js";
import type {
  AdapterSession,
  LoginOpts,
  PortalProgramOption,
  SubmitFiles,
  SubmitProfile,
  SubmitResult,
  UniversityAdapter,
} from "../../types.js";

const BASE = "https://apply.medipol.edu.tr";
const PROFILE_PATH = "/node/add/profile";

export interface MedipolProxyConfig {
  server: string;
  username?: string;
  password?: string;
  bypass?: string;
}

export function resolveMedipolProxy(
  extra?: Record<string, unknown>,
): MedipolProxyConfig | undefined {
  const server =
    typeof extra?.proxyServer === "string" ? extra.proxyServer.trim() : "";
  if (!server) return undefined;
  if (!/^https?:\/\/[^/\s]+(?::\d+)?$/i.test(server)) {
    throw new Error("Medipol proxyServer must be an http(s) proxy URL");
  }
  const optional = (key: string): string | undefined => {
    const value = extra?.[key];
    return typeof value === "string" && value.trim()
      ? value.trim()
      : undefined;
  };
  return {
    server,
    username: optional("proxyUsername"),
    password: optional("proxyPassword"),
    bypass: optional("proxyBypass"),
  };
}

export interface MedipolApplicationEvidence {
  externalRef: string;
  applicantName: string;
  programName: string;
  academicIntake: string;
  status: string;
}

export function resolveMedipolLevel(level: string): string | null {
  const value = fold(level);
  if (/\b(associate|onlisans)\b/.test(value)) return "Associate";
  if (/\b(bachelor|undergraduate|lisans)\b/.test(value)) return "Bachelor";
  if (/\b(master|graduate|yuksek lisans)\b/.test(value)) return "Master";
  if (/\b(phd|doctorate|doctoral|doktora)\b/.test(value)) return "Doctorate";
  if (/\b(tomer|language|dil)\b/.test(value)) return "TÖMER";
  return null;
}

export function chooseMedipolAcademicIntake(
  labels: string[],
  requested?: string,
): string | null {
  const selectable = labels
    .map((label) => label.replace(/\s+/g, " ").trim())
    .filter((label) => label && !/^[-\s]*(select|none)/i.test(label));
  if (selectable.length === 1) return selectable[0];

  const wanted = fold(requested ?? "");
  if (!wanted) return null;
  const exact = selectable.filter((label) => fold(label) === wanted);
  if (exact.length === 1) return exact[0];

  const requestedYear = wanted.match(/\b(20\d{2})(?:\D+(20\d{2}))?\b/);
  if (!requestedYear) return null;
  const yearMatches = selectable.filter((label) => {
    const normalized = fold(label);
    return (
      normalized.includes(requestedYear[1]) &&
      (!requestedYear[2] || normalized.includes(requestedYear[2]))
    );
  });
  return yearMatches.length === 1 ? yearMatches[0] : null;
}

export function chooseMedipolProgramIndex(
  options: PortalProgramOption[],
  requested: string,
): number | null {
  const enabled = options
    .map((option, index) => ({ option, index }))
    .filter(
      ({ option }) =>
        option.enabled &&
        option.name.trim() &&
        !/^\s*(?:select program|select a value|none)\s*$/i.test(option.name),
    );
  const exact = enabled.filter(
    ({ option }) => fold(option.name) === fold(requested),
  );
  if (exact.length === 1) return exact[0].index;
  if (exact.length > 1) return null;

  const matched = matchProgram(
    requested,
    enabled.map(({ option, index }) => ({
      id: String(index),
      name: option.name,
    })),
  );
  if (!matched || matched.conf < 0.75) return null;
  const index = Number(matched.match.id);
  return Number.isInteger(index) ? index : null;
}

export function verifyMedipolApplicationEvidence(
  profile: Pick<SubmitProfile, "firstName" | "lastName" | "programName">,
  evidence: MedipolApplicationEvidence,
): boolean {
  if (!/^\d{4,}$/.test(evidence.externalRef.trim())) return false;
  const expectedNames = new Set([
    fold(`${profile.firstName} ${profile.lastName}`),
    fold(`${profile.lastName} ${profile.firstName}`),
  ]);
  if (!expectedNames.has(fold(evidence.applicantName))) return false;
  if (fold(evidence.programName) !== fold(profile.programName)) return false;
  if (!evidence.academicIntake.trim()) return false;
  const status = fold(evidence.status);
  return Boolean(
    status &&
      !/\b(draft|incomplete|cancelled|canceled|invalid|refused)\b/.test(status),
  );
}

export type MedipolProfileDocumentSlot =
  | "passport"
  | "transcript"
  | "diploma";

export function missingMedipolProfileDocuments(
  applicantDocumentsText: string,
): MedipolProfileDocumentSlot[] {
  const text = fold(applicantDocumentsText);
  const present: Record<MedipolProfileDocumentSlot, boolean> = {
    passport: /\bpassport(?: files?)?\b/.test(text),
    transcript: /\btranscript\b/.test(text),
    diploma: /\bdiploma\b/.test(text),
  };
  return (Object.keys(present) as MedipolProfileDocumentSlot[]).filter(
    (slot) => !present[slot],
  );
}

function missingMedipolData(
  profile: SubmitProfile,
  files: SubmitFiles,
): { fields: string[]; documents: string[] } {
  const fields = [
    ["email", profile.email],
    ["firstName", profile.firstName],
    ["lastName", profile.lastName],
    ["passportNumber", profile.passportNumber],
    ["passportIssueDate", profile.passportIssueDate],
    ["passportExpiryDate", profile.passportExpiryDate],
    ["phone", profile.phone],
    ["gender", profile.gender],
    ["nationality", profile.nationality],
    ["dateOfBirth", profile.dateOfBirth],
    ["fatherName", profile.fatherName],
    ["motherName", profile.motherName],
    ["level", profile.level],
    ["schoolName", profile.schoolName],
    ["gpa", profile.gpa],
    ["programName", profile.programName],
  ]
    .filter(([, value]) => value == null || String(value).trim() === "")
    .map(([field]) => String(field));
  if (!resolveMedipolLevel(profile.level)) fields.push("level(unmapped)");

  const documents = (["passport", "transcript", "diploma", "photo"] as const)
    .filter((slot) => !files[slot])
    .map(String);
  return { fields, documents };
}

async function visible(locator: Locator): Promise<Locator[]> {
  const controls: Locator[] = [];
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index++) {
    if (await locator.nth(index).isVisible().catch(() => false)) {
      controls.push(locator.nth(index));
    }
  }
  return controls;
}

async function uniqueVisible(
  locator: Locator,
  description: string,
): Promise<Locator> {
  const controls = await visible(locator);
  if (controls.length !== 1) {
    throw new Error(
      `Medipol ${description} target is not unique (count=${controls.length})`,
    );
  }
  return controls[0];
}

async function fillAndRead(
  page: Page,
  selector: string,
  value: string | number | undefined,
  description: string,
): Promise<void> {
  if (value == null || String(value).trim() === "") {
    throw new Error(`Medipol data_missing: ${description}`);
  }
  const control = await uniqueVisible(page.locator(selector), description);
  const expected = String(value);
  await control.fill(expected);
  await control.press("Tab").catch(() => {});
  const actual = await control.inputValue().catch(() => "");
  const invalid =
    (await control.getAttribute("aria-invalid").catch(() => null)) === "true";
  if (actual !== expected || invalid) {
    throw new Error(`Medipol ${description} readback failed`);
  }
}

async function selectExactLabel(
  page: Page,
  selector: string,
  label: string,
  description: string,
): Promise<void> {
  const control = await uniqueVisible(page.locator(selector), description);
  await control.selectOption({ label });
  const selected = (
    (await control.locator("option:checked").innerText().catch(() => "")) || ""
  )
    .replace(/\s+/g, " ")
    .trim();
  if (fold(selected) !== fold(label)) {
    throw new Error(`Medipol ${description} readback failed`);
  }
}

async function waitForVisible(
  page: Page,
  selector: string,
  timeout = 30_000,
): Promise<Locator> {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "visible", timeout });
  return locator;
}

async function inspectOwnedProfile(
  page: Page,
  profile: SubmitProfile,
): Promise<{ profileId: string; ambiguous: boolean } | null> {
  await page.goto(`${BASE}/`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(4_000);
  const studentsForm = page
    .getByRole("form", { name: /filter the contents of the students view/i })
    .first();
  if (!(await studentsForm.count())) return null;
  const fullNameFilter = studentsForm.getByRole("textbox", {
    name: /full name/i,
  });
  if ((await fullNameFilter.count()) === 1) {
    await fullNameFilter.fill(`${profile.firstName} ${profile.lastName}`);
    const filter = studentsForm.getByRole("button", {
      name: /^\s*filter\s*$/i,
    });
    if ((await filter.count()) === 1) {
      await filter.click({ timeout: 8_000 });
      await page.waitForTimeout(4_000);
    }
  }

  const expectedNames = [
    fold(`${profile.firstName} ${profile.lastName}`),
    fold(`${profile.lastName} ${profile.firstName}`),
  ];
  const candidateLinks = page.locator('a[href^="/profile/"]');
  const hrefs = new Set<string>();
  const count = await candidateLinks.count().catch(() => 0);
  for (let index = 0; index < count; index++) {
    const link = candidateLinks.nth(index);
    const text = fold(await link.innerText().catch(() => ""));
    if (!expectedNames.includes(text)) continue;
    const href = await link.getAttribute("href").catch(() => null);
    if (/^\/profile\/\d+$/.test(href ?? "")) hrefs.add(href!);
  }

  const ownedIds: string[] = [];
  for (const href of hrefs) {
    await page.goto(`${BASE}${href}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(2_500);
    const body = fold(await page.locator("main").innerText().catch(() => ""));
    if (
      body.includes(fold(profile.passportNumber)) &&
      body.includes(fold(profile.email))
    ) {
      ownedIds.push(href.split("/").pop()!);
    }
  }
  if (ownedIds.length === 0) return null;
  return {
    profileId: ownedIds.length === 1 ? ownedIds[0] : "",
    ambiguous: ownedIds.length !== 1,
  };
}

async function inspectApplications(
  page: Page,
  profileId: string,
  profile: SubmitProfile,
): Promise<MedipolApplicationEvidence[]> {
  await page.goto(`${BASE}/profile/${profileId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(3_000);
  const rows = page.locator("tr");
  const evidence: MedipolApplicationEvidence[] = [];
  const count = await rows.count().catch(() => 0);
  for (let index = 0; index < count; index++) {
    const row = rows.nth(index);
    const link = row.locator('a[href^="/application/"]').first();
    if (!(await link.count())) continue;
    const href = (await link.getAttribute("href").catch(() => "")) || "";
    const externalRef = href.match(/^\/application\/(\d+)$/)?.[1] ?? "";
    if (!externalRef) continue;
    const cells = row.locator("th,td");
    const texts: string[] = [];
    for (let cellIndex = 0; cellIndex < await cells.count(); cellIndex++) {
      texts.push(
        ((await cells.nth(cellIndex).innerText().catch(() => "")) || "")
          .replace(/\s+/g, " ")
          .trim(),
      );
    }
    const linkText = (
      (await link.innerText().catch(() => "")) || ""
    ).replace(/\s+/g, " ").trim();
    const applicantName =
      [profile.firstName, profile.lastName]
        .map((part) => part.trim())
        .filter(Boolean)
        .join(" ");
    const programName =
      texts.find((text) => fold(text) === fold(profile.programName)) ||
      linkText
        .replace(new RegExp(`^${applicantName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*-\\s*`, "i"), "")
        .replace(/^\d{4}-\d{4}\s+Academic Year\s*-\s*/i, "")
        .trim();
    const academicIntake =
      texts.find((text) => /\b20\d{2}\s*-\s*20\d{2}\b/.test(text)) || "";
    const status =
      texts.find((text) =>
        /\b(pending|awaiting|offer|completed|payment|registered|quota|review|request)\b/i.test(
          text,
        ),
      ) || "";
    evidence.push({
      externalRef,
      applicantName,
      programName,
      academicIntake,
      status,
    });
  }
  return evidence;
}

async function inspectExistingProfileDocuments(
  page: Page,
  profileId: string,
): Promise<MedipolProfileDocumentSlot[]> {
  await page.goto(`${BASE}/profile/${profileId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(2_500);
  const heading = page.getByRole("heading", {
    name: /^\s*applicant documents\s*$/i,
  });
  if ((await heading.count().catch(() => 0)) !== 1) {
    return ["passport", "transcript", "diploma"];
  }
  const sectionText = await heading
    .first()
    .locator(
      "xpath=following-sibling::*[following-sibling::*[self::h2 or self::h3]][1]/preceding-sibling::*[1]",
    )
    .innerText()
    .catch(() => "");
  const documentLinksText = await page
    .locator('a[href*="/system/files/"]')
    .allInnerTexts()
    .catch(() => []);
  return missingMedipolProfileDocuments(
    `${sectionText} ${documentLinksText.join(" ")}`,
  );
}

async function uploadAndProve(
  page: Page,
  selector: string,
  buttonSelector: string,
  filePath: string,
  slot: string,
): Promise<void> {
  const input = await uniqueVisible(page.locator(selector), `${slot} upload`);
  await input.setInputFiles(filePath);
  const selected = await input.inputValue().catch(() => "");
  if (!selected) throw new Error(`Medipol ${slot} file selection failed`);
  const button = await uniqueVisible(
    page.locator(buttonSelector),
    `${slot} upload button`,
  );
  await button.click({ timeout: 10_000 });
  await page.waitForTimeout(1_500);
  const invalid =
    (await input.getAttribute("aria-invalid").catch(() => null)) === "true";
  const pageText = fold(await page.locator("main").innerText().catch(() => ""));
  if (invalid || !pageText.includes(fold(filePath.split("/").pop() ?? ""))) {
    throw new Error(`Medipol ${slot} upload could not be proved`);
  }
}

async function createProfile(
  page: Page,
  profile: SubmitProfile,
  files: SubmitFiles,
): Promise<string> {
  await page.goto(`${BASE}${PROFILE_PATH}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await waitForVisible(page, "#edit-field-email-0-value");
  await fillAndRead(
    page,
    "#edit-field-email-0-value",
    profile.email,
    "email",
  );
  await fillAndRead(
    page,
    "#edit-field-first-name-0-value",
    profile.firstName,
    "firstName",
  );
  await fillAndRead(
    page,
    "#edit-field-last-name-0-value",
    profile.lastName,
    "lastName",
  );
  await fillAndRead(
    page,
    "#edit-field-passport-number-0-value",
    profile.passportNumber,
    "passportNumber",
  );
  await fillAndRead(
    page,
    "#edit-field-date-of-issue-0-value-date",
    profile.passportIssueDate,
    "passportIssueDate",
  );
  await fillAndRead(
    page,
    "#edit-field-date-of-expiry-0-value-date",
    profile.passportExpiryDate,
    "passportExpiryDate",
  );
  await fillAndRead(
    page,
    "#edit-field-phone-mobile-0-value-int-phone",
    profile.phone,
    "phone",
  );
  const kvkk = await uniqueVisible(
    page.locator("#edit-field-kvkk-confirmation-value"),
    "KVKK",
  );
  await kvkk.check({ force: true });
  if (!(await kvkk.isChecked())) throw new Error("Medipol KVKK readback failed");
  await uniqueVisible(
    page.locator('input[name="op"][value="Next"]'),
    "profile first Next",
  ).then((button) => button.click({ timeout: 10_000 }));

  await waitForVisible(page, "#edit-field-nationality");
  const gender = /fem|female|kad[iı]n/i.test(profile.gender)
    ? "#edit-field-gender-female"
    : "#edit-field-gender-male";
  const genderControl = await uniqueVisible(page.locator(gender), "gender");
  await genderControl.check({ force: true });
  await uniqueVisible(
    page.locator("#edit-field-marital-status-single"),
    "maritalStatus",
  ).then((control) => control.check({ force: true }));
  await uniqueVisible(
    page.locator("#edit-field-mavi-kart-no"),
    "blueCard",
  ).then((control) => control.check({ force: true }));
  await uniqueVisible(
    page.locator("#edit-field-tc-number-no"),
    "tcNumber",
  ).then((control) => control.check({ force: true }));
  await selectExactLabel(
    page,
    "#edit-field-nationality",
    profile.nationality,
    "nationality",
  );
  await fillAndRead(
    page,
    "#edit-field-birth-date-0-value-date",
    profile.dateOfBirth,
    "dateOfBirth",
  );
  await fillAndRead(
    page,
    "#edit-field-father-name-0-value",
    profile.fatherName,
    "fatherName",
  );
  await fillAndRead(
    page,
    "#edit-field-mother-name-0-value",
    profile.motherName,
    "motherName",
  );
  const level = resolveMedipolLevel(profile.level);
  if (!level) throw new Error("Medipol data_missing: level(unmapped)");
  await selectExactLabel(page, "#edit-field-degree", level, "level");
  await waitForVisible(page, "#edit-field-high-school-name-0-value");
  await fillAndRead(
    page,
    "#edit-field-high-school-name-0-value",
    profile.schoolName,
    "schoolName",
  );
  await fillAndRead(
    page,
    "#edit-field-high-school-gpa-0-value",
    profile.gpa,
    "gpa",
  );
  await selectExactLabel(
    page,
    "#edit-field-high-school-country",
    profile.nationality,
    "highSchoolCountry",
  );
  await uniqueVisible(
    page.locator('input[name="op"][value="Next"]'),
    "profile second Next",
  ).then((button) => button.click({ timeout: 10_000 }));

  await waitForVisible(page, "#edit-field-passport-0-upload");
  await uploadAndProve(
    page,
    "#edit-field-passport-0-upload",
    "#edit-field-passport-0-upload-button",
    files.passport!,
    "passport",
  );
  await uploadAndProve(
    page,
    "#edit-field-transcript-0-upload",
    "#edit-field-transcript-0-upload-button",
    files.transcript!,
    "transcript",
  );
  await uploadAndProve(
    page,
    "#edit-field-diploma-0-upload",
    "#edit-field-diploma-0-upload-button",
    files.diploma!,
    "diploma",
  );
  await uploadAndProve(
    page,
    "#edit-field-photo-0-upload",
    "#edit-field-photo-0-upload-button",
    files.photo!,
    "photo",
  );
  const submit = await uniqueVisible(
    page.locator('input[name="op"][value="Submit"]'),
    "profile Submit",
  );
  await submit.click({ timeout: 12_000 });
  await page.waitForTimeout(4_000);
  const match = new URL(page.url()).pathname.match(/^\/profile\/(\d+)$/);
  if (!match) throw new Error("Medipol profile creation could not be proved");
  const mainText = fold(await page.locator("main").innerText().catch(() => ""));
  if (
    !mainText.includes(fold(profile.passportNumber)) ||
    !mainText.includes(fold(profile.email))
  ) {
    throw new Error("Medipol profile identity readback failed");
  }
  return match[1];
}

async function createApplication(
  page: Page,
  profileId: string,
  profile: SubmitProfile,
  dryRun: boolean,
): Promise<SubmitResult> {
  await page.goto(`${BASE}/profile/${profileId}/applications/add`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(3_000);
  const level = resolveMedipolLevel(profile.level);
  if (!level) throw new Error("Medipol data_missing: level(unmapped)");

  const intakeSelect = await uniqueVisible(
    page.locator("#edit-field-academic-intake"),
    "academic intake",
  );
  const intakeLabels = await intakeSelect.locator("option").allInnerTexts();
  const academicIntake = chooseMedipolAcademicIntake(
    intakeLabels,
    profile.intakeTerm,
  );
  if (!academicIntake) {
    throw new Error("Medipol data_missing: academicIntake(unresolved)");
  }
  await intakeSelect.selectOption({ label: academicIntake });

  await selectExactLabel(
    page,
    "#edit-field-level",
    level,
    "application level",
  );
  await page.waitForTimeout(1_500);

  const programSelect = await uniqueVisible(
    page.locator("#edit-field-program"),
    "application program",
  );
  let programOptions: PortalProgramOption[] = [];
  const options = programSelect.locator("option");
  for (let optionIndex = 0; optionIndex < await options.count(); optionIndex++) {
    const option = options.nth(optionIndex);
    programOptions.push({
      value:
        (await option.getAttribute("value").catch(() => "")) ||
        String(optionIndex),
      name: (
        (await option.innerText().catch(() => "")) || ""
      ).replace(/\s+/g, " ").trim(),
      enabled:
        (await option.getAttribute("disabled").catch(() => null)) == null,
    });
  }

  const programIndex = chooseMedipolProgramIndex(
    programOptions,
    profile.programName,
  );
  if (programIndex == null) {
    const disabledExact = programOptions.find(
      (option) =>
        !option.enabled && fold(option.name) === fold(profile.programName),
    );
    if (disabledExact) {
      return {
        alreadyExists: false,
        submitted: false,
        programMissing: false,
        programFull: true,
        requestedProgram: {
          value: disabledExact.value,
          name: disabledExact.name,
        },
        openPrograms: programOptions,
        detail: "Medipol requested program is disabled/full",
      };
    }
    return {
      alreadyExists: false,
      submitted: false,
      programMissing: true,
      resolution: "not_in_dropdown",
      availablePrograms: programOptions,
      detail: "Medipol requested program is not in the live dropdown",
    };
  }
  await programSelect.selectOption(programOptions[programIndex].value);

  const priority = process.env.MEDIPOL_DEFAULT_PRIORITY?.trim() || "";
  if (!priority) {
    throw new Error(
      "Medipol data_missing: MEDIPOL_DEFAULT_PRIORITY policy is not configured",
    );
  }
  if (!/^(?:[1-9]|10)$/.test(priority)) {
    throw new Error("Medipol MEDIPOL_DEFAULT_PRIORITY must be 1-10");
  }
  await selectExactLabel(
    page,
    "#edit-field-application-priority",
    priority,
    "priority",
  );
  logger.info("[medipol] application priority policy selected", { priority });

  if (dryRun) {
    return {
      alreadyExists: false,
      submitted: false,
      programMissing: false,
      detail: "Medipol dry-run reached the final mutation boundary",
      meta: { dryReachedApplicationConfirmation: true },
    };
  }
  const continueButton = await uniqueVisible(
    page.getByRole("button", { name: /^\s*continue\s*$/i }),
    "application Continue",
  );
  await continueButton.click({ timeout: 12_000 });
  await page.waitForTimeout(3_000);
  const confirmationText = fold(
    await page.locator("main").innerText().catch(() => ""),
  );
  if (
    !confirmationText.includes(fold(profile.programName)) ||
    !confirmationText.includes(fold(`${profile.firstName} ${profile.lastName}`))
  ) {
    throw new Error("Medipol application confirmation identity readback failed");
  }
  const submit = await uniqueVisible(
    page.getByRole("button", { name: /^\s*submit\s*$/i }),
    "application Submit",
  );
  await submit.click({ timeout: 12_000 });
  await page.waitForTimeout(4_000);

  const rows = await inspectApplications(page, profileId, profile);
  const proof = rows.find((row) =>
    verifyMedipolApplicationEvidence(profile, row),
  );
  if (!proof) {
    return {
      alreadyExists: false,
      submitted: false,
      programMissing: false,
      detail: "Medipol final application outcome could not be proved",
    };
  }
  return {
    alreadyExists: false,
    submitted: true,
    programMissing: false,
    externalRef: proof.externalRef,
    detail: `Medipol application ${proof.externalRef} created`,
    meta: {
      portalStatus: proof.status,
      academicIntake: proof.academicIntake,
    },
  };
}

export const medipolAdapter: UniversityAdapter = {
  key: "medipol",
  label: "Istanbul Medipol University",
  allowlist: [
    "Istanbul Medipol University",
    "İstanbul Medipol University",
    "İstanbul Medipol Üniversitesi",
  ],
  matches(name: string): boolean {
    const normalized = fold(name);
    return normalized.includes("medipol") && !normalized.includes("ankara");
  },

  async login(opts?: LoginOpts): Promise<AdapterSession> {
    const credentials = opts?.credentials ?? portalCreds("medipol");
    const { user, password } = credentials;
    const session = await launchPortal({
      headless: opts?.headless ?? true,
      proxy: resolveMedipolProxy(credentials.extra),
    });
    const page = session.page;
    try {
      await page.goto(`${BASE}/user/login`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      const title = await page.title().catch(() => "");
      if (/cloudflare|attention required/i.test(title)) {
        throw new Error(
          "Medipol network_blocked: Cloudflare rejected this worker egress IP",
        );
      }
      await fillAndRead(page, "#edit-name", user, "login email");
      await fillAndRead(page, "#edit-pass", password, "login password");
      await uniqueVisible(page.locator("#edit-submit"), "login submit").then(
        (button) => button.click({ timeout: 10_000 }),
      );
      await page.waitForTimeout(4_000);
      if (
        await page
          .locator("#edit-pass")
          .isVisible()
          .catch(() => false)
      ) {
        throw new Error("Medipol login failed");
      }
      if (!/^\/(?:node|profile)\//.test(new URL(page.url()).pathname)) {
        throw new Error("Medipol login outcome could not be proved");
      }
      return session;
    } catch (error) {
      await session.close().catch(() => {});
      throw error;
    }
  },

  async submit(
    session: AdapterSession,
    profile: SubmitProfile,
    files: SubmitFiles,
    doSubmit = true,
  ): Promise<SubmitResult> {
    const dryRun =
      doSubmit === false || process.env.PORTAL_DRYRUN === "1";
    const missing = missingMedipolData(profile, files);
    if (missing.fields.length > 0) {
      throw new Error(
        `Medipol data_missing: ${Array.from(new Set(missing.fields)).join(", ")}`,
      );
    }
    if (!dryRun && missing.documents.length > 0) {
      return {
        alreadyExists: false,
        submitted: false,
        programMissing: false,
        missingDocuments: missing.documents,
        detail: "Medipol required profile documents are missing",
      };
    }

    const page = session.page;
    const existing = await inspectOwnedProfile(page, profile);
    if (existing?.ambiguous) {
      return {
        alreadyExists: false,
        submitted: false,
        programMissing: false,
        detail: "Medipol owned profile match is ambiguous",
      };
    }
    if (existing?.profileId) {
      const missingPortalDocuments = await inspectExistingProfileDocuments(
        page,
        existing.profileId,
      );
      if (missingPortalDocuments.length > 0) {
        return {
          alreadyExists: false,
          submitted: false,
          programMissing: false,
          missingDocuments: missingPortalDocuments,
          detail:
            "Medipol existing profile is missing required portal documents",
        };
      }
      const applications = await inspectApplications(
        page,
        existing.profileId,
        profile,
      );
      const proof = applications.find((application) =>
        verifyMedipolApplicationEvidence(profile, application),
      );
      if (proof) {
        return {
          alreadyExists: true,
          submitted: false,
          programMissing: false,
          externalRef: proof.externalRef,
          detail: "Medipol application already exists",
          meta: {
            portalStatus: proof.status,
            academicIntake: proof.academicIntake,
          },
        };
      }
    }

    if (dryRun && !existing?.profileId) {
      return {
        alreadyExists: false,
        submitted: false,
        programMissing: false,
        detail:
          "Medipol dry-run stopped before creating a new student profile",
        meta: { dryReachedProfileMutationBoundary: true },
      };
    }
    const profileId =
      existing?.profileId ||
      (await createProfile(page, profile, files));
    return createApplication(page, profileId, profile, dryRun);
  },
};

export default medipolAdapter;
