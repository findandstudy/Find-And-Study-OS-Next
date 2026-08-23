/**
 * Integration test for PARÇA 1: ai_default_configs CRUD routes
 * and PARÇA 2: 4 example persona seeds.
 *
 * Run: pnpm --filter @workspace/api-server exec ts-node --esm scripts/test-ai-defaults.ts
 */
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";

const BASE = process.env.API_BASE ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@test.com";
const ADMIN_PASS = process.env.ADMIN_PASS ?? "Admin1234!";

let authCookie = "";
let csrfToken = "";

async function req<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const url = new URL(BASE + path);
  const isHttps = url.protocol === "https:";
  const lib = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const payload = body != null ? JSON.stringify(body) : undefined;
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(authCookie ? { Cookie: authCookie } : {}),
        ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    };
    const r = lib.request(options, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        if (res.headers["set-cookie"]) {
          authCookie = (res.headers["set-cookie"] as string[])
            .map((c) => c.split(";")[0])
            .join("; ");
          const csrf = (res.headers["set-cookie"] as string[])
            .find((c) => c.startsWith("csrf_token="));
          if (csrf) csrfToken = csrf.split("=")[1]?.split(";")[0] ?? "";
        }
        try {
          resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode ?? 0, data: raw as any });
        }
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

let passed = 0;
let failed = 0;

function ok(label: string, cond: boolean) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

