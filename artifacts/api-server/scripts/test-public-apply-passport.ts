/**
 * Public apply — passport hard-block route tests (FAZ 2).
 *
 * PA-1  Expired passport (YYYY-MM-DD) → 422 with stable error code
 *       "PASSPORT_EXPIRED", and NO student row is created (block runs
 *       before any insert).
 * PA-2  Expired passport in DD.MM.YYYY format → same 422.
 * PA-3  Valid future expiry passes the passport gate (request proceeds
 *       past it — any later failure is NOT the passport block).
 * PA-4  Unparseable expiry ("garbage") is fail-open — not blocked by the
 *       passport gate.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:public-apply-passport
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import { db, studentsTable, usersTable, leadsTable } from "@workspace/db";

import publicApplyRouter from "../src/routes/public-apply.js";

after(() => {
  setImmediate(() => process.exit(process.exitCode ?? 0));
});

const RUN_ID = `pa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

function buildApp(): Express {
  const app = express();
  app.use("/api", publicApplyRouter);
  return app;
}

const app = buildApp();

function apiReq(path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const payload = JSON.stringify(body);
      const reqq = http.request(
        {
          hostname: "127.0.0.1",
          port: addr.port,
          path,
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            server.close();
            let parsed: any = null;
            try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; }
            resolve({ status: res.statusCode || 0, body: parsed });
          });
        },
      );
      reqq.on("error", (e) => { server.close(); reject(e); });
      reqq.write(payload);
      reqq.end();
    });
  });
}

function basePayload(emailTag: string, passportExpiry: string | undefined) {
  return {
    firstName: "Testcase",
    lastName: "Passport",
    motherName: "Mother",
    fatherName: "Father",
    email: `${RUN_ID}.${emailTag}@example.test`,
    phone: "+905551112233",
    nationality: "Turkey",
    gender: "male",
    ...(passportExpiry !== undefined ? { passportExpiry } : {}),
  };
}

async function cleanup(emailTag: string) {
  const email = `${RUN_ID}.${emailTag}@example.test`;
  await db.delete(studentsTable).where(eq(studentsTable.email, email));
  await db.delete(leadsTable).where(eq(leadsTable.email, email));
  await db.delete(usersTable).where(eq(usersTable.email, email));
}

test("PA-1 expired passport (ISO) → 422 PASSPORT_EXPIRED, no student created", async () => {
  const email = `${RUN_ID}.pa1@example.test`;
  const r = await apiReq("/api/public/apply", basePayload("pa1", "2020-01-01"));
  assert.equal(r.status, 422);
  assert.equal(r.body.error, "PASSPORT_EXPIRED");
  const rows = await db.select().from(studentsTable).where(eq(studentsTable.email, email));
  assert.equal(rows.length, 0);
  await cleanup("pa1");
});

test("PA-2 expired passport (DD.MM.YYYY) → 422 PASSPORT_EXPIRED", async () => {
  const r = await apiReq("/api/public/apply", basePayload("pa2", "01.01.2020"));
  assert.equal(r.status, 422);
  assert.equal(r.body.error, "PASSPORT_EXPIRED");
  await cleanup("pa2");
});

test("PA-3 valid future expiry passes the passport gate", async () => {
  const r = await apiReq("/api/public/apply", basePayload("pa3", "2099-12-31"));
  assert.notEqual(r.status, 422);
  assert.notEqual(r.body?.error, "PASSPORT_EXPIRED");
  await cleanup("pa3");
});

test("PA-4 unparseable expiry is fail-open (not blocked)", async () => {
  const r = await apiReq("/api/public/apply", basePayload("pa4", "garbage"));
  assert.notEqual(r.body?.error, "PASSPORT_EXPIRED");
  await cleanup("pa4");
});
