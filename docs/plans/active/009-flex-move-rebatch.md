# Plan 009: Fix flex_move orphan re-batching + horizon-edge carry-over

**Status:** Done
**Date:** 2026-04-06
**Affects:** `src/agents/plan-flow.ts`, `src/solver/types.ts`, scenarios 002/008/009/013

## Problem

When a user moves a flex slot within the same meal type (e.g., Fri dinner to Sun dinner), the system creates multiple 1-serving gaps instead of intelligently re-batching. The handler resolves each orphan day immediately and independently, so contiguous orphans from a dissolved batch never merge into a multi-serving batch. 1-serving meal preps are a bad UX — nobody wants to cook for a single day.

The same sequential-resolution bug also exists in `flex_add` at capacity (lines 721-728), which degrades into a move-like mutation.

**User's scenario:**
- Original: Dinner Tue-Wed-Thu (3s), Flex Fri, Dinner Sat-Sun-Mon (3s)
- Request: "move flex to Sunday"
- Expected: Dinner Fri-Sat (2s, reusing dissolved recipe), Flex Sun, Mon-Tue-Wed carry-over (3s)
- Actual: 3 separate 1-serving gaps (Fri, Sat, Mon)

## Plan of work

### Fix 1 — Deferred orphan resolution with contiguous merging

Rewrite the `flex_move` case (`plan-flow.ts:755-791`) and `flex_add` at-capacity path (`plan-flow.ts:717-753`):

1. **Snapshot mutation-relevant state** before any mutation — deep-copy `state.proposal`, `state.pendingGaps`, `state.activeGapIndex`, and `state.phase` for rollback on failure. `absorbFreedDay` mutates `pendingGaps` (line 1036-1037) as a side effect outside `proposal`, so snapshotting only `proposal` is insufficient.
2. **Capture dissolved recipe** before mutation — new `findBatchForDay()` helper
3. **Process "to" side first** — `removeBatchDay(toDay)`, collect orphans
4. **Pool freed fromDay with orphans** if same meal type
5. **Resolve pool** — new `resolveOrphanPool()`:
   - Sort pool, group via `splitIntoContiguousRuns()`
   - Runs >= 2 days: create batch with dissolved recipe directly (no gap/prompt)
   - Singletons: delegate to `resolveSingletonOrphan()`
   - Overflow orphans: individual absorb-or-reject (unchanged)
6. **On failure (overflow orphan unabsorbable):** restore `proposal`, `pendingGaps`, `activeGapIndex`, and `phase` from snapshot, return rejection text. Draft is unchanged from the user's perspective.
7. **Cross-meal-type** moves: fall through to current individual resolution (each side independent)

Apply the same pattern to `flex_add` at capacity: the freed flex days and the new flex's carved orphans are pooled and resolved together instead of sequentially.

### Fix 2 — Horizon-edge silent carry-over for singleton orphans

New `resolveSingletonOrphan()` helper:

