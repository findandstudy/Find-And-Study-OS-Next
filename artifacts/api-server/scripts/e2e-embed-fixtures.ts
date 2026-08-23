/**
 * Playwright e2e fixtures for the embed widget apply form tests.
 *
 * Idempotently ensures the database has:
 *   - A test university (well-known name)
 *   - At least one active program belonging to that university
 *   - An active embed widget with a well-known slug, mode=combined, and
 *     no allowedDomains restriction so it can be loaded from any host page.
 *
 * The IDs of any rows created here are written to e2e-embed-state.json at the
 * project root. The teardown script (e2e-embed-fixtures-teardown.ts) reads
 * that file to clean up only the rows it created, leaving any pre-existing
 * data alone.
 *
 * Run via playwright globalSetup (see playwright-global-setup.ts).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "node:crypto";
import {
  db,
  universitiesTable,
  programsTable,
  embedWidgetsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { assertSafeE2eDatabase } from "./e2e-database-safety";

assertSafeE2eDatabase();

function generateWidgetApiKey(): string {
  return crypto.randomBytes(32).toString("hex");
}

export const EMBED_TEST_SLUG = "e2e-embed-test";
export const EMBED_TEST_UNIVERSITY = "E2E Embed Test University";
export const EMBED_TEST_PROGRAM = "E2E Embed Test Program";

/**
 * Two extra widgets seeded with a populated `allowedDomains` allowlist so
 * we can test allowlist behavior end-to-end through the loader/iframe
 * and at the public API layer. Keep these slugs + domains in sync with
 * the `embed widget — allowed-domains` describe block in
 * `artifacts/edcons/tests/e2e/embed-widget.spec.ts`.
 *
 *   - PERMISSIVE: allowedDomains includes "localhost"/"127.0.0.1" so the
 *     iframe (loaded from the dev server at http://localhost:25197) makes
 *     same-origin /config + /programs calls whose Referer hostname IS in
 *     the allowlist. Used for the "renders normally on allowed origin"
 *     loader test.
 *
 *   - STRICT: allowedDomains is exactly ["allowed.e2e.example.com"] — a
 *     domain that is never actually serving the test page. The iframe
 *     loaded from localhost will be rejected (Referer hostname=localhost
 *     is not in the list), so the widget shows its "Unable to load
 *     widget" error state. Also used for API-level allow/deny tests
 *     where we send an explicit Origin/Referer header.
 */
export const EMBED_TEST_ALLOWLIST_PERMISSIVE_SLUG = "e2e-embed-test-allowlist-permissive";
export const EMBED_TEST_ALLOWLIST_STRICT_SLUG = "e2e-embed-test-allowlist-strict";
export const EMBED_TEST_ALLOWED_DOMAIN = "allowed.e2e.example.com";

const stateFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../e2e-embed-state.json",
);

interface EmbedFixtureState {
  createdUniversityId: number | null;
  createdProgramId: number | null;
  createdWidgetId: number | null;
  createdAllowlistPermissiveWidgetId: number | null;
  createdAllowlistStrictWidgetId: number | null;
  priorProgramIsActive: boolean | null;
  priorProgramId: number | null;
  priorWidgetSnapshot: Record<string, unknown> | null;
  priorAllowlistPermissiveWidgetSnapshot: Record<string, unknown> | null;
  priorAllowlistStrictWidgetSnapshot: Record<string, unknown> | null;
  permissiveWidgetApiKey: string | null;
  strictWidgetApiKey: string | null;
}

