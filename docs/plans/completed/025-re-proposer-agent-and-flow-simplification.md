# Plan 025: Re-proposer Agent + Flow Simplification

**Status:** Active
**Date:** 2026-04-09
**Affects:** `src/agents/plan-reproposer.ts` (new), `src/agents/plan-flow.ts`, `src/agents/plan-utils.ts`, `src/agents/plan-proposer.ts`, `src/solver/types.ts`, `src/agents/plan-diff.ts` (new)
**Design doc:** `docs/design-docs/002-plans-that-survive-real-life.md`
**Depends on:** Plan 024 (flexible batch model, proposal validator, complete proposer).
**Blocked by:** Plan 024 must be complete — this plan removes mutation handlers that Plan 024 keeps alive.

## Problem

Mutations are handled by LLM intent classification → deterministic handlers (`removeBatchDay`, `resolveOrphanPool`, `resolveSingletonOrphan`, etc.). Each edge case spawns more handlers, which spawn more edge cases. A trivial request like "move flex to Sunday" can trigger orphan cascades and dead-end flows.

Replace all of this with a single re-proposer agent call: user message → `reProposePlan()` → validate → solve → present. One LLM call, structured output, deterministic validation. The re-proposer uses the same output contract as the initial proposer (complete plan — batches + flex slots + events) and the same validator + solver pipeline.

## Plan of work

### Phase 1: Re-proposer function

**1.1 — New file `src/agents/plan-reproposer.ts`**

```typescript
export interface ReProposerInput {
  currentProposal: PlanProposal;
  userMessage: string;
  mutationHistory: MutationRecord[];
  availableRecipes: RecipeSummary[];   // full recipe DB as context
  horizonDays: string[];
  preCommittedSlots: PreCommittedSlot[];
  breakfast: { name: string; caloriesPerDay: number; proteinPerDay: number };
  weeklyTargets: { calories: number; protein: number };
}

export interface MutationRecord {
  constraint: string;       // natural language: what the user asked
  appliedAt: string;        // ISO timestamp
}

export type ReProposerOutput =
  | { type: 'proposal'; proposal: PlanProposal; reasoning: string }
  | { type: 'clarification'; question: string; recipeNeeded?: string; recipeMealType?: 'lunch' | 'dinner' }
  | { type: 'failure'; message: string };

export async function reProposePlan(
  input: ReProposerInput,
  llm: LLMProvider,
): Promise<ReProposerOutput>
```

**1.2 — Re-proposer prompt**

System prompt covers:
- Role: you are a meal plan adjustment agent. You receive a current plan and a user's change request.
- Output: either a complete new plan (same schema as proposePlan) OR a clarification question.
- Authority rules (from design doc):
  - CAN change: batch eating days, serving counts (1-3), flex placement, cook days (derived), events (add/remove/modify per user intent), recipes (only when user explicitly requests).
  - CANNOT change: pre-committed slots, breakfast, total flex count, calorie targets, recipes without user intent.
- Batch model rules: non-consecutive days allowed, fridge-life hard wall, prefer 2-3 servings.
- Mutation history: prior user-approved changes are load-bearing — don't undo them unless the new request conflicts.
- Always output a complete plan — every slot filled, no gaps.
- If you can't confidently rearrange, return a clarification question.
- If the user requests a recipe not in the DB, return a clarification: "I don't have X. Want me to create one?"

User prompt includes:
- Current proposal (batches with recipe names/slugs/days/servings, flex slots, events).
- User's message.
- Mutation history (if any).
- Available recipes (slug, name, cuisine, protein source, fridgeDays — same compact format as proposer).
- Horizon dates.
- Pre-committed slots.

Structured output schema:
```json
{
  "type": "proposal" | "clarification",
  // if proposal:
  "batches": [...],
  "flex_slots": [...],
  "events": [...],
  "reasoning": "...",
  // if clarification:
  "question": "...",
  "recipe_needed": "string | null",    // non-null when clarification is a recipe generation request
  "recipe_meal_type": "lunch | dinner | null"  // which slot needs the recipe (when recipe_needed is set)
}
```

**1.3 — Model choice: mini with high reasoning** (same as proposer — arrangement is a reasoning task, not a generation task).

