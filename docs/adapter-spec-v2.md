# Adapter Spec v2

Adapter Spec v2 is the versioned, uploadable portal-automation contract used by
**Portal Automation → Adapters → Adapter Specs (Advanced)**.

The intended operating model is:

1. map the live portal without submitting;
2. author one JSON spec plus mapping evidence;
3. upload with **Enable on save off**;
4. validate and review the privileged capabilities;
5. run an approved canary;
6. enable the reviewed version;
7. roll back to the previous version if the portal changes.

Normal spec revisions do not require a source-code deployment or worker
restart. The worker refreshes enabled specs from the database cache.

## Safety and resolution

- `specVersion: 1` keeps the historical linear interpreter.
- `specVersion: 2` enables guarded steps, state-machine workflows, strict
  dry-run, profile policies and ordered outcome rules.
- `meta.resolution: "fallback"` never replaces a code adapter.
- `meta.resolution: "override"` may replace a same-key code adapter only when:
  - the version is enabled;
  - the spec parses as v2; and
  - a super admin explicitly grants `privilegedApproved`.
- New uploads are disabled by default in the admin UI.
- Credentials are resolved from the encrypted credential store or environment;
  passwords must never be embedded in a spec.
- `http`, `graphql`, `jsHook`, and code-adapter override are privileged.
- In v2 strict dry-run, fill/select/click/upload/jsHook/GraphQL and non-GET HTTP
  actions are skipped. Only navigation and read-only assertions/captures run.

## Workflow contract

`workflow.states` describes resumable logical portal screens. Every state has:

- a side-effect-free `detect` condition set;
- bounded `maxRetries`;
- the actions for one attempt;
- an allowlist of target transitions; and
- optional `terminal: true`.

The interpreter changes logical state only after consecutive stable detector
reads prove another state and the authored transition permits that target.
Validation that leaves the same state active consumes a bounded retry. Missing,
ambiguous or flickering state evidence fails closed.

Supported condition sources:

- `profile`, `vars`, `captured`
- `url`
- `selectorExists`, `selectorVisible`, `selectorText`, `selectorValue`

Supported operators:

- `exists`, `notExists`, `empty`, `notEmpty`
- `equals`, `notEquals`, `contains`, `matches`

## Profile policy

`profilePolicy.defaults` is the only supported declarative fallback mechanism.
A default:

- applies only when the source field is blank;
- names its literal or `profile.*` source;
- carries an auditable business-policy `reason`; and
- never logs the applicant value.

`profilePolicy.required` runs before the first submit mutation. Conditional
requirements can be level-specific. Missing required data stops before the
portal form is changed.

## Program selection and quota

`selectProgram` uses `programSelection` to enumerate a live `<select>` or an
authored static catalog. Matching order is exact label/value, admin name
mapping, then thresholded fuzzy matching.

- matched and enabled → select the proved portal value;
- matched and disabled → `programFull=true`;
- no proved match → `programMissing=true` with the observed catalog.

The existing writeback reducer maps Altınbaş `programFull` to `quota_full`.
A proved `submitted` result maps to `awaiting_offer`, and `alreadyExists` maps
to `all_registered`.

## Readback and outcomes

Writes can request exact/trimmed/folded readback and reject
`aria-invalid="true"`. CSS clicks can require exactly one target; `clickRole`
always requires one accessible-role target.

Every non-optional v2 `upload` must author a portal/server success proof:
`responseUrlContains` or `successSelector`. The interpreter starts the response
wait before choosing the file, verifies the exact local basename, rejects
non-2xx upload responses and records `uploadedSlots` only after every authored
proof passes. A missing required document fails before the upload action.

`outcomes` is an ordered list of read-only result rules. It can classify:

- `submitted`
- `alreadyExists`
- `programMissing`
- `programFull`
- `failure`

When outcome rules are present and none match, the result is explicitly
unproved; success is never inferred from a URL id alone.

## Altınbaş migration boundary

The current Altınbaş adapter includes a Salesforce Screen Flow/Aura protocol
driver, encrypted chained state handling, composed-shadow row identity,
ContentVersion upload proof and rollback logic. Those protocol mechanics remain
in the production code adapter until they are extracted into a reusable
Salesforce driver. An Altınbaş v2 spec must not be enabled as an override until
it proves all of the following with fixtures and an approved canary:

- new application creation and resumed application selection;
- Associate/Bachelor/Master/PhD routing;
- live program and language matching;
- Personal/Educational/Questionnaire state transitions;
- all required document slots with server-side proof;
- submitted/already-registered/full-quota outcomes; and
- no dangling application after a failed run.

Until that acceptance gate passes, Altınbaş continues using the hardened code
adapter; uploading an incomplete spec is not a safe replacement.