async function main() {
  console.log("=== AI Defaults + Persona Seeds Integration Test ===\n");

  // ── Auth ──────────────────────────────────────────────────────────────────
  console.log("Step 1: Login as admin");
  const init = await req<any>("GET", "/api/health");
  if (init.status === 200 && init.data?.ok) console.log("  server is up");

  const loginRes = await req<any>("POST", "/api/auth/login", {
    email: ADMIN_EMAIL,
    password: ADMIN_PASS,
  });
  ok("login 200", loginRes.status === 200);
  ok("login has user", Boolean(loginRes.data?.user));

  // ── GET /api/ai-defaults (list) ───────────────────────────────────────────
  console.log("\nStep 2: List all defaults");
  const listRes = await req<any>("GET", "/api/ai-defaults");
  ok("list 200", listRes.status === 200);
  ok("list has defaults array", Array.isArray(listRes.data?.defaults));
  const defaults: any[] = listRes.data?.defaults ?? [];
  ok("list has 5 keys", defaults.length === 5);
  const keys = defaults.map((d: any) => d.key);
  ok("has extractor.builtin.systemPrompt", keys.includes("extractor.builtin.systemPrompt"));
  ok("has extractor.builtin.fields", keys.includes("extractor.builtin.fields"));
  ok("has extractor.builtin.rules", keys.includes("extractor.builtin.rules"));
  ok("has persona.builtin.systemPrompt", keys.includes("persona.builtin.systemPrompt"));
  ok("has persona.builtin.guidelines", keys.includes("persona.builtin.guidelines"));
  ok("all start as built-in (not custom)", defaults.every((d: any) => !d.isCustom));

  // ── GET /api/ai-defaults/:key ─────────────────────────────────────────────
  console.log("\nStep 3: Get a single default");
  const getRes = await req<any>("GET", "/api/ai-defaults/extractor.builtin.rules");
  ok("get 200", getRes.status === 200);
  ok("get has value", getRes.data?.value != null);
  ok("get has hardcoded", getRes.data?.hardcoded != null);
  ok("get isCustom=false initially", !getRes.data?.isCustom);

  const getUnknown = await req<any>("GET", "/api/ai-defaults/nonexistent.key");
  ok("unknown key → 404", getUnknown.status === 404);

  // ── PUT /api/ai-defaults/:key ─────────────────────────────────────────────
  console.log("\nStep 4: Update a default (extractor.builtin.systemPrompt)");
  const customPrompt = "You are a specialized document AI for a Turkish education consultancy.";
  const putRes = await req<any>("PUT", "/api/ai-defaults/extractor.builtin.systemPrompt", {
    value: { text: customPrompt },
  });
  ok("put 200", putRes.status === 200);
  ok("put isCustom=true", putRes.data?.isCustom === true);
  ok("put value matches", (putRes.data?.value as any)?.text === customPrompt);

  // Verify it persists via GET
  const getAfterPut = await req<any>("GET", "/api/ai-defaults/extractor.builtin.systemPrompt");
  ok("persisted value matches", (getAfterPut.data?.value as any)?.text === customPrompt);
  ok("persisted isCustom=true", getAfterPut.data?.isCustom === true);

  // ── PUT validation ────────────────────────────────────────────────────────
  console.log("\nStep 5: Validation — wrong payload shape");
  const badPut = await req<any>("PUT", "/api/ai-defaults/extractor.builtin.rules", {
    value: "not-an-object",
  });
  ok("non-object value → 400", badPut.status === 400);

  // ── DELETE /api/ai-defaults/:key (reset) ──────────────────────────────────
  console.log("\nStep 6: Reset (DELETE) extractor.builtin.systemPrompt");
  const delRes = await req<any>("DELETE", "/api/ai-defaults/extractor.builtin.systemPrompt");
  ok("delete 200", delRes.status === 200);
  ok("delete returns hardcoded", (delRes.data as any)?.hardcoded != null);

  const getAfterDel = await req<any>("GET", "/api/ai-defaults/extractor.builtin.systemPrompt");
  ok("isCustom=false after reset", !getAfterDel.data?.isCustom);
  ok("value reverts to hardcoded", JSON.stringify(getAfterDel.data?.value) === JSON.stringify(getAfterDel.data?.hardcoded));

  // ── Unknown key DELETE → 404 ──────────────────────────────────────────────
  const delUnknown = await req<any>("DELETE", "/api/ai-defaults/bad.key");
  ok("delete unknown key → 404", delUnknown.status === 404);

  // ── PARÇA 2: Example persona seeds ───────────────────────────────────────
  console.log("\nStep 7: Verify seeded example personas");
  const personasRes = await req<any>("GET", "/api/ai-personas");
  ok("personas list 200", personasRes.status === 200);
  const personas: any[] = personasRes.data?.personas ?? [];
  const slugs = personas.map((p: any) => p.slug);
  ok("system-audit seeded", slugs.includes("system-audit"));
  ok("blog-yazar-zeynep seeded", slugs.includes("blog-yazar-zeynep"));
  ok("lead-summarizer seeded", slugs.includes("lead-summarizer"));
  ok("followup-reminder seeded", slugs.includes("followup-reminder"));

  const sysAudit = personas.find((p: any) => p.slug === "system-audit");
  ok("system-audit is advisor", sysAudit?.personaType === "advisor");
  ok("system-audit is inactive", !sysAudit?.isActive);

  const blogZeynep = personas.find((p: any) => p.slug === "blog-yazar-zeynep");
  ok("blog-yazar-zeynep is advisor", blogZeynep?.personaType === "advisor");
  ok("blog-yazar-zeynep is inactive", !blogZeynep?.isActive);

  const leadSum = personas.find((p: any) => p.slug === "lead-summarizer");
  ok("lead-summarizer is advisor", leadSum?.personaType === "advisor");
  ok("lead-summarizer trigger=manual", leadSum?.triggerMode === "manual");

  const followup = personas.find((p: any) => p.slug === "followup-reminder");
  ok("followup-reminder is operator", followup?.personaType === "operator");
  ok("followup-reminder trigger=scheduled", followup?.triggerMode === "scheduled");
  ok("followup-reminder cron set", Boolean(followup?.scheduleCron));
  ok("followup-reminder is inactive", !followup?.isActive);

  // ── Idempotency: seeds do not duplicate on re-run ─────────────────────────
  console.log("\nStep 8: Idempotency — seeds are not duplicated");
  ok("exactly 1 system-audit", personas.filter((p: any) => p.slug === "system-audit").length === 1);
  ok("exactly 1 blog-yazar-zeynep", personas.filter((p: any) => p.slug === "blog-yazar-zeynep").length === 1);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Passed: ${passed}  Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