**1.4 — Validation + retry loop**
- On `type: 'proposal'`, run `validateProposal()` (from Plan 024).
- If invalid, retry once with validation errors as feedback.
- Two failures → return `{ type: 'failure', message: "..." }`. The orchestration layer keeps the prior valid proposal and asks the user to rephrase. This matches the design doc: "Two failures → keep the prior valid plan, tell the user the change couldn't be applied cleanly."

**1.5 — Recipe generation via clarification**

The re-proposer may return a clarification like "I don't have a meatless Bolognese. Want me to create one?" The user confirms → orchestration generates the recipe → re-runs the re-proposer with the updated DB.

This is orchestrated via `pendingClarification` (same mechanism as any clarification) plus a `pendingRecipeGeneration` field on `PlanFlowState`:

```typescript
pendingRecipeGeneration?: {
  description: string;  // what the user asked for, e.g., "meatless Bolognese"
};
```

**Interception in `handleMutationText()`:** After the re-proposer returns a clarification, the `pendingClarification` is stored as normal. When the user responds, `handleMutationText` checks: does `pendingRecipeGeneration` exist? If so, and the user's answer is affirmative ("yes", "sure", "create it"), run the recipe generation flow:

1. Call `generateRecipe()` with the description as preferences.
2. Persist the new recipe to the DB via `recipes.save()`.
3. Clear `pendingRecipeGeneration`.
4. Re-run `reProposePlan()` with the updated recipe DB — the re-proposer now sees the new recipe and can place it.

If the user declines ("no", "never mind"), clear `pendingRecipeGeneration` and `pendingClarification`, keep the current plan.

**How it's detected:** The clarification output includes optional `recipeNeeded` (description) and `recipeMealType` fields. When set, the orchestration stores them in `pendingRecipeGeneration` on the flow state. On the next user message, `handleMutationText` step 0 checks for this state before calling the re-proposer.

**Generator contract:** Uses the existing `generateRecipe()` API (`src/agents/recipe-generator.ts:55`), which takes `{ mealType, targets: MacrosWithFatCarbs, preferences?: string }` and returns `GenerateResult { recipe, messages }`. The `pendingRecipeGeneration.mealType` supplies `mealType`; `targetsForMealType()` derives per-serving macro targets from solver config; `description` becomes `preferences`. After generation, `validateAndCorrectRecipe()` runs the existing macro QA gate before persisting. No wrapper or new API needed — this is the same path as the current gap recipe generation (`generateGapRecipe()` in `plan-flow.ts:1075`), just with different orchestration.

**Scenario coverage:** Scenario 5.5 (clarification) tests the normal clarification path. Add a separate scenario for the recipe generation handshake:
- User says "I want a Thai green curry" → re-proposer returns clarification with `recipeNeeded: "Thai green curry"` → user says "yes" → recipe generated → re-proposer places it → user approves.

### Phase 2: Change summary generator

**2.1 — New file `src/agents/plan-diff.ts`**

```typescript
export function diffProposals(
  oldProposal: PlanProposal,
  newProposal: PlanProposal,
): string
```

Deterministic diff — compares old and new proposals, returns a human-readable summary of what changed:

