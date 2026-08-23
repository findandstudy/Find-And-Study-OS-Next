/**
 * DOĞRULAMA TURU — RBAC API Audit Runner
 * Native Node.js fetch (v18+) kullanır; harici paket gerekmez.
 * Çalıştır: pnpm exec tsx scripts/rbac-audit-runner.ts
 */

const API = "http://localhost:8080/api";
const PASS = process.env.RBAC_E2E_PASSWORD;
if (!PASS) {
  throw new Error("RBAC_E2E_PASSWORD is required for the RBAC audit runner");
}

const USERS: Record<string, string> = {
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
};

interface TestResult {
  area: string;
  role: string;
  endpoint: string;
  expected: number | "not200";
  actual: number;
  pass: boolean;
}

const results: TestResult[] = [];

// ── cookie helpers ────────────────────────────────────────────────────────
function parseCookies(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = headers.getSetCookie ? headers.getSetCookie() : [];
  for (const line of raw) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

// ── session cache ─────────────────────────────────────────────────────────
interface Session { jar: Record<string, string>; csrf: string }
const sessionCache = new Map<string, Session>();

async function login(role: string): Promise<Session> {
  if (sessionCache.has(role)) return sessionCache.get(role)!;

  // 1. Seed csrf cookie via /auth/me
  const seedRes = await fetch(`${API}/auth/me`);
  const jar = parseCookies(seedRes.headers);
  const csrf = decodeURIComponent(jar["csrf_token"] ?? "");

  // 2. POST /auth/login
  const loginRes = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": csrf,
      Cookie: cookieHeader(jar),
    },
    body: JSON.stringify({ email: USERS[role], password: PASS }),
  });

  if (!loginRes.ok) {
    const txt = await loginRes.text();
    throw new Error(`Login failed for ${role} (${loginRes.status}): ${txt.slice(0, 200)}`);
  }

  const newCookies = parseCookies(loginRes.headers);
  const finalJar = { ...jar, ...newCookies };
  const finalCsrf = newCookies["csrf_token"]
    ? decodeURIComponent(newCookies["csrf_token"])
    : csrf;

  const session: Session = { jar: finalJar, csrf: finalCsrf };
  sessionCache.set(role, session);
  return session;
}

async function get(role: string, path: string): Promise<number> {
  const { jar, csrf } = await login(role);
  const res = await fetch(`${API}${path}`, {
    headers: {
      Cookie: cookieHeader(jar),
      "x-csrf-token": csrf,
    },
  });
  return res.status;
}

// ── record helper ─────────────────────────────────────────────────────────
function record(
  area: string,
  role: string,
  endpoint: string,
  expected: number | "not200",
  actual: number,
): void {
  const pass = expected === "not200" ? actual !== 200 : actual === expected;
  results.push({ area, role, endpoint, expected, actual, pass });
  const icon = pass ? "✓" : "✗";
  console.log(`  ${icon} [${area}] ${role.padEnd(12)} ${endpoint.padEnd(38)} → ${actual}  (want ${expected})`);
}

// ── AREA 1: Finance ───────────────────────────────────────────────────────
async function runArea1() {
  console.log("\n[AREA 1] Finance RBAC  (FINANCE_ROLES = superadmin,admin,accountant)");
  const EP = "/finance/university-receivables";
  for (const r of ["superadmin","admin","accountant"])
    record("Finance", r, EP, 200, await get(r, EP));
  for (const r of ["manager","staff","consultant","editor","student","agent","subagent","agentstaff"])
    record("Finance", r, EP, 403, await get(r, EP));
}

// ── AREA 2: AI Modları ────────────────────────────────────────────────────
async function runArea2() {
  console.log("\n[AREA 2] AI Modları RBAC  (ADMIN_ROLES = superadmin,admin,manager)");
  for (const ep of ["/ai-personas", "/ai-extractors"]) {
    for (const r of ["superadmin","admin","manager"])
      record("AI-Modları", r, ep, 200, await get(r, ep));
    for (const r of ["staff","consultant","editor","accountant","student","agent","agentstaff"])
      record("AI-Modları", r, ep, 403, await get(r, ep));
  }
}

