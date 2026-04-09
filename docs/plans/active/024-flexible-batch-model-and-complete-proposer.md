# Plan 024: Flexible Batch Model + Complete Proposer + Proposal Validator

**Status:** Active
**Date:** 2026-04-09
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

The proposer currently has two prompt paths:
- `buildLegacySystemPrompt()` (line 301) — used when no pre-committed slots exist (i.e., most fresh plans). Hardcodes consecutive batches (line 311, 335), `recipes_to_generate` output (line 387), and "recipe can only appear in ONE batch" (line 334).
- `buildSystemPrompt()` rolling-horizon path (line 182) — used only when pre-committed slots exist. Also hardcodes consecutive batches (line 192, 216) and `recipes_to_generate` (line 283).

The legacy/rolling split was a strangler-fig from Plan 007. Plan 024 re-records all scenarios anyway, so the strangler-fig is complete. **Delete `buildLegacySystemPrompt()` entirely.** Remove the `isRolling` dispatch (line 176-180). Write a single unified prompt in `buildSystemPrompt()` that:

- Replaces "consecutive days" with the new batch model: eating days need NOT be consecutive. Events and flex meals in the middle are fine.
- Adds fridge-life hard constraint: `calendarSpan(first eating day, last eating day) ≤ fridgeDays` for the recipe. Each recipe summary includes its `fridgeDays`.
- Allows 1-serving batches: "Prefer 2-3 serving batches. 1-serving is allowed only when no multi-serving arrangement fits."
- Replaces the "recipe can only appear in ONE batch" rule (see 3.2a below).
- Removes the `recipes_to_generate` section from the output schema (proposer always outputs complete plans).
- Removes the "RECIPE GAPS" section entirely — the proposer doesn't identify gaps.
- Always outputs a complete plan: "Every non-event, non-flex, non-pre-committed slot must have a batch. Never leave gaps."
- Conditionally includes pre-committed slot instructions (when present), same as the rolling path does today.

**3.2a — Relax recipe uniqueness rule**

Both prompts currently say "A recipe can only appear in ONE batch per week" (lines 215, 334). This makes complete coverage impossible with a small recipe DB (e.g., scenario 003 with 2 recipes). Replace with:

"Prefer unique recipes across batches for maximum variety. When the recipe DB is too small to cover all slots with unique recipes, reuse recipes across batches — this is better than leaving gaps. Within the same day, avoid the same recipe for both lunch and dinner."

This is a soft preference, not a hard constraint. The validator does not enforce recipe uniqueness — it only checks slot coverage, fridge-life, and servings.

**3.2b — Update user prompt slot math** (`src/agents/plan-proposer.ts`, `buildUserPrompt()` ~line 467-496)

The current user prompt includes gap-era logic that contradicts the new model:
- Line 473: `maxCoverageWith3Serving = availableRecipes.length * 3` — assumes each recipe is used exactly once.
- Line 491: "you MUST generate N new recipe(s)" — directs the LLM to emit `recipes_to_generate` entries.
- Line 489: "✓ Existing recipes CAN cover all slots — do NOT generate new recipes" — references gap generation.

Replace with slot math that matches the new model:
- Keep the arithmetic: total slots, event slots, pre-committed, flex, meal-prep slots needed.
- Remove the `maxCoverageWith3Serving` comparison and the generate/don't-generate branching.
- Replace with: "Cover exactly N meal prep slots with batches. Prefer unique recipes; reuse if the DB is too small. Every slot must have a batch — no gaps."
- Remove the `isRolling` label variable (line 495) — unified prompt, no legacy path.

