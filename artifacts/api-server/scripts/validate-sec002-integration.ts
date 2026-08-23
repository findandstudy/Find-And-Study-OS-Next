/**
 * SEC-002 — Privilege Escalation Canlı Entegrasyon Testi
 * api-server context'inde çalışır; DB'yi ve session store'u doğrudan kullanır.
 * Çalıştır: cd artifacts/api-server && pnpm exec tsx scripts/validate-sec002-integration.ts
 */
import { db, usersTable, sessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";

const BASE = process.env.API_BASE_URL ?? "http://localhost:8080/api";
const SUPER_ADMIN_ID = 8;

function makeSessionData(user: {
  id: number; email: string; firstName: string; lastName: string;
  role: string; avatarUrl: string | null; language: string;
  isActive: boolean; emailVerified: boolean;
}) {
  return {
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      avatarUrl: user.avatarUrl,
      language: user.language,
      isActive: user.isActive,
      emailVerified: user.emailVerified,
      replitId: null,
    },
    access_token: "sec002-integration-test",
  };
}

async function createTempUser(role: "admin" | "manager") {
  const email = `sec002-${role}-${Date.now()}@validate.local`;
  const passwordHash = await bcrypt.hash("ValidateTest123!", 10);
  const [user] = await db.insert(usersTable).values({
    email,
    firstName: "SEC002",
    lastName: `${role}Test`,
    role,
    isActive: true,
    emailVerified: true,
    passwordHash,
    language: "en",
  }).returning();
  return user;
}

async function createSession(userId: number, sessionData: object): Promise<string> {
  const sid = randomBytes(32).toString("hex");
  await db.insert(sessionsTable).values({
    sid,
    sess: sessionData as Record<string, unknown>,
    expire: new Date(Date.now() + 3600 * 1000),
    userId,
  });
  return sid;
}

async function getCsrfToken(sid: string): Promise<string> {
  const resp = await fetch(`${BASE}/auth/me`, {
    headers: { cookie: `sid=${sid}` },
  });
  const setCookies = resp.headers.getSetCookie?.() ?? [];
  for (const h of setCookies) {
    const m = h.match(/csrf_token=([^;]+)/);
    if (m) return m[1];
  }
  return "";
}

async function patchUser(sid: string, csrfToken: string, targetId: number, body: object) {
  const resp = await fetch(`${BASE}/users/${targetId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      cookie: `sid=${sid}; csrf_token=${csrfToken}`,
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify(body),
  });
  return { status: resp.status, body: await resp.json().catch(() => ({})) };
}

async function cleanup(userIds: number[]) {
  for (const id of userIds) {
    await db.delete(sessionsTable).where(eq(sessionsTable.userId, id)).catch(() => {});
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  }
}

async function run() {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(" SEC-002 — Privilege Escalation Canlı Entegrasyon Testi");
  console.log(`" → API: ${BASE}`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log("");

  let passed = 0, failed = 0;
  const cleanupIds: number[] = [];

  try {
    // Geçici test kullanıcıları oluştur
    const adminUser = await createTempUser("admin");
    const managerUser = await createTempUser("manager");
    cleanupIds.push(adminUser.id, managerUser.id);
    console.log(`→ Geçici admin: id=${adminUser.id}`);
    console.log(`→ Geçici manager: id=${managerUser.id}`);
    console.log(`→ Hedef super_admin: id=${SUPER_ADMIN_ID}`);
    console.log("");

    // Session'ları oluştur
    const adminSid = await createSession(adminUser.id, makeSessionData(adminUser));
    const managerSid = await createSession(managerUser.id, makeSessionData(managerUser));

    // CSRF token'ları al
    const adminCsrf = await getCsrfToken(adminSid);
    const managerCsrf = await getCsrfToken(managerSid);
    console.log(`→ admin CSRF: ${adminCsrf.slice(0, 16)}...`);
    console.log(`→ manager CSRF: ${managerCsrf.slice(0, 16)}...`);
    console.log("");

    // ─── Test 1: admin → super_admin PATCH → 403 bekleniyor ────────────────
    console.log("Test 1: admin → super_admin PATCH → 403 bekleniyor (SEC-002 guard)");
    const t1 = await patchUser(adminSid, adminCsrf, SUPER_ADMIN_ID, { phone: "+905550001111" });
    if (t1.status === 403) {
      console.log(`  ✅ PASS  HTTP 403 — "${(t1.body as any).error}"`);
      passed++;
    } else {
      console.log(`  ❌ FAIL  beklenen=403, alınan=${t1.status} — ${JSON.stringify(t1.body)}`);
      failed++;
    }
    console.log("");

    // ─── Test 2: manager → super_admin PATCH → 403 bekleniyor ──────────────
    console.log("Test 2: manager → super_admin PATCH → 403 bekleniyor (SEC-002 guard)");
    const t2 = await patchUser(managerSid, managerCsrf, SUPER_ADMIN_ID, { phone: "+905550002222" });
    if (t2.status === 403) {
      console.log(`  ✅ PASS  HTTP 403 — "${(t2.body as any).error}"`);
      passed++;
    } else {
      console.log(`  ❌ FAIL  beklenen=403, alınan=${t2.status} — ${JSON.stringify(t2.body)}`);
      failed++;
    }
    console.log("");

    // ─── Test 3: admin → kendi hesabına PATCH → 200/400 ────────────────────
    console.log("Test 3: admin → kendi hesabına PATCH → izin verilmeli (200/400)");
    const t3 = await patchUser(adminSid, adminCsrf, adminUser.id, {});
    if (t3.status === 200 || t3.status === 400) {
      console.log(`  ✅ PASS  HTTP ${t3.status} — izin verildi (403 DEĞİL)`);
      passed++;
    } else {
      console.log(`  ❌ FAIL  beklenen=200/400, alınan=${t3.status} — ${JSON.stringify(t3.body)}`);
      failed++;
    }
    console.log("");

    // ─── Test 4: admin → manager hesabına PATCH → 200/400 ──────────────────
    console.log("Test 4: admin → manager hesabına PATCH → izin verilmeli (200/400)");
    const t4 = await patchUser(adminSid, adminCsrf, managerUser.id, {});
    if (t4.status === 200 || t4.status === 400) {
      console.log(`  ✅ PASS  HTTP ${t4.status} — izin verildi (403 DEĞİL)`);
      passed++;
    } else {
      console.log(`  ❌ FAIL  beklenen=200/400, alınan=${t4.status} — ${JSON.stringify(t4.body)}`);
      failed++;
    }

  } finally {
    await cleanup(cleanupIds);
    console.log("");
    console.log(`→ Temizlik tamamlandı (${cleanupIds.length} test kullanıcısı silindi)`);
  }

  console.log("");
  console.log(`── SEC-002 Canlı Entegrasyon: ${passed}/${passed + failed} PASS, ${failed} FAIL ──`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
