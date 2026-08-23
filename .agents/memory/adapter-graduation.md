---
name: Adapter auto-graduation
description: Experimental adapters graduate (auto-process unlocks) after GRADUATION_THRESHOLD=3 live 'submitted' rows per adapter_key — computed live, no persisted flag.
---

## Rule
experimental(key) = staticExperimentalFamily(key) && successCount(key) < GRADUATION_THRESHOLD

GRADUATION_THRESHOLD = 3, exported from @workspace/portal-adapters registry.ts AND re-exported from @workspace/portal-runner graduation.ts AND api-server lib/adapterGraduation.ts — all three must agree.

## Key files
- `lib/portal-runner/src/graduation.ts` — single counting core (getAdapterSuccessCounts, getNonGraduatedExperimentalAdapterKeys, getExperimentalExcludedUniversityKeys); shared by api-server wrapper + worker + drain-once.
- `artifacts/api-server/src/lib/adapterGraduation.ts` — thin api-server wrappers (getSuccessCounts, isExperimentalDynamic, getNonGraduatedExperimentalKeys).
- `lib/portal-runner/src/queue.ts` claimNext() — 4th param `excludeUniversityKeys`; gated (inside the manual-bypass condition), so meta.manual rows always bypass.
- `lib/portal-adapters/src/registry.ts` — GRADUATION_THRESHOLD + EXPERIMENTAL_FAMILIES; resolveFamily is exact-key based.

## DB
- `portal_submissions.adapter_key` (text, nullable) + index `portal_submissions_adapter_key_status_idx(adapter_key, status)`. Added in schema migration 0032 + boot DDL in api-server src/index.ts (~L1610). Historical rows backfilled from portal_universities at boot.
- Counting query: `COUNT(*) WHERE adapter_key=ANY($1) AND status='submitted' AND deleted_at IS NULL GROUP BY adapter_key`.

## Auto-process guard locations (must all be in sync)
1. PATCH /portal-universities/:id/auto-process — 409 EXPERIMENTAL_ADAPTER guard (portalMgmt.ts ~L393)
2. Bulk auto-process — skip filter (portalMgmt.ts ~L766)
3. claimNext() excludeUniversityKeys param — scheduled drain (runPortalAutoDrainTick via drainQueue 3rd param)
4. worker.ts loadAutoProcessKeys — filters non-graduated keys
5. scripts/drain-once.ts — filters non-graduated keys

Manual single-submission (operator-triggered) intentionally bypasses ALL five gates.

## Frontend
- PortalAdaptersTab: RegistryAdapter type extended with staticExperimental/successCount/graduationThreshold/graduated. Renders amber "Experimental" badge + "N/threshold successful submissions" progress text + emerald "Graduated" badge.
- PortalUniversitiesTab: RegistryAdapter type extended identically. graduationInfoByKey memo → passed to UniversityRow. Tooltip for disabled auto-process switch shows graduation progress hint.
- i18n: portalAutomation.adapters.graduated, .graduationProgress "{count}/{threshold}...", portalAutomation.unis.autoProcessGraduationHint — all 10 locales.

**Why:** experimental adapters need a safe "prove-yourself" ramp before auto-processing can be enabled, without requiring code changes or a deploy.

**How to apply:** when modifying auto-process paths, check all 5 guard locations; when adding a new experimental family, add to EXPERIMENTAL_FAMILIES in registry.ts only.
