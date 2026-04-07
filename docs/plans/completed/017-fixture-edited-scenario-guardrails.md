# Plan 017: Fixture-Edited Scenario Guardrails

**Status:** Completed
**Date:** 2026-04-07
**Affects:** `docs/product-specs/testing.md`, `src/harness/generate.ts`, `src/harness/replay.ts`, `test/scenarios/014-proposer-orphan-fill/fixture-edits.md`, `test/scenarios/014-proposer-orphan-fill/*`

## Problem

Scenario 014 relies on a manually edited LLM fixture to simulate proposer underfill. That is a reasonable escape hatch for defensive code paths that the real LLM will not reliably produce, but the current workflow has two unacceptable failure modes:

1. Some instructions still tell the operator to run `npm run test:generate -- <name> --regenerate` after editing the fixture. That command calls the real LLM and rewrites `llmFixtures`, destroying the manual edits.
2. A regenerated valid fixture can still pass the scenario because replay is deterministic against whatever fixtures are present. If the manual underfill edit is missing, the test no longer exercises `fillOrphanSlots`, but the harness has no machine check that fails.

The documentation in `docs/product-specs/testing.md` already describes the right high-level workflow: generate valid fixtures, edit only `llmFixtures`, run `test:replay`, then run `npm test`. The implementation and scenario-local instructions need to be aligned with that workflow, and the fixture-edited scenario needs a guardrail that proves the edited fixture is still intentionally malformed.

## Plan of work

### Phase 1: Align the human-facing workflow

**Files:**
- `src/harness/generate.ts`
- `test/scenarios/014-proposer-orphan-fill/fixture-edits.md`
- `docs/product-specs/testing.md`

Change the generator warning for directories with `fixture-edits.md` so it tells the operator:

1. Apply the edits described in `fixture-edits.md`.
2. Run `npm run test:replay -- <scenario-name>`.
3. Review `recorded.json` via `git diff`.
4. Run `npm test`.

Remove the stale instruction that says to run `--regenerate` after editing. Update scenario 014's `fixture-edits.md` to say the same thing. Keep `docs/product-specs/testing.md` as the canonical workflow, but add a note that scenario-local `fixture-edits.md` files and generator warnings must point to `test:replay`, never to `--regenerate`, after edits have been applied.

### Phase 2: Add a machine-readable fixture edit assertion hook

**Files:**
- `src/harness/replay.ts`
- `src/harness/runner.ts` or a new small harness helper
- `test/scenarios.test.ts`
- `test/scenarios/014-proposer-orphan-fill/fixture-assertions.ts` (new)

Add an optional scenario-local assertion module, loaded by convention if present:

```typescript
// test/scenarios/<name>/fixture-assertions.ts
import type { RecordedScenario } from '../../../src/harness/types.js';

export function assertFixtureEdits(recorded: RecordedScenario): void {
  // Throw with a clear message if the edited fixture is not present.
}
```

Use a shared helper such as `runFixtureEditAssertions(dir, recorded)` so `replay.ts` and `test/scenarios.test.ts` both apply the same check before running the scenario. If no assertion file exists, do nothing.

For scenario 014, parse the first proposer fixture response as JSON and assert the specific underfill edits are present:

- The chicken lunch batch does not include `2026-04-08` and has `servings === 2`.
- The salmon dinner batch does not include `2026-04-07` and has `servings === 1`.
- Those missing slots are not present in `flex_slots` or `recipes_to_generate`.

The assertion error should explain the fix:

```text
Scenario 014 fixture edits are missing. Run:
  npm run test:generate -- 014-proposer-orphan-fill --regenerate
Then re-apply fixture-edits.md and run:
  npm run test:replay -- 014-proposer-orphan-fill
```

### Phase 3: Keep fixture replay strictly expected-only

**Files:**
- `src/harness/replay.ts`
- `docs/product-specs/testing.md`

Confirm `test:replay` preserves `llmFixtures` byte-for-byte except for JSON formatting. If the current implementation already does this, leave behavior unchanged and document it explicitly in the workflow section.

Do not add an option that edits fixtures automatically in this phase. The goal is to make the manual process safe and reviewable, not to hide the fixture mutation behind another generator.

### Phase 4: Regression coverage for the guardrail itself

**Files:**
- `test/unit/*` or a focused harness unit test file
- `test/scenarios/014-proposer-orphan-fill/fixture-assertions.ts`

Add focused unit coverage for the assertion helper if it is not too costly:

- No assertion module present: helper returns without error.
- Assertion module present and passes: helper returns without error.
- Assertion module present and throws: helper surfaces the scenario-specific error.

For scenario 014, prefer a small direct test of `assertFixtureEdits` if the recorded fixture shape can be loaded cheaply. It should fail against an intentionally valid proposer response and pass against the edited fixture.

## Progress

- [x] Update generator warning to point to `test:replay`, not post-edit `--regenerate`.
- [x] Update scenario 014 `fixture-edits.md` after-edit instructions.
- [x] Tighten `docs/product-specs/testing.md` with the canonical post-edit rule.
- [x] Add optional scenario-local fixture edit assertion hook.
- [x] Add scenario 014 assertions that prove the underfill fixture is still malformed.
- [x] Add focused tests for the assertion hook or scenario assertion.
- [x] Run `npm test`.

## Decision log

- Decision: Keep manual fixture edits as an escape hatch rather than replacing them with an automated mutator.
  Rationale: The scenario is intentionally testing malformed LLM output that the real LLM will not reliably emit. Manual edits are acceptable if they are documented, reviewed in `git diff`, and protected by a machine assertion.
  Date: 2026-04-07

- Decision: Add a scenario-local assertion hook instead of teaching the generic harness about scenario 014's meal-specific underfill.
  Rationale: The harness should know how to load and run assertions, but it should not embed scenario-specific recipe names, days, or business expectations. Keeping those checks next to `fixture-edits.md` makes the intent discoverable and keeps the generic harness small.
  Date: 2026-04-07

- Decision: Run fixture edit assertions in both `test:replay` and normal `npm test`.
  Rationale: `test:replay` catches missing edits before it rewrites `expected`, and `npm test` catches the dangerous steady state where a valid regenerated fixture was committed by mistake.
  Date: 2026-04-07

- Decision: Do not let `test:replay` rewrite `llmFixtures`.
  Rationale: Its purpose is to recompute `expected` from existing fixtures. Any fixture mutation should stay visible as a manual edit, at least until there is a separate reviewed design for deterministic fixture transforms.
  Date: 2026-04-07

## Validation

1. `npm run test:generate -- 014-proposer-orphan-fill --regenerate` prints instructions that say to apply `fixture-edits.md`, then run `npm run test:replay -- 014-proposer-orphan-fill`.
2. After applying the documented edits, `npm run test:replay -- 014-proposer-orphan-fill` succeeds and rewrites only `expected`.
3. `npm test` passes with the edited scenario 014 fixture.
4. If scenario 014 is regenerated and the manual fixture edits are not re-applied, `npm test` fails with a clear fixture-edit assertion error before the scenario can silently pass against valid LLM output.
5. `git diff` shows no accidental `llmFixtures` rewrite from `test:replay`.

## Feedback
