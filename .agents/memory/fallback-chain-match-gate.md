---
name: Ordered program+language fallback chain
description: How the auto fallback chain generator interacts with matchProgram's confidence gate and level matching; test fixture constraints.
---

# Ordered program+language fallback chain (auto path)

The auto fallback chain (generateProgramChain in lib/portal-runner/src/fallback.ts) runs
when portalAutomationSettings.fallbackEnabled is ON and NO admin rule matches. Admin rule
ALWAYS wins precedence. Chain = step2 (same-language nearest fuzzy) then step3 (applied
program in opposite language, only if applied has a language marker). Step1 = existing
submission, always excluded. LEVEL always matches via shared levelGroup.

## Non-obvious constraints (cost multiple attempts)

- **matchProgram is a strict confidence/margin gate, not a loose search.** step2 only
  resolves to a *near-identical same-language variant* (e.g. "Computer Engineering
  (English)" → "Computer Engineering Program (English)" ≈ conf 0.75). Unrelated names
  ("Computer Engineering" → "Software Engineering") return **null**. A single
  opposite-language candidate matches ≈ conf 0.667. **Why:** the margin gate rejects weak
  matches to avoid superseding into a wrong program. **How to apply:** any fixture or
  real-catalog expectation for step2 must be a genuinely close variant of the applied
  name, with far distractors (e.g. Medicine) present to prove the margin gate; do not
  expect distant programs to be picked.

- **generateProgramChain filters by levelGroup(applied.level) vs levelGroup(p.degree).**
  If the source application has `level = null`, levelGroup(null) mismatches catalog
  `bachelor` and the chain comes back EMPTY ("produced no untried candidate"). **How to
  apply:** integration fixtures that seed applications for the auto path MUST set
  `level` (e.g. "bachelor") on the application rows, not just on the pure-generator input.

## Test harness
- Tests live in lib/portal-runner/scripts/test-fallback.ts; run
  `pnpm --filter @workspace/portal-runner test:fallback` (~80s). FB-G* = pure generator,
  FB-A* = integration auto path. seedAutoScenario builds X (same-uni, mainApplicationId
  null) and Y (diff-uni, mainApplicationId set) scenarios.
