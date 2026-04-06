# Rolling Horizons and First-Class Batches

> Status: accepted
> Date: 2026-04-06
> Full history: [plans/active/007-rolling-horizon-and-first-class-batches.md](../plans/active/007-rolling-horizon-and-first-class-batches.md)

## Problem

The original data model treated the Mon-Sun calendar week as the atomic planning unit. A `WeeklyPlan` embedded cook days, meal slots, and batches in a single JSONB blob. This design created three escalating problems:

1. **Edge orphans.** Any mutation near the week boundary (flex move, recipe swap) could strand a 1-day residual that the system either cooked absurdly for 1 serving, prompted a "generate a recipe for 1 meal" gap, or silently dropped. The trigger bug: moving a flex slot to Saturday dinner dissolved Sunday dinner into a 1-serving orphan.

2. **Cross-week invisibility.** Real meal prep crosses week boundaries constantly — a batch cooked Sunday feeds you into Tuesday. The weekly silo forced all batches to fit inside one `WeeklyPlan`, so cross-week batches were invisible, duplicated, or silently dropped.

3. **Cook-day drift.** `CookDay` and `MealSlot` were persisted as denormalized views. Any mutation that changed batch assignments but didn't update the corresponding cook day or meal slot created a silent inconsistency. Plan 005's gap-surfacing fix was a direct consequence of this drift class.

Every downstream feature on the v0.0.5 roadmap — tracking, running budget, mid-week adjustment — would require designing around these three problems if the weekly model stayed. Building on it meant double work: work around the silo now, then port when the silo is eventually removed.

## Options considered

1. **Patch the weekly model.** Add cross-week references to `WeeklyPlan`, fix edge cases one by one. Rejected: each patch adds complexity to a model that's fundamentally misaligned with how cooking works. The patch surface grows with every v0.0.5 feature.

2. **Variable-length horizons.** Let the user choose 5, 7, or 10 day horizons. Rejected as premature generalization — 7 days is the only horizon that matters for v0.0.4, and variable length adds combinatorial complexity to the solver and proposer without a concrete user need.

3. **Rolling 7-day horizons with first-class batches.** Replace the weekly silo with a rolling model where the planning unit is a 7-day horizon and the cooking unit is a batch with its own lifecycle. Batches span horizons naturally; carry-over between sessions is a query, not a copy.

## Decision

Option 3. The implementation is a strangler-fig refactor (14 commits, 8 phases) that replaced the entire persistence and planning model while keeping the system operational at every intermediate step.

### Core model

**Plan sessions** are lightweight markers: horizon range, breakfast, treat budget, flex slots, events, confirmed timestamp. They do NOT embed batches. "What batches are in this session" is a query (`WHERE created_in_plan_session_id = ?`).

**Batches** are first-class Supabase entities with stable UUIDs. Each batch has `eatingDays` (2-3 contiguous ISO dates), a `status` (`planned` | `cancelled`), and an immutable `createdInPlanSessionId` linking it to the session that created it. Cook day is always `eatingDays[0]` — derived at display time, never stored.

**Batches span horizon boundaries.** A batch cooked on day 7 of session A can have eating days extending into session B's horizon. The solver sees only in-horizon days; overflow days become pre-committed slots when session B plans.

**Pre-committed slots** are materialized projections of prior sessions' batches into the current horizon. They carry frozen macros (the session A solver's per-slot target, not session B's) and are read-only — the user cannot edit them from the new session's swap flow.

### Horizon computation

`computeNextHorizonStart` uses three explicit store queries in fallback order:

1. `getFuturePlanSessions()` — if a future session exists, offer to replan it (D27).
2. `getRunningPlanSession()` — continuous rolling: new horizon starts the day after the running session ends.
3. `getLatestHistoricalPlanSession()` — gap fallback: new horizon starts tomorrow.

There is no `getCurrentPlanSession()`. "Current" is not a single concept in the rolling model — it splits into running, future, and historical, and each consumer picks the one that matches its intent.

### Replan flow (D27)

When the user taps Plan Week and a future-only session exists, the system offers "Replan it?" with Confirm/Cancel. On Confirm, a fresh planning flow starts with `replacingSessionId` stored in the draft state. The old session stays live throughout the draft. On Approve, `confirmPlanSessionReplacing` runs a four-step save-before-destroy sequence: (1) insert new session, (2) insert new batches, (3) cancel old batches, (4) mark old session superseded. On Cancel or abandon, the old session is untouched — save-before-destroy guaranteed by write ordering.

### Budget math with carry-over

The solver subtracts pre-committed slot calories and protein from the weekly budget before distributing to new batches:

```
mealPrepBudget = weeklyTarget - breakfast×7 - events - flexBonuses - treatBudget - preCommittedCal
perSlotCal = mealPrepBudget / newSlotCount
```

Pre-committed slots are NOT counted in `newSlotCount` — they're already subtracted from the numerator. A pre-committed slot's calories in the daily breakdown use its frozen value from session A, not session B's per-slot target. Days with pre-committed slots and new batches show different per-meal calorie values — this is intentional and mathematically correct.

### Persistence without transactions

All multi-row writes go through two methods on `StateStoreLike`: `confirmPlanSession` (2 sequential Supabase calls) and `confirmPlanSessionReplacing` (4 sequential calls). No pl/pgsql RPC functions — rejected as overkill for a single-user prototype. The FK constraint (`ON DELETE RESTRICT`) is the safety net. Partial-failure modes are self-healing on retry and logged to `debug.log` for diagnosability.

