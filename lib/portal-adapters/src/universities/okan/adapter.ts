// lib/portal-adapters/src/universities/okan/adapter.ts — v2 FINAL (full application)
//
// Istanbul Okan University — CODE adapter. CALIBRATED live 2026-06-20 against the
// real 6-step "Application Form" (Track Wizard). All step mechanisms verified:
//   • Navigation: REAL Playwright clicks (page.click) — synthetic JS clicks do NOT advance.
//   • Kendo DropDownList: page.evaluate → jQuery('#id').data('kendoDropDownList').text(v).trigger('change')
//   • Kendo NumericTextBox (GPA): kendo.widgetInstance($('.k-numerictextbox')).value(n)
//   • Plain text inputs: page.fill (real typing).
//   • Program: fill #programKeyword (live filter) → click "Select" on the matching row.
//   • Documents: per mandatory doc → file input.setInputFiles(pdf) → click adjacent "Upload".
//
// Flow: login → Agency Wizard (creates draft, "Done") → Track Wizard 6 steps → submit.
// REQUIRED step-2 Kendo dropdowns: gender, citizenshipId, blueCard(No), residence(No),
// countryOfResidenceId; required text: familyPhoneNumber. Step-4 country = countryOfSecondarySchoolId.
// Mandatory docs: Passport + Last High School Transcript (PDF, ≤5MB).

import { launchPortal, logger } from "../../browser.js";
import { portalCreds } from "../../portalCreds.js";
import { fold, matchProgram } from "../../programMatch.js";
import type {
  UniversityAdapter, LoginOpts, AdapterSession,
  SubmitProfile, SubmitFiles, SubmitResult,
} from "../../types.js";

const BASE = "https://apply.okan.edu.tr";
export function resolveOkanDegreeValue(level: string): string | null {
  const l = (level || "").toLowerCase();
  if (/(önlisans|onlisans|associate)/.test(l)) return "1";
  if (/(bachelor|lisans|undergraduate)/.test(l)) return "2";
  if (/(yüksek|yuksek|master|graduate)/.test(l)) return "3";
  if (/(phd|doktora|doctorate)/.test(l)) return "4";
  if (/(tömer|tomer|language|dil)/.test(l)) return "5";
  return null;
}