async function main() {
  const state: EmbedFixtureState = {
    createdUniversityId: null,
    createdProgramId: null,
    createdWidgetId: null,
    createdAllowlistPermissiveWidgetId: null,
    createdAllowlistStrictWidgetId: null,
    priorProgramIsActive: null,
    priorProgramId: null,
    priorWidgetSnapshot: null,
    priorAllowlistPermissiveWidgetSnapshot: null,
    priorAllowlistStrictWidgetSnapshot: null,
    permissiveWidgetApiKey: null,
    strictWidgetApiKey: null,
  };

  const [existingUni] = await db
    .select()
    .from(universitiesTable)
    .where(eq(universitiesTable.name, EMBED_TEST_UNIVERSITY));

  let universityId: number;
  if (existingUni) {
    universityId = existingUni.id;
    console.log(`[e2e-embed-setup] Reusing university id=${universityId}`);
  } else {
    const [created] = await db
      .insert(universitiesTable)
      .values({
        name: EMBED_TEST_UNIVERSITY,
        country: "United Kingdom",
        city: "London",
        isActive: true,
        universityType: "Public",
      })
      .returning();
    universityId = created.id;
    state.createdUniversityId = universityId;
    console.log(`[e2e-embed-setup] Created university id=${universityId}`);
  }

  const existingProgs = await db
    .select()
    .from(programsTable)
    .where(eq(programsTable.universityId, universityId));
  const existingTestProg = existingProgs.find((p) => p.name === EMBED_TEST_PROGRAM);

  let programId: number;
  if (existingTestProg) {
    programId = existingTestProg.id;
    state.priorProgramId = programId;
    state.priorProgramIsActive = existingTestProg.isActive ?? null;
    if (!existingTestProg.isActive) {
      await db
        .update(programsTable)
        .set({ isActive: true })
        .where(eq(programsTable.id, programId));
      console.log(`[e2e-embed-setup] Reusing program id=${programId} (forced isActive=true)`);
    } else {
      console.log(`[e2e-embed-setup] Reusing program id=${programId}`);
    }
  } else {
    const [created] = await db
      .insert(programsTable)
      .values({
        universityId,
        name: EMBED_TEST_PROGRAM,
        degree: "Bachelor",
        field: "Computer Science",
        language: "English",
        duration: "4 years",
        tuitionFee: 12000,
        currency: "USD",
        intakes: "Fall",
        isActive: true,
      })
      .returning();
    programId = created.id;
    state.createdProgramId = programId;
    console.log(`[e2e-embed-setup] Created program id=${programId}`);
  }

  const [existingWidget] = await db
    .select()
    .from(embedWidgetsTable)
    .where(eq(embedWidgetsTable.slug, EMBED_TEST_SLUG));

  let widgetId: number;
  if (existingWidget) {
    widgetId = existingWidget.id;
    state.priorWidgetSnapshot = {
      isActive: existingWidget.isActive,
      mode: existingWidget.mode,
      presetFilters: existingWidget.presetFilters,
      lockedFilters: existingWidget.lockedFilters,
      hiddenFilters: existingWidget.hiddenFilters,
      visibleFilters: existingWidget.visibleFilters,
      theme: existingWidget.theme,
      allowedDomains: existingWidget.allowedDomains,
    };
    await db
      .update(embedWidgetsTable)
      .set({
        isActive: true,
        mode: "combined",
        presetFilters: {},
        lockedFilters: [],
        hiddenFilters: [],
        visibleFilters: [],
        theme: {},
        allowedDomains: [],
      })
      .where(eq(embedWidgetsTable.id, widgetId));
    console.log(`[e2e-embed-setup] Reused widget id=${widgetId} (snapshot saved, reset config)`);
  } else {
    const [created] = await db
      .insert(embedWidgetsTable)
      .values({
        name: "E2E Embed Test Widget",
        slug: EMBED_TEST_SLUG,
        mode: "combined",
        presetFilters: {},
        lockedFilters: [],
        hiddenFilters: [],
        visibleFilters: [],
        theme: {},
        allowedDomains: [],
        isActive: true,
      })
      .returning();
    widgetId = created.id;
    state.createdWidgetId = widgetId;
    console.log(`[e2e-embed-setup] Created widget id=${widgetId}`);
  }

  // ---- Permissive allowlist widget (loader-renders test) --------------
  const permissiveApiKey = await ensureAllowlistWidget({
    slug: EMBED_TEST_ALLOWLIST_PERMISSIVE_SLUG,
    name: "E2E Embed Test Widget (Allowlist Permissive)",
    allowedDomains: ["localhost", "127.0.0.1"],
    onCreate: (id) => {
      state.createdAllowlistPermissiveWidgetId = id;
    },
    onReuse: (snap) => {
      state.priorAllowlistPermissiveWidgetSnapshot = snap;
    },
  });
  state.permissiveWidgetApiKey = permissiveApiKey;

  // ---- Strict allowlist widget (loader-rejects + API tests) -----------
  const strictApiKey = await ensureAllowlistWidget({
    slug: EMBED_TEST_ALLOWLIST_STRICT_SLUG,
    name: "E2E Embed Test Widget (Allowlist Strict)",
    allowedDomains: [EMBED_TEST_ALLOWED_DOMAIN],
    onCreate: (id) => {
      state.createdAllowlistStrictWidgetId = id;
    },
    onReuse: (snap) => {
      state.priorAllowlistStrictWidgetSnapshot = snap;
    },
  });
  state.strictWidgetApiKey = strictApiKey;

  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
  process.exit(0);
}

interface EnsureWidgetArgs {
  slug: string;
  name: string;
  allowedDomains: string[];
  onCreate: (id: number) => void;
  onReuse: (snapshot: Record<string, unknown>) => void;
}

/**
 * Ensures a restricted allowlist widget exists and returns its embedApiKey.
 * Generates a new API key if the widget doesn't already have one.
 */
async function ensureAllowlistWidget({
  slug,
  name,
  allowedDomains,
  onCreate,
  onReuse,
}: EnsureWidgetArgs): Promise<string> {
  const [existing] = await db
    .select()
    .from(embedWidgetsTable)
    .where(eq(embedWidgetsTable.slug, slug));

  if (existing) {
    onReuse({
      isActive: existing.isActive,
      mode: existing.mode,
      presetFilters: existing.presetFilters,
      lockedFilters: existing.lockedFilters,
      hiddenFilters: existing.hiddenFilters,
      visibleFilters: existing.visibleFilters,
      theme: existing.theme,
      allowedDomains: existing.allowedDomains,
    });
    // Preserve existing API key or generate a fresh one if missing.
    const apiKey = existing.embedApiKey ?? generateWidgetApiKey();
    await db
      .update(embedWidgetsTable)
      .set({
        isActive: true,
        mode: "combined",
        presetFilters: {},
        lockedFilters: [],
        hiddenFilters: [],
        visibleFilters: [],
        theme: {},
        allowedDomains,
        embedApiKey: apiKey,
      })
      .where(eq(embedWidgetsTable.id, existing.id));
    console.log(
      `[e2e-embed-setup] Reused allowlist widget slug=${slug} id=${existing.id} (snapshot saved, allowedDomains=[${allowedDomains.join(",")}])`,
    );
    return apiKey;
  } else {
    const apiKey = generateWidgetApiKey();
    const [created] = await db
      .insert(embedWidgetsTable)
      .values({
        name,
        slug,
        mode: "combined",
        presetFilters: {},
        lockedFilters: [],
        hiddenFilters: [],
        visibleFilters: [],
        theme: {},
        allowedDomains,
        embedApiKey: apiKey,
        isActive: true,
      })
      .returning();
    onCreate(created.id);
    console.log(
      `[e2e-embed-setup] Created allowlist widget slug=${slug} id=${created.id} (allowedDomains=[${allowedDomains.join(",")}])`,
    );
    return apiKey;
  }
}

main().catch((err) => {
  console.error("[e2e-embed-setup] error:", err);
  process.exit(1);
});
