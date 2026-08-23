/**
 * Playwright e2e tests for the DashboardLayout sidebar.
 *
 * Guards against the class of crash introduced by the collapsible-groups
 * refactor (Rules of Hooks violation). Three scenarios are covered:
 *
 *   1. No ErrorBoundary screen after login — the dashboard and its sidebar
 *      mount cleanly with no React render error.
 *
 *   2. Collapsible group expand / collapse — clicking a group header that
 *      starts closed (e.g. "System & Management") opens it; clicking again
 *      closes it. This directly exercises the hook path that was broken.
 *
 *   3. API Tokens link is reachable — the "API Tokens" item inside
 *      "System & Management" is present after the group expands and
 *      navigates to /admin/api-tokens on click.
 *
 * Required env (set by .replit [userenv.development] / CI):
 *   PLAYWRIGHT_BASE_URL    e.g. http://localhost:25197
 *   PLAYWRIGHT_STAFF_EMAIL admin/super_admin login email
 *   PLAYWRIGHT_STAFF_PASS  password
 *
 * Run:
 *   pnpm test:e2e --grep sidebar
 */

import { test, expect, type Page } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:25197";
const STAFF_EMAIL = process.env.PLAYWRIGHT_STAFF_EMAIL || "";
const STAFF_PASS = process.env.PLAYWRIGHT_STAFF_PASS || "";

// ─── helpers ──────────────────────────────────────────────────────────────────

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/login`);
  await page.getByLabel(/email/i).fill(STAFF_EMAIL);
  await page.getByLabel(/password/i).fill(STAFF_PASS);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await page.waitForURL(
    /\/(staff\/dashboard|admin\/dashboard|admin$|staff$|\/en\/|\/tr\/)/i,
    { timeout: 20_000 },
  );
}

// ─── tests ────────────────────────────────────────────────────────────────────

test.describe("sidebar: crash guard and navigation", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  // ── 1. No ErrorBoundary after login ────────────────────────────────────────

  test("dashboard loads without an ErrorBoundary crash screen", async ({ page }) => {
    // The ErrorBoundary fallback renders a "Reload" button and an AlertTriangle.
    // If either is present the app has crashed.
    const reloadBtn = page.getByRole("button", { name: /^reload$/i });
    await expect(reloadBtn).not.toBeVisible({ timeout: 8_000 });

    // The sidebar nav should be visible — it is the first thing DashboardLayout
    // renders after a successful auth resolution.
    const sidebar = page.locator('[data-sidebar="sidebar"]').first();
    await expect(sidebar).toBeVisible({ timeout: 10_000 });
  });

  // ── 2. Collapsible group expands and collapses ─────────────────────────────

  test("System & Management group can be expanded and collapsed", async ({ page }) => {
    // "system" is in DEFAULT_CLOSED_GROUPS so it starts collapsed.
    // The group header is a <button> with the group label as its visible text.
    const groupHeader = page.getByRole("button", {
      name: /system\s*&\s*management/i,
    });
    await expect(groupHeader).toBeVisible({ timeout: 10_000 });

    // A child nav link that should only be visible when the group is open.
    // "API Tokens" (key: dashboard.apiTokens) lives in this group.
    const apiTokensLink = page.getByRole("link", { name: /api tokens/i }).first();

    // ── Expand ─────────────────────────────────────────────────────────────
    // Collapsed by default — the link should not be visible yet.
    await expect(apiTokensLink).not.toBeVisible({ timeout: 5_000 });

    await groupHeader.click();

    // After expanding the group the link must become visible.
    await expect(apiTokensLink).toBeVisible({ timeout: 5_000 });

    // ── Collapse ───────────────────────────────────────────────────────────
    await groupHeader.click();

    await expect(apiTokensLink).not.toBeVisible({ timeout: 5_000 });
  });

  // ── 3. API Tokens link navigates correctly ─────────────────────────────────

  test("API Tokens link is present in System & Management and navigates to /admin/api-tokens", async ({ page }) => {
    const groupHeader = page.getByRole("button", {
      name: /system\s*&\s*management/i,
    });
    await expect(groupHeader).toBeVisible({ timeout: 10_000 });

    // Open the group.
    await groupHeader.click();

    const apiTokensLink = page.getByRole("link", { name: /api tokens/i }).first();
    await expect(apiTokensLink).toBeVisible({ timeout: 5_000 });

    // Click the link via SPA navigation (handleNavClick intercepts left-clicks).
    await apiTokensLink.click();

    // The URL should include /admin/api-tokens.
    await page.waitForURL(/\/admin\/api-tokens/i, { timeout: 15_000 });

    // And the page content should not be an error screen.
    const reloadBtn = page.getByRole("button", { name: /^reload$/i });
    await expect(reloadBtn).not.toBeVisible({ timeout: 5_000 });
  });
});
