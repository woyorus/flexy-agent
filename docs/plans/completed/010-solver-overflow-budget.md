# Plan 010: Fix solver overflow servings leak

**Status:** Complete
**Date:** 2026-04-06
**Affects:** `src/agents/plan-flow.ts`

## Problem

When a batch has overflow days (extends past the horizon end), `buildSolverInput()` leaks total servings (including overflow) into the solver. The solver divides the weekly budget across too many slots, making every meal ~14% smaller than it should be. The user undereats by the exact number of overflow servings × perSlotCal.

Production example: flex_move created a Moroccan Beef batch with 1 in-horizon day (Sun) + 2 overflow days (Mon, Tue). `buildSolverInput` passed `servings: 3` but `days: ['Sun']`. The solver counted 16 slots instead of 14, set perSlotCal to 703 instead of 803, and the user's weekly intake came out 8.2% under target (15,651 vs 17,052 cal).

### Real-world model

Sunday I cook Moroccan Beef — 3 equal portions. I eat one Sunday (this week). Two go in the fridge for Monday and Tuesday (next week). This week's budget should cover what I eat this week (1 portion). Next week's budget should cover what I eat next week (2 fridge portions, fixed). The solver for this week should only see 1 serving from this batch, not 3.

### Root cause

`buildSolverInput()` at `plan-flow.ts:1499` passes `servings: b.servings` (total including overflow) instead of `servings: b.days.length` (in-horizon eating occasions). This violates Plan 007's contract that overflow is invisible to the solver. The solver inflates its slot count, dilutes the per-slot budget, and the daily breakdown (in-horizon only) can't sum back to the weekly target.

Separately, `buildNewPlanSession()` at line 1600 passes `batchTarget.servings` to the scaler. With the fix, `batchTarget.servings` will be the in-horizon count (1), but the scaler needs the total count (3) to produce enough food. Same issue in the fallback path at line 1611.

## Plan of work

### Fix 1 — Stop leaking overflow servings to the solver

**`src/agents/plan-flow.ts` → `buildSolverInput()` (line 1499):**

```typescript
// Before (broken):
servings: b.servings,          // total including overflow

// After:
servings: b.days.length,       // in-horizon eating occasions only
```

The solver now sees 14 slots (not 16), perSlotCal = 803 (not 703), and `weeklyTotals` naturally matches `dailyBreakdown` + treat within ±3%.

### Fix 2 — Use total servings for scaling, not solver servings

**`src/agents/plan-flow.ts` → `buildNewPlanSession()` (lines 1600, 1611):**

Move `eatingDays` computation before the scaler call, then use `eatingDays.length` for scaling:

```typescript
// Compute total eating days (in-horizon + overflow) BEFORE scaling
const overflowDays = proposedBatch?.overflowDays ?? [];
const eatingDays = [...batchTarget.days, ...overflowDays];

// Scaler uses total servings — produce enough food for all portions
const scaled = await scaleRecipe({
  ...
  servings: eatingDays.length,      // was: batchTarget.servings
}, llm);

// Fallback path also uses eatingDays.length
totalForBatch: ing.amount * eatingDays.length,  // was: batchTarget.servings
```

All 3 portions are scaled to the same per-serving target (803 cal). The user cooks 3 equal portions. Next week's solver sees 2 pre-committed slots at 803 cal each (frozen `actualPerServing` from the scaler).

### What doesn't change

- **Solver** (`src/solver/solver.ts`) — no changes. The solver's math was always correct; it was fed wrong input.
- **Solver types** (`src/solver/types.ts`) — no new fields. Update the `RecipeRequest.servings` doc comment to clarify it means in-horizon eating occasions at the solver boundary (currently says "2 or 3 servings per batch" which is misleading post-fix).
- **QA validator** — already uses `output.weeklyTotals.calories`, which will now be correct.
- **Daily breakdown** — overflow days correctly absent (past horizon).
- **Pre-committed slots** — `materializeSlotsFromBatches` uses `actualPerServing` (frozen from scaler). Next week subtracts these from its budget. No double-counting.
- **Plan proposer** — already emits overflow correctly via `mapToProposal()`.

## Progress

- [x] Fix `buildSolverInput()`: `servings: b.days.length`
- [x] Fix `buildNewPlanSession()`: move `eatingDays` before scaler, use `eatingDays.length` for scaling
- [x] Update `RecipeRequest.servings` doc comment in `src/solver/types.ts`
- [x] Update `docs/product-specs/solver.md` to clarify servings is horizon-local at the solver boundary
- [x] Add regression test: `test/unit/build-solver-input.test.ts` — calls `buildSolverInput()` with overflow batch, asserts `servings === days.length`
- [x] `npm test` — stale recordings: 002, 008 (as predicted)
- [x] Regenerate + verify scenarios 002, 008 — warnings gone, weekly totals 17,051 cal (0.006% from 17,052)
- [x] Verify scenarios 005, 009, 010 still pass unchanged
- [x] `npm test` — 59/59 green. Pre-existing QA warning in scenario 011 (replan, 6.6% deviation) is unrelated — present in baseline before this change

## Decision log

- Decision: A horizon owns only meals eaten inside its 7 days, not everything cooked
  Rationale: Matches real life — I eat 1 portion this week, 2 go in the fridge for next week. This week's calorie budget covers this week's eating. Next week's solver picks up the fridge portions via pre-committed slots with frozen macros. No double-counting, no inconsistency between `weeklyTotals` and `dailyBreakdown`.
  Date: 2026-04-06

- Decision: Fix the servings leak in `buildSolverInput` instead of patching the solver's totals
  Rationale: The solver's math was always correct — it was fed inflated servings. Patching totals (adding overflow calories back) would have hardened the wrong model: session A claiming calories eaten in session B's window, `weeklyTotals` diverging from `dailyBreakdown`, and downstream formatters unable to reconcile. Fixing the input is a 3-line change with no new types or abstractions.
  Date: 2026-04-06

- Decision: Scaler uses `eatingDays.length` (total portions), not `batchTarget.servings` (in-horizon)
  Rationale: The scaler answers "how much food to cook," not "how many meals this week." A batch with 1 in-horizon + 2 overflow needs 3 portions of food at the per-serving target. All portions are equal (same recipe, divided equally). The per-serving target comes from the solver's in-horizon budget — a slightly higher target than the old buggy version, meaning larger meals that actually hit the user's weekly calorie goal.
  Date: 2026-04-06

## Validation

1. `npx tsc --noEmit` — clean compile
2. Regression unit test: call `buildSolverInput()` with a proposal containing an overflow batch (`days: [Sun], overflowDays: [Mon, Tue], servings: 3`), assert the emitted `RecipeRequest` has `servings: 1` (matching `days.length`). This catches the exact regression site — `plan-flow.ts` mapping, not solver math.
3. Regenerate scenarios **002** and **008** — both currently show 8.2% calorie deviation + protein shortfall. After the fix, warnings must disappear and weekly totals must be within ±3% of 17,052 cal.
4. Scenarios 005, 009, 010 have overflow in `finalStore` but no solver-visible mismatch in the current recordings (`mapToProposal()` preserves raw LLM `servings` which happens to match `days.length` in these fixtures — empirical, not a code invariant). No change expected — verify they still pass.
5. `npm test` — all green, zero ⚠️ warnings in any committed recording.
