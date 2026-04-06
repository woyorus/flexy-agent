# Plan 011: Deterministic Orphan Slot Fill + Flow Gate

**Status:** Active
**Date:** 2026-04-06
**Affects:** `src/agents/plan-proposer.ts`, `src/agents/plan-flow.ts`, `test/scenarios/014-*`

## Problem

The LLM proposer sometimes underfills the week — proposes fewer batches than needed, leaving days with no batch, flex, or event (orphan slots). The QA validator correctly detects orphans (`src/qa/validators/plan.ts:105-121`) but the flow ignores the result (`plan-flow.ts:491-493` — logs a warning, proceeds anyway). The user sees a broken plan. This kills trust with the product.

Identified as TD-001. Observed in scenario 011 where the proposer covered Mon-Thu but left Sat-Sun empty.

## Plan of work

### Phase 1: Extract `restoreMealSlot` to shared module

**From:** `src/agents/plan-flow.ts:1335`
**To:** `src/agents/plan-utils.ts` (new file)

`restoreMealSlot` extends an adjacent batch by one day (forward or backward, respecting the 3-serving cap and overflow logic). Both the proposer (orphan fill, this plan) and the flow (flex-move rebatching, existing) need it. Extract it and import from both call sites.

### Phase 2: Deterministic orphan fill in the proposer

**File:** `src/agents/plan-proposer.ts`

After `mapToProposal` returns (line 121) and after the existing flex-count retry (line 156), add a `fillOrphanSlots` step:

1. Compute the set of all `(day, mealType)` pairs in the horizon: `input.horizonDays ?? input.weekDays` × `['lunch', 'dinner']`.
2. Subtract **all** covered slots:
   - Batch days: `proposal.batches[].days` by mealType
   - Flex slots: `proposal.flexSlots[].day` + mealTime
   - Events: `input.events[]`
   - Pre-committed slots: `input.preCommittedSlots[]`
   - **Recipe gaps: `proposal.recipesToGenerate[].days` by mealType** — these are intentional gaps the proposer identified where the DB lacks variety. They must go through the gap-resolution flow, not be auto-filled.
3. The remainder is true orphan slots — days the proposer simply forgot to cover.
4. For each orphan `(day, mealType)`:
   - Try `restoreMealSlot(proposal, day, mealType)` — extends an adjacent batch if one exists with < 3 servings and the day is adjacent.
   - If `restoreMealSlot` returns false, **emit a `RecipeGap`** — push to `proposal.recipesToGenerate` with a generic suggestion like "Fill uncovered {mealType} slot." This enters the existing gap-resolution flow where the user can generate, provide preferences, or pick an existing recipe. Do NOT create non-adjacent batch extensions or 1-serving batches — both violate the contiguous 2-3 serving batch invariant.
5. Log a warning for every orphan filled: `PLAN orphan fill: {day} {mealType} → extended batch {slug}` or `→ recipe gap`.

**Why in the proposer, not the flow?** The proposer already owns the retry pattern (flex-count, lines 125-156). Orphan fill is the same class of "LLM non-compliance correction." Keeping it here means the flow receives a clean proposal every time — either fully covered by batches or with explicit gaps for the user to resolve.

### Phase 3: Flow gate — never show a broken plan

**File:** `src/agents/plan-flow.ts`

At line 491, after `validatePlan` returns but **before** the recipe-gap check at line 501:

The validator (`plan.ts:105-121`) flags any slot without a `batchId`, `flexBonus`, event, or carried source as a "no source" error. It has no concept of `recipesToGenerate` — so slots covered by pending RecipeGaps will also produce "no source" errors. The gate must distinguish between:

- **Expected "no source" errors** — slots covered by a pending `RecipeGap` in `proposal.recipesToGenerate`. These are fine; the gap flow at line 501 will handle them.
- **Unexpected "no source" errors** — true orphans that survived the deterministic fill. These mean something went wrong.

Implementation — extract a `computeUnexplainedOrphans` helper (reusable by both the gate and `fillOrphanSlots`):

1. Compute all `(day, mealType)` pairs in the horizon.
2. Subtract: batch days (by mealType), flex slots, events, pre-committed slots, **and** `proposal.recipesToGenerate[].days` (by mealType).
3. The remainder is unexplained orphans — slots not covered by any source and not accounted for by a pending RecipeGap.

This avoids parsing validator error strings (brittle coupling to error message copy). The gate uses the same set-difference logic as `fillOrphanSlots` but as a read-only check.

Gate logic:

1. Call `computeUnexplainedOrphans(proposal, input)`. If the result is empty, proceed normally (any "no source" validator errors are explained by pending RecipeGaps).
2. If non-empty (unexpected orphans), silently re-run `proposePlan` + `buildSolverInput` + `solve` (one retry). No intermediate message — the existing "Generating your plan..." covers the latency.
3. After retry, call `computeUnexplainedOrphans` again on the **new** proposal. If still non-empty, return an error response: "I couldn't build a complete plan for this week. Try again or adjust your recipe set." Do NOT present the broken plan. If empty, proceed normally — the retried proposal is clean (any remaining "no source" errors are explained by its RecipeGaps).

**Testing note:** This gate is defense-in-depth. The deterministic fill in Phase 2 should make unexpected-orphan-after-validation impossible. The gate is not exercised by scenario 014 — the harness's fixture replay would mask the retry. Accepted as untested safety net, documented here so future agents don't try to write a test for it.

### Phase 4: Scenario 014 — orphan fill regression test

**File:** `test/scenarios/014-proposer-orphan-fill/spec.ts`

