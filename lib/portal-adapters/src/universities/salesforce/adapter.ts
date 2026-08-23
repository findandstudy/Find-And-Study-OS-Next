import type {
  UniversityAdapter,
  AdapterSession,
  SubmitProfile,
  SubmitFiles,
  SubmitResult,
  LoginOpts,
} from "../../types.js";
import { launchPortal, logger } from "../../browser.js";
import { portalCreds } from "../../portalCreds.js";
import { fold } from "../../programMatch.js";
import { SALESFORCE_SCHOOLS, type SalesforceSchoolConfig } from "./config.js";
import {
  chooseSalesforceBinaryCandidate,
  findSalesforceAppliedProgramMatch,
  hasSalesforceCompletionProof,
  hasSalesforceUploadProof,
  inferSalesforceDocumentSlot,
  isOwnedSalesforceApplicant,
  normalizeSalesforceStage,
  parseSalesforceStageMarker,
  resolveSalesforceProgramTarget,
  salesforceApplicantReadbackFailures,
  salesforceDuplicateDisposition,
  salesforceProgramCardMatchesCandidate,
  salesforcePortalProgramCandidates,
  type SalesforceStage,
} from "./portalState.js";
import { basename } from "node:path";

function markSalesforceVerifiedSuccess(
  result: SubmitResult,
  kind: "completed_stage" | "exact_application_row",
): void {
  result.submitted = true;
  result.meta = {
    ...result.meta,
    successProof: {
      verified: true,
      kind,
      schemaVersion: 1,
    },
  };
}

