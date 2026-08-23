/**
 * Bölüm A2 — Rol-bazlı Fonksiyonel E2E (DEV ONLY)
 *
 * 11 rol × 6 alan:
 *   (1) Finans         — FINANCE_ROLES erişim sınırı
 *   (2) AI Modları     — ADMIN_ROLES erişim sınırı (personas/extractors/action-queue)
 *   (3) Bildirimler    — tüm roller unread-count okuyabilir; notification-rules ADMIN_ROLES
 *   (4) Mesajlaşma     — conversations/broadcasts/templates erişim sınırları
 *   (5) Süreç Takibi   — leads/students/applications pipeline görünürlüğü
 *   (6) Agent Network  — agent/sub_agent/agent_staff 7 izin scope
 *
 * Her test: rol + endpoint + beklenen HTTP kodu.
 * Gerçek dış mesaj / ödeme YOK. Yalnızca GET (okuma) ve 403 sınır kontrolleri.
 *
 * Kurulum öncesinde çalıştır:
 *   cd artifacts/api-server && pnpm exec tsx scripts/rbac-e2e-setup.ts
 */

import {
  test,
  expect,
  type APIRequestContext,
} from "@playwright/test";

// ─── Sabitler ────────────────────────────────────────────────────────────────

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:25197";
const API = "http://localhost:8080/api";
const PASS = process.env.RBAC_E2E_PASSWORD || "";

const A = {
  superadmin:  "audit-superadmin@audit.test",
  admin:       "audit-admin@audit.test",
  manager:     "audit-manager@audit.test",
  staff:       "audit-staff@audit.test",
  consultant:  "audit-consultant@audit.test",
  editor:      "audit-editor@audit.test",
  accountant:  "audit-accountant@audit.test",
  agent:       "audit-agent@audit.test",
  subagent:    "audit-subagent@audit.test",
  agentstaff:  "audit-agentstaff@audit.test",
  student:     "audit-student@audit.test",
} as const;

// ─── Yardımcı fonksiyonlar ───────────────────────────────────────────────────

/** Programmatic login — CSRF seed → POST /auth/login */
async function loginAs(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<void> {
  if (!password) {
    throw new Error("RBAC_E2E_PASSWORD is required for RBAC functional E2E tests");
  }
  await request.get(`${API}/auth/me`);
  const state = await request.storageState();
  const csrf = state.cookies.find((c) => c.name === "csrf_token")?.value ?? "";
  const res = await request.post(`${API}/auth/login`, {
    headers: { "Content-Type": "application/json", "x-csrf-token": csrf },
    data: { email, password },
  });
  if (!res.ok() && res.status() !== 200) {
    throw new Error(`Login failed for ${email}: ${res.status()} ${await res.text()}`);
  }
}

/**
 * Returns HTTP status of a GET request to ${API}${path} authenticated as ${email}.
 * Uses a fresh APIRequestContext per call so sessions don't bleed between tests.
 */
async function getStatus(
  request: APIRequestContext,
  email: string,
  path: string,
): Promise<number> {
  await loginAs(request, email, PASS);
  const res = await request.get(`${API}${path}`);
  return res.status();
}

// ─── Area 1: Finans ──────────────────────────────────────────────────────────
// FINANCE_ROLES = ["super_admin", "admin", "accountant"]
// Diğer tüm roller → 403

test.describe("AREA 1 — Finans RBAC", () => {
  const FINANCE_ENDPOINT = "/finance/university-receivables";

  // İzin verilenler (FINANCE_ROLES)
  for (const [label, email] of [
    ["superadmin", A.superadmin],
    ["admin", A.admin],
    ["accountant", A.accountant],
  ] as const) {
    test(`${label} → 200 on GET /api${FINANCE_ENDPOINT}`, async ({ request }) => {
      const status = await getStatus(request, email, FINANCE_ENDPOINT);
      expect(status, `${label} should access finance`).toBe(200);
    });
  }

  // Yasaklılar (non-FINANCE)
  for (const [label, email] of [
    ["manager", A.manager],
    ["staff", A.staff],
    ["consultant", A.consultant],
    ["editor", A.editor],
    ["student", A.student],
    ["agent", A.agent],
    ["subagent", A.subagent],
    ["agentstaff", A.agentstaff],
  ] as const) {
    test(`${label} → 403 on GET /api${FINANCE_ENDPOINT}`, async ({ request }) => {
      const status = await getStatus(request, email, FINANCE_ENDPOINT);
      expect(status, `${label} should NOT access finance`).toBe(403);
    });
  }

  // UI: accountant /staff/finance sayfasını açabilmeli
  test("UI — accountant /staff/finance sayfası yüklenir", async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.getByLabel(/email/i).fill(A.accountant);
    await page.getByLabel(/password/i).fill(PASS);
    await page.getByRole("button", { name: /sign in|log in/i }).click();
    await page.waitForURL(/\/(staff|admin)/i, { timeout: 20_000 });
    await page.goto(`${BASE_URL}/staff/finance`);
    await page.waitForTimeout(2_000);
    const url = page.url();
    expect(url, "accountant stays on finance page").toContain("finance");
    const errBoundary = page.getByRole("button", { name: /^reload$/i });
    await expect(errBoundary).not.toBeVisible({ timeout: 3_000 });
  });

  // UI: staff /staff/finance'a erişemez → yönlendirme
  test("UI — staff /staff/finance'a erişemez (yönlendirme)", async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.getByLabel(/email/i).fill(A.staff);
    await page.getByLabel(/password/i).fill(PASS);
    await page.getByRole("button", { name: /sign in|log in/i }).click();
    await page.waitForURL(/\/(staff|admin)/i, { timeout: 20_000 });
    await page.goto(`${BASE_URL}/staff/finance`);
    await page.waitForTimeout(2_000);
    const url = page.url();
    expect(url, "staff redirected away from /staff/finance").not.toContain("/staff/finance");
  });
});

