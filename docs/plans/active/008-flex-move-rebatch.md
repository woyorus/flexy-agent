# Plan 008: Fix flex_move orphan re-batching + horizon-edge carry-over

**Status:** Active
**Date:** 2026-04-06
**Affects:** `src/agents/plan-flow.ts`, `src/solver/types.ts`, scenarios 002/008/013

## Problem

When a user moves a flex slot within the same meal type (e.g., Fri dinner to Sun dinner), the system creates multiple 1-serving gaps instead of intelligently re-batching. The handler resolves each orphan day immediately and independently, so contiguous orphans from a dissolved batch never merge into a multi-serving batch. 1-serving meal preps are a bad UX — nobody wants to cook for a single day.

**User's scenario:**
- Original: Dinner Tue-Wed-Thu (3s), Flex Fri, Dinner Sat-Sun-Mon (3s)
- Request: "move flex to Sunday"
- Expected: Dinner Fri-Sat (2s, reusing dissolved recipe), Flex Sun, Mon-Tue-Wed carry-over (3s)
- Actual: 3 separate 1-serving gaps (Fri, Sat, Mon)

## Plan of work

### Fix 1 — Deferred orphan resolution with contiguous merging

Rewrite the `flex_move` case in `plan-flow.ts:755-791`:

1. **Capture dissolved recipe** before mutation — new `findBatchForDay()` helper
2. **Process "to" side first** — `removeBatchDay(toDay)`, collect orphans
3. **Pool freed fromDay with orphans** if same meal type
4. **Resolve pool** — new `resolveOrphanPool()`:
   - Sort pool, group via `splitIntoContiguousRuns()`
   - Runs >= 2 days: create batch with dissolved recipe (no gap/prompt)
   - Singletons: delegate to `resolveSingletonOrphan()`
   - Overflow orphans: individual absorb-or-reject (unchanged)
5. **Cross-meal-type** moves: fall through to current individual resolution

### Fix 2 — Horizon-edge overflow for singleton orphans

New `resolveSingletonOrphan()` helper:

1. Try `restoreMealSlot()` — extend adjacent batch
2. If within 2 days of horizonEnd: extend into overflow (1-2 days past horizon) → create batch with dissolved recipe if available, else gap with overflow
3. Fallback: standard 1-day gap

Supporting changes:
- `RecipeGap` (`src/solver/types.ts`): add `overflowDays?: string[]`
- `addBatchFromGap()`: propagate `overflowDays` to created batch
- `presentRecipeGap()`: show overflow context in message

### Scenarios

- **Regenerate 002** (`flex-move-regression`): behavior changes, fewer gaps
- **Regenerate 008** (`rolling-flex-move-at-edge`): horizon-edge handling changes
- **New 013** (`flex-move-rebatch-carryover`): exercises user's exact case
- Full verification protocol on each

## Progress

- [ ] Add `overflowDays` to `RecipeGap` type
- [ ] Add `findBatchForDay()` helper
- [ ] Add `resolveOrphanPool()` helper
- [ ] Add `resolveSingletonOrphan()` helper (Fix 2)
- [ ] Rewrite `flex_move` case
- [ ] Update `addBatchFromGap()` and `presentRecipeGap()`
- [ ] `npm test` — expect failures from stale recordings
- [ ] Regenerate scenario 002, verify
- [ ] Regenerate scenario 008, verify
- [ ] Author + generate scenario 013, verify
- [ ] `npm test` — all green

## Decision log

- Decision: Pool orphans and resolve together instead of individually
  Rationale: Contiguous orphans (Fri+Sat) form natural 2-serving batches. Sequential immediate resolution prevents recognizing adjacency because the 3-serving cap blocks absorption before the batch is dissolved.
  Date: 2026-04-06

- Decision: Extend singleton edge-orphans into overflow instead of 1-serving gaps
  Rationale: User constraint — "I don't want to cook one-day meal preps." Overflow carry-over is already supported by the batch model (D30: cook day in-horizon, overflow days past horizon).
  Date: 2026-04-06

- Decision: Reuse dissolved recipe for merged orphan batches (no user prompt)
  Rationale: The orphan days came from that recipe's batch — silently re-batching them with the same recipe is the least surprising behavior. No gap prompt needed for batches that just shifted.
  Date: 2026-04-06

## Validation

1. `npm test` — all scenarios pass
2. Scenario 013 verifies: no 1-serving batches, dissolved recipe reused for Fri-Sat, Mon has overflow carry-over
3. Scenarios 002/008 regenerated and verified per testing.md protocol
4. No D30 invariant violations in any scenario's `finalStore`
