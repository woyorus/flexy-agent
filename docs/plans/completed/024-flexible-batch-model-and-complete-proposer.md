# Plan 024: Flexible Batch Model + Complete Proposer + Proposal Validator

**Status:** Completed
**Date:** 2026-04-09
**Completed:** 2026-04-09
**Affects:** `src/solver/types.ts`, `src/models/types.ts`, `src/agents/plan-proposer.ts`, `src/agents/plan-flow.ts`, `src/qa/validators/proposal.ts` (new), `src/telegram/formatters.ts`, `supabase/schema.sql`, `supabase/migrations/`
**Design doc:** `docs/design-docs/proposals/002-plans-that-survive-real-life.md`
**Depends on:** Nothing — this is the foundation for Plan 025.
**Enables:** Plan 025 (re-proposer agent + flow simplification).

## Problem

The batch model requires consecutive eating days. The proposer can leave gaps (`RecipeGap`) triggering a multi-step gap resolution flow. Both must change:

1. **Batches become fridge-life constrained, not calendar-consecutive.** A batch of 3 can span Wed, Fri, Sat — Thursday is a flex or event day. The hard wall is `recipe.storage.fridgeDays`, not adjacency.
2. **The proposer always outputs complete plans.** The proposer returns `recipesToGenerate: []` (the field stays on the type for mutation handlers until Plan 025). The full recipe DB is passed as context — the LLM picks recipes directly. `fillOrphanSlots()` is removed; the new `validateProposal()` catches uncovered slots and the LLM retries.
3. **A new proposal validator** (`validateProposal()`) gates every proposal before the solver sees it. This replaces the ad-hoc orphan flow gate (`computeUnexplainedOrphans` retry in `handleGenerateProposal`).

After this plan, fresh plan generation works with the new model. Mutations still use old handlers (they produce consecutive batches, which remain a valid subset). Plan 025 replaces mutation handlers with the re-proposer.

## Plan of work

### Phase 1: Type changes + DB migration

**1.1 — `PlanProposal` type** (`src/solver/types.ts:145-154`)
- **Keep** `recipesToGenerate: RecipeGap[]` on the type. The proposer will always return `[]`, but mutation handlers still push to this field (`plan-flow.ts:997`, `plan-flow.ts:1034`) and the post-mutation gate reads it (`plan-flow.ts:1054`). `computeUnexplainedOrphans()` also reads it (`plan-utils.ts:115`). Removing the field would break the mutation path that Plan 025 hasn't replaced yet. Plan 025 deletes the field along with all its writers/readers.
- Add `events: MealEvent[]` field — the proposal becomes the single source of truth for the plan arrangement including events. The initial proposer populates this from its input events (pass-through); the re-proposer (Plan 025) will modify them.
- Keep `RecipeGap` type itself alive — mutation handlers still use it until Plan 025 removes them.

```typescript
export interface PlanProposal {
  batches: ProposedBatch[];
  flexSlots: FlexSlot[];
  events: MealEvent[];
  /** @deprecated Proposer always returns []. Mutation handlers still push here until Plan 025. */
  recipesToGenerate: RecipeGap[];
  solverOutput?: SolverOutput;
}
```

**1.2 — `ProposedBatch` doc update** (`src/solver/types.ts:160-174`)
- Update doc comment: days are no longer required to be consecutive. They must be ascending ISO order, within fridge-life span of the recipe.
- No field changes needed — `days: string[]` already supports non-consecutive.

**1.3 — `PlanFlowState` cleanup** (`src/agents/plan-flow.ts:76-114`)
- Do NOT remove `pendingGaps`, `activeGapIndex`, `recipeGenMessages`, `currentRecipe` yet — mutation handlers still create gaps until Plan 025.
- No changes to flow state in this plan.

**1.4 — `Batch` type doc update** (`src/models/types.ts:206-233`)
- Update `eatingDays` doc comment: no longer required to be contiguous. Fridge-life is the constraint.

**1.5 — DB migration** (`supabase/migrations/004_flexible_batches.sql`)
- Widen servings constraint: `CHECK (servings BETWEEN 1 AND 3)`.
- Update `schema.sql` to match.
- No constraint on eating_days contiguity exists in DB — only in code. No migration needed for that.

### Phase 2: Proposal validator

**2.1 — New file `src/qa/validators/proposal.ts`**

```typescript
export interface ProposalValidationResult {
  valid: boolean;
  errors: string[];   // hard failures — proposal rejected
  warnings: string[]; // soft issues — logged, not blocking
}

export function validateProposal(
  proposal: PlanProposal,
  recipeDb: RecipeDatabase,
  horizonDays: string[],
  preCommittedSlots: PreCommittedSlot[],
): ProposalValidationResult
```

**Invariants to check** (from design doc):

| # | Invariant | Rule | Severity |
|---|-----------|------|----------|
| 1 | Slot coverage | Every `(day, mealType)` in horizon has exactly one source: batch day, flex slot, `proposal.events` entry, or pre-committed slot | error |
| 2 | No overlap | No `(day, mealType)` claimed by two sources | error |
| 3 | Eating days sorted | Each batch's `days` array is ascending ISO order | error |
| 4 | Servings match | `batch.servings === batch.days.length + (batch.overflowDays?.length ?? 0)` | error |
| 5 | Servings range | `1 ≤ servings ≤ 3` | error (warn on 1-serving) |
| 6 | Cook day in horizon | `batch.days[0]` is within `horizonDays` | error |
| 7 | Fridge life respected | `calendarSpan(batch.days[0], lastEatingDay) ≤ recipe.storage.fridgeDays` where `lastEatingDay = overflowDays?.at(-1) ?? days.at(-1)` | error |
| 8 | Flex count | Exactly `config.planning.flexSlotsPerWeek` flex slots | error |
| 9 | Pre-committed slots intact | Every pre-committed slot from input appears as-is (not displaced by a batch or flex) | error |
| 10 | Recipes exist | Every `batch.recipeSlug` exists in the recipe DB | error |
| 11 | Event dates in horizon | Every event's `day` is within horizon | error |
| 12 | Event fields valid | Non-empty `name`, valid `mealTime`, positive `estimatedCalories` | error |
| 13 | No duplicate events | No two events share `(day, mealTime)` | error |