// ─── Area 2: AI Modları ──────────────────────────────────────────────────────
// ADMIN_ROLES = ["super_admin", "admin", "manager"]
// ai-personas, ai-extractors → ADMIN_ROLES; diğerleri → 403

test.describe("AREA 2 — AI Modları RBAC", () => {
  // İzin verilenler
  for (const [label, email] of [
    ["superadmin", A.superadmin],
    ["admin", A.admin],
    ["manager", A.manager],
  ] as const) {
    test(`${label} → 200 on GET /api/ai-personas`, async ({ request }) => {
      const status = await getStatus(request, email, "/ai-personas");
      expect(status, `${label} should access ai-personas`).toBe(200);
    });

    test(`${label} → 200 on GET /api/ai-extractors`, async ({ request }) => {
      const status = await getStatus(request, email, "/ai-extractors");
      expect(status, `${label} should access ai-extractors`).toBe(200);
    });
  }

  // Yasaklılar
  for (const [label, email] of [
    ["staff", A.staff],
    ["consultant", A.consultant],
    ["editor", A.editor],
    ["accountant", A.accountant],
    ["student", A.student],
    ["agent", A.agent],
    ["agentstaff", A.agentstaff],
  ] as const) {
    test(`${label} → 403 on GET /api/ai-personas`, async ({ request }) => {
      const status = await getStatus(request, email, "/ai-personas");
      expect(status, `${label} should NOT access ai-personas`).toBe(403);
    });
  }

  // UI: admin /admin/ai-personas sayfası yüklenir
  test("UI — admin /admin/ai-personas sayfası yüklenir", async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.getByLabel(/email/i).fill(A.admin);
    await page.getByLabel(/password/i).fill(PASS);
    await page.getByRole("button", { name: /sign in|log in/i }).click();
    await page.waitForURL(/\/(staff|admin)/i, { timeout: 20_000 });
    await page.goto(`${BASE_URL}/admin/ai-personas`);
    await page.waitForTimeout(2_000);
    const errBoundary = page.getByRole("button", { name: /^reload$/i });
    await expect(errBoundary).not.toBeVisible({ timeout: 3_000 });
  });

  // UI: staff /admin/ai-personas'a erişemez
  test("UI — staff /admin/ai-personas'a erişemez", async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.getByLabel(/email/i).fill(A.staff);
    await page.getByLabel(/password/i).fill(PASS);
    await page.getByRole("button", { name: /sign in|log in/i }).click();
    await page.waitForURL(/\/(staff|admin)/i, { timeout: 20_000 });
    await page.goto(`${BASE_URL}/admin/ai-personas`);
    await page.waitForTimeout(2_000);
    const url = page.url();
    expect(url, "staff redirected away from /admin/ai-personas").not.toContain("ai-personas");
  });
});

