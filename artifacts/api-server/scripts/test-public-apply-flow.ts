/**
 * Public/Embed Apply flow regression test (Task #135).
 *
 * Verifies the lead-first + auto-convert behavior end-to-end against
 * a running api-server (default http://localhost:8080). Four flows
 * are exercised:
 *
 *   (a) Embed widget — POST /public/embed/:slug/lead then
 *       POST /public/embed/:slug/apply with the same email + leadId.
 *       Expect:
 *         - lead-only call leaves the row at status="new", no student
 *         - full apply auto-converts the lead (status="converted",
 *           convertedStudentId set) and creates a student/application
 *         - student persists ALL AI-extractable fields submitted
 *           (motherName, fatherName, gender, dateOfBirth, passport*,
 *           address, highSchool, graduationYear, gpa, languageScore)
 *
 *   (b) Program-detail public apply — POST /public/lead then
 *       POST /public/apply with the same email + leadId. Same auto-
 *       convert + persistence assertions as the embed flow.
 *
 *   (c) Gender normalization — embed /apply with several variants
 *       (canonical, title-case, upper-case, unknown). Confirms
 *       canonical persistence and NULL coercion for unknowns.
 *
 *   (d) Auto-convert disabled — flips settings.autoConvertLeadEnabled
 *       to false, runs lead+apply, and asserts the lead stays at
 *       status="new" with convertedStudentId=null even though the
 *       student row is still created. Restores the original setting
 *       on exit.
 *
 * Self-seeds its own university/program/widget rows tagged with the
 * RUN_ID so reruns never collide. Cleans up at the end.
 *
 * NOT wired into the default `pnpm test` chain on purpose: it depends
 * on a running api-server. Run explicitly with:
 *   pnpm --filter @workspace/api-server test:public-apply-flow
 */