### Explicit `horizonDays` on SolverInput (D32)

The old solver derived its day set from `recipes[].days + flexSlots[].day`, silently missing any day covered only by an event or pre-committed slot. The new solver requires an explicit `horizonDays: string[]` of length 7, producing a daily breakdown row for every day regardless of source coverage. This closed a latent bug that was masked by the invariant that old plans always had a batch or flex on every day.

### Draft lifecycle (D33)

Drafts are in-memory only. No `proposed` batch status, no nullable `confirmed_at`. Every row in `plan_sessions` has `confirmed_at NOT NULL`; every row in `batches` has `status IN ('planned', 'cancelled')`. The `ProposedBatch` type in `solver/types.ts` is the in-memory draft; it becomes a `Batch` only at confirm time in `buildNewPlanSession`.

### Ownership invariant (D30)

Every persisted batch has `eatingDays[0]` (cook day) inside its creating session's `[horizonStart, horizonEnd]`. This is asserted at confirm time in `buildNewPlanSession`. Swap handlers that would violate this invariant (e.g., carving the only in-horizon day from a cross-horizon batch) reject the mutation and surface a user-facing error rather than producing a batch with an out-of-horizon cook day.

## Why

**Why rolling horizons, not patched weeks:** The week is a calendar artifact. The actual unit of cooking is a 2-3 day batch that starts on any day and may span any boundary. Every downstream feature (tracking asks "which batch did I consume from," running budget asks "what's scheduled vs consumed," mid-week replanning asks "mutate the remaining batches") is cleaner when batches are cross-horizon entities with stable IDs.

**Why first-class batches, not embedded arrays:** A batch cooked Sunday for Sun-Mon-Tue spans two plan sessions. Embedding it in one session means the other has to duplicate knowledge or lose visibility. First-class batches with their own table make cross-session queries (`getBatchesOverlapping`) natural.

**Why frozen macros on carry-over:** Session A solved at 790 cal/slot. Session B solves at 820 cal/slot (different constraint mix). Carry-over meals appear at 790 in session B's daily breakdown. Recomputing them at 820 would silently change what the user committed to eating in session A. Freezing preserves intent.

**Why save-before-destroy, not delete-then-create:** The original replan flow superseded the old session before starting the new draft. If the user abandoned the draft, they had no plan at all. Save-before-destroy (write new state fully, then mark old as superseded) guarantees the old session survives any abandonment path.

**Why client-side write ordering, not pl/pgsql:** Adding a new language (Postgres functions) to the codebase for a single-user prototype with ~6 rows per confirm is net-negative complexity. The sequential Supabase JS calls provide the same ordering guarantee with better debuggability. The FK constraint catches accidental deletes. If partial writes ever appear in production logs, the upgrade path to RPC functions is straightforward.

**Why no batch tracking states:** `cooked` and `consumed` are v0.0.5 concepts that depend on tracking UX decisions not yet made. Pre-modeling them adds columns that sit unused and constrain future design. Whatever tracking looks like, it will infer state from time or integrate with photo/voice — not use explicit "mark as cooked" buttons (that's friction).

## Surprises during implementation

1. **Ghost batch bug in gap resolution.** When the user skipped a recipe gap via "Pick from my recipes," `addBatchFromGap` added a replacement batch but didn't remove the original gap's placeholder batch. This produced 0-calorie ghost batches that `deepStrictEqual` locked in as correct. Caught only by reading scenario 003's output as a user would — the canonical example of why scenario verification matters. Fixed by making `addBatchFromGap` remove any existing batch covering the same (days, mealType) before adding the replacement.

2. **Proposer prompt backward compatibility.** Changing the system prompt text broke existing scenario fixture hashes (the LLM call hash includes prompt content). Solved by gating the rolling-horizon prompt on whether pre-committed slots exist — fresh plans (no carry-over) use the legacy prompt during the strangler-fig, preserving fixture hashes. Phase 7b switched everything to rolling-only and re-recorded all scenarios.

3. **Calorie deviation with carry-over.** When session A's frozen per-slot target (792 cal) differs from session B's computed target (~803 cal), the weekly total can deviate beyond the 3% QA threshold. This is mathematically correct — it's the cost of honoring frozen commitments — but the validator flags it. Logged to tech-debt as a tolerance-threshold question for v0.0.5.

4. **Proposer underfill.** The LLM occasionally proposes fewer batches than needed to cover all 14 slots, leaving orphan days. The slot math in the prompt is explicit, but the model doesn't always comply. Logged to tech-debt with three fix options (retry, post-proposal fill, prompt emphasis). Not a structural issue — the QA validator catches it.

## Outcomes

- **10 scenarios**, all recorded against real LLM and verified for behavioral correctness.
- **56 tests** (17 unit tests + 6 solver tests + 10 scenario replays + 23 harness/parser tests), all green.
- **Deleted types:** `WeeklyPlan`, `CookDay`, `MealSlot`, `LegacyBatch`, `FunFoodItem` (from plan contexts).
- **Deleted methods:** `savePlan`, `getCurrentPlan`, `getLastCompletedPlan`, `getRecentCompletedPlans`, `completeActivePlans`.
- **New Supabase tables:** `plan_sessions`, `batches` (migration 001). `weekly_plans` dropped (migration 002).
- **No production data lost:** No real production usage existed before this migration. Hard-cut was the right call.
- **The ghost batch bug** was found and fixed during this implementation — a bug that predated Plan 007 but was only visible when scenario 003 was reviewed for quality. This validated the scenario verification protocol as a load-bearing part of the development process.