**3.3 — Update structured output format** (`src/agents/plan-proposer.ts`)
- Remove `recipes_to_generate` from the JSON schema in the prompt.
- Add `events` to the output schema (pass-through of input events — the proposer doesn't modify them, but including them in the output makes the contract uniform with the re-proposer in Plan 025).

**3.4 — Update `mapToProposal()`** (`src/agents/plan-proposer.ts` ~line 625)
- Stop reading `recipes_to_generate` from LLM output (it's no longer in the output schema).
- Set `recipesToGenerate: []` — the field stays on the type (Phase 1.1) for mutation handlers, but the proposer always returns an empty array.
- Map events from the raw output. If the proposer returns events, use them; otherwise fall back to the input events.

**3.5 — Remove `fillOrphanSlots()`** (`src/agents/plan-proposer.ts` ~line 673-706)
- Delete the function entirely.
- Remove the call in `proposePlan()` (line 160).
- Remove the import of `restoreMealSlot` and `computeUnexplainedOrphans` from `plan-utils.ts` (the proposer no longer needs them).

**3.6 — Add validateProposal + retry loop to `proposePlan()`**
- After `mapToProposal()`, call `validateProposal()`.
- If invalid, retry once: feed validation errors back to the LLM as a correction message (same pattern as the existing flex-count retry, but generalized).
- If retry also fails, return a structured failure so the caller can abort gracefully. `proposePlan()` returns a discriminated union:

```typescript
export type PlanProposerOutput =
  | { type: 'proposal'; proposal: PlanProposal; reasoning: string }
  | { type: 'failure'; errors: string[] };
```

- This replaces both `fillOrphanSlots()` and the orphan flow gate in `handleGenerateProposal()`.

**3.8 — Graceful abort in `handleGenerateProposal()`**
- When `proposePlan()` returns `type: 'failure'`: reset phase to `context`, tell the user "I couldn't build a complete plan — try adjusting your events or adding more recipes." Same UX as the current orphan flow gate abort (line 531), but triggered by the validator instead of `computeUnexplainedOrphans`.
- The design doc mentions the initial proposer can use a clarification path when the DB can't satisfy the request (e.g., ask "Want me to create a recipe?"). This requires the clarification + recipe generation orchestration infrastructure, which is built in Plan 025. For Plan 024, the graceful abort is sufficient — the edge case (DB too small for any valid arrangement even with flexible batches and 1-serving batches) is rare in practice.

**3.7 — Populate `proposal.events`**
- In `mapToProposal()` or `proposePlan()`, set `proposal.events` from the input events. The initial proposer doesn't modify events — it's a pass-through. This establishes the contract that `PlanProposal` is the complete plan state.

### Phase 4: Flow surgery — remove gap path from proposer flow

**4.1 — Simplify `handleGenerateProposal()`** (`src/agents/plan-flow.ts` ~line 451-575)
- Remove the `computeUnexplainedOrphans` flow gate (lines 514-555). Replaced by `validateProposal()` inside `proposePlan()`.
- Remove the `recipesToGenerate.length > 0` branching (lines 544-547, 562-567). The proposer never produces gaps now.
- The flow becomes: call `proposePlan()` → solver → `validatePlan()` → present proposal. Clean linear path.
- Keep the `presentRecipeGap()` function and gap-resolution handlers alive — mutation handlers still route to them until Plan 025.

**4.2 — Migrate event reads from `state.events` to `proposal.events`**

`proposal.events` is the single source of truth (Phase 1.1). The migration is split into two groups: call sites that can be migrated now, and mutation-path call sites that must stay on `state.events` until Plan 025 replaces the mutation handlers.

**Migrated in Plan 024** (downstream consumers — display, solver, persistence):

| Call site | File:line | Change |
|-----------|-----------|--------|
| `formatPlanProposal()` | `plan-flow.ts:1970` (event display loop) | Read `proposal.events` instead of `state.events` |
| `buildSolverInput()` | `plan-flow.ts:1544` (`events: state.events`) | Read `proposal.events` — passed as argument or accessed from the proposal parameter |
| `buildNewPlanSession()` | `plan-flow.ts:1628` (`events: state.events`) | Read `proposal.events` — the confirmed plan session persists the proposal's events |

**NOT migrated — mutation handlers still use `state.events`** (Plan 025 removes these entirely):

| Call site | File:line | Why it stays |
|-----------|-----------|-------------|
| `classifySwapIntent()` | `plan-flow.ts:1778` (`state.events.map(...)` builds event descriptions for LLM classifier) | The swap classifier reads `state.events` to show the LLM what events exist. Plan 025 removes `classifySwapIntent()` entirely. |
| `event_remove` handler | `plan-flow.ts:1012` (finds event by day/mealTime), `plan-flow.ts:1021` (splices from array) | The handler searches and mutates `state.events`. Plan 025 removes this handler — the re-proposer handles event removal. |

**Keeping these in sync:** After any mutation that modifies `state.events` (currently only `event_remove`), the mutation handler must also update `proposal.events` to match. Add a sync line after the splice at `plan-flow.ts:1021`:

```typescript
state.proposal!.events = [...state.events];
```

This ensures that when the post-mutation solver re-run reads `proposal.events` (via the migrated `buildSolverInput`), it sees the updated event set. The sync is a one-line bridge — Plan 025 eliminates it by removing the handler.

**4.3 — Update batch day-range formatting in `formatPlanProposal()`** (see Phase 5).

### Phase 5: Display — non-contiguous batch formatting

**5.1 — New day-range formatter**

A utility function that formats an array of ISO dates into a human-readable compact range, handling non-contiguous days:

```typescript
function formatDayRange(days: string[]): string
// [Wed, Thu, Fri] → "Wed–Fri"
// [Wed, Fri, Sat] → "Wed, Fri–Sat"
// [Mon, Wed, Fri] → "Mon, Wed, Fri"
// [Mon] → "Mon"
```

Algorithm: split into contiguous runs, format each run as start–end (or just start if single), join with ", ".

**5.2 — Update `formatPlanProposal()`** (plan-flow.ts ~line 1953)
- Replace the current `batch.days.map(formatDayShort).join(...)` logic with the new `formatDayRange()`.
- Update cook-day display: "Cook 3 servings (Wed, Fri–Sat)" instead of "3 servings (Wed-Fri)".

**5.3 — Update `getDayRange()` helper** (`src/plan/helpers.ts:245-251`)

The current `getDayRange(batch)` returns `{ first, last }` — only the endpoints. `formatDayDetail()` uses this to render "Wed–Sat" (line 367), which is wrong for non-contiguous batches (should be "Wed, Fri–Sat").

Replace `getDayRange()` with a function that returns the full `eatingDays` array (or deprecate it in favor of passing `batch.eatingDays` directly to `formatDayRange()`). The Telegram formatters should use the new `formatDayRange()` from Phase 5.1, not the old first/last shortcut.

**5.4 — Update Telegram formatters** (`src/telegram/formatters.ts`)

Only `formatDayDetail()` uses `getDayRange()` (line 365). The other two formatters do not show batch day ranges:
- `formatNextAction()` (line 200): shows recipe name + "reheat" or "Cook: recipe — N servings" per day. No day range displayed — **no change needed**.
- `formatWeekOverview()` (line 271): shows per-day slot names (recipe name or "Flex" or event). No day range displayed — **no change needed**.
- `formatDayDetail()` (line 365-368): replace `getDayRange(match.batch)` → `formatDayRange(match.batch.eatingDays)` so cook-day lines show "Wed, Fri–Sat" instead of "Wed–Sat" for non-contiguous batches.

### Phase 6: Testing

**6.1 — Unit tests for `validateProposal()`** (Phase 2.2 — already described above).

**6.2 — Regenerate affected scenarios**

These scenarios exercise the proposer and will have different recorded outputs because the proposer prompt changes (fridgeDays context, no `recipes_to_generate` in output schema, complete-plan instruction):

| Scenario | Why affected | Action |
|----------|-------------|--------|
| 001 plan-week-happy-path | Proposer prompt changes | Regenerate, review |
| 004 rolling-first-plan | Proposer prompt changes | Regenerate, review |
| 005 rolling-continuous | Proposer prompt changes, carry-over | Regenerate, review |
| 006 rolling-gap-vacation | Proposer prompt changes | Regenerate, review |
| 010 rolling-events-with-carryover | Proposer prompt changes, events | Regenerate, review |
| 011 rolling-replan-future-only | Proposer prompt changes | Regenerate, review |
| 012 rolling-replan-abandon | Proposer prompt changes | Regenerate, review |
| 018 plan-view-navigation | Display format changes | Regenerate, review |
| 019 shopping-list-tiered | Batch model affects shopping | Regenerate, review |
| 022 upcoming-plan-view | Display format changes | Regenerate, review |

**6.3 — Rework scenario 003 (plan-week-minimal-recipes)**

Currently tests the gap-resolution sub-flow (proposer emits gaps when only 2 recipes available). After this plan, the proposer must produce a complete plan even with only 2 recipes (reusing recipes, 1-serving batches if needed). The gap flow is never entered from the proposer path.

- Update spec description.
- Regenerate — the proposer should now return a complete plan with repeated recipes.
- Review: verify the plan covers all slots with only 2 lunch/dinner recipes.

**6.4 — Rework scenario 014 (proposer-orphan-fill)**

Currently tests `fillOrphanSlots()` with fixture-edited underfilled proposal. Since `fillOrphanSlots()` is removed, this scenario's purpose changes. Convert it to test the validator retry loop:

- Edit the fixture to return a proposal with an uncovered slot (similar to current setup).
- The validator catches it → proposer retries → second attempt fills the slot.
- Rename to something like `014-proposer-validator-retry`.
- This is a fixture-edited scenario, so follow the fixture-edits workflow (edit fixtures, run `test:replay`, add `fixture-assertions.ts`).

**6.5 — New scenario: non-consecutive batch arrangement**

A new scenario (e.g., `023-flexible-batches-with-events`) that exercises the core new capability:

- Spec: user has a dinner event on Thursday. The proposer should produce a batch that spans Wed, Fri, Sat (skipping Thursday) rather than forcing two smaller batches.
- Recipe set: `six-balanced` (plenty of recipes, fridge-life allows the span).
- Verify: batch eating days are non-consecutive, fridge-life respected, all slots covered.

**6.6 — New scenario: fridge-life constraint**

A scenario (or unit test) verifying that the validator rejects a batch whose span exceeds `fridgeDays`. This is best as a unit test in `test/unit/validate-proposal.test.ts` rather than a full scenario, since it tests the validator not the proposer.

**6.7 — Verification protocol**

Every regenerated scenario gets the full behavioral review per `docs/product-specs/testing.md`:
- Read the recorded output as a user receiving Telegram messages.
- Check: plan makes sense, slots covered, no ghost batches, cook days match first eating days, weekly totals reasonable, fridge-life respected.
- Verify non-consecutive batches display correctly.

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
  Rationale: Mutation handlers (flex_remove at line 997, event_remove at line 1034) push to `proposal.recipesToGenerate`. The post-mutation gate (line 1054) reads it. `computeUnexplainedOrphans` (plan-utils.ts:115) counts gaps as covered slots. Removing the field would break the mutation path that Plan 025 hasn't replaced yet. The proposer always returns `[]` — the field is dead from the generation side but alive for mutations.
  Date: 2026-04-09

- Decision: Retire `buildLegacySystemPrompt()`, unify into single prompt.
  Rationale: The legacy/rolling split was a Plan 007 strangler-fig. Plan 024 re-records all scenarios, completing the migration. The legacy prompt hardcodes consecutive batches (line 311, 335), `recipes_to_generate` (line 387), and "recipe can only appear in ONE batch" (line 334) — all incompatible with the new model. One prompt is simpler and eliminates the risk of the legacy path silently reverting new behavior for fresh plans (which are the majority of production traffic).
  Date: 2026-04-09

- Decision: Relax recipe uniqueness from hard rule to soft preference.
  Rationale: "A recipe can only appear in ONE batch" makes coverage impossible with small recipe DBs (scenario 003: 2 recipes, 12 slots). With flexible batches, the proposer needs permission to reuse recipes. Uniqueness becomes "prefer unique for variety; reuse when DB is too small." The validator does not enforce uniqueness — it only checks slot coverage.
  Date: 2026-04-09

- Decision: Migrate downstream event reads (solver, persistence, display) to `proposal.events`; mutation handlers stay on `state.events` with a sync bridge.
  Rationale: `buildSolverInput()` (line 1544), `buildNewPlanSession()` (line 1628), and `formatPlanProposal()` (line 1970) must read `proposal.events` so the single-source-of-truth contract holds for all downstream consumers. But `classifySwapIntent()` (line 1778) and `event_remove` (line 1012, 1021) read/write `state.events` and can't be migrated without rewriting mutation handlers — which is Plan 025's job. The bridge (`proposal.events = [...state.events]` after event_remove splice) keeps both in sync until Plan 025 eliminates the dual path.
  Date: 2026-04-09

- Decision: Update `buildUserPrompt()` slot math to match new model — remove gap-generation instructions.
  Rationale: The current user prompt (lines 467-496) includes "you MUST generate N new recipe(s)" and compares `availableRecipes.length * 3` against slots needed — both assume the old gap-generation model. The system prompt says "always complete, no gaps" but the user prompt says "you MUST generate recipes." This is a direct contradiction that would confuse the LLM. Both prompt layers must be consistent.
  Date: 2026-04-09

- Decision: Add `events` to `PlanProposal` now (pass-through from input).
  Rationale: Establishes the contract that the proposal is the complete plan state. The initial proposer passes events through; the re-proposer (Plan 025) will modify them. Single source of truth from day one.
  Date: 2026-04-09

- Decision: Validator retry replaces both `fillOrphanSlots()` and the orphan flow gate.
  Rationale: Same "agent proposes, sidecar validates" pattern. One mechanism instead of two. The proposer is instructed to always produce complete plans; the validator catches failures; the retry gives the LLM a second chance with feedback.
  Date: 2026-04-09

- Decision: `validateProposal()` reads events from `proposal.events`, not a separate parameter.
  Rationale: `proposal.events` is the single source of truth for the plan arrangement (Phase 1.1). Passing events separately reintroduces dual-state ambiguity. The validator trusts the proposal as the complete plan.
  Date: 2026-04-09

- Decision: Proposer graceful-abort on double validation failure; full clarification path deferred to Plan 025.
  Rationale: The design doc specifies a clarification path for the initial proposer when the DB can't satisfy the request. This requires clarification + recipe generation orchestration, which Plan 025 builds. For Plan 024, graceful abort is sufficient — with flexible batches and 1-serving batches allowed, even a 2-recipe DB can cover 12 slots. The edge case is rare enough that a simple abort message is acceptable until the clarification infrastructure exists.
  Date: 2026-04-09

## Validation

1. `npm test` passes with all regenerated/reworked scenarios.
2. Unit tests for `validateProposal()` cover all 13 invariants.
3. Scenario 003 confirms the proposer handles minimal recipe sets without gaps.
4. Scenario 014 (reworked) confirms the validator retry loop recovers from uncovered slots.
5. New flexible-batches scenario confirms non-consecutive batch arrangement.
6. All regenerated scenarios pass the behavioral review protocol.
7. Manual `npm run dev` smoke test: plan a week with an event mid-week, verify non-consecutive batch appears and displays correctly.

# Feedback

