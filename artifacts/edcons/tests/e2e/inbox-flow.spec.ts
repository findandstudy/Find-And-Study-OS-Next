/**
 * Playwright e2e for the omnichannel inbox.
 *
 * Covers the canonical happy-path:
 *   1. Post an inbound webhook (web_form, no secret -> auth-free in dev).
 *   2. Sign in as a staff/super_admin user.
 *   3. Open /staff/messages, switch to the "Unmatched" tab, select the
 *      newly-created conversation, and click "Assign to me".
 *   4. Switch to the "Mine" tab and assert the conversation now appears
 *      there.
 *
 * This file is intentionally framework-light (only depends on
 * @playwright/test) so it can be wired into CI as a single `playwright test`
 * invocation once the runner is installed at the repo root. The integration
 * checks in `artifacts/api-server/scripts/test-inbox-suite.ts` cover the
 * lower-level invariants (dedup, identity resolver, signature gates) and
 * run today via `pnpm --filter @workspace/api-server test`.
 *
 * Required env (set by CI):
 *   PLAYWRIGHT_BASE_URL    e.g. http://localhost:5000
 *   PLAYWRIGHT_STAFF_EMAIL staff/super_admin login email
 *   PLAYWRIGHT_STAFF_PASS  password
 *
 * Run:
 *   pnpm dlx playwright test artifacts/edcons/tests/e2e/inbox-flow.spec.ts
 */
import { test, expect, type APIRequestContext } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:5000";
const STAFF_EMAIL = process.env.PLAYWRIGHT_STAFF_EMAIL || "";
const STAFF_PASS = process.env.PLAYWRIGHT_STAFF_PASS || "";

const RUN_ID = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const TEST_NAME = `Playwright Inbox ${RUN_ID}`;
const TEST_EMAIL = `inbox_${RUN_ID}@e2e.test`;
const TEST_MESSAGE = `automated e2e webhook ${RUN_ID}`;

test.describe("inbox e2e: webhook -> assign -> mine", () => {
  // KNOWN FLAKY: this test is pre-existing infrastructure-sensitive.
  // When Hostinger SMTP rate-limits the dev environment (450/451 4.7.1
  // "too many AUTH commands" / "hostinger_out_ratelimit") the server-side
  // email notification triggered by the webhook POST can cause the request
  // handler to stall, making the conversation take longer to appear in the
  // Unmatched tab. This is NOT a code regression — it is a transient
  // infra limit. If the test fails with a timeout on `conversationItem`,
  // check the api-server logs for SMTP rate-limit errors first.
  test("inbound webhook lands, can be assigned, and moves to Mine", async ({
    page,
    request,
  }) => {
    // 1. Post an inbound web_form webhook. In dev with no secret configured
    //    on the integration, the webhook is auth-free and accepts anonymous
    //    posts; CI should run with web_form integration enabled but with no
    //    secret to keep this test self-contained.
    const inbound = await postWebhook(request);
    expect(inbound.ok).toBeTruthy();

    // 2. Log in as a staff user.
    await page.goto(`${BASE_URL}/login`);
    await page.getByLabel(/email/i).fill(STAFF_EMAIL);
    await page.getByLabel(/password/i).fill(STAFF_PASS);
    await page.getByRole("button", { name: /sign in|log in/i }).click();
    await page.waitForURL(/\/staff\/dashboard|\/admin\/dashboard|\/dashboard/i, {
      timeout: 15_000,
    });

    // 3. Open the Messages page, expose test-tagged conversations, and switch
    //    to Unmatched through the current inbox-filter dropdown.
    await page.goto(`${BASE_URL}/staff/messages`);
    const showTests = page.getByTestId("button-inbox-show-tests");
    await expect(showTests).toBeVisible({ timeout: 15_000 });
    await showTests.click();
    const tabFilter = page.getByTestId("button-inbox-tab-filter");
    await expect(tabFilter).toBeVisible({ timeout: 15_000 });
    await tabFilter.click();
    await page.getByRole("menuitem", { name: /unmatched/i }).click();

    // Pick the conversation by its run-tagged display name / message body.
    const conversationItem = page
      .locator('[data-testid="inbox-conversation-item"], li, button')
      .filter({ hasText: TEST_NAME })
      .first();
    await expect(conversationItem).toBeVisible({ timeout: 10_000 });
    await conversationItem.click();

    // 4. Assign to me, then assert the conversation now appears in Mine.
    const assignBtn = page.getByTestId("button-assign-staff");
    await expect(assignBtn).toBeVisible();
    await assignBtn.click();
    const staffSearch = page.getByTestId("input-assign-staff-search");
    await expect(staffSearch).toBeVisible();
    await staffSearch.fill("Find Study");
    await page.getByRole("menuitem", { name: /^Find Study$/i }).click();
    await expect(page.getByText(/assigned to you/i)).toBeVisible({
      timeout: 5_000,
    });

    await tabFilter.click();
    await page.getByRole("menuitem", { name: /^mine/i }).click();
    const inMine = page
      .locator('[data-testid="inbox-conversation-item"], li, button')
      .filter({ hasText: TEST_NAME })
      .first();
    await expect(inMine).toBeVisible({ timeout: 10_000 });
  });
});

async function postWebhook(request: APIRequestContext): Promise<{ ok: boolean }> {
  const res = await request.post(`${BASE_URL}/api/webhooks/web-form`, {
    headers: { "Content-Type": "application/json" },
    data: {
      name: TEST_NAME,
      email: TEST_EMAIL,
      message: TEST_MESSAGE,
      submission_id: `e2e_${RUN_ID}`,
    },
  });
  return { ok: res.ok() };
}