- **Batch changes:** "Moved Tagine from Mon–Wed to Wed, Fri–Sat", "Swapped Tagine for Salmon Linguine on Thu–Sat", "Reduced Stir-fry from 3 to 2 servings (Mon–Tue)".
- **Flex changes:** "Moved flex from Sat dinner to Sun dinner", "Flex stays on Sat dinner".
- **Event changes:** "Added event: dinner with friends Friday (~800 cal)", "Removed event: team lunch Thursday".
- **No change:** "No changes to the plan" (shouldn't happen, but defensive).

Algorithm (two passes):

**Pass 1 — Match by recipe identity.** Primary key: `(mealType, recipeSlug)`. When multiple batches share the same key (small DB, recipe reuse), disambiguate by day overlap: pair the old/new batch combo with the most overlapping eating days. Matched batches with different days → "Moved Tagine from Mon–Wed to Wed, Fri–Sat." Matched batches with different servings → "Reduced Stir-fry from 3 to 2 servings."

**Pass 2 — Detect recipe swaps from unmatched pairs.** After Pass 1, collect unmatched old batches and unmatched new batches. For each unmatched old batch, find an unmatched new batch with the same `(mealType)` and overlapping or identical days. A pair where the days largely overlap but the recipe differs is a swap: "Swapped Tagine for Salmon Linguine on Thu–Sat." Pairs with no day overlap stay as separate remove/add: "Removed Tagine Mon–Wed. Added Pork Bowls Thu–Sat."

**Remaining steps:**
3. Compare flex slots by `(day, mealTime)`.
4. Compare events by `(day, mealTime)`.
5. Assemble summary lines in display order (events first, then batches, then flex).

**Edge case — duplicate recipes:** With a 2-recipe DB, the plan may have two lunch batches of the same recipe. The day-overlap disambiguation in Pass 1 handles this: each old batch matches the new batch it overlaps most with. If an old batch has zero overlap with any new batch of the same recipe, it falls through to Pass 2.

**2.2 — Unit tests** (`test/unit/plan-diff.test.ts`)
- Test: batch moved (same recipe, different days).
- Test: recipe swapped (different recipe on same days).
- Test: flex moved.
- Test: event added.
- Test: event removed.
- Test: no changes.
- Test: multiple simultaneous changes.
- Test: duplicate recipes in small DB — two batches of the same recipe, one moved. Verify correct match by day overlap, not false add/remove.

### Phase 3: Flow simplification

**3.1 — Add `mutationHistory` to `PlanFlowState`** (`src/agents/plan-flow.ts`)

```typescript
export interface PlanFlowState {
  // ... existing fields ...
  /** Accumulated mutation history for this planning session. Clears on confirm. */
  mutationHistory?: MutationRecord[];
  /**
   * When the re-proposer returned a clarification, this stores the context
   * needed to continue the conversation on the next user message:
   * - originalMessage: the user's ambiguous request that triggered the clarification
   * - question: the clarification question the re-proposer asked
   * Cleared when the clarification is resolved (next reProposePlan call).
   */
  pendingClarification?: {
    originalMessage: string;
    question: string;
  };
  /** When the re-proposer asked to generate a recipe, stores generation context. */
  pendingRecipeGeneration?: {
    description: string;                          // what the user asked for
    mealType: 'lunch' | 'dinner';                 // which slot needs the recipe
  };
}
```

**3.2 — Simplify `PlanFlowPhase`**

Remove phases that no longer exist:
```typescript
export type PlanFlowPhase =
  | 'context'
  | 'awaiting_events'
  | 'generating_proposal'
  | 'proposal'              // user reviewing plan (can send adjustments or approve)
  | 'confirmed';
```

Removed:
- `recipe_suggestion` — gap flow gone.
- `awaiting_recipe_prefs` — gap flow gone.
- `generating_recipe` — gap flow gone.
- `reviewing_recipe` — gap flow gone.
- `awaiting_swap` — no separate phase needed; the `proposal` phase now handles both review and adjustment. User sends text → re-proposer runs → presents updated plan → still in `proposal` phase.

**3.3 — Remove gap resolution handlers** (from `plan-flow.ts`)

Delete these functions entirely:
- `presentRecipeGap()` (~20 lines)
- `handleGapResponse()` (lines 583-624)
- `handleGapRecipePrefs()` (lines 629-640)
- `generateGapRecipe()` (lines 1075-1112)
- `handleGapRecipeReview()` (lines 647-674)
- `handleGapRecipeRefinement()` (lines 681-713)
- `advanceGapOrPresent()` (lines 1167-1185)

Remove gap-related state fields from `PlanFlowState`:
- `pendingGaps`
- `activeGapIndex`
- `recipeGenMessages`
- `currentRecipe`

Delete `RecipeGap` type from `src/solver/types.ts`.

**3.4 — Remove intent classification** (from `plan-flow.ts`)

Delete these functions:
- `classifySwapIntent()` (lines 1765-1843) — LLM-based intent classifier.
- `SwapIntent` type and its discriminated union variants (lines 1750-1763).
- `classifyEventIntent()` stays — it's used during event collection (awaiting_events phase), which is unchanged. (Plan 025 doesn't touch event collection; that's a v0.0.5 concern.)

**3.5 — Remove all deterministic mutation handlers** (from `plan-flow.ts`)

Delete these functions:
- `removeBatchDay()` (lines 1449-1507)
- `splitIntoContiguousRuns()` (lines 1513-1532)
- `resolveOrphanPool()` (lines 1321-1389)
- `resolveSingletonOrphan()` (lines 1246-1304)
- `absorbFreedDay()` (lines 1403-1432)
- `findBatchForDay()` (helper used by mutation handlers)

**3.6 — Remove `plan-utils.ts` functions**

Delete from `src/agents/plan-utils.ts`:
- `restoreMealSlot()` (lines 22-68) — only used by mutation handlers.
- `computeUnexplainedOrphans()` (lines 83-132) — replaced by `validateProposal()` (Plan 024). Check that `validatePlan()` in `qa/validators/plan.ts` doesn't depend on it — if it does, inline the relevant check there.

If `plan-utils.ts` is now empty, delete the file.

**3.7 — Remove mutation handler dispatch** (from `plan-flow.ts`)

The current `handleSwapText()` (lines 775-1070):
1. Classifies intent via `classifySwapIntent()`.
2. Switches on intent type → calls the appropriate handler.
3. Post-mutation: checks for gaps, re-runs solver, re-presents.

Replace entirely with the new mutation flow:

```typescript
export async function handleMutationText(
  state: PlanFlowState,
  text: string,
  llm: LLMProvider,
  recipes: RecipeDatabase,
): Promise<FlowResponse> {
  // 0. Recipe generation handshake — if a prior clarification asked to
  //    generate a recipe and the user confirmed, generate it first, then
  //    re-run the re-proposer with the updated DB.
  if (state.pendingRecipeGeneration) {
    const isAffirmative = /^(yes|yeah|sure|ok|create|do it|go ahead)/i.test(text.trim());
    if (isAffirmative) {
      const desc = state.pendingRecipeGeneration.description;
      const mealType = state.pendingRecipeGeneration.mealType;
      // Save the original request BEFORE clearing state
      const originalRequest = state.pendingClarification?.originalMessage ?? desc;
      state.pendingRecipeGeneration = undefined;
      state.pendingClarification = undefined;
      // Generate + validate + persist the recipe.
      // Uses the existing generateRecipe() contract: { mealType, targets, preferences }.
      // targetsForMealType() derives per-serving macro targets from the solver config.
      const targets = targetsForMealType(mealType);
      const genResult = await generateRecipe({ mealType, targets, preferences: desc }, llm);
      const corrected = await validateAndCorrectRecipe(genResult, targets, llm);
      await recipes.save(corrected.recipe);
      // Re-run re-proposer with updated DB — the new recipe is now available.
      // Pass the ORIGINAL mutation request so the re-proposer knows the full intent
      // (e.g., "I want a Thai green curry instead of the tagine").
      return handleMutationText(state, originalRequest, llm, recipes);
    }
    // User declined — clear state, keep current plan
    state.pendingRecipeGeneration = undefined;
    state.pendingClarification = undefined;
    return { text: 'OK, keeping the current plan.', state };
  }

  // 1. Build the user message for the re-proposer.
  //    If there's a pending clarification, the user's text is an answer to it.
  //    Combine the original request + clarification + answer into one message
  //    so the re-proposer has full context.
  let userMessage: string;
  const priorClarification = state.pendingClarification; // save before clearing
  // Track the root mutation intent for history (not the clarification answer)
  const mutationIntent = priorClarification
    ? priorClarification.originalMessage
    : text;
  if (priorClarification) {
    userMessage = [
      `Original request: ${priorClarification.originalMessage}`,
      `You asked: ${priorClarification.question}`,
      `User answered: ${text}`,
    ].join('\n');
    state.pendingClarification = undefined; // consumed
  } else {
    userMessage = text;
  }

  // 2. Call re-proposer
  const result = await reProposePlan({
    currentProposal: state.proposal!,
    userMessage,
    mutationHistory: state.mutationHistory ?? [],
    availableRecipes: buildRecipeSummaries(recipes.getAll()),
    horizonDays: state.horizonDays ?? state.weekDays,
    preCommittedSlots: state.preCommittedSlots ?? [],
    breakfast: state.breakfast,
    weeklyTargets: config.targets.weekly,
  }, llm);

  // 3. Handle clarification — store context, stay in proposal phase.
  //    If this is a second clarification (the re-proposer asked again after
  //    receiving the first answer), preserve the original request from the
  //    prior round — it's the root of the conversation.
  if (result.type === 'clarification') {
    state.pendingClarification = {
      originalMessage: priorClarification
        ? priorClarification.originalMessage  // nested: keep root request
        : text,                               // first clarification: this IS the request
      question: result.question,
    };
    // If the re-proposer flagged a recipe generation need, store it
    if (result.recipeNeeded) {
      state.pendingRecipeGeneration = {
        description: result.recipeNeeded,
        mealType: result.recipeMealType ?? 'dinner',
      };
    }
    return { text: result.question, state };
  }

  // 4. Handle failure — keep prior plan, ask user to rephrase
  if (result.type === 'failure') {
    return { text: result.message, state };
  }

  // 5. New proposal — run solver
  const proposal = result.proposal;
  const solverInput = buildSolverInput(state, proposal, recipes, state.preCommittedSlots);
  const solverOutput = solve(solverInput);
  proposal.solverOutput = solverOutput;

  // 6. Generate change summary
  const summary = diffProposals(state.proposal!, proposal);

  // 7. Update state — store new proposal and append to history.
  //    History records the ROOT mutation intent (e.g., "move flex to Sunday"),
  //    not a clarification answer (e.g., "the dinner one"). After clarification
  //    rounds, mutationIntent holds the original request.
  state.proposal = proposal;
  state.mutationHistory = [
    ...(state.mutationHistory ?? []),
    { constraint: mutationIntent, appliedAt: new Date().toISOString() },
  ];

  // 8. Present updated plan with change summary
  state.phase = 'proposal';
  return {
    text: `${summary}\n\n${formatPlanProposal(state)}`,
    state,
  };
}
```

**3.8 — Update proposal phase routing**

In the flow dispatcher (wherever `handleSwapRequest()` is called from):
- Remove the `awaiting_swap` → `handleSwapText()` routing.
- In `proposal` phase, when user sends text (not a button tap): call `handleMutationText()` directly.
- The `matchPlanningMetaIntent()` regex check stays — "start over" and "cancel" are still handled before calling the re-proposer.
- The "Swap something" button is removed from `planProposalKeyboard` (see Phase 4.3). Users type adjustments directly — the re-proposer handles natural language in the proposal phase.

**3.9 — Update `handleApprove()`**
- Clear `mutationHistory` and `pendingClarification` after persist (session-scoped — history doesn't survive plan confirmation).
- No special append logic needed — history is already populated by `handleMutationText()` at show time.

**3.10 — Update `event_remove` routing**
- Currently in `handleSwapText()` under `case 'event_remove'`. Now handled by the re-proposer naturally — user says "cancel the Thursday dinner" → re-proposer removes the event and rearranges.
- No separate handler needed.

### Phase 4: Cleanup

**4.1 — Remove dead imports**
- Sweep `plan-flow.ts` for imports of removed functions/types.
- Remove `RecipeGap` import from any file that used it.
- Remove `plan-utils.ts` import if file is deleted.

**4.2 — Update `plan-flow.ts` exports**
- Remove exports of deleted handlers.
- Export `handleMutationText` (new).
- Remove `handleSwapText`, `handleSwapRequest` exports.

**4.3 — Update `src/telegram/core.ts`** (flow dispatcher + keyboard wiring)

The Telegram core has extensive wiring for removed phases and handlers. All of this becomes dead or broken:

**Callback/button handlers to remove:**
- `plan_swap` callback → `handleSwapRequest()` (line ~612) — remove the callback handling.
- `plan_generate_gap_*` callback → `handleGapResponse('generate')` (line ~631) — gap recipe generation button.
- `plan_idea_gap_*` callback → `handleGapResponse('idea')` (line ~650) — gap "I have an idea" button.
- `plan_skip_gap_*` callback → `handleGapResponse('skip')` (line ~659) — gap "use existing" button.
- `plan_use_recipe` callback → `handleGapRecipeReview('use')` (line ~670) — gap recipe accept button.
- `plan_different_recipe` callback → `handleGapRecipeReview('different')` (line ~683) — gap recipe retry button.

**Phase routing in text handler to remove:**
- `awaiting_recipe_prefs` → `handleGapRecipePrefs()` (line ~1420-1435).
- `awaiting_swap` branch in `proposal` routing (line ~1438).
- `reviewing_recipe` → `handleGapRecipeRefinement()` (line ~1457-1470).

**Phase display in resume/status to remove:**
- `recipe_suggestion` keyboard selection (line ~540, ~567) — `planRecipeGapKeyboard`.
- `generating_recipe` "still working" message (line ~976).
- `recipe_suggestion` status text (line ~978-986).
- `awaiting_recipe_prefs` status text (line ~988).
- `reviewing_recipe` status text (line ~990-1000).
- `awaiting_swap` status text (line ~1009).

**Keyboard definitions to update/remove** (`src/telegram/keyboards.ts`):
- `planProposalKeyboard` (line 263): remove the `plan_swap` / "Swap something" button — it becomes a dead control since the callback handler is removed. The keyboard becomes just `[Looks good]`. Users type adjustments directly in the proposal phase.
- `planRecipeGapKeyboard` — delete entirely (gap resolution buttons).
- `planGapRecipeReviewKeyboard` — delete entirely (gap recipe review buttons).

**Imports to remove:**
- `handleGapResponse`, `handleGapRecipePrefs`, `handleGapRecipeReview`, `handleGapRecipeRefinement`, `handleSwapRequest`, `handleSwapText` (line ~132-138).

**New routing:**
- `proposal` phase text → `handleMutationText()` (after `matchPlanningMetaIntent` check).
- Import `handleMutationText` from plan-flow.

**4.4 — Verify `validatePlan()` independence**
- `src/qa/validators/plan.ts` validates `SolverOutput` post-solver. Check it doesn't import anything from deleted files. If it uses `computeUnexplainedOrphans`, inline the coverage check or remove it (the pre-solver `validateProposal()` from Plan 024 now handles slot coverage).

### Phase 5: Testing

**5.1 — Rework mutation scenarios**

These scenarios test mutations via the old handlers. They need complete reworks — same user intent, but now routed through the re-proposer:

| Scenario | Current test | New test |
|----------|-------------|----------|
| 002 plan-week-flex-move-regression | flex_move via deterministic handler, orphan pool resolution | Same user message ("move flex to Sunday"), re-proposer handles it in one call |
| 008 rolling-flex-move-at-edge | flex_move at horizon edge, overflow orphan handling | Same user message, re-proposer respects horizon boundaries |
| 009 rolling-swap-recipe-with-carryover | recipe_swap via intent classification + LLM recipe match | Same user message ("swap the chicken for something else"), re-proposer picks from DB |
| 013 flex-move-rebatch-carryover | flex_move with contiguous orphan merging (Plan 009) | Same user message, re-proposer rearranges naturally |
| 020 planning-intents-from-text | Swap from proposal phase (no button), "start over" | Swap goes through re-proposer; "start over" still via meta-intent regex |

For each:
- Update `spec.ts` if the flow phases change (e.g., no `awaiting_swap` phase).
- Regenerate with `npm run test:generate -- <name>`.
- Full behavioral review of recorded output.

**5.2 — Verify cancel scenario**

| Scenario | Check |
|----------|-------|
| 021 planning-cancel-intent | "Nevermind" during proposal still works via `matchPlanningMetaIntent()` regex — no change expected. Regenerate to confirm. |

**5.3 — New scenario: re-proposer flex move**

Scenario (e.g., `024-reproposer-flex-move`):
- Spec: plan week → proposer places flex on Saturday dinner → user says "move the flex to Sunday" → re-proposer moves it, rearranges batches → user approves.
- Verify: flex moved, batches adjusted, change summary accurate, all slots covered.

**5.4 — New scenario: re-proposer event add during planning**

Scenario (e.g., `025-reproposer-event-add`):
- Spec: plan week → proposal shown → user says "oh wait, I have dinner with friends on Friday" → re-proposer adds event, rearranges batches → user approves.
- Verify: event added, batch days skip Friday dinner, fridge-life respected, change summary shows event addition.

**5.5 — New scenario: re-proposer clarification**

Scenario (e.g., `026-reproposer-clarification`):
- Spec: plan week → proposal shown → user says "move the chicken" (ambiguous — which chicken batch?) → re-proposer returns clarification → user clarifies → re-proposer produces updated plan → user approves.
- Verify: clarification question is sensible, second call produces correct plan, change summary after clarification.

**5.6 — New scenario: re-proposer recipe swap**

Scenario (e.g., `027-reproposer-recipe-swap`):
- Spec: plan week → proposal shown → user says "I want the pork bowls instead of the tagine" → re-proposer swaps recipe from DB → user approves.
- Verify: recipe changed, days may shift (different fridgeDays), all slots covered, change summary shows swap.

**5.7 — New scenario: re-proposer recipe generation handshake**

Scenario (e.g., `028-reproposer-recipe-generation`):
- Spec: plan week → proposal shown → user says "I want a Thai green curry instead of the tagine" → re-proposer returns clarification with `recipeNeeded: "Thai green curry"` → user says "yes" → `generateRecipe()` runs → recipe persisted → re-proposer re-runs with updated DB → places new recipe → user approves.
- Verify: recipe generated and saved, re-proposer uses it, change summary shows swap, all slots covered.

**5.8 — New scenario: re-proposer validation failure**

Best as a fixture-edited scenario:
- Generate a normal scenario, then edit the re-proposer's first response fixture to have an uncovered slot.
- Verify: validator catches it, re-proposer retries, second attempt succeeds.
- Add `fixture-assertions.ts` to guard against `--regenerate` destroying the edit.

**5.9 — Unit tests for `diffProposals()`** (Phase 2.2 — already described above).

**5.10 — Verification protocol**

Same as Plan 024: every regenerated scenario gets the full behavioral review. Additionally for mutation scenarios:
- Verify the change summary accurately describes what changed.
- Verify mutation history accumulates correctly (multi-mutation scenarios).
- Verify the plan after mutation is still valid (all slots covered, fridge-life respected).

## Progress

- [x] Phase 0: Update design doc mutation-history semantics (prerequisite — resolve divergence before coding)
- [x] Phase 1: Re-proposer function
- [x] Phase 2: Change summary generator
- [x] Phase 3: Flow simplification
- [x] Phase 4: Cleanup
- [x] Phase 5: Testing (151/151 pass — 5 mutation specs reworked, 4 new scenarios: 023-026)

### Phase 0: Update design doc

Before implementation begins, update `docs/design-docs/proposals/002-plans-that-survive-real-life.md` section "Mutation history" (~line 130) to match the plan's append-on-show semantics:

- Replace "Each time the user approves a re-proposed plan, the mutation is appended" with: "Each time the re-proposer produces a new plan and it is shown to the user, the mutation is appended to history."
- Remove: "On rollback (user rejects), nothing is appended." There is no explicit rollback action — the user sends a new adjustment, and the re-proposer works from the latest arrangement + full history.
- Keep: "History is scoped to the planning session and clears when the plan is confirmed."

This is a one-line-equivalent change that resolves the design-doc/plan divergence before any code is written.

## Decision log

- Decision: The re-proposer is a single structured-output LLM call, not a tool-using agent.
  Rationale: Arrangement decisions don't need tool use. The full recipe DB fits in context (tens of recipes). One call is faster, more predictable, and easier to validate than a multi-step loop.
  Date: 2026-04-09

- Decision: Keep `classifyEventIntent()` — only remove `classifySwapIntent()`.
  Rationale: Event intent classification is used during event collection (awaiting_events phase), which is unchanged in this plan. Conversational event collection is a v0.0.5 concern.
  Date: 2026-04-09

- Decision: Remove `awaiting_swap` phase entirely. Mutation text handled directly in `proposal` phase.
  Rationale: The separate phase existed because the old system needed a "type your swap" prompt before classification. The re-proposer takes any natural language — no prompt needed. User just types in the proposal phase.
  Date: 2026-04-09

- Decision: Change summary is deterministic (diff-based), not LLM-generated.
  Rationale: The LLM's `reasoning` field is logged for debugging but never shown to the user. A structural diff is reliable and fast. It compares actual batch/flex/event assignments rather than trusting the LLM to accurately describe its own changes.
  Date: 2026-04-09

- Decision: Mutation history clears on confirm.
  Rationale: History is scoped to the planning session. When v0.0.5 adds post-confirmation mutations, history will need to persist — but that's v0.0.5's problem. For v0.0.4, planning-session scope is correct.
  Date: 2026-04-09

- Decision: Recipe generation via clarification reuses existing `generateRecipe()`.
  Rationale: No need for a second recipe generation facility. The re-proposer detects "recipe not in DB" → asks user via clarification → orchestration generates + persists → re-proposer runs again with updated DB. One extra interaction, rare in practice.
  Date: 2026-04-09

- Decision: Mutation history appended on show (when user sees the updated plan), not on final approve. **Design doc divergence — update required.**
  Rationale: The design doc says "each time the user approves a re-proposed plan, the mutation is appended" — but the only "approve" in the current UI is final plan confirmation (`handleApprove` → `planFlow = null`). If history only appended on final approve, subsequent re-proposer calls during the same session would always see empty history, defeating the purpose. "Approve" is reinterpreted as "the user saw the change and didn't reject it" — which is what happens when they send another mutation or tap final approve. If the user explicitly undoes a change ("go back" / "undo"), the re-proposer handles it naturally by reverting the arrangement.
  **Action:** Update design doc section "Mutation history" (line ~130) to say: "Each time the re-proposer produces a new plan and it is shown to the user, the mutation is appended to history. If the user explicitly undoes a change, the re-proposer adjusts the arrangement; history tracks intent, not outcome." Remove the "On rollback, nothing is appended" sentence — there is no explicit rollback action; the user just sends a new adjustment.
  Date: 2026-04-09

- Decision: `ReProposerOutput` has three shapes: `proposal`, `clarification`, and `failure`.
  Rationale: Two validation failures must be representable as a distinct outcome so the orchestration can keep the prior plan and ask the user to rephrase. Without `failure`, the sample flow had no branch for this case — a gap between the type system and the design doc's contract.
  Date: 2026-04-09

- Decision: Diff matches duplicate-recipe batches by day overlap, not just `(recipeSlug, mealType)`.
  Rationale: Small recipe DBs produce plans with repeated recipes (same slug, same mealType). Matching by recipe alone can't distinguish two such batches. Day overlap is the natural tiebreaker — the batch that shared the most days with the old batch is the "same" batch (moved), not a new addition.
  Date: 2026-04-09

- Decision: Clarification is stateful — `pendingClarification` stores the original request and question.
  Rationale: Without context, a follow-up like "the dinner one" or "yes, create it" would be treated as a fresh mutation request. The re-proposer needs the original ambiguous message + its own clarification question + the user's answer to resolve the ambiguity. Recipe generation handshake ("Want me to create one?" → "yes") also requires this context.
  Date: 2026-04-09

- Decision: Diff uses two passes — Pass 1 matches by recipe identity, Pass 2 detects recipe swaps from unmatched pairs.
  Rationale: Matching by (mealType, recipeSlug) means matched pairs necessarily share the same recipe — "different recipe = swapped" is logically impossible for them. Recipe swaps (Tagine → Pork Bowls on the same days) appear as an unmatched old + unmatched new. Pass 2 pairs these by day overlap to generate "Swapped X for Y" instead of separate "Removed X / Added Y" lines.
  Date: 2026-04-09

## Validation

1. `npm test` passes with all reworked and new scenarios.
2. Unit tests for `diffProposals()` cover all change types.
3. Mutation scenarios verify: re-proposer handles flex move, recipe swap, event add/remove.
4. Clarification scenario verifies the two-round-trip path.
5. Fixture-edited scenario verifies validator retry on re-proposer output.
6. `plan-flow.ts` is significantly smaller — all deterministic mutation handlers, intent classification, and gap flow are gone.
7. No references to removed functions/types remain (grep for `removeBatchDay`, `resolveOrphanPool`, `SwapIntent`, `RecipeGap`, `fillOrphanSlots`, `restoreMealSlot`, `computeUnexplainedOrphans`).
8. Manual `npm run dev` smoke test: plan a week, send "move flex to Sunday", verify re-proposer handles it and change summary is shown.

# Feedback

