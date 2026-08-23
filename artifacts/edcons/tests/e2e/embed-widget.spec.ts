/**
 * Playwright e2e for the embeddable apply widget.
 *
 * Permanent regression coverage for the recent embed loader fixes:
 *   - Task #82: cross-origin loader / iframe injection.
 *   - Task #83: mobile modal positioning, scroll lock during modal,
 *     scroll position restored on close.
 *
 * The test does NOT load the widget through the edcons app. Instead, it
 * builds a small synthetic host page in-memory via page.setContent(),
 * drops in the public embed loader (`/api/public/embed/embed.js`), and
 * asserts that:
 *
 *   1. The loader injects an <iframe> into the host page.
 *   2. The widget HTML inside the iframe lists at least one program
 *      (or shows the empty state) — i.e. the public programs API works.
 *   3. Clicking "Apply Now" on a program opens the apply modal inside
 *      the iframe.
 *   4. While the modal is open, the host page body has scroll lock
 *      applied (position:fixed) and cannot scroll.
 *   5. On mobile viewport, the modal stays inside the visible viewport
 *      (top + height fit within parent viewport).
 *   6. Closing the modal restores the original scroll position on the
 *      host page.
 *
 * Fixtures (test university + program + widget with slug
 * `e2e-embed-test`) are seeded by playwright globalSetup via
 * `artifacts/api-server/scripts/e2e-embed-fixtures.ts`.
 */
import { test, expect, request as pwRequest, type Page, type FrameLocator } from "@playwright/test";
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:25197";
const EMBED_SLUG = "e2e-embed-test";

/**
 * Allowlist-widget slugs (seeded by
 * `artifacts/api-server/scripts/e2e-embed-fixtures.ts`).
 *
 *   - PERMISSIVE: allowedDomains=["localhost","127.0.0.1"].  Tests proxy the
 *     token request through page.route() to simulate a partner backend that
 *     holds the embedApiKey server-side.
 *
 *   - STRICT: allowedDomains=["allowed.e2e.example.com"].  A domain that is
 *     never actually serving the test page, used for API-level rejection tests.
 */
const EMBED_ALLOWLIST_PERMISSIVE_SLUG = "e2e-embed-test-allowlist-permissive";
const EMBED_ALLOWLIST_STRICT_SLUG = "e2e-embed-test-allowlist-strict";

/** Read embedApiKeys written by globalSetup into the fixture state file. */
function getFixtureState(): { permissiveWidgetApiKey: string; strictWidgetApiKey: string } {
  const stateFile = path.resolve(__dirname, "../../../../e2e-embed-state.json");
  return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}

/**
 * Build the host page HTML.
 * @param slug     Widget slug.
 * @param tokenUrl Optional data-edcons-token-url (partner's backend endpoint).
 *                 When omitted, embed.js calls /token directly (open widgets
 *                 need no key; restricted widgets will get a 403 and show error state).
 */