// ── AREA 3: Bildirimler ───────────────────────────────────────────────────
async function runArea3() {
  console.log("\n[AREA 3] Bildirimler RBAC");
  const UNREAD = "/notifications/unread-count";
  for (const r of ["superadmin","admin","manager","staff","consultant","editor","accountant","student","agent","agentstaff"])
    record("Bildirimler", r, UNREAD, 200, await get(r, UNREAD));

  const RULES = "/notification-rules";
  for (const r of ["superadmin","admin","manager"])
    record("Bildirimler", r, RULES, 200, await get(r, RULES));
  for (const r of ["staff","accountant","student","agent"])
    record("Bildirimler", r, RULES, 403, await get(r, RULES));

  for (const r of ["admin","student"])
    record("Bildirimler", r, "/notifications", 200, await get(r, "/notifications"));
}

// ── AREA 4: Mesajlaşma / Inbox ────────────────────────────────────────────
async function runArea4() {
  console.log("\n[AREA 4] Mesajlaşma / Inbox RBAC");
  const CONV = "/conversations";
  for (const r of ["superadmin","admin","manager","staff","consultant","editor","accountant"])
    record("Mesajlaşma", r, CONV, 200, await get(r, CONV));
  for (const r of ["student","agent","subagent","agentstaff"])
    record("Mesajlaşma", r, CONV, 403, await get(r, CONV));

  const BC = "/broadcasts";
  for (const r of ["superadmin","admin","manager"])
    record("Mesajlaşma", r, BC, 200, await get(r, BC));
  for (const r of ["staff","accountant","student","agent"])
    record("Mesajlaşma", r, BC, 403, await get(r, BC));

  const MT = "/message-templates";
  for (const r of ["admin","staff","accountant"])
    record("Mesajlaşma", r, MT, 200, await get(r, MT));
  for (const r of ["student","agent"])
    record("Mesajlaşma", r, MT, 403, await get(r, MT));
}

// ── AREA 5: Süreç Takibi ─────────────────────────────────────────────────
async function runArea5() {
  console.log("\n[AREA 5] Süreç Takibi RBAC");
  const LEADS = "/leads";
  for (const r of ["superadmin","admin","manager","staff","consultant","editor","accountant"])
    record("Süreç-Takibi", r, LEADS, 200, await get(r, LEADS));
  record("Süreç-Takibi", "student", LEADS, 403, await get("student", LEADS));
  record("Süreç-Takibi", "agentstaff", LEADS, 200, await get("agentstaff", LEADS));

  const STUDS = "/students";
  for (const r of ["superadmin","admin","staff"])
    record("Süreç-Takibi", r, STUDS, 200, await get(r, STUDS));
  record("Süreç-Takibi", "student", STUDS, 200, await get("student", STUDS));
  record("Süreç-Takibi", "agentstaff", STUDS, 200, await get("agentstaff", STUDS));

  const APPS = "/applications";
  for (const r of ["admin","staff","student","agentstaff"])
    record("Süreç-Takibi", r, APPS, 200, await get(r, APPS));
}

// ── AREA 6: Agent Network ─────────────────────────────────────────────────
async function runArea6() {
  console.log("\n[AREA 6] Agent Network RBAC  (7 izin scope)");
  record("Agent-Network", "agent",      "/agents/me",           200,      await get("agent",      "/agents/me"));
  record("Agent-Network", "subagent",   "/agents/me",           200,      await get("subagent",   "/agents/me"));
  record("Agent-Network", "agentstaff", "/agents/me",           200,      await get("agentstaff", "/agents/me"));
  record("Agent-Network", "staff",      "/agents/me",           "not200", await get("staff",      "/agents/me"));
  record("Agent-Network", "student",    "/agents/me",           "not200", await get("student",    "/agents/me"));
  record("Agent-Network", "agentstaff", "/leads",               200,      await get("agentstaff", "/leads"));
  record("Agent-Network", "agentstaff", "/students",            200,      await get("agentstaff", "/students"));
  record("Agent-Network", "agentstaff", "/applications",        200,      await get("agentstaff", "/applications"));
  record("Agent-Network", "subagent",   "/leads",               200,      await get("subagent",   "/leads"));
  record("Agent-Network", "agent",      "/agents/me/sub-agents",200,      await get("agent",      "/agents/me/sub-agents"));
  record("Agent-Network", "agent",      "/commissions",         403,      await get("agent",      "/commissions"));
  record("Agent-Network", "agentstaff", "/commissions",         403,      await get("agentstaff", "/commissions"));
}

