/**
 * Doc-equivalence + apply-reuse test suite.
 *
 * Locks down the invariants for Task #92 (skip re-uploading docs the student
 * already has when applying again):
 *
 *   (a) Pure-unit checks of the @workspace/doc-equivalence helpers:
 *         - apply-form short keys (e.g. "hs_diploma") and their canonical
 *           types (e.g. "class_12th_hsc_certificate") collapse to the same
 *           equivalence group.
 *         - findMissingMandatoryTypes treats equivalent uploads as covering
 *           the mandatory canonical type.
 *
 *   (b) POST /public/apply with an existing student email and an empty
 *       reuseDocumentIds + no fresh documents auto-links the student's
 *       on-file canonical docs to the new application when both apps are at
 *       the same level (bachelors -> bachelors).
 *
 *   (c) Same flow but bachelors -> masters auto-links only docs whose
 *       equivalence group is required by the masters level (passport,
 *       bachelors_certificate, bachelors_transcript) and skips docs that
 *       are not (e.g. class_10th_ssc_marks_sheet only required for
 *       pre_bachelors/others would be skipped at bachelors-level too — we
 *       assert by type set, not by hard-coded counts).
 *
 *   (d) The same-equivalence dedup means docs already uploaded in the apply
 *       payload (e.g. fresh "passport") suppress a duplicate auto-link of
 *       the equivalent canonical "passport".
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:doc-equivalence
 *   # or:
 *   pnpm --filter @workspace/api-server exec tsx ./scripts/test-doc-equivalence.ts
 */
import http from "http";
import express, { type Express } from "express";
import { and, eq, inArray, like } from "drizzle-orm";
import {
  db,
  usersTable,
  studentsTable,
  applicationsTable,
  documentsTable,
  programsTable,
  universitiesTable,
} from "@workspace/db";

import {
  getDocEquivalenceGroup,
  areEquivalentDocTypes,
  findEquivalentDoc,
  findMissingMandatoryTypes,
  getEquivalentCanonicalTypes,
} from "@workspace/doc-equivalence";

import publicApplyRouter, { enableTestModeBypass } from "../src/routes/public-apply";
import { ensureRateLimitsTable } from "../src/lib/pgRateLimiter";

const RUN_ID = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

interface Section {
  name: string;
  ok: boolean;
  details: string[];
}

function assert(cond: boolean, msg: string, details: string[]): boolean {
  details.push(`${cond ? "OK   " : "FAIL "} ${msg}`);
  return cond;
}

// ---------------------------------------------------------------------------
// (a) Pure unit checks for equivalence helpers
// ---------------------------------------------------------------------------

