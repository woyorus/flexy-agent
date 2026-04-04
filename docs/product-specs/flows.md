# User Flows

> Scope: All user-facing conversation flows — plan week, recipe generation, shopping list. See also: [ui.md](./ui.md) for keyboards/formatting, [solver.md](./solver.md) for budget math.

## Plan week flow (`src/agents/plan-flow.ts`)

The main weekly ritual. Suggestive-first: the system proposes a complete plan, the user approves or tweaks.

### Phases

```
context → awaiting_events → generating_proposal →
  [recipe_suggestion → awaiting_recipe_prefs → generating_recipe → reviewing_recipe →]
  proposal → [awaiting_swap →] confirmed
```

### Phase details

**context** — Entry point. Shows breakfast confirmation + events question. User taps "Keep it" to confirm breakfast, then either "No events" or "Add event."

**awaiting_events** — User adds events via free-text or voice. Each message is parsed by nano LLM into a `MealEvent` (day, mealTime, estimatedCalories). Supports corrections to the last event (nano classifies intent: new event vs correction). Loop until user taps "That's all."

**generating_proposal** — Heavy async step:
1. Load available recipes + recent plan history from DB/Supabase
2. Call plan-proposer sub-agent (generates recipe assignments, flex slot suggestions, identifies recipe gaps)
3. Run solver on the proposal (using real per-serving macros from recipes)
4. Validate solver output via QA gate
5. If recipe gaps exist → enter gap resolution loop. Otherwise → show proposal.

**recipe_suggestion** — Plan-proposer found a gap (not enough variety in the recipe DB for a meal type). Shows the gap reason and suggestion. User picks: [Generate it] / [I have an idea] / [Pick from my recipes].

**awaiting_recipe_prefs** — User describes preferences for the gap recipe (if they chose "I have an idea").

**generating_recipe** — Recipe-generator sub-agent creates a recipe for the gap. Runs QA validation + correction loop (max 2 corrections). Result stored in `state.currentRecipe`.

**reviewing_recipe** — User reviews the generated gap recipe. Options: [Use it] / [Different one]. Free-text during this phase is treated as a refinement request (multi-turn conversation with the generator).

**proposal** — Full plan displayed with: breakfast, meal prep batches (recipe name + servings + cal), events, flex meals, treat budget, cooking schedule, weekly totals. User picks: [Looks good!] / [Swap something].

**awaiting_swap** — User describes a swap via free-text. Nano LLM classifies into: `flex_add`, `flex_remove`, `recipe_swap`, or `unclear`. After applying the swap, solver re-runs and proposal is re-presented.

**confirmed** — Plan saved to Supabase. Any existing active plans are transitioned to completed first. Shows shopping list / view recipes buttons.

### Key behaviors

- **No explicit fun food step.** Flex slots are auto-suggested by the plan-proposer and presented in the proposal. Users can add/remove flex meals via the swap mechanism.
- **Inline recipe gap resolution.** When the plan-proposer identifies variety gaps, the flow enters a recipe generation sub-loop within the planning session rather than requiring a separate recipe creation step.
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
