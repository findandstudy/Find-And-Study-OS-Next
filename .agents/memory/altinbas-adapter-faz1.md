---
name: Altınbaş adapter (Screen Flow replay)
description: Salesforce Screen Flow portal — adapter replays navigateFlow aura POSTs (serializedState chained) instead of DOM clicking; closed LWC shadow makes UI automation impossible past Program screen.
---

## Architecture decision (Faz-4, 2026-07-10) — navigateFlow REPLAY

The wizard is a Salesforce Screen Flow. Every screen transition is
`POST /partner/s/sfsites/aura` → `FlowRuntimeConnectController.navigateFlow`
with `{action: NEXT|CONTINUE_AFTER_COMMIT|FINISH, serializedState, fields[]}`.
- `serializedState` is ~90KB ENCRYPTED + server-chained → can NEVER be hand-built;
  always take it from the LAST flow response. Adapter must run in a live logged-in
  browser (flow boot via clicking "Create New Application" gives the first state
  carrying applicant context).
- `fields[]` is PLAIN TEXT → we inject our values by field name; Next is never
  clicked, so client-side validation never runs.

**Why**: the program cards live inside CLOSED LWC shadow DOM — no Playwright
locator or evaluate-walker can reach them (proven empirically over many dry-runs).
The earlier coordinate-click approach worked but was fragile; replay removes all
DOM interaction past Step 1. Do NOT reintroduce DOM/coordinate handling for
Term→FINISH screens.

## Flow contract essentials (captured live)

- Screen order: Term(NEXT) → Degree(NEXT) → Program(NEXT) →
  CONTINUE_AFTER_COMMIT ×N with `fields:[]` (application record is CREATED here)
  → Personal(NEXT) → Educational(NEXT) → Questionnaire(NEXT) → Documents(NEXT)
  → FINISH. Dry-run stops before FINISH.