1. Try `restoreMealSlot()` — extend adjacent batch
2. If within 2 days of horizonEnd AND dissolved recipe is available: create batch **directly** with overflowDays (cook day in-horizon, 1-2 overflow days past horizon). No gap surfaced — same as proposer carry-over. D30 satisfied. Respects the rule that overflow days cannot be gap-surfaced (plan-flow.ts:1003).
3. If within 2 days of horizonEnd but NO dissolved recipe: create standard 1-day gap (fallback — shouldn't happen in practice since the dissolved recipe comes from the carved batch)
4. Else: standard 1-day gap

**No changes to RecipeGap type.** Overflow carry-over batches are created directly, not through gap-surfacing. `presentRecipeGap()` and `addBatchFromGap()` stay unchanged for overflow.

### Fix 3 — Batch identity in `buildNewPlanSession`

`buildNewPlanSession:1295` looks up `proposedBatch` via `.find(b => slug && mealType)` — returns first match only. After Fix 1, two batches with the same (recipeSlug, mealType) are possible (e.g., Moroccan Beef Fri-Sat + Moroccan Beef Mon carry-over).

Fix: add `days[0]` to the `.find()` predicate so the lookup is unique:
```
proposal.batches.find(b => b.recipeSlug === target.recipeSlug
  && b.mealType === target.mealType
  && b.days[0] === target.days[0])
```

### Scenarios

- **Regenerate 002** (`flex-move-regression`): behavior changes, fewer gaps
- **Regenerate 008** (`rolling-flex-move-at-edge`): horizon-edge handling changes
- **Regenerate 009** (`rolling-swap-recipe-with-carryover`): may be affected by batch identity fix
- **New 013** (`flex-move-rebatch-carryover`): exercises user's exact case — no 1-serving batches, dissolved recipe reused, carry-over at horizon edge
- **New 014** (`flex-move-overflow-rejection-rollback`): flex_move to a position that strands overflow orphans — verifies rejection text returned AND proposal/pendingGaps/phase unchanged
- Full verification protocol on each

## Progress

- [x] Add `findBatchForDay()` helper
- [x] Add `resolveOrphanPool()` helper
- [x] Add `resolveSingletonOrphan()` helper (Fix 2 — silent carry-over)
- [x] Add snapshot/rollback (proposal + pendingGaps + activeGapIndex + phase) to `flex_move` case
- [x] Rewrite `flex_move` case with deferred resolution
- [x] Apply same pattern to `flex_add` at-capacity path
- [x] Fix batch identity lookup in `buildNewPlanSession` (Fix 3)
- [x] `npm test` — 2 expected failures (002, 008)
- [x] Regenerate scenarios 002, 008 — verified each (009 passed without changes)
- [x] Author + generate scenario 013 (`flex-move-rebatch-carryover`), verified
- [x] Author + generate scenario 014 — implemented as unit test (`test/unit/flex-move-rollback.test.ts`) because overflow rejection requires contrived state the proposer doesn't naturally produce
- [x] `npm test` — all 58 tests green

## Decision log

- Decision: Pool orphans and resolve together instead of individually
  Rationale: Contiguous orphans (Fri+Sat) form natural 2-serving batches. Sequential immediate resolution prevents recognizing adjacency because the 3-serving cap blocks absorption before the batch is dissolved.
  Date: 2026-04-06

- Decision: Create carry-over batches directly, NOT through gap-surfacing
  Rationale: Plan 007 rule (plan-flow.ts:1003): overflow days cannot be gap-surfaced because the user can't see out-of-horizon days. The proposer already creates overflow batches silently — swap mutations should do the same when the dissolved recipe is known. Keeps `RecipeGap` unchanged.
  Date: 2026-04-06 (revised after review)

- Decision: Reuse dissolved recipe for merged orphan batches (no user prompt)
  Rationale: The orphan days came from that recipe's batch — silently re-batching them with the same recipe is the least surprising behavior. No gap prompt needed for batches that just shifted.
  Date: 2026-04-06

- Decision: Snapshot full mutation-relevant state (proposal + pendingGaps + activeGapIndex + phase), restore on failure
  Rationale: Plan 007 contract says "rejection with rollback." Current code mutates in place and returns rejection text with a partially mutated draft. `absorbFreedDay` also mutates `pendingGaps` (line 1036-1037) as a side effect outside `proposal`, so restoring only `proposal` leaves stale gap state. Pre-existing bug but must be fixed as part of this change.
  Date: 2026-04-06 (revised after second review)

- Decision: Fix batch identity lookup to include days[0]
  Rationale: buildNewPlanSession:1295 uses (recipeSlug, mealType) which is not unique when the same recipe appears in two batches of the same meal type (e.g., after re-batching). Adding days[0] makes the lookup unambiguous. The first eating day uniquely differentiates batches within a (slug, mealType) pair.
  Date: 2026-04-06 (added after review)

- Decision: Include flex_add at-capacity in scope
  Rationale: Same sequential absorbFreedDay pattern at lines 721-728. Same helpers apply. Leaving it unfixed creates an inconsistency and the same user-facing 1-serving gap problem.
  Date: 2026-04-06 (added after review)

## Validation

1. `npm test` — all scenarios pass
2. Scenario 013 verifies: no 1-serving batches, dissolved recipe reused for merged run, horizon-edge orphan gets silent carry-over batch (not a gap)
3. Scenarios 002/008/009 regenerated and verified per testing.md protocol
4. No D30 invariant violations in any scenario's `finalStore`
5. No duplicate (recipeSlug, mealType, days[0]) in any scenario's final proposal
6. Rollback: scenario 014 verifies flex_move to a position that strands overflow orphans returns rejection text AND full state (proposal, pendingGaps, activeGapIndex, phase) is unchanged
