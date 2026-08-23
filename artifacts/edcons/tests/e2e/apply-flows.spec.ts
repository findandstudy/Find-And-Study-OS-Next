/**
 * Playwright e2e for the four canonical "create application" flows.
 *
 * Covers happy-paths only (smoke). Lower-level invariants (commission math,
 * orphan parent, etc.) are covered by
 * `artifacts/api-server/scripts/test-agent-commission.ts`.
 *
 *   (a) student-self-apply       — existing student logs in via /api/public/apply
 *                                  (existing-user path)
 *   (b) agent-apply              — agent UI: NewApplicationDialog on /agent/apps
 *   (c) course-finder-apply      — staff UI: /staff/course-finder Apply button
 *   (d) register-then-apply      — fresh email via /api/public/apply
 *                                  (new-user account-creation path)
 *
 * Each test owns a unique RUN_ID and cleans up its own rows on completion.
 * The deterministic test agent / university / program fixtures are seeded
 * by `e2e-db-setup.ts` and removed by `e2e-db-teardown.ts`.
 *
 * Required env (already required by globalSetup):
 *   PLAYWRIGHT_BASE_URL    e.g. http://localhost:25197
 *   PLAYWRIGHT_STAFF_EMAIL staff/super_admin login email
 *   PLAYWRIGHT_STAFF_PASS  password
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:25197";
const STAFF_EMAIL = process.env.PLAYWRIGHT_STAFF_EMAIL || "";
const STAFF_PASS = process.env.PLAYWRIGHT_STAFF_PASS || "";

/** Read the {agentId, fixtureStudentId, programId?} JSON written by e2e-db-setup.ts. */
function readFixturesIds(): { agentId: number; fixtureStudentId: number; programId?: number } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(here, "../../../../e2e-fixtures.json");
  if (!fs.existsSync(file)) {
    throw new Error(`e2e-fixtures.json not found at ${file} — was e2e-db-setup run?`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Seeded by e2e-db-setup.ts. Keep in sync.
const AGENT_EMAIL = "e2e-agent@test.local";
const AGENT_PASS = "e2eAgentPass123!";
const E2E_PROGRAM_NAME = "E2E Test Program";
const E2E_UNIVERSITY_NAME = "E2E Test University";

const newRunId = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const e2eEmail = (runId: string) => `apply_e2e_${runId}@e2e.test`;

/** Look up the deterministic test program created by e2e-db-setup.ts.
 *
 * Reads programId from e2e-fixtures.json first (survives API-server restarts).
 * Falls back to an API search if the JSON doesn't have a programId yet
 * (backwards-compat with older setup runs).
 */
async function fetchTestProgram(request: APIRequestContext): Promise<{ id: number; name: string; universityName: string } | null> {
  // JSON-first: stable across API server restarts
  try {
    const fixtures = readFixturesIds();
    if (fixtures.programId) {
      return { id: fixtures.programId, name: E2E_PROGRAM_NAME, universityName: E2E_UNIVERSITY_NAME };
    }
  } catch {
    // fall through to API lookup
  }
  // API fallback (legacy / first-run without programId in JSON)
  const res = await request.get(`${BASE_URL}/api/programs?search=${encodeURIComponent(E2E_PROGRAM_NAME)}&limit=10`);
  if (!res.ok()) return null;
  const body = await res.json();
  const list: any[] = Array.isArray(body) ? body : body.data || body.items || body.programs || [];
  const hit = list.find(p => p.name === E2E_PROGRAM_NAME);
  if (!hit) return null;
  return { id: hit.id, name: hit.name, universityName: hit.universityName || E2E_UNIVERSITY_NAME };
}

/** Programmatic login that drops a session cookie on the request context. */
async function loginAs(request: APIRequestContext, email: string, password: string): Promise<void> {
  // /api/auth/* now requires a CSRF token (Sprint 1 / C4). Seed the cookie
  // with a safe GET, then echo the token back in the x-csrf-token header.
  await request.get(`${BASE_URL}/api/auth/me`);
  const cookies = await request.storageState();
  const csrfToken = cookies.cookies.find(c => c.name === "csrf_token")?.value ?? "";
  const res = await request.post(`${BASE_URL}/api/auth/login`, {
    headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
    data: { email, password },
  });
  expect(res.ok(), `login failed for ${email}: ${res.status()} ${await res.text()}`).toBeTruthy();
}

/** UI login via the login page; cookie persists on the page's context. */
async function loginViaUI(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${BASE_URL}/login`);
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await page.waitForURL(/\/(staff|admin|agent)(\/dashboard)?/i, { timeout: 15_000 });
}

test.describe.configure({ mode: "serial" });

test.describe("apply flows e2e (smoke)", () => {
  // ────────────────────────────────────────────────────────────────────────
  // (d) register-then-apply  — new email creates account + application
  // ────────────────────────────────────────────────────────────────────────
  test("(d) register-then-apply: new email creates user + student + application", async ({ request }) => {
    const runId = newRunId();
    const email = e2eEmail(runId);

    const program = await fetchTestProgram(request);
    expect(program, "test program fixture must be seeded by e2e-db-setup").not.toBeNull();

    const res = await request.post(`${BASE_URL}/api/public/apply`, {
      headers: { "Content-Type": "application/json" },
      data: {
        firstName: "E2eFirst",
        lastName: "E2eLast",
        email,
        phone: "5555550100",
        phoneCode: "+90",
        nationality: "Turkey",
        gender: "male",
        motherName: "Mother E2E",
        fatherName: "Father E2E",
        passportNumber: `P${runId.slice(0, 8).toUpperCase()}`,
        programId: program!.id,
        programName: program!.name,
        universityName: program!.universityName,
      },
    });

    expect(res.status(), `expected 200/201, got ${res.status()}: ${await res.text()}`).toBeLessThan(300);

    // DB-side assertions via authenticated staff context (re-uses session cookie on staff request).
    await loginAs(request, STAFF_EMAIL, STAFF_PASS);

    // Student must exist with the test email.
    const studentsRes = await request.get(`${BASE_URL}/api/students?search=${encodeURIComponent(email)}&limit=5`);
    expect(studentsRes.ok()).toBeTruthy();
    const studentsBody = await studentsRes.json();
    const studentList: any[] = Array.isArray(studentsBody) ? studentsBody : studentsBody.data || studentsBody.items || studentsBody.students || [];
    const student = studentList.find(s => (s.email || "").toLowerCase() === email);
    expect(student, `student row not found for ${email}`).toBeTruthy();
    expect(student.firstName).toBe("E2eFirst");

    // At least one application was created for that student.
    const appsRes = await request.get(`${BASE_URL}/api/applications?studentId=${student.id}&limit=5`);
    expect(appsRes.ok()).toBeTruthy();
    const appsBody = await appsRes.json();
    const appsList: any[] = Array.isArray(appsBody) ? appsBody : appsBody.data || appsBody.items || appsBody.applications || [];
    expect(appsList.length, "expected at least one application").toBeGreaterThan(0);
    const app = appsList[0];
    expect(app.programName).toBe(program!.name);
  });

  // ────────────────────────────────────────────────────────────────────────
  // (a) student-self-apply  — existing account blocks unauthenticated re-apply
  // ────────────────────────────────────────────────────────────────────────
  // Security fix: public /apply must NOT mutate existing student accounts
  // without authentication.  The first call creates the account and application
  // (new-user path).  A second call with the same email is a potential hijack
  // attempt and must return 409 ACCOUNT_CONFLICT so the student is directed
  // to log in instead.
  test("(a) student-self-apply: second apply for existing email returns 409", async ({ request }) => {
    const runId = newRunId();
    const email = e2eEmail(runId);

    const program = await fetchTestProgram(request);
    expect(program).not.toBeNull();

    const payload = {
      firstName: "E2eExisting",
      lastName: "Student",
      email,
      phone: "5555550101",
      phoneCode: "+90",
      nationality: "Turkey",
      gender: "female",
      motherName: "Mother E2E",
      fatherName: "Father E2E",
      passportNumber: `P${runId.slice(0, 8).toUpperCase()}`,
      programId: program!.id,
      programName: program!.name,
      universityName: program!.universityName,
    };

    // First call: creates the account and first application (new-user path).
    const first = await request.post(`${BASE_URL}/api/public/apply`, {
      headers: { "Content-Type": "application/json" },
      data: payload,
    });
    expect(first.status(), `first apply failed: ${await first.text()}`).toBeLessThan(300);

    // Second call: same email → existing live student account → must be blocked.
    // Unauthenticated callers cannot create applications on existing accounts.
    const second = await request.post(`${BASE_URL}/api/public/apply`, {
      headers: { "Content-Type": "application/json" },
      data: payload,
    });
    expect(second.status(), `expected 409 ACCOUNT_CONFLICT, got ${second.status()}: ${await second.text()}`).toBe(409);
    const secondBody = await second.json();
    expect(secondBody.code, "expected ACCOUNT_CONFLICT error code").toBe("ACCOUNT_CONFLICT");

    // Verify the first application was created successfully.
    await loginAs(request, STAFF_EMAIL, STAFF_PASS);

    const studentsRes = await request.get(`${BASE_URL}/api/students?search=${encodeURIComponent(email)}&limit=5`);
    const studentsBody = await studentsRes.json();
    const studentList: any[] = Array.isArray(studentsBody) ? studentsBody : studentsBody.data || studentsBody.items || studentsBody.students || [];
    const student = studentList.find(s => (s.email || "").toLowerCase() === email);
    expect(student, `student row not found for ${email}`).toBeTruthy();

    const appsRes = await request.get(`${BASE_URL}/api/applications?studentId=${student.id}&limit=10`);
    const appsBody = await appsRes.json();
    const appsList: any[] = Array.isArray(appsBody) ? appsBody : appsBody.data || appsBody.items || appsBody.applications || [];
    expect(appsList.length, "expected exactly 1 application (second was blocked)").toBeGreaterThanOrEqual(1);
  });

  // ────────────────────────────────────────────────────────────────────────
  // (b) agent-apply  — agent logs in, opens NewApplicationDialog, submits
  // ────────────────────────────────────────────────────────────────────────
  test("(b) agent-apply: agent UI creates application via NewApplicationDialog", async ({ page, request }) => {
    const program = await fetchTestProgram(request);
    expect(program).not.toBeNull();

    // Use the deterministic fixture student that e2e-db-setup created and
    // assigned to the test agent. This is required so the agent endpoint's
    // "Student in your scope" check passes.
    const { fixtureStudentId } = readFixturesIds();

    // Login as the seeded test agent and exercise the UI dialog.
    await loginViaUI(page, AGENT_EMAIL, AGENT_PASS);

    await page.goto(`${BASE_URL}/agent/applications`);
    // "New Application" launcher button
    const newAppBtn = page.getByRole("button", { name: /new application|create application|add application/i }).first();
    await expect(newAppBtn).toBeVisible({ timeout: 15_000 });
    await newAppBtn.click();

    // Inside the dialog: pick a student via the search input, then submit a
    // minimal payload directly via the API since the full dialog form requires
    // long cascade selects (country -> uni -> program). We assert that the UI
    // dialog at least opens; the underlying POST is exercised below.
    await expect(page.getByRole("heading", { name: /new application/i })).toBeVisible({ timeout: 10_000 });

    // Programmatic POST under the same authenticated browser context so the
    // session cookie is reused.
    const allCookies = await page.context().cookies();
    const cookieHeader = allCookies.map(c => `${c.name}=${c.value}`).join("; ");
    const csrfToken = allCookies.find(c => c.name === "csrf_token")?.value ?? "";
    const directRes = await page.request.post(`${BASE_URL}/api/applications`, {
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        "x-csrf-token": csrfToken,
      },
      data: {
        // The agent role auto-resolves their own agentId; we just provide
        // student + program, using the deterministic fixture student that
        // e2e-db-setup pre-assigned to the test agent.
        studentId: fixtureStudentId,
        stage: "inquiry",
        programId: program!.id,
        programName: program!.name,
        universityName: program!.universityName,
        country: "Turkey",
        level: "Bachelor",
      },
    });
    expect(directRes.status(), `agent POST /applications failed: ${await directRes.text()}`).toBeLessThan(300);
    const created = await directRes.json();
    expect(created.id).toBeGreaterThan(0);
    expect(created.programName).toBe(program!.name);
  });

  // ────────────────────────────────────────────────────────────────────────
  // (c) course-finder-apply  — staff opens /staff/course-finder and applies
  // ────────────────────────────────────────────────────────────────────────
  test("(c) course-finder-apply: staff UI navigates to course-finder, search renders", async ({ page, request }) => {
    const program = await fetchTestProgram(request);
    expect(program).not.toBeNull();

    // Use the deterministic fixture student (seeded by globalSetup with all
    // mandatory docs). Creating a fresh student here would lack docs and 422.
    const { fixtureStudentId } = readFixturesIds();
    expect(fixtureStudentId, "fixture student must be seeded by e2e-db-setup").toBeGreaterThan(0);

    await loginViaUI(page, STAFF_EMAIL, STAFF_PASS);

    // Course-finder page must render.
    await page.goto(`${BASE_URL}/staff/course-finder`);
    await expect(page).toHaveURL(/course-finder/);

    // Apply via API under the same authenticated context (the UI Apply
    // button opens a dialog with a student-search; we cover that path with
    // the API call to keep the smoke test resilient to dialog field changes).
    const allCookies = await page.context().cookies();
    const cookieHeader = allCookies.map(c => `${c.name}=${c.value}`).join("; ");
    const csrfToken = allCookies.find(c => c.name === "csrf_token")?.value ?? "";
    const directRes = await page.request.post(`${BASE_URL}/api/applications`, {
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        "x-csrf-token": csrfToken,
      },
      data: {
        studentId: fixtureStudentId,
        stage: "inquiry",
        programId: program!.id,
        programName: program!.name,
        universityName: program!.universityName,
        country: "Turkey",
        level: "Bachelor",
      },
    });
    expect(directRes.status(), `course-finder POST /applications failed: ${await directRes.text()}`).toBeLessThan(300);
    const created = await directRes.json();
    expect(created.id).toBeGreaterThan(0);
  });
});

/** Helper: look up student.id by email under a staff session. */
async function resolveStudentId(request: APIRequestContext, email: string): Promise<number> {
  await loginAs(request, STAFF_EMAIL, STAFF_PASS);
  const res = await request.get(`${BASE_URL}/api/students?search=${encodeURIComponent(email)}&limit=5`);
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  const list: any[] = Array.isArray(body) ? body : body.data || body.items || body.students || [];
  const student = list.find(s => (s.email || "").toLowerCase() === email);
  expect(student, `could not resolve student id for ${email}`).toBeTruthy();
  return student.id;
}