import {
  db,
  universitiesTable,
  programsTable,
  embedWidgetsTable,
  leadsTable,
  studentsTable,
  usersTable,
  applicationsTable,
  documentsTable,
  settingsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

const BASE = process.env.API_BASE_URL || "http://localhost:8080";
const RUN_ID = `t135_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

interface Section { name: string; ok: boolean; details: string[] }
interface Fixtures { uniId: number; progId: number; widgetId: number; slug: string }
interface JsonResponse { status: number; ok: boolean; data: Record<string, unknown> | null }

function assert(cond: boolean, msg: string, details: string[]): boolean {
  details.push(`${cond ? "OK   " : "FAIL "} ${msg}`);
  return cond;
}

async function setupFixtures(): Promise<Fixtures> {
  const [uni] = await db.insert(universitiesTable).values({
    name: `T135 Test University ${RUN_ID}`,
    country: "Turkey",
    city: "Istanbul",
    isActive: true,
  }).returning();
  const [prog] = await db.insert(programsTable).values({
    universityId: uni.id,
    name: `T135 Test Program ${RUN_ID}`,
    degree: "Bachelor",
    language: "English",
    isActive: true,
  }).returning();
  const slug = `t135-widget-${RUN_ID}`;
  const [widget] = await db.insert(embedWidgetsTable).values({
    slug,
    name: `T135 Widget ${RUN_ID}`,
    isActive: true,
    mode: "combined",
    allowedDomains: [],
  }).returning();
  return { uniId: uni.id, progId: prog.id, widgetId: widget.id, slug };
}

async function teardownFixtures(fx: Fixtures, emails: string[]): Promise<void> {
  for (const email of emails) {
    const lc = email.toLowerCase().trim();
    const [u] = await db.select().from(usersTable).where(eq(usersTable.email, lc));
    if (u) {
      const studs = await db.select().from(studentsTable).where(eq(studentsTable.userId, u.id));
      for (const st of studs) {
        await db.delete(documentsTable).where(eq(documentsTable.studentId, st.id));
        await db.delete(applicationsTable).where(eq(applicationsTable.studentId, st.id));
        await db.delete(studentsTable).where(eq(studentsTable.id, st.id));
      }
      await db.delete(usersTable).where(eq(usersTable.id, u.id));
    }
    await db.delete(leadsTable).where(eq(leadsTable.email, email));
  }
  await db.delete(embedWidgetsTable).where(eq(embedWidgetsTable.id, fx.widgetId));
  await db.delete(programsTable).where(eq(programsTable.id, fx.progId));
  await db.delete(universitiesTable).where(eq(universitiesTable.id, fx.uniId));
}

async function postJson(url: string, body: Record<string, unknown>): Promise<JsonResponse> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: Record<string, unknown> | null = null;
  try {
    data = await r.json() as Record<string, unknown>;
  } catch {
    // Non-JSON response (rare on these endpoints) — leave data null and
    // let the caller assert on status. We don't need to mask anything
    // beyond the parse itself.
    data = null;
  }
  return { status: r.status, ok: r.ok, data };
}

function readNumber(data: Record<string, unknown> | null, key: string): number | null {
  const v = data?.[key];
  return typeof v === "number" ? v : null;
}

function buildFullFields(suffix: string) {
  return {
    motherName: "ANNE TEST",
    fatherName: "BABA TEST",
    gender: "female",
    dateOfBirth: "2000-01-15",
    passportNumber: `T135${suffix}${Date.now().toString(36).slice(-5).toUpperCase()}`,
    passportIssueDate: "2020-06-01",
    passportExpiry: "2030-06-01",
    address: "Test Sokak No 1, Istanbul",
    highSchool: "Test Lisesi",
    graduationYear: 2018,
    gpa: "85",
    languageScore: "IELTS 7.0",
  };
}

async function runEmbedFlow(slug: string): Promise<Section> {
  const details: string[] = [];
  let ok = true;
  const email = `t135-embed-${RUN_ID}@test.local`;
  const FULL = buildFullFields("E");

  const r1 = await postJson(`${BASE}/api/public/embed/${slug}/lead`, {
    firstName: "EmbedFirst",
    lastName: "EmbedLast",
    email,
    phone: "5551234567",
    countryCode: "+90",
    programName: "T135 Test Program",
    universityName: "T135 Test University",
  });
  const leadId = readNumber(r1.data, "leadId");
  ok = assert(r1.status === 201 && leadId !== null, `embed /lead returns 201 with leadId (got ${r1.status})`, details) && ok;

  if (leadId !== null) {
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
    ok = assert(!!lead && lead.status === "new", `lead-only row exists with status="new" (got ${lead?.status})`, details) && ok;
    const [usr] = await db.select().from(usersTable).where(eq(usersTable.email, email.toLowerCase()));
    ok = assert(!usr, `lead-only step did NOT create a user account`, details) && ok;
  }

  const r2 = await postJson(`${BASE}/api/public/embed/${slug}/apply`, {
    firstName: "EmbedFirst",
    lastName: "EmbedLast",
    email,
    phone: "5551234567",
    countryCode: "+90",
    nationality: "Turkey",
    desiredLevel: "Bachelor",
    leadId,
    ...FULL,
  });
  ok = assert(r2.status === 201 && r2.data?.success === true, `embed /apply returns 201 success (got ${r2.status})`, details) && ok;

  if (leadId !== null) {
    const [leadAfter] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
    ok = assert(leadAfter?.status === "converted", `lead auto-converted to status="converted" (got ${leadAfter?.status})`, details) && ok;
    ok = assert(!!leadAfter?.convertedStudentId, `lead.convertedStudentId is set (got ${leadAfter?.convertedStudentId})`, details) && ok;

    if (leadAfter?.convertedStudentId) {
      const linkedApps = await db.select({ leadId: applicationsTable.leadId })
        .from(applicationsTable)
        .where(eq(applicationsTable.studentId, leadAfter.convertedStudentId));
      ok = assert(
        linkedApps.some((app) => app.leadId === leadId),
        `auto-converted application stores its exact leadId`,
        details,
      ) && ok;
      const [stu] = await db.select().from(studentsTable).where(eq(studentsTable.id, leadAfter.convertedStudentId));
      ok = assert(!!stu, `student row created`, details) && ok;
      if (stu) {
        ok = assert(stu.motherName === FULL.motherName, `student.motherName persisted (got "${stu.motherName}")`, details) && ok;
        ok = assert(stu.fatherName === FULL.fatherName, `student.fatherName persisted (got "${stu.fatherName}")`, details) && ok;
        ok = assert(stu.gender === FULL.gender, `student.gender persisted (got "${stu.gender}")`, details) && ok;
        ok = assert(stu.dateOfBirth === FULL.dateOfBirth, `student.dateOfBirth persisted (got "${stu.dateOfBirth}")`, details) && ok;
        ok = assert(stu.passportNumber === FULL.passportNumber, `student.passportNumber persisted`, details) && ok;
        ok = assert(stu.passportIssueDate === FULL.passportIssueDate, `student.passportIssueDate persisted`, details) && ok;
        ok = assert(stu.passportExpiry === FULL.passportExpiry, `student.passportExpiry persisted`, details) && ok;
        ok = assert(stu.address === FULL.address, `student.address persisted`, details) && ok;
        ok = assert(stu.highSchool === FULL.highSchool, `student.highSchool persisted`, details) && ok;
        ok = assert(stu.graduationYear === FULL.graduationYear, `student.graduationYear persisted (got ${stu.graduationYear})`, details) && ok;
        ok = assert(stu.gpa === FULL.gpa, `student.gpa persisted (got "${stu.gpa}")`, details) && ok;
        ok = assert(stu.languageScore === FULL.languageScore, `student.languageScore persisted (got "${stu.languageScore}")`, details) && ok;
      }
    }
  }

  return { name: "(a) Embed widget lead-first + full submit", ok, details };
}

async function runPublicApplyFlow(progId: number): Promise<Section> {
  const details: string[] = [];
  let ok = true;
  const email = `t135-pub-${RUN_ID}@test.local`;
  const FULL = buildFullFields("P");

  const r1 = await postJson(`${BASE}/api/public/lead`, {
    firstName: "PubFirst",
    lastName: "PubLast",
    email,
    phone: "+905557654321",
    interestedProgram: "T135 Test Program",
    interestedCountry: "Turkey",
  });
  const leadId = readNumber(r1.data, "leadId");
  ok = assert(r1.status === 201 && leadId !== null, `public /lead returns 201 with leadId (got ${r1.status})`, details) && ok;

  if (leadId !== null) {
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
    ok = assert(!!lead && lead.status === "new", `lead-only row status="new" (got ${lead?.status})`, details) && ok;
    const [usr] = await db.select().from(usersTable).where(eq(usersTable.email, email.toLowerCase()));
    ok = assert(!usr, `lead-only step did NOT create user account`, details) && ok;
  }

  const r2 = await postJson(`${BASE}/api/public/apply`, {
    firstName: "PubFirst",
    lastName: "PubLast",
    email,
    phone: "5557654321",
    phoneCode: "+90",
    nationality: "Turkey",
    programId: progId,
    programName: "T135 Test Program",
    universityName: "T135 Test University",
    leadId,
    ...FULL,
  });
  ok = assert(r2.status === 201 || r2.status === 200, `public /apply success (got ${r2.status})`, details) && ok;

  if (leadId !== null) {
    const [leadAfter] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
    ok = assert(leadAfter?.status === "converted", `lead auto-converted to "converted" (got ${leadAfter?.status})`, details) && ok;
    ok = assert(!!leadAfter?.convertedStudentId, `lead.convertedStudentId set`, details) && ok;

    if (leadAfter?.convertedStudentId) {
      const [stu] = await db.select().from(studentsTable).where(eq(studentsTable.id, leadAfter.convertedStudentId));
      ok = assert(!!stu, `student row created`, details) && ok;
      if (stu) {
        ok = assert(stu.motherName === FULL.motherName, `student.motherName persisted`, details) && ok;
        ok = assert(stu.fatherName === FULL.fatherName, `student.fatherName persisted`, details) && ok;
        ok = assert(stu.gender === FULL.gender, `student.gender persisted`, details) && ok;
        ok = assert(stu.dateOfBirth === FULL.dateOfBirth, `student.dateOfBirth persisted`, details) && ok;
        ok = assert(stu.passportNumber === FULL.passportNumber, `student.passportNumber persisted`, details) && ok;
        ok = assert(stu.passportIssueDate === FULL.passportIssueDate, `student.passportIssueDate persisted`, details) && ok;
        ok = assert(stu.passportExpiry === FULL.passportExpiry, `student.passportExpiry persisted`, details) && ok;
        ok = assert(stu.address === FULL.address, `student.address persisted`, details) && ok;
        ok = assert(stu.highSchool === FULL.highSchool, `student.highSchool persisted`, details) && ok;
        ok = assert(stu.graduationYear === FULL.graduationYear, `student.graduationYear persisted`, details) && ok;
        ok = assert(stu.gpa === FULL.gpa, `student.gpa persisted`, details) && ok;
        ok = assert(stu.languageScore === FULL.languageScore, `student.languageScore persisted`, details) && ok;
      }
    }
  }

  return { name: "(b) Public-apply lead-first + full submit", ok, details };
}

/**
 * The embed /apply route lowercases gender and only accepts the two
 * canonical tokens; anything else is coerced to NULL on the student
 * row (see embed.ts ~L645 normalizedGender / safeGender). Frontend
 * mergeAiData layers do the same on the AI extraction path, so any
 * stray AI variant either lands as canonical or doesn't pollute the
 * column. We assert both halves: canonical/case variants persist
 * exactly, unknown values surface as NULL (never silently mis-mapped).
 */
async function runGenderNormalizationFlow(slug: string): Promise<Section> {
  const details: string[] = [];
  let ok = true;
  const variants: Array<{ input: string; expected: string | null; label: string }> = [
    { input: "female", expected: "female", label: "canonical female" },
    { input: "male",   expected: "male",   label: "canonical male" },
    { input: "Female", expected: "female", label: "Female title-case" },
    { input: "Male",   expected: "male",   label: "Male title-case" },
    { input: "FEMALE", expected: "female", label: "uppercase FEMALE" },
  ];
  for (const v of variants) {
    const email = `t135-gn-${RUN_ID}-${v.input}@test.local`;
    const r = await postJson(`${BASE}/api/public/embed/${slug}/apply`, {
      firstName: "GN", lastName: "Test", email,
      phone: "5550000000", countryCode: "+90",
      nationality: "Turkey", desiredLevel: "Bachelor",
      gender: v.input,
      passportNumber: `T135GN${v.label.replace(/\s/g, "").toUpperCase()}${Date.now().toString(36).slice(-4)}`,
    });
    ok = assert(r.status === 201, `apply with gender="${v.input}" (${v.label}) -> 201 (got ${r.status})`, details) && ok;
    const [u] = await db.select().from(usersTable).where(eq(usersTable.email, email.toLowerCase()));
    if (u) {
      const [stu] = await db.select().from(studentsTable).where(eq(studentsTable.userId, u.id));
      ok = assert(stu?.gender === v.expected, `gender "${v.input}" persisted as "${v.expected}" (got "${stu?.gender}")`, details) && ok;
    }
  }
  // Unknown variant: backend coerces to NULL rather than rejecting.
  const badEmail = `t135-gn-${RUN_ID}-bad@test.local`;
  const rBad = await postJson(`${BASE}/api/public/embed/${slug}/apply`, {
    firstName: "GN", lastName: "Bad", email: badEmail,
    phone: "5550000000", countryCode: "+90",
    nationality: "Turkey", desiredLevel: "Bachelor",
    gender: "Other",
    passportNumber: `T135GNBAD${Date.now().toString(36).slice(-4)}`,
  });
  ok = assert(rBad.status === 201, `apply with gender="Other" still succeeds (got ${rBad.status})`, details) && ok;
  const [uBad] = await db.select().from(usersTable).where(eq(usersTable.email, badEmail.toLowerCase()));
  if (uBad) {
    const [stuBad] = await db.select().from(studentsTable).where(eq(studentsTable.userId, uBad.id));
    ok = assert(stuBad?.gender === null, `unknown gender coerced to NULL (got "${stuBad?.gender}")`, details) && ok;
  }

  return { name: "(c) Gender normalization variants", ok, details };
}

/**
 * (d) Auto-convert disabled branch. Toggles
 * settings.autoConvertLeadEnabled to false, runs the embed
 * lead+apply pair, and asserts that the lead is NOT converted even
 * though the student row is still created (separate-bucket behavior
 * the task explicitly calls out). The setting is restored in the
 * finally block so subsequent runs and other tests are unaffected.
 */
async function runAutoConvertDisabledFlow(slug: string): Promise<Section> {
  const details: string[] = [];
  let ok = true;
  const email = `t135-noconv-${RUN_ID}@test.local`;

  const [origSettings] = await db.select().from(settingsTable);
  const original = origSettings?.autoConvertLeadEnabled;
  if (origSettings) {
    await db.update(settingsTable)
      .set({ autoConvertLeadEnabled: false })
      .where(eq(settingsTable.id, origSettings.id));
  } else {
    // No settings row exists yet — insert one with the toggle off so
    // the route's `!== false` check picks it up.
    await db.insert(settingsTable).values({ autoConvertLeadEnabled: false });
  }

  try {
    const r1 = await postJson(`${BASE}/api/public/embed/${slug}/lead`, {
      firstName: "NoConv",
      lastName: "Test",
      email,
      phone: "5559998888",
      countryCode: "+90",
    });
    const leadId = readNumber(r1.data, "leadId");
    ok = assert(r1.status === 201 && leadId !== null, `embed /lead returns 201 (got ${r1.status})`, details) && ok;

    const r2 = await postJson(`${BASE}/api/public/embed/${slug}/apply`, {
      firstName: "NoConv",
      lastName: "Test",
      email,
      phone: "5559998888",
      countryCode: "+90",
      nationality: "Turkey",
      desiredLevel: "Bachelor",
      leadId,
      passportNumber: `T135NC${Date.now().toString(36).slice(-5).toUpperCase()}`,
    });
    ok = assert(r2.status === 201, `embed /apply succeeds (got ${r2.status})`, details) && ok;

    if (leadId !== null) {
      const [leadAfter] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
      ok = assert(leadAfter?.status === "new", `auto-convert OFF: lead stays at status="new" (got ${leadAfter?.status})`, details) && ok;
      ok = assert(!leadAfter?.convertedStudentId, `auto-convert OFF: lead.convertedStudentId remains null (got ${leadAfter?.convertedStudentId})`, details) && ok;
    }

    // Student row is still created independently — the toggle only
    // controls the lead-side bucketing, not whether apply produces a
    // student/application pair.
    const [u] = await db.select().from(usersTable).where(eq(usersTable.email, email.toLowerCase()));
    ok = assert(!!u, `student user account still created when auto-convert is off`, details) && ok;
  } finally {
    if (origSettings) {
      await db.update(settingsTable)
        .set({ autoConvertLeadEnabled: original ?? true })
        .where(eq(settingsTable.id, origSettings.id));
    } else {
      // Best-effort restore: if we created the row, leave it at the
      // schema default (true) so the system reads as if untouched.
      const [seeded] = await db.select().from(settingsTable);
      if (seeded) {
        await db.update(settingsTable)
          .set({ autoConvertLeadEnabled: true })
          .where(eq(settingsTable.id, seeded.id));
      }
    }
  }

  return { name: "(d) Auto-convert disabled branch", ok, details };
}

/**
 * (e) UK national-trunk-0 phone flow.
 *
 * Verifies the end-to-end behavior introduced by the pn() trunk-0 fix:
 *   - Early-lead step stores the trunk-stripped phone in the phone column
 *     (not the trunk-retained pre-fix form)
 *   - Final /apply with a libphonenumber-valid UK number returns 201
 *     (no 422 phone.invalid)
 *   - The exact example from the task description (07700900000 + "+44"):
 *     phone column = "+447700900000", NOT "+4407700900000"
 *   - Step-1 leniency: missing/empty phone still produces 201 on /lead
 *
 * Note on 07700900000: this is a fictional Ofcom number that libphonenumber
 * does NOT consider valid, so phoneE164 is null and /apply would correctly
 * 422 it. The regression assertion is purely on the phone column value.
 * For the /apply success assertion we use 07911123456 (a valid UK mobile range).
 */
async function runUkPhoneFlow(slug: string): Promise<Section> {
  const details: string[] = [];
  let ok = true;

  // --- Sub-scenario A: task-example number (07700900000 + "+44") ---
  // Asserts phone column stores the trunk-stripped form "+447700900000",
  // not the old pre-fix form "+4407700900000". phoneE164 is null because
  // the 07700 range is fictional (libphonenumber-invalid).
  const emailA = `t135-ukphone-a-${RUN_ID}@test.local`;
  const rA = await postJson(`${BASE}/api/public/embed/${slug}/lead`, {
    firstName: "UkTaskEx",
    lastName: "Lead",
    email: emailA,
    phone: "07700900000",
    countryCode: "+44",
  });
  const leadIdA = readNumber(rA.data, "leadId");
  ok = assert(rA.status === 201 && leadIdA !== null, `07700 /lead returns 201 with leadId (got ${rA.status})`, details) && ok;
  if (leadIdA !== null) {
    const [leadA] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadIdA));
    ok = assert(!!leadA, "07700 lead row exists", details) && ok;
    if (leadA) {
      ok = assert(
        leadA.phone === "+447700900000",
        `07700 lead.phone stored as trunk-stripped "+447700900000" (got "${leadA.phone}")`,
        details,
      ) && ok;
      ok = assert(
        leadA.phone !== "+4407700900000",
        `07700 lead.phone NOT the old trunk-retained form "+4407700900000"`,
        details,
      ) && ok;
      // phoneE164 is null: 07700 is not a valid number in libphonenumber
      ok = assert(
        leadA.phoneE164 === null,
        `07700 lead.phoneE164 is null (fictional range, libphonenumber-invalid) (got "${leadA.phoneE164}")`,
        details,
      ) && ok;
    }
  }

  // --- Sub-scenario B: valid UK mobile (07911123456 + "+44") ---
  // Uses a libphonenumber-verified valid range so both phone and phoneE164
  // store clean E.164, and /apply returns 201 (not 422 phone.invalid).
  const email = `t135-ukphone-${RUN_ID}@test.local`;
  const UK_PHONE_RAW = "07911123456";
  const UK_DIAL = "+44";
  const UK_E164 = "+447911123456";

  const r1 = await postJson(`${BASE}/api/public/embed/${slug}/lead`, {
    firstName: "UkFirst",
    lastName: "UkLast",
    email,
    phone: UK_PHONE_RAW,
    countryCode: UK_DIAL,
  });
  const leadId = readNumber(r1.data, "leadId");
  ok = assert(r1.status === 201 && leadId !== null, `UK /lead returns 201 with leadId (got ${r1.status})`, details) && ok;

  if (leadId !== null) {
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
    ok = assert(!!lead, "lead row exists", details) && ok;
    if (lead) {
      ok = assert(
        lead.phone === UK_E164,
        `lead.phone stored as trunk-stripped E.164 "${UK_E164}" (got "${lead.phone}")`,
        details,
      ) && ok;
      ok = assert(
        lead.phoneE164 === UK_E164,
        `lead.phoneE164 stored as "${UK_E164}" (got "${lead.phoneE164}")`,
        details,
      ) && ok;
      ok = assert(
        lead.phone !== "+4407911123456",
        `lead.phone is NOT the old trunk-retained form "+4407911123456"`,
        details,
      ) && ok;
    }
  }

  const r2 = await postJson(`${BASE}/api/public/embed/${slug}/apply`, {
    firstName: "UkFirst",
    lastName: "UkLast",
    email,
    phone: UK_PHONE_RAW,
    countryCode: UK_DIAL,
    nationality: "United Kingdom",
    desiredLevel: "Bachelor",
    leadId,
    passportNumber: `T135UK${Date.now().toString(36).slice(-5).toUpperCase()}`,
  });
  ok = assert(
    r2.status === 201,
    `/apply with UK national phone returns 201, not 422 phone.invalid (got ${r2.status})`,
    details,
  ) && ok;
  if (r2.status === 422 && (r2.data as any)?.code === "phone.invalid") {
    details.push("  => phone.invalid 422 means trunk-0 was NOT stripped — regression detected");
  }

  // Step 3: leniency — missing phone on /lead still returns 201.
  const emailNoPhone = `t135-ukphone-noph-${RUN_ID}@test.local`;
  const r3 = await postJson(`${BASE}/api/public/embed/${slug}/lead`, {
    firstName: "NoPhone",
    lastName: "Lead",
    email: emailNoPhone,
    // phone intentionally omitted
  });
  ok = assert(r3.status === 201, `/lead without phone returns 201 (got ${r3.status}) — leniency preserved`, details) && ok;

  // Step 4: leniency — empty-string phone on /lead still returns 201.
  const emailEmptyPhone = `t135-ukphone-emph-${RUN_ID}@test.local`;
  const r4 = await postJson(`${BASE}/api/public/embed/${slug}/lead`, {
    firstName: "EmptyPhone",
    lastName: "Lead",
    email: emailEmptyPhone,
    phone: "",
    countryCode: "+44",
  });
  ok = assert(r4.status === 201, `/lead with empty phone returns 201 (got ${r4.status}) — leniency preserved`, details) && ok;

  return { name: "(e) UK trunk-0 phone: early-lead stores clean E.164, /apply succeeds, leniency intact", ok, details };
}

async function waitForServer(): Promise<boolean> {
  for (let i = 0; i < 15; i++) {
    try {
      const r = await fetch(`${BASE}/api/public/embed/__nope__/config`);
      if (r.status === 404 || r.status === 200) return true;
    } catch {
      // Server still booting / unreachable — retry.
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

async function main() {
  console.log(`[t135] starting run ${RUN_ID} against ${BASE}`);
  const ready = await waitForServer();
  if (!ready) {
    console.error(`[t135] api-server at ${BASE} did not respond — start it before running this script.`);
    process.exit(2);
  }

  const fx = await setupFixtures();
  const usedEmails: string[] = [
    `t135-embed-${RUN_ID}@test.local`,
    `t135-pub-${RUN_ID}@test.local`,
    `t135-gn-${RUN_ID}-female@test.local`,
    `t135-gn-${RUN_ID}-male@test.local`,
    `t135-gn-${RUN_ID}-Female@test.local`,
    `t135-gn-${RUN_ID}-Male@test.local`,
    `t135-gn-${RUN_ID}-FEMALE@test.local`,
    `t135-gn-${RUN_ID}-bad@test.local`,
    `t135-noconv-${RUN_ID}@test.local`,
    `t135-ukphone-a-${RUN_ID}@test.local`,
    `t135-ukphone-${RUN_ID}@test.local`,
    `t135-ukphone-noph-${RUN_ID}@test.local`,
    `t135-ukphone-emph-${RUN_ID}@test.local`,
  ];
  const sections: Section[] = [];
  try {
    sections.push(await runEmbedFlow(fx.slug));
    sections.push(await runPublicApplyFlow(fx.progId));
    sections.push(await runGenderNormalizationFlow(fx.slug));
    sections.push(await runAutoConvertDisabledFlow(fx.slug));
    sections.push(await runUkPhoneFlow(fx.slug));
  } finally {
    await teardownFixtures(fx, usedEmails);
  }

  let allOk = true;
  for (const s of sections) {
    console.log(`\n=== ${s.name} ${s.ok ? "PASS" : "FAIL"} ===`);
    for (const d of s.details) console.log(`  ${d}`);
    if (!s.ok) allOk = false;
  }
  console.log(`\n[t135] ${allOk ? "PASS" : "FAIL"} (run ${RUN_ID})`);
  process.exit(allOk ? 0 : 1);
}

main().catch(err => {
  console.error(`[t135] crashed:`, err);
  process.exit(2);
});
