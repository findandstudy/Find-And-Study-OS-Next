# Find & Study OS Next — Live Baseline Refresh

Date: 31 August 2026

Evidence: GitHub branches/commits/PRs plus read-only Hostinger VPS and PostgreSQL checks

Safety: No production file, data, service, configuration, deployment, migration or external integration was changed.

## Verified baseline

| Surface | Verified state |
|---|---|
| Live source repository | `findandstudy/Find-And-Study-OS` |
| Live source branch | `hotfix/embed-release-20260830` |
| Live source commit | `d8f385ca018161cf6330232f5840d3a29c3581ce` |
| Live release ID | `20260831T071637Z-d8f385ca0181` |
| Product commits, 11–31 August | 126 |
| Production DB / migration ledger | `fasos_apply`, 66/66, `0000–0065` |
| Old repository default | `master` → `7e3c9639…`, 139 commits behind live, unprotected |
| This repository default | `main` → `32c84a928…`, 23 August import, unprotected |
| Latest Control Plane candidate | PR #29 → `eb577b780…`, open/draft/unmerged |

The live API process cwd and `/api/health.releaseId` agree on the same release.
`/health` and `/api/health` returned HTTP 200 and the database reported ready.
Nginx, PostgreSQL and Fail2ban were active; the Apply API and portal worker were
online.

The production catalog confirms `finance_mutation_requests`,
`agent_applications.access_token_expires_at` and the five new finance CHECK
constraints. The CHECK constraints are intentionally `NOT VALID`; PostgreSQL
reports `convalidated=false`, while new writes remain constrained.

## Product changes that must survive convergence

The 126-commit live line contains these grouped capabilities and fixes:

1. Student-created application visibility, branch/staff scope, lost-stage
   propagation, inbox assignment, JFIF normalization, standalone signing and
   proposal fee-period preservation.
2. DormBooking knowledge/catalog integration, configurable WhatsApp sender and
   branding, multilingual channel routing, bounded portal document handling,
   Salesforce diagnostics and the full Haliç submission flow.
3. Lifecycle messaging, candidate-port deployment support, SIT session fixes,
   public-application provenance, finance sync, `+92` assignment and AI config
   alignment.
4. Unified Web-to-Lead/embed creation, optional widget AI, partner ownership,
   inbox resilience and human handoff.
5. Course Finder payload/read-path performance, cache/prefetch/lazy loading,
   default-university embeds and Nginx failover/cutover controls.
6. AI-assisted application intake and the localized Follow-up workspace with
   permission, reassignment and cache rules.
7. Piri Reis, SIT, Topkapı, Okan and Yeni Yüzyıl/United portal routing;
   document normalization; manual queue/fanout and Salesforce resume.
8. Verified agency onboarding, production verification mail, country/flag and
   review fixes, template-specific contract verification evidence and the
   provisional agency portal lifecycle.
9. Agency/sub-agent assignment separation, Academy/follow-up visibility,
   confirmed-commission finance reporting, service-fee corrections and agent
   Course Finder/program-catalog embed modes.
10. 31 August security hardening: authorization checks, transactional finance
    mutations, advisory locks/idempotency, private-object authorization,
    SSRF/DNS-IP defenses, PDF egress/resource limits, HTML sanitization, output
    escaping, constrained CORS/webhooks, session/token expiry, separate asset
    signing secrets, POST+CSRF logout, endpoint caps and safe error responses.

The 31 August security commit changes 66 files with 2,075 insertions and 716
deletions. These changes are repository and runtime evidence, not a claim that
every user journey has completed independent production E2E validation.

## P0 migration identity collision

The live product line uses:

```text
0054 agent_applications
0055 agent_application_review_then_sign
0056 contract_email_verification_evidence
0057 agent_application_provisional_portal
0058 pipeline_stage_auto_messages
0059 fas_agency_codes
0060 scoped_record_assignments
0061 pipeline_stage_audiences
0062 agent_tenant_capabilities
0063 finance_mutation_integrity
0064 agent_application_token_expiry
0065 invoice_integrity
```

The unmerged Control Plane line uses the same `0054–0065` numbers for
authorization, ChangeSet, evidence, audit and active-context migrations, then
continues through `0069`. The SQL, journal order and hashes are different.

Production `0000–0065` is authoritative. Because the Control Plane migrations
were not applied to a long-lived database, the safe proposed mapping is:

```text
Control Plane 0054–0069 → canonical 0066–0081
```

This mapping requires repository-owner reservation of `0066+`, file and journal
renumbering, hash regeneration, adoption-guard review, migration denominator
updates, documentation/PR updates and fresh disposable PostgreSQL plus all
exact-head CI. A filename-only rename is insufficient.

## Runtime and operations drift

- Root disk is `84/96 GB` used (`87%`), approximately 13 GB free.
- Apply API and portal worker still run as `root`.
- Hostinger shows weekly backups and two visible backup/snapshot items.
- Hostinger provider firewall shows zero rules; host UFW/Fail2ban is a separate
  layer and was active in the earlier audit.
- Hostinger malware scanner is not installed.
- Offsite restore/DR evidence remains open.

## Required convergence sequence

1. Freeze `d8f385ca…` and production ledger `66/66` as immutable inputs.
2. Reserve the next migration range and renumber the unmerged Control Plane
   series before any convergence merge.
3. Start a new branch from the live commit, not from this repository's squash
   import snapshot.
4. Port G0/Control Plane changes in small reviewed slices, preserving all 126
   live product commits and their regression tests.
5. Run product regressions and tenant/authz negative tests together, including
   clean and production-derived disposable PostgreSQL migrations.
6. Require protected branch/ruleset contexts and an independent reviewer before
   merging into `main`.
7. Treat production deploy/migration/runtime wiring as a separate approval-gated
   change with backup, canary, health checks and rollback.

Until this sequence passes, this repository is an engineering candidate and
knowledge baseline, not a deployable production source of truth.
