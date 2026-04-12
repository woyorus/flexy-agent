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

## Flow: Post-confirmation plan mutation (Plan 029 — Flow 1 from proposal 003)

**The living-document feature.** A confirmed plan adapts to real life when the user types what happened.

**Entry points:** Any text or voice message during `lifecycle=active_*` or `lifecycle=upcoming` when no planning session is active. Typical phrasings: "I'm eating out tonight", "move the flex to Sunday", "swap tomorrow's dinner for fish".

**Flow:**

1. User's message goes through the dispatcher, which picks `mutate_plan` and forwards the request verbatim to the applier.
2. Applier's post-confirmation branch loads the active plan, runs the split-aware adapter to separate past (frozen) from active (mutable) slots, calls the re-proposer in post-confirmation mode.
3. Re-proposer produces either a new proposal or a clarification question. On proposal, the applier runs the solver and generates a change summary.
4. User sees the change summary with `[Confirm] [Adjust]` inline buttons:
   - `Confirm` → `confirmPlanSessionReplacing` persists the new session, old session is tombstoned.
   - `Adjust` → `pendingMutation` is cleared, user is prompted to describe the change again.

**Rules:** Meal-type lanes are never crossed (validator invariant #14). Near-future days (today + tomorrow) are soft-locked. Past slots are frozen.

**Known v0.0.5 limitations:** Calorie tracking of eat-out events is not implemented. Retroactive events are handled by shifting forward only. Post-confirmation clarifications persist via `pendingPostConfirmationClarification` (invariant #5). In-memory only.

See also: proposal 003 § "Flow 1 — Post-confirmation plan mutation".

## Flow: Side question during any phase (Plan 030)

**The conversational affordance.** Users can ask questions at any point — mid-planning, on a recipe view, from the shopping list — and get an answer without losing their place.

**Entry points:** Any text or voice message that the dispatcher classifies as `answer_plan_question`, `answer_recipe_question`, or `answer_domain_question`.

**Flow:**

1. Dispatcher classifies the question into one of three scopes:
   - `answer_plan_question` — about the user's active plan ("when's my next cook day?", "how many calories is Thursday?"). The plan summary is injected as context.
   - `answer_recipe_question` — about a specific recipe the user is viewing or recently viewed ("can I freeze this?", "what can I substitute for tahini in this?"). The recipe from `lastRenderedView` is injected as context.
   - `answer_domain_question` — general food/nutrition/cooking knowledge ("how much protein in 100g of chicken?", "what's a good substitute for tahini?"). No plan or recipe context needed.
2. An LLM-generated answer is returned. The answer is strictly read-only — no plan state, recipe state, or session state is mutated.
3. The response includes a `[← Back to ...]` inline button targeting the user's previous surface via `lastRenderedView`.

**Rules:** All three answer types are read-only. They must never trigger a plan mutation, recipe swap, or ingredient change. `planFlow`, `recipeFlow`, and all pending clarifications are preserved across the side conversation. The user returns exactly where they were.

## Flow: Natural-language navigation (Plan 030)

**Conversational shortcuts to existing views.** Users can type what they want to see instead of tapping through menus.

**Entry points:** Any text or voice message that the dispatcher classifies as `show_recipe`, `show_plan`, `show_shopping_list`, or `show_progress`.

**Flow:**

1. Dispatcher extracts structured parameters from natural language:
   - `show_recipe` — extracts a recipe slug. Resolves to cook view if the slug is in an active batch, library detail view otherwise. Multi-batch recipes pick the soonest cook day.
   - `show_plan` — extracts a day reference ("Thursday", "tomorrow", "next cook day") and resolves to an ISO date. Renders the day-detail view.
   - `show_shopping_list` — extracts a scope: `recipe` (filters to one recipe's ingredients) or `full_week` (aggregates across all cook days).
   - `show_progress` — renders the weekly summary report.
2. The resolved parameters are passed to the existing view renderers — the same code paths as the button-driven navigation.

**Rules:** Navigation actions update `lastRenderedView` and `surfaceContext` to reflect the new view, exactly as button-driven navigation does. Flow state (`planFlow`, `recipeFlow`) is preserved.

## Flow: Cross-surface measurement logging (Plan 030)

**Log a measurement from anywhere.** The user doesn't need to navigate to the Progress screen to record their weight.

**Entry points:** Any text or voice message that the dispatcher classifies as `log_measurement` when the user is NOT already in `awaiting_measurement` phase (that case is handled by the numeric pre-filter).

**Flow:**

1. Dispatcher picks `log_measurement` and extracts the measurement value from the user's message.
2. The handler persists the measurement to the store.
3. A confirmation message is shown. `surfaceContext` is preserved — the user's previous view is undisturbed.

**Rules:** The numeric pre-filter (`awaiting_measurement` phase) still takes precedence for the fast path. The dispatcher-driven `log_measurement` extends coverage to all other surfaces. `planFlow` and `recipeFlow` are preserved across the logging side-trip.
