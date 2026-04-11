# User Flows

> Scope: All user-facing conversation flows — plan week, recipe generation, shopping list. See also: [ui.md](./ui.md) for keyboards/formatting, [solver.md](./solver.md) for budget math.

## Plan week flow (`src/agents/plan-flow.ts`)

The main weekly ritual. Suggestive-first: the system proposes a complete plan, the user approves or tweaks.

### Phases

```
context → awaiting_events → generating_proposal → proposal → confirmed
```

### Phase details

**context** — Entry point. Shows breakfast confirmation + meals-out question: "Any meals you'll eat out this week? (restaurants, dinner parties, etc.)" User taps "Keep it" to confirm breakfast, then either "No meals out" or "Add meal out."

**awaiting_events** — User adds meal-replacement events via free-text or voice. Each message is parsed by nano LLM into one of two types:
- `meal_replacement` → stored as a `MealEvent` and replaces a lunch/dinner slot in the solver.
- `treat` → NOT stored as an event. User gets a friendly response explaining the treat budget covers it; the user still eats their regular meals that day.

Follow-up messages classify into: correction to last event, `reclassify_as_treat` (removes the last event from state), or new event. Loop until user taps "That's all."

**generating_proposal** — Heavy async step:
1. Load available recipes + recent plan history from DB/Supabase
2. Call plan-proposer sub-agent — always returns a **complete** plan: every slot covered, exactly `config.planning.flexSlotsPerWeek` flex slots, batches fridge-life constrained (not required to be consecutive).
3. `validateProposal()` gates the raw proposal (14 invariants: slot coverage, no overlap, fridge-life, flex count, recipe existence, event validity, meal-type lane). On failure, the proposer retries once with correction feedback. Double failure → graceful abort.
4. Run solver on validated proposal (protected treat budget upfront, uniform per-slot targets)
5. Validate solver output via QA gate → show proposal.

**proposal** — Full plan displayed with: breakfast, meal prep batches (uniform per-serving calorie shown once as a header, rounded to nearest 10 — e.g. "each ~800 cal/serving"), events, flex meal, treat budget, cooking schedule, weekly totals. User picks: [Looks good!] or types an adjustment.

When the user types text in this phase, it goes through `handleMutationText()` → the re-proposer agent (`plan-reproposer.ts`). The re-proposer receives the current plan + user message + mutation history and returns one of:
- **proposal** — complete new plan. Validated, solver re-runs, `diffProposals()` generates a change summary, updated plan shown. User stays in `proposal` phase.
- **clarification** — question for the user (e.g. "which meal do you mean?"). Stored in `pendingClarification`; user's next message combines original request + answer for a second re-proposer call.
- **failure** — two validation failures. Prior plan kept, user asked to rephrase.

If the user asks for a recipe not in the DB, the re-proposer returns a clarification with `recipeNeeded` set. User confirms → `generateRecipe()` runs → recipe persisted → re-proposer re-runs with the updated DB.

Mutation history accumulates per session (cleared on confirm). Each shown mutation appends to history so subsequent re-proposer calls respect prior changes.

**confirmed** — Recipe scaler runs on each batch (adjusts ingredients to the solver's per-slot target within ±20 cal, preserving protein). Plan saved to Supabase. Any existing active plans are transitioned to completed first. Shows shopping list / view recipes buttons.

### Key behaviors

- **No explicit fun food step.** Flex slots are auto-suggested by the plan-proposer and presented in the proposal. Users can adjust flex placement by typing in the proposal phase.
- **One-message mutations.** All plan adjustments (flex moves, recipe swaps, event add/remove) are handled by a single re-proposer LLM call. No separate swap phase, no intent classification, no deterministic mutation handlers.
- **Event corrections.** During event collection, the system distinguishes corrections to the last event from new events using nano LLM classification.
- **Multi-turn recipe refinement.** During gap recipe review, free-text messages refine the recipe via conversation history (not regeneration from scratch).

## Recipe flow (`src/agents/recipe-flow.ts`)

Standalone recipe generation/editing flow, separate from planning.

### Phases

```
choose_meal_type → awaiting_preferences → reviewing → [awaiting_refinement → reviewing →] (save/discard)
```

**choose_meal_type** — User picks: Breakfast / Lunch / Dinner.

**awaiting_preferences** — User describes what they want (text or voice). Optional — they can also just tap a meal type and let the system decide.

**reviewing** — Recipe generated, rendered, and shown. Options: [Save] / [Refine] / [New recipe] / [Discard].

**awaiting_refinement** — User describes changes. Multi-turn refinement via conversation history.

### Edit mode

Existing recipes can be edited via `createEditFlowState(recipe)`. This seeds the conversation history with the existing recipe as the assistant's prior output, then enters `awaiting_refinement` so the LLM makes targeted changes instead of regenerating.

## Shopping list flow

Generated after plan confirmation from `src/shopping/generator.ts`. Aggregates `scaledIngredients` across all batches + breakfast recipe ingredients x7.

Displayed via [View shopping list] button. Supports:
- [Add items] — user-added non-food items (water, paper towels)
- [Share list] — forwards as a message