// ---------------------------------------------------------------------------
// Factory — one UniversityAdapter per SALESFORCE_SCHOOLS entry
//
// Credentials priority:
//   1. opts.credentials (injected by worker from DB)
//   2. portalCreds(cfg.key) (reads from process.env — legacy / dev fallback)
// ---------------------------------------------------------------------------
function makeSalesforceAdapter(cfg: SalesforceSchoolConfig): UniversityAdapter {
  return {
    key:   cfg.key,
    label: cfg.label,
    portalUrl: cfg.portalUrl,

    matches(name: string): boolean {
      const f = fold(name);
      return cfg.namePatterns.some(p => f.includes(p));
    },

    async login(opts?: LoginOpts): Promise<AdapterSession> {
      const { user, password } = opts?.credentials ?? portalCreds(cfg.key);
      const session = await launchPortal({ headless: opts?.headless ?? true });
      logger.info(`[salesforce:${cfg.key}] login → ${cfg.portalUrl}`);

      const page: any = session.page;
      try {
        await page.goto(cfg.portalUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(3500);
        for (const __s of ["input[type=email]","input[name*=email i]","input[id*=email i]","input[type=text]"]) { const __l = page.locator(__s).first(); if ((await __l.count()) && (await __l.isVisible().catch(() => false))) { await __l.fill(user).catch(() => {}); break; } }
        await page.locator("input[type=password]").first().fill(password);
        await page.getByRole("button", { name: /login|giris|sign in/i }).first().click({ timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(6000);
        const stillLogin = await page.locator("input[type=password]").first().isVisible().catch(() => false);
        if (stillLogin) throw new Error(`[salesforce:${cfg.key}] login failed - password field still visible (wrong creds or captcha)`);
        logger.info(`[salesforce:${cfg.key}] login successful -> ${page.url()}`);
      } catch (err) {
        await session.close().catch(() => {});
        throw err;
      }
      return session;
    },

    async submit(
      session: AdapterSession,
      profile: SubmitProfile,
      files: SubmitFiles,
      doSubmit: boolean = true,
    ): Promise<SubmitResult> {
      logger.info(`[salesforce:${cfg.key}] submit — program: ${profile.programName}`);

      for (const doc of cfg.requiredDocs) {
        if (!files[doc]) {
          logger.warn(`[salesforce:${cfg.key}] missing required doc: ${doc}`);
        }
      }

      const page: any = session.page;
      const dryRun = doSubmit === false || process.env.PORTAL_DRYRUN === "1" || process.env.SF_DRYRUN === "1";
      const strictMappedPortal = cfg.strictContract;
      if (strictMappedPortal) {
        const missingProfile = [
          ["firstName", profile.firstName],
          ["lastName", profile.lastName],
          ["passportNumber", profile.passportNumber],
          ["email", profile.email],
          ["dateOfBirth", profile.dateOfBirth],
          ["gender", profile.gender],
          ["nationality", profile.nationality],
          ["address", profile.address],
          ["addressCity", profile.addressCity],
          ["phone", profile.phone],
          ["level", profile.level],
          ["programName", profile.programName],
          ["schoolName", profile.schoolName],
          ["gpa", profile.gpa],
        ]
          .filter(([, value]) => value == null || String(value).trim() === "")
          .map(([field]) => String(field));
        if (missingProfile.length > 0) {
          throw new Error(
            `Salesforce ${cfg.key} data_missing: ${missingProfile.join(", ")}`,
          );
        }
        if (!dryRun) {
          const missingDocuments = cfg.requiredDocs.filter(
            (slot) => !files[slot],
          );
          if (missingDocuments.length > 0) {
            return {
              submitted: false,
              alreadyExists: false,
              programMissing: false,
              missingDocuments,
              detail: `${cfg.label}: required documents are missing`,
            };
          }
        }
      }

      // --- Boot-first SPA navigation (Sabancı / 2-phase Experience Cloud fix) ---
      // A cold goto(application-form) is redirected Home by the SPA route-guard,
      // so the wizard never renders. Boot on Home first (let the app-shell
      // hydrate), then reach the wizard via an in-app link, falling back to a
      // warmed goto. Retry up to 3× until a wizard form field is visible.
      const agencyUrl = cfg.portalUrl.replace(/\/$/, "") + "/";
      const appFormUrl = agencyUrl + "application-form";
      const FORM_SEL = 'input[name="First_Name"], input[name="Last_Name"], input[name="Passport_Number"], input[name="Student_First_Name"], input[name="eduhubPicklistOptions"], input[placeholder*="search program" i], input[placeholder*="keyword" i], select[name="Gender"], input[name="Country_of_Secondary_School"], input[type=file]';
      // "Any visible match" — FORM_SEL is a broad union, so .first() can bind to
      // a hidden element while another field is actually on screen. Iterate.
      const onWizard = async (): Promise<boolean> => { try { const loc = page.locator(FORM_SEL); const n = await loc.count(); for (let i = 0; i < Math.min(n, 12); i++) { if (await loc.nth(i).isVisible().catch(() => false)) return true; } return false; } catch (e) { return false; } };
      const readPageText = async (): Promise<string> => {
        try {
          return (await page.evaluate(
            "(() => document.body ? document.body.innerText : '')()",
          )) as string;
        } catch {
          return "";
        }
      };
      const inspectAppliedPrograms = async (): Promise<{
        externalRef: string;
        portalProgram: string;
      } | null> => {
        if (cfg.key !== "halic" || !strictMappedPortal) return null;
        const expectedTarget = resolveSalesforceProgramTarget(
          profile.programName,
          profile.programNameMap,
          profile.programNameMapGeneral,
        );
        const expectedCandidates =
          salesforcePortalProgramCandidates(expectedTarget);
        const rows = page.locator("tr");
        const rowCount = await rows.count().catch(() => 0);
        const appliedRows: Array<{
          applicationNumber: string;
          programName: string;
        }> = [];
        for (let index = 0; index < rowCount; index++) {
          const row = rows.nth(index);
          const cells = await row
            .locator("td")
            .evaluateAll((nodes: Element[]) =>
              nodes.map((node: Element) => ({
                label: node.getAttribute("data-label") || "",
                text: (node.textContent || "").replace(/\s+/g, " ").trim(),
              })),
            )
            .catch(() => []);
          const applicationNumber =
            cells.find((cell: { label: string }) =>
              /applied program number/i.test(cell.label),
            )?.text ||
            cells.map((cell: { text: string }) => cell.text)
              .find((text: string) => /^AP\d{6,}$/i.test(text)) ||
            "";
          const programName =
            cells.find((cell: { label: string }) =>
              /program name/i.test(cell.label),
            )?.text || "";
          if (applicationNumber && programName) {
            appliedRows.push({ applicationNumber, programName });
          }
        }
        const match = findSalesforceAppliedProgramMatch(
          appliedRows,
          expectedCandidates,
        );
        if (match) {
          logger.info(`[salesforce:${cfg.key}] applied programme proof`, {
            externalRef: match.externalRef,
            portalProgram: match.portalProgram,
          });
        }
        return match;
      };
      const filterTrackApplicant = async (
        query: string,
      ): Promise<void> => {
        const listSearch = page
          .getByPlaceholder(/search this list/i)
          .first();
        if (query && (await listSearch.count())) {
          await listSearch.fill(query).catch(() => {});
          await listSearch.press("Enter").catch(() => {});
          await page.waitForTimeout(4000);
          return;
        }

        // Beykent's current lightning-datatable exposes Search as a button.
        // It opens one unlabeled text filter rather than a placeholder input.
        const searchButton = page
          .getByRole("button", { name: /^\s*search\s*$/i })
          .first();
        if (!(await searchButton.count())) return;
        await searchButton.click({ timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(1200);
        const textInputs = page.locator('input[type="text"]');
        const visibleTextInputs: any[] = [];
        const count = await textInputs.count().catch(() => 0);
        for (let index = 0; index < count; index++) {
          if (
            await textInputs
              .nth(index)
              .isVisible()
              .catch(() => false)
          ) {
            visibleTextInputs.push(textInputs.nth(index));
          }
        }
        if (query && visibleTextInputs.length === 1) {
          await visibleTextInputs[0].fill(query).catch(() => {});
          await visibleTextInputs[0].press("Enter").catch(() => {});
          await page.waitForTimeout(4000);
        }
      };
      const gotoAppForm = async (): Promise<void> => {
        await page.goto(agencyUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(8000); // SPA app-shell hydration (networkidle unreliable on Salesforce)
        const link = page.locator('a[href*="application-form"], a[href$="/application-form"]').first();
        if (await link.count().catch(() => 0)) {
          await link.scrollIntoViewIfNeeded().catch(() => {});
          await link.click({ timeout: 6000 }).catch(() => {});
          await page.waitForTimeout(3000);
        }
        if (!(await onWizard())) {
          await page.goto(appFormUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
        }
        // Poll for ANY visible wizard field (don't waitFor .first(), which may be hidden).
        for (let i = 0; i < 30 && !(await onWizard()); i++) await page.waitForTimeout(1000);
      };
      const inspectOwnedApplicant = async (): Promise<{
        owned: boolean;
        externalRef: string;
        applicationStatus: string;
        trackStage: string;
      }> => {
        const empty = {
          owned: false,
          externalRef: "",
          applicationStatus: "",
          trackStage: "",
        };
        if (!strictMappedPortal) return empty;
        await page.goto(agencyUrl + "track-application", {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        }).catch(() => {});
        await page.waitForTimeout(8000);
        // Beykent's global filter matches one column at a time, so an exact
        // email lookup is reliable while a combined "First Last" query is not.
        // Ownership below still requires both the name and email readback.
        await filterTrackApplicant(profile.email);
        const emailPattern = new RegExp(
          profile.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          "i",
        );
        const rows = page.locator("tr").filter({ hasText: emailPattern });
        if ((await rows.count().catch(() => 0)) !== 1) return empty;
        const row = rows.first();
        const cellText = async (label: string): Promise<string> => {
          const cell = row.locator(`[data-label="${label}"]`).first();
          return ((await cell.innerText().catch(() => "")) || "")
            .replace(/\s+/g, " ")
            .trim();
        };
        const firstName = await cellText("First Name");
        const lastName = await cellText("Last Name");
        const rowName =
          `${firstName} ${lastName}`.trim() ||
          (await cellText("Name"));
        const rowEmail = await cellText("Email");
        const mailtoHref =
          (await row
            .locator('a[href^="mailto:"]')
            .first()
            .getAttribute("href")
            .catch(() => "")) || "";
        if (cfg.key === "halic") {
          const cells = await row
            .locator("td")
            .evaluateAll((nodes: Element[]) =>
              nodes.map((node: Element) => ({
                label: node.getAttribute("data-label"),
                text: (node.textContent || "").replace(/\s+/g, " ").trim(),
              })),
            )
            .catch(() => []);
          logger.info(`[salesforce:${cfg.key}] track applicant row`, {
            cells: JSON.stringify(cells),
          });
        }
        const owned = isOwnedSalesforceApplicant({
          firstName: profile.firstName,
          lastName: profile.lastName,
          email: profile.email,
          rowName,
          rowEmail: mailtoHref || rowEmail,
        });
        if (!owned) return empty;
        return {
          owned,
          externalRef:
            (await cellText("Application Name")) ||
            (await cellText("Name")),
          applicationStatus: await cellText("Application Status"),
          trackStage: await cellText("Stage"),
        };
      };
      const applicantPreflight = await inspectOwnedApplicant();
      logger.info(`[salesforce:${cfg.key}] applicant preflight`, {
        owned: applicantPreflight.owned,
        hasApplicationRef: Boolean(applicantPreflight.externalRef),
        hasApplicationStatus: Boolean(applicantPreflight.applicationStatus),
        hasTrackStage: Boolean(applicantPreflight.trackStage),
      });
      if (
        applicantPreflight.owned &&
        hasSalesforceCompletionProof(applicantPreflight)
      ) {
        return {
          alreadyExists: true,
          submitted: false,
          programMissing: false,
          externalRef: applicantPreflight.externalRef,
          detail: `${cfg.label}: application already completed in portal`,
        };
      }
      let ownedCompletedApplication:
        | {
            externalRef: string;
            portalProgram: string;
            programMismatch: boolean;
          }
        | null = null;
      const tryResumeOwnedApplicant = async (): Promise<boolean> => {
        if (!strictMappedPortal || !applicantPreflight.owned) return false;
        await page
          .goto(agencyUrl + "track-application", {
            waitUntil: "domcontentloaded",
            timeout: 60000,
          })
          .catch(() => {});
        await page.waitForTimeout(7000);
        await filterTrackApplicant(profile.email);
        const emailPattern = new RegExp(
          profile.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          "i",
        );
        const rows = page.locator("tr").filter({ hasText: emailPattern });
        if ((await rows.count().catch(() => 0)) !== 1) return false;
        const row = rows.first();
        const rowText = await row.innerText().catch(() => "");
        const mailto =
          (await row
            .locator('a[href^="mailto:"]')
            .first()
            .getAttribute("href")
            .catch(() => "")) || "";
        const rowEmail = (
          (await row
            .locator('[data-label="Email"]')
            .first()
            .innerText()
            .catch(() => "")) || ""
        )
          .replace(/\s+/g, " ")
          .trim();
        if (
          !isOwnedSalesforceApplicant({
            firstName: profile.firstName,
            lastName: profile.lastName,
            email: profile.email,
            rowName: rowText,
            rowEmail: mailto || rowEmail,
          })
        ) {
          return false;
        }
        const selectors = row.locator(
          'input[type="radio"],input[type="checkbox"]',
        );
        if ((await selectors.count().catch(() => 0)) === 1) {
          await selectors.first().check({ force: true }).catch(() => {});
        }
        let actions = row.getByRole("button", {
          name: /complete application|continue application|edit application|view application/i,
        });
        let actionCount = await actions.count().catch(() => 0);
        if (actionCount === 0) {
          // Üsküdar enables a page-level action only after the row selector is
          // checked. It is not a descendant of the selected table row.
          actions = page.getByRole("button", {
            name: /complete application|continue application|edit application|view application/i,
          });
          actionCount = await actions.count().catch(() => 0);
        }
        if (actionCount !== 1) {
          logger.warn(
            `[salesforce:${cfg.key}] owned application resume action is not unique`,
            { actionCount },
          );
          return false;
        }
        const actionLabel = (
          (await actions.first().innerText().catch(() => "")) || ""
        )
          .replace(/\s+/g, " ")
          .trim();
        const popupPromise = page
          .waitForEvent("popup", { timeout: 8000 })
          .catch(() => null);
        let actionClicked = false;
        try {
          await actions.first().click({ timeout: 6000 });
          actionClicked = true;
        } catch {
          logger.warn(
            `[salesforce:${cfg.key}] owned application resume action could not be clicked`,
            { actionLabel },
          );
        }
        const popup = await popupPromise;
        if (popup) {
          await popup
            .waitForLoadState("domcontentloaded", { timeout: 15_000 })
            .catch(() => {});
          const popupUrl = popup.url();
          if (
            popupUrl &&
            new URL(popupUrl).origin === new URL(agencyUrl).origin
          ) {
            await page
              .goto(popupUrl, {
                waitUntil: "domcontentloaded",
                timeout: 60_000,
              })
              .catch(() => {});
          }
          await popup.close().catch(() => {});
        }
        await page.waitForTimeout(4500);
        const appliedProgram = await inspectAppliedPrograms();
        if (appliedProgram) {
          ownedCompletedApplication = {
            externalRef: appliedProgram.externalRef,
            portalProgram: appliedProgram.portalProgram,
            programMismatch: false,
          };
          return false;
        }
        const wizardAfterAction = await onWizard();
        if (wizardAfterAction) return true;

        // Beykent first opens a read-only detail page from the table. Resume
        // only through one uniquely named edit/complete action.
        const detailAction = page.getByRole("button", {
          name: /complete application|continue application|edit application/i,
        });
        const detailActionCount = await detailAction
          .count()
          .catch(() => 0);
        const relevantButtons = (
          await page
            .getByRole("button")
            .allInnerTexts()
            .catch(() => [])
        )
          .map((text: string) => text.replace(/\s+/g, " ").trim())
          .filter((text: string) =>
            /application|edit|complete|continue|view/i.test(text),
          )
          .slice(0, 12);
        logger.info(
          `[salesforce:${cfg.key}] owned application resume state`,
          {
            actionLabel,
            actionClicked,
            popup: Boolean(popup),
            path: new URL(page.url()).pathname,
            wizardAfterAction,
            detailActionCount,
            relevantButtons,
          },
        );
        const detailText = await readPageText();
        const externalRef =
          (
            detailText.match(
              /\b[A-Z]{2,4}-\d{4,}\b/,
            ) || []
          )[0] || "";
        if (
          /application has been successfully sent/i.test(detailText) &&
          externalRef
        ) {
          const portalProgram = (
            (await page
              .locator('[data-label="Program Name"]')
              .first()
              .innerText()
              .catch(() => "")) || ""
          )
            .replace(/\s+/g, " ")
            .trim();
          const expectedTarget = strictMappedPortal
            ? resolveSalesforceProgramTarget(
                profile.programName,
                profile.programNameMap,
                profile.programNameMapGeneral,
              )
            : {
                label: profile.programName,
                source: "normalized" as const,
                ambiguous: false,
              };
          const expectedCandidates =
            salesforcePortalProgramCandidates(expectedTarget);
          ownedCompletedApplication = {
            externalRef,
            portalProgram,
            programMismatch:
              Boolean(portalProgram) &&
              expectedCandidates.length > 0 &&
              !expectedCandidates.some(
                (candidate) =>
                  fold(candidate) === fold(portalProgram),
              ),
          };
          return false;
        }
        if (
          cfg.key === "beykent" &&
          process.env.PORTAL_DIAGNOSTIC_CAPTURE === "1"
        ) {
          await page
            .screenshot({
              path: "/tmp/beykent-resume-state.png",
              fullPage: true,
            })
            .catch(() => {});
        }
        if (detailActionCount !== 1) return false;
        await detailAction.first().click({ timeout: 6000 }).catch(() => {});
        await page.waitForTimeout(4500);
        return onWizard();
      };
      await tryResumeOwnedApplicant();
      if (ownedCompletedApplication) {
        const completed = ownedCompletedApplication as {
          externalRef: string;
          portalProgram: string;
          programMismatch: boolean;
        };
        const completedResult: SubmitResult = {
          alreadyExists: true,
          submitted: false,
          programMissing: false,
          externalRef: completed.externalRef,
          detail: completed.programMismatch
            ? `${cfg.label}: student already has a completed portal application for a different programme`
            : `${cfg.label}: application already completed in portal`,
          meta: {
            existingPortalApplication: true,
            programMismatch: completed.programMismatch,
            ...(completed.portalProgram
              ? { portalProgram: completed.portalProgram }
              : {}),
          },
        };
        markSalesforceVerifiedSuccess(
          completedResult,
          "exact_application_row",
        );
        return completedResult;
      }
      for (let attempt = 0; attempt < 3 && !(await onWizard()); attempt++) await gotoAppForm();
      await page.waitForTimeout(2000);

      const DUP = /already an application for this (passport|email)|already exists/i;
      // Existing-application detection on the Applicant Detail page: an
      // application number like "SU260169828" means a record already exists —
      // never open a NEW application for the same student.
      const APP_NUM = /\b[A-Z]{2,3}\d{6,}\b/;
      const result: any = { alreadyExists: false, submitted: false, programMissing: false };
      const bodyText = readPageText;
      const has = async (sel: string): Promise<boolean> => { try { return (await page.locator(sel).count()) > 0; } catch (e) { return false; } };
      const hasVisible = async (sel: string): Promise<boolean> => {
        try {
          const controls = page.locator(sel);
          const count = await controls.count();
          for (let i = 0; i < count; i++) {
            if (await controls.nth(i).isVisible().catch(() => false)) return true;
          }
          return false;
        } catch {
          return false;
        }
      };
      const typeInto = async (sel: string, v?: string | number): Promise<boolean> => {
        if (v === undefined || v === null || v === "") return false;
        try {
          const loc = page.locator(sel);
          const cnt = await loc.count();
          let target: any = null;
          for (let i = 0; i < cnt; i++) {
            if (await loc.nth(i).isVisible().catch(() => false)) {
              target = loc.nth(i);
              break;
            }
          }
          if (!target) return false;
          const expected = String(v);
          await target.fill(expected);
          let current = await target.inputValue().catch(() => "");
          if (current !== expected) {
            await target.click();
            await target.fill("");
            await target.pressSequentially(expected, { delay: 45 });
            current = await target.inputValue().catch(() => "");
          }
          await target.press("Tab").catch(() => {});
          return (
            current === expected &&
            (await target.getAttribute("aria-invalid").catch(() => null)) !==
              "true"
          );
        } catch {
          return false;
        }
      };
      const fill = typeInto;
      const visibleControls = async (locator: any): Promise<any[]> => {
        const visible: any[] = [];
        const count = await locator.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          if (await locator.nth(i).isVisible().catch(() => false)) {
            visible.push(locator.nth(i));
          }
        }
        return visible;
      };
      const fillAndReadUnique = async (
        locator: any,
        value?: string | number,
      ): Promise<{ value: string; invalid: boolean; found: boolean }> => {
        if (value === undefined || value === null || String(value) === "") {
          return { value: "", invalid: false, found: false };
        }
        const controls = await visibleControls(locator);
        if (controls.length !== 1) {
          return { value: "", invalid: false, found: false };
        }
        const control = controls[0];
        const expected = String(value);
        try {
          await control.fill(expected);
          let current = await control.inputValue().catch(() => "");
          if (current !== expected) {
            await control.click();
            await control.fill("");
            await control.pressSequentially(expected, { delay: 45 });
            current = await control.inputValue().catch(() => "");
          }
          await control.press("Tab").catch(() => {});
          await page.waitForTimeout(180);
          current = await control.inputValue().catch(() => "");
          return {
            value: current,
            invalid:
              (await control
                .getAttribute("aria-invalid")
                .catch(() => null)) === "true",
            found: true,
          };
        } catch {
          return { value: "", invalid: false, found: true };
        }
      };
      const readValidationMessages = async (): Promise<string[]> =>
        (
          await page
            .locator(
              '[role="alert"],.slds-form-element__help,[aria-invalid="true"]',
            )
            .allInnerTexts()
            .catch(() => [])
        )
          .map((text: string) => text.replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .slice(0, 8);
      const selByName = async (name: string, label?: string): Promise<boolean> => {
        try {
          const s = page.locator(`select[name="${name}"]`).first();
          if (!(await s.count())) return false;
          if (!label) {
            if (strictMappedPortal) return false;
            await s.selectOption({ index: 1 });
            return Boolean(await s.inputValue());
          }
          try {
            await s.selectOption({ label });
          } catch {
            if (strictMappedPortal) return false;
            await s.selectOption({ index: 1 });
          }
          const selected = await s
            .locator("option:checked")
            .first()
            .innerText()
            .catch(() => "");
          return (
            Boolean(await s.inputValue().catch(() => "")) &&
            (!strictMappedPortal ||
              fold(selected) === fold(label) ||
              fold(selected).includes(fold(label)))
          );
        } catch {
          return false;
        }
      };
      const selByNamePattern = async (
        name: string,
        pattern: RegExp,
      ): Promise<boolean> => {
        try {
          const select = page.locator(`select[name="${name}"]`).first();
          if (!(await select.count())) return false;
          const options = select.locator("option");
          const matches: Array<{ value: string; label: string }> = [];
          for (let index = 0; index < await options.count(); index++) {
            const option = options.nth(index);
            const label =
              ((await option.innerText().catch(() => "")) || "")
                .replace(/\s+/g, " ")
                .trim();
            const value = (await option.getAttribute("value").catch(() => "")) || "";
            if (pattern.test(label)) matches.push({ value, label });
          }
          if (matches.length !== 1 || !matches[0].value) {
            if (cfg.key === "halic") {
              const available = [];
              for (let index = 0; index < await options.count(); index++) {
                const option = options.nth(index);
                available.push({
                  label:
                    ((await option.innerText().catch(() => "")) || "")
                      .replace(/\s+/g, " ")
                      .trim(),
                  value:
                    (await option.getAttribute("value").catch(() => "")) || "",
                });
              }
              logger.warn(`[salesforce:${cfg.key}] select pattern options`, {
                name,
                pattern: String(pattern),
                options: JSON.stringify(available),
              });
            }
            return false;
          }
          await select.selectOption(matches[0].value);
          const selected = await select
            .locator("option:checked")
            .first()
            .innerText()
            .catch(() => "");
          return fold(selected) === fold(matches[0].label);
        } catch {
          return false;
        }
      };
      const selLightningByName = async (
        name: string,
        label: string,
      ): Promise<boolean> => {
        const escapedName = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const control = page
          .locator(`[name="${escapedName}"]`)
          .filter({ visible: true })
          .first();
        if (!(await control.count().catch(() => 0))) return false;
        try {
          await control.click({ timeout: 4000 });
          await page.waitForTimeout(500);
          const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const options = page.getByRole("option", {
            name: new RegExp(`^\\s*${escapedLabel}\\s*$`, "i"),
          });
          const visibleOptions = await visibleControls(options);
          if (visibleOptions.length !== 1) return false;
          await visibleOptions[0].click({ timeout: 4000 });
          await page.waitForTimeout(350);
          const value =
            (await control.inputValue().catch(() => "")) ||
            (await control.innerText().catch(() => "")) ||
            (await control.getAttribute("data-value").catch(() => "")) ||
            "";
          return fold(value).includes(fold(label));
        } catch {
          return false;
        }
      };
      const clickNext = async (): Promise<boolean> => {
        const candidates = [
          page.getByRole("button", {
            name: /^\s*(next|save\s*(?:and|&)\s*next|ileri|kaydet\s*(?:ve|&)\s*ilerle|sonraki|devam)\s*$/i,
          }),
          page.getByRole("button", {
            name: /create new application|add application|create application/i,
          }),
        ];
        for (const locator of candidates) {
          const visible: any[] = [];
          for (let index = 0; index < await locator.count(); index++) {
            const button = locator.nth(index);
            if (await button.isVisible().catch(() => false)) {
              visible.push(button);
            }
          }
          if (visible.length !== 1) continue;
          try {
            await visible[0].click({ timeout: 6000 });
            return true;
          } catch {
            return false;
          }
        }
        return false;
      };
      const setBinaryAnswer = async (
        question: RegExp,
        answer: "Yes" | "No",
      ): Promise<boolean> => {
        const groups = page
          .locator("fieldset,.slds-form-element,[role=radiogroup]")
          .filter({ hasText: question });
        const groupCandidates: Array<{
          group: any;
          radioCount: number;
          textLength: number;
        }> = [];
        for (let groupIndex = 0; groupIndex < await groups.count(); groupIndex++) {
          const group = groups.nth(groupIndex);
          if (!(await group.isVisible().catch(() => false))) continue;
          const radioCount = await group
            .locator('input[type="radio"],[role="radio"]')
            .count()
            .catch(() => 0);
          if (radioCount < 2) continue;
          const textLength = (
            (await group.innerText().catch(() => "")) || ""
          ).replace(/\s+/g, " ").length;
          groupCandidates.push({ group, radioCount, textLength });
        }
        if (groupCandidates.length === 0) return false;
        groupCandidates.sort(
          (left, right) =>
            Math.abs(left.radioCount - 2) - Math.abs(right.radioCount - 2) ||
            left.textLength - right.textLength,
        );
        const best = groupCandidates[0];
        const equallySpecific = groupCandidates.filter(
          (candidate) =>
            candidate.radioCount === best.radioCount &&
            candidate.textLength === best.textLength,
        );
        if (equallySpecific.length !== 1) return false;

        const controls = best.group.locator(
          'input[type="radio"],[role="radio"]',
        );
        const candidates = [];
        for (let index = 0; index < await controls.count(); index++) {
          const control = controls.nth(index);
          const id = (await control.getAttribute("id").catch(() => "")) || "";
          let labelText = "";
          if (id) {
            const label = page.locator(
              `label[for="${id.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`,
            );
            if ((await label.count().catch(() => 0)) === 1) {
              labelText = await label.innerText().catch(() => "");
            }
          }
          if (!labelText) {
            labelText = await control
              .locator("xpath=ancestor::label[1]")
              .innerText()
              .catch(() => "");
          }
          candidates.push({
            index,
            value: await control.getAttribute("value").catch(() => null),
            dataValue: await control
              .getAttribute("data-value")
              .catch(() => null),
            ariaLabel: await control
              .getAttribute("aria-label")
              .catch(() => null),
            label: labelText,
            text: await control.innerText().catch(() => ""),
          });
        }
        const targetIndex = chooseSalesforceBinaryCandidate(
          candidates,
          answer,
        );
        if (targetIndex == null) return false;
        const target = controls.nth(targetIndex);
        try {
          if (
            (await target.getAttribute("type").catch(() => null)) === "radio"
          ) {
            await target.check({ force: true });
          } else {
            await target.click({ force: true });
          }
        } catch {
          return false;
        }
        await target.evaluate((node: HTMLElement) => {
          node.dispatchEvent(new Event("input", { bubbles: true }));
          node.dispatchEvent(new Event("change", { bubbles: true }));
          node.dispatchEvent(new Event("blur", { bubbles: true }));
        }).catch(() => {});
        const checked =
          (await target.isChecked().catch(() => false)) ||
          (await target.getAttribute("aria-checked").catch(() => null)) ===
            "true";
        const invalid =
          (await target.getAttribute("aria-invalid").catch(() => null)) ===
          "true";
        return checked && !invalid;
      };
      const readActiveStage = async (): Promise<SalesforceStage> => {
        const stageName = page.locator(".slds-path__stage-name").first();
        if (
          (await stageName.count().catch(() => 0)) &&
          (await stageName.isVisible().catch(() => false))
        ) {
          const marker = await stageName.innerText().catch(() => "");
          const stage = parseSalesforceStageMarker(marker);
          if (stage) return stage;
        }
        const current = page.locator(
          [
            ".slds-path__item.slds-is-current",
            ".slds-progress__item.slds-is-active",
            ".slds-progress__item.slds-is-current",
            '[aria-current="step"]',
          ].join(","),
        );
        const count = await current.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          const item = current.nth(i);
          if (!(await item.isVisible().catch(() => false))) continue;
          const text = ((await item.innerText().catch(() => "")) || "").trim();
          for (const line of text.split(/\r?\n/)) {
            const stage = normalizeSalesforceStage(line.trim());
            if (stage) return stage;
          }
          const stage = normalizeSalesforceStage(text);
          if (stage) return stage;
        }

        // Control-based inference is used only when the path component exposes
        // no active marker. Future step labels in body text are never evidence.
        if (
          await hasVisible(
            'input[placeholder*="search program" i],input[placeholder*="keyword" i]',
          )
        ) return "Program Selection";
        if (await hasVisible('select[name="Gender"]')) {
          return "Personal Information";
        }
        if (
          await hasVisible(
            'select[name="Country_of_Secondary_School"],input[name="Name_of_Secondary_School"]',
          )
        ) return "Educational Information";
        if (await hasVisible("input[type=file]")) return "Documents";
        const submit = page
          .getByRole("button", {
            name: /^\s*(submit(?:\s+application)?|complete(?:\s+application)?|tamamla|gönder|finish|onayla)\s*$/i,
          })
          .first();
        if (
          (await submit.count()) &&
          (await submit.isVisible().catch(() => false))
        ) return "Review and Submit";
        return null;
      };
      const verifyTrackCompletion = async (): Promise<{
        verified: boolean;
        externalRef?: string;
        applicationStatus?: string;
        trackStage?: string;
      }> => {
        const trackApplicant = await inspectOwnedApplicant();
        if (!trackApplicant.owned) {
          return { verified: false };
        }
        return {
          verified: hasSalesforceCompletionProof(trackApplicant),
          ...(trackApplicant.externalRef
            ? { externalRef: trackApplicant.externalRef }
            : {}),
          applicationStatus: trackApplicant.applicationStatus,
          trackStage: trackApplicant.trackStage,
        };
      };
      const dobm = String(profile.dateOfBirth || "").match(/(\d{4})-(\d{2})-(\d{2})/);
      const dobStr = dobm
        ? cfg.key === "halic"
          ? dobm[3] + "/" + dobm[2] + "/" + dobm[1]
          : dobm[2] + "/" + dobm[3] + "/" + dobm[1]
        : strictMappedPortal
          ? ""
          : "01/01/2000";
      let exactApplicantReadback = false;
      for (let step = 0; step < 12; step++) {
        await page.waitForTimeout(2500);
        const txt = await bodyText();
        const activeStage = await readActiveStage();
        const appliedProgram = await inspectAppliedPrograms();
        if (appliedProgram) {
          result.alreadyExists = true;
          markSalesforceVerifiedSuccess(
            result,
            "exact_application_row",
          );
          result.externalRef = appliedProgram.externalRef;
          result.detail = `${cfg.label}: application already completed in portal`;
          result.meta = {
            ...result.meta,
            existingPortalApplication: true,
            portalProgram: appliedProgram.portalProgram,
          };
          break;
        }
        if (
          dryRun &&
          activeStage === "Review and Submit" &&
          /review your application before submit/i.test(txt)
        ) {
          if (cfg.key === "halic") {
            const reviewButtons = await page
              .locator('button:visible,[role="button"]:visible')
              .evaluateAll((nodes: Element[]) =>
                nodes.slice(0, 40).map((node: Element) => ({
                  text: (node.textContent || "").replace(/\s+/g, " ").trim(),
                  disabled:
                    (node as HTMLButtonElement).disabled ||
                    node.getAttribute("aria-disabled") === "true",
                  name: node.getAttribute("name"),
                  title: node.getAttribute("title"),
                })),
              )
              .catch(() => []);
            logger.info(`[salesforce:${cfg.key}] dry review controls`, {
              buttons: JSON.stringify(reviewButtons),
            });
          }
          result.dryReachedFinal = true;
          break;
        }
        if (DUP.test(txt)) {
          if (exactApplicantReadback && !applicantPreflight.owned) {
            const clicked = await clickNext();
            if (clicked) {
              await page.waitForTimeout(7000);
              continue;
            }
          }
          const duplicateDisposition = salesforceDuplicateDisposition({
            activeStage,
            ownedApplicant: applicantPreflight.owned,
            completionProved: hasSalesforceCompletionProof(
              applicantPreflight,
            ),
          });
          if (duplicateDisposition === "continue") {
            logger.info(
              `[salesforce:${cfg.key}] stale applicant duplicate notice ignored after verified wizard advance`,
              { activeStage },
            );
          } else if (duplicateDisposition === "resume") {
            const resume = page
              .getByRole("button", {
                name: /create new application|add application|continue application|complete application/i,
              })
              .first();
            if (await resume.count()) {
              await resume.click({ timeout: 6000 }).catch(() => {});
              await page.waitForTimeout(4000);
              continue;
            }
            if (!activeStage) {
              const beforeResume = (await bodyText()).replace(/\s+/g, " ");
              const clicked = await clickNext();
              if (clicked) {
                await page.waitForTimeout(5000);
                const afterResume = (await bodyText()).replace(/\s+/g, " ");
                const resumedStage = await readActiveStage();
                if (
                  resumedStage ||
                  beforeResume !== afterResume ||
                  (await page
                    .getByPlaceholder(/search program name|keyword/i)
                    .count()) > 0
                ) {
                  continue;
                }
              }
              result.stuckStep = step;
              result.detail =
                `${cfg.label}: owned applicant exists but application continuation did not advance`;
              break;
            }
          } else if (duplicateDisposition === "already_exists") {
            result.alreadyExists = true;
            break;
          } else {
            if (cfg.key === "halic") {
              const buttons = await page
                .locator('button:visible,[role="button"]:visible')
                .evaluateAll((nodes: Element[]) =>
                  nodes.slice(0, 40).map((node: Element) => ({
                    text: (node.textContent || "").replace(/\s+/g, " ").trim(),
                    disabled:
                      (node as HTMLButtonElement).disabled ||
                      node.getAttribute("aria-disabled") === "true",
                  })),
                )
                .catch(() => []);
              logger.warn(`[salesforce:${cfg.key}] existing applicant controls`, {
                buttons: JSON.stringify(buttons),
              });
            }
            result.stuckStep = step;
            result.detail =
              `${cfg.label}: applicant already exists, but no owned application continuation or completion proof was found`;
            break;
          }
        }
        if (
          !activeStage &&
          /application\s*number/i.test(txt) &&
          APP_NUM.test(txt)
        ) {
          result.stuckStep = step;
          result.detail =
            `${cfg.label}: application reference exists, but completion could not be proved`;
          break;
        }
        const before = (await bodyText()).replace(/\s+/g, " ").slice(0, 600);
        if ((await has("input[name=\"Student_First_Name\"]")) || ((await has("input[name=\"First_Name\"]")) && !(await has("select[name=\"Gender\"]")))) {
          if (strictMappedPortal) {
            const firstNameProof = await fillAndReadUnique(
              page.locator(
                'input[name="Student_First_Name"],input[name="First_Name"]',
              ),
              profile.firstName,
            );
            const lastNameProof = await fillAndReadUnique(
              page.locator(
                'input[name="Student_Last_Name"],input[name="Last_Name"]',
              ),
              profile.lastName,
            );
            const passportProof = await fillAndReadUnique(
              page.locator(
                'input[name="Student_Passport_Number"],input[name="Passport_Number"]',
              ),
              profile.passportNumber,
            );

            // Beykent exposes this as type=text with a dynamic
            // "<student name>'s Email" label and no stable name/placeholder.
            // Accessible-label lookup is therefore the primary selector.
            let emailLocator = page.getByLabel(/email/i);
            if ((await visibleControls(emailLocator)).length !== 1) {
              emailLocator = page.locator(
                [
                  'input[type="email"]',
                  'input[name*="email" i]',
                  'input[name*="mail" i]',
                  'input[placeholder*="@"]:not([type="password"])',
                ].join(","),
              );
            }
            const emailProof = await fillAndReadUnique(
              emailLocator,
              profile.email,
            );
            const invalidFields = [
              ...(firstNameProof.invalid ? ["firstName"] : []),
              ...(lastNameProof.invalid ? ["lastName"] : []),
              ...(passportProof.invalid ? ["passportNumber"] : []),
              ...(emailProof.invalid ? ["email"] : []),
            ];
            const applicantFailures = salesforceApplicantReadbackFailures(
              {
                firstName: profile.firstName,
                lastName: profile.lastName,
                passportNumber: profile.passportNumber,
                email: profile.email,
              },
              {
                firstName: firstNameProof.value,
                lastName: lastNameProof.value,
                passportNumber: passportProof.value,
                email: emailProof.value,
                invalidFields,
              },
            );
            logger.info(`[salesforce:${cfg.key}] applicant readback`, {
              firstName: !applicantFailures.includes("firstName"),
              lastName: !applicantFailures.includes("lastName"),
              passportNumber: !applicantFailures.includes("passportNumber"),
              email: !applicantFailures.includes("email"),
            });
            if (applicantFailures.length > 0) {
              result.stuckStep = step;
              result.detail =
                `${cfg.label}: applicant fields could not be verified (${applicantFailures.join(", ")})`;
              break;
            }
            exactApplicantReadback = true;
          } else {
            await typeInto("input[name=\"Student_First_Name\"]", profile.firstName);
            await typeInto("input[name=\"First_Name\"]", profile.firstName);
            await typeInto("input[name=\"Student_Last_Name\"]", profile.lastName);
            await typeInto("input[name=\"Last_Name\"]", profile.lastName);
            await typeInto("input[name=\"Student_Passport_Number\"]", profile.passportNumber);
            await typeInto("input[name*=Passport i]", profile.passportNumber);
            await typeInto("input[placeholder=\"you@example.com\"]", profile.email);
            await typeInto("input[type=email]", profile.email);
            await typeInto("input[placeholder*=\"@\"]:not([type=password])", profile.email);
          }
          if (!strictMappedPortal) {
            try { const __cb = page.locator("input[role=combobox], input[aria-autocomplete=list], input[aria-autocomplete=both], input[id*=combobox]"); const __cbn = await __cb.count(); for (let __i = 0; __i < __cbn; __i++) { const __e = __cb.nth(__i); if (!(await __e.isVisible().catch(() => false))) continue; if ((await __e.inputValue().catch(() => "x")) !== "") continue; await __e.click().catch(() => {}); await __e.fill(profile.nationality || "Turkey").catch(() => {}); await page.waitForTimeout(1500); const __o = page.locator("[role=option], lightning-base-combobox-item, .slds-listbox__option, li[role=option]").first(); if (await __o.count()) await __o.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(600); } } catch (e) {}
          }
          if (!strictMappedPortal) {
            try { const __cand = page.locator("input[required], input[aria-required=\"true\"]"); const __cn = await __cand.count(); for (let __ci = 0; __ci < __cn; __ci++) { const __el = __cand.nth(__ci); if (!(await __el.isVisible().catch(() => false))) continue; const __ty = (await __el.getAttribute("type").catch(() => "")) || "text"; if (__ty === "radio" || __ty === "checkbox") continue; const __idr = ((await __el.getAttribute("id").catch(() => "")) || "") + ((await __el.getAttribute("role").catch(() => "")) || "") + ((await __el.getAttribute("aria-autocomplete").catch(() => "")) || ""); if (/combobox|list|both/i.test(__idr)) continue; const __cv = await __el.inputValue().catch(() => "x"); if (__cv === "") { await __el.fill(profile.email).catch(() => {}); break; } } } catch (e) {}
          }
          try { const cz = page.getByLabel(/citizenship|vatanda/i).first(); if ((await cz.count()) && (await cz.isVisible().catch(() => false))) { await cz.click().catch(() => {}); await cz.fill(profile.nationality || "Turkey").catch(() => {}); await page.waitForTimeout(1500); const o = strictMappedPortal ? page.getByRole("option", { name: new RegExp("^" + profile.nationality.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i") }).first() : page.locator("[role=option],lightning-base-combobox-item,li").first(); if (await o.count()) await o.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(700); } } catch (e) {}
          if (!strictMappedPortal) {
            try { const eml = page.getByLabel(/applicant email|email address/i).first(); if ((await eml.count()) && (await eml.isVisible().catch(() => false)) && !(await eml.inputValue().catch(() => "x")) && profile.email) { await eml.click().catch(() => {}); await page.keyboard.type(profile.email, { delay: 40 }).catch(() => {}); await eml.press("Tab").catch(() => {}); } } catch (e) {}
          }
          if (!(await clickNext())) {
            result.stuckStep = step;
            result.detail = `${cfg.label}: applicant Next control was not found`;
            break;
          }
          let applicantMoved = false;
          for (let t = 0; t < 12; t++) {
            await page.waitForTimeout(750);
            const applicantStillVisible =
              (await hasVisible('input[name="Student_First_Name"]')) ||
              ((await hasVisible('input[name="First_Name"]')) &&
                !(await hasVisible('select[name="Gender"]')));
            if (
              DUP.test(await bodyText()) ||
              (await hasVisible(
                'input[placeholder*="search program" i],input[placeholder*="keyword" i]',
              )) ||
              !applicantStillVisible
            ) {
              applicantMoved = true;
              break;
            }
          }
          if (!applicantMoved) {
            const validation = await readValidationMessages();
            result.stuckStep = step;
            result.detail =
              `${cfg.label}: applicant screen did not advance` +
              (validation.length
                ? ` — validation: ${validation.join(" | ")}`
                : "");
            break;
          }
          continue;
        } else if (/available programs/i.test(txt) || (await page.getByPlaceholder(/search program name|keyword/i).count())) {
          const programTarget = strictMappedPortal
            ? resolveSalesforceProgramTarget(
                profile.programName,
                profile.programNameMap,
                profile.programNameMapGeneral,
              )
            : {
                label: profile.programName,
                source: "normalized" as const,
                ambiguous: false,
              };
          if (programTarget.ambiguous) {
            result.stuckStep = step;
            result.detail =
              `${cfg.label}: programme mapping is ambiguous for the requested CRM programme`;
            break;
          }
          const programCandidates =
            salesforcePortalProgramCandidates(programTarget);
          // Boş program adı match-all regex üretir (yanlış program seçer) → güvenli çıkış.
          if (!programCandidates.length) {
            result.programMissing = true;
            logger.warn("[salesforce:" + cfg.key + "] program adı boş — Available Programs atlanıyor", { crmProgram: profile.programName });
            break;
          }
          // Live Salesforce builds use both "Programme (English)" and
          // "Programme - English". Search each deterministic spelling and
          // accept only one exact visible label; never fall back to a similar
          // or first programme.
          const kw = page
            .getByPlaceholder(/search program name|keyword/i)
            .first();
          let portalProg = programCandidates[0];
          let visibleExactLabels: any[] = [];
          for (const candidate of programCandidates) {
            try {
              if (await kw.count()) {
                await kw.fill("");
                await kw.fill(candidate);
                await kw.press("Tab").catch(() => {});
                await page.waitForTimeout(2500);
              } else {
                await page.waitForTimeout(1200);
              }
            } catch {
              await page.waitForTimeout(1200);
            }

            const escapedCandidate = candidate.replace(
              /[.*+?^${}()|[\]\\]/g,
              "\\$&",
            );
            const exactCandidateLabels = page.getByText(
              new RegExp(`^\\s*${escapedCandidate}\\s*$`, "i"),
            );
            const visibleCandidates: any[] = [];
            const candidateCount = await exactCandidateLabels
              .count()
              .catch(() => 0);
            for (let i = 0; i < candidateCount; i++) {
              if (
                await exactCandidateLabels
                  .nth(i)
                  .isVisible()
                  .catch(() => false)
              ) {
                visibleCandidates.push(exactCandidateLabels.nth(i));
              }
            }
            if (visibleCandidates.length > 0) {
              portalProg = candidate;
              visibleExactLabels = visibleCandidates;
              break;
            }
          }
          // Teşhis: filtre sonrası kart metinlerini dök (mapping doğrulama için)
          try {
            const cards = page.locator('li, article, lightning-card, [class*="card" i], [class*="tile" i], tr');
            const cn = Math.min(await cards.count().catch(() => 0), 40);
            const labels: string[] = [];
            for (let i = 0; i < cn; i++) {
              const t = ((await cards.nth(i).innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
              if (t && /select/i.test(t) && t.length < 160) labels.push(t.slice(0, 120));
            }
            logger.info("[salesforce:" + cfg.key + "] Available Programs kartları", {
              portalProg,
              programCandidates,
              mappingSource: programTarget.source,
              count: labels.length,
              sample: labels.slice(0, 40),
            });
          } catch (e) {}
          // KÖK NEDEN: kartlar KAPALI shadow root'ta; page.evaluate manuel walk giremez (cards:0).
          // Playwright locator'ları kapalı shadow'u deler → seçimi tamamen Playwright ile yap.
          const escapedPortalProgram = portalProg.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&",
          );
          const exactProgramLabel = page.getByText(
            new RegExp(`^\\s*${escapedPortalProgram}\\s*$`, "i"),
          );
          const exactProgramButtons: any[] = [];
          if (!visibleExactLabels.length) {
            const exactLabelCount = await exactProgramLabel
              .count()
              .catch(() => 0);
            for (let i = 0; i < exactLabelCount; i++) {
              if (
                await exactProgramLabel
                  .nth(i)
                  .isVisible()
                  .catch(() => false)
              ) {
                visibleExactLabels.push(exactProgramLabel.nth(i));
              }
            }
          }
          // Haliç currently splits the programme label across nested shadow
          // nodes, so getByText(exact) sees no single matching element. Resolve
          // the visible Select button through its nearest programme card and
          // require one exact normalized card readback.
          if (!visibleExactLabels.length) {
            const programmeCards = page.locator("li,article,tr");
            const programmeCardCount = await programmeCards
              .count()
              .catch(() => 0);
            for (let i = 0; i < programmeCardCount; i++) {
              const card = programmeCards.nth(i);
              if (!(await card.isVisible().catch(() => false))) continue;
              const cardText = (
                (await card.innerText().catch(() => "")) || ""
              )
                .replace(/\s+/g, " ")
                .trim();
              const matchedCandidate = programCandidates.find((candidate) =>
                salesforceProgramCardMatchesCandidate(cardText, candidate),
              );
              if (!matchedCandidate) continue;
              const nativeButtons = card.locator("button");
              const nativeButtonCount = await nativeButtons
                .count()
                .catch(() => 0);
              const visibleButtons: any[] = [];
              for (let buttonIndex = 0; buttonIndex < nativeButtonCount; buttonIndex++) {
                const button = nativeButtons.nth(buttonIndex);
                if (await button.isVisible().catch(() => false)) {
                  visibleButtons.push(button);
                }
              }
              if (visibleButtons.length !== 1) continue;
              portalProg = matchedCandidate;
              exactProgramButtons.push(visibleButtons[0]);
            }
          }
          if (!visibleExactLabels.length && !exactProgramButtons.length) {
            const selectButtons = page.getByRole("button", {
              name: /^\s*select\s*$/i,
            });
            const selectCount = await selectButtons.count().catch(() => 0);
            for (let i = 0; i < selectCount; i++) {
              const button = selectButtons.nth(i);
              if (!(await button.isVisible().catch(() => false))) continue;
              let cardText = "";
              for (const ancestor of [
                "xpath=ancestor::li[1]",
                "xpath=ancestor::article[1]",
                "xpath=ancestor::tr[1]",
              ]) {
                const card = button.locator(ancestor);
                if (!(await card.count().catch(() => 0))) continue;
                cardText = (
                  (await card.innerText().catch(() => "")) || ""
                )
                  .replace(/\s+/g, " ")
                  .trim();
                if (cardText) break;
              }
              const matchedCandidate = programCandidates.find((candidate) =>
                salesforceProgramCardMatchesCandidate(cardText, candidate),
              );
              if (!matchedCandidate) continue;
              portalProg = matchedCandidate;
              exactProgramButtons.push(button);
            }
          }
          const cartBtn = page
            .locator(
              'button[name*="selected" i],button[title*="selected" i],button[aria-label*="selected" i]',
            )
            .first();
          const cartText = page
            .locator("button")
            .filter({
              hasText:
                /^\s*selected\s+program(?:me)?s?(?:\s*[:([]?\s*\d+\s*[)\]]?)?\s*$/i,
            });
          const readCartN = async () => {
            const controls: any[] = [];
            if (await cartBtn.count()) controls.push(cartBtn);
            const textCount = await cartText.count().catch(() => 0);
            for (let i = 0; i < textCount; i++) {
              const control = cartText.nth(i);
              if (await control.isVisible().catch(() => false)) {
                controls.push(control);
              }
            }
            for (const control of controls) {
              const text = [
                await control.innerText().catch(() => ""),
                await control.getAttribute("aria-label").catch(() => ""),
                await control.getAttribute("title").catch(() => ""),
              ]
                .filter(Boolean)
                .join(" ")
                .replace(/\s+/g, " ")
                .trim();
              const count = text.match(
                /(?:\(|\[|:\s*)(\d+)(?:\)|\]|\s*$)/,
              )?.[1];
              if (count) return count;
            }
            return "0";
          };
          let cartN = "0";
          const cardCount = exactProgramButtons.length || visibleExactLabels.length;
          const maxSelectAttempts = strictMappedPortal ? 1 : 2;
          for (let attempt = 1; attempt <= maxSelectAttempts && cartN === "0"; attempt++) {
            if (!cardCount) break;
            if (strictMappedPortal && cardCount !== 1) {
              logger.warn(
                `[salesforce:${cfg.key}] program target ambiguous; count=${cardCount}`,
              );
              break;
            }
            let target = exactProgramButtons[0];
            if (!target) {
              const label = visibleExactLabels[0];
              let row = label.locator("xpath=ancestor::tr[1]");
              if (!(await row.count().catch(() => 0))) {
                row = page
                  .locator(
                    'li,article,lightning-card,[class*="card" i],[class*="tile" i]',
                  )
                  .filter({ has: label })
                  .filter({ hasText: /select/i })
                  .last();
              }
              target = row
                .getByRole("button", { name: /^\s*select\s*$/i })
                .first();
            }
            if (!(await target.count().catch(() => 0))) break;
            await target.scrollIntoViewIfNeeded().catch(() => {});
            const selectCountBefore = await page
              .locator('button[name="select_program"]')
              .count()
              .catch(() => 0);
            const controlBefore = await target
              .evaluate((element: HTMLElement) => element.outerHTML.slice(0, 500))
              .catch(() => "");
            let clicked = false;
            try {
              await target.click({ timeout: 6000 });
              clicked = true;
            } catch {
              try {
                await target.click({ timeout: 6000, force: true });
                clicked = true;
              } catch {
                clicked = false;
              }
            }
            if (!clicked) break;
            await page.waitForTimeout(2400);
            cartN = await readCartN();
            if (cartN === "0") {
              const selectCountAfter = await page
                .locator('button[name="select_program"]')
                .count()
                .catch(() => 0);
              const controlState = [
                await target.innerText().catch(() => ""),
                await target.getAttribute("aria-label").catch(() => ""),
                await target.getAttribute("title").catch(() => ""),
              ]
                .filter(Boolean)
                .join(" ")
                .replace(/\s+/g, " ")
                .trim();
              const selectedState =
                selectCountBefore > 0 &&
                selectCountAfter === selectCountBefore - 1 ||
                /selected|remove|unselect|deselect/i.test(controlState) ||
                (await target.getAttribute("aria-pressed").catch(() => null)) ===
                  "true" ||
                (await target.getAttribute("disabled").catch(() => null)) !==
                  null;
              if (selectedState) cartN = "1";
              const buttonSamples: string[] = [];
              const pageButtons = page.locator("button");
              const pageButtonCount = Math.min(
                await pageButtons.count().catch(() => 0),
                80,
              );
              for (let buttonIndex = 0; buttonIndex < pageButtonCount; buttonIndex++) {
                const buttonText = (
                  (await pageButtons.nth(buttonIndex).innerText().catch(() => "")) ||
                  ""
                )
                  .replace(/\s+/g, " ")
                  .trim();
                if (/select|program/i.test(buttonText) && buttonText.length < 100) {
                  buttonSamples.push(buttonText);
                }
              }
              logger.info(
                `[salesforce:${cfg.key}] programme control readback`,
                {
                  controlBefore,
                  controlState,
                  selectedState,
                  selectCountBefore,
                  selectCountAfter,
                  buttonSamples: buttonSamples.slice(0, 20),
                },
              );
            }
          }
          if (cardCount === 0) {
            result.programMissing = true;
            logger.warn("[salesforce:" + cfg.key + "] program bulunamadı (Available Programs)", { crmProgram: profile.programName, portalProg, cardCount });
            break;
          }
          logger.info("[salesforce:" + cfg.key + "] program Select tıklandı (Playwright/pierce)", { portalProg, cartN, cardCount });
          if (cartN === "0") {
            result.programMissing = true;
            logger.warn("[salesforce:" + cfg.key + "] sepet boş kaldı (Select tıklandı ama sepet artmadı)", { portalProg, cardCount });
            break;
          }
          let advanced = false;
          let cartControl: any = null;
          if (await cartBtn.count()) {
            cartControl = cartBtn;
          } else {
            const textCount = await cartText.count().catch(() => 0);
            for (let i = 0; i < textCount; i++) {
              const control = cartText.nth(i);
              if (await control.isVisible().catch(() => false)) {
                cartControl = control;
                break;
              }
            }
          }
          if (cartControl) {
            await cartControl.click({ timeout: 4000 }).catch(() => {});
            await page.waitForTimeout(1500);
            const selectedProgramLabelCount = await page
              .getByText(
                new RegExp(`^\\s*${escapedPortalProgram}\\s*$`, "i"),
              )
              .count()
              .catch(() => 0);
            if (strictMappedPortal && selectedProgramLabelCount < 1) {
              result.programMissing = true;
              result.detail =
                `${cfg.label}: selected programme readback could not be proved`;
              break;
            }
            const modalSave = page.getByRole("button", { name: /save and next|save & next/i }).first();
            if (await modalSave.count()) {
              await modalSave.click({ timeout: 6000 }).catch(() => {});
              await page.waitForTimeout(3500);
              advanced = (await readActiveStage()) !== "Program Selection";
            }
          }
          if (!advanced) {
            const clickedNext = await clickNext();
            if (clickedNext) {
              await page.waitForTimeout(3500);
              advanced = (await readActiveStage()) !== "Program Selection";
            }
          }
          logger.info("[salesforce:" + cfg.key + "] program seçildi (Save and Next)", { portalProg, cartN, advanced });
          if (strictMappedPortal && !advanced) {
            result.stuckStep = step;
            result.detail =
              `${cfg.label}: programme selection did not advance`;
            break;
          }
          continue;
        } else if (await hasVisible('select[name="Gender"]')) {
          const personalProof: Record<string, boolean> = {};
          personalProof.firstName = await fill(
            cfg.key === "halic"
              ? 'input[name="FirstName"]'
              : 'input[name="First_Name"]',
            profile.firstName,
          );
          personalProof.lastName = await fill(
            cfg.key === "halic"
              ? 'input[name="LastName"]'
              : 'input[name="Last_Name"]',
            profile.lastName,
          );
          personalProof.gender = await selByName(
            "Gender",
            /female/i.test(profile.gender || "") ? "Female" : "Male",
          );
          personalProof.citizenship =
            cfg.key === "halic"
              ? (await selByName("Citizenship_0", profile.nationality)) ||
                (await selLightningByName("Citizenship_0", profile.nationality))
              : await selByName("Citizenship", profile.nationality);
          personalProof.residenceCountry = await selByName(
            "Country_of_Residence",
            profile.nationality,
          );
          if (await has('select[name="Where_did_you_hear_us"]')) {
            personalProof.source = await selByName(
              "Where_did_you_hear_us",
              "University Website",
            );
          }
          const dateControl = page
            .locator('input[name*="Date_of_Birth" i],input[name*="birth" i]')
            .first();
          personalProof.dateOfBirth = false;
          if (await dateControl.count()) {
            await dateControl.click().catch(() => {});
            await dateControl.fill("").catch(() => {});
            await dateControl.pressSequentially(dobStr, { delay: 45 }).catch(() => {});
            await dateControl.press("Tab").catch(() => {});
            const readDate = await dateControl.inputValue().catch(() => "");
            if (cfg.key === "halic" && dobm) {
              const parsed = new Date(readDate);
              personalProof.dateOfBirth =
                !Number.isNaN(parsed.getTime()) &&
                parsed.getUTCFullYear() === Number(dobm[1]) &&
                parsed.getUTCMonth() + 1 === Number(dobm[2]) &&
                parsed.getUTCDate() === Number(dobm[3]);
            } else {
              personalProof.dateOfBirth = Boolean(readDate);
            }
          }
          if (strictMappedPortal) {
            if (/turkish citizenship|türk vatanda/i.test(txt)) {
              personalProof.turkishCitizenship = await setBinaryAnswer(
                /turkish citizenship|türk vatanda/i,
                profile.hasTcId ? "Yes" : "No",
              );
            }
            if (/residence permit|ikamet izni/i.test(txt)) {
              personalProof.residencePermit = await setBinaryAnswer(
                /residence permit|ikamet izni/i,
                "No",
              );
            }
            if (/blue card|mavi kart/i.test(txt)) {
              personalProof.blueCard = await setBinaryAnswer(
                /blue card|mavi kart/i,
                profile.hasBlueCard ? "Yes" : "No",
              );
            }
          }
          if (!strictMappedPortal) {
            try { const cb = page.locator("button[role=combobox],[role=combobox]").first(); if (await cb.count()) { await cb.click({ timeout: 2500 }).catch(() => {}); await page.waitForTimeout(800); const opts = page.locator("[role=option]"); const oc = await opts.count(); for (let i = 0; i < oc; i++) { const ot = (await opts.nth(i).innerText().catch(() => "")) || ""; if (!/none/i.test(ot)) { await opts.nth(i).click({ timeout: 2000 }).catch(() => {}); break; } } } } catch (e) {}
          }
          if (cfg.key === "halic") {
            const phoneDigits = String(profile.phone || "").replace(/\D/g, "");
            const countryCode = profile.nationality === "Bangladesh" ? "880" : "";
            const localPhone =
              countryCode && phoneDigits.startsWith(countryCode)
                ? phoneDigits.slice(countryCode.length)
                : phoneDigits;
            let countryCodeProof = false;
            const phoneCountry = page.locator('button[name="phoneWithCountryCode"]').first();
            if (await phoneCountry.count()) {
              await phoneCountry.click({ timeout: 4000 }).catch(() => {});
              await page.waitForTimeout(400);
              const choices = page.locator(
                '[role="option"],lightning-base-combobox-item,li[role="presentation"]',
              );
              const matchingChoices: any[] = [];
              const choiceTexts: string[] = [];
              for (let index = 0; index < await choices.count(); index++) {
                const choice = choices.nth(index);
                if (!(await choice.isVisible().catch(() => false))) continue;
                const choiceText =
                  ((await choice.innerText().catch(() => "")) || "")
                    .replace(/\s+/g, " ")
                    .trim();
                if (choiceText) choiceTexts.push(choiceText);
                if (/Bangladesh|\+?880/.test(choiceText)) {
                  matchingChoices.push(choice);
                }
              }
              if (matchingChoices.length === 1) {
                await matchingChoices[0]
                  .click({ timeout: 4000 })
                  .catch(() => {});
                countryCodeProof = true;
              } else {
                logger.warn(`[salesforce:${cfg.key}] phone country options`, {
                  matchingCount: matchingChoices.length,
                  choices: choiceTexts.slice(0, 80),
                });
              }
            }
            personalProof.phone =
              countryCodeProof &&
              (await fill('input[name="Mobile_Phone"]', localPhone));
          } else {
            personalProof.phone = await fill(
              'input[name="MobilePhone_Text"]',
              profile.phone,
            );
          }
          personalProof.address = await fill(
            'input[name="Address"]',
            profile.addressStreet || profile.address,
          );
          personalProof.city = await fill(
            'input[name="City"]',
            strictMappedPortal ? profile.addressCity : profile.address,
          );
          if (cfg.key === "halic") {
            personalProof.motherName = await fill(
              'input[name="Mother_s_Name"]',
              profile.motherName,
            );
            personalProof.fatherName = await fill(
              'input[name="Father_s_Name"]',
              profile.fatherName,
            );
          }
          if (strictMappedPortal) {
            const failed = Object.entries(personalProof)
              .filter(([, ok]) => !ok)
              .map(([field]) => field);
            if (failed.length > 0) {
              const controls = await page
                .locator("input,select,textarea,[role=combobox],[role=radio]")
                .evaluateAll((nodes: Element[]) =>
                  nodes.slice(0, 80).map((node: Element) => {
                    const element = node as HTMLInputElement;
                    return {
                      tag: node.tagName,
                      name: element.getAttribute("name"),
                      type: element.getAttribute("type"),
                      id: element.id,
                      ariaLabel: element.getAttribute("aria-label"),
                      value: element.value,
                    };
                  }),
                )
                .catch(() => []);
              const labels = await page
                .locator("label,legend")
                .allInnerTexts()
                .catch(() => []);
              logger.warn(
                `[salesforce:${cfg.key}] personal controls diagnostic`,
                {
                  failed,
                  controls,
                  labels: labels
                    .map((label: string) => label.replace(/\s+/g, " ").trim())
                    .filter(Boolean)
                    .slice(0, 80),
                },
              );
              result.detail =
                `${cfg.label}: personal fields could not be verified (${failed.join(", ")})`;
              result.stuckStep = step;
              break;
            }
          }
          await clickNext();
        } else if (
          (await hasVisible('select[name="Country_of_Secondary_School"]')) ||
          (!strictMappedPortal && /secondary school/i.test(txt))
        ) {
          const educationProof: Record<string, boolean> = {};
          educationProof.schoolName = await fill(
            'input[name="Name_of_Secondary_School"]',
            strictMappedPortal
              ? profile.schoolName
              : profile.schoolName || "High School",
          );
          educationProof.country = await selByName(
            "Country_of_Secondary_School",
            profile.nationality,
          );
          if (strictMappedPortal) {
            if (
              await has(
                'select[name="Choose_the_education_system_of_the_high_school_you_have_graduated_from"]',
              )
            ) {
              educationProof.system = await selByName(
                "Choose_the_education_system_of_the_high_school_you_have_graduated_from",
                "Other",
              );
            }
          } else {
            await selByName("Choose_the_education_system_of_the_high_school_you_have_graduated_from");
          }
          educationProof.gpa = await fill(
            cfg.key === "halic"
              ? 'input[name="GPA"]'
              : 'input[name="GPA_of_Secondary_School"]',
            String(strictMappedPortal ? profile.gpa : profile.gpa || "3"),
          );
          if (cfg.key === "halic") {
            educationProof.graduationYear = await selByName(
              "High_School_Graduation_Year",
              String(profile.graduationYear),
            );
            educationProof.englishProficiency = await selByName(
              "English_Proficiency",
              profile.languageScore ? "Other" : "None",
            );
            if (!educationProof.englishProficiency) {
              educationProof.englishProficiency = await selByNamePattern(
                "English_Proficiency",
                profile.languageScore ? /^\s*other\s*$/i : /^\s*none\s*$/i,
              );
            }
            educationProof.languageScore = await fill(
              'input[name="Language_Exam_Score"]',
              profile.languageScore || "0",
            );
          }
          if (strictMappedPortal) {
            const failed = Object.entries(educationProof)
              .filter(([, ok]) => !ok)
              .map(([field]) => field);
            if (failed.length > 0) {
              if (cfg.key === "halic") {
                const controls = await page
                  .locator("input,select,textarea,[role=combobox]")
                  .evaluateAll((nodes: Element[]) =>
                    nodes.slice(0, 80).map((node: Element) => {
                      const element = node as HTMLInputElement;
                      return {
                        tag: node.tagName,
                        name: element.getAttribute("name"),
                        type: element.getAttribute("type"),
                        id: element.id,
                        value: element.value,
                        options:
                          node instanceof HTMLSelectElement
                            ? Array.from(node.options).map((option) => ({
                                label: option.text,
                                value: option.value,
                              }))
                            : undefined,
                      };
                    }),
                  )
                  .catch(() => []);
                const labels = await page
                  .locator("label,legend")
                  .allInnerTexts()
                  .catch(() => []);
                logger.warn(`[salesforce:${cfg.key}] education controls diagnostic`, {
                  failed,
                  controls,
                  labels: labels
                    .map((label: string) => label.replace(/\s+/g, " ").trim())
                    .filter(Boolean)
                    .slice(0, 80),
                });
              }
              result.detail =
                `${cfg.label}: education fields could not be verified (${failed.join(", ")})`;
              result.stuckStep = step;
              break;
            }
          }
          await clickNext();
        } else if (
          activeStage === "Documents" &&
          (await hasVisible("input[type=file]"))
        ) {
          try {
            const fi = page.locator("input[type=file]");
            const n = await fi.count();
            const uploadedSlots: string[] = [];
            const controlsBySlot = new Map<string, any[]>();
            for (let i = 0; i < n; i++) {
              const input = fi.nth(i);
              const metadata = await input
                .evaluate((el: HTMLInputElement) => {
                  const container = el.closest(
                    "lightning-input,.slds-form-element,[data-name],[class*='upload']",
                  );
                  return [
                    el.name,
                    el.id,
                    el.getAttribute("aria-label") || "",
                    el.getAttribute("title") || "",
                    container?.textContent || "",
                  ]
                    .join(" ")
                    .replace(/\s+/g, " ")
                    .trim();
                })
                .catch(() => "");
              const slot = inferSalesforceDocumentSlot(metadata);
              if (!slot) continue;
              const group = controlsBySlot.get(slot) ?? [];
              group.push(input);
              controlsBySlot.set(slot, group);
            }
            const fileBySlot: Record<string, string | undefined> = {
              diploma: files.diploma,
              transcript: files.transcript,
              passport: files.passport,
              photo: files.photo,
              english: files.english,
            };
            for (const [slot, localPath] of Object.entries(fileBySlot)) {
              if (!localPath) continue;
              const controls = controlsBySlot.get(slot) ?? [];
              if (controls.length !== 1) {
                logger.warn(
                  `[salesforce:${cfg.key}] upload target not unique`,
                  { slot, count: controls.length },
                );
                continue;
              }
              const input = controls[0];
              try {
                await input.setInputFiles(localPath);
              } catch {
                logger.warn(
                  `[salesforce:${cfg.key}] file selection failed`,
                  { slot },
                );
                continue;
              }
              let uploadProved = false;
              for (let attempt = 0; attempt < 12; attempt++) {
                await page.waitForTimeout(700);
                const evidence = {
                  localPath,
                  inputValue: await input.inputValue().catch(() => ""),
                  ariaInvalid: await input
                    .getAttribute("aria-invalid")
                    .catch(() => null),
                  containerText: await input
                    .evaluate((el: HTMLInputElement) => {
                      const container = el.closest(
                        "lightning-input,.slds-form-element,[data-name],[class*='upload']",
                      );
                      return (container?.textContent || "")
                        .replace(/\s+/g, " ")
                        .trim();
                    })
                    .catch(() => ""),
                };
                if (hasSalesforceUploadProof(evidence)) {
                  uploadProved = true;
                  break;
                }
              }
              if (uploadProved) {
                uploadedSlots.push(slot);
              } else {
                logger.warn(
                  `[salesforce:${cfg.key}] portal upload proof missing`,
                  { slot },
                );
              }
            }
            result.uploadedSlots = uploadedSlots;
            if (
              strictMappedPortal &&
              cfg.requiredDocs.some(
                (slot) => !uploadedSlots.includes(String(slot)),
              )
            ) {
              result.missingDocuments = cfg.requiredDocs.filter(
                (slot) => !uploadedSlots.includes(String(slot)),
              );
              result.detail = `${cfg.label}: required document upload could not be proved`;
              break;
            }
          } catch (e) {
            if (strictMappedPortal) throw e;
          }
          await clickNext();
        } else if (
          activeStage === "Documents" &&
          strictMappedPortal &&
          (await hasVisible('button[name="filesToSelect"]'))
        ) {
          if (cfg.key === "halic") {
            const halicDocuments: Array<{
              slot: string;
              label: string;
              localPath?: string;
            }> = [
              {
                slot: "transcript",
                label: "High School Transcript (*)",
                localPath: files.transcript,
              },
              {
                slot: "passport",
                label: "Passport (*)",
                localPath: files.passport,
              },
              {
                slot: "diploma",
                label: "High School Diploma",
                localPath: files.diploma,
              },
            ];
            const uploadedSlots: string[] = [];
            for (const document of halicDocuments) {
              const fileLibrary = page
                .locator('button[name="filesToSelect"]')
                .first();
              if (!document.localPath || !(await fileLibrary.count())) continue;
              await fileLibrary.click({ timeout: 5000 }).catch(() => {});
              await page.waitForTimeout(350);
              const escapedDocumentLabel = document.label.replace(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&",
              );
              const option = page
                .locator('[role="option"],lightning-base-combobox-item')
                .filter({
                  hasText: new RegExp(
                    `^\\s*${escapedDocumentLabel}\\s*$`,
                    "i",
                  ),
                })
                .first();
              if (!(await option.count())) {
                const options = await page
                  .locator('[role="option"],lightning-base-combobox-item')
                  .allInnerTexts()
                  .catch(() => []);
                logger.warn(`[salesforce:${cfg.key}] document type missing`, {
                  slot: document.slot,
                  expected: document.label,
                  options,
                });
                continue;
              }
              await option.click({ timeout: 5000 }).catch(() => {});
              await page.waitForTimeout(500);
              const inputs = page.locator('input[type="file"]');
              const inputCount = await inputs.count();
              if (inputCount < 1) {
                logger.warn(`[salesforce:${cfg.key}] document file input missing`, {
                  slot: document.slot,
                  label: document.label,
                });
                continue;
              }
              const input = inputs.last();
              await input.setInputFiles(document.localPath).catch(() => {});
              const expectedName = basename(document.localPath);
              let proved = false;
              for (let attempt = 0; attempt < 20; attempt++) {
                await page.waitForTimeout(750);
                if ((await bodyText()).includes(expectedName)) {
                  proved = true;
                  break;
                }
              }
              if (proved) {
                uploadedSlots.push(document.slot);
                const uploadDialog = page
                  .locator('[role="dialog"],section.slds-modal,.slds-modal')
                  .filter({ hasText: expectedName })
                  .last();
                const doneButton = uploadDialog.getByRole("button", {
                  name: /^\s*done\s*$/i,
                });
                if (
                  (await uploadDialog.count().catch(() => 0)) > 0 &&
                  (await doneButton.count().catch(() => 0)) === 1
                ) {
                  await doneButton.click({ timeout: 5000 }).catch(() => {});
                  await page.waitForTimeout(800);
                }
                await page.waitForTimeout(4500);
              }
            }
            result.uploadedSlots = uploadedSlots;
            const missingDocuments = cfg.requiredDocs.filter(
              (slot) => !uploadedSlots.includes(String(slot)),
            );
            if (missingDocuments.length > 0) {
              result.missingDocuments = missingDocuments;
              result.detail = `${cfg.label}: required document upload could not be proved`;
              break;
            }
            let documentsAdvanced = false;
            for (let attempt = 0; attempt < 3; attempt++) {
              await page.waitForTimeout(attempt === 0 ? 4500 : 6500);
              const clicked = await clickNext();
              await page.waitForTimeout(3500);
              const finalSubmit = page
                .getByRole("button", {
                  name: /^\s*(submit(?:\s+application)?|complete(?:\s+application)?|tamamla|gönder|finish|onayla)\s*$/i,
                })
                .first();
              const finalSubmitVisible =
                (await finalSubmit.count().catch(() => 0)) > 0 &&
                (await finalSubmit.isVisible().catch(() => false));
              if (
                clicked &&
                (finalSubmitVisible || (await readActiveStage()) !== "Documents")
              ) {
                documentsAdvanced = true;
                break;
              }
            }
            if (!documentsAdvanced) {
              result.stuckStep = step;
              const validation = await readValidationMessages();
              const visibleButtons = await page
                .locator('button:visible,[role="button"]:visible')
                .evaluateAll((nodes: Element[]) =>
                  nodes.slice(0, 40).map((node: Element) => ({
                    text: (node.textContent || "").replace(/\s+/g, " ").trim(),
                    disabled:
                      (node as HTMLButtonElement).disabled ||
                      node.getAttribute("aria-disabled") === "true",
                    name: node.getAttribute("name"),
                    title: node.getAttribute("title"),
                  })),
                )
                .catch(() => []);
              logger.warn(`[salesforce:${cfg.key}] document stage did not advance`, {
                validation,
                buttons: JSON.stringify(visibleButtons),
              });
              result.detail =
                `${cfg.label}: Documents did not advance` +
                (validation.length
                  ? ` — validation: ${validation.join(" | ")}`
                  : "");
              break;
            }
            continue;
          }
          const documentControls = await page
            .locator("input,button,[role=button],label")
            .evaluateAll((nodes: Element[]) =>
              nodes.slice(0, 120).map((node: Element) => {
                const input = node as HTMLInputElement;
                return {
                  tag: node.tagName,
                  name: input.getAttribute("name"),
                  type: input.getAttribute("type"),
                  id: input.id,
                  text: (node.textContent || "").replace(/\s+/g, " ").trim(),
                };
              }),
            )
            .catch(() => []);
          logger.warn(`[salesforce:${cfg.key}] documents controls diagnostic`, {
            controls: JSON.stringify(documentControls),
          });
          await clickNext();
        } else {
          const cna = page.getByRole("button", { name: /create new application|add application/i }).first();
          if (await cna.count()) { await cna.click({ timeout: 6000 }).catch(() => {}); }
          const sub = page.getByRole("button", { name: /^\s*(submit(?:\s+application)?|complete(?:\s+application)?|tamamla|gönder|finish|onayla)\s*$/i }).first();
          const hn = await page.getByRole("button", { name: /^\s*(next|ileri|sonraki|devam)\s*$/i }).count();
          if ((await sub.count()) && !hn) {
            if (dryRun) { result.dryReachedFinal = true; break; }
            await sub.click({ timeout: 8000 }).catch(() => {});
            if (cfg.key === "halic") {
              await page.waitForTimeout(1500);
              const confirmation = page
                .locator('[role="dialog"],section.slds-modal,.slds-modal')
                .filter({ hasText: /confirm|complete|submit/i })
                .last();
              if (await confirmation.isVisible().catch(() => false)) {
                const positive = confirmation.getByRole("button", {
                  name: /^\s*(confirm|yes|submit(?:\s+application)?|complete(?:\s+application)?)\s*$/i,
                });
                const positiveVisible = await visibleControls(positive);
                if (positiveVisible.length === 1) {
                  await positiveVisible[0]
                    .click({ timeout: 6000 })
                    .catch(() => {});
                }
              }
            }
            await page.waitForTimeout(6000);
            const finalText = await bodyText();
            const appliedProgram = await inspectAppliedPrograms();
            if (appliedProgram) {
              markSalesforceVerifiedSuccess(
                result,
                "exact_application_row",
              );
              result.externalRef = appliedProgram.externalRef;
              result.meta = {
                ...result.meta,
                portalProgram: appliedProgram.portalProgram,
              };
            } else if (DUP.test(finalText)) {
              result.alreadyExists = true;
            } else if (!strictMappedPortal) {
              result.submitted = true;
            } else {
              const completionStage = await readActiveStage();
              if (
                hasSalesforceCompletionProof({
                  activeStage: completionStage,
                })
              ) {
                markSalesforceVerifiedSuccess(result, "completed_stage");
              } else {
                const trackProof = await verifyTrackCompletion();
                if (trackProof.verified) {
                  markSalesforceVerifiedSuccess(
                    result,
                    "exact_application_row",
                  );
                  if (trackProof.externalRef) {
                    result.externalRef = trackProof.externalRef;
                  }
                } else {
                  result.stuckStep = step;
                  result.detail =
                    `${cfg.label}: final submission outcome could not be proved`;
                }
              }
            }
            break;
          }
          try {
            const r = page.locator("input[type=radio]");
            const radioCount = await r.count();
            if (radioCount) {
              if (
                strictMappedPortal &&
                /term|intake|semester|fall|spring|academic year/i.test(txt) &&
                radioCount !== 1
              ) {
                throw new Error(
                  `Salesforce ${cfg.key}: term target was not unique`,
                );
              }
              let target = r.first();
              if (
                strictMappedPortal &&
                /degree|education level|program level/i.test(txt)
              ) {
                const levelPattern = /associate|önlisans|onlisans/i.test(profile.level)
                  ? /associate|önlisans|onlisans/i
                  : /master|yüksek lisans|yuksek lisans/i.test(profile.level)
                    ? /master|yüksek lisans|yuksek lisans/i
                    : /phd|doctor|doktora/i.test(profile.level)
                      ? /phd|doctor|doktora/i
                      : /bachelor|lisans/i;
                const labels = page.locator("label").filter({ hasText: levelPattern });
                if ((await labels.count()) !== 1) {
                  throw new Error(
                    `Salesforce ${cfg.key}: degree target was not unique`,
                  );
                }
                await labels.first().click({ timeout: 3000 });
                target = page.locator("#__never_used__");
              }
              if (await target.count()) {
                const id = await target.getAttribute("id").catch(() => null);
                if (id) {
                  const lb = page.locator("label[for=\"" + id + "\"]").first();
                  if (await lb.count()) await lb.click({ timeout: 3000 }).catch(() => {});
                }
                await target.check({ force: true }).catch(() => {});
              }
            }
          } catch (e) {
            if (strictMappedPortal) throw e;
          }
          await clickNext();
        }
        let moved = false;
        let afterStage: SalesforceStage = activeStage;
        let bodyChanged = false;
        for (let t = 0; t < 10; t++) {
          await page.waitForTimeout(1000);
          afterStage = await readActiveStage();
          bodyChanged =
            (await bodyText()).replace(/\s+/g, " ").slice(0, 600) !== before;
          if (activeStage && afterStage && afterStage !== activeStage) {
            moved = true;
            break;
          }
          if (!activeStage && bodyChanged) {
            moved = true;
            break;
          }
        }
        if (
          strictMappedPortal &&
          activeStage &&
          afterStage === activeStage &&
          !(activeStage === "Program Selection" && bodyChanged)
        ) {
          const validation = await readValidationMessages();
          if (cfg.key === "halic" && activeStage === "Review and Submit") {
            const buttons = await page
              .locator('button:visible,[role="button"]:visible')
              .evaluateAll((nodes: Element[]) =>
                nodes.slice(0, 40).map((node: Element) => ({
                  text: (node.textContent || "").replace(/\s+/g, " ").trim(),
                  disabled:
                    (node as HTMLButtonElement).disabled ||
                    node.getAttribute("aria-disabled") === "true",
                  name: node.getAttribute("name"),
                  title: node.getAttribute("title"),
                })),
              )
              .catch(() => []);
            logger.warn(`[salesforce:${cfg.key}] review stage did not advance`, {
              validation,
              buttons: JSON.stringify(buttons),
            });
          }
          result.stuckStep = step;
          result.detail =
            `${cfg.label}: ${activeStage} did not advance` +
            (validation.length
              ? ` — validation: ${validation.join(" | ")}`
              : "");
          break;
        }
        if (!moved) {
          result.stuckStep = step;
          if (!strictMappedPortal) {
            result.stuckBody = (await bodyText())
              .replace(/\s+/g, " ")
              .slice(0, 200);
          }
          if (step > 0) break;
        }
      }
      logger.info("[salesforce:" + cfg.key + "] submit " + JSON.stringify(result));
      return result;
    },
  };
}

export const salesforceAdapters: UniversityAdapter[] = SALESFORCE_SCHOOLS.map(makeSalesforceAdapter);
