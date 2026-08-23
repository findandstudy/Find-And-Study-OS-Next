/**
 * Contract signing end-to-end smoke test.
 *
 * Verifies the full self-service signing path introduced by the production fix
 * (remove process.exit, defer PDF render to lazy download, store signature as
 * base64 in DB). Run this whenever the signing hot-path or ensureSignedContractPdf
 * is changed so that regressions are caught before a human tester is needed.
 *
 * What it covers:
 *   (a) POST /api/contracts/me/sign — submits a synthetic signature PNG and
 *       asserts the response returns { data: { signedContractId } }. Then
 *       confirms the route reached its "[contracts/sign] done" log line by
 *       checking that finalizeSign() wrote audit_logs(action='contract.signed',
 *       resourceId=signedContractId) — the audit write happens synchronously
 *       just before that log line, so its presence is equivalent proof.
 *   (b) signed_contracts DB row — confirms a row was inserted with
 *       signingSessionId, signatureImageBase64 set, pdfObjectKey=NULL (lazy).
 *   (c) GET /api/contracts/me/pdf — triggers ensureSignedContractPdf (headless
 *       Chromium), confirms the response is a valid PDF byte stream (%PDF magic).
 *
 * Self-seeds its own contract template, agent user, agent record, and signing
 * session tagged with RUN_ID so reruns never collide. Full teardown runs even
 * on failure.
 *
 * Requires a running api-server (default http://localhost:8080).
 * Run with:
 *   pnpm --filter @workspace/api-server test:contract-sign-smoke
 */