function testEquivalenceUnits(): Section {
  const details: string[] = [];
  let ok = true;

  ok = assert(
    getDocEquivalenceGroup("passport") === "passport",
    "getDocEquivalenceGroup('passport') -> 'passport'",
    details,
  ) && ok;
  ok = assert(
    getDocEquivalenceGroup("PASSPORT") === "passport",
    "getDocEquivalenceGroup is case-insensitive",
    details,
  ) && ok;
  ok = assert(
    getDocEquivalenceGroup("not_a_real_doctype_xyz") === null,
    "Unknown type returns null",
    details,
  ) && ok;
  ok = assert(
    getDocEquivalenceGroup(null) === null && getDocEquivalenceGroup(undefined) === null,
    "Null/undefined returns null",
    details,
  ) && ok;

  // High-school: apply key short form vs canonical types
  ok = assert(
    areEquivalentDocTypes("hs_diploma", "class_12th_hsc_certificate"),
    "hs_diploma ≡ class_12th_hsc_certificate",
    details,
  ) && ok;
  ok = assert(
    areEquivalentDocTypes("hs_diploma", "high_school_diploma_translation"),
    "hs_diploma ≡ high_school_diploma_translation",
    details,
  ) && ok;
  ok = assert(
    areEquivalentDocTypes("hs_transcript", "class_12th_hsc_marks_sheet"),
    "hs_transcript ≡ class_12th_hsc_marks_sheet",
    details,
  ) && ok;
  ok = assert(
    areEquivalentDocTypes("hs_diploma", "diploma_certificate"),
    "public hs_diploma ≡ catalog diploma_certificate",
    details,
  ) && ok;
  ok = assert(
    areEquivalentDocTypes("hs_transcript", "diploma_transcript"),
    "public hs_transcript ≡ catalog diploma_transcript",
    details,
  ) && ok;

  // Bachelor's
  ok = assert(
    areEquivalentDocTypes("bachelor_diploma", "bachelors_certificate"),
    "bachelor_diploma ≡ bachelors_certificate",
    details,
  ) && ok;
  ok = assert(
    areEquivalentDocTypes("bachelor_diploma", "bachelors_provisional_certificate"),
    "bachelor_diploma ≡ bachelors_provisional_certificate",
    details,
  ) && ok;
  ok = assert(
    areEquivalentDocTypes("bachelor_transcript", "bachelors_transcript"),
    "bachelor_transcript ≡ bachelors_transcript",
    details,
  ) && ok;
  ok = assert(
    areEquivalentDocTypes("bachelor_transcript", "bachelors_transcript_all_semesters"),
    "bachelor_transcript ≡ bachelors_transcript_all_semesters",
    details,
  ) && ok;

  // Master's
  ok = assert(
    areEquivalentDocTypes("master_diploma", "masters_certificate"),
    "master_diploma ≡ masters_certificate",
    details,
  ) && ok;
  ok = assert(
    areEquivalentDocTypes("master_transcript", "masters_transcript_all_semesters"),
    "master_transcript ≡ masters_transcript_all_semesters",
    details,
  ) && ok;

  // Equivalency / language proof
  ok = assert(
    areEquivalentDocTypes("equivalency_letter", "diploma_recognition"),
    "equivalency_letter ≡ diploma_recognition",
    details,
  ) && ok;
  ok = assert(
    areEquivalentDocTypes("language_proof", "ielts_pte_gre_gmat_toefl_duolingo"),
    "language_proof ≡ ielts_pte_gre_gmat_toefl_duolingo",
    details,
  ) && ok;

  // Negative
  ok = assert(
    !areEquivalentDocTypes("passport", "photo"),
    "passport ≢ photo",
    details,
  ) && ok;
  ok = assert(
    !areEquivalentDocTypes("hs_diploma", "bachelors_certificate"),
    "hs_diploma ≢ bachelors_certificate",
    details,
  ) && ok;

  // findEquivalentDoc on a mixed library
  const lib = [
    { id: 1, type: "class_12th_hsc_certificate" },
    { id: 2, type: "bachelors_certificate" },
    { id: 3, type: "passport" },
    { id: 4, type: "photo" },
  ];
  const hsHit = findEquivalentDoc("hs_diploma", lib);
  ok = assert(hsHit?.id === 1, "findEquivalentDoc('hs_diploma') -> canonical hs cert", details) && ok;
  const bdHit = findEquivalentDoc("bachelor_diploma", lib);
  ok = assert(bdHit?.id === 2, "findEquivalentDoc('bachelor_diploma') -> bachelors_certificate", details) && ok;
  const photoHit = findEquivalentDoc("photo", lib);
  ok = assert(photoHit?.id === 4, "findEquivalentDoc('photo') -> photo", details) && ok;
  const missHit = findEquivalentDoc("master_diploma", lib);
  ok = assert(missHit === null, "findEquivalentDoc('master_diploma') on lib without one -> null", details) && ok;

  // findMissingMandatoryTypes — uploaded apply-key satisfies canonical mandatory
  const mandatory = ["passport", "class_12th_hsc_certificate", "bachelors_certificate"];
  const uploaded = new Set(["passport", "hs_diploma", "bachelor_diploma"]);
  const missing = findMissingMandatoryTypes(mandatory, uploaded);
  ok = assert(
    missing.length === 0,
    `findMissingMandatoryTypes covers all via equivalence (got [${missing.join(",")}])`,
    details,
  ) && ok;

  const partial = findMissingMandatoryTypes(mandatory, new Set(["passport"]));
  ok = assert(
    partial.length === 2 &&
      partial.includes("class_12th_hsc_certificate") &&
      partial.includes("bachelors_certificate"),
    `Partial coverage reports correct missing canonical types (got [${partial.join(",")}])`,
    details,
  ) && ok;

  const canonHs = getEquivalentCanonicalTypes("hs_diploma");
  ok = assert(
    canonHs.includes("class_12th_hsc_certificate") &&
      canonHs.includes("high_school_diploma_translation") &&
      canonHs.includes("diploma_certificate"),
    `getEquivalentCanonicalTypes('hs_diploma') includes all hs canonicals (got [${canonHs.join(",")}])`,
    details,
  ) && ok;

  return { name: "(a) Equivalence helpers (pure)", ok, details };
}

