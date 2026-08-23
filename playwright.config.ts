import { defineConfig, devices } from "@playwright/test";
import { execSync } from "child_process";
import { existsSync } from "node:fs";

function findSystemChromium(): string | undefined {
  const envPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  const knownPaths = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  const knownPath = knownPaths.find((candidate) => existsSync(candidate));
  if (knownPath) return knownPath;

  try {
    const p = execSync("command -v chromium || command -v google-chrome", {
      stdio: ["pipe", "pipe", "pipe"],
    })
      .toString()
      .trim();
    return p || undefined;
  } catch {
    return undefined;
  }
}

const systemChromium = findSystemChromium();

const chromiumLaunchOptions = systemChromium
  ? { executablePath: systemChromium, args: ["--lang=en-US"] }
  : undefined;

/**
 * Mobile viewport projects for the embed widget tests.
 *
 * We use raw viewport configs (not Playwright device presets) so each
 * project can run on the host's chromium binary — Playwright's iPhone /
 * iPad presets default to WebKit, which is not always available locally
 * (see WebKit gating below). The viewports below cover representative
 * phone & tablet form factors that real partners embed the widget on:
 *
 *   - small Android (Galaxy / older Pixel class):  360 x 740
 *   - large modern iPhone (Pro Max class):         430 x 932
 *   - tablet portrait (iPad-class):                768 x 1024
 *
 * All run only the @mobile-tagged tests in embed-widget.spec.ts.
 */
const MOBILE_VIEWPORTS: Array<{
  name: string;
  viewport: { width: number; height: number };
}> = [
  {
    name: "chromium-mobile-android-small",
    viewport: { width: 360, height: 740 },
  },
  {
    name: "chromium-mobile-iphone-large",
    viewport: { width: 430, height: 932 },
  },
  {
    name: "chromium-tablet-portrait",
    viewport: { width: 768, height: 1024 },
  },
];

/**
 * WebKit coverage. The widget is meant to be embedded on partner sites
 * visited from Safari (desktop + iOS), so we want at least one WebKit
 * project to catch Safari-specific iframe + scroll-lock differences.
 *
 * Gated by RUN_WEBKIT_E2E=1 because WebKit's bundled binary needs system
 * libs (libgstreamer, libwoff2, etc.) that aren't installed on every
 * host. CI / local environments that have those libs (or use
 * `pkgs.playwright-driver.browsers`) can opt in by exporting the flag.
 * Default off so the chromium projects always pass without flake.
 */
const WEBKIT_ENABLED = process.env.RUN_WEBKIT_E2E === "1";

export default defineConfig({
  testDir: "./artifacts/edcons/tests/e2e",

  globalSetup: "./playwright-global-setup.ts",
  globalTeardown: "./playwright-global-teardown.ts",

  timeout: 60_000,
  expect: { timeout: 10_000 },

  reporter: [["line"], ["junit", { outputFile: "test-results/e2e-results.xml" }]],

  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:25197",
    locale: "en-US",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    // Default chromium-desktop project. Runs all non-@mobile tests
    // (inbox flow + embed widget desktop cases). Preserves the previous
    // behaviour of the single `chromium` project.
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(chromiumLaunchOptions ? { launchOptions: chromiumLaunchOptions } : {}),
      },
      grepInvert: /@mobile/,
    },

    // Additional mobile/tablet viewports. Scoped to embed widget tests
    // and only @mobile-tagged cases so we don't redundantly re-run the
    // inbox flow or the desktop embed cases on every viewport.
    ...MOBILE_VIEWPORTS.map((v) => ({
      name: v.name,
      use: {
        browserName: "chromium" as const,
        viewport: v.viewport,
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
        ...(chromiumLaunchOptions ? { launchOptions: chromiumLaunchOptions } : {}),
      },
      grep: /@mobile/,
      testMatch: /embed-widget\.spec\.ts/,
    })),

    // WebKit (opt-in). Covers desktop Safari + mobile iOS Safari for the
    // embed widget only, so we don't re-run unrelated suites under webkit.
    ...(WEBKIT_ENABLED
      ? [
          {
            name: "webkit-desktop",
            use: { ...devices["Desktop Safari"] },
            grepInvert: /@mobile/,
            testMatch: /embed-widget\.spec\.ts/,
          },
          {
            name: "webkit-mobile-iphone",
            use: { ...devices["iPhone 14"] },
            grep: /@mobile/,
            testMatch: /embed-widget\.spec\.ts/,
          },
        ]
      : []),
  ],

  webServer: [
    {
      command: "pnpm --filter @workspace/api-server run dev",
      port: 8080,
      timeout: 60_000,
      reuseExistingServer: true,
      env: {
        PORT: "8080",
        NODE_ENV: "development",
      },
    },
    {
      command: "pnpm --filter @workspace/edcons run dev",
      port: 25197,
      timeout: 60_000,
      reuseExistingServer: true,
      env: {
        PORT: "25197",
        NODE_ENV: "development",
        BASE_PATH: "/",
      },
    },
  ],
});
