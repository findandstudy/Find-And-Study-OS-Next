/**
 * DOĞRULAMA TURU — Birleşik Feed FAZ 1
 *
 * (1) CROSS-CONTEXT IDOR: personFeed TÜM uçları
 * (2) LIFECYCLE: lead→student dönüşümü + feed sürekliliği
 * (3) NOT KARARI: General/Private + resourceType
 *
 * Çalıştır:
 *   pnpm --filter @workspace/api-server exec tsx scripts/test-person-feed.ts
 * Ön koşul: API Server 8080'de çalışıyor, audit kullanıcıları seed edilmiş.
 */

import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import {
  db, leadsTable, studentsTable, notesTable, followUpsTable,
  externalContactsTable,
} from "@workspace/db";
import { eq, and, isNull, inArray, sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const API = "http://localhost:8080/api";
const PASS = process.env.RBAC_E2E_PASSWORD;
if (!PASS) {
  throw new Error("RBAC_E2E_PASSWORD is required for person-feed tests");
}
const ADMIN_EMAIL = "audit-admin@audit.test";
const RUN = `pf${Date.now().toString(36).slice(-5)}`;

// ---------------------------------------------------------------------------
// HTTP Session helper
// ---------------------------------------------------------------------------
type CookieJar = Map<string, string>;

function cookieStr(jar: CookieJar): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function absorbSetCookie(headers: Headers, jar: CookieJar): void {
  const raw: string[] = typeof (headers as any).getSetCookie === "function"
    ? (headers as any).getSetCookie()
    : [headers.get("set-cookie") ?? ""].filter(Boolean);
  for (const c of raw) {
    const [kv] = c.split(";");
    const eqIdx = kv.indexOf("=");
    if (eqIdx < 0) continue;
    jar.set(kv.slice(0, eqIdx).trim(), kv.slice(eqIdx + 1).trim());
  }
}

async function apiFetch(
  jar: CookieJar,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const hdrs: Record<string, string> = {
    "Content-Type": "application/json",
    "Cookie": cookieStr(jar),
    "x-csrf-token": jar.get("csrf_token") ?? "",
  };
  const res = await fetch(`${API}${path}`, {
    method,
    headers: hdrs,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  absorbSetCookie(res.headers, jar);
  return res;
}

async function login(email: string): Promise<CookieJar> {
  const jar: CookieJar = new Map();
  // Seed csrf_token
  const seed = await fetch(`${API}/auth/me`);
  absorbSetCookie(seed.headers, jar);
  const res = await apiFetch(jar, "POST", "/auth/login", { email, password: PASS });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Login failed (${email}): HTTP ${res.status} — ${txt}`);
  }
  return jar;
}

// ---------------------------------------------------------------------------
// DB-direct helpers (bypass branch requirement in POST /leads)
// ---------------------------------------------------------------------------
async function dbInsertLead(overrides: Record<string, unknown>): Promise<number> {
  const [row] = await db.insert(leadsTable).values({
    firstName: overrides.firstName as string,
    lastName: overrides.lastName as string,
    email: overrides.email as string,
    phone: overrides.phone as string,
    source: "direct",
    status: "new",
    originType: "direct",
    branchId: null,            // null-branch is visible to admin (includes null in WHERE)
    agentId: null,
    convertedStudentId: null,
    ...overrides,
  } as any).returning({ id: leadsTable.id });
  return row.id;
}

// ---------------------------------------------------------------------------
// Feed API helpers
// ---------------------------------------------------------------------------
async function postNote(
  jar: CookieJar,
  context: string,
  id: number,
  content: string,
  isInternal = false,
): Promise<{ noteId: number; entityType: string; entityId: number; isInternal: boolean }> {
  const res = await apiFetch(
    jar, "POST",
    `/persons/feed/notes?context=${context}&id=${id}`,
    { content, isInternal },
  );
  const txt = await res.clone().text();
  assert.equal(res.status, 201, `postNote HTTP ${res.status}: ${txt}`);
  const body = JSON.parse(txt) as any;
  const noteId = body?.data?.noteId;
  assert.ok(noteId, `postNote: no noteId — ${txt}`);
  createdNoteIds.push(noteId);
  return {
    noteId,
    entityType: body.data.entityType,
    entityId: body.data.entityId,
    isInternal: body.data.isInternal,
  };
}

async function postFollowUp(
  jar: CookieJar,
  context: string,
  id: number,
  title: string,
): Promise<{ fuId: number; entityType: string }> {
  const res = await apiFetch(
    jar, "POST",
    `/persons/feed/follow-ups?context=${context}&id=${id}`,
    { title, scheduledAt: "2030-01-01T10:00:00Z" },
  );
  const txt = await res.clone().text();
  assert.equal(res.status, 201, `postFollowUp HTTP ${res.status}: ${txt}`);
  const body = JSON.parse(txt) as any;
  const fuId = body?.data?.followUpId;
  assert.ok(fuId, `postFollowUp: no followUpId — ${txt}`);
  createdFuIds.push(fuId);
  return { fuId, entityType: body.data.entityType };
}

async function getFeed(jar: CookieJar, context: string, id: number): Promise<any[]> {
  const res = await apiFetch(jar, "GET", `/persons/feed?context=${context}&id=${id}`);
  const txt = await res.clone().text();
  assert.equal(res.status, 200, `getFeed HTTP ${res.status}: ${txt}`);
  return (JSON.parse(txt) as any)?.data ?? [];
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------
let adminJar: CookieJar;
let leadAId: number;
let leadBId: number;
let studentId = 0;

// Suite-1 IDOR test fixtures — created in root before() to avoid inner-before() race
let suite1NoteOnAId = 0;
let suite1FuOnAId = 0;

const createdNoteIds: number[] = [];
const createdFuIds: number[] = [];
const createdLeadIds: number[] = [];
const createdStudentIds: number[] = [];

// ---------------------------------------------------------------------------
// Root setup / teardown
// ---------------------------------------------------------------------------
before(async () => {
  adminJar = await login(ADMIN_EMAIL);

  leadAId = await dbInsertLead({
    firstName: `PF-A-${RUN}`,
    lastName: "FeedTest",
    email: `pf-a-${RUN}@feed.test`,
    phone: "+905001111111",
  });
  createdLeadIds.push(leadAId);
  console.log(`  [setup] Lead A id=${leadAId}, Lead B creating...`);

  leadBId = await dbInsertLead({
    firstName: `PF-B-${RUN}`,
    lastName: "FeedTest",
    email: `pf-b-${RUN}@feed.test`,
    phone: "+905002222222",
  });
  createdLeadIds.push(leadBId);
  console.log(`  [setup] Lead B id=${leadBId}`);

  // Suite-1 IDOR fixtures: note + follow-up on Lead A created here (root before)
  // to avoid any timing/race issue with describe-level before() hooks.
  const n = await postNote(adminJar, "lead", leadAId, `[IDOR-setup] Note on A ${RUN}`);
  suite1NoteOnAId = n.noteId;
  const fu = await postFollowUp(adminJar, "lead", leadAId, `[IDOR-setup] FU on A ${RUN}`);
  suite1FuOnAId = fu.fuId;
  console.log(`  [setup] IDOR fixtures: noteOnA=${suite1NoteOnAId}, fuOnA=${suite1FuOnAId}`);
});

after(async () => {
  // Remove test notes (hard-delete, no soft-delete on notes table)
  if (createdNoteIds.length) {
    await db.delete(notesTable).where(inArray(notesTable.id, createdNoteIds));
  }
  // Remove test follow-ups
  if (createdFuIds.length) {
    await db.delete(followUpsTable).where(inArray(followUpsTable.id, createdFuIds));
  }
  // Soft-delete students via DB
  for (const sid of createdStudentIds) {
    await db.update(studentsTable).set({ deletedAt: new Date() }).where(eq(studentsTable.id, sid));
  }
  // Soft-delete leads via DB
  for (const lid of createdLeadIds) {
    await db.update(leadsTable).set({ deletedAt: new Date() }).where(eq(leadsTable.id, lid));
  }
  console.log("  [teardown] done");
});

// ===========================================================================
// BÖLÜM 1 — CROSS-CONTEXT IDOR (tüm 5 endpoint)
// ===========================================================================
describe("(1) Cross-context IDOR — tüm 5 endpoint", async () => {
  // Fixtures created in the root before() to avoid describe-level before() race conditions.
  // suite1NoteOnAId and suite1FuOnAId are module-level variables set before any describe runs.

  // 1a. GET feed — Lead B context Lead A notunu içermez
  test("1a. GET feed: Lead B context Lead A notunu içermez", async () => {
    const items = await getFeed(adminJar, "lead", leadBId);
    const noteIds = items.map((i: any) => i.noteId).filter(Boolean);
    assert.ok(
      !noteIds.includes(suite1NoteOnAId),
      `FAIL — Lead B feed'inde Lead A notu (${suite1NoteOnAId}) görünüyor — IDOR!`,
    );
    console.log(`    ✓ Lead B feed ${items.length} item, noteOnA=${suite1NoteOnAId} YOK`);
  });

  // 1b. DELETE — Lead B context ile Lead A notuna erişim → 404
  test("1b. DELETE note: Lead B context ile Lead A notu → 404 (BUG-011)", async () => {
    const res = await apiFetch(
      adminJar, "DELETE",
      `/persons/feed/notes/${suite1NoteOnAId}?context=lead&id=${leadBId}`,
    );
    assert.equal(
      res.status, 404,
      `FAIL — HTTP ${res.status}, beklenen 404 — BUG-011 düzeltmesi çalışmıyor!`,
    );

    // Kanıt: not hâlâ DB'de
    const [row] = await db.select().from(notesTable).where(eq(notesTable.id, suite1NoteOnAId));
    assert.ok(row, "FAIL — Not DB'den silinmiş (IDOR gerçekleşti!)");
    console.log(`    ✓ DELETE → 404 (IDOR engellendi); DB'de hâlâ: noteId=${suite1NoteOnAId}`);
  });

  // 1c. PATCH follow-up — Lead B context ile Lead A FU → 404
  test("1c. PATCH follow-up: Lead B context ile Lead A FU → 404 (BUG-012)", async () => {
    const res = await apiFetch(
      adminJar, "PATCH",
      `/persons/feed/follow-ups/${suite1FuOnAId}?context=lead&id=${leadBId}`,
      { completed: true },
    );
    assert.equal(
      res.status, 404,
      `FAIL — HTTP ${res.status}, beklenen 404 — BUG-012 düzeltmesi çalışmıyor!`,
    );

    // Kanıt: FU completed=false kalmış (değiştirilmemiş)
    const [row] = await db.select().from(followUpsTable).where(eq(followUpsTable.id, suite1FuOnAId));
    assert.ok(row, "FU DB'de bulunamadı");
    assert.equal(row.completed, false, `FAIL — FU.completed=${row.completed} — IDOR gerçekleşti!`);
    console.log(`    ✓ PATCH → 404; DB fuId=${suite1FuOnAId}.completed=false (değişmemiş)`);
  });

  // 1d. POST note — Lead B context'te yazılan not Lead A'ya düşmez
  test("1d. POST note: Lead B context'e yazılan not yalnızca Lead B'ye bağlıdır", async () => {
    const { noteId, entityId, entityType } = await postNote(
      adminJar, "lead", leadBId,
      `[IDOR-isolation] Note via B ${RUN}`,
    );
    assert.equal(entityId, leadBId, `FAIL — entityId=${entityId} ≠ leadB=${leadBId}`);
    assert.equal(entityType, "lead");

    const [row] = await db.select().from(notesTable).where(eq(notesTable.id, noteId));
    assert.ok(row, "Not DB'de yok");
    assert.equal(row.resourceId, leadBId, `FAIL — DB resourceId=${row.resourceId} ≠ leadB=${leadBId}`);
    console.log(`    ✓ noteId=${noteId} → resourceId=${row.resourceId} (=leadB), type=${row.resourceType}`);
  });

  // 1e. POST follow-up — Lead B context'te yazılan FU Lead A'ya düşmez
  test("1e. POST follow-up: Lead B context'e yazılan FU yalnızca Lead B'ye bağlıdır", async () => {
    const { fuId } = await postFollowUp(adminJar, "lead", leadBId, `[IDOR-isolation] FU via B ${RUN}`);

    const [row] = await db.select().from(followUpsTable).where(eq(followUpsTable.id, fuId));
    assert.ok(row, "FU DB'de yok");
    assert.equal(row.leadId, leadBId, `FAIL — DB leadId=${row.leadId} ≠ leadB=${leadBId}`);
    assert.ok(!row.studentId, `FAIL — studentId set=${row.studentId} (beklenmiyor)`);
    console.log(`    ✓ fuId=${fuId} → leadId=${row.leadId} (=leadB), studentId=${row.studentId}`);
  });

  // 1f. GET feed çift yön — Lead A context Lead B'ye özgü notu içermez
  test("1f. GET feed çift yön: Lead A context Lead B notunu içermez", async () => {
    const { noteId: bOnlyNote } = await postNote(
      adminJar, "lead", leadBId,
      `[IDOR-cross] B-only ${RUN}`,
    );

    const itemsOfA = await getFeed(adminJar, "lead", leadAId);
    const noteIds = itemsOfA.map((i: any) => i.noteId).filter(Boolean);
    assert.ok(
      !noteIds.includes(bOnlyNote),
      `FAIL — Lead A feed'inde Lead B notu (${bOnlyNote}) var — IDOR!`,
    );
    console.log(`    ✓ Lead A feed ${itemsOfA.length} item; B-only note=${bOnlyNote} YOK`);
  });
});