// ---------------------------------------------------------------------------
// (a2) Cross-level / cross-university reconciliation (Task #286)
//
// When an admin adds a NEW application for a student who already has documents
// (uploaded for a different program, university, or level), the backend
// reduces the configured document-request list to only the docs the student
// is genuinely missing — matched via equivalence, regardless of which program
// or level the existing docs were uploaded for. These pure-unit checks mirror
// the server-side `findMissingMandatoryTypes` reduction used by the
// DOC_SELECTION_REQUIRED / STUDENT_DOCS_REQUIRED paths in applications.ts.
// ---------------------------------------------------------------------------

function testCrossLevelReconciliation(): Section {
  const details: string[] = [];
  let ok = true;

  // A student's on-file library — docs were uploaded once (any program/uni).
  // Mixed apply-key + canonical forms, as can happen across upload paths.
  const studentLibrary = new Set([
    "passport",
    "photo",
    "bachelor_diploma",          // apply key ≡ bachelors_certificate
    "bachelors_transcript",      // canonical
    "class_12th_hsc_certificate", // canonical hs cert
  ]);

  // Cross-university: two DIFFERENT programs/universities require the same
  // canonical type. One existing equivalent upload satisfies BOTH — the
  // reconciliation is program/university-agnostic (groups by canonical type).
  const programA_required = ["passport", "bachelors_certificate"];
  const programB_required = ["passport", "bachelors_certificate"]; // different uni, same req
  ok = assert(
    findMissingMandatoryTypes(programA_required, studentLibrary).length === 0,
    "Cross-university: program A's passport+bachelors_certificate already satisfied",
    details,
  ) && ok;
  ok = assert(
    findMissingMandatoryTypes(programB_required, studentLibrary).length === 0,
    "Cross-university: program B (different uni) same reqs also satisfied by one upload",
    details,
  ) && ok;

  // Cross-level: a new MASTERS program requires bachelor-level docs the student
  // uploaded for an earlier BACHELORS application — satisfied via equivalence,
  // even though the stored type strings differ (apply key vs canonical).
  const mastersRequired = [
    "passport",
    "bachelors_certificate",
    "bachelors_transcript",
  ];
  ok = assert(
    findMissingMandatoryTypes(mastersRequired, studentLibrary).length === 0,
    "Cross-level: masters bachelor-doc requirements satisfied by prior bachelors uploads",
    details,
  ) && ok;

  // Only-the-extra: the new program requires something the student does NOT
  // have (masters_certificate) plus docs they do have. Reconciliation must
  // return ONLY the genuinely-missing extra, preserving the configured string.
  const phdRequired = [
    "passport",
    "bachelors_certificate",
    "masters_certificate", // student has no masters docs
  ];
  const phdMissing = findMissingMandatoryTypes(phdRequired, studentLibrary);
  ok = assert(
    phdMissing.length === 1 && phdMissing[0] === "masters_certificate",
    `Only the genuinely-missing extra is requested (got [${phdMissing.join(",")}])`,
    details,
  ) && ok;

  // All-satisfied: when every configured doc is already on file (directly or
  // via equivalence), reconciliation yields an empty list — the server then
  // skips the request prompt entirely and lets the move proceed.
  const allSatisfied = findMissingMandatoryTypes(
    ["passport", "photo", "bachelor_diploma", "class_12th_hsc_certificate"],
    studentLibrary,
  );
  ok = assert(
    allSatisfied.length === 0,
    `All configured docs already on file -> empty (got [${allSatisfied.join(",")}])`,
    details,
  ) && ok;

  // Unknown / custom catalog types (not in any equivalence group) fall back to
  // exact case-insensitive matching and are reported missing when absent.
  const withCustom = findMissingMandatoryTypes(
    ["passport", "some_custom_doc"],
    studentLibrary,
  );
  ok = assert(
    withCustom.length === 1 && withCustom[0] === "some_custom_doc",
    `Unknown/custom type with no equivalent reported missing (got [${withCustom.join(",")}])`,
    details,
  ) && ok;

  return { name: "(a2) Cross-level/cross-university reconciliation (Task #286)", ok, details };
}