// ─── Area 3: Bildirimler ─────────────────────────────────────────────────────
// /api/notifications/unread-count → tüm auth
// /api/notification-rules        → ADMIN_ROLES only

test.describe("AREA 3 — Bildirimler RBAC", () => {
  // Tüm roller unread-count okuyabilmeli
  for (const [label, email] of [
    ["superadmin", A.superadmin],
    ["admin", A.admin],
    ["manager", A.manager],
    ["staff", A.staff],
    ["consultant", A.consultant],
    ["editor", A.editor],
    ["accountant", A.accountant],
    ["student", A.student],
    ["agent", A.agent],
    ["agentstaff", A.agentstaff],
  ] as const) {
    test(`${label} → 200 on GET /api/notifications/unread-count`, async ({ request }) => {
      const status = await getStatus(request, email, "/notifications/unread-count");
      expect(status, `${label} should read unread-count`).toBe(200);
    });
  }

  // ADMIN_ROLES notification-rules yönetebilir
  for (const [label, email] of [
    ["superadmin", A.superadmin],
    ["admin", A.admin],
    ["manager", A.manager],
  ] as const) {
    test(`${label} → 200 on GET /api/notification-rules`, async ({ request }) => {
      const status = await getStatus(request, email, "/notification-rules");
      expect(status, `${label} should access notification-rules`).toBe(200);
    });
  }

  // Non-admin notification-rules'a erişemez
  for (const [label, email] of [
    ["staff", A.staff],
    ["accountant", A.accountant],
    ["student", A.student],
    ["agent", A.agent],
  ] as const) {
    test(`${label} → 403 on GET /api/notification-rules`, async ({ request }) => {
      const status = await getStatus(request, email, "/notification-rules");
      expect(status, `${label} should NOT access notification-rules`).toBe(403);
    });
  }

  // Bildirim listesi + badge sayısı (list endpoint)
  test("admin → notifications listesi alınabilir (array)", async ({ request }) => {
    await loginAs(request, A.admin, PASS);
    const res = await request.get(`${API}/notifications`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    // API returns { data: [...] } shape
    const list = body.notifications ?? body.data ?? body.items ?? body;
    expect(Array.isArray(list)).toBe(true);
  });

  test("student → kendi notification listesi alınabilir", async ({ request }) => {
    await loginAs(request, A.student, PASS);
    const res = await request.get(`${API}/notifications`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const list = body.notifications ?? body.data ?? body.items ?? body;
    expect(Array.isArray(list)).toBe(true);
  });
});

// ─── Area 4: Mesajlaşma / Inbox ──────────────────────────────────────────────
// /api/conversations → STAFF_ROLES (7 staff rol)
// /api/broadcasts    GET → ADMIN_ROLES only
// /api/message-templates GET → STAFF_ROLES

test.describe("AREA 4 — Mesajlaşma / Inbox RBAC", () => {
  // STAFF_ROLES conversations
  for (const [label, email] of [
    ["superadmin", A.superadmin],
    ["admin", A.admin],
    ["manager", A.manager],
    ["staff", A.staff],
    ["consultant", A.consultant],
    ["editor", A.editor],
    ["accountant", A.accountant],
  ] as const) {
    test(`${label} → 200 on GET /api/conversations`, async ({ request }) => {
      const status = await getStatus(request, email, "/conversations");
      expect(status, `${label} should access conversations`).toBe(200);
    });
  }

  // Non-staff conversations'a erişemez
  for (const [label, email] of [
    ["student", A.student],
    ["agent", A.agent],
    ["subagent", A.subagent],
    ["agentstaff", A.agentstaff],
  ] as const) {
    test(`${label} → 403 on GET /api/conversations`, async ({ request }) => {
      const status = await getStatus(request, email, "/conversations");
      expect(status, `${label} should NOT access conversations`).toBe(403);
    });
  }

  // Broadcasts — ADMIN_ROLES only
  for (const [label, email] of [
    ["superadmin", A.superadmin],
    ["admin", A.admin],
    ["manager", A.manager],
  ] as const) {
    test(`${label} → 200 on GET /api/broadcasts`, async ({ request }) => {
      const status = await getStatus(request, email, "/broadcasts");
      expect(status, `${label} should access broadcasts`).toBe(200);
    });
  }

  for (const [label, email] of [
    ["staff", A.staff],
    ["accountant", A.accountant],
    ["student", A.student],
    ["agent", A.agent],
  ] as const) {
    test(`${label} → 403 on GET /api/broadcasts`, async ({ request }) => {
      const status = await getStatus(request, email, "/broadcasts");
      expect(status, `${label} should NOT access broadcasts`).toBe(403);
    });
  }

  // Message Templates — STAFF_ROLES
  for (const [label, email] of [
    ["admin", A.admin],
    ["staff", A.staff],
    ["accountant", A.accountant],
  ] as const) {
    test(`${label} → 200 on GET /api/message-templates`, async ({ request }) => {
      const status = await getStatus(request, email, "/message-templates");
      expect(status, `${label} should access message-templates`).toBe(200);
    });
  }

  for (const [label, email] of [
    ["student", A.student],
    ["agent", A.agent],
  ] as const) {
    test(`${label} → 403 on GET /api/message-templates`, async ({ request }) => {
      const status = await getStatus(request, email, "/message-templates");
      expect(status, `${label} should NOT access message-templates`).toBe(403);
    });
  }

  // UI: Staff mesaj sayfası yüklenir
  test("UI — staff /staff/messages sayfası hata olmadan açılır", async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.getByLabel(/email/i).fill(A.staff);
    await page.getByLabel(/password/i).fill(PASS);
    await page.getByRole("button", { name: /sign in|log in/i }).click();
    await page.waitForURL(/\/(staff|admin)/i, { timeout: 20_000 });
    await page.goto(`${BASE_URL}/staff/messages`);
    await page.waitForTimeout(2_000);
    const errBoundary = page.getByRole("button", { name: /^reload$/i });
    await expect(errBoundary).not.toBeVisible({ timeout: 3_000 });
  });
});

// ─── Area 5: Süreç Takibi (Pipeline / Stage) ─────────────────────────────────
// /api/leads        → STAFF_ROLES + AGENT_ROLES (with "leads" perm)
// /api/students     → STAFF_ROLES + student + AGENT_ROLES (with "students" perm)
// /api/applications → requireAgentStaffPermission("applications") — tüm auth roller

test.describe("AREA 5 — Süreç Takibi RBAC", () => {
  // Leads — STAFF_ROLES
  for (const [label, email] of [
    ["superadmin", A.superadmin],
    ["admin", A.admin],
    ["manager", A.manager],
    ["staff", A.staff],
    ["consultant", A.consultant],
    ["editor", A.editor],
    ["accountant", A.accountant],
  ] as const) {
    test(`${label} → 200 on GET /api/leads`, async ({ request }) => {
      const status = await getStatus(request, email, "/leads");
      expect(status, `${label} should access leads`).toBe(200);
    });
  }

  // Student leads göremez
  test("student → 403 on GET /api/leads", async ({ request }) => {
    const status = await getStatus(request, A.student, "/leads");
    expect(status).toBe(403);
  });

  // agent_staff (all perms) → leads görebilir
  test("agentstaff (all perms) → 200 on GET /api/leads", async ({ request }) => {
    const status = await getStatus(request, A.agentstaff, "/leads");
    expect(status, "agentstaff with leads perm should access leads").toBe(200);
  });

  // Students endpoint
  for (const [label, email] of [
    ["superadmin", A.superadmin],
    ["admin", A.admin],
    ["staff", A.staff],
  ] as const) {
    test(`${label} → 200 on GET /api/students`, async ({ request }) => {
      const status = await getStatus(request, email, "/students");
      expect(status, `${label} should access students`).toBe(200);
    });
  }

  test("student → 200 on GET /api/students (kendi kayıtları)", async ({ request }) => {
    const status = await getStatus(request, A.student, "/students");
    expect(status, "student should access students (own)").toBe(200);
  });

  test("agentstaff (students perm) → 200 on GET /api/students", async ({ request }) => {
    const status = await getStatus(request, A.agentstaff, "/students");
    expect(status, "agentstaff with students perm").toBe(200);
  });

  // Applications endpoint (only requireAgentStaffPermission, no requireRole)
  for (const [label, email] of [
    ["admin", A.admin],
    ["staff", A.staff],
    ["student", A.student],
    ["agentstaff", A.agentstaff],
  ] as const) {
    test(`${label} → 200 on GET /api/applications`, async ({ request }) => {
      const status = await getStatus(request, email, "/applications");
      expect(status, `${label} should access applications`).toBe(200);
    });
  }

  // UI: Admin öğrenci listesini görebilir
  test("UI — admin /staff/students listesi hata olmadan açılır", async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.getByLabel(/email/i).fill(A.admin);
    await page.getByLabel(/password/i).fill(PASS);
    await page.getByRole("button", { name: /sign in|log in/i }).click();
    await page.waitForURL(/\/(staff|admin)/i, { timeout: 20_000 });
    await page.goto(`${BASE_URL}/staff/students`);
    await page.waitForTimeout(2_000);
    const errBoundary = page.getByRole("button", { name: /^reload$/i });
    await expect(errBoundary).not.toBeVisible({ timeout: 3_000 });
  });

  // UI: Student kendi başvurularını görebilir
  test("UI — student /student/applications hata olmadan açılır", async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.getByLabel(/email/i).fill(A.student);
    await page.getByLabel(/password/i).fill(PASS);
    await page.getByRole("button", { name: /sign in|log in/i }).click();
    await page.waitForURL(/\/student/i, { timeout: 20_000 });
    await page.goto(`${BASE_URL}/student/applications`);
    await page.waitForTimeout(2_000);
    const errBoundary = page.getByRole("button", { name: /^reload$/i });
    await expect(errBoundary).not.toBeVisible({ timeout: 3_000 });
  });
});