**2.2 — Unit tests** (`test/unit/validate-proposal.test.ts`)
- One test case per invariant above.
- A "valid baseline" test with a well-formed proposal that passes all checks.
- An edge case: non-consecutive batch that passes fridge-life (the new happy path).
- An edge case: non-consecutive batch that violates fridge-life (caught by #7).

### Phase 3: Proposer overhaul

**3.1 — Add fridgeDays to recipe context** (`src/agents/plan-proposer.ts`, `buildRecipeSummaries()` ~line 507)
- Each recipe summary already includes macros, cuisine, tags. Add `fridgeDays` so the LLM knows the fridge-life constraint per recipe.
- Update `PlanProposerInput.availableRecipes` type to include `fridgeDays`.

**3.2 — Retire legacy prompt, unify into single prompt** (`src/agents/plan-proposer.ts`)

Deleted `buildLegacySystemPrompt()` entirely. Removed the `isRolling` dispatch. Single unified `buildSystemPrompt()` that:
- Replaces "consecutive days" with fridge-life constraint.
- Adds `fridgeDays` per recipe to context.
- Allows 1-serving batches (prefer 2-3, allow 1 when needed).
- Relaxes recipe uniqueness to soft preference.
- Removes `recipes_to_generate` from output schema.
- Always outputs complete plans.

**3.5 — Remove `fillOrphanSlots()`** — deleted entirely. Replaced by validator retry.

**3.6 — `proposePlan()` returns discriminated union:**

```typescript
export type PlanProposerOutput =
  | { type: 'proposal'; proposal: PlanProposal; reasoning: string }
  | { type: 'failure'; errors: string[] };
```

### Phase 4: Flow surgery

- Removed `computeUnexplainedOrphans` flow gate from `handleGenerateProposal()` — replaced by `validateProposal()` inside `proposePlan()`.
- Removed `recipesToGenerate.length > 0` branching — proposer never produces gaps.
- Migrated event reads in `buildSolverInput()`, `buildNewPlanSession()`, `formatPlanProposal()` to read from `proposal.events`.
- Graceful abort when `proposePlan()` returns `{type:'failure'}`.

### Phase 5: Display

- Added `formatDayRange()` to `src/plan/helpers.ts` — formats non-contiguous day arrays as compact ranges (e.g., "Wed, Fri–Sat").
- Updated `formatPlanProposal()` and `formatDayDetail()` to use `formatDayRange()`.

### Phase 6: Testing

- Unit tests for all 13 `validateProposal()` invariants in `test/unit/validate-proposal.test.ts`.
- Regenerated scenarios 001, 004, 005, 006, 010, 011, 012, 018, 019, 022.
- Reworked scenario 003 (proposer now returns complete plan with 2 recipes, no gap flow).
- Reworked scenario 014 → `014-proposer-validator-retry` (fixture-edited, validator retry loop).

## Progress

- [x] Phase 1: Type changes + DB migration
- [x] Phase 2: Proposal validator
- [x] Phase 3: Proposer overhaul
- [x] Phase 4: Flow surgery
- [x] Phase 5: Display updates
- [x] Phase 6: Testing

## Decision log

- Decision: Split into Plan 024 (foundation) + Plan 025 (re-proposer). Plan 024 changes generation; Plan 025 changes mutation.
  Rationale: Natural boundary. Between the two plans, mutations still work via old handlers (they produce consecutive batches, a valid subset of the new model). Gap flow stays alive for mutations until Plan 025 removes it.
  Date: 2026-04-09

- Decision: Keep `RecipeGap` type, gap resolution flow, AND `recipesToGenerate` field alive in Plan 024.
  Rationale: Mutation handlers still push to `proposal.recipesToGenerate`. The post-mutation gate reads it. Removing the field would break the mutation path that Plan 025 hasn't replaced yet.
  Date: 2026-04-09

- Decision: Retire `buildLegacySystemPrompt()`, unify into single prompt.
  Rationale: The legacy/rolling split was a Plan 007 strangler-fig. One prompt is simpler and eliminates the risk of the legacy path silently reverting new behavior for fresh plans.
  Date: 2026-04-09

- Decision: Relax recipe uniqueness from hard rule to soft preference.
  Rationale: Hard uniqueness makes coverage impossible with small recipe DBs (scenario 003: 2 recipes, 12 slots).
  Date: 2026-04-09

- Decision: Migrate downstream event reads to `proposal.events`; mutation handlers stay on `state.events` with a sync bridge.
  Rationale: Single-source-of-truth for downstream consumers; mutation handlers can't be migrated without Plan 025.
  Date: 2026-04-09

- Decision: Validator retry replaces both `fillOrphanSlots()` and the orphan flow gate.
  Rationale: One mechanism instead of two. Same "agent proposes, sidecar validates" pattern.
  Date: 2026-04-09

- Decision: Proposer graceful-abort on double validation failure; full clarification path deferred to Plan 025.
  Rationale: With flexible batches and 1-serving batches allowed, even a 2-recipe DB can cover 12 slots. Edge case rare enough for simple abort until Plan 025 clarification infrastructure.
  Date: 2026-04-09
