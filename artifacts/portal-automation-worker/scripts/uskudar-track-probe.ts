/**
 * Read-only Üsküdar Track Applications probe.
 *
 * It never clicks an application action. Applicant values are used only for
 * boolean matching and are never printed.
 *
 * Usage:
 *   pnpm tsx scripts/uskudar-track-probe.ts <applicationId>
 */
import {
  applicationsTable,
  db,
  studentsTable,
} from "@workspace/db";
import { adapterByKey, fold } from "@workspace/portal-adapters";
import { eq } from "drizzle-orm";
import { resolvePortalCreds } from "../src/credResolver.js";

const applicationId = Number(process.argv[2]);
if (!Number.isInteger(applicationId) || applicationId <= 0) {
  throw new Error("applicationId must be a positive integer");
}

const TRACK_URL =
  "https://apply.uskudar.edu.tr/agency/s/track-application";

function nameVariants(firstName: string, lastName: string): string[] {
  return [
    `${firstName} ${lastName}`,
    `${lastName} ${firstName}`,
  ].map(fold);
}

async function main(): Promise<void> {
  const adapter = adapterByKey("uskudar");
  if (!adapter) throw new Error("Üsküdar adapter was not found");

  const [application] = await db
    .select({
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      programName: applicationsTable.programName,
    })
    .from(applicationsTable)
    .innerJoin(
      studentsTable,
      eq(studentsTable.id, applicationsTable.studentId),
    )
    .where(eq(applicationsTable.id, applicationId));
  if (!application) throw new Error("Application was not found");
  const applicantNames = nameVariants(
    application.firstName,
    application.lastName,
  );
  const displayName = `${application.firstName} ${application.lastName}`;
  const programName = fold(application.programName ?? "");
  const creds = await resolvePortalCreds("uskudar", "uskudar");
  const session: any = await adapter.login({
    credentials: creds,
    headless: true,
  });
  const page: any = session.page;

  try {
    await page.goto(TRACK_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(8_000);

    const listSearch = page.getByPlaceholder(/search this list/i).first();
    if (await listSearch.count()) {
      await listSearch.fill(displayName);
      await listSearch.press("Enter").catch(() => {});
      await page.waitForTimeout(5_000);
    }

    const escapedName = displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matchedRows = page
      .locator("tr")
      .filter({ hasText: new RegExp(escapedName, "i") });
    const matchedRowCount = await matchedRows.count();
    if (matchedRowCount === 1) {
      const radio = matchedRows.first().locator("input[type=radio]").first();
      if (await radio.count()) {
        await radio.check({ force: true }).catch(() => {});
        await page.waitForTimeout(2_000);
      }
    }

    const actionButtons = page
      .getByRole("button", {
        name: /complete application|continue application|view application/i,
      });
    const actionCount = await actionButtons.count();
    const candidates: Array<Record<string, unknown>> = [];

    for (let i = 0; i < actionCount; i++) {
      const button = actionButtons.nth(i);
      const ancestorTexts = (await button.evaluate((element: Element) => {
        const values: string[] = [];
        let current: Element | null = element;
        const seen = new Set<Element>();
        for (let depth = 0; current && depth < 14; depth++) {
          if (seen.has(current)) break;
          seen.add(current);
          const text = (current.textContent ?? "")
            .replace(/\s+/g, " ")
            .trim();
          if (text) values.push(text.slice(0, 2_000));
          const root = current.getRootNode() as ShadowRoot | Document;
          current =
            current.parentElement ??
            ("host" in root ? (root.host as Element) : null);
        }
        return values;
      })) as string[];

      const foldedAncestors = ancestorTexts.map(fold);
      const matchingAncestorIndex = foldedAncestors.findIndex((text) =>
        applicantNames.some((name) => text.includes(name)),
      );
      const programMatched = foldedAncestors.some(
        (text) => programName.length > 0 && text.includes(programName),
      );
      candidates.push({
        index: i,
        applicantMatched: matchingAncestorIndex >= 0,
        programMatched,
        matchingAncestorDepth:
          matchingAncestorIndex >= 0 ? matchingAncestorIndex : null,
      });
    }

    const applicantMatches = candidates.filter(
      (candidate) => candidate.applicantMatched === true,
    );
    const visibleButtonLabels: string[] = [];
    const buttons = page.locator("button");
    for (let i = 0; i < Math.min(await buttons.count(), 80); i++) {
      const button = buttons.nth(i);
      if (!(await button.isVisible().catch(() => false))) continue;
      const label = (
        (await button.innerText().catch(() => "")) ||
        (await button.getAttribute("aria-label").catch(() => "")) ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim();
      if (label && !visibleButtonLabels.includes(label)) {
        visibleButtonLabels.push(label);
      }
    }
    const visibleInputs: string[] = [];
    const inputs = page.locator("input,select");
    for (let i = 0; i < Math.min(await inputs.count(), 80); i++) {
      const input = inputs.nth(i);
      if (!(await input.isVisible().catch(() => false))) continue;
      const description = [
        (await input.getAttribute("type").catch(() => "")) || "",
        (await input.getAttribute("name").catch(() => "")) || "",
        (await input.getAttribute("placeholder").catch(() => "")) || "",
        (await input.getAttribute("aria-label").catch(() => "")) || "",
      ]
        .filter(Boolean)
        .join(":")
        .slice(0, 180);
      if (description && !visibleInputs.includes(description)) {
        visibleInputs.push(description);
      }
    }
    const body = fold(
      (await page.locator("body").innerText().catch(() => "")) || "",
    );
    const matchedRow: Record<string, unknown> | null =
      matchedRowCount === 1
        ? await (async () => {
            const row = matchedRows.first();
            const links = row.locator("a");
            const hrefKinds: string[] = [];
            for (let i = 0; i < Math.min(await links.count(), 12); i++) {
              const href = await links.nth(i).getAttribute("href").catch(() => "");
              if (!href) continue;
              let kind = "relative:";
              try {
                const url = new URL(href, TRACK_URL);
                kind = url.protocol;
              } catch {}
              if (!hrefKinds.includes(kind)) hrefKinds.push(kind);
            }
            const rowText = fold(
              (await row.innerText().catch(() => "")) || "",
            );
            const cellShapes: Array<Record<string, unknown>> = [];
            const cells = row.locator("th,td");
            for (let i = 0; i < Math.min(await cells.count(), 16); i++) {
              const cell = cells.nth(i);
              cellShapes.push({
                index: i,
                dataLabel:
                  (await cell.getAttribute("data-label").catch(() => null)) ??
                  null,
                role:
                  (await cell.getAttribute("role").catch(() => null)) ?? null,
                tabIndex:
                  (await cell.getAttribute("tabindex").catch(() => null)) ??
                  null,
                linkCount: await cell.locator("a").count(),
                buttonCount: await cell.locator("button").count(),
                inputCount: await cell.locator("input").count(),
              });
            }
            return {
              linkCount: await links.count(),
              buttonCount: await row.locator("button").count(),
              hrefKinds,
              cellShapes,
              hasDraftStatus: /\bdraft\b/.test(rowText),
              hasInProgressStatus: /in progress|incomplete/.test(rowText),
              hasProgramSelectionStage: rowText.includes("program selection"),
              hasCompletedStage: /\bcompleted\b/.test(rowText),
              hasSubmittedStatus: /\bsubmitted\b/.test(rowText),
            };
          })()
        : null;
    await page.goto(
      "https://apply.uskudar.edu.tr/agency/s/application-form",
      { waitUntil: "domcontentloaded", timeout: 60_000 },
    );
    await page.waitForTimeout(8_000);
    const formBody = fold(
      (await page.locator("body").innerText().catch(() => "")) || "",
    );
    const formButtonLabels: string[] = [];
    const formButtons = page.locator("button");
    for (let i = 0; i < Math.min(await formButtons.count(), 80); i++) {
      const button = formButtons.nth(i);
      if (!(await button.isVisible().catch(() => false))) continue;
      const label = (
        (await button.innerText().catch(() => "")) ||
        (await button.getAttribute("aria-label").catch(() => "")) ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim();
      if (label && !formButtonLabels.includes(label)) {
        formButtonLabels.push(label);
      }
    }
    const appFormProbe = {
      urlOk: page.url().includes("/application-form"),
      applicantNameVisible: applicantNames.some((name) =>
        formBody.includes(name),
      ),
      programVisible:
        programName.length > 0 && formBody.includes(programName),
      hasTermSelection:
        /academic term|intake|fall 20|spring 20/.test(formBody),
      hasProgramSelection: formBody.includes("available programs"),
      hasPersonalInformation: formBody.includes("personal information"),
      hasEducationalInformation: formBody.includes(
        "educational information",
      ),
      hasDocuments: /\bdocuments\b/.test(formBody),
      hasReviewAndSubmit: formBody.includes("review and submit"),
      hasCompleted: /\bcompleted\b/.test(formBody),
      searchProgramCount: await page
        .getByPlaceholder(/search program name|keyword/i)
        .count(),
      formButtonLabels,
    };
    console.log(
      "USKUDAR_TRACK_PROBE " +
        JSON.stringify({
          urlOk: page.url().includes("/track-application"),
          loginVisible: await page
            .locator("input[type=password]")
            .first()
            .isVisible()
            .catch(() => false),
          actionCount,
          applicantMatchCount: applicantMatches.length,
          exactApplicantAndProgramMatchCount: applicantMatches.filter(
            (candidate) => candidate.programMatched === true,
          ).length,
          applicantNameVisible: applicantNames.some((name) =>
            body.includes(name),
          ),
          programVisible:
            programName.length > 0 && body.includes(programName),
          matchedRowCount,
          matchedRow,
          visibleButtonLabels,
          visibleInputs,
          candidates,
          appFormProbe,
        }),
    );
  } finally {
    await session.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(
    "USKUDAR_TRACK_PROBE_ERROR " +
      (error instanceof Error ? error.message : String(error)),
  );
  process.exitCode = 1;
});