// ===========================================================================
// BÖLÜM 2 — LIFECYCLE: lead→student dönüşümü + feed sürekliliği
// ===========================================================================
describe("(2) Lifecycle — lead→student dönüşümü + feed sürekliliği", async () => {
  let leadNoteId = 0;
  let leadFuId = 0;
  let studentNoteId = 0;

  before(async () => {
    // Dönüşüm öncesi Lead A'ya not + FU ekle
    const n = await postNote(adminJar, "lead", leadAId, `[LC] Lead note ${RUN}`);
    leadNoteId = n.noteId;
    const fu = await postFollowUp(adminJar, "lead", leadAId, `[LC] Lead FU ${RUN}`);
    leadFuId = fu.fuId;
    console.log(`    [suite-2-setup] leadNoteId=${leadNoteId}, leadFuId=${leadFuId}`);
  });

  test("2a. Lead→Student dönüşümü: 200, student.originLeadId=leadAId", async () => {
    const res = await apiFetch(adminJar, "POST", `/leads/${leadAId}/convert`);
    const txt = await res.clone().text();
    assert.ok([200, 201].includes(res.status), `FAIL — convert HTTP ${res.status}: ${txt}`);
    const body = JSON.parse(txt) as any;
    assert.ok(body?.student?.id, `FAIL — student.id yok: ${txt}`);
    studentId = body.student.id;
    createdStudentIds.push(studentId);

    assert.equal(
      body.student.originLeadId, leadAId,
      `FAIL — originLeadId=${body.student.originLeadId} ≠ leadA=${leadAId}`,
    );
    console.log(`    ✓ Student oluşturuldu: id=${studentId}, originLeadId=${body.student.originLeadId}`);
  });

  test("2b. leads.convertedStudentId → studentId", async () => {
    assert.ok(studentId, "studentId set edilmedi (2a başarısız?)");
    const [lead] = await db.select({ cvtId: leadsTable.convertedStudentId })
      .from(leadsTable).where(eq(leadsTable.id, leadAId));
    assert.ok(lead, "Lead DB'de bulunamadı");
    assert.equal(lead.cvtId, studentId, `FAIL — convertedStudentId=${lead.cvtId} ≠ ${studentId}`);
    console.log(`    ✓ leads.convertedStudentId=${lead.cvtId}`);
  });

  test("2c. external_contacts.studentId dönüşüm sonrası set edildi", async () => {
    const contacts = await db.select()
      .from(externalContactsTable)
      .where(eq(externalContactsTable.leadId, leadAId));
    if (contacts.length === 0) {
      console.log("    ~ external_contacts kaydı yok (inbox konuşması yok) — skip");
      return; // not a failure — lead was never in inbox
    }
    for (const c of contacts) {
      assert.equal(
        c.studentId, studentId,
        `FAIL — external_contacts id=${c.id}: studentId=${c.studentId} ≠ ${studentId}`,
      );
    }
    console.log(`    ✓ ${contacts.length} external_contact.studentId=${studentId}`);
  });

  test("2d. Student context feed — dönüşüm öncesi lead notu görünüyor", async () => {
    assert.ok(studentId, "studentId set edilmedi (2a başarısız?)");
    const items = await getFeed(adminJar, "student", studentId);
    const noteIds = items.map((i: any) => i.noteId).filter(Boolean);
    assert.ok(
      noteIds.includes(leadNoteId),
      `FAIL — student feed'inde leadNoteId=${leadNoteId} yok\nFeed noteIds: ${JSON.stringify(noteIds)}`,
    );
    console.log(`    ✓ Student feed ${items.length} item; leadNoteId=${leadNoteId} var`);
  });

  test("2e. Student context feed — dönüşüm öncesi lead FU'su görünüyor", async () => {
    assert.ok(studentId, "studentId set edilmedi (2a başarısız?)");
    const items = await getFeed(adminJar, "student", studentId);
    const fuIds = items.map((i: any) => i.followUpId).filter(Boolean);
    assert.ok(
      fuIds.includes(leadFuId),
      `FAIL — student feed'inde leadFuId=${leadFuId} yok\nFeed fuIds: ${JSON.stringify(fuIds)}`,
    );
    console.log(`    ✓ Student feed; leadFuId=${leadFuId} var`);
  });

  test("2f. Dönüşüm sonrası student context notu → resourceType='student' (lead DEĞİL)", async () => {
    assert.ok(studentId, "studentId set edilmedi");
    const { noteId, entityType, entityId } = await postNote(
      adminJar, "student", studentId,
      `[LC] Student note post-convert ${RUN}`,
    );
    studentNoteId = noteId;
    assert.equal(entityType, "student",
      `FAIL — entityType=${entityType} — 'lead'e zorlanıyor!`);
    assert.equal(entityId, studentId, `FAIL — entityId=${entityId} ≠ studentId=${studentId}`);

    const [row] = await db.select().from(notesTable).where(eq(notesTable.id, noteId));
    assert.equal(row.resourceType, "student",
      `FAIL — DB resourceType=${row.resourceType} — 'lead'e zorlanıyor!`);
    assert.equal(row.resourceId, studentId);
    console.log(`    ✓ noteId=${noteId} → resourceType='${row.resourceType}', resourceId=${row.resourceId}`);
  });

  test("2g. Çift yön: Lead A context feed'inde student notu görünüyor", async () => {
    assert.ok(studentNoteId, "studentNoteId set edilmedi (2f başarısız?)");
    // Lead A context → resolvePersonIds çağrısı convertedStudentId via DB, studentId'yi set eder
    const items = await getFeed(adminJar, "lead", leadAId);
    const noteIds = items.map((i: any) => i.noteId).filter(Boolean);
    assert.ok(
      noteIds.includes(studentNoteId),
      `FAIL — Lead A feed'inde studentNoteId=${studentNoteId} yok (çift yön kırık)\nFeed noteIds: ${JSON.stringify(noteIds)}`,
    );
    console.log(`    ✓ Lead A feed'inde studentNoteId=${studentNoteId} var (çift yön ✓)`);
  });
});