- Formats: dates ISO `YYYY-MM-DD` (UI shows otherwise — payload is ISO);
  country picklists are a 3-field pattern
  (`<F>.<Group>.<CountryEn>.selected=true` + `.selectedChoiceLabels/Values`;
  Passport_Issuing_Country's group is `IssuingCountry`, others `CountryList`);
  phone = `phoneWithCountryCode.selectedCountryCode` + `.phone` with the dial
  code PREFIXED; Email is READ-ONLY pre-filled — never send it.
- Record ids in responses: Term/Degree options prefix `a0C`, program
  availability `a0A` (carries `eduhub__Program__c`), Contact `003`,
  Application__c `a02`, Account `001`. Eligible program list is client-side
  preloaded; already-applied programs are hidden from it.
- Duplicate guard: portal blocks a 2nd application with same
  passport+term+degree (`Prevent_Duplicate_Passport` subflow) → adapter maps it
  to alreadyExists=true (SKIPPED_DUPLICATE), never a FAIL.

## Hardening rules (architect-reviewed)

- Interceptor ingests state/template ONLY from FlowRuntimeConnectController
  traffic (background aura calls would corrupt the chained state); the
  ALTINBAS_CAPTURE=1 dump still logs ALL aura traffic (/tmp/altinbas-capture.json).
- A replay response counts only if HTTP 2xx AND parses as aura JSON with
  `actions[]`; FINISH additionally requires `state:SUCCESS` before
  submitted=true (HTML login/edge pages must fail visibly, never fake success).

## Raw-regex Id candidates are diagnostic only — trust tiers (FIX-10, 2026-07-10)

- Proven failure: the loose commit-body regex (`a02[a-zA-Z0-9]{12,15}` = variable
  13-18 len) matched a token FRAGMENT (`a02Q3107ut6nun1`, no `0000` padding) and
  bound it as "run-proven" applicationId → Educational validation err=true even
  with all 4 ids filled.
- Rules now enforced (architect 3 rounds):
  - Shape is the only HARD gate: exactly 15 or 18 alnum chars at every ingress
    (explicit keyRe, prefix scan, walk records pool, walk explicit keys).
  - `0000` padding is a SOFT ranking signal only (not a Salesforce guarantee —
    never hard-reject on it): padded candidates preferred everywhere (provenAppId
    tiers, scanIds upgrade, records prefix-fallback two-pass), unpadded selection
    always WARNs.
  - Raw-regex-scanned a02s go to a diagnostic-only set (`rawCommitA02`) and can
    NEVER bind directly. Bindable applicationId candidates: parsed rt.records
    commit diff (`runCreatedAppIds`) ∪ (raw ∩ explicit-key corroborated) ∪
    explicit. Weak-only candidates → loud "BAĞLANMADI" WARN + capture guidance.
  - Precedence: padded commitTrusted > padded explicit > unpadded commitTrusted
    > unpadded explicit (commit>explicit is the FIX-9 stale-draft decision).
  - seenA02 baseline stays BROAD (unpadded included) — broader baseline can only
    prevent mis-attribution, never cause it.
- Educational payload shape (nf=19: path1.currentStage + 4 lists ×
  applicantId/applicationId/cvType/language + SetCookie.accountId/contactId)
  already equals the human-flow minimal form — if err=true persists with a REAL
  applicationId, next step is the human Educational navigateFlow payload diff
  (manual capture), not payload guessing.

## Id extraction must not depend on JSON.parse (FIX-9, 2026-07-10)

- Proven failure: aura response bodies frequently fail JSON.parse → the walk
  never runs → NO ids/records collected → all 4 Educational bindings empty.
  Id scanning must be an escaped-tolerant regex over EVERY raw body,
  independent of parse success (explicit keys incl. Salesforce AccountId/
  ContactId capitalized variants; 15-18 alnum values).
- Non-flow aura traffic (applicant-detail page load) is the ONLY carrier of
  the selected student's Contact(003)/Account(001) when flow responses lack
  them — scan it for ids ONLY (never state), with three gates:
  applicationId NEVER from non-flow (old-draft pollution); other keys only
  AFTER applicant selection (pre-selection traffic = session context, wrong
  actor); aura-explicit never overwrites flow-explicit (source registry).
- applicationId precedence: run-proven (commit-response-body a02 diff vs
  pre-commit baseline incl. raw-scanned a02 universe) > flow-explicit >
  prefix. Commit attribution must diff the commit RESPONSE body itself, not
  a global seen-set (concurrent traffic mis-attributes).
- Bind aura-explicit/raw-scan fallbacks with a WARN (fail-operational: empty
  binding = guaranteed validation error); contactId↔applicantId cross-fill
  (same Contact); drop obviously wrong-prefix values (003 is a Contact, never
  an accountId) before binding.

## Educational ID bindings need provenance (FIX-8, 2026-07-10)

- Educational NEXT with correct field SHAPE (contract-identical nf=19) can still
  fail as an empty-errorCode client validation if list bindings
  (EducationalInformationList/Exam/Experience/Reference .applicationId/.applicantId
  + SetCookie.accountId/contactId) carry stale ids.
- rt.ids is polluted by first-seen prefix fallback (003/001/a02 — a02 hits
  boot/program availability rows). Bindings must use DETERMINISTIC provenance:
  applicationId = run-proven (explicit "applicationId" key ∪ first-seen-in-commit
  a02) > explicit > prefix-fallback; other three = last EXPLICIT key value >
  prefix-fallback. FlowRuntime.explicitIds tracks last explicit value per key.
- Log provenance per key (run-proven|explicit|prefix-fallback|YOK) + full
  Educational REQUEST fields JSON (ids+constants only, no PII) so the next
  ALTINBAS_CAPTURE run can be diffed 1:1 against the human contract.
- Sub-records (GPA/school rows) are optional — human flow passed empty lists;
  only add real education rows if validation persists WITH correct ids
  (field names to be captured first).

## Duplicate = Program step ONLY (FIX-7, 2026-07-10) — supersedes FIX-5/FIX-6 stop logic

- TWO separate portal duplicate checks exist. (1) Program step
  `AlreadyApplicationError` — runs BEFORE any record is created; its `message`
  populates only for a student who really applied → the ONLY valid
  SKIPPED_DUPLICATE trigger. (2) commit/Personal `CheckDuplicateValidation`
  "passport already exists" — runs AFTER commit1 created the record and flags
  our OWN just-created record on EVERY fresh student (proof: fresh student run,
  Program dup=false, commit2+Personal dup=true) → NEVER a stop reason; log-only
  (`dupIgnored=true`) and continue to Educational.
- FIX-6's a02-window ownership heuristic (classifyDuplicate) could not reliably
  separate self vs real and was REMOVED; the ÇİFT-CREATE diagnostic
  (runCreatedAppIds baseline vs commit responses) is kept as evidence only.
- isAlreadyAppliedProgram: /already applied for this program/i OR
  AlreadyApplicationError followed within ≤300 chars by a POPULATED (≥4-char,
  trimmed) escaped-JSON-tolerant `message` value; null/"" must not match.
- Real-duplicate safety net: portal hard-blocks duplicates at Submit/FINISH
  visibly; dry stops before Submit — ignoring self-referential messages cannot
  cause a silent wrong submit.

## Self-duplicate (FIX-6, 2026-07-10, SUPERSEDED by FIX-7) — commit creates the record the guard flags

- commit1 CREATES the application record; the duplicate-guard subflow can then
  flag that just-created record as "passport already exists" even for fresh
  students (human flow excludes it as current application). Self vs real must
  be distinguished or every student is falsely skipped.
- Ownership evidence = explicit "applicationId" key ids ∪ a02 record ids that
  FIRST appear in commit responses (baseline snapshot taken after Program NEXT,
  before first commit). NEVER use rt.ids.applicationId for ownership — the a02
  prefix fallback is polluted by boot availability records.
- Classification: no owned ids this run → real; foreign a02 within ±800 chars
  of the message → real; else (with ownership proof) → self → WARN + continue.
  Continuing on ambiguity is fail-safe: the portal hard-blocks real duplicates
  at Submit/FINISH visibly; dry stops before Submit.
- ÇİFT-CREATE ŞÜPHESİ warn fires if a 2nd commit creates another app id
  (hypothesis: adapter sends more commits than the human flow — compare with
  ALTINBAS_CAPTURE).

## Duplicate detection (FIX-5, 2026-07-10) — match the MESSAGE, not config names

- "Prevent_Duplicate_Passport" is the flow's subflow CONFIG name
  (CheckDuplicateValidation.subflowToRun) and appears in EVERY ~1MB state —
  matching it (or generic phrases like "already an application") marks every
  student SKIPPED_DUPLICATE. Only match the real populated error text
  ("an application with this passport number already exists" / "you cannot
  submit a new application using the same passport").
- The duplicate subflow runs when LEAVING Personal (errorMessage fills there),
  not at commit — duplicate is checked ONLY on the Personal response
  (guard checkDup flag); all steps still check flowHasError. Dup check runs
  before flow-error check so real duplicates classify as SKIPPED_DUPLICATE.

## State chaining (FIX-4, 2026-07-10) — response key is DIFFERENT

- Flow RESPONSES return the new state under `serializedEncodedState`;
  `serializedState` is the REQUEST-side key. Ingest must accept both
  (encoded preferred when an object carries both) or the chain silently
  sticks on the tiny (~3KB) boot-request state and the flow rejects the
  2nd NEXT with interviewStatus:"Error" even when field data is correct.
- Real interview state is tens of thousands of chars — a <5KB state before
  send is a broken-chain signal (WARN); log newStateLen after every ingest.
- interviewStatus:"Error" is a flow-error signal alongside state:ERROR /
  exceptionEvent / errors[] (match escaped-JSON variants too).

## Option matching (FIX-2/FIX-3, 2026-07-10)

- Term/Degree/Program selectable options come from the navigateFlow RESPONSE
  records themselves (boot carried 11) — there is NO separate Apex options call.
  Never send a screen with `fields:[]` (nf=0): the flow silently advances with
  no selection and the NEXT screen fails ("Degree seçeneği bulunamadı").
- FIX-3 lesson: loose label-only dynamic parse picks the WRONG record type —
  year-only "2026-2027" labels live on a02 (application/availability) records
  and the flow REJECTS them (interviewStatus:"Error"). Dynamic candidates MUST
  be filtered by Id prefix AND label pattern (Term: a0C + season word; Degree:
  a0C + Master/PhD/Doctorate/Doktora; Program: a0A/a0B/eduhub__Program__c).
- Captured constants are PRIMARY for Term+Master (this cycle stable):
  Term "Fall 2026 - 2027"→a0CQ30000AVvpaEMQR, Degree "Master"→a0CQ30000AVvqKTMQZ;
  PhD Id unknown → filtered dynamic, else fail-visible (capture on a PhD run).
- Term fields must include `TermSelector.maxSelections=3` + `uniMaxSelection=3`.
- On flow ERROR at a selection screen, log the exact sent id+label.

## Still unknown (pending first live ALTINBAS_CAPTURE=1 run)

- FINISH exact payload and Documents upload (Salesforce ContentVersion base64
  insert) were never captured — Documents is currently passed empty and the
  capture dump exists precisely to grab these on the first real run.
- Questionnaire required answers shape (`QuestionnaireView.responseQuestions`);
  known question: "Do you need Visa Support?" → Yes.

## Kept DOM parts (before the flow boots)

- Level guard: Master/PhD only, everything else → skipped with clear detail
  (customer confirmed only Master+PhD open).
- Login → Basic Info Step 1 (First/Last/Citizenship typeahead/Passport/Email) →
  student grid (SLDS faux radio needs force-check) → applicant detail →
  "Create New Application". SPA route guard bounces cold deep-links → click-through
  navigation with retries; "Sorry to interrupt" CSS-error dialog dismissed
  non-blockingly.
- Live success verification (portal UI): Applications list Stage "Evaluation"
  + green ✓; "Signed Up"/"Complete Application" = half-finished.