import crypto from "crypto";
import bcrypt from "bcryptjs";
import {
  db,
  contractTemplatesTable,
  signingSessionsTable,
  signedContractsTable,
  agentsTable,
  usersTable,
  sessionsTable,
  auditLogsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";

const BASE = process.env.API_BASE_URL || "http://localhost:8080";
const RUN_ID = `t364_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

// Minimal 1×1 white PNG (valid PNG file, tiny but real).
const SYNTHETIC_SIG_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";

interface Section {
  name: string;
  ok: boolean;
  details: string[];
}

interface Fixtures {
  templateId: number;
  agentUserId: number;
  agentId: number;
  sessionId: number;
  agentEmail: string;
  agentPassword: string;
}

function assert(cond: boolean, msg: string, details: string[]): boolean {
  details.push(`${cond ? "OK   " : "FAIL "} ${msg}`);
  return cond;
}

// ---------------------------------------------------------------------------
// Cookie jar — thin manual cookie management so we avoid an npm dependency.
// ---------------------------------------------------------------------------

type Jar = Map<string, string>;

function parseCookies(headers: Headers): Jar {
  const jar: Jar = new Map();
  const raw = headers.getSetCookie ? headers.getSetCookie() : [];
  for (const h of raw) {
    const eqIdx = h.indexOf("=");
    if (eqIdx < 0) continue;
    const name = h.slice(0, eqIdx).trim();
    const rest = h.slice(eqIdx + 1);
    const value = rest.split(";")[0].trim();
    jar.set(name, value);
  }
  return jar;
}

function mergeCookies(jar: Jar, fresh: Jar): void {
  for (const [k, v] of fresh) jar.set(k, v);
}

function cookieHeader(jar: Jar): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function apiGet(
  path: string,
  jar: Jar,
): Promise<{ status: number; ok: boolean; headers: Headers; raw: Response }> {
  const r = await fetch(`${BASE}${path}`, {
    method: "GET",
    headers: { Cookie: cookieHeader(jar) },
  });
  mergeCookies(jar, parseCookies(r.headers));
  return { status: r.status, ok: r.ok, headers: r.headers, raw: r };
}

async function apiPost(
  path: string,
  body: Record<string, unknown>,
  jar: Jar,
): Promise<{ status: number; ok: boolean; data: Record<string, unknown> | null }> {
  const csrfToken = jar.get("csrf_token") ?? crypto.randomBytes(16).toString("hex");
  jar.set("csrf_token", csrfToken);

  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader(jar),
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify(body),
  });
  mergeCookies(jar, parseCookies(r.headers));

  let data: Record<string, unknown> | null = null;
  try {
    data = (await r.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON — leave data null.
  }
  return { status: r.status, ok: r.ok, data };
}

// ---------------------------------------------------------------------------
// Fixture setup / teardown
// ---------------------------------------------------------------------------

async function setup(): Promise<Fixtures> {
  const agentEmail = `t364-agent-${RUN_ID}@test.local`;
  const agentPassword = "SmokeTest1!";

  // Contract template (minimal body with {{signature}} placeholder)
  const [tpl] = await db
    .insert(contractTemplatesTable)
    .values({
      name: `T364 Smoke Template ${RUN_ID}`,
      language: "en",
      entityType: "company",
      version: 1,
      isActive: true,
      bodyHtml: `<p>Test contract body.</p><p>{{signature}}</p>`,
    })
    .returning();

  // Agent user
  const passwordHash = await bcrypt.hash(agentPassword, 10);
  const [user] = await db
    .insert(usersTable)
    .values({
      email: agentEmail,
      passwordHash,
      firstName: "Smoke",
      lastName: "Agent",
      role: "agent",
      isActive: true,
      emailVerified: true,
    })
    .returning();

  // Agent record
  const [agent] = await db
    .insert(agentsTable)
    .values({
      userId: user.id,
      firstName: "Smoke",
      lastName: "Agent",
      companyName: `T364 Smoke Agency ${RUN_ID}`,
      email: agentEmail,
      country: "Turkey",
      commissionRate: 0,
    })
    .returning();

  // Signing session (review_pending = intake already complete, ready to sign)
  const tokenHash = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const [session] = await db
    .insert(signingSessionsTable)
    .values({
      templateId: tpl.id,
      agentId: agent.id,
      tokenHash,
      mode: "admin_driven",
      status: "review_pending",
      intakeData: null,
      signerEmail: agentEmail,
      signerName: "Smoke Agent",
      expiresAt,
      isPrimaryOnboarding: true,
      createdByUserId: null,
    })
    .returning();

  return {
    templateId: tpl.id,
    agentUserId: user.id,
    agentId: agent.id,
    sessionId: session.id,
    agentEmail,
    agentPassword,
  };
}

async function teardown(fx: Fixtures): Promise<void> {
  // signed_contracts → signing_sessions → agents → users → contract_templates
  // audit_logs reference these by resourceId (integer) with no FK constraint,
  // so we can safely delete the primary rows first.
  try {
    await db
      .delete(signedContractsTable)
      .where(eq(signedContractsTable.signingSessionId, fx.sessionId));
  } catch (e) {
    console.warn("[t364 teardown] signed_contracts delete:", e);
  }
  try {
    await db
      .delete(signingSessionsTable)
      .where(eq(signingSessionsTable.id, fx.sessionId));
  } catch (e) {
    console.warn("[t364 teardown] signing_sessions delete:", e);
  }
  try {
    await db.delete(agentsTable).where(eq(agentsTable.id, fx.agentId));
  } catch (e) {
    console.warn("[t364 teardown] agents delete:", e);
  }
  // Sessions (auth) for this user
  try {
    await db
      .delete(sessionsTable)
      .where(eq(sessionsTable.userId, fx.agentUserId));
  } catch (e) {
    console.warn("[t364 teardown] sessions delete:", e);
  }
  try {
    await db.delete(usersTable).where(eq(usersTable.id, fx.agentUserId));
  } catch (e) {
    console.warn("[t364 teardown] users delete:", e);
  }
  try {
    await db
      .delete(contractTemplatesTable)
      .where(eq(contractTemplatesTable.id, fx.templateId));
  } catch (e) {
    console.warn("[t364 teardown] contract_templates delete:", e);
  }
}


// ---------------------------------------------------------------------------
// Test sections
// ---------------------------------------------------------------------------

async function runSignSection(fx: Fixtures): Promise<{
  section: Section;
  jar: Jar;
  signedContractId: number | null;
}> {
  const details: string[] = [];
  let ok = true;
  const jar: Jar = new Map();
  let signedContractId: number | null = null;

  // ── Step 1: seed a CSRF token so the login POST is accepted ────────────
  // Visiting any GET endpoint causes the server to set csrf_token in the
  // Set-Cookie response; we capture it and use it as the double-submit token.
  await apiGet("/api/health", jar).catch(() => {
    // /api/health may 404; we only need the cookie side-effect.
  });
  if (!jar.has("csrf_token")) {
    // Fallback: seed it ourselves — the middleware accepts any matching pair.
    jar.set("csrf_token", crypto.randomBytes(16).toString("hex"));
  }

  // ── Step 2: Login ────────────────────────────────────────────────────────
  const login = await apiPost(
    "/api/auth/login",
    { email: fx.agentEmail, password: fx.agentPassword },
    jar,
  );
  ok =
    assert(
      login.status === 200 && !!login.data?.user,
      `POST /api/auth/login → 200 with user (got ${login.status})`,
      details,
    ) && ok;
  ok =
    assert(
      jar.has("sid"),
      `Login set sid session cookie`,
      details,
    ) && ok;

  if (!jar.has("sid")) {
    return { section: { name: "(a+b) Sign + DB assertion", ok: false, details }, jar, signedContractId };
  }

  // ── Step 3: POST sign ────────────────────────────────────────────────────
  const signResp = await apiPost(
    "/api/contracts/me/sign",
    {
      signatureImagePngBase64: `data:image/png;base64,${SYNTHETIC_SIG_PNG_BASE64}`,
      signerName: "Smoke Agent",
    },
    jar,
  );
  ok =
    assert(
      signResp.status === 200,
      `POST /api/contracts/me/sign → 200 (got ${signResp.status}; body=${JSON.stringify(signResp.data)})`,
      details,
    ) && ok;

  const rawId = (signResp.data?.data as Record<string, unknown> | undefined)?.signedContractId;
  signedContractId = typeof rawId === "number" ? rawId : null;
  ok =
    assert(
      signedContractId !== null,
      `Response contains signedContractId (got ${JSON.stringify(rawId)})`,
      details,
    ) && ok;

  // ── Step 3b: "[contracts/sign] done" proxy assertion via audit log ────
  // The server's log files are snapshots written by the log tooling and do not
  // update in real-time during a test run. Instead we assert the equivalent
  // in-process evidence: finalizeSign() writes `writeAudit(action='contract.signed',
  // resourceId=signedContractId)` synchronously just before the route emits
  // "[contracts/sign] done" and sends the response. If the HTTP response
  // carries signedContractId AND the audit row exists, the done log line is
  // guaranteed to have been emitted between those two facts.
  if (signedContractId !== null) {
    const auditRows = await db
      .select()
      .from(auditLogsTable)
      .where(
        and(
          eq(auditLogsTable.action, "contract.signed"),
          eq(auditLogsTable.resourceId, signedContractId),
        ),
      );
    ok =
      assert(
        auditRows.length > 0,
        `audit_logs has action='contract.signed' resourceId=${signedContractId} — confirms "[contracts/sign] done" log line was reached`,
        details,
      ) && ok;
  }

  // ── Step 4: DB assertion — signed_contracts row ───────────────────────
  if (signedContractId !== null) {
    const [row] = await db
      .select()
      .from(signedContractsTable)
      .where(eq(signedContractsTable.id, signedContractId));

    ok =
      assert(!!row, `signed_contracts row exists (id=${signedContractId})`, details) && ok;
    ok =
      assert(
        row?.signingSessionId === fx.sessionId,
        `signed_contracts.signingSessionId = ${fx.sessionId} (got ${row?.signingSessionId})`,
        details,
      ) && ok;
    ok =
      assert(
        !!row?.signatureImageBase64,
        `signed_contracts.signatureImageBase64 is populated`,
        details,
      ) && ok;
    ok =
      assert(
        row?.pdfObjectKey === null || row?.pdfObjectKey === undefined,
        `signed_contracts.pdfObjectKey is NULL at sign time (lazy PDF) (got ${row?.pdfObjectKey})`,
        details,
      ) && ok;
  }

  return { section: { name: "(a+b) Sign + DB assertion", ok, details }, jar, signedContractId };
}

async function runPdfSection(
  signedContractId: number | null,
  jar: Jar,
): Promise<Section> {
  const details: string[] = [];
  let ok = true;

  if (signedContractId === null) {
    details.push("SKIP No signedContractId — sign section failed");
    return { name: "(c) PDF download (ensureSignedContractPdf)", ok: false, details };
  }

  // PDF rendering is deliberately asynchronous. The first request normally
  // returns 202 while the background delivery worker runs Chromium off the
  // request path, so poll until the file becomes available.
  let pdfResponse: Response;
  let attempts = 0;
  try {
    const csrfToken = jar.get("csrf_token") ?? "";
    const deadline = Date.now() + 45_000;
    do {
      attempts += 1;
      pdfResponse = await fetch(`${BASE}/api/contracts/me/pdf`, {
        method: "GET",
        headers: { Cookie: cookieHeader(jar), "x-csrf-token": csrfToken },
        signal: AbortSignal.timeout(10_000),
      });
      if (pdfResponse.status !== 202 || Date.now() >= deadline) break;
      await pdfResponse.arrayBuffer();
      await new Promise(resolve => setTimeout(resolve, 2_000));
    } while (true);
  } catch (err) {
    details.push(`FAIL GET /api/contracts/me/pdf threw: ${err}`);
    return { name: "(c) PDF download (ensureSignedContractPdf)", ok: false, details };
  }

  ok =
    assert(
      pdfResponse.status === 200,
      `GET /api/contracts/me/pdf → 200 after ${attempts} attempt(s) (got ${pdfResponse.status})`,
      details,
    ) && ok;

  const contentType = pdfResponse.headers.get("content-type") || "";
  ok =
    assert(
      contentType.includes("pdf"),
      `Content-Type includes "pdf" (got "${contentType}")`,
      details,
    ) && ok;

  let pdfBytes: Uint8Array | null = null;
  try {
    const buf = await pdfResponse.arrayBuffer();
    pdfBytes = new Uint8Array(buf);
  } catch (e) {
    details.push(`FAIL Could not read PDF body: ${e}`);
  }

  if (pdfBytes) {
    // %PDF magic bytes: 0x25 0x50 0x44 0x46
    const magic = String.fromCharCode(...pdfBytes.slice(0, 4));
    ok =
      assert(
        magic === "%PDF",
        `PDF response starts with %PDF magic bytes (got "${magic}")`,
        details,
      ) && ok;
    ok =
      assert(
        pdfBytes.length > 1024,
        `PDF is non-trivial (${pdfBytes.length} bytes)`,
        details,
      ) && ok;
  }

  // Confirm pdfObjectKey is now set in the DB (lazy hydration happened).
  const [row] = await db
    .select({ pdfObjectKey: signedContractsTable.pdfObjectKey })
    .from(signedContractsTable)
    .where(eq(signedContractsTable.id, signedContractId));
  ok =
    assert(
      !!row?.pdfObjectKey,
      `signed_contracts.pdfObjectKey hydrated after PDF download (got ${row?.pdfObjectKey ?? "null"})`,
      details,
    ) && ok;

  return { name: "(c) PDF download (ensureSignedContractPdf)", ok, details };
}

// ---------------------------------------------------------------------------
// Server readiness probe
// ---------------------------------------------------------------------------

async function waitForServer(): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.status < 500) return true;
    } catch {
      // Still booting.
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`[t364] contract sign smoke test  run=${RUN_ID}  api=${BASE}`);

  const ready = await waitForServer();
  if (!ready) {
    console.error(
      "[t364] api-server did not respond — start it before running this script.",
    );
    process.exit(2);
  }

  const fx = await setup();
  console.log(
    `[t364] fixtures seeded — templateId=${fx.templateId} agentId=${fx.agentId} sessionId=${fx.sessionId}`,
  );

  const sections: Section[] = [];
  let jar: Jar = new Map();
  let signedContractId: number | null = null;

  try {
    const signResult = await runSignSection(fx);
    sections.push(signResult.section);
    jar = signResult.jar;
    signedContractId = signResult.signedContractId;

    const pdfSection = await runPdfSection(signedContractId, jar);
    sections.push(pdfSection);
  } finally {
    await teardown(fx);
    console.log("[t364] fixtures cleaned up");
  }

  let allOk = true;
  for (const s of sections) {
    console.log(`\n=== ${s.name}  ${s.ok ? "PASS" : "FAIL"} ===`);
    for (const d of s.details) console.log(`  ${d}`);
    if (!s.ok) allOk = false;
  }

  console.log(`\n[t364] ${allOk ? "PASS" : "FAIL"}  (run ${RUN_ID})`);
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("[t364] crashed:", err);
  process.exit(2);
});