export function chooseOkanProgramIndex(labels: string[], wanted: string): number | null {
  const withoutTrack = (value: string) =>
    fold(value)
      .replace(/\b(non thesis|thesis|tezli|tezsiz|english|turkish|ingilizce|turkce)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const wantedBase = withoutTrack(wanted);
  const sameBase = labels.filter((label) => withoutTrack(label) === wantedBase);
  if (sameBase.length > 1 && !/\b(non thesis|thesis|tezli|tezsiz)\b/.test(fold(wanted))) {
    return null;
  }
  const candidates = labels.map((name, index) => ({ id: String(index), name }));
  const matched = matchProgram(wanted, candidates);
  if (!matched || matched.conf < 0.6) return null;
  const index = Number(matched.match.id);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

export interface OkanTrackEvidence {
  externalRef: string;
  applicantName: string;
  programName: string;
  status: string;
  completed: string;
  stage: string;
}

export function verifyOkanSubmissionEvidence(
  profile: Pick<SubmitProfile, "firstName" | "lastName" | "programName">,
  evidence: OkanTrackEvidence,
): boolean {
  if (!/^\d{3,}$/.test(evidence.externalRef.trim())) return false;
  const expectedNames = new Set([
    fold(`${profile.firstName} ${profile.lastName}`),
    fold(`${profile.lastName} ${profile.firstName}`),
  ]);
  if (!expectedNames.has(fold(evidence.applicantName))) return false;
  if (fold(evidence.programName) !== fold(profile.programName)) return false;
  const durableState = fold(
    `${evidence.status} ${evidence.completed} ${evidence.stage}`,
  );
  if (/\b(not completed|incomplete|draft|cancelled|canceled)\b/.test(durableState)) {
    return false;
  }
  return /\b(completed|submitted|received|yes|true)\b/.test(durableState);
}
const genderText = (g: string) => (/fem|kadın|female/i.test(g || "") ? "Female" : "Male");

export function resolveOkanRequiredFields(profile: SubmitProfile): {
  city: string;
  birthplace: string;
  secondarySchoolCity: string;
  missing: string[];
  policyFallbacks: string[];
} {
  const educationCity =
    profile.educationRecords?.find(
      (record) =>
        record.city?.trim() &&
        (!profile.schoolName ||
          !record.schoolName ||
          record.schoolName.trim().toLowerCase() ===
            profile.schoolName.trim().toLowerCase()),
    )?.city?.trim() ?? "";
  const city = profile.addressCity?.trim() ?? "";
  const birthplace = profile.cityOfBirth?.trim() ?? "";
  const secondarySchoolCity = educationCity || city;
  const missing: string[] = [];
  if (!city) missing.push("addressCity");
  if (!birthplace) missing.push("cityOfBirth");
  if (!secondarySchoolCity) missing.push("secondarySchoolCity");
  return {
    city,
    birthplace,
    secondarySchoolCity,
    missing,
    policyFallbacks:
      !educationCity && city
        ? ["secondarySchoolCity<-addressCity"]
        : [],
  };
}

export const okanAdapter: UniversityAdapter = {
  key: "okan",
  label: "Istanbul Okan University",
  allowlist: ["Istanbul Okan University", "Okan Üniversitesi", "Okan University", "İstanbul Okan"],
  matches(name: string): boolean { return /okan/i.test(name || ""); },

  async login(opts?: LoginOpts): Promise<AdapterSession> {
    const { user, password } = opts?.credentials ?? portalCreds("okan");
    const session = await launchPortal({ headless: opts?.headless ?? true });
    const page: any = session.page;
    logger.info("[okan] login");
    try {
      await page.goto(BASE + "/Agency/Login", { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2000);
      await page.locator("#agencyEmail").first().fill(user);
      await page.locator("#agencyPassword").first().fill(password);
      await page.locator("#login").first().click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(5000);
      if (await page.locator("#agencyPassword").first().isVisible().catch(() => false))
        throw new Error("[okan] login failed — wrong creds or captcha");
      logger.info("[okan] login successful -> " + page.url());
    } catch (err) { await session.close().catch(() => {}); throw err; }
    return session;
  },

  async submit(session: AdapterSession, profile: SubmitProfile, files: SubmitFiles, doSubmit: boolean = true): Promise<SubmitResult> {
    const page: any = session.page;
    const dryRun = doSubmit === false || process.env.PORTAL_DRYRUN === "1";
    const result: any = { alreadyExists: false, submitted: false, programMissing: false };
    const wait = (ms: number) => page.waitForTimeout(ms);
    logger.info("[okan] submit v2 — level:", profile.level, "dry:", dryRun);
    const resolvedFields = resolveOkanRequiredFields(profile);
    const missingCore = [
      ["firstName", profile.firstName],
      ["lastName", profile.lastName],
      ["passportNumber", profile.passportNumber],
      ["email", profile.email],
      ["level", profile.level],
      ["programName", profile.programName],
      ["dateOfBirth", profile.dateOfBirth],
      ["nationality", profile.nationality],
      ["address", profile.address],
      ["phone", profile.phone],
      ["schoolName", profile.schoolName],
      ["graduationYear", profile.graduationYear],
    ]
      .filter(([, value]) => value == null || String(value).trim() === "")
      .map(([field]) => String(field));
    const degree = resolveOkanDegreeValue(profile.level);
    if (!degree) missingCore.push("level(unmapped)");
    const missingData = [...missingCore, ...resolvedFields.missing];
    if (!dryRun && missingData.length > 0) {
      throw new Error(
        `Okan data_missing: ${Array.from(new Set(missingData)).join(", ")}`,
      );
    }
    if (resolvedFields.policyFallbacks.length > 0) {
      logger.warn(
        `[okan] audited legacy policy: ${resolvedFields.policyFallbacks.join(",")}`,
      );
    }

    const clickVisible = async (label: string) => {
      const b = page.locator(`button:has-text("${label}")`);
      const n = await b.count();
      for (let i = 0; i < n; i++) {
        const x = b.nth(i);
        if (!(await x.isVisible().catch(() => false))) continue;
        try {
          await x.click({ timeout: 8000 });
          return true;
        } catch {
          return false;
        }
      }
      return false;
    };
    const next = () => clickVisible("Next");
    const setKendo = (id: string, text: string) => text ? page.evaluate(([i, t]: any) => {
      const w = (window as any).jQuery('#' + i).data('kendoDropDownList'); if (w) { w.text(t); w.trigger('change'); }
    }, [id, text]).catch(() => {}) : Promise.resolve();
    const setNumeric = (labelRe: string, val: number) => page.evaluate(([re, v]: any) => {
      const $ = (window as any).jQuery, kendo = (window as any).kendo;
      const lab = Array.from(document.querySelectorAll('label')).find(l => new RegExp(re, 'i').test(l.innerText));
      const grp = lab && lab.closest('.form-group,.col,div');
      const wrap = grp && grp.querySelector('.k-numerictextbox');
      let w: any = null; if (wrap) { try { w = kendo.widgetInstance($(wrap)); } catch (e) {} }
      if (!w && grp) grp.querySelectorAll('input').forEach((inp: any) => { const x = $(inp).data('kendoNumericTextBox'); if (x) w = x; });
      if (w) { w.value(v); w.trigger('change'); }
    }, [labelRe, val]).catch(() => {});
    const fill = async (id: string, v?: string) => { const l = page.locator("#" + id); if ((await l.count()) && v != null && v !== "") await l.fill(String(v)).catch(() => {}); };

    try {
      // ===== A) Agency Wizard — create draft =====
      await page.goto(BASE + "/agency/ApplicationWizard", { waitUntil: "domcontentloaded", timeout: 60000 });
      await wait(2500);
      await page.locator(".image-container[data-value]").first().click({ timeout: 8000 }).catch(() => {});
      await wait(800); await next(); await wait(1500);
      const degreeTarget = page.locator(`.image-container[data-value="${degree}"]`);
      if ((await degreeTarget.count()) !== 1) {
        throw new Error(`Okan degree target was not unique: ${profile.level}`);
      }
      await degreeTarget.click({ timeout: 8000 });
      await wait(800); await next(); await wait(1500);
      await fill("firstName", profile.firstName);
      await fill("lastName", profile.lastName);
      await fill("passportNumber", profile.passportNumber);
      await fill("email", profile.email);
      await wait(600);
      if (dryRun) {
        result.dryReachedFinal = await page.locator('button:has-text("Done")').first().isVisible().catch(() => false);
        logger.info("[okan] DRY: reached draft Done boundary — stopping. " + JSON.stringify(result));
        return result as SubmitResult;
      }
      await clickVisible("Done");
      await wait(5000);
      if (!/trackwizard/i.test(page.url())) {
        await page.goto(BASE + "/Agency/TrackApplications", { waitUntil: "domcontentloaded", timeout: 60000 });
        await wait(2500);
        await page.locator('a[href*="trackwizard"]').first().click({ timeout: 8000 }).catch(() => {});
        await wait(3000);
      }

      // ===== B) Application Form (6 steps) =====
      // 1 Application Type
      await page.locator('.image-container[data-value="1"]').first().click({ timeout: 8000 }).catch(() => {});
      await wait(600); await next(); await wait(1500);
      // 2 Personal Details
      await setKendo("gender", genderText((profile as any).gender));
      await fill("passportNumber", profile.passportNumber);
      await fill("birthdate", (profile.dateOfBirth || "").slice(0, 10));
      await setKendo("citizenshipId", profile.nationality);
      await setKendo("blueCard", "No");
      await setKendo("residence", "No");
      await setKendo("countryOfResidenceId", profile.nationality);
      await fill("address", profile.address);
      await fill("mobilePhone", String(profile.phone || "").replace(/^\+?90/, "").replace(/^\+/, ""));
      await fill("city", resolvedFields.city);
      await fill("birthplace", resolvedFields.birthplace);
      await fill("mothersName", (profile as any).motherName);
      await fill("fathersName", (profile as any).fatherName);
      await fill("familyPhoneNumber", String(profile.phone || "").replace(/^\+?90/, "").replace(/^\+/, ""));
      await wait(600); await next(); await wait(1800);
      // 3 Program Selection — keyword filter → Select
      if (profile.programName) {
        await fill("programKeyword", profile.programName.replace(/\(.*\)/, "").trim());
        await wait(2000);
        const selectButtons = page.locator('button:has-text("Select")');
        const labels: string[] = [];
        const visibleIndexes: number[] = [];
        for (let i = 0; i < await selectButtons.count(); i++) {
          const button = selectButtons.nth(i);
          if (!(await button.isVisible().catch(() => false))) continue;
          const text = await button.evaluate((el: HTMLElement) => {
            const root = el.closest("tr,.single-table,.card,.program-card,.row") ?? el.parentElement;
            return String(root?.textContent ?? "").replace(/\s+/g, " ").replace(/\bSelect\b/gi, "").trim();
          }).catch(() => "");
          labels.push(text);
          visibleIndexes.push(i);
        }
        const selectedIndex = chooseOkanProgramIndex(labels, profile.programName);
        if (selectedIndex == null) {
          result.programMissing = true;
        } else {
          await selectButtons.nth(visibleIndexes[selectedIndex]).click({ timeout: 6000 });
        }
        await wait(1000);
      }
      if (result.programMissing) return result as SubmitResult;
      await next(); await wait(1800);
      // 4 Educational Information
      await fill("secondarySchoolName", (profile as any).schoolName);
      await fill("graduationYearOfSecondarySchool", String((profile as any).graduationYear || ""));
      await fill(
        "cityOfSecondarySchool",
        resolvedFields.secondarySchoolCity,
      );
      await setKendo("countryOfSecondarySchoolId", profile.nationality);
      if ((profile as any).gpa != null) await setNumeric("gpa of secondary", Number((profile as any).gpa));
      await wait(600); await next(); await wait(1800);
      // 5 Documents — Passport + Last High School Transcript (PDF). One file
      // input + one Upload action per document, followed by exact filename or
      // success-state readback. Missing/ambiguous uploads never advance.
      const uploadDoc = async (
        labelRe: RegExp,
        fpath: string | undefined,
        slot: string,
      ): Promise<boolean> => {
        if (!fpath) return false;
        const labels = page.locator("label").filter({ hasText: labelRe });
        const candidates: any[] = [];
        for (let i = 0; i < await labels.count(); i++) {
          const label = labels.nth(i);
          if (!(await label.isVisible().catch(() => false))) continue;
          const group = label
            .locator(
              'xpath=ancestor::*[(self::div or self::fieldset) and .//input[@type="file"] and .//button[contains(normalize-space(.), "Upload")]][1]',
            )
            .first();
          if (!(await group.count())) continue;
          const fileInputs = group.locator('input[type="file"]');
          const uploadButtons = group.locator('button:has-text("Upload")');
          if (
            (await fileInputs.count()) === 1 &&
            (await uploadButtons.count()) === 1
          ) {
            candidates.push(group);
          }
        }
        if (candidates.length !== 1) {
          logger.warn("[okan] upload target is not unique", {
            slot,
            count: candidates.length,
          });
          return false;
        }
        const group = candidates[0];
        const fi = group.locator('input[type="file"]').first();
        await fi.setInputFiles(fpath);
        const selected = await fi.inputValue().catch(() => "");
        if (!selected) return false;
        await group
          .locator('button:has-text("Upload")')
          .first()
          .click({ timeout: 8000 });
        await wait(2500);
        const fileName = fpath.split("/").pop() || "";
        const groupText = (
          (await group.innerText().catch(() => "")) || ""
        ).replace(/\s+/g, " ");
        const invalid =
          (await fi.getAttribute("aria-invalid").catch(() => null)) === "true";
        return (
          !invalid &&
          (groupText.toLowerCase().includes(fileName.toLowerCase()) ||
            /\b(uploaded|success|complete)\b/i.test(groupText))
        );
      };
      const uploadedSlots: string[] = [];
      if (
        await uploadDoc(/passport/i, (files as any).passport, "passport")
      ) {
        uploadedSlots.push("passport");
      }
      if (
        await uploadDoc(
          /transcript|high school/i,
          (files as any).transcript,
          "transcript",
        )
      ) {
        uploadedSlots.push("transcript");
      }
      result.uploadedSlots = uploadedSlots;
      const missingDocuments = ["passport", "transcript"].filter(
        (slot) => !uploadedSlots.includes(slot),
      );
      if (missingDocuments.length > 0) {
        result.missingDocuments = missingDocuments;
        result.detail = "Okan required document upload could not be proved";
        return result as SubmitResult;
      }
      await wait(1000); await next(); await wait(2000);
      // 6 Completed — final submit
      const finalClicked =
        (await clickVisible("Submit")) ||
        (await clickVisible("Complete")) ||
        (await clickVisible("Finish")) ||
        (await clickVisible("Done"));
      if (!finalClicked) {
        result.detail = "Okan final submit action was not found or could not be clicked";
        return result as SubmitResult;
      }
      await wait(6000);
      const finalBody = (await page.evaluate(
        "(()=>document.body?document.body.innerText:'')()",
      )) as string;
      if (/already|kayıtlı|duplicate|zaten/i.test(finalBody)) {
        result.alreadyExists = true;
        result.detail = "Okan portal reported a duplicate applicant/application";
        return result as SubmitResult;
      }

      // The grid headings themselves contain "Completed" even when it has zero
      // rows. A generic body-text success regex therefore produced historical
      // submitted=true/programMissing=true contradictions. Success now requires
      // a durable, exact row in Track Applications.
      await page.goto(BASE + "/Agency/TrackApplications", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await wait(3500);
      const trackRows = page.locator("table tbody tr,.k-grid-content tbody tr");
      const proofs: OkanTrackEvidence[] = [];
      for (let rowIndex = 0; rowIndex < await trackRows.count(); rowIndex++) {
        const row = trackRows.nth(rowIndex);
        if (!(await row.isVisible().catch(() => false))) continue;
        const cells = row.locator("td");
        if ((await cells.count()) < 3) continue;
        const texts: string[] = [];
        for (let cellIndex = 0; cellIndex < await cells.count(); cellIndex++) {
          texts.push(
            ((await cells.nth(cellIndex).innerText().catch(() => "")) || "")
              .replace(/\s+/g, " ")
              .trim(),
          );
        }
        const applicantName =
          texts.find((text) => {
            const value = fold(text);
            return (
              value === fold(`${profile.firstName} ${profile.lastName}`) ||
              value === fold(`${profile.lastName} ${profile.firstName}`)
            );
          }) || "";
        const programName =
          texts.find((text) => fold(text) === fold(profile.programName)) || "";
        if (!applicantName || !programName) continue;
        const rowHref =
          (await row
            .locator('a[href*="trackwizard"],a[href*="application"]')
            .first()
            .getAttribute("href")
            .catch(() => "")) || "";
        const externalRef =
          rowHref.match(/[?&](?:id|applicationId)=(\d+)/i)?.[1] ||
          texts.find((text) => /^\d{3,}$/.test(text)) ||
          "";
        const status =
          texts.find((text) =>
            /\b(submitted|received|approved|pending|rejected)\b/i.test(text),
          ) || "";
        const completed =
          texts.find((text) => /^(?:yes|true|completed)$/i.test(text)) || "";
        const stage =
          texts.find((text) =>
            /\b(completed|submitted|received|evaluation|review)\b/i.test(text),
          ) || "";
        proofs.push({
          externalRef,
          applicantName,
          programName,
          status,
          completed,
          stage,
        });
      }
      const proof = proofs.find((candidate) =>
        verifyOkanSubmissionEvidence(profile, candidate),
      );
      if (proof) {
        result.submitted = true;
        result.externalRef = proof.externalRef;
        result.detail = `Okan application ${proof.externalRef} verified in Track Applications`;
      } else {
        result.detail =
          "Okan final submission outcome could not be proved in Track Applications";
      }
      logger.info("[okan] submit " + JSON.stringify(result));
      return result as SubmitResult;
    } catch (e: any) {
      throw new Error(`Okan submit failed: ${e?.message || String(e)}`);
    }
  },
};
export default okanAdapter;