1. Author a scenario spec modeled on scenario 001 (happy path):
   - Use `six-balanced` recipe set (enough recipes that the fix has options)
   - Standard clock, no initial state (fresh plan), no events
   - Events: `/start` → `Plan Week` → keep breakfast → no events → approve

2. Generate fixtures: `npm run test:generate -- 014-proposer-orphan-fill`

3. **Manually edit `recorded.json`** to simulate LLM underfill:
   - Find the proposer's LLM response in the fixture
   - Remove days from an existing batch (or remove a small batch entirely)
   - **Capacity constraint: total orphaned days must not exceed the available adjacent absorption capacity.** For each orphaned `(day, mealType)`, there must be a remaining batch of matching mealType that (a) is adjacent to that day and (b) has fewer than 3 servings. Example: if a 2-serving lunch batch covers Wed-Thu, you can orphan Tue lunch (absorbed backward) or Fri lunch (absorbed forward) — but not both, since the batch hits the 3-serving cap after one absorption. Count capacity before editing.
   - This ensures `restoreMealSlot` absorbs all orphans. The scenario tests the batch-extension path only, not the RecipeGap fallback. (The RecipeGap fallback is already exercised by scenario 003 which uses a minimal recipe set.)
   - Do NOT add those days to `recipes_to_generate` — the point is to simulate the proposer forgetting slots entirely
   - Keep `flex_slots`, `reasoning`, and other fields intact

4. Run `npm test` — the deterministic fill should extend adjacent batches to cover the orphans. The QA validator (`validatePlan`) should return `valid: true` with no orphan errors.

5. Review the recorded output per the verification protocol: every slot covered, no orphan warnings, weekly totals within 3%.

6. Update `test/scenarios/index.md` with the new scenario.

### Phase 5: Update tech-debt.md

Move TD-001 to the Resolved section with a reference to Plan 011.

## Progress

- [x] Extract `restoreMealSlot` to shared module
- [x] Implement `fillOrphanSlots` in plan-proposer.ts
- [x] Add flow gate in plan-flow.ts (never show broken plans)
- [x] Author scenario 014 + manually edit fixture for orphan trigger
- [x] Verify `npm test` passes with all scenarios
- [x] Update tech-debt.md and scenarios index

## Decision log

- Decision: Deterministic fill as primary fix, not LLM retry.
  Rationale: LLM retry is probabilistic (~3s latency, may still fail), deterministic fill is zero-latency and guaranteed. The LLM's variety/rotation choices for covered slots are preserved — we only fill what it missed.
  Date: 2026-04-06

- Decision: Extract `restoreMealSlot` rather than duplicate.
  Rationale: Both proposer (orphan fill) and flow (flex-move rebatching) need adjacent-batch extension. One implementation, two call sites.
  Date: 2026-04-06

- Decision: Flow gate as defense in depth, not sole fix.
  Rationale: The deterministic fill should make orphans impossible. The gate catches anything we missed — the user never sees a plan the system knows is broken. Not covered by scenario tests (harness masks retries) — accepted as untested safety net.
  Date: 2026-04-06

- Decision: Gate uses independent set-difference check, not validator string parsing.
  Rationale: The QA validator has no concept of RecipeGaps and its error messages are human-readable strings. Parsing "(day, mealType)" back out of error text is brittle coupling to copy. Instead, the gate reuses the same `computeUnexplainedOrphans` set-difference logic as `fillOrphanSlots` — computes orphans directly from proposal + input data. Both the first check and the post-retry check use this helper, so the retry path applies the same gap-aware filter as the first pass.
  Date: 2026-04-06

- Decision: Unfillable orphans become RecipeGaps, not 1-serving batches.
  Rationale: Batches must be contiguous 2-3 servings. A 1-serving batch or a non-adjacent day extension violates this invariant. Emitting a RecipeGap routes through the existing gap-resolution flow where the user resolves it. This preserves the contract where gaps are first-class proposer output.
  Date: 2026-04-06

- Decision: Subtract recipesToGenerate from orphan detection.
  Rationale: Recipe gaps are intentional — the proposer identified slots the DB can't cover cleanly. Auto-filling them would bypass the gap flow and silently override the proposer's judgment about variety.
  Date: 2026-04-06

- Decision: Scenario 014 only tests the batch-extension path, with explicit capacity accounting.
  Rationale: The manual fixture edit must orphan only as many days as adjacent batches can absorb (total orphaned days ≤ sum of (3 - currentServings) across adjacent same-mealType batches). This avoids entering the gap-resolution flow, which would need extra events in the scenario spec. The RecipeGap fallback path is already exercised by scenario 003 (minimal recipes force gaps).
  Date: 2026-04-06

- Decision: Drop "Still working on it..." intermediate message.
  Rationale: FlowResponse is `{ text, state }` — single message, no multi-message support. Adding it requires an API change with little value. The existing "Generating your plan..." message covers the retry latency (~3s).
  Date: 2026-04-06

- Decision: Manually edit recorded.json fixture to simulate underfill.
  Rationale: We can't reliably make the real LLM underfill on demand. Editing the fixture gives us a deterministic trigger for the orphan-fill code path.
  Date: 2026-04-06

## Validation

1. `npm test` — all existing scenarios pass (no regressions)
2. Scenario 014 specifically: recorded output shows 14/14 slot coverage despite a proposer response that only covers 10-12 slots
3. QA validator (`validatePlan`) returns `valid: true` with no orphan errors in scenario 014
4. Manual review of scenario 014's `recorded.json` per verification protocol