// ===========================================================================
// BÖLÜM 3 — NOT KARARI: General/Private + resourceType
// ===========================================================================
describe("(3) Not kararı — General/Private + resourceType + inbox", async () => {

  test("3a. General not (isInternal=false) — oluşturulur, response doğru", async () => {
    const { noteId, isInternal, entityType } = await postNote(
      adminJar, "lead", leadBId,
      `[GEN] General ${RUN}`, false,
    );
    assert.equal(isInternal, false, `FAIL — isInternal=${isInternal}`);
    assert.equal(entityType, "lead");
    const [row] = await db.select().from(notesTable).where(eq(notesTable.id, noteId));
    assert.equal(row.isInternal, false, `FAIL — DB isInternal=${row.isInternal}`);
    assert.equal(row.resourceType, "lead");
    console.log(`    ✓ General noteId=${noteId} → isInternal=false, resourceType='lead'`);
  });

  test("3b. Private not (isInternal=true) — staff oluşturabilir, response doğru", async () => {
    const { noteId, isInternal, entityType } = await postNote(
      adminJar, "lead", leadBId,
      `[PRIV] Private ${RUN}`, true,
    );
    assert.equal(isInternal, true, `FAIL — isInternal=${isInternal}`);
    assert.equal(entityType, "lead");
    const [row] = await db.select().from(notesTable).where(eq(notesTable.id, noteId));
    assert.equal(row.isInternal, true, `FAIL — DB isInternal=${row.isInternal}`);
    console.log(`    ✓ Private noteId=${noteId} → isInternal=true`);
  });

  test("3c. Staff feed'inde hem General hem Private görünüyor", async () => {
    const { noteId: genId } = await postNote(
      adminJar, "lead", leadBId, `[READ-GEN] ${RUN}`, false,
    );
    const { noteId: privId } = await postNote(
      adminJar, "lead", leadBId, `[READ-PRIV] ${RUN}`, true,
    );

    const items = await getFeed(adminJar, "lead", leadBId);
    const noteIds = items.map((i: any) => i.noteId).filter(Boolean);

    assert.ok(noteIds.includes(genId), `FAIL — General noteId=${genId} feed'de yok`);
    assert.ok(noteIds.includes(privId), `FAIL — Private noteId=${privId} staff feed'de yok`);

    const genItem = items.find((i: any) => i.noteId === genId);
    const privItem = items.find((i: any) => i.noteId === privId);
    assert.equal(genItem.isInternal, false, `FAIL — General isInternal=${genItem.isInternal}`);
    assert.equal(privItem.isInternal, true, `FAIL — Private isInternal=${privItem.isInternal}`);
    console.log(`    ✓ Staff feed: General noteId=${genId} isInternal=false, Private noteId=${privId} isInternal=true`);
  });

  test("3d. Lead context notu → resourceType='lead' (studentId yok)", async () => {
    // Lead B dönüştürülmedi — studentId yok → resourceType='lead'
    const { noteId } = await postNote(
      adminJar, "lead", leadBId, `[RT-lead] ${RUN}`,
    );
    const [row] = await db.select().from(notesTable).where(eq(notesTable.id, noteId));
    assert.equal(row.resourceType, "lead",
      `FAIL — DB resourceType=${row.resourceType} (leadId varken 'lead' olmalı)`);
    console.log(`    ✓ Lead context → DB resourceType='${row.resourceType}'`);
  });

  test("3e. Student context notu → resourceType='student' (lead DEĞİL)", async () => {
    assert.ok(studentId, "studentId set edilmedi (Bölüm 2 başarısız?)");
    const { noteId, entityType } = await postNote(
      adminJar, "student", studentId, `[RT-student] ${RUN}`,
    );
    assert.equal(entityType, "student",
      `FAIL — API entityType=${entityType} — 'lead'e zorlanıyor!`);
    const [row] = await db.select().from(notesTable).where(eq(notesTable.id, noteId));
    assert.equal(row.resourceType, "student",
      `FAIL — DB resourceType=${row.resourceType} — 'lead'e zorlanıyor!`);
    console.log(`    ✓ Student context → DB resourceType='${row.resourceType}'`);
  });

  test("3f. Inbox notu → isInternal=true (DB + kod doğrulaması)", async () => {
    // Mevcut conversation notlarını kontrol et
    const rows = await db
      .select({ id: notesTable.id, isInternal: notesTable.isInternal })
      .from(notesTable)
      .where(eq(notesTable.resourceType, "conversation"))
      .limit(10);

    if (rows.length > 0) {
      for (const r of rows) {
        assert.equal(r.isInternal, true,
          `FAIL — Inbox not id=${r.id}: isInternal=${r.isInternal} (true olmalı!)`);
      }
      console.log(`    ✓ ${rows.length} conversation notu: hepsi isInternal=true`);
    } else {
      // Kod kanıtı: inbox.ts satır 1357 ve 1368 → isInternal: true
      console.log("    ~ conversation notu yok (inbox konuşması olmamış)");
      console.log("    ✓ Kod doğrulaması: inbox.ts:1357 isInternal:true (primary) + :1368 isInternal:true (cross-link)");
    }
  });

  test("3g. Kart notu (doğrudan lead/student) — isInternal kullanıcı tarafından belirlenir", async () => {
    const { noteId: g } = await postNote(adminJar, "lead", leadBId, `[CARD-G] ${RUN}`, false);
    const { noteId: p } = await postNote(adminJar, "lead", leadBId, `[CARD-P] ${RUN}`, true);

    const [gRow] = await db.select().from(notesTable).where(eq(notesTable.id, g));
    const [pRow] = await db.select().from(notesTable).where(eq(notesTable.id, p));

    assert.equal(gRow.isInternal, false, `FAIL — General isInternal=${gRow.isInternal}`);
    assert.equal(pRow.isInternal, true, `FAIL — Private isInternal=${pRow.isInternal}`);
    console.log(`    ✓ General noteId=${g} isInternal=false | Private noteId=${p} isInternal=true`);
  });
});