function buildHostHtml(slug: string = EMBED_SLUG, tokenUrl?: string): string {
  const widgetAttr = tokenUrl
    ? `data-edcons-widget="${slug}" data-edcons-token-url="${tokenUrl}"`
    : `data-edcons-widget="${slug}"`;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Embed Widget E2E Host</title>
<style>
  body { margin: 0; font-family: sans-serif; }
  #spacer-top { height: 120px; background: linear-gradient(#fafafa,#eee); padding: 24px; }
  #widget-host { padding: 16px; background: #fff; }
  #spacer-bottom { height: 1500px; background: linear-gradient(#eee,#ddd); padding: 24px; }
</style>
</head>
<body>
<div id="spacer-top">Top spacer (forces scroll above the widget).</div>
<div id="widget-host"><div ${widgetAttr}></div></div>
<div id="spacer-bottom">Bottom spacer.</div>
<script src="${BASE_URL}/api/public/embed/embed.js"></script>
</body>
</html>`;
}

async function loadHost(page: Page, slug: string = EMBED_SLUG, tokenUrl?: string) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  await page.setContent(buildHostHtml(slug, tokenUrl), { waitUntil: "load" });
  // Force the lazy-loaded iframe to start loading immediately, then reset
  // host scroll so individual tests start from a known position.
  const iframeLocator = page.locator("#widget-host iframe");
  await expect(iframeLocator).toHaveCount(1, { timeout: 10_000 });
  await iframeLocator.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function getWidgetIframe(
  page: Page,
  slug: string = EMBED_SLUG,
): Promise<FrameLocator> {
  const iframeEl = page.locator("#widget-host iframe");
  await expect(iframeEl).toHaveCount(1, { timeout: 10_000 });
  await expect(iframeEl).toHaveAttribute(
    "src",
    new RegExp(`/api/public/embed/${slug}/widget`),
  );
  return page.frameLocator("#widget-host iframe");
}

test.describe("embed widget — desktop", { tag: "@desktop" }, () => {
  test("loader injects iframe and renders the program list", async ({ page }) => {
    await loadHost(page);
    const widget = await getWidgetIframe(page);

    // The fixture guarantees at least one active program exists for this
    // widget, so we should always see at least one card and never the
    // empty state. Wait for cards to appear.
    const cards = widget.locator(".ew-card");
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });
    expect(await cards.count()).toBeGreaterThan(0);
    await expect(widget.locator(".ew-empty")).toHaveCount(0);

    // Apply Now button must be present on the card.
    await expect(
      widget.locator(".ew-card .ew-btn", { hasText: /apply now/i }).first(),
    ).toBeVisible();
  });

  test("opening apply modal locks scroll and restores it on close", async ({ page }) => {
    await loadHost(page);
    const widget = await getWidgetIframe(page);

    await expect(widget.locator(".ew-card").first()).toBeVisible({ timeout: 10_000 });

    // Scroll the host page so we can later assert restoration. The widget
    // is small (spacer-top 120px) so the apply button stays in viewport
    // without Playwright auto-scrolling on click.
    await page.evaluate(() => window.scrollTo(0, 200));

    // Click the first Apply Now button.
    await widget.locator(".ew-card .ew-btn", { hasText: /apply now/i }).first().click();

    // Modal must appear inside the iframe.
    const modalOverlay = widget.locator(".ew-modal-overlay");
    const modal = widget.locator(".ew-modal");
    await expect(modalOverlay).toBeVisible({ timeout: 5_000 });
    await expect(modal).toBeVisible();

    // Scroll lock: host body should be position:fixed while modal is open.
    await expect.poll(
      async () => page.evaluate(() => document.body.style.position),
      { timeout: 3_000 },
    ).toBe("fixed");

    // The loader stores the captured scroll in `body.style.top` as
    // negative pixels — extract it so we can assert restoration even if
    // Playwright auto-scrolled the page slightly when clicking apply.
    const savedScrollFromLoader = await page.evaluate(() => {
      const top = document.body.style.top;
      return top ? Math.abs(parseInt(top, 10)) : 0;
    });
    expect(savedScrollFromLoader).toBeGreaterThan(0);

    // Attempting to scroll the host page must NOT change the visible scroll.
    const lockedScroll = await page.evaluate(() => {
      window.scrollTo(0, 1000);
      return Math.round(window.scrollY);
    });
    expect(lockedScroll).toBe(0); // body fixed -> scrollY clamps to 0

    // Close the modal via the close button.
    await widget.locator("#ew-modal-close").click();
    await expect(modalOverlay).toHaveCount(0, { timeout: 5_000 });

    // Scroll lock removed and original scroll restored.
    await expect.poll(
      async () => page.evaluate(() => document.body.style.position),
      { timeout: 3_000 },
    ).toBe("");
    await expect.poll(
      async () => page.evaluate(() => Math.round(window.scrollY)),
      { timeout: 3_000 },
    ).toBe(savedScrollFromLoader);
  });
});

/**
 * Mobile modal coverage.
 *
 * Tagged @mobile so playwright.config.ts can route this to multiple
 * mobile-viewport projects (small Android, large iPhone, tablet
 * portrait) and — when RUN_WEBKIT_E2E=1 — to a WebKit iOS Safari
 * project. The viewport itself is set by the project, NOT here, so
 * the same test exercises every form factor without copy-paste.
 */
test.describe("embed widget — mobile", { tag: "@mobile" }, () => {
  test("modal stays inside the visible viewport on mobile", async ({ page }, testInfo) => {
    await loadHost(page);
    const widget = await getWidgetIframe(page);

    await expect(widget.locator(".ew-card").first()).toBeVisible({ timeout: 10_000 });

    // Scroll the host a small amount so the modal positioning logic has
    // a non-zero parent scroll to react to. Use a small fraction of the
    // current viewport so the apply button stays in view across all
    // mobile viewports (360x740 .. 768x1024).
    const viewportH = page.viewportSize()?.height ?? 700;
    const initialScroll = Math.min(80, Math.floor(viewportH * 0.1));
    await page.evaluate((y) => window.scrollTo(0, y), initialScroll);

    // Open the modal.
    await widget
      .locator(".ew-card .ew-btn", { hasText: /apply now/i })
      .first()
      .click();

    const modal = widget.locator(".ew-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Wait until the modal has a non-zero rendered height. repositionModal()
    // runs synchronously on open and again at t+60ms; the parent loader also
    // resizes the iframe immediately after edcons-modal-open, which can
    // trigger a brief layout-flush that returns height=0 between the two
    // repaint frames. Polling avoids a sporadic race on loaded CI/autoscale.
    await expect
      .poll(
        async () => {
          const h = await widget
            .locator(".ew-modal")
            .evaluate((el) => el.getBoundingClientRect().height)
            .catch(() => 0);
          return h;
        },
        { timeout: 5_000, intervals: [50, 100, 150, 200] },
      )
      .toBeGreaterThan(0);

    // The modal must fit inside the parent (mobile) viewport. Compute the
    // modal's bounding box in the parent viewport's coordinate system by
    // adding the iframe's offset.
    const modalInfo = await widget.locator(".ew-modal").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        topInIframe: r.top,
        height: r.height,
        maxHeight: parseFloat((el as HTMLElement).style.maxHeight) || 0,
      };
    });
    const iframeTopInParent = await page.locator("#widget-host iframe").evaluate(
      (el) => el.getBoundingClientRect().top,
    );
    const viewportHeight = await page.evaluate(() => window.innerHeight);

    const modalTopInParent = iframeTopInParent + modalInfo.topInIframe;

    // Helpful diagnostics so a viewport-specific failure tells us which
    // form factor blew up without grepping junit XML.
    testInfo.annotations.push({
      type: "viewport",
      description: `${page.viewportSize()?.width}x${page.viewportSize()?.height}`,
    });

    // Modal must be at least partially visible in the parent viewport
    // (top within viewport). Allow a 16px tolerance for rounding/layout shifts.
    expect(modalTopInParent).toBeGreaterThanOrEqual(-16);
    expect(modalTopInParent).toBeLessThan(viewportHeight);
    expect(modalInfo.height).toBeGreaterThan(120);
    // The applied max-height must be bounded by the parent viewport height.
    expect(modalInfo.maxHeight).toBeLessThanOrEqual(viewportHeight);

    // Scroll lock must be active on mobile too.
    await expect
      .poll(async () => page.evaluate(() => document.body.style.position), {
        timeout: 3_000,
      })
      .toBe("fixed");
  });
});

/**
 * Allowed-domains restriction — backend-mediated API key model.
 *
 * Restricted widgets use a per-widget API key stored in the DB and NEVER
 * placed in HTML.  Partners hold the key on their backend server and exchange
 * it server-to-server (via X-Widget-Api-Key header) for a short-lived HMAC
 * session token.  The browser calls the partner's own endpoint to get the token;
 * the secret is never exposed to the browser.
 *
 * Security model:
 *   - Correct X-Widget-Api-Key (server-to-server) → session token → data 200
 *   - Missing or wrong X-Widget-Api-Key → /token 403
 *   - Correct key + Origin not in allowedDomains (defense-in-depth) → 403
 *   - No session token → data endpoints 403 (regardless of any Origin/Referer)
 *
 * Two angles of coverage:
 *
 *   1) Loader/iframe end-to-end (user-facing flow):
 *        - PERMISSIVE widget: page.route() simulates the partner backend.
 *          Intercepts data-edcons-token-url, calls /token with the API key,
 *          returns the session token → program cards render inside iframe.
 *        - STRICT widget: no data-edcons-token-url → embed.js calls /token
 *          without a key → 403 → widget shows "Unable to load widget".
 *
 *   2) Public-API direct (proves Origin/Referer cannot bypass the gate):
 *        - Correct key → session token → 200
 *        - Missing key → 403
 *        - Wrong key → 403
 *        - Correct key + wrong Origin → 403 (defense-in-depth)
 *        - No session token + forged Origin/Referer → data 403
 *
 * Tagged @desktop so it only runs on the chromium-desktop project.
 */
test.describe("embed widget — allowed-domains", { tag: "@desktop" }, () => {
  test("loader iframe renders program cards when token-url simulates partner backend", async ({
    page,
  }) => {
    // PERMISSIVE widget: allowedDomains=["localhost","127.0.0.1"].
    // Simulate the partner's backend: intercept the token-url call in the
    // test process (page.route), add the API key header, call our /token.
    const state = getFixtureState();
    const apiKey = state.permissiveWidgetApiKey;
    expect(apiKey, "permissiveWidgetApiKey must be in the fixture state file").toBeTruthy();

    const fakeTokenUrl = `${BASE_URL}/api/e2e-partner-token-permissive`;
    await page.route("**/api/e2e-partner-token-permissive", async (route) => {
      const ctx = await pwRequest.newContext({
        extraHTTPHeaders: { "X-Widget-Api-Key": apiKey },
      });
      const tokenRes = await ctx.get(`${BASE_URL}/api/public/embed/${EMBED_ALLOWLIST_PERMISSIVE_SLUG}/token`);
      const body = await tokenRes.json();
      await ctx.dispose();
      await route.fulfill({ json: body, contentType: "application/json" });
    });

    await loadHost(page, EMBED_ALLOWLIST_PERMISSIVE_SLUG, fakeTokenUrl);
    const widget = await getWidgetIframe(page, EMBED_ALLOWLIST_PERMISSIVE_SLUG);

    await expect(widget.locator(".ew-card").first()).toBeVisible({ timeout: 15_000 });
    await expect(widget.locator(".ew-empty")).toHaveCount(0);
  });

  test("loader iframe shows error state when no token-url is provided for restricted widget", async ({
    page,
  }) => {
    // STRICT widget: allowedDomains=["allowed.e2e.example.com"].
    // No data-edcons-token-url → embed.js calls /token directly without an API key.
    // /token returns 403 → /config returns 403 → widget shows .ew-empty.
    await loadHost(page, EMBED_ALLOWLIST_STRICT_SLUG);
    const widget = await getWidgetIframe(page, EMBED_ALLOWLIST_STRICT_SLUG);

    await expect(widget.locator(".ew-empty")).toBeVisible({ timeout: 15_000 });
    await expect(widget.locator(".ew-empty p")).toContainText(/unable to load widget/i);
    await expect(widget.locator(".ew-card")).toHaveCount(0);
  });

  // ── Public-API tests (server-to-server, no browser) ──────────────────────

  test("public /token returns 200 and /config is accessible with correct X-Widget-Api-Key", async () => {
    const state = getFixtureState();
    const apiKey = state.strictWidgetApiKey;
    expect(apiKey, "strictWidgetApiKey must be in the fixture state file").toBeTruthy();
    const ctx = await pwRequest.newContext({
      extraHTTPHeaders: { "X-Widget-Api-Key": apiKey },
    });
    try {
      const tokenRes = await ctx.get(`${BASE_URL}/api/public/embed/${EMBED_ALLOWLIST_STRICT_SLUG}/token`);
      expect(tokenRes.status(), "correct API key must return 200").toBe(200);
      const { token } = await tokenRes.json();
      expect(token).toBeTruthy();

      const res = await ctx.get(`${BASE_URL}/api/public/embed/${EMBED_ALLOWLIST_STRICT_SLUG}/config?t=${encodeURIComponent(token)}`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.slug).toBe(EMBED_ALLOWLIST_STRICT_SLUG);
      expect(body.mode).toBe("combined");
    } finally {
      await ctx.dispose();
    }
  });

  test("public /programs returns 200 with correct API key session token", async () => {
    const state = getFixtureState();
    const apiKey = state.strictWidgetApiKey;
    expect(apiKey).toBeTruthy();
    const ctx = await pwRequest.newContext({
      extraHTTPHeaders: { "X-Widget-Api-Key": apiKey },
    });
    try {
      const tokenRes = await ctx.get(`${BASE_URL}/api/public/embed/${EMBED_ALLOWLIST_STRICT_SLUG}/token`);
      expect(tokenRes.status()).toBe(200);
      const { token } = await tokenRes.json();

      const res = await ctx.get(`${BASE_URL}/api/public/embed/${EMBED_ALLOWLIST_STRICT_SLUG}/programs?t=${encodeURIComponent(token)}`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.meta).toBeDefined();
    } finally {
      await ctx.dispose();
    }
  });

  test("token endpoint rejects missing X-Widget-Api-Key (no key at all)", async () => {
    // Key gate: restricted widget requires the API key header.
    const ctx = await pwRequest.newContext();
    try {
      const res = await ctx.get(`${BASE_URL}/api/public/embed/${EMBED_ALLOWLIST_STRICT_SLUG}/token`);
      expect(res.status()).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/X-Widget-Api-Key header required/i);
    } finally {
      await ctx.dispose();
    }
  });

  test("token endpoint rejects a wrong/forged X-Widget-Api-Key", async () => {
    // A direct HTTP client with a fabricated key must not receive a session token.
    const ctx = await pwRequest.newContext({
      extraHTTPHeaders: { "X-Widget-Api-Key": "0".repeat(64) },
    });
    try {
      const res = await ctx.get(`${BASE_URL}/api/public/embed/${EMBED_ALLOWLIST_STRICT_SLUG}/token`);
      expect(res.status()).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/invalid widget api key/i);
    } finally {
      await ctx.dispose();
    }
  });

  test("token endpoint rejects correct key from wrong Origin (defense-in-depth)", async () => {
    // KEY SECURITY PROPERTY: even with a valid API key, a browser request whose
    // Origin is not in allowedDomains must be rejected (prevents a stolen key
    // being used from an unauthorized site via browser fetch).
    const state = getFixtureState();
    const apiKey = state.strictWidgetApiKey;
    expect(apiKey).toBeTruthy();
    const ctx = await pwRequest.newContext({
      extraHTTPHeaders: {
        "X-Widget-Api-Key": apiKey,
        Origin: "https://unauthorized.attacker.example.com",
      },
    });
    try {
      const res = await ctx.get(`${BASE_URL}/api/public/embed/${EMBED_ALLOWLIST_STRICT_SLUG}/token`);
      expect(res.status()).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/origin not in widget/i);
    } finally {
      await ctx.dispose();
    }
  });

  test("public /config is rejected with 403 when no token is provided (forged Origin header ignored)", async () => {
    // Forging Origin/Referer headers does NOT bypass the data endpoint gate —
    // the server requires a valid HMAC session token regardless.
    const ctx = await pwRequest.newContext({
      extraHTTPHeaders: {
        Origin: "https://allowed.e2e.example.com",
        Referer: "https://allowed.e2e.example.com/programs",
      },
    });
    try {
      const res = await ctx.get(`${BASE_URL}/api/public/embed/${EMBED_ALLOWLIST_STRICT_SLUG}/config`);
      expect(res.status()).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/invalid or expired embed token/i);
    } finally {
      await ctx.dispose();
    }
  });

  test("public /programs is rejected with 403 when no token is provided", async () => {
    const ctx = await pwRequest.newContext();
    try {
      const res = await ctx.get(`${BASE_URL}/api/public/embed/${EMBED_ALLOWLIST_STRICT_SLUG}/programs`);
      expect(res.status()).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/invalid or expired embed token/i);
    } finally {
      await ctx.dispose();
    }
  });

  test("public /apply is rejected with 403 when no token is provided", async () => {
    // Submission endpoint writes leads — must be locked down without a valid token.
    const ctx = await pwRequest.newContext({
      extraHTTPHeaders: {
        Origin: "https://attacker.e2e.example.com",
        Referer: "https://attacker.e2e.example.com/embed-page",
      },
    });
    try {
      const res = await ctx.post(`${BASE_URL}/api/public/embed/${EMBED_ALLOWLIST_STRICT_SLUG}/apply`, {
        data: {
          firstName: "Attacker",
          lastName: "NoToken",
          email: "attacker-notoken@e2e.test",
        },
      });
      expect(res.status()).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/invalid or expired embed token/i);
    } finally {
      await ctx.dispose();
    }
  });

  test("public /config is rejected with 403 when no token is provided (no headers)", async () => {
    const ctx = await pwRequest.newContext();
    try {
      const res = await ctx.get(`${BASE_URL}/api/public/embed/${EMBED_ALLOWLIST_STRICT_SLUG}/config`);
      expect(res.status()).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/invalid or expired embed token/i);
    } finally {
      await ctx.dispose();
    }
  });
});

/**
 * Full apply submission flow (Task #87).
 *
 * The other desktop tests cover the modal *opening*, but none of them
 * fill out and submit the form. A regression in the submission endpoint,
 * server-side validation, transaction logic, or the success-state UI
 * would slip through. This describe block walks the user through the
 * complete happy path:
 *
 *   1. Load the host page with the seeded `e2e-embed-test` widget
 *      (no allowedDomains => loadable from localhost).
 *   2. Click "Apply Now" on the first program card.
 *   3. The modal opens at the upload step. Click "Skip, fill manually"
 *      to bypass document upload + AI analysis (which would require a
 *      real LLM call) and jump straight to the form step.
 *   4. Fill the three required fields (firstName, lastName, email).
 *      Use a unique e2e-namespaced email so the verification query has
 *      a stable handle even if the suite is re-run rapidly.
 *   5. Click "Submit Application".
 *   6. Assert the success UI (`<div class="ew-success">` with the
 *      "Application Submitted!" heading) replaces the form.
 *   7. Out-of-band, run the verify-submission script to confirm an
 *      `embed_submissions` row was actually written for this widget +
 *      email, with the matching first/last name and a populated lead_id
 *      (route inserts both lead + submission in a single transaction).
 *
 * Cleanup: the existing teardown in
 * `artifacts/api-server/scripts/e2e-embed-fixtures-teardown.ts` already
 * handles this — when the e2e setup created the widget, dropping the
 * widget cascade-deletes its `embed_submissions` rows (FK is
 * `onDelete: "cascade"`); when the widget was reused, the teardown
 * explicitly deletes its submissions; in both branches it also deletes
 * the linked lead rows (source LIKE 'embed:%') and any documents.
 *
 * Tagged @desktop so this only runs on chromium-desktop, not on every
 * mobile viewport (the submission flow is viewport-independent and
 * already covered for layout by the @mobile modal test).
 */
test.describe("embed widget — apply submission", { tag: "@desktop" }, () => {
  test("fills the apply form, submits, shows success, and writes embed_submissions row", async ({
    page,
  }) => {
    await loadHost(page);
    const widget = await getWidgetIframe(page);

    // Wait for the program list to render so the Apply Now button exists.
    await expect(widget.locator(".ew-card").first()).toBeVisible({
      timeout: 10_000,
    });

    // Open the modal.
    await widget
      .locator(".ew-card .ew-btn", { hasText: /apply now/i })
      .first()
      .click();
    await expect(widget.locator(".ew-modal")).toBeVisible({ timeout: 5_000 });

    // Unique per-run email — declared early because we also need it in
    // the personal step below.
    const runId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const submittedEmail = `e2e-apply-${runId}@e2e.test`;
    const firstName = "E2EApply";
    const lastName = `Run${runId}`;

    // We use `dispatchEvent("click")` (rather than `click()`) for the
    // in-modal interactions: the modal is `position:absolute` inside
    // the widget iframe and can extend past the iframe's CSS box (the
    // iframe doesn't auto-grow with absolutely positioned children).
    // Playwright's viewport-bounds heuristic then refuses both the
    // normal click and `click({force:true})` because the click point
    // sits below the iframe's parent-page-visible region.
    // `dispatchEvent` skips that bounds check while still firing the
    // real click handler the widget JS bound at line 1187 of
    // routes/embed.ts. The button being live in the DOM is still
    // verified by `toBeVisible()` immediately above.

    // Step 1 — Personal Info: the modal now opens at the personal step.
    // Wait for the Next button, then atomically fill fields AND click it
    // inside a single evaluate() call so there is no async gap during
    // which loadProgramDocs() can fire its showModal() callback and
    // wipe the values we just set.  JS is single-threaded: all of the
    // field mutations and the click dispatch run synchronously, so
    // handleNextPersonal captures them into savedFormData before any
    // setTimeout/Promise callback can re-render the modal.
    const nextBtn = widget.locator("#ew-next-personal");
    await expect(nextBtn).toBeVisible({ timeout: 8_000 });
    await nextBtn.evaluate(
      (btn, d) => {
        const form = btn.closest("form") as HTMLFormElement | null;
        if (!form) return;
        const set = (name: string, val: string) => {
          const el = form.querySelector(
            `input[name="${name}"]`,
          ) as HTMLInputElement | null;
          if (el) {
            el.value = val;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
        };
        set("firstName", d.firstName);
        set("lastName", d.lastName);
        set("email", d.email);
        // Must be a country-valid number: the /apply endpoint now rejects
        // invalid phones with 422 phone.invalid (TR mobile, 10 digits).
        set("phone", "5321112233");
        // countryCode is a hidden input — must be non-empty or
        // handleNextPersonal blocks with an alert.
        set("countryCode", "+90");
        btn.click();
      },
      { firstName, lastName, email: submittedEmail },
    );

    // Step 2 — Documents: skip the AI upload step to stay out of the
    // LLM round-trip path.  The skip button appears once formStep
    // transitions to 'documents' (after the /lead call resolves).
    const skipBtn = widget.locator("#ew-skip-btn");
    await expect(skipBtn).toBeVisible({ timeout: 10_000 });
    await skipBtn.dispatchEvent("click");

    // Step 3 — Review & Submit.
    const form = widget.locator("#ew-form");
    await expect(form).toBeVisible({ timeout: 5_000 });

    // Same iframe-quirk reason as the skip button: Playwright's `fill`
    // also runs the viewport check. Set the values directly and then
    // dispatch `input`/`change` so any JS listeners fire — the widget's
    // `handleFormSubmit` (routes/embed.ts L1242) reads via `new
    // FormData(form)`, which only needs the value to be set.
    async function setFieldValue(name: string, value: string) {
      await form.locator(`input[name="${name}"]`).evaluate((el, v) => {
        const input = el as HTMLInputElement;
        input.value = v;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, value);
    }
    await setFieldValue("firstName", firstName);
    await setFieldValue("lastName", lastName);
    await setFieldValue("email", submittedEmail);

    // Submit. We verify the button exists and is enabled to surface
    // regressions, then dispatch a `submit` Event directly on the form.
    //
    // The review form has many `required` fields (nationality, DOB, gender,
    // passport, address, …) that the test deliberately leaves empty because
    // they are not relevant to the security/embed-access-control assertions
    // this test exercises.  Native browser validation (triggered by
    // btn.click() or form.requestSubmit()) silently blocks submission when any
    // required field is missing and the form is inside a cross-origin-like
    // iframe — the `submit` event never fires and no API call is made.
    //
    // Dispatching a synthetic `submit` Event bypasses the browser's built-in
    // validation while still calling the widget's `handleFormSubmit` handler
    // (bound via addEventListener).  That handler performs its own lightweight
    // server-side-mirrored check (firstName/lastName/email) and then POSTs to
    // the embed /apply endpoint, which is the actual code path under test.
    const submitBtn = form.locator('button[type="submit"]', {
      hasText: /submit application/i,
    });
    await expect(submitBtn).toBeVisible({ timeout: 5_000 });
    await expect(submitBtn).toBeEnabled({ timeout: 5_000 });
    await form.evaluate((el) => {
      el.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    // Success UI: renderSuccess() replaces the form contents with a
    // `<div class="ew-success">` containing an `<h3>Application
    // Submitted!</h3>`. The form itself disappears.
    const success = widget.locator(".ew-success");
    await expect(success).toBeVisible({ timeout: 10_000 });
    await expect(success.locator("h3")).toHaveText(/application submitted/i);
    await expect(form).toHaveCount(0);

    // Verify the row landed in `embed_submissions` for this widget.
    // Done out-of-band via a tiny tsx script so we don't have to plumb
    // admin auth or a dev-only HTTP endpoint into the test runner.
    //
    // `tsx` is a dependency of `@workspace/api-server`, not the
    // workspace root, so we must scope the exec via `pnpm --filter`.
    // The script path is relative to that package's directory.
    const verifyScript = path.join(
      "scripts",
      "e2e-embed-verify-submission.ts",
    );
    let raw: string;
    try {
      raw = execSync(
        `pnpm --filter @workspace/api-server exec tsx ${verifyScript} --slug ${EMBED_SLUG} --email ${submittedEmail}`,
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
      throw new Error(
        `verify-submission script failed (exit=${e.status ?? "?"})\n` +
          `stdout: ${e.stdout?.toString() ?? ""}\n` +
          `stderr: ${e.stderr?.toString() ?? ""}`,
      );
    }

    const row = JSON.parse(raw) as {
      id: number;
      widgetId: number;
      email: string;
      firstName: string;
      lastName: string;
      leadId: number | null;
      status: string;
      lead: {
        id: number;
        firstName: string;
        lastName: string;
        email: string | null;
        source: string | null;
        status: string;
      } | null;
    };

    expect(row.id).toBeGreaterThan(0);
    expect(row.widgetId).toBeGreaterThan(0);
    expect(row.email.toLowerCase()).toBe(submittedEmail.toLowerCase());
    // The widget normalises first/last names via ewToLatinUpper before
    // sending them to the server, so the stored value is always uppercase.
    expect(row.firstName).toBe(firstName.toUpperCase());
    expect(row.lastName).toBe(lastName.toUpperCase());
    // The route inserts the lead first, then the submission with that
    // lead's id, in a single transaction. A null leadId would mean the
    // transaction broke and only the submission half landed.
    expect(row.leadId).not.toBeNull();
    expect(row.leadId).toBeGreaterThan(0);
    expect(row.status).toBe("new");

    // The route also writes a `leads` row tagged `embed:<slug>` and
    // wires it back as the FK target. Asserting the lead payload here
    // catches a regression that lands the submission but skips/breaks
    // the lead insert (or mis-tags `source`).
    expect(row.lead).not.toBeNull();
    expect(row.lead!.id).toBe(row.leadId);
    // ewToLatinUpper normalises names to uppercase before the server stores them.
    expect(row.lead!.firstName).toBe(firstName.toUpperCase());
    expect(row.lead!.lastName).toBe(lastName.toUpperCase());
    expect(row.lead!.email?.toLowerCase()).toBe(submittedEmail.toLowerCase());
    expect(row.lead!.source).toBe(`embed:${EMBED_SLUG}`);
    // /apply auto-converts the lead (leads.status = "converted") once the
    // full application is submitted.
    expect(row.lead!.status).toBe("converted");
  });
});