// ─── Area 6: Agent Network (agent / sub_agent / agent_staff 7 izin) ──────────

test.describe("AREA 6 — Agent Network RBAC", () => {
  // /api/agents/me → AGENT_ROLES
  test("agent → 200 on GET /api/agents/me", async ({ request }) => {
    const status = await getStatus(request, A.agent, "/agents/me");
    expect(status, "agent should access agents/me").toBe(200);
  });

  test("subagent → 200 on GET /api/agents/me", async ({ request }) => {
    const status = await getStatus(request, A.subagent, "/agents/me");
    expect(status, "subagent should access agents/me").toBe(200);
  });

  test("agentstaff → 200 on GET /api/agents/me", async ({ request }) => {
    const status = await getStatus(request, A.agentstaff, "/agents/me");
    expect(status, "agentstaff should access agents/me").toBe(200);
  });

  // Staff/student agents/me'ye erişemez
  // Note: /agents/me uses requireAuth but no requireRole guard;
  // non-agent roles have no agent record → 404 (not 403). Both 403+404 = access denied.
  test("staff → non-200 on GET /api/agents/me (no agent record)", async ({ request }) => {
    const status = await getStatus(request, A.staff, "/agents/me");
    expect(status, "staff should NOT successfully access agents/me").not.toBe(200);
  });

  test("student → non-200 on GET /api/agents/me (no agent record)", async ({ request }) => {
    const status = await getStatus(request, A.student, "/agents/me");
    expect(status, "student should NOT successfully access agents/me").not.toBe(200);
  });

  // Agent 7 izin sınırı — agentstaff (all perms) tüm endpoint'lere erişebilir
  const PERM_ENDPOINTS: Array<[string, string]> = [
    ["leads", "/leads"],
    ["students", "/students"],
    ["applications", "/applications"],
    ["messages", "/conversations"],   // messages perm → conversations STAFF_ROLES (403 for agent_staff)
    ["course_finder", "/course-finder/filters"],
  ];

  test("agentstaff (all perms) → leads endpoint 200", async ({ request }) => {
    await loginAs(request, A.agentstaff, PASS);
    const res = await request.get(`${API}/leads`);
    expect(res.status()).toBe(200);
  });

  test("agentstaff (all perms) → students endpoint 200", async ({ request }) => {
    await loginAs(request, A.agentstaff, PASS);
    const res = await request.get(`${API}/students`);
    expect(res.status()).toBe(200);
  });

  test("agentstaff (all perms) → applications endpoint 200", async ({ request }) => {
    await loginAs(request, A.agentstaff, PASS);
    const res = await request.get(`${API}/applications`);
    expect(res.status()).toBe(200);
  });

  // subagent leads görebilir (kendi scope)
  test("subagent → leads endpoint 200 (kendi scope)", async ({ request }) => {
    await loginAs(request, A.subagent, PASS);
    const res = await request.get(`${API}/leads`);
    expect(res.status()).toBe(200);
  });

  // agent kendi sub-agent listesini görebilir (doğru endpoint: /agents/me/sub-agents)
  test("agent → GET /api/agents/me/sub-agents 200", async ({ request }) => {
    await loginAs(request, A.agent, PASS);
    const res = await request.get(`${API}/agents/me/sub-agents`);
    expect(res.status()).toBe(200);
  });

  // agent commissions görebilir
  test("agent → GET /api/commissions 403 (FINANCE_ROLES gate)", async ({ request }) => {
    await loginAs(request, A.agent, PASS);
    const res = await request.get(`${API}/commissions`);
    expect(res.status(), "agent cannot access commissions (FINANCE_ROLES gate)").toBe(403);
  });

  // agentstaff commissions endpoint → FINANCE_ROLES guard blocks
  test("agentstaff → GET /api/commissions 403 (FINANCE_ROLES gate)", async ({ request }) => {
    const status = await getStatus(request, A.agentstaff, "/commissions");
    expect(status, "agentstaff commissions blocked by FINANCE_ROLES guard").toBe(403);
  });

  // UI: agent portalı yüklenir
  test("UI — agent /agent dashboard hata olmadan yüklenir", async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.getByLabel(/email/i).fill(A.agent);
    await page.getByLabel(/password/i).fill(PASS);
    await page.getByRole("button", { name: /sign in|log in/i }).click();
    // agent portal → /agent after login
    await page.waitForURL(/\/agent/i, { timeout: 20_000 });
    await page.waitForTimeout(2_000);
    const errBoundary = page.getByRole("button", { name: /^reload$/i });
    await expect(errBoundary).not.toBeVisible({ timeout: 5_000 });
  });

  // UI: sub_agent portalı yüklenir
  test("UI — subagent /agent dashboard hata olmadan yüklenir", async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.getByLabel(/email/i).fill(A.subagent);
    await page.getByLabel(/password/i).fill(PASS);
    await page.getByRole("button", { name: /sign in|log in/i }).click();
    await page.waitForURL(/\/agent/i, { timeout: 20_000 });
    await page.waitForTimeout(2_000);
    const errBoundary = page.getByRole("button", { name: /^reload$/i });
    await expect(errBoundary).not.toBeVisible({ timeout: 5_000 });
  });

  // UI: agent_staff portalı yüklenir
  test("UI — agentstaff /agent dashboard hata olmadan yüklenir", async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.getByLabel(/email/i).fill(A.agentstaff);
    await page.getByLabel(/password/i).fill(PASS);
    await page.getByRole("button", { name: /sign in|log in/i }).click();
    await page.waitForURL(/\/agent/i, { timeout: 20_000 });
    await page.waitForTimeout(2_000);
    const errBoundary = page.getByRole("button", { name: /^reload$/i });
    await expect(errBoundary).not.toBeVisible({ timeout: 5_000 });
  });
});
