import assert from "node:assert/strict";
import test from "node:test";
import {
  findMatchingMulticoApplication,
  normalizeMulticoGpaSystem,
} from "../src/universities/multico/adapter.js";
import {
  chooseOkanProgramIndex,
  resolveOkanDegreeValue,
} from "../src/universities/okan/adapter.js";
import {
  findUnitedProfileHrefByExternalRef,
  findUniqueUnitedTargetApplication,
  hasExactUnitedUniversityCard,
  parseUnitedProfileUploadKey,
  resolveUnitedDegreeLabel,
  resolveUnitedDocumentSlots,
  resolveUnitedProfileLookupAction,
  resolveUnitedProfileDocumentKeys,
  resolveUnitedProgramOption,
  resolveUnitedUniversityLabel,
  resolveUnitedUniversityOption,
} from "../src/universities/united/adapter.js";

test("United uses exact live degree-card labels", () => {
  assert.equal(resolveUnitedDegreeLabel("Associate"), "Vocational School");
  assert.equal(resolveUnitedDegreeLabel("Bachelor"), "Bachelor");
  assert.equal(resolveUnitedDegreeLabel("Master"), "Master");
  assert.equal(resolveUnitedDegreeLabel("PhD"), "PhD");
  assert.equal(resolveUnitedDegreeLabel("Foundation"), null);
});

test("United uses degree-specific live document slots", () => {
  assert.deepEqual(resolveUnitedDocumentSlots("Associate"), {
    diploma: ["cer"],
    transcript: ["trans"],
  });
  assert.deepEqual(resolveUnitedDocumentSlots("Bachelor"), {
    diploma: ["cer"],
    transcript: ["trans"],
  });
  assert.deepEqual(resolveUnitedDocumentSlots("Master"), {
    diploma: ["cerb"],
    transcript: ["transb"],
  });
  assert.deepEqual(resolveUnitedDocumentSlots("PhD"), {
    diploma: ["cerp"],
    transcript: ["transp"],
  });
  assert.equal(resolveUnitedDocumentSlots("Foundation"), null);
});

test("United resolves CRM university aliases to exact live portal labels", () => {
  assert.equal(
    resolveUnitedUniversityLabel("Ankara Bilim University"),
    "Ankara Science University",
  );
  assert.equal(
    resolveUnitedUniversityLabel("Ankara Bilim Üniversitesi"),
    "Ankara Science University",
  );
  assert.equal(
    resolveUnitedUniversityLabel("Nişantaşı Üniversitesi"),
    "Nisantasi University",
  );
  assert.equal(
    resolveUnitedUniversityLabel("Biruni Üniversitesi"),
    "Biruni University",
  );
  assert.equal(
    resolveUnitedUniversityOption(
      [
        "Istanbul Kent\u200f\u200f University",
        "Ankara Science University",
        "Ankara Medipol University",
      ],
      "Ankara Bilim University",
    ),
    "Ankara Science University",
  );
  assert.equal(
    resolveUnitedUniversityOption(
      ["Ankara Science University", "Ankara Science University"],
      "Ankara Bilim University",
    ),
    null,
  );
});

test("United exact-email My Students rows override stale zero search counts", () => {
  assert.equal(resolveUnitedProfileLookupAction(0, 1), "inspect");
  assert.equal(resolveUnitedProfileLookupAction(2, 0), "unknown");
  assert.equal(resolveUnitedProfileLookupAction(0, 0), "new");
});

test("United university filter tolerates unrelated staging cards but requires the exact target", () => {
  assert.equal(
    hasExactUnitedUniversityCard(
      ["Biruni University", "Nisantasi University"],
      "Istanbul Nisantasi University",
    ),
    true,
  );
  assert.equal(
    hasExactUnitedUniversityCard(
      ["Biruni University", "Ankara Science University"],
      "Istanbul Nisantasi University",
    ),
    false,
  );
});

test("United resolves programme options exactly and preserves qualifiers", () => {
  const options = [
    "Law (Turkish)",
    "Law (English)",
    "International Law (English)",
    "Business Administration (English) (Thesis)",
    "Business Administration (English) (Non-Thesis)",
  ];
  assert.equal(
    resolveUnitedProgramOption(options, "Bachelor of Law (Turkish)"),
    "Law (Turkish)",
  );
  assert.equal(
    resolveUnitedProgramOption(
      options,
      "Master of Business Administration (English) (Non-Thesis)",
    ),
    "Business Administration (English) (Non-Thesis)",
  );
  assert.equal(
    resolveUnitedProgramOption(options, "Bachelor of Law"),
    null,
  );
});