// ── Security Baseline ─────────────────────────────────────────────────────
async function runSecurity() {
  console.log("\n[SECURITY] Güvenlik baseline kontrolleri");

  // Unauthenticated access
  const r1 = await fetch(`${API}/leads`);
  const pass1 = r1.status === 401 || r1.status === 403;
  results.push({ area: "Security", role: "-", endpoint: "/leads (no auth)", expected: 401, actual: r1.status, pass: pass1 });
  console.log(`  ${pass1?"✓":"✗"} [Security] unauthenticated /leads → ${r1.status}`);

  const r2 = await fetch(`${API}/students`);
  const pass2 = r2.status === 401 || r2.status === 403;
  results.push({ area: "Security", role: "-", endpoint: "/students (no auth)", expected: 401, actual: r2.status, pass: pass2 });
  console.log(`  ${pass2?"✓":"✗"} [Security] unauthenticated /students → ${r2.status}`);

  // CSRF required on POST
  const { jar, csrf } = await login("admin");
  const r3 = await fetch(`${API}/leads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) },
    body: JSON.stringify({ firstName: "test", lastName: "test", email: "t@t.com" }),
  });
  const csrfBlocked = r3.status === 403 || r3.status === 401;
  results.push({ area: "Security", role: "admin", endpoint: "POST /leads (no CSRF header)", expected: 403, actual: r3.status, pass: csrfBlocked });
  console.log(`  ${csrfBlocked?"✓":"✗"} [Security] POST /leads without CSRF header → ${r3.status}`);

  // Bad login → 401
  const r4 = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-csrf-token": csrf, Cookie: cookieHeader(jar) },
    body: JSON.stringify({ email: "no-such-user@audit.test", password: "wrongpass" }),
  });
  const pass4 = r4.status === 401 || r4.status === 403;
  results.push({ area: "Security", role: "-", endpoint: "/auth/login (bad creds)", expected: 401, actual: r4.status, pass: pass4 });
  console.log(`  ${pass4?"✓":"✗"} [Security] bad login creds → ${r4.status}`);

  // Public endpoint not gated by RBAC but rate-limited
  const r5 = await fetch(`${API}/public/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "x@x.com", firstName: "x", lastName: "x" }),
  });
  const pass5 = r5.status !== 500;
  results.push({ area: "Security", role: "-", endpoint: "/public/apply (incomplete body)", expected: 400, actual: r5.status, pass: pass5 });
  console.log(`  ${pass5?"✓":"✗"} [Security] /public/apply incomplete → ${r5.status} (want non-500)`);

  // webform_tokens endpoint — should be open (webhook handler)
  const r6 = await fetch(`${API}/webhooks/whatsapp`, { method: "GET" });
  const pass6 = r6.status !== 500;
  results.push({ area: "Security", role: "-", endpoint: "/webhooks/whatsapp GET", expected: 200, actual: r6.status, pass: pass6 });
  console.log(`  ${pass6?"✓":"✗"} [Security] /webhooks/whatsapp GET → ${r6.status}`);
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║      RBAC AUDIT RUNNER — EduConsult OS  (DOĞRULAMA TURU)   ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  try {
    await runArea1();
    await runArea2();
    await runArea3();
    await runArea4();
    await runArea5();
    await runArea6();
    await runSecurity();
  } catch (e: unknown) {
    console.error("\nFATAL ERROR:", e);
  }

  const total  = results.length;
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);

  console.log(`\n${"═".repeat(64)}`);
  console.log(`TOPLAM: ${passed}/${total} PASS | ${failed.length} FAIL`);

  if (failed.length > 0) {
    console.log("\n── FAIL LİSTESİ ──");
    for (const f of failed) {
      console.log(`  ✗ [${f.area}] ${f.role} ${f.endpoint}  actual=${f.actual}  expected=${f.expected}`);
    }
  }

  console.log("\n__JSON_RESULTS__");
  console.log(JSON.stringify({ total, passed, failed: failed.length, failures: failed }, null, 2));

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