// ---------------------------------------------------------------------------
// Shared ephemeral Express server hosting the public-apply router
// ---------------------------------------------------------------------------

interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

function startApplyServer(): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const app: Express = express();
    app.use(express.json({ limit: "20mb" }));
    // Public-apply router mounts its routes at the root; mount at /api here
    // so paths look like the real server (`/api/public/apply`).
    app.use("/api", publicApplyRouter);
    const server = http.createServer(app);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("server.address() did not return an AddressInfo"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function ensureTestUniversityAndPrograms(suffix: string): Promise<{
  bachelorsProgramId: number;
  mastersProgramId: number;
  universityId: number;
}> {
  const uniName = `Test University ${suffix}`;
  const [uni] = await db.insert(universitiesTable).values({
    name: uniName,
    country: "Turkey",
    city: "Istanbul",
    type: "private",
  }).returning();

  const [bach] = await db.insert(programsTable).values({
    universityId: uni.id,
    name: `BSc Test ${suffix}`,
    degree: "Bachelors",
    field: "Engineering",
    language: "English",
    tuitionFee: 1000,
    currency: "USD",
  }).returning();

  const [mast] = await db.insert(programsTable).values({
    universityId: uni.id,
    name: `MSc Test ${suffix}`,
    degree: "Masters",
    field: "Engineering",
    language: "English",
    tuitionFee: 2000,
    currency: "USD",
  }).returning();

  return {
    bachelorsProgramId: bach.id,
    mastersProgramId: mast.id,
    universityId: uni.id,
  };
}

interface SeededStudent {
  userId: number;
  studentId: number;
  email: string;
  prevAppId: number;
  seededDocIds: number[];
}

async function seedExistingBachelorsStudent(suffix: string): Promise<SeededStudent> {
  const email = `eq_test_${suffix}@example.com`.toLowerCase();
  const [user] = await db.insert(usersTable).values({
    email,
    firstName: "Eq",
    lastName: `Test_${suffix}`,
    phone: "+10000000000",
    role: "student",
    isActive: true,
    emailVerified: true,
    language: "en",
  }).returning();

  const [student] = await db.insert(studentsTable).values({
    userId: user.id,
    firstName: "Eq",
    lastName: `Test_${suffix}`,
    email,
    phone: "+10000000000",
    nationality: "Turkey",
    motherName: "Eq Mother",
    fatherName: "Eq Father",
  }).returning();

  // A previous bachelors application that the docs were uploaded for.
  const [prevApp] = await db.insert(applicationsTable).values({
    studentId: student.id,
    universityName: "Prior Uni",
    programName: "BSc Prior",
    level: "Bachelors",
    stage: "draft",
  }).returning();

  // Seed docs under canonical types (the form student-portal uploads use).
  const docTypes = [
    "passport",
    "photo",
    "class_12th_hsc_certificate",
    "class_12th_hsc_marks_sheet",
    "bachelors_certificate",
    "bachelors_transcript",
  ];
  const seededDocIds: number[] = [];
  for (const t of docTypes) {
    const [d] = await db.insert(documentsTable).values({
      studentId: student.id,
      applicationId: prevApp.id,
      name: `${t}-${suffix}.pdf`,
      type: t,
      status: "approved",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      fileData: "JVBERi0xLjQK", // dummy "%PDF-1.4\n" base64
    }).returning({ id: documentsTable.id });
    seededDocIds.push(d.id);
  }

  return {
    userId: user.id,
    studentId: student.id,
    email,
    prevAppId: prevApp.id,
    seededDocIds,
  };
}

async function getNewlyLinkedDocTypes(
  studentId: number,
  excludedAppIds: number[],
): Promise<{ appId: number | null; types: string[] }> {
  const docs = await db.select({
    id: documentsTable.id,
    appId: documentsTable.applicationId,
    type: documentsTable.type,
  }).from(documentsTable).where(eq(documentsTable.studentId, studentId));
  const newDocs = docs.filter(d => d.appId != null && !excludedAppIds.includes(d.appId));
  if (newDocs.length === 0) return { appId: null, types: [] };
  const appId = newDocs[0].appId!;
  const types = newDocs.filter(d => d.appId === appId).map(d => String(d.type || ""));
  return { appId, types };
}

// ---------------------------------------------------------------------------
// (b) Same-level: bachelors -> bachelors auto-links full doc set
// (c) Cross-level: bachelors -> masters auto-links only equivalent docs
// ---------------------------------------------------------------------------

async function testReuseSameLevel(serverUrl: string): Promise<Section> {
  const details: string[] = [];
  let ok = true;
  const suffix = `same_${RUN_ID}`;
  const cleanupUserIds: number[] = [];
  const cleanupStudentIds: number[] = [];
  const cleanupUniIds: number[] = [];
  const cleanupProgramIds: number[] = [];
  try {
    const { bachelorsProgramId, universityId } = await ensureTestUniversityAndPrograms(suffix);
    cleanupUniIds.push(universityId);
    cleanupProgramIds.push(bachelorsProgramId);
    const seed = await seedExistingBachelorsStudent(suffix);
    cleanupUserIds.push(seed.userId);
    cleanupStudentIds.push(seed.studentId);

    const res = await fetch(`${serverUrl}/api/public/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: "Eq",
        lastName: `Test_${suffix}`,
        email: seed.email,
        phone: "1234567890",
        phoneCode: "+1",
        nationality: "Turkey",
        gender: "male",
        motherName: "Eq Mother",
        fatherName: "Eq Father",
        programId: bachelorsProgramId,
        programName: `BSc Test ${suffix}`,
        universityName: `Test University ${suffix}`,
        // Critically: empty reuseDocumentIds + no documents — server should
        // still auto-link the student's existing on-file docs.
        reuseDocumentIds: [],
        documents: [],
      }),
    });
    ok = assert(res.status === 201, `POST /public/apply returns 201 (got ${res.status})`, details) && ok;

    const linked = await getNewlyLinkedDocTypes(seed.studentId, [seed.prevAppId]);
    ok = assert(linked.appId !== null, `New application created (got id ${linked.appId})`, details) && ok;
    const set = new Set(linked.types);
    // The bachelors apply form needs passport, photo, and the high-school
    // docs. The student's seeded bachelor-degree docs are NOT relevant for
    // a bachelors APPLICATION (they're relevant for masters/phd) so they
    // should be skipped.
    for (const expected of [
      "passport",
      "photo",
      "class_12th_hsc_certificate",
      "class_12th_hsc_marks_sheet",
    ]) {
      ok = assert(
        set.has(expected),
        `Same-level reuse linked ${expected} (got [${[...set].join(",")}])`,
        details,
      ) && ok;
    }
    for (const irrelevant of ["bachelors_certificate", "bachelors_transcript"]) {
      ok = assert(
        !set.has(irrelevant),
        `Same-level reuse skipped ${irrelevant} not relevant at bachelors apply (got [${[...set].join(",")}])`,
        details,
      ) && ok;
    }
    // No equivalence collisions — exactly one doc per equivalence group.
    const groups = linked.types
      .map(t => getDocEquivalenceGroup(t))
      .filter((g): g is Exclude<typeof g, null> => g !== null);
    const uniqueGroups = new Set(groups);
    ok = assert(
      groups.length === uniqueGroups.size,
      `No duplicate equivalence groups linked (groups: [${groups.join(",")}])`,
      details,
    ) && ok;
  } catch (e) {
    ok = false;
    details.push(`FAIL unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await cleanup(cleanupUserIds, cleanupStudentIds, cleanupProgramIds, cleanupUniIds, details);
  }
  return { name: "(b) bachelors->bachelors auto-link with empty reuseDocumentIds", ok, details };
}

async function testReuseCrossLevel(serverUrl: string): Promise<Section> {
  const details: string[] = [];
  let ok = true;
  const suffix = `cross_${RUN_ID}`;
  const cleanupUserIds: number[] = [];
  const cleanupStudentIds: number[] = [];
  const cleanupUniIds: number[] = [];
  const cleanupProgramIds: number[] = [];
  try {
    const { bachelorsProgramId, mastersProgramId, universityId } =
      await ensureTestUniversityAndPrograms(suffix);
    cleanupUniIds.push(universityId);
    cleanupProgramIds.push(bachelorsProgramId, mastersProgramId);
    const seed = await seedExistingBachelorsStudent(suffix);
    cleanupUserIds.push(seed.userId);
    cleanupStudentIds.push(seed.studentId);

    const res = await fetch(`${serverUrl}/api/public/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: "Eq",
        lastName: `Test_${suffix}`,
        email: seed.email,
        phone: "1234567890",
        phoneCode: "+1",
        nationality: "Turkey",
        gender: "male",
        motherName: "Eq Mother",
        fatherName: "Eq Father",
        programId: mastersProgramId,
        programName: `MSc Test ${suffix}`,
        universityName: `Test University ${suffix}`,
        reuseDocumentIds: [],
        documents: [],
      }),
    });
    ok = assert(res.status === 201, `POST /public/apply returns 201 (got ${res.status})`, details) && ok;

    const linked = await getNewlyLinkedDocTypes(seed.studentId, [seed.prevAppId]);
    ok = assert(linked.appId !== null, `New masters application created (got id ${linked.appId})`, details) && ok;
    const set = new Set(linked.types);

    // Masters seed (per seedDocumentRequirements):
    //   passport (mandatory all levels), bachelors_certificate (mandatory),
    //   bachelors_transcript (mandatory), bachelors_transcript_all_semesters
    //   (enabled), other_certificates_documents (enabled),
    //   ielts_pte_gre_gmat_toefl_duolingo (enabled), sop (enabled)
    //
    // High-school docs are NOT enabled at the masters level, so the
    // auto-linker should skip them.
    for (const expected of ["passport", "bachelors_certificate", "bachelors_transcript"]) {
      ok = assert(
        set.has(expected),
        `Cross-level masters linked ${expected} (got [${[...set].join(",")}])`,
        details,
      ) && ok;
    }
    for (const skipped of [
      "class_12th_hsc_certificate",
      "class_12th_hsc_marks_sheet",
    ]) {
      ok = assert(
        !set.has(skipped),
        `Cross-level masters did NOT link ${skipped} (got [${[...set].join(",")}])`,
        details,
      ) && ok;
    }
  } catch (e) {
    ok = false;
    details.push(`FAIL unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await cleanup(cleanupUserIds, cleanupStudentIds, cleanupProgramIds, cleanupUniIds, details);
  }
  return { name: "(c) bachelors->masters auto-link only required equivalence groups", ok, details };
}

async function testFreshUploadSuppressesEquivalentReuse(
  serverUrl: string,
): Promise<Section> {
  const details: string[] = [];
  let ok = true;
  const suffix = `fresh_${RUN_ID}`;
  const cleanupUserIds: number[] = [];
  const cleanupStudentIds: number[] = [];
  const cleanupUniIds: number[] = [];
  const cleanupProgramIds: number[] = [];
  try {
    const { bachelorsProgramId, universityId } = await ensureTestUniversityAndPrograms(suffix);
    cleanupUniIds.push(universityId);
    cleanupProgramIds.push(bachelorsProgramId);
    const seed = await seedExistingBachelorsStudent(suffix);
    cleanupUserIds.push(seed.userId);
    cleanupStudentIds.push(seed.studentId);

    // Client uploads a fresh "passport" (apply key) — server should NOT
    // also auto-link the equivalent canonical "passport" from the library
    // (would result in two passport docs on the same app).
    const res = await fetch(`${serverUrl}/api/public/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: "Eq",
        lastName: `Test_${suffix}`,
        email: seed.email,
        phone: "1234567890",
        phoneCode: "+1",
        nationality: "Turkey",
        gender: "male",
        motherName: "Eq Mother",
        fatherName: "Eq Father",
        programId: bachelorsProgramId,
        programName: `BSc Test ${suffix}`,
        universityName: `Test University ${suffix}`,
        reuseDocumentIds: [],
        documents: [
          {
            key: "passport",
            label: "Passport",
            name: "fresh-passport.pdf",
            mediaType: "application/pdf",
            base64: "JVBERi0xLjQK",
            sizeBytes: 1024,
          },
        ],
      }),
    });
    ok = assert(res.status === 201, `POST /public/apply returns 201 (got ${res.status})`, details) && ok;

    const linked = await getNewlyLinkedDocTypes(seed.studentId, [seed.prevAppId]);
    ok = assert(linked.appId !== null, `New application created (got id ${linked.appId})`, details) && ok;
    const passportCount = linked.types.filter(t =>
      getDocEquivalenceGroup(t) === "passport",
    ).length;
    ok = assert(
      passportCount === 1,
      `Exactly one passport-group doc linked (got ${passportCount}: [${linked.types.join(",")}])`,
      details,
    ) && ok;
    // Other relevant equivalence groups should still auto-link from the
    // student's library — bachelors apply form needs hs_certificate and
    // photo, both of which the student already has on file.
    const set = new Set(linked.types);
    ok = assert(
      set.has("class_12th_hsc_certificate"),
      `Other relevant groups still auto-link (hs_certificate present, got [${[...set].join(",")}])`,
      details,
    ) && ok;
    ok = assert(
      set.has("photo"),
      `Other relevant groups still auto-link (photo present, got [${[...set].join(",")}])`,
      details,
    ) && ok;
  } catch (e) {
    ok = false;
    details.push(`FAIL unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await cleanup(cleanupUserIds, cleanupStudentIds, cleanupProgramIds, cleanupUniIds, details);
  }
  return { name: "(d) Fresh apply-key upload suppresses equivalent canonical auto-link", ok, details };
}

async function cleanup(
  userIds: number[],
  studentIds: number[],
  programIds: number[],
  uniIds: number[],
  details: string[],
): Promise<void> {
  try {
    if (studentIds.length > 0) {
      await db.delete(documentsTable).where(inArray(documentsTable.studentId, studentIds));
      await db.delete(applicationsTable).where(inArray(applicationsTable.studentId, studentIds));
      await db.delete(studentsTable).where(inArray(studentsTable.id, studentIds));
    }
    if (userIds.length > 0) {
      await db.delete(usersTable).where(inArray(usersTable.id, userIds));
    }
    if (programIds.length > 0) {
      await db.delete(programsTable).where(inArray(programsTable.id, programIds));
    }
    if (uniIds.length > 0) {
      await db.delete(universitiesTable).where(inArray(universitiesTable.id, uniIds));
    }
  } catch (cleanupErr) {
    details.push(
      `WARN cleanup error (non-fatal): ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`[doc-equivalence] starting run ${RUN_ID}`);

  // Pre-cleanup any stragglers from a previous interrupted run with our
  // test email pattern, so the test is idempotent.
  try {
    const stragglers = await db.select({ id: usersTable.id })
      .from(usersTable)
      .where(like(usersTable.email, "eq_test_%@example.com"));
    if (stragglers.length > 0) {
      const ids = stragglers.map(s => s.id);
      const stuRows = await db.select({ id: studentsTable.id })
        .from(studentsTable)
        .where(inArray(studentsTable.userId, ids));
      const stuIds = stuRows.map(r => r.id);
      if (stuIds.length > 0) {
        await db.delete(documentsTable).where(inArray(documentsTable.studentId, stuIds));
        await db.delete(applicationsTable).where(inArray(applicationsTable.studentId, stuIds));
        await db.delete(studentsTable).where(inArray(studentsTable.id, stuIds));
      }
      await db.delete(usersTable).where(inArray(usersTable.id, ids));
    }
    const stragglerUnis = await db.select({ id: universitiesTable.id })
      .from(universitiesTable)
      .where(like(universitiesTable.name, "Test University %"));
    if (stragglerUnis.length > 0) {
      const uniIds = stragglerUnis.map(u => u.id);
      await db.delete(programsTable).where(inArray(programsTable.universityId, uniIds));
      await db.delete(universitiesTable).where(inArray(universitiesTable.id, uniIds));
    }
  } catch (e) {
    console.warn("[doc-equivalence] pre-cleanup warning:", e);
  }

  // Ensure rate limiting is bypassed for in-process test server.
  process.env.NODE_ENV = "test";
  // Enable the ACCOUNT_CONFLICT bypass so doc-equivalence HTTP suites (b)(c)(d)
  // can re-apply on existing student accounts.  This is wired explicitly here
  // rather than via NODE_ENV so it never fires in a production server.
  enableTestModeBypass();

  await ensureRateLimitsTable();

  const sections: Section[] = [];
  sections.push(testEquivalenceUnits());
  sections.push(testCrossLevelReconciliation());

  // HTTP integration tests (b)(c)(d): start an in-process Express server
  // backed by the real publicApplyRouter (and real DB) so we validate the
  // full apply → doc-link → mandatory-gate pipeline end-to-end.
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/api", publicApplyRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const serverUrl = `http://127.0.0.1:${port}`;

  sections.push(await testReuseSameLevel(serverUrl));
  sections.push(await testReuseCrossLevel(serverUrl));
  sections.push(await testFreshUploadSuppressesEquivalentReuse(serverUrl));

  await new Promise<void>((resolve) => server.close(() => resolve()));

  let allOk = true;
  for (const s of sections) {
    console.log(`\n=== ${s.name} ${s.ok ? "PASS" : "FAIL"} ===`);
    for (const d of s.details) console.log("  " + d);
    if (!s.ok) allOk = false;
  }
  console.log(`\n[doc-equivalence] ${allOk ? "PASS" : "FAIL"} (run ${RUN_ID})`);
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("[doc-equivalence] unexpected error:", err);
  process.exit(1);
});