test("United target application proof rejects wrong default portal cards", () => {
  const rows = [
    {
      href: "/Manage/applicationdetails/a0vWRONG",
      ref: "APP-286080",
      university: "Istanbul Kent\u200f\u200f University",
      program: "Dentistry (Turkish)",
      profileHref: "/Manage/studentprofile/001WRONG",
    },
    {
      href: "/Manage/applicationdetails/a0vRIGHT",
      ref: "APP-286099",
      university: "Ankara Science University",
      program: "Law (Turkish)",
      profileHref: "/Manage/studentprofile/001RIGHT",
    },
  ];
  assert.deepEqual(
    findUniqueUnitedTargetApplication(
      rows,
      "Ankara Bilim University",
      "Bachelor of Law (Turkish)",
    ),
    rows[1],
  );
  assert.equal(
    findUniqueUnitedTargetApplication(
      [rows[0]],
      "Ankara Bilim University",
      "Bachelor of Law (Turkish)",
    ),
    null,
  );
  assert.equal(
    findUniqueUnitedTargetApplication(
      [rows[1], { ...rows[1], href: "/Manage/applicationdetails/a0vDUP" }],
      "Ankara Bilim University",
      "Bachelor of Law (Turkish)",
    ),
    null,
  );
});

test("United duplicate-profile repair requires unique prior external-ref ownership", () => {
  const rows = [
    {
      href: "/Manage/applicationdetails/a0vP200000ZtJM1IAN",
      ref: "APP-286081",
      university: "Istanbul Kent University",
      program: "Dentistry (Turkish)",
      profileHref: "/Manage/studentprofile/001P200001DQR1NIAX",
    },
    {
      href: "/Manage/applicationdetails/a0vP200000ZtJHBIA3",
      ref: "APP-286080",
      university: "Istanbul Kent University",
      program: "Dentistry (Turkish)",
      profileHref: "/Manage/studentprofile/001P200001DQEHDIA5",
    },
  ];
  assert.equal(
    findUnitedProfileHrefByExternalRef(rows, "a0vP200000ZtJHBIA3"),
    "/Manage/studentprofile/001P200001DQEHDIA5",
  );
  assert.equal(
    findUnitedProfileHrefByExternalRef(rows, "APP-286081"),
    "/Manage/studentprofile/001P200001DQR1NIAX",
  );
  assert.equal(findUnitedProfileHrefByExternalRef(rows, undefined), null);
  assert.equal(
    findUnitedProfileHrefByExternalRef(
      [
        rows[0],
        {
          ...rows[0],
          profileHref: "/Manage/studentprofile/001DUPLICATE",
        },
      ],
      "a0vP200000ZtJM1IAN",
    ),
    null,
  );
});

test("United profile repair uses degree-specific document keys", () => {
  assert.deepEqual(resolveUnitedProfileDocumentKeys("Bachelor"), {
    diploma: "HighSchoolDiploma",
    transcript: "HighSchoolTranscript",
  });
  assert.deepEqual(resolveUnitedProfileDocumentKeys("Master"), {
    diploma: "Bachelor'sDiploma",
    transcript: "Bachelor'sTranscript",
  });
  assert.deepEqual(resolveUnitedProfileDocumentKeys("PhD"), {
    diploma: "Master'sDiploma",
    transcript: "Master'sTranscript",
  });
  assert.equal(resolveUnitedProfileDocumentKeys("Foundation"), null);
  assert.equal(
    parseUnitedProfileUploadKey(
      "uploadfile('003X','001X','1','Bachelor\\'s Diploma','Bachelor\\'sDiploma')",
    ),
    "Bachelor'sDiploma",
  );
  assert.equal(
    parseUnitedProfileUploadKey(
      "uploadfile('003X','001X','1','Passport','Passport')",
    ),
    "Passport",
  );
});

test("Multico uses exact live GPA select values", () => {
  assert.equal(normalizeMulticoGpaSystem("4.0"), "4");
  assert.equal(normalizeMulticoGpaSystem("100"), "100");
  assert.equal(normalizeMulticoGpaSystem("6"), null);
});

test("Multico target application lookup is exact and fail-closed on ambiguity", () => {
  const one = `
    <h3>Candidate Applications</h3>
    <table>
      <tr><td><a href="/crm/student-applications/edit/8123">#8123</a></td>
      <td>Bachelor of Software Engineering (English)</td><td>Pending</td></tr>
      <tr><td><a href="/crm/student-applications/edit/8124">#8124</a></td>
      <td>Bachelor of Nursing (Turkish)</td><td>Accepted</td></tr>
    </table>`;
  assert.deepEqual(
    findMatchingMulticoApplication(
      one,
      "Bachelor of Software Engineering (English)",
    ),
    { applicationId: "8123", fee: "", status: "Pending" },
  );
  assert.equal(
    findMatchingMulticoApplication(one, "Bachelor of Medicine (English)"),
    null,
  );
  const ambiguous = one.replace(
    "</table>",
    '<tr><td><a href="/crm/student-applications/edit/8125">#8125</a></td><td>Bachelor of Software Engineering (English)</td><td>Pending</td></tr></table>',
  );
  assert.equal(
    findMatchingMulticoApplication(
      ambiguous,
      "Bachelor of Software Engineering (English)",
    ),
    null,
  );
});

test("Okan refuses unknown degree levels and ambiguous programs", () => {
  assert.equal(resolveOkanDegreeValue("Bachelor"), "2");
  assert.equal(resolveOkanDegreeValue("unknown"), null);
  assert.equal(
    chooseOkanProgramIndex(
      ["Business Administration (Thesis)", "Business Administration (Non-Thesis)"],
      "Business Administration",
    ),
    null,
  );
});
