# Portal Automation Mapping Report — 2026-07-26

Scope: United, Multico, Üsküdar, Okan, Beykent and Işık. SIT and Topkapı are
explicitly excluded.

All mapping was performed in the authenticated portal sessions without a final
student submit. The six JSON artifacts under `docs/portal-specs/` validate as
Adapter Spec v2, use strict dry-run, are marked experimental and resolve as
fallback. They are intended to be uploaded disabled until an approved canary
proves the complete workflow.

## United

- Portal family: ASP.NET/Metronic, six-step KT-Stepper.
- Entry: `/Manage/newapplication`.
- Live first state: `input[name=radio_buttons_2]`, `Continue`.
- Degree state: visible `label.form-check-image` cards.
- Program state: `div.single-table`; proof is an increase in
  `Selected Majors (N)`.
- Personal controls: `#firstname`, `#lastname`, `#passport`, `#dateInput`,
  `#fathername`, `#mothername`, `#SecondarySchoolName`, `#phone11`,
  `#emailaddress`, `#gender`, country selects.
- Documents: `#pass`, `#cer/#cerb/#cerp`, `#trans/#transb/#transp`;
  server proof endpoint `/Manage/uploadfilesone`.
- Dedup: `/Account/searchapp`; unknown dedup is fail-closed.

## Multico

- Portal family: server-rendered CRM with authenticated HTTP form endpoints.
- Live create form and POST action: `/crm/students/add`.
- Hidden form contract: `agent_id`.
- Required identity fields: `name`, `surname`, `passport_number`, `phone`,
  `email`, `mother_name`, `father_name`, `dob`, `address`.
- Required selects: `status`, `residence_country`, `nationality_id`,
  `graduate_year`.
- Correct multiple-nationality field: `hasMultipleNationality`.
- Required uploads observed: `file_passport`, `file_diploma`,
  `file_transcript`.
- Application endpoint remains `/student-applications/add/{studentId}`.
- Existing student ownership is not inferable; duplicate application creation
  is therefore blocked.

## Okan

- Portal family: Kendo application wizard.
- Entry: `/agency/ApplicationWizard`.
- Agency wizard states:
  1. `Please Select the Term`
  2. `Please Select the Degree`
  3. Personal Info (`#firstName`, `#lastName`, `#passportNumber`, `#email`)
- Degree values: Associate=1, Bachelor=2, Master=3, PhD=4, TÖMER=5.
- Track wizard selectors confirmed from the production code mapping:
  personal Kendo fields, `#programKeyword`, secondary-school controls and
  document upload rows.
- Residence city and birth city now require their dedicated CRM fields; they
  are never parsed from an address.

## Üsküdar

- Portal family: Salesforce Experience Cloud Screen Flow.
- Entry: `/agency/s/application-form`.
- Live first state: `input[name=eduhubPicklistOptions]`, term
  `Fall 2026-2027`, `Next`.
- Subsequent mapped families: applicant identity, Available Programs,
  selected-program cart, personal details, secondary school, documents,
  review/submit.

## Beykent

- Portal family: Salesforce Experience Cloud/LWC Screen Flow.
- Entry: `/agency/s/application-form`.
- Track page: `/agency/s/track-application`.
- Live first state: `input[name=eduhubPicklistOptions]`, term
  `Fall 2026 - 2027`, `Next`.
- Subsequent state contract matches the shared Salesforce flow family, with
  Beykent-specific origin and term label.

## Işık

- Portal family: Salesforce Experience Cloud Screen Flow.
- Entry: `/agency/s/application-form`.
- Live first state: `input[name=eduhubPicklistOptions]`, term
  `Fall 2026-2027`, `Next`.
- Subsequent mapped families match the shared Salesforce flow contract.

## Guardian v2 boundary

Failure runs now persist a PII-safe structural evidence object: origin/path,
headings, buttons, control metadata, required/invalid flags, validation labels,
progress markers and shadow-host counts. Values, query strings, cookies,
storage, tokens and request bodies are excluded.

Guardian may automatically create a disabled spec draft only when:

- structured output is valid;
- classification is selector/portal change;
- confidence is at least 0.85;
- risk is low;
- every operation is a selector/detector/success-proof string edit; and
- the patched spec still passes the v2 schema.

Authentication, URL, final-submit, document policy, profile defaults,
program choice, HTTP, GraphQL and JavaScript changes are outside this boundary.
A super-admin approval can promote the exact stale-checked, non-executable
draft; it never retries a student or touches a university portal.
