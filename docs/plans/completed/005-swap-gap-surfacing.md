# Plan 005: Surface post-swap recipe gaps

**Status:** Complete
**Date:** 2026-04-05
**Affects:** `src/agents/plan-flow.ts` (swap tail), `docs/product-specs/flows.md`

## Problem

From `logs/debug.log`: user asked "Move flex slot to Saturday" (a `flex_move` from Thu dinner → Sat dinner). The displayed plan came back with the Moroccan beef Fri-Sat-Sun dinner batch silently dissolved, Thu/Fri/Sun dinner uncovered, and every lunch batch showing "1022 cal exceeds maximum 1000. Clamped."

### Root cause

In `src/agents/plan-flow.ts`, the swap tail (line 697-706) after `flex_move`/`flex_add` mutations re-runs the solver and returns `formatPlanProposal` without checking `state.proposal.recipesToGenerate`. The mutation handlers DO create gaps via `absorbFreedDay` when orphaned days can't be reabsorbed into adjacent batches — those gaps end up in `recipesToGenerate` — but they're never surfaced to the user. `flex_remove` (line 660-683) and `recipe_swap` (line 1224-1285) handle this correctly; `flex_move` and `flex_add` are outliers.

Downstream symptom: the solver distributes the weekly budget over whatever batches are left (10 slots in today's case instead of 13), producing per-slot calorie values that get clamped to the 1000 cal max. The user sees a broken plan and has no signal that it's broken.

### Why this matters

Flexie goes into daily production use Monday 2026-04-06. `PRODUCT_SENSE.md` frames adherence as the main variable and friction as existential. A planning flow that silently loses meals violates both — the user cooks to a plan that's missing days, or notices and stops trusting the tool. Either way adherence breaks.

## Plan of work

### 1. Add gap surfacing to the swap tail (`src/agents/plan-flow.ts:697`)

Before the solver re-run, insert:

```typescript
// Surface any gaps created by the mutation (mirrors the initial proposal
// path at line 393-398). Without this, gaps created by absorbFreedDay stay
// invisible and the solver silently redistributes over the wrong slot count.
if (state.proposal.recipesToGenerate.length > 0) {
  state.pendingGaps = [...state.proposal.recipesToGenerate];
  state.activeGapIndex = 0;
  return presentRecipeGap(state);
}
```

This single change fixes `flex_move` AND `flex_add` simultaneously — they share the same bug pattern.

**Note on `pendingGaps` state:** `absorbFreedDay` (line 849-868) currently pushes to both `recipesToGenerate` AND `pendingGaps` (line 865-867). Rebuilding `pendingGaps = [...recipesToGenerate]` at the tail replaces any stale state with a clean snapshot of the canonical list. Spread copies object references, so the identity check at line 839 (`filter(g => g !== gap)`) continues to work during gap resolution.

**Pre-condition:** `pendingGaps` is expected to be undefined at the start of a swap (reset at line 818 when prior gaps resolved, and the initial proposal path cleared it at line 395 when resolving its own gaps). No other cleanup needed.

### 2. Update `docs/product-specs/flows.md:51`

Current text:
> After any swap, the solver re-runs on the mutated proposal and the display is regenerated. `removeBatchDay` never leaves 1-serving batches — orphan days are absorbed via `absorbFreedDay` (extend adjacent batch or create gap).

New text:
> After any swap, if the mutation created any recipe gaps (orphan days that couldn't be reabsorbed into adjacent batches), they are presented via the same inline gap-resolution flow as the initial proposal. Then the solver re-runs on the mutated proposal and the display is regenerated. `removeBatchDay` never leaves 1-serving batches — orphan days are absorbed via `absorbFreedDay` (extend adjacent batch or create gap).

## Progress

- [x] Step 1: gap surfacing conditional in swap tail
- [x] Step 2: `flows.md:51` update
- [x] Step 3: build passes (`npm run build` clean)
- [ ] Step 4: manual Telegram trace against the reported bug scenario

## Decision log

- **Decision**: Fix scope is the gap surfacing conditional only. Reconstruction logic and invariant checker, both proposed in an earlier draft of this plan, are rejected.
  **Rationale**: `BACKLOG.md:71-97` explicitly says "Do NOT restructure in v0.0.4. The current handlers work for shipping" and names `removeBatchDay`, `absorbFreedDay`, and the serving-rule logic as tech debt to be replaced by the v0.0.5 slow-path re-proposer. Adding a `reconstructBatchesFromPool` helper would have been a third sibling in that tech-debt pile — a nicer patch than today's behavior, but still a patch in the area slated for deletion. The invariant checker was speculative infrastructure for a future tests PR and didn't catch today's specific bug anyway. The true proper fix for this class of bug is the v0.0.5 refactor; anything short of that in v0.0.4 is patching. Given that, keep the patch as small as possible.
  **Date**: 2026-04-05

- **Decision**: Accept 3 gap prompts on `flex_move` edge cases as temporary UX debt.
  **Rationale**: Without reconstruction, a flex move that dissolves a 3-serving batch produces 3 gap prompts (one per orphaned day) instead of 1. That's friction on a common action, which `PRODUCT_SENSE.md` flags as adherence-damaging. But: (a) the user is a single dev in week 1 of v0.0.4 who knows the tool is rough, (b) each gap prompt has a [Skip] option that picks any DB recipe, (c) the swap flow is opt-in, (d) the v0.0.5 slow-path re-proposer will replace all of this shortly. The friction is bounded, the fix is temporary, the alternative is churn in a dead-end code area.
  **Date**: 2026-04-05

- **Decision**: Fix `flex_move` AND `flex_add` together even though only `flex_move` was reported.
  **Rationale**: They share the exact same bug pattern in the swap tail. The fix is one conditional that covers both. Not fixing `flex_add` would leave a latent bug waiting for the next report.
  **Date**: 2026-04-05

## Validation

### Trace against the exact bug from `logs/debug.log:51-246`

Starting state after initial proposal:
- Batches: lunch Mon-Wed Chicken (3s), lunch Thu-Fri Tuna (2s), lunch Sat-Sun Pork (2s), dinner Mon-Wed Salmon (3s), dinner Fri-Sun Moroccan beef (3s)
- Flex: Thu dinner
- `recipesToGenerate`: []

User: "Move flex slot to Saturday" → classifier emits `flex_move` Thu dinner → Sat dinner.

Expected execution (unchanged mutation logic, new tail behavior):
1. `flex_move` case: pops Thu flex, pushes Sat flex, calls `removeBatchDay('2026-04-11', 'dinner')`. Moroccan beef b4 contains Sat; residual `[Fri, Sun]` splits into two 1-day runs, both become orphans, b4 is deleted.
2. `absorbFreedDay` is called for each orphan (Fri, Sun) AND for the freed Thu from-day. All three hit the 3-serving max on neighbors → all three become gaps pushed to `recipesToGenerate`.
3. **New tail**: `recipesToGenerate.length === 3` → set `pendingGaps = [Thu dinner, Fri dinner, Sun dinner]`, `activeGapIndex = 0`, return `presentRecipeGap`.
4. User sees: "Thu dinner needs a recipe — I'd suggest any recipe that fits this slot. Generate one, or do you have something specific in mind?" with [Generate] [I have an idea] [Skip] keyboard.
5. User taps [Skip] → picks any unused recipe from DB → advance to Fri dinner gap.
6. Repeat for Fri and Sun.
7. All gaps resolved → `advanceGapOrPresent` re-runs solver (now with 4 batches + 3 newly-resolved batches = 7 total) → shows final plan.

Key signal: the three lunch "1022 cal clamped" warnings from the broken version do NOT appear, because the solver sees 13 slots again (not 10), and per-slot comes out near the target.

### End-to-end verification

1. `npm run build` — no type errors (the change is a single conditional, no type surface changes).
2. `DEBUG=1 npm run dev` — Telegram test: plan the current week, swap → "Move flex slot to Saturday" (or whatever produces the carve scenario). Confirm gap prompts appear instead of silent breakage. Resolve each via [Skip]. Confirm final plan has no calorie clamping warnings.
3. Regression `flex_remove`: plan, swap → "remove the flex meal". Should work unchanged — it already routed through `presentRecipeGap`.
4. Regression `recipe_swap`: plan, swap → "different lunch for Thu-Fri". Should work unchanged — it has its own gap routing.
5. Regression `flex_add`: plan (no flex initially... wait, the proposer always produces 1 flex, so this path is "add a second flex" which triggers the treat-as-move shortcut). Verify this path still works — the shortcut internally does `absorbFreedDay` which may create gaps, and the new tail will now surface them.
6. `logs/debug.log` tail: `[PLAN-FLOW] swap intent: flex_move` → `[PLAN-FLOW] phase → recipe_suggestion` (from `presentRecipeGap`) instead of going straight to proposal rendering.

## Follow-ups (explicitly not in this plan)

- **Tests for swap logic** under the v0.0.4 "Test coverage for critical paths" epic (`BACKLOG.md:54`). First fixture: the scenario from `logs/debug.log`. Assertions: after `flex_move`, either the proposal is fully covered OR `pendingGaps` is non-empty and phase is `recipe_suggestion` — never a silent broken state.
- **Solver + scaling unit tests** per existing backlog entry.
- **Reconstruction logic, if desired** as a UX improvement (3 prompts → 1 prompt on this edge case). Deferred to v0.0.5 where it gets solved properly by the slow-path re-proposer rather than patched into the handlers.
- **Invariant checker** (`validateProposalStructure` pure function) lands with the tests PR where it has immediate purchase — not as speculative infrastructure now.
