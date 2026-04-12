# Plan 030: Secondary Actions — Answers, Navigation, and log_measurement

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Completed
**Date:** 2026-04-11
**Completed:** 2026-04-12
**Affects:** `src/agents/dispatcher.ts`, `src/telegram/dispatcher-runner.ts`, `src/telegram/core.ts`, `src/telegram/view-renderers.ts` (new), `src/telegram/navigation-state.ts`, `src/shopping/generator.ts`, `test/unit/view-renderers.test.ts` (new), `test/unit/shopping-generator-scopes.test.ts` (new), `test/unit/dispatcher-secondary-actions.test.ts` (new), 12 new scenarios under `test/scenarios/`, `docs/product-specs/ui-architecture.md`, `docs/product-specs/flows.md`, `docs/design-docs/proposals/003-freeform-conversation-layer.md`, `test/scenarios/index.md`.

**Goal:** Ship the remaining eight dispatcher actions from proposal 003's v0.0.5 catalog — `answer_plan_question`, `answer_recipe_question`, `answer_domain_question`, `show_recipe`, `show_plan`, `show_shopping_list`, `show_progress`, `log_measurement` — wiring each to the existing deterministic renderer or parser, extending the shopping generator with three new scopes (`full_week`, `recipe`, `day`), and promoting `rerenderLastView` in the dispatcher runner from Plan 028's placeholder to real re-render parity. **This is Plan E from proposal `003-freeform-conversation-layer.md`.** After this plan lands, the entire v0.0.5 catalog is live: the dispatcher can answer, navigate, log, and mutate from any surface during any phase, and the living-document promise from Flow 1 is surrounded by the full set of state-preserving secondary affordances.

**Architecture:** Three layers stacked on top of Plans A/B/C/D:

1. **View renderers extracted into a leaf module.** A new `src/telegram/view-renderers.ts` owns the small render helpers (`renderNextAction`, `renderWeekOverview`, `renderDayDetail`, `renderCookViewForBatch`, `renderCookViewForSlug`, `renderLibraryRecipeView`, `renderRecipeLibrary`, `renderShoppingListForScope`, `renderProgressView`) that today live inline inside `core.ts`'s callback `case` branches. Each helper takes `(session, deps, sink, params)`, loads its data, calls the existing formatters in `formatters.ts` (plan/shopping/progress views) or `recipes/renderer.ts` (cook view and library recipe view), and the keyboards in `keyboards.ts`, writes `setLastRenderedView(session, …)` (Plan 027 invariant), and invokes `sink.reply(...)`. `core.ts`'s callback handlers become thin wrappers that just parse the callback data and delegate. **The library list view (`showRecipeList` behind the `📖 My Recipes` reply-keyboard button) IS extracted as `renderRecipeLibrary` even though Plan E has no `show_recipe_library` action** — the second caller is `rerenderLastView`'s `recipes/library` variant, which must deliver full-fidelity parity per proposal 003 state preservation invariants #3 and #6 (natural-language "back to my recipes" after the user looked at the library should restore the exact pagination state, not emit a hint to tap a button). See the decision log for why the second-round review escalated this extraction from "deferred" to "required". The new module imports only from `models/`, `state/`, `recipes/`, `plan/helpers.ts`, `shopping/`, and `telegram/{formatters,keyboards,navigation-state}.ts` — no imports from `core.ts` so the dispatcher runner can use it without a cycle.

2. **Eight new action handlers in the dispatcher runner.** Each handler is a thin wrapper: `handleShowPlanAction` routes to `renderNextAction` / `renderWeekOverview` / `renderDayDetail` based on the `screen` param. `handleShowRecipeAction` resolves the slug into an active-plan batch if present (multi-batch disambiguation picks the soonest cook day per proposal 003 § "show_recipe"), otherwise renders the library view. `handleShowShoppingListAction` dispatches between the four scopes via the extended shopping generator. `handleShowProgressAction` delegates to `renderProgressView`. The three `answer_*` handlers send the dispatcher's pre-written reply verbatim with a `buildSideConversationKeyboard` back button. `handleLogMeasurementAction` is a thin wrapper around the existing `parseMeasurementInput` → `assignWeightWaist` → `formatMeasurementConfirmation` / disambiguation pipeline that `tryNumericPreFilter` in `dispatcher-runner.ts` already runs for the `awaiting_measurement` phase.

3. **Shopping generator gains three new scopes, keeping the old signature untouched.** `generateShoppingList` (for `next_cook`) stays as-is. Three new exports land alongside it: `generateShoppingListForWeek(batches, breakfast, { horizonStart, horizonEnd })`, `generateShoppingListForRecipe(batches, { recipeSlug })`, `generateShoppingListForDay(batches, breakfast, { day, remainingDays })`. Each reuses the internal `classifyIngredient` and `addIngredient` helpers via a new shared `buildShoppingListFromAggregated(aggregated)` finisher. The existing `sl_next` / `sl_<date>` callbacks in `core.ts` continue to call `generateShoppingList` unchanged. Plan E's `handleShowShoppingListAction` calls the new function for the corresponding scope.

**Tech Stack:** TypeScript, `node:test`, the existing scenario harness (`src/harness/runner.ts` + `test/scenarios/`), `LLMProvider` via `src/ai/provider.ts`, `FixtureLLMProvider` for scenario replay. No database changes, no new external dependencies, no changes to the grammY adapter.

**Scope:** Exactly the eight remaining v0.0.5 catalog entries, the view-renderer extraction, the shopping generator scope extension, the `rerenderLastView` upgrade, and scenario coverage. **Out of scope (explicitly deferred):** `answer_product_question` (its own future plan with an opinionated methodology knowledge base), ingredient-level plan recipe updates (re-proposer capability extension), `log_treat` / `log_eating_out` handlers (deviation accounting plan), multi-user timezone-aware time semantics (v0.1.0), session state persistence across bot restarts (v0.1.0), auto-confirm for small mutations (forever until re-proposer is production-proven), full re-parse of recipe bodies for `answer_recipe_question` (v0.0.5 answers from the recipe index in the dispatcher context — body inclusion is a future optimization).

**Dependencies:** Plan E has **HARD dependencies** on all four prior plans being fully merged and green.
- **Plan 026 (Plan A — re-proposer post-confirmation enablement)** contributes the `mutation_history` column and Plan A's re-proposer rules. Plan E does not call the adapter directly, but the cross-action state preservation scenario (scenario 065) exercises an `answer_plan_question` → `mutate_plan` → `plan_approve` sequence whose persisted `mutationHistory` must be carried correctly — that guarantee is Plan A's.
- **Plan 027 (Plan B — navigation state model)** provides `BotCoreSession.lastRenderedView` and `setLastRenderedView`. Plan E extends Plan B's `LastRenderedView` discriminated union with two new shopping variants (`full_week`, `recipe`) to cover the new scopes, and its view-renderers set the field via `setLastRenderedView` on every render.
- **Plan 028 (Plan C — dispatcher infrastructure)** provides `src/agents/dispatcher.ts`, `src/telegram/dispatcher-runner.ts`, `runDispatcherFrontDoor`, the context bundle builder, `recentTurns`, and the four minimal actions. Plan E extends the catalog to eight more actions (twelve total, plus `mutate_plan` from Plan D for thirteen v0.0.5 actions) and promotes `rerenderLastView` from Plan C's placeholder implementation to real view-renderer dispatch.
- **Plan 029 (Plan D — mutate_plan action)** provides the `mutate_plan` action already live in the dispatcher and the `applyMutationRequest` / `applyMutationConfirmation` applier. Plan E's cross-action state preservation scenario (scenario 065) sits on top of the full Plan D path.

**Plan E does NOT start until Plans A/B/C/D are all merged and `npm test` is fully green.** Task 1 verifies every dependency artifact exists.

---

## Problem

After Plans A–D land, the dispatcher is live as the front door for every inbound text/voice message, and it understands exactly five actions: `flow_input`, `clarify`, `out_of_scope`, `return_to_flow`, and `mutate_plan`. That slice delivers the living-document promise (Flow 1 from proposal 003), but it leaves the secondary catalog entries marked NOT AVAILABLE in the dispatcher prompt. Concretely, three problems remain:

1. **Side questions during any phase still route to `clarify` with "coming soon".** A user mid-planning who types "when's my next cook day?" sees the dispatcher pick `clarify` with an honest-but-frustrating "answering questions isn't built yet — that's coming next". Same for recipe Q&A ("can I freeze the tagine?") and domain Q&A ("substitute for tahini?"). The proposal's Flow 2 and Flow 3 are unreachable through the dispatcher even though the context bundle carries everything needed to answer.

2. **Natural-language navigation hits `out_of_scope`.** A user on the shopping surface who types "show me the calamari pasta" sees the dispatcher pick `out_of_scope` with "navigating by name isn't built yet — tap a button". The proposal's Flow 4 is unreachable. So is "show me Thursday's dinner", "what's in my shopping list for the full week?", "how am I doing on weight?" — all fall through to the same decline.

3. **`log_measurement` only works after tapping 📊 Progress.** A user on the plan surface who types "82.3 today" sees the dispatcher pick `clarify` with "I can only log measurements when you tap 📊 Progress first". The structural reason is that the numeric pre-filter only short-circuits when `progressFlow.phase === 'awaiting_measurement'`; any other state sends the text to the dispatcher, and Plan C's dispatcher prompt explicitly told the LLM to route `log_measurement` to clarify. The proposal's JTBD D2 ("log a measurement under 5 seconds") is under-delivered because the user has to navigate before typing.

Plan E closes all three gaps **without** extending the dispatcher's capabilities beyond classification and parameter extraction. The LLM still never writes state. Every read-only answer is a string the LLM produces from the context bundle. Every navigation action is a deterministic render of the exact same view the existing callback handlers produce. Every measurement log is a call to the exact same parser and store functions the `awaiting_measurement` phase already uses.

There is also a **fourth, smaller problem** this plan addresses in the same motion: Plan 028 Task 10 left `rerenderLastView` as a minimal placeholder that replies "Back to your plan. Tap 📋 My Plan for the current view." and relies on the user re-entering the surface manually. Once Plan E's view-renderers exist, `rerenderLastView` can delegate to them and the "ok back to the plan" phrase produces a real re-render of the exact view the user was looking at — closing the last remaining Plan C TODO.

---

## Plan of work

### File structure

**Files to create:**

- `src/telegram/view-renderers.ts` — Extracted render helpers. The module exports:
  - `renderNextAction(session, deps, sink)` — mirrors the `na_show` callback body.
  - `renderWeekOverview(session, deps, sink)` — mirrors `wo_show`.
  - `renderDayDetail(session, deps, sink, day)` — mirrors `dd_<date>`; validates `day` is an ISO date that falls within the visible plan horizon.
  - `renderCookViewForBatch(session, deps, sink, batchId)` — mirrors `cv_<batchId>`; loads the batch via `store.getBatch`, resolves the recipe via `recipes.getBySlug`, calls `renderCookView` from `recipes/renderer.ts`.
  - `renderCookViewForSlug(session, deps, sink, slug)` — **new** helper built for `show_recipe`. Enumerates the active plan's planned batches, filters to those whose `recipeSlug === slug`, picks the batch with the soonest `eatingDays[0]` (ties broken by `batchId` for determinism), and delegates to `renderCookViewForBatch`. Returns `'rendered' | 'not_in_plan'` so the `show_recipe` handler can fall back to the library view when the slug isn't in any active batch.
  - `renderLibraryRecipeView(session, deps, sink, slug)` — mirrors the `rv_<slug>` callback body for library recipes (per-serving amounts). This is the single-recipe library view (used for `show_recipe` when the slug isn't in an active batch).
  - `renderRecipeLibrary(session, deps, sink)` — mirrors the `showRecipeList` closure body that's today inlined in `core.ts` (`src/telegram/core.ts:1083–1113`). Reads `session.recipeListPage` from the structural slice, loads all recipes via `deps.recipes.getAll()`, checks plan lifecycle via `getPlanLifecycle`, computes `cookingSoonBatchViews` via the module-local `loadVisiblePlanAndBatches` helper, builds the paginated `recipeListKeyboard`, sets `lastRenderedView = { surface: 'recipes', view: 'library' }`, and emits the reply. Task 6 replaces `core.ts`'s `showRecipeList` closure with a thin wrapper that delegates to this helper. The second caller is `rerenderLastView`'s `recipes/library` branch (Task 19), which relies on this helper to deliver invariant-#6 parity (exact-view restore on natural-language back navigation).
  - `renderShoppingListForScope(session, deps, sink, scope)` — routes to the appropriate generator function based on `scope.kind`. The `scope` argument is a tagged union matching the new `ShoppingScope` type in `src/shopping/generator.ts`.
  - `renderProgressView(session, deps, sink, view)` — `view: 'log_prompt' | 'weekly_report'`. For `log_prompt`, mirrors the existing `progress` menu handler's "set awaiting_measurement phase + send prompt" path. For `weekly_report`, mirrors the `hasCompletedWeekReport` path that calls `formatWeeklyReport` from `formatters.ts`.
  - `ViewRendererDeps` — structural type alias equal to `BotCoreDeps` (`{ llm, recipes, store }`); aliased so the module doesn't take a transitive dependency on `core.ts`'s interface name.
  - `ViewRenderResult` — the `renderCookViewForSlug` return type alias `'rendered' | 'not_in_plan'`.

- `test/unit/view-renderers.test.ts` — Unit tests for each renderer. Seeds a `TestStateStore` with a canonical plan (tagine dinner batch Mon–Wed + grain-bowl lunch batch Mon–Fri) and asserts each renderer produces the expected text + keyboard + sets `session.lastRenderedView`. (`surfaceContext` is set by the call sites in Task 6, not by the renderers.) Covers: `renderNextAction` success, `renderWeekOverview` success, `renderDayDetail` with valid day, `renderDayDetail` with out-of-horizon day (returns a graceful "not in this week" reply), `renderCookViewForSlug` with single batch, `renderCookViewForSlug` with multi-batch (soonest wins), `renderCookViewForSlug` with no matching batch (returns `'not_in_plan'`), `renderLibraryRecipeView`, `renderRecipeLibrary` with and without an active plan (cookingSoonBatchViews shown vs. absent), `renderShoppingListForScope` for each scope, `renderProgressView` for both views.

- `test/unit/shopping-generator-scopes.test.ts` — Unit tests for the three new shopping generator functions. Covers: full-week aggregation across multiple cook days, recipe-scoped filtering, day-scoped filtering (eaten vs. cooked semantics — defined in Task 2, tested in Task 3), breakfast proration for `full_week` vs. no breakfast for `recipe`, empty-scope graceful handling.

- `test/unit/dispatcher-secondary-actions.test.ts` — Unit tests for the eight new dispatcher runner handlers (`handleAnswerPlanQuestionAction`, etc.). Each test exercises the handler directly with a stub `DispatcherRunnerDeps` and asserts the correct reply text, keyboard, and session state. The `dispatchMessage` parser and action-pick tests are in `test/unit/dispatcher-agent.test.ts` (extended in Task 10).

- `test/scenarios/054-answer-plan-question/spec.ts` + `recorded.json` — User with an active plan types "When's my next cook day?". Dispatcher picks `answer_plan_question`, replies inline with the answer derived from the plan summary in context, session state unchanged.

- `test/scenarios/055-answer-recipe-question/spec.ts` + `recorded.json` — User on the cook view of a tagine batch types "Can I freeze this?". Dispatcher picks `answer_recipe_question` with `recipe_slug: 'tagine'`, replies inline using the recipe index data (`freezable`, `reheat`).

- `test/scenarios/056-answer-domain-question/spec.ts` + `recorded.json` — User types "What's a good substitute for tahini?". Dispatcher picks `answer_domain_question`, replies inline with a short generic answer. Locks v0.0.5 behavior — generic model knowledge, no opinionated knowledge base yet.

- `test/scenarios/057-show-recipe-in-plan/spec.ts` + `recorded.json` — User on the menu types "show me the calamari pasta" and calamari pasta is in one active batch. Dispatcher picks `show_recipe({ recipe_slug: 'calamari-pasta' })`, handler renders the scaled cook view for that batch.

- `test/scenarios/058-show-recipe-library-only/spec.ts` + `recorded.json` — User types "show me the lasagna" and lasagna is in the library but not in any active batch. Dispatcher picks `show_recipe`, handler renders the library view with per-serving amounts.

- `test/scenarios/059-show-recipe-multi-batch/spec.ts` + `recorded.json` — User types "show me the grain bowl" and grain bowl appears in two active batches (one Mon–Wed lunch, one Fri–Sun lunch). Handler picks the batch with the soonest cook day (Mon) and renders its cook view. Regression lock for the v0.0.5 disambiguation rule.

- `test/scenarios/060-show-plan-day-detail-natural-language/spec.ts` + `recorded.json` — User types "what's Thursday looking like?". Dispatcher resolves "Thursday" to the next Thursday's ISO date using the plan horizon in context, picks `show_plan({ screen: 'day_detail', day: '<iso>' })`, handler calls `renderDayDetail` for that day.

- `test/scenarios/061-show-shopping-list-recipe-scope/spec.ts` + `recorded.json` — User types "shopping list for the tagine". Dispatcher picks `show_shopping_list({ scope: 'recipe', recipe_slug: 'tagine' })`, handler calls `generateShoppingListForRecipe` and renders the scoped list.

- `test/scenarios/062-show-shopping-list-full-week/spec.ts` + `recorded.json` — User types "full shopping list for the week". Dispatcher picks `show_shopping_list({ scope: 'full_week' })`, handler calls `generateShoppingListForWeek` and renders the week-spanning list.

- `test/scenarios/063-show-progress-weekly-report/spec.ts` + `recorded.json` — User types "how am I doing this week?" with a logged measurement today + measurements from last week. Dispatcher picks `show_progress({ view: 'weekly_report' })`, handler calls `renderProgressView('weekly_report')`.

- `test/scenarios/064-log-measurement-cross-surface/spec.ts` + `recorded.json` — User on the plan surface (no active `progressFlow`) types "82.3 today". Dispatcher picks `log_measurement({ weight: 82.3 })`, handler delegates to the existing parse → store → confirmation pipeline. The measurement lands in the store and `surfaceContext` stays `'plan'` — the user does not get teleported to the progress surface.

- `test/scenarios/065-answer-then-mutate-state-preservation/spec.ts` + `recorded.json` — **The cross-action regression lock.** User is mid-planning at `phase: 'proposal'` with mutation history `[{ constraint: 'initial', … }]`. User types "when's my flex this week?" — dispatcher picks `answer_plan_question`, responds inline, planFlow preserved. Then types "move the flex to Sunday" — dispatcher picks `mutate_plan`, applier's in-session branch runs on the preserved planFlow, mutation history extends to 2 entries. User taps `plan_approve`. The persisted session's `mutationHistory` has BOTH entries. This scenario is the direct embodiment of proposal 003 state preservation invariant #1.

**Files to modify:**

- `src/agents/dispatcher.ts`:
  - Extend `DispatcherAction` union with the eight new actions: `'answer_plan_question' | 'answer_recipe_question' | 'answer_domain_question' | 'show_recipe' | 'show_plan' | 'show_shopping_list' | 'show_progress' | 'log_measurement'`.
  - Extend `AVAILABLE_ACTIONS_V0_0_5` with the same eight actions.
  - Extend `DispatcherDecision` union with one variant per new action, each carrying its params. See Tasks 7–8 for variant specs.
  - Update `buildSystemPrompt` to flip each NOT AVAILABLE marker to AVAILABLE and add usage guidance + few-shot examples. Remove the "pick clarify / out_of_scope with honest deferral" instructions for every Plan E action.
  - Update `parseDecision` to handle each new action variant: extract required params, validate types, reject invalid shapes so the retry loop can correct them.

- `src/telegram/dispatcher-runner.ts`:
  - Add `handleAnswerPlanQuestionAction`, `handleAnswerRecipeQuestionAction`, `handleAnswerDomainQuestionAction`, `handleShowRecipeAction`, `handleShowPlanAction`, `handleShowShoppingListAction`, `handleShowProgressAction`, `handleLogMeasurementAction`.
  - Wire all eight handlers into the `switch (decision.action)` inside `runDispatcherFrontDoor`.
  - Replace the minimal `rerenderLastView` body with a dispatch over `session.lastRenderedView` that calls the new view-renderers for real re-render parity. This removes Plan C's Task 10 TODO.
  - Extract `renderMeasurementConfirmation` from `tryNumericPreFilter` as a shared helper — both `tryNumericPreFilter` and `handleLogMeasurementAction` call it, eliminating code duplication. No cross-module import needed since both live in `dispatcher-runner.ts`.
  - Add `DispatcherRunnerDeps` no-op — the existing `{ llm, recipes, store }` shape is sufficient for the new handlers because they go through the view-renderers, which take the same deps.

- `src/telegram/core.ts`:
  - Refactor the callback handlers to delegate to the new view-renderers. Each change is surgical: the `case` body becomes a parse + delegate. See Task 6 for the per-case changes.
  - `routeTextToActiveFlow`'s `awaiting_measurement` path was already moved to `tryNumericPreFilter` in `dispatcher-runner.ts` by Plan 028 Task 6/8. Only the `confirming_disambiguation` fallthrough remains in `core.ts`. No changes needed to the measurement pipeline in `core.ts`.

- `src/telegram/navigation-state.ts`:
  - Extend the `LastRenderedView` discriminated union with two new shopping variants:
    ```typescript
    | { surface: 'shopping'; view: 'full_week' }
    | { surface: 'shopping'; view: 'recipe'; recipeSlug: string }
    ```
  - Plan B's existing `{ surface: 'shopping'; view: 'next_cook' }` and `{ surface: 'shopping'; view: 'day'; day: string }` stay unchanged.

- `src/shopping/generator.ts`:
  - Add an exported `ShoppingScope` tagged union type:
    ```typescript
    export type ShoppingScope =
      | { kind: 'next_cook'; targetDate: string; remainingDays: number }
      | { kind: 'full_week'; horizonStart: string; horizonEnd: string }
      | { kind: 'recipe'; recipeSlug: string }
      | { kind: 'day'; day: string; remainingDays: number };
    ```
  - Add three new exported functions: `generateShoppingListForWeek`, `generateShoppingListForRecipe`, `generateShoppingListForDay`. Each calls a new internal `buildShoppingListFromAggregated(aggregated)` helper that runs classification + tier assignment (extracted from the existing `generateShoppingList` body).
  - Existing `generateShoppingList` stays. It continues to call `buildShoppingListFromAggregated` internally after the refactor, so there's no behavioral change — Task 3 verifies with unit tests.

- `docs/product-specs/ui-architecture.md`:
  - Flip all eight Plan E rows in the "v0.0.5 minimal action catalog" table from "🚧 Plan E" to "✅ Plan 030".
  - Add a new "Secondary actions (Plan 030)" subsection describing the read-only Q&A rules, the navigation handler patterns (especially `show_recipe` disambiguation), the shopping scope matrix, and the cross-surface `log_measurement` behavior.

- `docs/product-specs/flows.md`:
  - Add three new short sections: "Flow: side question during any phase", "Flow: natural-language navigation", "Flow: cross-surface measurement logging". Each narrates the happy path and the state-preservation guarantee.

- `docs/design-docs/proposals/003-freeform-conversation-layer.md`:
  - Update the implementation marker near the top: `Implementation: Plans A (026), B (027), C (028), D (029), E (030) all complete. v0.0.5 catalog fully live.`

- `test/scenarios/index.md`:
  - Add rows for scenarios 054–065 with short descriptions.

- **Every pre-Task-9 scenario that fires text through the dispatcher** needs regeneration after the prompt flip, because the fixture hash changes when the prompt changes — not just scenarios where the action pick would change. Task 33 runs `npm test` to identify all affected scenarios by "fixture not found" failures, then regenerates in parallel and reviews serially. See Task 33 for the full candidate list and process.

**Files NOT modified (deliberate scope guard):**

- `src/plan/session-to-proposal.ts` (Plan A) — untouched. Plan E's scenario 065 exercises the full Plan D path without touching the adapter directly.
- `src/plan/mutate-plan-applier.ts` (Plan D) — untouched. Plan E's scenario 065 invokes it via the existing `handleMutatePlanAction`.
- `src/agents/plan-reproposer.ts`, `src/agents/plan-flow.ts`, `src/solver/solver.ts`, `src/qa/validators/proposal.ts` — untouched. Plan E is pure UI / dispatcher surface work.
- `src/state/store.ts`, `src/harness/test-store.ts`, `supabase/migrations/*`, `supabase/schema.sql` — no schema changes. `LastRenderedView` extensions live in-memory only and the shopping generator doesn't persist anything.
- `src/telegram/bot.ts` — no grammY adapter changes.
- `src/ai/*` — no LLM provider changes.

### Task order rationale

Tasks run strictly top-to-bottom.

- **Task 1** sets the baseline and verifies every Plan A/B/C/D artifact exists before Plan E starts.
- **Task 2** extends the shopping generator with the three new scope functions (`generateShoppingListForWeek`, `generateShoppingListForRecipe`, `generateShoppingListForDay`) — the view-renderers in Task 5 depend on these exports.
- **Task 3** unit-tests the new shopping scope functions to lock in their behavior before anything imports them.
- **Task 4** extends Plan B's `LastRenderedView` union with the two new shopping variants (`full_week`, `recipe`) so subsequent tasks can use them.
- **Task 5** creates `src/telegram/view-renderers.ts` with every extracted render helper — the biggest structural task in the plan. The module is standalone until Task 6 wires it in.
- **Task 6** refactors `core.ts` callback handlers to delegate to the view-renderers module — one `case` body at a time, with `npm test` staying green after each step. This task also replaces `showRecipeList`'s closure body with a thin delegation to `renderRecipeLibrary` (Step 9) so natural-language back navigation for the library variant can deliver full parity in Task 19.
- **Tasks 7–9** expand the dispatcher catalog: Task 7 adds the `DispatcherAction` / `AVAILABLE_ACTIONS_V0_0_5` / `DispatcherDecision` type extensions AND updates the disallowed-action unit test (since `answer_plan_question` is now allowed), Task 8 extends `parseDecision` for each new action variant (Tasks 7+8 are a combined commit pair), Task 9 flips each of the eight Plan E actions in `buildSystemPrompt` from NOT AVAILABLE to AVAILABLE and adds few-shot examples. Task 9 is the "intentional red" task — the prompt change invalidates cached dispatcher fixtures and a handful of existing scenarios go red pending Task 33's regeneration.
- **Task 10** adds positive dispatcher-agent unit tests for the eight new Plan E actions (confirming `parseDecision` accepts valid responses for each).
- **Tasks 11–17** add the eight new dispatcher runner handlers. Task 12 bundles `handleAnswerRecipeQuestionAction` + `handleAnswerDomainQuestionAction` because both answer handlers have the same shape (dispatcher-authored reply + side-conversation keyboard). That leaves seven task headers for eight handlers. Each handler is a small wrapper over the view-renderers or existing helpers, TDD-tested via unit tests in `test/unit/dispatcher-secondary-actions.test.ts`.
- **Task 18** wires all eight handlers into the runner's decision `switch`.
- **Task 19** upgrades `rerenderLastView` to call the real renderers — closes the last Plan C TODO and delivers proposal 003 invariant #6 for every `LastRenderedView` variant, including `recipes/library` (via `renderRecipeLibrary`).
- **Task 20** adds the integration unit tests for the view-renderers against a `TestStateStore` seeded with a canonical plan.
- **Tasks 21–32** add the twelve new scenarios (one per task — 054 through 065), each generated + behaviorally reviewed + committed individually, per CLAUDE.md's "regenerate in parallel, review serially" rule adapted for new authoring.
- **Task 33** regenerates existing scenarios that captured pre-Task-9 dispatcher fixtures.
- **Task 34** updates `test/scenarios/index.md` with rows for 054–065.
- **Task 35** syncs `ui-architecture.md`, `flows.md`, and proposal 003's status marker.
- **Task 36** is the final baseline + commit chain verification.

Every task ends with a commit. `npm test` stays green after every task except Task 9 (where the dispatcher prompt flips and a handful of existing scenarios go red pending Task 33's regeneration — same intentional-red pattern Plans B/C/D used). **Note:** Tasks 7 and 8 are a combined commit pair — Task 7 extends the types (typecheck fails until Task 8 adds the `parseDecision` cases) and also updates the disallowed-action unit test that would otherwise break when `AVAILABLE_ACTIONS_V0_0_5` is extended.

---

## Tasks

### Task 1: Green baseline + dependency verification

**Files:** none — sanity check.

- [ ] **Step 1: Confirm clean `npm test`**

Run: `npm test`
Expected: all scenarios and unit tests pass. Note the count in the output (something like `# tests NN`) so later tasks can confirm no regressions. **If any test is red, STOP — Plan E has a hard dependency on Plans A/B/C/D being fully green.**

- [ ] **Step 2: Confirm Plan 026 (Plan A) artifacts exist**

Use the Glob tool on `src/plan/session-to-proposal.ts`. Expected: file exists.
Use the Grep tool on `src/models/types.ts` for `mutationHistory`. Expected: field exists on `PlanSession`.
Use the Grep tool on `src/qa/validators/proposal.ts` for `#14`. Expected: invariant #14 exists.
Use the Glob tool on `supabase/migrations/005_plan_session_mutation_history.sql`. Expected: file exists.

- [ ] **Step 3: Confirm Plan 027 (Plan B) artifacts exist**

Use the Glob tool on `src/telegram/navigation-state.ts`. Expected: file exists.
Use the Grep tool on `src/telegram/core.ts` for `lastRenderedView`. Expected: multiple hits.
Use the Grep tool on `src/telegram/navigation-state.ts` for `LastRenderedView`. Expected: the discriminated union exists.

- [ ] **Step 4: Confirm Plan 028 (Plan C) artifacts exist**

Use the Glob tool on `src/agents/dispatcher.ts` and `src/telegram/dispatcher-runner.ts`. Expected: both exist.
Use the Grep tool on `src/agents/dispatcher.ts` for `AVAILABLE_ACTIONS_V0_0_5`. Expected: constant exists.
Use the Grep tool on `src/telegram/dispatcher-runner.ts` for `runDispatcherFrontDoor` and `rerenderLastView`. Expected: both exist.
Use the Grep tool on `src/telegram/core.ts` for `runDispatcherFrontDoor`. Expected: dispatcher is wired.

- [ ] **Step 5: Confirm Plan 029 (Plan D) artifacts exist**

Use the Glob tool on `src/plan/mutate-plan-applier.ts`. Expected: file exists.
Use the Grep tool on `src/agents/dispatcher.ts` for `mutate_plan`. Expected: hits in `DispatcherAction`, `AVAILABLE_ACTIONS_V0_0_5`, `DispatcherDecision`, and `buildSystemPrompt`.
Use the Grep tool on `src/telegram/keyboards.ts` for `mutateConfirmKeyboard`. Expected: exported.
Use the Grep tool on `src/telegram/core.ts` for `mp_confirm` and `pendingMutation`. Expected: both exist.

If ANY of these checks fail, **STOP** — the missing plan must land first. Do not proceed with Plan E against a partial dependency tree.

- [ ] **Step 6: Note the current scenario range**

Use the Glob tool with pattern `test/scenarios/*/spec.ts`. Record the highest `NNN-` prefix. Expected: `053` (Plan D's highest — Plan 029 adds 044 through 053, with 053 being the invariant-#5 post-confirmation clarification resume scenario from Plan 029 Task 22). Plan E uses 054–065. Scenario paths and cross-references throughout this plan already use the corrected 054–065 numbering.

- [ ] **Step 7: Confirm there is no existing `src/telegram/view-renderers.ts`**

Use the Glob tool on `src/telegram/view-renderers.ts`. Expected: no match. Task 5 creates it.

No commit — this is a verification step.

---

### Task 2: Extend the shopping generator with three new scope functions

**Rationale:** The view-renderer module in Task 5 imports `generateShoppingListForWeek`, `generateShoppingListForRecipe`, and `generateShoppingListForDay` from `src/shopping/generator.ts`. Those exports must exist before Task 5 creates the module. This task adds them without touching the existing `generateShoppingList` function — the existing signature stays so `sl_next` / `sl_<date>` callbacks continue to work unchanged.

**Files:**
- Modify: `src/shopping/generator.ts`

- [ ] **Step 1: Read the existing generator to understand the shared helpers**

Use the Read tool on `src/shopping/generator.ts`. Expected: the file exports `generateShoppingList` (function, lines 118–202) and has internal helpers `classifyIngredient` (~line 88), `addIngredient` (~line 212), `roundAmount` (~line 250), plus `TIER_1_EXCLUSIONS`, `TIER_2_PANTRY`, and `CATEGORY_ORDER` constants. The tier classification + category assignment logic is self-contained — it operates on a name + role + amount tuple and returns a classification.

Note the current signature:
```typescript
export function generateShoppingList(
  batches: Batch[],
  breakfastRecipe: Recipe | undefined,
  options: { targetDate: string; remainingDays: number },
): ShoppingList
```

And the current body structure:
1. Filter `batches` to cook-day match (line 140).
2. Accumulate ingredients into `aggregated` map.
3. Optionally add prorated breakfast ingredients.
4. Classify + split into tiers.
5. Return `ShoppingList`.

Plan E's new scope functions share steps 2–5 but differ in step 1 (which batches) and step 3 (whether and how to include breakfast).

- [ ] **Step 2: Extract the shared finisher into an internal helper**

Refactor `generateShoppingList` to move its "classify + build ShoppingList" tail into a shared helper. Replace the current body of `generateShoppingList` (lines 118–202) with this pair:

```typescript
/**
 * Shopping scope tag — used by Plan 030's dispatcher-driven shopping list
 * renders. The existing `sl_next` and `sl_<date>` callbacks do NOT use
 * this type; they continue to call `generateShoppingList` directly.
 */
export type ShoppingScope =
  | { kind: 'next_cook'; targetDate: string; remainingDays: number }
  | { kind: 'full_week'; horizonStart: string; horizonEnd: string }
  | { kind: 'recipe'; recipeSlug: string }
  | { kind: 'day'; day: string; remainingDays: number };

/**
 * Generate a shopping list scoped to a single cook day. Existing signature,
 * unchanged — `sl_next` / `sl_<date>` callbacks continue to call this.
 *
 * @param batches - All planned batches (filtered to target cook date internally)
 * @param breakfastRecipe - The locked breakfast recipe (prorated to remainingDays)
 * @param options - Target cook date and remaining plan days for breakfast proration
 */
export function generateShoppingList(
  batches: Batch[],
  breakfastRecipe: Recipe | undefined,
  options: { targetDate: string; remainingDays: number },
): ShoppingList {
  const { targetDate, remainingDays } = options;
  const aggregated = newAggregationMap();
  const cookBatches = batches.filter((b) => b.eatingDays[0] === targetDate);

  for (const batch of cookBatches) {
    for (const ing of batch.scaledIngredients) {
      addIngredient(aggregated, ing.name, ing.totalForBatch, ing.unit, ing.role);
    }
  }
  if (breakfastRecipe) {
    for (const ing of breakfastRecipe.ingredients) {
      const proratedAmount = ing.amount * remainingDays;
      const note = `(breakfast, ${remainingDays} days)`;
      addIngredient(aggregated, ing.name, proratedAmount, ing.unit, ing.role, note);
    }
  }

  return buildShoppingListFromAggregated(aggregated);
}

/**
 * Internal: the classification + tier split + ShoppingList construction step
 * that used to live inline inside `generateShoppingList`. Shared by every
 * Plan 030 scope function.
 */
function buildShoppingListFromAggregated(
  aggregated: Map<string, AggregatedEntry>,
): ShoppingList {
  const tier2Items: string[] = [];
  const tier3ByCategory = new Map<string, ShoppingItem[]>();

  for (const [, data] of aggregated) {
    const classification = classifyIngredient(data.displayName, data.role);
    if (!classification) continue;

    if (classification.tier === 2) {
      tier2Items.push(data.displayName);
      continue;
    }
    const items = tier3ByCategory.get(classification.category) ?? [];
    items.push({
      name: data.displayName,
      amount: roundAmount(data.amount),
      unit: data.unit,
      ...(data.note && { note: data.note }),
    });
    tier3ByCategory.set(classification.category, items);
  }

  const categories: ShoppingCategory[] = CATEGORY_ORDER
    .filter((cat) => tier3ByCategory.has(cat))
    .map((cat) => ({
      name: cat,
      items: tier3ByCategory.get(cat)!.sort((a, b) => a.name.localeCompare(b.name)),
    }));
  for (const [cat, items] of tier3ByCategory) {
    if (!CATEGORY_ORDER.includes(cat)) {
      categories.push({ name: cat, items: items.sort((a, b) => a.name.localeCompare(b.name)) });
    }
  }

  return {
    categories,
    checkYouHave: tier2Items.sort(),
    customItems: [],
  };
}

interface AggregatedEntry {
  displayName: string;
  amount: number;
  unit: string;
  role: IngredientRole;
  note?: string;
}

function newAggregationMap(): Map<string, AggregatedEntry> {
  return new Map();
}
```

**Note:** The new `AggregatedEntry` interface and `newAggregationMap` factory replace the anonymous inline type literal the old `generateShoppingList` used. They're exported as internal-only (no `export` keyword). The `addIngredient` helper already takes a structural `Map<string, {...}>` so its signature doesn't change — verify this by reading lines 212–247 of the current file and confirming the map value type matches `AggregatedEntry` structurally. If it doesn't (different field names), either update `addIngredient`'s signature to use `AggregatedEntry` directly, or leave the inline type and have `newAggregationMap` match.

- [ ] **Step 3: Add `generateShoppingListForWeek`**

Append to `src/shopping/generator.ts` after `buildShoppingListFromAggregated`:

```typescript
/**
 * Generate a shopping list covering every batch in a horizon.
 *
 * Aggregates ingredients across ALL batches whose first eating day falls
 * inside `[horizonStart, horizonEnd]`. Breakfast is prorated to the full
 * horizon length in days (inclusive).
 *
 * Used by Plan 030's `show_shopping_list({ scope: 'full_week' })` handler.
 */
export function generateShoppingListForWeek(
  batches: Batch[],
  breakfastRecipe: Recipe | undefined,
  options: { horizonStart: string; horizonEnd: string },
): ShoppingList {
  const { horizonStart, horizonEnd } = options;
  const aggregated = newAggregationMap();

  // A batch "belongs" to the horizon if its cook day (eatingDays[0]) is
  // in [horizonStart, horizonEnd]. We exclude batches whose first eating
  // day is before the horizon because the user has already shopped for
  // them; we include carryover batches whose cook day is in-horizon.
  const weekBatches = batches.filter((b) => {
    const cookDay = b.eatingDays[0];
    if (!cookDay) return false;
    return cookDay >= horizonStart && cookDay <= horizonEnd;
  });

  for (const batch of weekBatches) {
    for (const ing of batch.scaledIngredients) {
      addIngredient(aggregated, ing.name, ing.totalForBatch, ing.unit, ing.role);
    }
  }

  if (breakfastRecipe) {
    const horizonDays = horizonDayCount(horizonStart, horizonEnd);
    for (const ing of breakfastRecipe.ingredients) {
      const proratedAmount = ing.amount * horizonDays;
      const note = `(breakfast, ${horizonDays} days)`;
      addIngredient(aggregated, ing.name, proratedAmount, ing.unit, ing.role, note);
    }
  }

  return buildShoppingListFromAggregated(aggregated);
}

function horizonDayCount(start: string, end: string): number {
  const s = new Date(start + 'T00:00:00Z').getTime();
  const e = new Date(end + 'T00:00:00Z').getTime();
  return Math.round((e - s) / 86_400_000) + 1;
}
```

- [ ] **Step 4: Add `generateShoppingListForRecipe`**

Append:

```typescript
/**
 * Generate a shopping list for a single recipe across all active batches.
 *
 * Filters batches by `recipeSlug` and aggregates their ingredients.
 * Usually one batch matches, sometimes more (e.g., two batches of the
 * same recipe in different weeks); this function aggregates across all
 * of them so the user sees one total per ingredient.
 *
 * NO breakfast proration — recipe-scoped shopping is about a single dish,
 * not a meal plan.
 *
 * Used by Plan 030's `show_shopping_list({ scope: 'recipe', recipe_slug })` handler.
 */
export function generateShoppingListForRecipe(
  batches: Batch[],
  options: { recipeSlug: string },
): ShoppingList {
  const { recipeSlug } = options;
  const aggregated = newAggregationMap();

  const matching = batches.filter((b) => b.recipeSlug === recipeSlug);
  for (const batch of matching) {
    for (const ing of batch.scaledIngredients) {
      addIngredient(aggregated, ing.name, ing.totalForBatch, ing.unit, ing.role);
    }
  }

  return buildShoppingListFromAggregated(aggregated);
}
```

- [ ] **Step 5: Add `generateShoppingListForDay`**

Append:

```typescript
/**
 * Generate a shopping list for a single day.
 *
 * **Semantics for v0.0.5**: "day" means the COOK day. Any batch whose
 * first eating day (`eatingDays[0]`) equals the target day contributes
 * its full ingredient load. This matches the existing `generateShoppingList`
 * behavior scoped to one day and is the most useful interpretation for
 * shoppers — "what do I need to buy to cook on Friday?".
 *
 * Breakfast is prorated to `remainingDays` (same semantics as `generateShoppingList`).
 *
 * Used by Plan 030's `show_shopping_list({ scope: 'day', day })` handler.
 *
 * NOTE: An alternative interpretation is "any batch whose eating days
 * INCLUDE the target day" (to answer "what am I eating on Friday?").
 * Plan 030 does not implement this because it's structurally the same
 * query as `renderDayDetail` — Day Detail shows what you're EATING, and
 * a shopping list for that day would just be the cook-day list already.
 * A user asking "what's for Friday" wants Day Detail; a user asking
 * "shopping list for Friday" wants the cook-day shopping list. Document
 * this decision in the scenario 062 behavioral review so the review
 * picks up any disagreement.
 */
export function generateShoppingListForDay(
  batches: Batch[],
  breakfastRecipe: Recipe | undefined,
  options: { day: string; remainingDays: number },
): ShoppingList {
  const { day, remainingDays } = options;
  // Structurally identical to generateShoppingList(batches, breakfast,
  // { targetDate: day, remainingDays }). Delegate to avoid duplication.
  return generateShoppingList(batches, breakfastRecipe, {
    targetDate: day,
    remainingDays,
  });
}
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. The refactored `generateShoppingList` keeps its public signature, so every call site continues to work.

- [ ] **Step 7: Run tests**

Run: `npm test`
Expected: PASS. Every existing scenario that exercises the shopping list (019, 031, ...) must still pass because the public behavior of `generateShoppingList` is unchanged. If any scenario fails with a diff, the refactor changed behavior — investigate and fix before proceeding.

- [ ] **Step 8: Commit**

```bash
git add src/shopping/generator.ts
git commit -m "Plan 030: extract buildShoppingListFromAggregated + add week/recipe/day scope functions"
```

---

### Task 3: Unit test the new shopping scope functions

**Rationale:** The three new shopping generator functions are pure, deterministic, and fully unit-testable without touching the harness. Landing a unit test before the view-renderer module is created ensures the Task 5 renderer module has a green pedestal to stand on.

**Files:**
- Create: `test/unit/shopping-generator-scopes.test.ts`

- [ ] **Step 1: Write the test file**

Create `test/unit/shopping-generator-scopes.test.ts` with:

```typescript
/**
 * Unit tests for Plan 030's new shopping generator scope functions.
 *
 * Covers:
 *   - full_week aggregation across multiple cook days
 *   - full_week breakfast proration to horizon length
 *   - recipe-scoped filtering (single batch, multi-batch aggregation)
 *   - recipe-scoped omits breakfast
 *   - day-scoped matches generateShoppingList behavior
 *   - empty-scope graceful handling
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  generateShoppingList,
  generateShoppingListForWeek,
  generateShoppingListForRecipe,
  generateShoppingListForDay,
} from '../../src/shopping/generator.js';
import type { Batch, Recipe } from '../../src/models/types.js';

function batch(id: string, slug: string, cookDay: string, ingredients: Array<{ name: string; amount: number; unit: string; role: 'protein' | 'carb' | 'vegetable' | 'fat' | 'base' | 'seasoning' }>): Batch {
  return {
    id,
    recipeSlug: slug,
    mealType: 'dinner',
    eatingDays: [cookDay],
    servings: 2,
    targetPerServing: { calories: 800, protein: 45 },
    actualPerServing: { calories: 800, protein: 45, fat: 30, carbs: 60 },
    scaledIngredients: ingredients.map((i) => ({ ...i, totalForBatch: i.amount })),
    status: 'planned',
    createdInPlanSessionId: 'sess-1',
  };
}

function recipeWithIngredients(slug: string, ingredients: Array<{ name: string; amount: number; unit: string; role: 'protein' | 'carb' | 'vegetable' | 'fat' | 'base' | 'seasoning' }>): Recipe {
  return {
    name: slug,
    shortName: slug,
    slug,
    cuisine: 'test',
    tags: [],
    prepTimeMinutes: 0,
    structure: [{ type: 'main', name: 'Main' }],
    perServing: { calories: 400, protein: 15, fat: 10, carbs: 50 },
    servings: 1,
    ingredients,
    instructions: [],
    storage: { fridgeDays: 3, freezable: false, reheat: 'microwave' },
    mealTypes: ['breakfast'],
  } as unknown as Recipe;
}

test('generateShoppingListForWeek: aggregates across multiple cook days', () => {
  const batches = [
    batch('b1', 'tagine', '2026-04-06', [{ name: 'beef', amount: 400, unit: 'g', role: 'protein' }]),
    batch('b2', 'grain-bowl', '2026-04-09', [{ name: 'quinoa', amount: 300, unit: 'g', role: 'carb' }]),
    batch('b3', 'tagine', '2026-04-10', [{ name: 'beef', amount: 200, unit: 'g', role: 'protein' }]),
  ];
  const list = generateShoppingListForWeek(batches, undefined, {
    horizonStart: '2026-04-06',
    horizonEnd: '2026-04-12',
  });
  // Beef from b1 + b3 aggregated to 600g.
  const meatCategory = list.categories.find((c) => c.name === 'MEAT');
  assert.ok(meatCategory, 'MEAT category should exist');
  const beef = meatCategory!.items.find((i) => i.name === 'beef');
  assert.ok(beef, 'beef should be aggregated');
  assert.equal(beef!.amount, 600);
});

test('generateShoppingListForWeek: prorates breakfast to horizon length', () => {
  const batches = [batch('b1', 'tagine', '2026-04-06', [{ name: 'beef', amount: 400, unit: 'g', role: 'protein' }])];
  const breakfast = recipeWithIngredients('oatmeal', [{ name: 'oats', amount: 50, unit: 'g', role: 'carb' }]);
  const list = generateShoppingListForWeek(batches, breakfast, {
    horizonStart: '2026-04-06',
    horizonEnd: '2026-04-12',
  });
  // 7 days * 50g = 350g oats.
  const pantry = list.categories.find((c) => c.name === 'PANTRY');
  assert.ok(pantry, 'PANTRY category should exist');
  const oats = pantry!.items.find((i) => i.name === 'oats');
  assert.ok(oats, 'oats should be in pantry');
  assert.equal(oats!.amount, 350);
});

test('generateShoppingListForRecipe: filters to single slug', () => {
  const batches = [
    batch('b1', 'tagine', '2026-04-06', [{ name: 'beef', amount: 400, unit: 'g', role: 'protein' }]),
    batch('b2', 'grain-bowl', '2026-04-09', [{ name: 'quinoa', amount: 300, unit: 'g', role: 'carb' }]),
  ];
  const list = generateShoppingListForRecipe(batches, { recipeSlug: 'tagine' });
  // Only tagine's beef — no quinoa.
  const meat = list.categories.find((c) => c.name === 'MEAT');
  assert.ok(meat);
  assert.equal(meat!.items.length, 1);
  assert.equal(meat!.items[0]!.name, 'beef');
  const pantry = list.categories.find((c) => c.name === 'PANTRY');
  assert.equal(pantry, undefined, 'quinoa should not appear');
});

test('generateShoppingListForRecipe: aggregates multi-batch', () => {
  const batches = [
    batch('b1', 'tagine', '2026-04-06', [{ name: 'beef', amount: 400, unit: 'g', role: 'protein' }]),
    batch('b2', 'tagine', '2026-04-10', [{ name: 'beef', amount: 200, unit: 'g', role: 'protein' }]),
  ];
  const list = generateShoppingListForRecipe(batches, { recipeSlug: 'tagine' });
  const beef = list.categories.find((c) => c.name === 'MEAT')!.items[0]!;
  assert.equal(beef.amount, 600);
});

test('generateShoppingListForRecipe: omits breakfast (no breakfast param)', () => {
  // The function doesn't take a breakfast arg — there's no way to include it.
  // This test just confirms the signature by a successful call.
  const batches = [batch('b1', 'tagine', '2026-04-06', [{ name: 'beef', amount: 400, unit: 'g', role: 'protein' }])];
  const list = generateShoppingListForRecipe(batches, { recipeSlug: 'tagine' });
  // No oats in the output because there's no breakfast.
  const allItems = list.categories.flatMap((c) => c.items);
  assert.equal(allItems.find((i) => i.name === 'oats'), undefined);
});

test('generateShoppingListForDay: matches generateShoppingList output', () => {
  const batches = [batch('b1', 'tagine', '2026-04-09', [{ name: 'beef', amount: 400, unit: 'g', role: 'protein' }])];
  const breakfast = recipeWithIngredients('oatmeal', [{ name: 'oats', amount: 50, unit: 'g', role: 'carb' }]);
  const a = generateShoppingList(batches, breakfast, { targetDate: '2026-04-09', remainingDays: 4 });
  const b = generateShoppingListForDay(batches, breakfast, { day: '2026-04-09', remainingDays: 4 });
  assert.deepStrictEqual(a, b);
});

test('generateShoppingListForWeek: empty batches produces empty list', () => {
  const list = generateShoppingListForWeek([], undefined, { horizonStart: '2026-04-06', horizonEnd: '2026-04-12' });
  assert.deepStrictEqual(list.categories, []);
  assert.deepStrictEqual(list.checkYouHave, []);
});
```

- [ ] **Step 2: Run the tests**

Run: `npm test -- --test-name-pattern="generateShoppingList"`
Expected: all 7 tests pass.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS — no regressions.

- [ ] **Step 4: Commit**

```bash
git add test/unit/shopping-generator-scopes.test.ts
git commit -m "Plan 030: unit tests for shopping generator scope functions"
```

---

### Task 4: Extend `LastRenderedView` with new shopping variants

**Rationale:** Plan 030 adds two new shopping scopes (`full_week`, `recipe`) that Plan B's navigation state union doesn't cover. Extending the union BEFORE the view-renderer module is created means the new module typechecks on first commit.

**Files:**
- Modify: `src/telegram/navigation-state.ts`

- [ ] **Step 1: Add the two new union variants**

Open `src/telegram/navigation-state.ts` and find the `LastRenderedView` union (Plan B Task 2, line ~210). Add the two new variants after `'shopping' + 'day'`:

```typescript
export type LastRenderedView =
  | { surface: 'plan'; view: 'next_action' }
  | { surface: 'plan'; view: 'week_overview' }
  | { surface: 'plan'; view: 'day_detail'; day: string }
  | { surface: 'cooking'; view: 'cook_view'; batchId: string; recipeSlug: string }
  | { surface: 'shopping'; view: 'next_cook' }
  | { surface: 'shopping'; view: 'day'; day: string }
  | { surface: 'shopping'; view: 'full_week' }  // Plan 030
  | { surface: 'shopping'; view: 'recipe'; recipeSlug: string }  // Plan 030
  | { surface: 'recipes'; view: 'library' }
  | { surface: 'recipes'; view: 'recipe_detail'; slug: string }
  | { surface: 'progress'; view: 'log_prompt' }
  | { surface: 'progress'; view: 'weekly_report' };
```

- [ ] **Step 2: Update the module's doc comment**

Near the top of `navigation-state.ts`, find the "Shopping scope is minimal in v0.0.5" decision note in the module doc comment. Update it:

```typescript
/*
 *   - **Shopping scope in v0.0.5 / Plan 030**: Plan B originally landed
 *     with only `next_cook` and `day`. Plan 030 adds `full_week` and
 *     `recipe` when the shopping generator gained scope support. The
 *     union now covers all four scopes the `show_shopping_list` action
 *     uses.
 */
```

- [ ] **Step 3: Typecheck + test**

Run: `npx tsc --noEmit`
Expected: no errors. The union extension is non-breaking — existing callers construct one of the original four variants, which all still exist.

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/telegram/navigation-state.ts
git commit -m "Plan 030: extend LastRenderedView with full_week and recipe shopping variants"
```

---

### Task 5: Create `src/telegram/view-renderers.ts` with extracted render helpers

**Rationale:** Plan E's eight action handlers need to call the same render logic that `core.ts`'s callback handlers run today. Two options were considered: (a) inject render callbacks into the dispatcher runner via `deps`, or (b) extract renderers into a leaf module both `core.ts` and `dispatcher-runner.ts` can import. Option (b) is chosen because it eliminates circular-import risk, makes each renderer independently unit-testable, and keeps the dispatcher runner's `handleShow*Action` wrappers trivially thin.

The module is a leaf — it imports from `models/`, `state/`, `recipes/`, `plan/helpers.ts`, `shopping/generator.ts`, `telegram/formatters.ts`, `telegram/keyboards.ts`, and `telegram/navigation-state.ts`, but **not** from `core.ts`. The renderers accept a structural `RenderSession` slice rather than `BotCoreSession` to avoid the reverse import.

This task creates the module's final form with every helper. Task 6 wires `core.ts` to delegate to it. Until Task 6 runs, the helpers exist but are only exercised by Task 20's integration unit tests.

**Files:**
- Create: `src/telegram/view-renderers.ts`
- Modify: `src/plan/helpers.ts` (widen `getPlanLifecycle`'s first parameter)

- [ ] **Step 1: Widen `getPlanLifecycle`'s first parameter**

Open `src/plan/helpers.ts`. The current signature (line ~63) takes `session: BotCoreSession`. The function only reads `session.planFlow`. Widen to a structural slice so the new view-renderers module can call it without importing `BotCoreSession`.

Replace:
```typescript
import type { BotCoreSession } from '../telegram/core.js';
```
with: keep the import only if other functions in the file use `BotCoreSession`. Grep `BotCoreSession` in the file. If the only use is `getPlanLifecycle`'s parameter, delete the import. Otherwise leave it.

Replace the `getPlanLifecycle` signature:
```typescript
export async function getPlanLifecycle(
  session: { planFlow: import('../models/types.js').PlanFlowState | null },
  store: StateStoreLike,
  today: string,
): Promise<PlanLifecycle> {
```

The body is unchanged. Every existing caller passes `BotCoreSession`, which structurally satisfies the new constraint.

Run `npx tsc --noEmit`. Expected: no errors.

- [ ] **Step 2: Create the view-renderers module with the header + structural slice + load helper**

Create `src/telegram/view-renderers.ts`:

```typescript
/**
 * View renderers — Plan 030.
 *
 * Extracted render helpers that encapsulate the "load data → call formatter
 * → attach keyboard → set lastRenderedView → sink.reply" pattern used by
 * the plan / cook / shopping / recipe / progress views. Today these bodies
 * live inline inside `core.ts`'s callback cases. Plan 030 extracts them so
 * the dispatcher runner's `handleShow*Action` handlers can call the same
 * code path without going through a synthetic callback.
 *
 * ## Architecture position
 *
 * Leaf module — no imports from `core.ts`. `core.ts` imports from this
 * module to delegate from its callback handlers (Plan 030 Task 6 refactor),
 * and `dispatcher-runner.ts` imports from this module to render the view
 * a dispatcher action chose (Tasks 11–17). Neither consumer imports the
 * other, so there is no cycle.
 *
 * The helpers accept a structural `RenderSession` slice rather than
 * `BotCoreSession` directly — this lets `core.ts` pass its full session
 * without the reverse import.
 *
 * ## Contract for every renderer
 *
 *   1. Load whatever plan / recipe / measurement data it needs.
 *   2. Call the formatter (`formatters.ts` or `recipes/renderer.ts`) to produce text.
 *   3. Attach the appropriate keyboard from `keyboards.ts`.
 *   4. Call `setLastRenderedView(session, …)` (Plan 027 invariant).
 *   5. `await sink.reply(text, { reply_markup, parse_mode? })`.
 *
 * ## On "rendered vs. not_in_plan"
 *
 * `renderCookViewForSlug` is the only helper that can fail to find a
 * target. It returns `'rendered' | 'not_in_plan'` so the caller (the
 * `show_recipe` handler) can fall back to the library view. Every other
 * helper returns `void`.
 */

import type { StateStoreLike } from '../state/store.js';
import type { RecipeDatabase } from '../recipes/database.js';
import type { LLMProvider } from '../ai/provider.js';
import type {
  Batch,
  BatchView,
  PlanSession,
  PlanFlowState,
} from '../models/types.js';
import {
  setLastRenderedView,
  type NavigationSessionSlice,
} from './navigation-state.js';
import {
  formatNextAction,
  formatWeekOverview,
  formatDayDetail,
  formatShoppingList,
  formatWeeklyReport,
} from './formatters.js';
import { renderCookView, renderRecipe } from '../recipes/renderer.js';
import {
  buildMainMenuKeyboard,
  cookViewKeyboard,
  recipeViewKeyboard,
  nextActionKeyboard,
  weekOverviewKeyboard,
  dayDetailKeyboard,
  buildShoppingListKeyboard,
  progressReportKeyboard,
  recipeListKeyboard,
} from './keyboards.js';
import {
  generateShoppingList,
  generateShoppingListForWeek,
  generateShoppingListForRecipe,
  generateShoppingListForDay,
  type ShoppingScope,
} from '../shopping/generator.js';
import {
  getVisiblePlanSession,
  getPlanLifecycle,
  getNextCookDay,
  toLocalISODate,
} from '../plan/helpers.js';
import { log } from '../debug/logger.js';

/**
 * Structural session slice the view-renderers require. Matches the subset
 * of `BotCoreSession` each renderer touches. Declared structurally so the
 * module doesn't import `core.ts`.
 */
export interface RenderSession extends NavigationSessionSlice {
  lastRecipeSlug?: string;
  /**
   * Pagination index for the recipe library list view (`renderRecipeLibrary`).
   * Matches `BotCoreSession.recipeListPage`. Required by `renderRecipeLibrary`
   * so `rerenderLastView`'s `recipes/library` branch can restore the exact
   * page the user was on when they typed natural-language back navigation
   * (proposal 003 state preservation invariant #6).
   */
  recipeListPage: number;
  planFlow: PlanFlowState | null;
  progressFlow: {
    phase: 'awaiting_measurement' | 'confirming_disambiguation';
    pendingWeight?: number;
    pendingWaist?: number;
    pendingDate?: string;
  } | null;
}

export interface ViewRendererDeps {
  llm: LLMProvider;
  recipes: RecipeDatabase;
  store: StateStoreLike;
}

export interface ViewOutputSink {
  reply(
    text: string,
    options?: {
      reply_markup?: unknown;
      parse_mode?: 'MarkdownV2' | 'HTML' | 'Markdown';
    },
  ): Promise<void>;
}

export type ViewRenderResult = 'rendered' | 'not_in_plan';

/**
 * Load the visible plan + dedupe its batches + resolve recipes.
 * Mirrors `loadPlanBatches` from `core.ts`.
 */
async function loadVisiblePlanAndBatches(
  deps: ViewRendererDeps,
  today: string,
): Promise<{ session: PlanSession; batchViews: BatchView[]; allBatches: Batch[] } | null> {
  const session = await getVisiblePlanSession(deps.store, today);
  if (!session) return null;

  const ownBatches = await deps.store.getBatchesByPlanSessionId(session.id);
  const overlapBatches = await deps.store.getBatchesOverlapping({
    horizonStart: session.horizonStart,
    horizonEnd: session.horizonEnd,
    statuses: ['planned'],
  });
  const seen = new Set<string>();
  const allBatches = [...ownBatches, ...overlapBatches]
    .filter((b) => (seen.has(b.id) ? false : (seen.add(b.id), true)))
    .filter((b) => b.status === 'planned');

  const batchViews: BatchView[] = allBatches.flatMap((b) => {
    const recipe = deps.recipes.getBySlug(b.recipeSlug);
    if (!recipe) {
      log.warn('VIEW', `no recipe for slug ${b.recipeSlug}`);
      return [];
    }
    return [{ batch: b, recipe }];
  });

  return { session, batchViews, allBatches };
}
```

- [ ] **Step 3: Append the plan-view helpers**

Append `renderNextAction`, `renderWeekOverview`, and `renderDayDetail` to `src/telegram/view-renderers.ts`:

```typescript
/**
 * Render the Next Action view. Mirrors the `na_show` callback case body.
 */
export async function renderNextAction(
  session: RenderSession,
  deps: ViewRendererDeps,
  sink: ViewOutputSink,
): Promise<void> {
  const today = toLocalISODate(new Date());
  const loaded = await loadVisiblePlanAndBatches(deps, today);
  if (!loaded) {
    const lifecycle = await getPlanLifecycle(session, deps.store, today);
    await sink.reply("You don't have a plan yet. Tap 📋 Plan Week to start one.", {
      reply_markup: buildMainMenuKeyboard(lifecycle),
    });
    return;
  }
  const text = formatNextAction(
    loaded.batchViews,
    loaded.session.events,
    loaded.session.flexSlots,
    today,
    loaded.session.horizonStart,
  );
  const nextCook = getNextCookDay(loaded.allBatches, today);
  const nextCookBatchViews = nextCook
    ? loaded.batchViews.filter(bv => bv.batch.eatingDays[0] === nextCook.date)
    : [];
  const lifecycle = await getPlanLifecycle(session, deps.store, today);
  setLastRenderedView(session, { surface: 'plan', view: 'next_action' });
  await sink.reply(text, { reply_markup: nextActionKeyboard(nextCookBatchViews, lifecycle), parse_mode: 'MarkdownV2' });
}

/**
 * Render the Week Overview. Mirrors the `wo_show` callback case body.
 */
export async function renderWeekOverview(
  session: RenderSession,
  deps: ViewRendererDeps,
  sink: ViewOutputSink,
): Promise<void> {
  const today = toLocalISODate(new Date());
  const loaded = await loadVisiblePlanAndBatches(deps, today);
  if (!loaded) {
    const lifecycle = await getPlanLifecycle(session, deps.store, today);
    await sink.reply("You don't have a plan yet. Tap 📋 Plan Week to start one.", {
      reply_markup: buildMainMenuKeyboard(lifecycle),
    });
    return;
  }
  const breakfastRecipe = deps.recipes.getBySlug(loaded.session.breakfast.recipeSlug);
  const text = formatWeekOverview(
    loaded.session,
    loaded.batchViews,
    loaded.session.events,
    loaded.session.flexSlots,
    breakfastRecipe,
  );
  // Build 7-day array from horizon for the keyboard
  const weekDays: string[] = [];
  const d = new Date(loaded.session.horizonStart + 'T00:00:00');
  for (let i = 0; i < 7; i++) {
    weekDays.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    d.setDate(d.getDate() + 1);
  }
  setLastRenderedView(session, { surface: 'plan', view: 'week_overview' });
  await sink.reply(text, { reply_markup: weekOverviewKeyboard(weekDays), parse_mode: 'MarkdownV2' });
}

/**
 * Render a specific day's detail. Mirrors the `dd_<date>` callback case.
 *
 * Guards: rejects invalid date strings and dates outside the visible
 * plan horizon with graceful fallbacks.
 */
export async function renderDayDetail(
  session: RenderSession,
  deps: ViewRendererDeps,
  sink: ViewOutputSink,
  day: string,
): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    await sink.reply("I couldn't figure out which day you meant. Try 'Thursday' or a full date.");
    return;
  }
  const today = toLocalISODate(new Date());
  const loaded = await loadVisiblePlanAndBatches(deps, today);
  if (!loaded) {
    const lifecycle = await getPlanLifecycle(session, deps.store, today);
    await sink.reply("You don't have a plan yet. Tap 📋 Plan Week to start one.", {
      reply_markup: buildMainMenuKeyboard(lifecycle),
    });
    return;
  }
  if (day < loaded.session.horizonStart || day > loaded.session.horizonEnd) {
    await sink.reply(
      `${day} isn't in this week's plan (${loaded.session.horizonStart} — ${loaded.session.horizonEnd}).`,
    );
    return;
  }
  const text = formatDayDetail(day, loaded.batchViews, loaded.session.events, loaded.session.flexSlots);
  const cookBatchViews = loaded.batchViews.filter(bv => bv.batch.eatingDays[0] === day);
  setLastRenderedView(session, { surface: 'plan', view: 'day_detail', day });
  await sink.reply(text, { reply_markup: dayDetailKeyboard(day, cookBatchViews, today), parse_mode: 'MarkdownV2' });
}
```

- [ ] **Step 4: Append the cook-view helpers**

Append `renderCookViewForBatch` and `renderCookViewForSlug`:

```typescript
/**
 * Render the cook view for a specific batch ID. Mirrors the `cv_<batchId>`
 * callback case body.
 */
export async function renderCookViewForBatch(
  session: RenderSession,
  deps: ViewRendererDeps,
  sink: ViewOutputSink,
  batchId: string,
): Promise<void> {
  const batch = await deps.store.getBatch(batchId);
  if (!batch) {
    await sink.reply("I couldn't find that batch. It may have been cancelled.");
    return;
  }
  const recipe = deps.recipes.getBySlug(batch.recipeSlug);
  if (!recipe) {
    await sink.reply(`I couldn't find the recipe for ${batch.recipeSlug}.`);
    return;
  }
  const text = renderCookView(recipe, batch);
  setLastRenderedView(session, {
    surface: 'cooking',
    view: 'cook_view',
    batchId: batch.id,
    recipeSlug: batch.recipeSlug,
  });
  session.lastRecipeSlug = batch.recipeSlug;
  await sink.reply(text, {
    reply_markup: cookViewKeyboard(batch.recipeSlug),
    parse_mode: 'MarkdownV2',
  });
}

/**
 * Resolve a recipe slug to the soonest-cook-day batch in the active plan
 * and render its cook view. Returns `'not_in_plan'` if no active batch
 * matches — the caller should fall back to `renderLibraryRecipeView`.
 *
 * **Disambiguation rule (proposal 003 § show_recipe)**: when multiple
 * active batches match the slug, pick the one with the soonest
 * `eatingDays[0]`. Ties are broken by `batchId` lexicographic order for
 * determinism. v0.0.5 picks soonest-wins; a future version may replace
 * this with a clarify round-trip if users find it confusing.
 */
export async function renderCookViewForSlug(
  session: RenderSession,
  deps: ViewRendererDeps,
  sink: ViewOutputSink,
  slug: string,
): Promise<ViewRenderResult> {
  const today = toLocalISODate(new Date());
  const loaded = await loadVisiblePlanAndBatches(deps, today);
  if (!loaded) return 'not_in_plan';

  const matching = loaded.allBatches.filter((b) => b.recipeSlug === slug);
  if (matching.length === 0) return 'not_in_plan';

  matching.sort((a, b) => {
    const aDay = a.eatingDays[0] ?? '';
    const bDay = b.eatingDays[0] ?? '';
    if (aDay !== bDay) return aDay.localeCompare(bDay);
    return a.id.localeCompare(b.id);
  });

  const chosen = matching[0]!;
  await renderCookViewForBatch(session, deps, sink, chosen.id);
  return 'rendered';
}
```

- [ ] **Step 5: Append the library recipe view helpers**

Append both `renderLibraryRecipeView` (single recipe, per-serving amounts) and `renderRecipeLibrary` (the paginated list view, extracted from `core.ts`'s `showRecipeList` closure). The second helper is required by `rerenderLastView`'s `recipes/library` branch (Task 19) so natural-language back navigation after viewing the library restores the exact pagination state (proposal 003 state preservation invariant #6 — see the decision log entry "Why `renderRecipeLibrary` IS extracted").

```typescript
/**
 * Render a library recipe view — per-serving amounts, no batch context.
 * Mirrors the `rv_<slug>` callback case body (`src/telegram/core.ts:477`).
 *
 * Includes the `findBySlugPrefix` fallback for truncated callback-data
 * slugs (Telegram's 64-byte callback limit). Uses the resolved canonical
 * `recipe.slug` for state, not the raw input slug.
 */
export async function renderLibraryRecipeView(
  session: RenderSession,
  deps: ViewRendererDeps,
  sink: ViewOutputSink,
  slug: string,
): Promise<void> {
  const recipe =
    deps.recipes.getBySlug(slug) ??
    deps.recipes.getAll().find((r) => r.slug.startsWith(slug));
  if (!recipe) {
    const today = toLocalISODate(new Date());
    const lifecycle = await getPlanLifecycle(session, deps.store, today);
    await sink.reply('Recipe not found.', {
      reply_markup: buildMainMenuKeyboard(lifecycle),
    });
    return;
  }
  const text = renderRecipe(recipe);
  setLastRenderedView(session, { surface: 'recipes', view: 'recipe_detail', slug: recipe.slug });
  session.lastRecipeSlug = recipe.slug;
  await sink.reply(text, {
    reply_markup: recipeViewKeyboard(slug),
    parse_mode: 'MarkdownV2',
  });
}

/**
 * Render the paginated recipe library list with optional "cooking soon"
 * section when the user has an active plan. Mirrors `showRecipeList` from
 * `core.ts:1083–1113`. Reads `session.recipeListPage` directly from the
 * structural slice (not a closure over core state) so `rerenderLastView`
 * can invoke it for the `recipes/library` variant of `LastRenderedView`.
 *
 * Sets `lastRenderedView = { surface: 'recipes', view: 'library' }`.
 */
export async function renderRecipeLibrary(
  session: RenderSession,
  deps: ViewRendererDeps,
  sink: ViewOutputSink,
): Promise<void> {
  const all = deps.recipes.getAll();
  const pageSize = 5;

  const today = toLocalISODate(new Date());
  const lifecycle = await getPlanLifecycle(session, deps.store, today);

  let cookingSoonBatchViews: BatchView[] | undefined;
  if (lifecycle.startsWith('active_') || lifecycle === 'upcoming') {
    const loaded = await loadVisiblePlanAndBatches(deps, today);
    if (loaded) {
      cookingSoonBatchViews = loaded.batchViews
        .filter((bv) => bv.batch.eatingDays.length > 0 && bv.batch.eatingDays[0]! >= today)
        .sort((a, b) => a.batch.eatingDays[0]!.localeCompare(b.batch.eatingDays[0]!));
    }
  }

  const msg =
    cookingSoonBatchViews && cookingSoonBatchViews.length > 0
      ? `COOKING SOON\n\nALL RECIPES (${all.length}):`
      : `Your recipes (${all.length}):`;

  setLastRenderedView(session, { surface: 'recipes', view: 'library' });
  await sink.reply(msg, {
    reply_markup: recipeListKeyboard(all, session.recipeListPage, pageSize, cookingSoonBatchViews),
  });
}
```

**Import additions for this step:** `renderRecipeLibrary` needs `BatchView` type (already imported in Task 5 Step 2) and `recipeListKeyboard` from `./keyboards.js` (already imported in the corrected module header). It uses the module-local `loadVisiblePlanAndBatches` helper instead of `core.ts`'s closure-scoped `loadPlanBatches`. No new imports needed.

- [ ] **Step 6: Append the shopping-list dispatcher**

Append `renderShoppingListForScope`. The new shopping variants (`full_week`, `recipe`) typecheck cleanly because Task 4 added them to the union.

```typescript
/**
 * Render a shopping list for a given scope. Dispatches to the appropriate
 * generator function (Plan 030 Task 2). The `next_cook` scope calls the
 * existing `generateShoppingList` unchanged, so `sl_next` callbacks
 * continue to work identically after the refactor.
 *
 * Sets `lastRenderedView` with the matching Plan B / Plan E shopping variant.
 */
export async function renderShoppingListForScope(
  session: RenderSession,
  deps: ViewRendererDeps,
  sink: ViewOutputSink,
  scope: ShoppingScope,
): Promise<void> {
  const today = toLocalISODate(new Date());
  const loaded = await loadVisiblePlanAndBatches(deps, today);
  if (!loaded) {
    const lifecycle = await getPlanLifecycle(session, deps.store, today);
    await sink.reply("You don't have a plan yet. Tap 📋 Plan Week to start one.", {
      reply_markup: buildMainMenuKeyboard(lifecycle),
    });
    return;
  }
  const breakfastRecipe = deps.recipes.getBySlug(loaded.session.breakfast.recipeSlug);

  switch (scope.kind) {
    case 'next_cook': {
      const list = generateShoppingList(loaded.allBatches, breakfastRecipe, {
        targetDate: scope.targetDate,
        remainingDays: scope.remainingDays,
      });
      // Build recipe-based scope text matching the live sl_next handler
      const cookBatchesForDay = loaded.allBatches.filter(b => b.eatingDays[0] === scope.targetDate);
      const scopeParts = cookBatchesForDay.map(b => {
        const recipe = deps.recipes.getBySlug(b.recipeSlug);
        return `${recipe?.name ?? b.recipeSlug} (${b.servings} servings)`;
      });
      if (breakfastRecipe) scopeParts.push('Breakfast');
      const text = formatShoppingList(list, scope.targetDate, scopeParts.join(' + '));
      setLastRenderedView(session, { surface: 'shopping', view: 'next_cook' });
      await sink.reply(text, { reply_markup: buildShoppingListKeyboard(), parse_mode: 'MarkdownV2' });
      return;
    }
    case 'full_week': {
      const list = generateShoppingListForWeek(loaded.allBatches, breakfastRecipe, {
        horizonStart: scope.horizonStart,
        horizonEnd: scope.horizonEnd,
      });
      const text = formatShoppingList(
        list,
        scope.horizonStart,
        `Full week ${scope.horizonStart} — ${scope.horizonEnd}`,
      );
      setLastRenderedView(session, { surface: 'shopping', view: 'full_week' });
      await sink.reply(text, { reply_markup: buildShoppingListKeyboard(), parse_mode: 'MarkdownV2' });
      return;
    }
    case 'recipe': {
      const list = generateShoppingListForRecipe(loaded.allBatches, {
        recipeSlug: scope.recipeSlug,
      });
      const recipe = deps.recipes.getBySlug(scope.recipeSlug);
      const labelName = recipe?.name ?? scope.recipeSlug;
      const text = formatShoppingList(list, today, `For ${labelName}`);
      setLastRenderedView(session, {
        surface: 'shopping',
        view: 'recipe',
        recipeSlug: scope.recipeSlug,
      });
      await sink.reply(text, { reply_markup: buildShoppingListKeyboard(), parse_mode: 'MarkdownV2' });
      return;
    }
    case 'day': {
      const list = generateShoppingListForDay(loaded.allBatches, breakfastRecipe, {
        day: scope.day,
        remainingDays: scope.remainingDays,
      });
      const text = formatShoppingList(list, scope.day, `Day ${scope.day}`);
      setLastRenderedView(session, { surface: 'shopping', view: 'day', day: scope.day });
      await sink.reply(text, { reply_markup: buildShoppingListKeyboard(), parse_mode: 'MarkdownV2' });
      return;
    }
  }
}
```

- [ ] **Step 7: Append the progress view helper**

Append `renderProgressView` and its internal `getWeekBoundariesForReport` helper:

```typescript
/**
 * Render a progress view. `log_prompt` sets the measurement phase and
 * asks for input; `weekly_report` shows last week's report if there are
 * measurements from the prior week.
 *
 * Mirrors the `progress` menu handler in `core.ts` but with an explicit
 * `view` parameter — the dispatcher can pick either branch.
 */
export async function renderProgressView(
  session: RenderSession,
  deps: ViewRendererDeps,
  sink: ViewOutputSink,
  view: 'log_prompt' | 'weekly_report',
): Promise<void> {
  const today = toLocalISODate(new Date());
  const existing = await deps.store.getTodayMeasurement('default', today);

  if (view === 'weekly_report') {
    const { lastWeekStart, lastWeekEnd, prevWeekStart, prevWeekEnd } =
      getWeekBoundariesForReport(today);
    const lastWeek = await deps.store.getMeasurements('default', lastWeekStart, lastWeekEnd);
    const prevWeek = await deps.store.getMeasurements('default', prevWeekStart, prevWeekEnd);
    if (lastWeek.length === 0) {
      await sink.reply("No measurements from last week yet — log one today to start the report.");
      setLastRenderedView(session, { surface: 'progress', view: 'weekly_report' });
      return;
    }
    const report = formatWeeklyReport(lastWeek, prevWeek, lastWeekStart, lastWeekEnd);
    setLastRenderedView(session, { surface: 'progress', view: 'weekly_report' });
    await sink.reply(report, { parse_mode: 'Markdown' });
    return;
  }

  // view === 'log_prompt'
  if (existing) {
    session.progressFlow = null;
    const { lastWeekStart, lastWeekEnd } = getWeekBoundariesForReport(today);
    const lastWeek = await deps.store.getMeasurements('default', lastWeekStart, lastWeekEnd);
    const hasCompletedWeekReport = lastWeek.length > 0;
    setLastRenderedView(session, { surface: 'progress', view: 'weekly_report' });
    if (hasCompletedWeekReport) {
      await sink.reply('Already logged today ✓', { reply_markup: progressReportKeyboard });
    } else {
      await sink.reply('Already logged today ✓');
    }
    return;
  }

  session.progressFlow = { phase: 'awaiting_measurement' };
  const hour = new Date().getHours();
  const timeQualifier = hour >= 14 ? '\n\nIf this is your morning weight, drop it here.' : '';
  const prompt = `Drop your weight (and waist if you track it):\n\nExamples: "82.3 / 91" or just "82.3"${timeQualifier}`;
  setLastRenderedView(session, { surface: 'progress', view: 'log_prompt' });
  await sink.reply(prompt);
}

/**
 * Compute week boundary ISO dates for the weekly report. Mon–Sun weeks.
 * Mirrors `getCalendarWeekBoundaries` in `core.ts`. The duplication is
 * five lines of arithmetic — acceptable to avoid a circular dependency.
 */
function getWeekBoundariesForReport(today: string): {
  lastWeekStart: string;
  lastWeekEnd: string;
  prevWeekStart: string;
  prevWeekEnd: string;
} {
  const d = new Date(today + 'T00:00:00Z');
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7;
  const thisMonday = new Date(d);
  thisMonday.setUTCDate(d.getUTCDate() - daysSinceMonday);
  const lastMonday = new Date(thisMonday);
  lastMonday.setUTCDate(thisMonday.getUTCDate() - 7);
  const lastSunday = new Date(lastMonday);
  lastSunday.setUTCDate(lastMonday.getUTCDate() + 6);
  const prevMonday = new Date(lastMonday);
  prevMonday.setUTCDate(lastMonday.getUTCDate() - 7);
  const prevSunday = new Date(prevMonday);
  prevSunday.setUTCDate(prevMonday.getUTCDate() + 6);

  const iso = (x: Date): string => x.toISOString().slice(0, 10);
  return {
    lastWeekStart: iso(lastMonday),
    lastWeekEnd: iso(lastSunday),
    prevWeekStart: iso(prevMonday),
    prevWeekEnd: iso(prevSunday),
  };
}
```

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. The module compiles standalone — every import resolves.

- [ ] **Step 9: Run tests**

Run: `npm test`
Expected: PASS — the new module has no callers yet, so existing scenarios are unaffected.

- [ ] **Step 10: Commit**

```bash
git add src/telegram/view-renderers.ts src/plan/helpers.ts
git commit -m "Plan 030: create view-renderers module with extracted render helpers"
```

---

### Task 6: Refactor `core.ts` callback handlers to delegate to view-renderers

**Rationale:** With the view-renderers module live, `core.ts`'s callback handlers can become 2-line wrappers that parse the callback data and call the helper. The refactor is surgical — one `case` body at a time — and each step preserves identical behavior verified by the existing scenario harness. The benefit beyond Plan E: `core.ts` shrinks by ~150 lines and the per-case render logic becomes independently testable.

**Files:**
- Modify: `src/telegram/core.ts`

The exact line numbers in this task are post-Plans-A/B/C/D, so they may drift. Use Grep to locate each callback `case` before editing.

- [ ] **Step 1: Import the view-renderers module**

Add to the imports block in `src/telegram/core.ts`:

```typescript
import {
  renderNextAction,
  renderWeekOverview,
  renderDayDetail,
  renderCookViewForBatch,
  renderLibraryRecipeView,
  renderRecipeLibrary,
  renderShoppingListForScope,
  renderProgressView,
} from './view-renderers.js';
```

- [ ] **Step 2: Refactor `na_show`**

Find `if (action === 'na_show')` (Grep). Replace its body with:

```typescript
    if (action === 'na_show') {
      session.surfaceContext = 'plan';
      await renderNextAction(session, { llm, recipes, store }, sink);
      return;
    }
```

The previous body did the same `loadPlanBatches` + `formatNextAction` + `setLastRenderedView` sequence — now centralized.

- [ ] **Step 3: Refactor `wo_show`**

Find `if (action === 'wo_show')`. Replace body:

```typescript
    if (action === 'wo_show') {
      session.surfaceContext = 'plan';
      await renderWeekOverview(session, { llm, recipes, store }, sink);
      return;
    }
```

- [ ] **Step 4: Refactor `dd_<date>`**

Find `if (action.startsWith('dd_'))`. Replace body:

```typescript
    if (action.startsWith('dd_')) {
      const day = action.slice(3);
      session.surfaceContext = 'plan';
      await renderDayDetail(session, { llm, recipes, store }, sink, day);
      return;
    }
```

- [ ] **Step 5: Refactor `cv_<batchId>`**

Find `if (action.startsWith('cv_'))`. Replace body:

```typescript
    if (action.startsWith('cv_')) {
      const batchId = action.slice(3);
      session.surfaceContext = 'cooking';
      await renderCookViewForBatch(session, { llm, recipes, store }, sink, batchId);
      return;
    }
```

The renderer sets `session.lastRecipeSlug` itself, so the previous inline `session.lastRecipeSlug = batch.recipeSlug` line can be removed.

- [ ] **Step 6: Refactor `rv_<slug>`**

Find `if (action.startsWith('rv_'))`. The current body (`src/telegram/core.ts:477`) is a straight library-recipe render: it resolves the recipe via `getBySlug` / `findBySlugPrefix`, sets `lastRecipeSlug` and `lastRenderedView`, and replies with `renderRecipe(recipe)` + `recipeViewKeyboard`. There is no active-plan cook-view branch — this callback always renders the library view. Replace body:

```typescript
    if (action.startsWith('rv_')) {
      const slug = action.slice(3);
      session.surfaceContext = 'recipes';
      await renderLibraryRecipeView(session, { llm, recipes, store }, sink, slug);
      return;
    }
```

`renderLibraryRecipeView` handles slug resolution (including `findBySlugPrefix` fallback), `lastRecipeSlug`, `lastRenderedView`, and the reply — a direct 1:1 replacement of the inline body.

- [ ] **Step 7: Refactor `sl_<param>`**

Find `if (action.startsWith('sl_'))`. The current body parses `sl_next` or `sl_<date>` and calls `generateShoppingList`. Replace body:

```typescript
    if (action.startsWith('sl_')) {
      const param = action.slice(3);
      session.surfaceContext = 'shopping';
      const today = toLocalISODate(new Date());
      const visible = await getVisiblePlanSession(store, today);
      if (!visible) {
        const lifecycle = await getPlanLifecycle(session, store, today);
        await sink.reply("You don't have a plan yet. Tap 📋 Plan Week to start one.", {
          reply_markup: buildMainMenuKeyboard(lifecycle),
        });
        return;
      }

      // Load deduped own + overlap batches — same as the live handler.
      const { allBatches } = await loadPlanBatches(visible, recipes);
      const plannedBatches = allBatches.filter(b => b.status === 'planned');

      // Build the scope from the callback param.
      let scope: ShoppingScope;
      if (param === 'next') {
        const next = getNextCookDay(plannedBatches, today);
        const targetDate = next?.date ?? today;
        const remainingDays = Math.max(
          0,
          Math.round(
            (new Date(visible.horizonEnd + 'T00:00:00Z').getTime() -
              new Date(targetDate + 'T00:00:00Z').getTime()) /
              86_400_000,
          ) + 1,
        );
        scope = { kind: 'next_cook', targetDate, remainingDays };
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(param)) {
        const remainingDays = Math.max(
          0,
          Math.round(
            (new Date(visible.horizonEnd + 'T00:00:00Z').getTime() -
              new Date(param + 'T00:00:00Z').getTime()) /
              86_400_000,
          ) + 1,
        );
        scope = { kind: 'day', day: param, remainingDays };
      } else {
        await sink.reply('Unknown shopping scope.');
        return;
      }

      await renderShoppingListForScope(session, { llm, recipes, store }, sink, scope);
      return;
    }
```

This consolidates the per-callback logic into a single delegation through `renderShoppingListForScope`.

- [ ] **Step 8: Refactor `progress` menu case**

Find `case 'progress':`. The current body branches between "already logged" and "no measurement today". Replace body:

```typescript
      case 'progress': {
        session.surfaceContext = 'progress';
        session.lastRecipeSlug = undefined;
        await renderProgressView(session, { llm, recipes, store }, sink, 'log_prompt');
        return;
      }
```

`renderProgressView('log_prompt')` already handles both branches internally.

- [ ] **Step 9: Replace `showRecipeList` closure body with delegation to `renderRecipeLibrary`**

Find `async function showRecipeList(sink: OutputSink)` in `src/telegram/core.ts` (currently at `src/telegram/core.ts:1083`; line number may have drifted after earlier Plans). The closure's body today inlines the recipe-list + cooking-soon rendering (~30 lines). Plan E's `renderRecipeLibrary` (Task 5 Step 5) is the extracted version of exactly this body. Replace the closure with a thin delegation:

```typescript
  // ─── Paginated recipe list ─────────────────────────────────────────────
  async function showRecipeList(sink: OutputSink): Promise<void> {
    await renderRecipeLibrary(session, { llm, recipes, store }, sink);
  }
```

Delete every line of the old closure body (the `const all = recipes.getAll()` through the `await sink.reply(msg, { reply_markup: recipeListKeyboard(...) })` lines). All four closure readers — `recipes`, `session`, `store`, the pagination helpers — are now parameters on `renderRecipeLibrary`, so nothing is lost.

The existing call sites (`case '📖 My Recipes':`, `recipes_prev` callback, `recipes_next` callback, the `recipes_show` callback in the awaiting-plan-week path) still invoke `showRecipeList(sink)` unchanged — the closure is kept as a convenience alias for the existing callers so this refactor stays surgical. A future cleanup may delete the alias and have each caller invoke `renderRecipeLibrary` directly, but that's not Plan 030's scope.

**Why this matters:** Task 19's `rerenderLastView` upgrade (later in Plan 030) calls `renderRecipeLibrary` directly for the `recipes/library` variant of `LastRenderedView`. Both the reply-keyboard button handler and the natural-language back navigation route through the same helper, which is what proposal 003 invariant #6 requires. See the decision log entry "Why `renderRecipeLibrary` IS extracted".

- [ ] **Step 10: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. The new imports are used, and the renderer signatures match.

- [ ] **Step 11: Run tests — expect REGENERATION-LEVEL diffs**

Run: `npm test`
Expected: green if the renderers are perfectly behavior-equivalent. If a scenario fails with a small text-formatting diff, investigate: the most likely cause is a missing `setLastRenderedView` call in the renderer that the inline code had, or vice versa. Fix the renderer (don't blindly regenerate) and re-run.

If a scenario fails with `finalSession.lastRenderedView` missing, the original inline code didn't set it but the renderer does — this is actually the CORRECT new behavior, and the recording needs regeneration. One specific delta to expect: scenarios that tap 📖 My Recipes previously did NOT set `lastRenderedView = { surface: 'recipes', view: 'library' }` because `showRecipeList` was inline; after Step 9, it does. Regenerate any affected scenario.

Use the following triage:
- Fewer than 3 scenarios fail with `lastRenderedView` diffs → regenerate them with `npm run test:generate -- <name> --regenerate --yes`, behaviorally review per CLAUDE.md, commit.
- Many scenarios fail or text-diffs are larger than `lastRenderedView` → STOP, the refactor changed behavior. Investigate before regenerating.

- [ ] **Step 12: Commit**

```bash
git add src/telegram/core.ts
# include any regenerated recordings
git commit -m "Plan 030: refactor core.ts callback handlers to delegate to view-renderers"
```

---

### Task 7: Expand the dispatcher catalog — types

**Rationale:** Plan E adds eight new actions to the dispatcher. The first step is purely type-level: extend `DispatcherAction`, `AVAILABLE_ACTIONS_V0_0_5`, and `DispatcherDecision` so the parser and the prompt have something to refer to. No prompt changes yet. **This task also updates the disallowed-action unit test** because the test uses `answer_plan_question` as its disallowed example, and extending `AVAILABLE_ACTIONS_V0_0_5` immediately breaks it.

**Files:**
- Modify: `src/agents/dispatcher.ts`
- Modify: `test/unit/dispatcher-agent.test.ts`

- [ ] **Step 1: Extend `DispatcherAction`**

Find the `DispatcherAction` union (Plan C Task 3, post-Plan-D extended with `'mutate_plan'`). Replace with:

```typescript
export type DispatcherAction =
  | 'flow_input'
  | 'clarify'
  | 'out_of_scope'
  | 'return_to_flow'
  | 'mutate_plan'
  | 'answer_plan_question'
  | 'answer_recipe_question'
  | 'answer_domain_question'
  | 'show_recipe'
  | 'show_plan'
  | 'show_shopping_list'
  | 'show_progress'
  | 'log_measurement';
```

- [ ] **Step 2: Extend `AVAILABLE_ACTIONS_V0_0_5`**

Replace the constant with:

```typescript
export const AVAILABLE_ACTIONS_V0_0_5: readonly DispatcherAction[] = [
  'flow_input',
  'clarify',
  'out_of_scope',
  'return_to_flow',
  'mutate_plan',
  'answer_plan_question',
  'answer_recipe_question',
  'answer_domain_question',
  'show_recipe',
  'show_plan',
  'show_shopping_list',
  'show_progress',
  'log_measurement',
] as const;
```

13 actions total — matches the proposal's "13 active actions" count.

- [ ] **Step 3: Extend `DispatcherDecision` with the eight new variants**

Append to the existing `DispatcherDecision` union (after the `mutate_plan` variant from Plan D):

```typescript
  | {
      action: 'answer_plan_question';
      params: { question: string };
      /** The dispatcher-authored answer text. Required. */
      response: string;
      reasoning: string;
    }
  | {
      action: 'answer_recipe_question';
      params: { question: string; recipe_slug?: string };
      response: string;
      reasoning: string;
    }
  | {
      action: 'answer_domain_question';
      params: { question: string };
      response: string;
      reasoning: string;
    }
  | {
      action: 'show_recipe';
      params: { recipe_slug: string };
      response?: undefined;
      reasoning: string;
    }
  | {
      action: 'show_plan';
      params: {
        screen: 'next_action' | 'week_overview' | 'day_detail';
        /** Required when screen='day_detail'; ISO date YYYY-MM-DD. */
        day?: string;
      };
      response?: undefined;
      reasoning: string;
    }
  | {
      action: 'show_shopping_list';
      params: {
        scope: 'next_cook' | 'full_week' | 'recipe' | 'day';
        /** Required when scope='recipe'. */
        recipe_slug?: string;
        /** Required when scope='day'; ISO date YYYY-MM-DD. */
        day?: string;
      };
      response?: undefined;
      reasoning: string;
    }
  | {
      action: 'show_progress';
      params: { view: 'log_prompt' | 'weekly_report' };
      response?: undefined;
      reasoning: string;
    }
  | {
      action: 'log_measurement';
      params: {
        /** Optional weight in kg (positive number). */
        weight?: number;
        /** Optional waist in cm (positive number). */
        waist?: number;
      };
      response?: undefined;
      reasoning: string;
    };
```

**Note on `log_measurement` params:** The dispatcher can extract numeric values from the user's text ("82.3 today" → `{ weight: 82.3 }`, "82.3 / 91" → `{ weight: 82.3, waist: 91 }`). The handler validates and falls through to disambiguation if both numbers could be interpreted as either. The same numeric pre-filter Plan C added still runs FIRST when `progressFlow.phase === 'awaiting_measurement'` — `log_measurement` is ONLY reached for cross-surface logging.

- [ ] **Step 4: Update the disallowed-action unit test**

The live test at `test/unit/dispatcher-agent.test.ts:152` (`'dispatchMessage: first-pass disallowed action → retries and succeeds'`) uses `answer_plan_question` as the disallowed example, and `baseContext()` references `AVAILABLE_ACTIONS_V0_0_5`. Since Step 2 just added `answer_plan_question` to that set, the test would now pass for the wrong reason (the parser accepts it on first pass, no retry). Update it NOW — before Task 8 — to use a still-deferred action:

```typescript
test('dispatchMessage: first-pass disallowed action → retries and succeeds', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'log_eating_out',
      params: { description: 'Indian restaurant', meal_time: 'dinner', day: 'today' },
      response: null,
      reasoning: 'User described eating out — would route to log_eating_out if available.',
    }),
    JSON.stringify({
      action: 'mutate_plan',
      params: { request: 'I went out for Indian for dinner' },
      response: null,
      reasoning: 'Honest fallback after disallowed-action retry — Plan D handles eating-out via mutate_plan.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext({ lifecycle: 'active_mid' }), 'I went out for Indian for dinner', llm);
  assert.equal(decision.action, 'mutate_plan');
});
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: errors in `parseDecision` (every new action variant is unhandled in the switch). Task 8 fixes them.

The error pattern is:
```
src/agents/dispatcher.ts:LLL:CC - error TS7030: Not all code paths return a value.
src/agents/dispatcher.ts:LLL:CC - error TS2367: Type '"answer_plan_question"' has no overlap with type '"flow_input" | ...'.
```

These are expected. Do not commit until Task 8 lands.

---

### Task 8: Update `parseDecision` to handle the new action variants

**Files:**
- Modify: `src/agents/dispatcher.ts`

- [ ] **Step 1: Add per-action validation cases to `parseDecision`**

In `src/agents/dispatcher.ts`, find the `switch (action)` block inside `parseDecision` (Plan C Task 4, lines ~1144 in the post-Plan-C-and-D file). After the `mutate_plan` case (Plan D Task 2 added it), add:

```typescript
    case 'answer_plan_question': {
      if (!response) {
        throw new Error('answer_plan_question requires a non-empty "response" string (the answer text).');
      }
      const question = typeof params.question === 'string' ? params.question : undefined;
      if (!question) {
        throw new Error('answer_plan_question requires params.question (string).');
      }
      return {
        action: 'answer_plan_question',
        params: { question },
        response,
        reasoning,
      };
    }

    case 'answer_recipe_question': {
      if (!response) {
        throw new Error('answer_recipe_question requires a non-empty "response" string.');
      }
      const question = typeof params.question === 'string' ? params.question : undefined;
      if (!question) {
        throw new Error('answer_recipe_question requires params.question (string).');
      }
      const recipe_slug = typeof params.recipe_slug === 'string' ? params.recipe_slug : undefined;
      return {
        action: 'answer_recipe_question',
        params: recipe_slug ? { question, recipe_slug } : { question },
        response,
        reasoning,
      };
    }

    case 'answer_domain_question': {
      if (!response) {
        throw new Error('answer_domain_question requires a non-empty "response" string.');
      }
      const question = typeof params.question === 'string' ? params.question : undefined;
      if (!question) {
        throw new Error('answer_domain_question requires params.question (string).');
      }
      return {
        action: 'answer_domain_question',
        params: { question },
        response,
        reasoning,
      };
    }

    case 'show_recipe': {
      if (response !== undefined && response !== '') {
        throw new Error('show_recipe must have response: null (the handler renders the view).');
      }
      const recipe_slug = typeof params.recipe_slug === 'string' ? params.recipe_slug : undefined;
      if (!recipe_slug) {
        throw new Error('show_recipe requires params.recipe_slug (string).');
      }
      return {
        action: 'show_recipe',
        params: { recipe_slug },
        reasoning,
      };
    }

    case 'show_plan': {
      if (response !== undefined && response !== '') {
        throw new Error('show_plan must have response: null.');
      }
      const screen = params.screen;
      if (screen !== 'next_action' && screen !== 'week_overview' && screen !== 'day_detail') {
        throw new Error('show_plan requires params.screen ∈ {next_action, week_overview, day_detail}.');
      }
      const day = typeof params.day === 'string' ? params.day : undefined;
      if (screen === 'day_detail' && !day) {
        throw new Error('show_plan with screen=day_detail requires params.day (ISO date string).');
      }
      if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        throw new Error('show_plan params.day must be ISO date YYYY-MM-DD.');
      }
      return {
        action: 'show_plan',
        params: day ? { screen, day } : { screen },
        reasoning,
      };
    }

    case 'show_shopping_list': {
      if (response !== undefined && response !== '') {
        throw new Error('show_shopping_list must have response: null.');
      }
      const scope = params.scope;
      if (scope !== 'next_cook' && scope !== 'full_week' && scope !== 'recipe' && scope !== 'day') {
        throw new Error('show_shopping_list requires params.scope ∈ {next_cook, full_week, recipe, day}.');
      }
      const recipe_slug = typeof params.recipe_slug === 'string' ? params.recipe_slug : undefined;
      const day = typeof params.day === 'string' ? params.day : undefined;
      if (scope === 'recipe' && !recipe_slug) {
        throw new Error('show_shopping_list with scope=recipe requires params.recipe_slug (string).');
      }
      if (scope === 'day' && !day) {
        throw new Error('show_shopping_list with scope=day requires params.day (ISO date string).');
      }
      if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        throw new Error('show_shopping_list params.day must be ISO date YYYY-MM-DD.');
      }
      const out: { scope: typeof scope; recipe_slug?: string; day?: string } = { scope };
      if (recipe_slug) out.recipe_slug = recipe_slug;
      if (day) out.day = day;
      return {
        action: 'show_shopping_list',
        params: out,
        reasoning,
      };
    }

    case 'show_progress': {
      if (response !== undefined && response !== '') {
        throw new Error('show_progress must have response: null.');
      }
      const view = params.view;
      if (view !== 'log_prompt' && view !== 'weekly_report') {
        throw new Error('show_progress requires params.view ∈ {log_prompt, weekly_report}.');
      }
      return {
        action: 'show_progress',
        params: { view },
        reasoning,
      };
    }

    case 'log_measurement': {
      if (response !== undefined && response !== '') {
        throw new Error('log_measurement must have response: null.');
      }
      const weight = typeof params.weight === 'number' ? params.weight : undefined;
      const waist = typeof params.waist === 'number' ? params.waist : undefined;
      if (weight === undefined && waist === undefined) {
        throw new Error('log_measurement requires at least one of params.weight or params.waist (numbers).');
      }
      if (weight !== undefined && (weight <= 0 || weight > 500)) {
        throw new Error('log_measurement params.weight must be a positive number under 500.');
      }
      if (waist !== undefined && (waist <= 0 || waist > 300)) {
        throw new Error('log_measurement params.waist must be a positive number under 300.');
      }
      const out: { weight?: number; waist?: number } = {};
      if (weight !== undefined) out.weight = weight;
      if (waist !== undefined) out.waist = waist;
      return {
        action: 'log_measurement',
        params: out,
        reasoning,
      };
    }
```

- [ ] **Step 2: Update the `knownActions` array inside `parseDecision`**

Plan C's `parseDecision` had a `knownActions` constant listing all dispatcher actions. After Plan D, it lists `flow_input | clarify | out_of_scope | return_to_flow | mutate_plan`. Replace it with the full 13:

```typescript
  const knownActions: readonly DispatcherAction[] = [
    'flow_input',
    'clarify',
    'out_of_scope',
    'return_to_flow',
    'mutate_plan',
    'answer_plan_question',
    'answer_recipe_question',
    'answer_domain_question',
    'show_recipe',
    'show_plan',
    'show_shopping_list',
    'show_progress',
    'log_measurement',
  ];
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS — the parser is more permissive (more actions allowed) but no existing scenario fixtures use the new actions yet, so no test fires the new code paths. The disallowed-action test was already updated in Task 7 Step 4 to use `log_eating_out` instead of the now-allowed `answer_plan_question`.

- [ ] **Step 5: Commit**

```bash
git add src/agents/dispatcher.ts test/unit/dispatcher-agent.test.ts
git commit -m "Plan 030: extend dispatcher catalog with 8 new action types + parseDecision cases

Also updates the disallowed-action unit test to use log_eating_out (answer_plan_question is now AVAILABLE)."
```

---

### Task 9: Update `buildSystemPrompt` — flip the eight Plan E actions from NOT AVAILABLE to AVAILABLE

**Rationale:** Plan C's prompt listed every Plan E action with a "NOT AVAILABLE in v0.0.5 — Plan E" marker and instructed the LLM to pick `clarify` / `out_of_scope` instead. Plan E flips them all to AVAILABLE with usage guidance, params docs, and few-shot examples. This is the load-bearing prompt change in Plan E.

**Files:**
- Modify: `src/agents/dispatcher.ts`

- [ ] **Step 1: Replace each NOT AVAILABLE entry**

Find `buildSystemPrompt()` in `src/agents/dispatcher.ts`. Replace each Plan E action's catalog entry. The pattern from Plan C's prompt was:

```
### answer_plan_question  (NOT AVAILABLE in v0.0.5 — Plan E)
### answer_recipe_question  (NOT AVAILABLE in v0.0.5 — Plan E)
### answer_domain_question  (NOT AVAILABLE in v0.0.5 — Plan E)
Future: questions about the plan...
```

Replace with eight new entries. Insert them between `mutate_plan` (Plan D) and the deferred-action notes:

```markdown
### answer_plan_question  (AVAILABLE)
The user is asking a factual question about their current plan that can be answered from the PLAN SUMMARY in your context — "when's my next cook day?", "what's planned for Thursday dinner?", "what's my weekly target?", "which days am I cooking?". You author the answer inline.
Params: { "question": string }  (echo the user's question for downstream logging)
Response: the answer text (required, user-visible). Be brief, factual, and ONLY use numbers/facts that are in the PLAN SUMMARY context. NEVER invent quantities, dates, or recipe names that aren't in the context. If the question asks for something not in the summary (e.g., "what ingredients do I still need?"), pick show_shopping_list with scope=next_cook instead.
When to pick: factual questions about the plan whose answer is mechanically derivable from the summary.
When NOT to pick: "why" questions about plan composition (the summary has no reasoning history — pick clarify with an honest "I can tell you what's in your plan but not why"); ingredient-level questions (route to show_shopping_list); product-meta questions like "what's a flex meal?" (pick out_of_scope with an honest "I don't explain product concepts yet").

### answer_recipe_question  (AVAILABLE)
The user is asking about a recipe — storage ("can I freeze the tagine?"), reheating ("how do I reheat the salmon pasta?"), basic technique, or substitutions. The recipe data you can use is in the RECIPE LIBRARY index in your context, which carries fridgeDays, freezable, reheat, mealTypes, and per-serving macros. For substitution questions, your general food knowledge is acceptable as long as the answer doesn't claim to know the recipe's specific ingredient list.
Params: { "question": string, "recipe_slug": string? }  (set recipe_slug when the question references a specific recipe by name or when the user is on a recipe view)
Response: the answer text (required). Use ONLY recipe-index data for storage/freezable/reheat questions. For substitution questions, give a brief generic answer.
When to pick: recipe-specific questions whose answer is in the recipe index data, OR generic substitution questions.
When NOT to pick: questions about how the recipe fits the plan (route to answer_plan_question); requests to modify the recipe in the plan (route to mutate_plan).

### answer_domain_question  (AVAILABLE)
The user is asking a general food/nutrition question that isn't specifically about their plan or library recipes — "protein in 100g chicken?", "what's the difference between brown and white rice?", "why does protein make me full?". Your general food knowledge is the answer source.
Params: { "question": string }
Response: the answer text (required). Brief. Non-judgmental. Non-lecturing. Aligned with Flexie's tone — flexible, no food demonization, hyper-palatable/ultra-processed foods are the only category we're skeptical of.
When to pick: in-domain food/nutrition questions outside the user's specific plan + library scope.
When NOT to pick: out-of-domain (weather, stock prices, etc. → out_of_scope); plan-specific questions (→ answer_plan_question); recipe-specific (→ answer_recipe_question).

### show_recipe  (AVAILABLE)
The user wants to see a specific recipe by name — "show me the calamari pasta", "let me see the lemon chicken", "the tagine one". You fuzzy-match against the RECIPE LIBRARY index in your context and pick the slug. The handler will render the cook view if the recipe is in an active batch, or the library view otherwise.
Params: { "recipe_slug": string }  (the slug from the RECIPE LIBRARY, not a free-form name)
Response: null (the handler renders the view)
When to pick: any natural-language request to "see" / "show" / "view" / "look at" a specific recipe.
When NOT to pick: requests to modify a recipe (→ mutate_plan); requests to see the plan or shopping list (→ show_plan / show_shopping_list); requests to browse the library generally (→ out_of_scope with "tap 📖 My Recipes").
**Disambiguation:** if the user's reference matches multiple library slugs (e.g., "the chicken one" with two chicken recipes), pick clarify with the candidate names. The handler's multi-batch tie-break picks soonest cook day automatically — you don't need to specify it.

### show_plan  (AVAILABLE)
The user wants to see their plan — "show me the plan", "what's tomorrow looking like?", "what's for dinner Thursday?". You pick the appropriate screen and (for day_detail) resolve the day to an ISO date.
Params: { "screen": "next_action" | "week_overview" | "day_detail", "day": string? }
- "next_action" — the user wants the brief "what's next" view ("what's next?", "what should I do?")
- "week_overview" — the full week view ("show me the week", "the whole plan", "everything")
- "day_detail" — a specific day's detail ("Thursday", "tomorrow", "Friday's meals"). REQUIRES "day" as ISO date YYYY-MM-DD. Resolve relative day names against the PLAN SUMMARY's horizon dates: "tomorrow" = today + 1, "Thursday" = the next Thursday in or after the horizon. If genuinely ambiguous, pick clarify.
Response: null
When to pick: any "show / view / what's" request about the plan structure.
When NOT to pick: questions about a specific batch's recipe (→ show_recipe); modifications (→ mutate_plan); shopping (→ show_shopping_list).

### show_shopping_list  (AVAILABLE)
The user wants the shopping list — "shopping list", "what do I need to buy?", "shopping for Friday", "everything I need this week", "shopping for the tagine".
Params: { "scope": "next_cook" | "full_week" | "recipe" | "day", "recipe_slug": string?, "day": string? }
- "next_cook" — the default "what to buy for the next cook day" ("shopping list", "what do I need to buy?")
- "full_week" — the entire horizon ("shopping for the week", "everything for this week", "the full list")
- "recipe" — one recipe across all batches ("shopping for the tagine", "what do I need for the calamari pasta?"). REQUIRES recipe_slug.
- "day" — one specific day ("shopping for Friday", "what to buy on Wednesday"). REQUIRES day as ISO date.
Response: null
When to pick: any shopping-list request.
When NOT to pick: ingredient-level questions about a specific batch ("how much beef in the tagine?" → answer_recipe_question).

### show_progress  (AVAILABLE)
The user wants to see or interact with progress (weight/waist measurements).
Params: { "view": "log_prompt" | "weekly_report" }
- "log_prompt" — open the measurement input prompt ("log my weight", "I want to log a measurement")
- "weekly_report" — show the weekly progress report ("how am I doing?", "show me the report", "weekly progress")
Response: null
When to pick: explicit "log" / "show progress" / "report" requests.
When NOT to pick: actually-typed-numeric measurements ("82.3", "82.3 / 91" — see log_measurement). When the user asks "log my weight" without giving a number, pick show_progress({view: 'log_prompt'}).

### log_measurement  (AVAILABLE)
The user typed numeric values that look like a weight and/or waist — "82.3", "82.3 today", "weight 82.3 waist 91", "82.3 / 91", "log 82.3". You extract the numbers into params.
Params: { "weight": number?, "waist": number? }  (one or both)
Response: null
When to pick: text contains a number that looks like a weight or waist measurement.
When NOT to pick: numbers that are clearly part of a different intent ("move dinner to day 3" — that's a mutation_plan request); numbers without unit context that could be anything else.
**Numeric pre-filter note:** when progressFlow.phase === 'awaiting_measurement', the runner pre-filter handles numeric input BEFORE you run — you will only see log_measurement-shaped messages from OTHER surfaces (the user types "82.3" while looking at the plan view, not after tapping 📊 Progress).
**Day:** the day is always today (server-local). No day parameter.
```

After the eight new entries, **delete** the Plan C combined "answer_plan_question / answer_recipe_question / answer_domain_question / show_recipe / show_plan / show_shopping_list / show_progress / log_measurement (NOT AVAILABLE)" placeholder block. Plan E replaces it entirely.

- [ ] **Step 2: Update the few-shot examples**

Plan C's prompt has a `## FEW-SHOT EXAMPLES` section. Append the following examples after the existing ones:

```
(Active flow: none / lifecycle: active_mid)
User: "when's my next cook day?"
→ { "action": "answer_plan_question", "params": { "question": "when's my next cook day?" }, "response": "Your next cook day is Thursday — you're cooking the Greek lemon chicken batch (3 servings, Thu/Fri/Sat dinner).", "reasoning": "Mechanical answer from the plan summary: scan batches for soonest eatingDays[0] in the future." }

(Active flow: none / lifecycle: active_mid / lastRenderedView: cooking/cook_view)
User: "can I freeze this?"
→ { "action": "answer_recipe_question", "params": { "question": "can I freeze this?", "recipe_slug": "tagine" }, "response": "Yes — beef tagine freezes well. Cool fully, portion into containers, and reheat from frozen in a covered pan with a splash of water. The recipe index marks it freezable=true.", "reasoning": "User is on a tagine cook view; recipe index shows freezable=true." }

(Active flow: none / lifecycle: active_mid)
User: "what's a substitute for tahini?"
→ { "action": "answer_domain_question", "params": { "question": "what's a substitute for tahini?" }, "response": "Cashew butter or sunflower seed butter both work — similar nutty flavor and texture. Greek yogurt is a thinner option if you want a looser sauce.", "reasoning": "Generic substitution question, no plan or specific recipe context needed." }

(Active flow: none / lifecycle: active_mid)
User: "show me the calamari pasta"
→ { "action": "show_recipe", "params": { "recipe_slug": "calamari-pasta" }, "response": null, "reasoning": "Fuzzy match in recipe index → calamari-pasta. Handler renders cook view if in active plan, library view otherwise." }

(Active flow: none / lifecycle: active_mid)
User: "what's Thursday looking like?"
→ { "action": "show_plan", "params": { "screen": "day_detail", "day": "2026-04-09" }, "response": null, "reasoning": "Today is 2026-04-07 (Tue), next Thursday is 2026-04-09. Resolve the day name against the plan horizon and pick day_detail." }

(Active flow: none / lifecycle: active_mid)
User: "shopping list for the tagine"
→ { "action": "show_shopping_list", "params": { "scope": "recipe", "recipe_slug": "tagine" }, "response": null, "reasoning": "Recipe-scoped shopping list request." }

(Active flow: none / lifecycle: active_mid)
User: "how am I doing this week?"
→ { "action": "show_progress", "params": { "view": "weekly_report" }, "response": null, "reasoning": "Weekly report request." }

(Active flow: none / lifecycle: active_mid / surface: plan)
User: "82.3 today"
→ { "action": "log_measurement", "params": { "weight": 82.3 }, "response": null, "reasoning": "Numeric weight input from a non-progress surface; cross-surface measurement logging." }
```

- [ ] **Step 3: Add a "NO-FABRICATION RULES" section**

Append a new section before `## STATE PRESERVATION` to lock in the read-only-by-construction guarantee:

```
## NO-FABRICATION RULES (load-bearing)

For answer_plan_question: NEVER invent batches, days, recipes, or numbers that aren't in PLAN SUMMARY. If the answer requires a number not in the summary, pick clarify with "I can't tell from your plan summary alone" or pick show_shopping_list / show_plan / show_recipe to render the actual data instead.

For answer_recipe_question: NEVER invent ingredient quantities, calorie counts, or recipe steps. The recipe index has macros, freezability, fridge days, and reheat instructions — use those. For everything else, give a brief generic answer that doesn't claim to know the specific recipe's content.

For answer_domain_question: NEVER cite specific studies, brands, or fabricate authoritative claims. Brief, generic, common-sense answers only. If the question genuinely needs lookup ("how much vitamin C in 100g kiwi?"), give your best general estimate with appropriate hedge.

A wrong answer that ADMITS uncertainty is much better than a confident wrong answer.
```

- [ ] **Step 4: Typecheck + test**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test`
Expected: many existing scenarios go RED. The dispatcher prompt has changed, so any scenario whose `llmFixtures` array contains a dispatcher fixture will fail because the recorded LLM input no longer matches the new prompt. This is the **intentional-red** state.

Task 33 below regenerates the affected scenarios. Until then, the tree stays red.

- [ ] **Step 5: Commit (intentional red)**

```bash
git add src/agents/dispatcher.ts
git commit -m "Plan 030: flip 8 Plan E actions from NOT AVAILABLE to AVAILABLE in dispatcher prompt

Existing dispatcher-fixture scenarios go red until Task 33 regenerates them."
```

---

### Task 10: Add dispatcher-agent unit tests for the eight new Plan E actions

**Rationale:** Task 7 already updated the disallowed-action test (swapped `answer_plan_question` → `log_eating_out`). This task adds positive tests that confirm `parseDecision` accepts valid responses for each of the eight new actions.

**Files:**
- Modify: `test/unit/dispatcher-agent.test.ts`

- [ ] **Step 1: Add new tests for the eight Plan E actions**

Append to `test/unit/dispatcher-agent.test.ts` one test per new action that confirms `parseDecision` accepts a valid response:

```typescript
test('dispatchMessage: answer_plan_question with question + response', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'answer_plan_question',
      params: { question: "when's my next cook day?" },
      response: 'Thursday — you cook the Greek lemon chicken batch.',
      reasoning: 'Mechanical lookup from plan summary.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), "when's my next cook day?", llm);
  assert.equal(decision.action, 'answer_plan_question');
  if (decision.action !== 'answer_plan_question') throw new Error('unreachable');
  assert.match(decision.response, /Thursday/);
});

test('dispatchMessage: answer_plan_question without response is rejected', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'answer_plan_question',
      params: { question: 'X?' },
      response: null,
      reasoning: 'Invalid — missing response.',
    }),
    JSON.stringify({
      action: 'answer_plan_question',
      params: { question: 'X?' },
      response: 'Corrected answer.',
      reasoning: 'Fixed.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'X?', llm);
  assert.equal(decision.action, 'answer_plan_question');
});

test('dispatchMessage: show_recipe with recipe_slug param', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'show_recipe',
      params: { recipe_slug: 'tagine' },
      response: null,
      reasoning: 'User asked to see the tagine.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'show me the tagine', llm);
  assert.equal(decision.action, 'show_recipe');
});

test('dispatchMessage: show_plan with day_detail requires day param', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'show_plan',
      params: { screen: 'day_detail' },
      response: null,
      reasoning: 'Missing day.',
    }),
    JSON.stringify({
      action: 'show_plan',
      params: { screen: 'day_detail', day: '2026-04-09' },
      response: null,
      reasoning: 'Fixed with explicit day.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'what is Thursday looking like', llm);
  assert.equal(decision.action, 'show_plan');
});

test('dispatchMessage: show_shopping_list scope=recipe requires recipe_slug', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'show_shopping_list',
      params: { scope: 'recipe' },
      response: null,
      reasoning: 'Missing recipe_slug.',
    }),
    JSON.stringify({
      action: 'show_shopping_list',
      params: { scope: 'recipe', recipe_slug: 'tagine' },
      response: null,
      reasoning: 'Fixed.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'shopping list for the tagine', llm);
  assert.equal(decision.action, 'show_shopping_list');
});

test('dispatchMessage: show_progress with view param', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'show_progress',
      params: { view: 'weekly_report' },
      response: null,
      reasoning: 'Weekly report request.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'show me the weekly report', llm);
  assert.equal(decision.action, 'show_progress');
});

test('dispatchMessage: log_measurement requires at least one numeric param', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'log_measurement',
      params: {},
      response: null,
      reasoning: 'Empty.',
    }),
    JSON.stringify({
      action: 'log_measurement',
      params: { weight: 82.3 },
      response: null,
      reasoning: 'Fixed with weight.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), '82.3 today', llm);
  assert.equal(decision.action, 'log_measurement');
});

test('dispatchMessage: log_measurement rejects out-of-range weight', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'log_measurement',
      params: { weight: 999 },
      response: null,
      reasoning: 'Out of range.',
    }),
    JSON.stringify({
      action: 'log_measurement',
      params: { weight: 82.3 },
      response: null,
      reasoning: 'Fixed.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), '999 today', llm);
  assert.equal(decision.action, 'log_measurement');
});
```

- [ ] **Step 5: Run the new tests**

Run: `npm test -- --test-name-pattern="dispatchMessage"`
Expected: all dispatcher-agent tests pass.

- [ ] **Step 6: Commit**

```bash
git add test/unit/dispatcher-agent.test.ts
git commit -m "Plan 030: dispatcher-agent unit tests for 8 new actions + retire promoted disallowed example"
```

---

### Tasks 11–17: Add the eight new action handlers

These tasks are deliberately compact — each handler is small and follows the same pattern. Task 12 bundles `handleAnswerRecipeQuestionAction` + `handleAnswerDomainQuestionAction` into one commit because both answer handlers have the same shape, so seven task headers cover eight handlers.

**Files for all tasks 11–17:**
- Modify: `src/telegram/dispatcher-runner.ts`
- Modify: `test/unit/dispatcher-secondary-actions.test.ts` (created in Task 11)

Each task:
1. Adds the named handler function as an export.
2. Adds a unit test that exercises it with a stub session + sink (or asserts the right view-renderer is called via a spy).
3. Typechecks + runs the unit test alone.
4. Commits.

Wire-up into the dispatcher runner's `switch` happens in Task 18 (one consolidated commit).

---

### Task 11: `handleAnswerPlanQuestionAction`

- [ ] **Step 1: Create the unit test file with the answer-plan-question test**

Create `test/unit/dispatcher-secondary-actions.test.ts`:

```typescript
/**
 * Unit tests for Plan 030's eight new dispatcher action handlers.
 *
 * Each handler is exercised with a hand-constructed session + sink. The
 * sink is a recording stub that captures every reply. The session is the
 * minimal `DispatcherSession` shape the runner uses.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  handleAnswerPlanQuestionAction,
  handleAnswerRecipeQuestionAction,
  handleAnswerDomainQuestionAction,
  handleShowRecipeAction,
  handleShowPlanAction,
  handleShowShoppingListAction,
  handleShowProgressAction,
  handleLogMeasurementAction,
} from '../../src/telegram/dispatcher-runner.js';
import type { DispatcherDecision } from '../../src/agents/dispatcher.js';
import type { DispatcherSession, DispatcherOutputSink, DispatcherRunnerDeps } from '../../src/telegram/dispatcher-runner.js';

interface RecordedReply {
  text: string;
  options?: { reply_markup?: unknown; parse_mode?: string };
}

function recordingSink(): { sink: DispatcherOutputSink; replies: RecordedReply[] } {
  const replies: RecordedReply[] = [];
  const sink: DispatcherOutputSink = {
    async reply(text, options) {
      replies.push({ text, options });
    },
  };
  return { sink, replies };
}

function emptySession(): DispatcherSession {
  return {
    planFlow: null,
    recipeFlow: null,
    progressFlow: null,
    surfaceContext: null,
    recentTurns: [],
  } as unknown as DispatcherSession;
}

function fakeDeps(): DispatcherRunnerDeps {
  return {
    llm: { complete: async () => { throw new Error('no LLM'); }, transcribe: async () => '' },
    recipes: { getAll: () => [], getBySlug: () => undefined } as never,
    store: {} as never,
  };
}

test('handleAnswerPlanQuestionAction: sends decision.response with side-conversation keyboard', async () => {
  const session = emptySession();
  const { sink, replies } = recordingSink();
  const decision: Extract<DispatcherDecision, { action: 'answer_plan_question' }> = {
    action: 'answer_plan_question',
    params: { question: "when's my next cook day?" },
    response: 'Thursday — Greek lemon chicken.',
    reasoning: 'plan-summary lookup',
  };
  await handleAnswerPlanQuestionAction(decision, fakeDeps(), session, sink);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.text, 'Thursday — Greek lemon chicken.');
  // Bot-turn capture is NOT this handler's job — it's done by
  // wrapSinkForBotTurnCapture / flushBotTurn in runDispatcherFrontDoor.
  // The handler must NOT call pushTurn (see handleClarifyAction for precedent).
  assert.ok(replies[0]!.options?.reply_markup, 'should include side-conversation keyboard');
});
```

- [ ] **Step 2: Run the test (expect FAIL — handler doesn't exist)**

Run: `npm test -- --test-name-pattern="handleAnswerPlanQuestionAction"`
Expected: FAIL — `handleAnswerPlanQuestionAction is not exported`.

- [ ] **Step 3: Implement the handler**

In `src/telegram/dispatcher-runner.ts`, append after the existing handlers:

```typescript
// ─── Plan 030 secondary action handlers ──────────────────────────────────────

/**
 * `answer_plan_question` — send the dispatcher's pre-written answer with a
 * side-conversation back button. Read-only: never mutates plan state.
 */
export async function handleAnswerPlanQuestionAction(
  decision: Extract<DispatcherDecision, { action: 'answer_plan_question' }>,
  deps: DispatcherRunnerDeps,
  session: DispatcherSession,
  sink: DispatcherOutputSink,
): Promise<void> {
  const kb = await buildSideConversationKeyboard(session, deps.store);
  // Bot-turn capture is handled by wrapSinkForBotTurnCapture / flushBotTurn
  // in runDispatcherFrontDoor — do NOT call pushTurn here (it would duplicate).
  await sink.reply(decision.response, { reply_markup: kb });
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -- --test-name-pattern="handleAnswerPlanQuestionAction"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/dispatcher-runner.ts test/unit/dispatcher-secondary-actions.test.ts
git commit -m "Plan 030: handleAnswerPlanQuestionAction handler + unit test"
```

---

### Task 12: `handleAnswerRecipeQuestionAction` and `handleAnswerDomainQuestionAction`

These two handlers are structurally identical to `handleAnswerPlanQuestionAction` — they take the dispatcher's pre-written response and reply with a side-conversation back button. They live in one task to keep the commit list shorter.

- [ ] **Step 1: Add unit tests**

Append to `test/unit/dispatcher-secondary-actions.test.ts`:

```typescript
test('handleAnswerRecipeQuestionAction: sends response with optional recipe_slug context', async () => {
  const session = emptySession();
  const { sink, replies } = recordingSink();
  const decision: Extract<DispatcherDecision, { action: 'answer_recipe_question' }> = {
    action: 'answer_recipe_question',
    params: { question: 'can I freeze the tagine?', recipe_slug: 'tagine' },
    response: 'Yes — tagine freezes well.',
    reasoning: 'recipe-index freezable=true',
  };
  await handleAnswerRecipeQuestionAction(decision, fakeDeps(), session, sink);
  assert.equal(replies[0]!.text, 'Yes — tagine freezes well.');
});

test('handleAnswerDomainQuestionAction: sends response', async () => {
  const session = emptySession();
  const { sink, replies } = recordingSink();
  const decision: Extract<DispatcherDecision, { action: 'answer_domain_question' }> = {
    action: 'answer_domain_question',
    params: { question: 'substitute for tahini?' },
    response: 'Cashew or sunflower seed butter work well.',
    reasoning: 'generic substitution',
  };
  await handleAnswerDomainQuestionAction(decision, fakeDeps(), session, sink);
  assert.equal(replies[0]!.text, 'Cashew or sunflower seed butter work well.');
});
```

- [ ] **Step 2: Implement both handlers**

Append to `src/telegram/dispatcher-runner.ts`:

```typescript
/**
 * `answer_recipe_question` — same shape as answer_plan_question. The
 * dispatcher's response is the answer; we just deliver it with a back
 * button. The recipe_slug param is currently used only for logging — a
 * future plan may add per-recipe answer-quality metrics.
 */
export async function handleAnswerRecipeQuestionAction(
  decision: Extract<DispatcherDecision, { action: 'answer_recipe_question' }>,
  deps: DispatcherRunnerDeps,
  session: DispatcherSession,
  sink: DispatcherOutputSink,
): Promise<void> {
  log.debug('DISPATCHER', `answer_recipe_question for slug=${decision.params.recipe_slug ?? '(none)'}`);
  const kb = await buildSideConversationKeyboard(session, deps.store);
  // Bot-turn capture handled by wrapSinkForBotTurnCapture — no pushTurn here.
  await sink.reply(decision.response, { reply_markup: kb });
}

/**
 * `answer_domain_question` — generic food/nutrition answer.
 */
export async function handleAnswerDomainQuestionAction(
  decision: Extract<DispatcherDecision, { action: 'answer_domain_question' }>,
  deps: DispatcherRunnerDeps,
  session: DispatcherSession,
  sink: DispatcherOutputSink,
): Promise<void> {
  const kb = await buildSideConversationKeyboard(session, deps.store);
  // Bot-turn capture handled by wrapSinkForBotTurnCapture — no pushTurn here.
  await sink.reply(decision.response, { reply_markup: kb });
}
```

- [ ] **Step 3: Run + commit**

```bash
npm test -- --test-name-pattern="handleAnswer"
git add src/telegram/dispatcher-runner.ts test/unit/dispatcher-secondary-actions.test.ts
git commit -m "Plan 030: handleAnswerRecipe/DomainQuestionAction handlers + unit tests"
```

---

### Task 13: `handleShowRecipeAction`

- [ ] **Step 1: Add unit test**

Append to `test/unit/dispatcher-secondary-actions.test.ts`:

```typescript
test('handleShowRecipeAction: delegates to renderCookViewForSlug; falls back to library', async () => {
  // This test exercises the integration with view-renderers via a mock
  // that records which renderer was called. Real rendering is tested in
  // the view-renderers unit tests (Task 20) and scenarios 057–059.
  // Here we just verify the action handler routes correctly.
  // Implementation: use a deps.store stub that returns null for plan
  // session → 'not_in_plan' → handler falls back to library view.
  const session = emptySession();
  const { sink, replies } = recordingSink();
  const deps: DispatcherRunnerDeps = {
    llm: fakeDeps().llm,
    recipes: {
      getAll: () => [],
      getBySlug: (slug: string) =>
        slug === 'tagine'
          ? ({
              name: 'Beef Tagine',
              shortName: 'Tagine',
              slug: 'tagine',
              cuisine: 'moroccan',
              tags: [],
              prepTimeMinutes: 30,
              perServing: { calories: 800, protein: 45, fat: 30, carbs: 60 },
              servings: 1,
              ingredients: [],
              instructions: [],
              storage: { fridgeDays: 4, freezable: true, reheat: 'pan' },
              mealTypes: ['dinner'],
              structure: [{ type: 'main', name: 'Main' }],
            } as never)
          : undefined,
    } as never,
    store: {
      async getRunningPlanSession() { return null; },
      async getFuturePlanSessions() { return []; },
    } as never,
  };
  const decision: Extract<DispatcherDecision, { action: 'show_recipe' }> = {
    action: 'show_recipe',
    params: { recipe_slug: 'tagine' },
    reasoning: 'fuzzy match',
  };
  await handleShowRecipeAction(decision, deps, session, sink);
  // Library view rendered → at least one reply with the recipe content.
  assert.ok(replies.length >= 1);
});
```

- [ ] **Step 2: Implement the handler**

Append to `src/telegram/dispatcher-runner.ts`:

```typescript
/**
 * `show_recipe` — resolve the slug to either the cook view of the
 * soonest-cook-day batch (if the recipe is in the active plan) or the
 * library view (otherwise). Multi-batch disambiguation is handled inside
 * `renderCookViewForSlug` per proposal 003 § show_recipe.
 */
export async function handleShowRecipeAction(
  decision: Extract<DispatcherDecision, { action: 'show_recipe' }>,
  deps: DispatcherRunnerDeps,
  session: DispatcherSession,
  sink: DispatcherOutputSink,
): Promise<void> {
  const { renderCookViewForSlug, renderLibraryRecipeView } = await import('./view-renderers.js');
  const result = await renderCookViewForSlug(
    session as never,
    deps,
    sink,
    decision.params.recipe_slug,
  );
  if (result === 'not_in_plan') {
    await renderLibraryRecipeView(session as never, deps, sink, decision.params.recipe_slug);
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
npm test -- --test-name-pattern="handleShowRecipeAction"
git add src/telegram/dispatcher-runner.ts test/unit/dispatcher-secondary-actions.test.ts
git commit -m "Plan 030: handleShowRecipeAction with cook-view-or-library fallback"
```

---

### Task 14: `handleShowPlanAction`

- [ ] **Step 1: Add unit test**

```typescript
test('handleShowPlanAction: routes screen=next_action to renderNextAction', async () => {
  const session = emptySession();
  const { sink, replies } = recordingSink();
  // Stub store with no plan → renderer's "no plan yet" branch.
  const deps: DispatcherRunnerDeps = {
    llm: fakeDeps().llm,
    recipes: { getAll: () => [], getBySlug: () => undefined } as never,
    store: {
      async getRunningPlanSession() { return null; },
      async getFuturePlanSessions() { return []; },
    } as never,
  };
  const decision: Extract<DispatcherDecision, { action: 'show_plan' }> = {
    action: 'show_plan',
    params: { screen: 'next_action' },
    reasoning: 'next action requested',
  };
  await handleShowPlanAction(decision, deps, session, sink);
  // The renderer's no-plan branch sends "You don't have a plan yet."
  assert.match(replies[0]!.text, /don't have a plan/);
});
```

- [ ] **Step 2: Implement**

```typescript
/**
 * `show_plan` — route to next_action / week_overview / day_detail.
 */
export async function handleShowPlanAction(
  decision: Extract<DispatcherDecision, { action: 'show_plan' }>,
  deps: DispatcherRunnerDeps,
  session: DispatcherSession,
  sink: DispatcherOutputSink,
): Promise<void> {
  const { renderNextAction, renderWeekOverview, renderDayDetail } = await import('./view-renderers.js');
  switch (decision.params.screen) {
    case 'next_action':
      await renderNextAction(session as never, deps, sink);
      return;
    case 'week_overview':
      await renderWeekOverview(session as never, deps, sink);
      return;
    case 'day_detail': {
      const day = decision.params.day;
      if (!day) {
        log.warn('DISPATCHER', 'show_plan day_detail with no day param — should have been rejected by parser');
        await sink.reply("I couldn't figure out which day you meant.");
        return;
      }
      await renderDayDetail(session as never, deps, sink, day);
      return;
    }
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
npm test -- --test-name-pattern="handleShowPlanAction"
git add src/telegram/dispatcher-runner.ts test/unit/dispatcher-secondary-actions.test.ts
git commit -m "Plan 030: handleShowPlanAction routes between three screens"
```

---

### Task 15: `handleShowShoppingListAction`

- [ ] **Step 1: Add unit test**

```typescript
test('handleShowShoppingListAction: builds scope from params', async () => {
  const session = emptySession();
  const { sink, replies } = recordingSink();
  const deps: DispatcherRunnerDeps = {
    llm: fakeDeps().llm,
    recipes: { getAll: () => [], getBySlug: () => undefined } as never,
    store: {
      async getRunningPlanSession() { return null; },
      async getFuturePlanSessions() { return []; },
    } as never,
  };
  const decision: Extract<DispatcherDecision, { action: 'show_shopping_list' }> = {
    action: 'show_shopping_list',
    params: { scope: 'full_week' },
    reasoning: 'full week request',
  };
  await handleShowShoppingListAction(decision, deps, session, sink);
  // No plan → "you don't have a plan yet" branch fires.
  assert.match(replies[0]!.text, /don't have a plan/);
});
```

- [ ] **Step 2: Implement**

```typescript
/**
 * `show_shopping_list` — translate dispatcher params into a ShoppingScope
 * and delegate to `renderShoppingListForScope`. The visible plan's horizon
 * dates and remaining-day counts are computed inside the renderer; the
 * handler only constructs the discriminated-union shape.
 */
export async function handleShowShoppingListAction(
  decision: Extract<DispatcherDecision, { action: 'show_shopping_list' }>,
  deps: DispatcherRunnerDeps,
  session: DispatcherSession,
  sink: DispatcherOutputSink,
): Promise<void> {
  const { renderShoppingListForScope } = await import('./view-renderers.js');
  const { toLocalISODate, getVisiblePlanSession, getNextCookDay } = await import('../plan/helpers.js');
  const today = toLocalISODate(new Date());

  // Pre-load the visible plan to compute horizon-dependent fields. The
  // renderer also loads it, but we need horizon dates here to construct
  // the scope object.
  const visible = await getVisiblePlanSession(deps.store, today);

  switch (decision.params.scope) {
    case 'next_cook': {
      // Compute next cook day from current batches.
      let targetDate = today;
      let remainingDays = 1;
      if (visible) {
        const batches = await deps.store.getBatchesByPlanSessionId(visible.id);
        const next = getNextCookDay(batches, today);
        if (next) {
          targetDate = next.date;
        }
        const horizonEndMs = new Date(visible.horizonEnd + 'T00:00:00Z').getTime();
        const targetMs = new Date(targetDate + 'T00:00:00Z').getTime();
        remainingDays = Math.max(1, Math.round((horizonEndMs - targetMs) / 86_400_000) + 1);
      }
      await renderShoppingListForScope(session as never, deps, sink, {
        kind: 'next_cook',
        targetDate,
        remainingDays,
      });
      return;
    }
    case 'full_week': {
      const horizonStart = visible?.horizonStart ?? today;
      const horizonEnd = visible?.horizonEnd ?? today;
      await renderShoppingListForScope(session as never, deps, sink, {
        kind: 'full_week',
        horizonStart,
        horizonEnd,
      });
      return;
    }
    case 'recipe': {
      if (!decision.params.recipe_slug) {
        log.warn('DISPATCHER', 'show_shopping_list scope=recipe without recipe_slug');
        await sink.reply("I couldn't figure out which recipe you meant.");
        return;
      }
      await renderShoppingListForScope(session as never, deps, sink, {
        kind: 'recipe',
        recipeSlug: decision.params.recipe_slug,
      });
      return;
    }
    case 'day': {
      if (!decision.params.day) {
        log.warn('DISPATCHER', 'show_shopping_list scope=day without day');
        await sink.reply("I couldn't figure out which day you meant.");
        return;
      }
      let remainingDays = 1;
      if (visible) {
        const horizonEndMs = new Date(visible.horizonEnd + 'T00:00:00Z').getTime();
        const targetMs = new Date(decision.params.day + 'T00:00:00Z').getTime();
        remainingDays = Math.max(1, Math.round((horizonEndMs - targetMs) / 86_400_000) + 1);
      }
      await renderShoppingListForScope(session as never, deps, sink, {
        kind: 'day',
        day: decision.params.day,
        remainingDays,
      });
      return;
    }
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
npm test -- --test-name-pattern="handleShowShoppingListAction"
git add src/telegram/dispatcher-runner.ts test/unit/dispatcher-secondary-actions.test.ts
git commit -m "Plan 030: handleShowShoppingListAction routes between four scopes"
```

---

### Task 16: `handleShowProgressAction`

- [ ] **Step 1: Unit test + implement together**

```typescript
test('handleShowProgressAction: routes view=log_prompt to renderProgressView', async () => {
  const session = emptySession();
  const { sink, replies } = recordingSink();
  const deps: DispatcherRunnerDeps = {
    llm: fakeDeps().llm,
    recipes: { getAll: () => [], getBySlug: () => undefined } as never,
    store: {
      async getTodayMeasurement() { return null; },
      async getMeasurements() { return []; },
    } as never,
  };
  const decision: Extract<DispatcherDecision, { action: 'show_progress' }> = {
    action: 'show_progress',
    params: { view: 'log_prompt' },
    reasoning: 'log measurement requested',
  };
  await handleShowProgressAction(decision, deps, session, sink);
  // No measurement today → "Drop your weight..." prompt.
  assert.match(replies[0]!.text, /Drop your weight/);
});
```

```typescript
export async function handleShowProgressAction(
  decision: Extract<DispatcherDecision, { action: 'show_progress' }>,
  deps: DispatcherRunnerDeps,
  session: DispatcherSession,
  sink: DispatcherOutputSink,
): Promise<void> {
  const { renderProgressView } = await import('./view-renderers.js');
  await renderProgressView(session as never, deps, sink, decision.params.view);
}
```

- [ ] **Step 2: Run + commit**

```bash
npm test -- --test-name-pattern="handleShowProgressAction"
git add src/telegram/dispatcher-runner.ts test/unit/dispatcher-secondary-actions.test.ts
git commit -m "Plan 030: handleShowProgressAction delegates to renderProgressView"
```

---

### Task 17: `handleLogMeasurementAction`

**Rationale:** This handler is the only Plan E delegation handler that touches state directly (via the measurement store). It must use the **exact same** code path as the existing `awaiting_measurement` numeric pre-filter. **Important:** Plan 028 Task 6/8 already moved the measurement fast path from `core.ts`'s `routeTextToActiveFlow` into `tryNumericPreFilter` in `dispatcher-runner.ts` (`src/telegram/dispatcher-runner.ts:361`). The `core.ts` `routeTextToActiveFlow` now only handles the `confirming_disambiguation` fallthrough (`src/telegram/core.ts:1264`). The shared helper must be extracted from `tryNumericPreFilter` in `dispatcher-runner.ts`, NOT from `core.ts`.

**Files:**
- Modify: `src/telegram/dispatcher-runner.ts` (extract helper + handler)
- Modify: `test/unit/dispatcher-secondary-actions.test.ts`

- [ ] **Step 1: Extract `renderMeasurementConfirmation` from `tryNumericPreFilter`**

In `src/telegram/dispatcher-runner.ts`, find `tryNumericPreFilter` (line ~361). The current body handles: parse → single number → persist → confirm; parse → two numbers → assignWeightWaist → persist OR disambiguate. Extract the post-parse logic into a new exported helper:

```typescript
/**
 * Plan 030: Shared measurement confirmation path. Called by both
 * `tryNumericPreFilter` (in-flow awaiting_measurement) and the
 * dispatcher's cross-surface `handleLogMeasurementAction`. Encapsulates
 * persist → confirm OR disambiguate decisions.
 *
 * Note: The measurement pipeline was moved from core.ts to
 * dispatcher-runner.ts in Plan 028 Task 6/8. This helper is extracted
 * from `tryNumericPreFilter` to share with the cross-surface handler.
 */
export async function renderMeasurementConfirmation(
  session: DispatcherSession,
  store: StateStoreLike,
  sink: DispatcherOutputSink,
  parsed: { values: number[] },
): Promise<void> {
  const today = toLocalISODate(new Date());
  // Single value → weight only.
  if (parsed.values.length === 1) {
    const weight = parsed.values[0]!;
    const isFirst = (await store.getLatestMeasurement('default')) === null;
    await store.logMeasurement('default', today, weight, null);
    session.progressFlow = null;
    let confirmText = formatMeasurementConfirmation(weight, null);
    if (isFirst) {
      confirmText +=
        "\n\nWe track weekly averages, not daily -- so don't worry about day-to-day swings. Come back tomorrow -- we'll start tracking your trend.";
    }
    const reportKb = await getProgressReportKeyboardIfAvailable(store, today);
    if (reportKb) {
      await sink.reply(confirmText, { reply_markup: reportKb });
    } else {
      await sink.reply(confirmText);
    }
    return;
  }
  // Two values → ambiguity check.
  const [a, b] = parsed.values as [number, number];
  const lastMeasurement = await store.getLatestMeasurement('default');
  const assignment = assignWeightWaist(a, b, lastMeasurement);
  if (!assignment.ambiguous) {
    const isFirst = lastMeasurement === null;
    await store.logMeasurement('default', today, assignment.weight, assignment.waist);
    session.progressFlow = null;
    let confirmText = formatMeasurementConfirmation(assignment.weight, assignment.waist);
    if (isFirst) {
      confirmText +=
        "\n\nWe track weekly averages, not daily -- so don't worry about day-to-day swings. Come back tomorrow -- we'll start tracking your trend.";
    }
    const reportKb = await getProgressReportKeyboardIfAvailable(store, today);
    if (reportKb) {
      await sink.reply(confirmText, { reply_markup: reportKb });
    } else {
      await sink.reply(confirmText);
    }
    return;
  }
  // Ambiguous — enter confirming_disambiguation phase.
  session.progressFlow = {
    phase: 'confirming_disambiguation',
    pendingWeight: assignment.weight,
    pendingWaist: assignment.waist,
    pendingDate: today,
  };
  await sink.reply(formatDisambiguationPrompt(assignment.weight, assignment.waist), {
    reply_markup: progressDisambiguationKeyboard,
  });
}
```

Then refactor `tryNumericPreFilter` to delegate to this helper after the guard checks:

```typescript
export async function tryNumericPreFilter(
  text: string,
  session: DispatcherSession,
  store: StateStoreLike,
  sink: DispatcherOutputSink,
): Promise<boolean> {
  if (!session.progressFlow || session.progressFlow.phase !== 'awaiting_measurement') {
    return false;
  }
  const parsed = parseMeasurementInput(text);
  if (!parsed) {
    return false;
  }
  await renderMeasurementConfirmation(session, store, sink, parsed);
  return true;
}
```

- [ ] **Step 2: Add the dispatcher handler**

In `src/telegram/dispatcher-runner.ts` (same file — no cross-module import needed):

```typescript
/**
 * `log_measurement` — cross-surface measurement logging. The dispatcher
 * already extracted weight/waist from the user's text. We synthesize a
 * `parsed` object that mirrors what `parseMeasurementInput` would return
 * and delegate to `renderMeasurementConfirmation` so the persist +
 * confirm pipeline is exactly the same as the in-flow path.
 */
export async function handleLogMeasurementAction(
  decision: Extract<DispatcherDecision, { action: 'log_measurement' }>,
  deps: DispatcherRunnerDeps,
  session: DispatcherSession,
  sink: DispatcherOutputSink,
): Promise<void> {
  // Build the same parsed shape parseMeasurementInput would produce.
  const values: number[] = [];
  if (decision.params.weight !== undefined) values.push(decision.params.weight);
  if (decision.params.waist !== undefined) values.push(decision.params.waist);
  if (values.length === 0) {
    await sink.reply("I didn't catch a number. Try '82.3' or '82.3 / 91'.");
    return;
  }
  await renderMeasurementConfirmation(session, deps.store, sink, { values });
}
```


- [ ] **Step 3: Add unit test**

```typescript
test('handleLogMeasurementAction: weight only delegates to renderMeasurementConfirmation', async () => {
  const session = emptySession();
  const { sink, replies } = recordingSink();
  let logged: { userId: string; date: string; weightKg: number; waistCm: number | null } | null = null;
  const deps: DispatcherRunnerDeps = {
    llm: fakeDeps().llm,
    recipes: { getAll: () => [], getBySlug: () => undefined } as never,
    store: {
      async logMeasurement(userId: string, date: string, weightKg: number, waistCm: number | null) {
        logged = { userId, date, weightKg, waistCm };
      },
      async getLatestMeasurement() { return null; },
      async getMeasurements() { return []; },
    } as never,
  };
  const decision: Extract<DispatcherDecision, { action: 'log_measurement' }> = {
    action: 'log_measurement',
    params: { weight: 82.3 },
    reasoning: 'cross-surface log',
  };
  await handleLogMeasurementAction(decision, deps, session, sink);
  assert.ok(logged, 'logMeasurement should be called');
  assert.equal(logged!.weightKg, 82.3);
  assert.equal(logged!.waistCm, null);
});
```

- [ ] **Step 4: Run + commit**

```bash
npm test -- --test-name-pattern="handleLogMeasurementAction"
git add src/telegram/dispatcher-runner.ts test/unit/dispatcher-secondary-actions.test.ts
git commit -m "Plan 030: handleLogMeasurementAction + extract renderMeasurementConfirmation from tryNumericPreFilter"
```

---

### Task 18: Wire all eight handlers into `runDispatcherFrontDoor`

**Rationale:** Tasks 11–17 added the handler functions but didn't wire them into the runner's decision `switch`. This task does the wire-up in one commit so the dispatcher can actually call them.

**Files:**
- Modify: `src/telegram/dispatcher-runner.ts`

- [ ] **Step 1: Find the decision switch in `runDispatcherFrontDoor`**

Use Grep on `src/telegram/dispatcher-runner.ts` for `switch (decision.action)`. There may be more than one — Plan C has the main switch in `runDispatcherFrontDoor`, and Plan D added a `case 'mutate_plan'` to it.

- [ ] **Step 2: Add the eight new cases**

After the existing `case 'mutate_plan':` block, add:

```typescript
      case 'answer_plan_question':
        await handleAnswerPlanQuestionAction(decision, deps, session, sink);
        return;
      case 'answer_recipe_question':
        await handleAnswerRecipeQuestionAction(decision, deps, session, sink);
        return;
      case 'answer_domain_question':
        await handleAnswerDomainQuestionAction(decision, deps, session, sink);
        return;
      case 'show_recipe':
        await handleShowRecipeAction(decision, deps, session, sink);
        return;
      case 'show_plan':
        await handleShowPlanAction(decision, deps, session, sink);
        return;
      case 'show_shopping_list':
        await handleShowShoppingListAction(decision, deps, session, sink);
        return;
      case 'show_progress':
        await handleShowProgressAction(decision, deps, session, sink);
        return;
      case 'log_measurement':
        await handleLogMeasurementAction(decision, deps, session, sink);
        return;
```

- [ ] **Step 3: Typecheck — exhaustiveness check**

Run: `npx tsc --noEmit`
Expected: no errors. Because `DispatcherDecision` is a discriminated union and the switch is exhaustive over `decision.action`, TypeScript narrows correctly. If the switch is non-exhaustive, tsc emits a "not all code paths return" error — fix by adding any missing case.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: same red state as end of Task 9 (existing dispatcher-fixture scenarios still need Task 33 regen). The new wire-up doesn't break anything because no test calls the new actions yet.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/dispatcher-runner.ts
git commit -m "Plan 030: wire 8 new handlers into runDispatcherFrontDoor decision switch"
```

---

### Task 19: Upgrade `rerenderLastView` to call the real view-renderers

**Rationale:** Plan 028 Task 10 left `rerenderLastView` as a placeholder that emits "Back to your plan. Tap 📋 My Plan for the current view." text and relies on the user re-tapping a menu button. With Plan E's view-renderers in place, this helper can call them directly for real re-render parity. This closes the last Plan C TODO.

**Files:**
- Modify: `src/telegram/dispatcher-runner.ts`

- [ ] **Step 1: Replace the `rerenderLastView` body**

Find `rerenderLastView` in `src/telegram/dispatcher-runner.ts`. Replace its body:

```typescript
async function rerenderLastView(
  session: DispatcherSession,
  deps: DispatcherRunnerDeps,
  sink: DispatcherOutputSink,
): Promise<void> {
  const view = session.lastRenderedView;
  if (!view) {
    const menuKb = await buildMenuKeyboardForSession(session, deps.store);
    await sink.reply("You're at the menu.", { reply_markup: menuKb });
    return;
  }

  const {
    renderNextAction,
    renderWeekOverview,
    renderDayDetail,
    renderCookViewForBatch,
    renderLibraryRecipeView,
    renderRecipeLibrary,
    renderShoppingListForScope,
    renderProgressView,
  } = await import('./view-renderers.js');

  // Restore surfaceContext to match what the callback handlers set in
  // Task 6 before delegating. Without this, surfaceContext would remain
  // stale after a natural-language return_to_flow, breaking parity with
  // the callback path.
  session.surfaceContext = view.surface;

  switch (view.surface) {
    case 'plan':
      switch (view.view) {
        case 'next_action':
          await renderNextAction(session as never, deps, sink);
          return;
        case 'week_overview':
          await renderWeekOverview(session as never, deps, sink);
          return;
        case 'day_detail':
          await renderDayDetail(session as never, deps, sink, view.day);
          return;
      }
      return;
    case 'cooking':
      // view.view === 'cook_view' (only variant)
      await renderCookViewForBatch(session as never, deps, sink, view.batchId);
      return;
    case 'recipes':
      switch (view.view) {
        case 'recipe_detail':
          await renderLibraryRecipeView(session as never, deps, sink, view.slug);
          return;
        case 'library':
          // Full-fidelity re-render of the paginated library list.
          // `renderRecipeLibrary` reads `session.recipeListPage` directly
          // so the user returns to the exact page they were on (proposal
          // 003 state preservation invariant #6).
          await renderRecipeLibrary(session as never, deps, sink);
          return;
      }
      return;
    case 'shopping': {
      // Reconstruct ShoppingScope from the variant. Mirrors the scope
      // construction in Task 6 Step 7's sl_<param> refactor: next_cook
      // uses getNextCookDay to find the real target date, and remainingDays
      // is computed from the actual target/requested date, not from today.
      const { toLocalISODate, getVisiblePlanSession, getNextCookDay } = await import('../plan/helpers.js');
      const today = toLocalISODate(new Date());
      const visible = await getVisiblePlanSession(deps.store, today);
      const horizonEnd = visible?.horizonEnd ?? today;
      const horizonStart = visible?.horizonStart ?? today;

      /** Compute remaining plan days from a given date to horizon end. */
      const computeRemainingDays = (fromDate: string): number =>
        Math.max(
          1,
          Math.round(
            (new Date(horizonEnd + 'T00:00:00Z').getTime() -
              new Date(fromDate + 'T00:00:00Z').getTime()) /
              86_400_000,
          ) + 1,
        );

      switch (view.view) {
        case 'next_cook': {
          // Must resolve the actual next cook day, not just use today.
          // Mirrors the sl_next callback path in Task 6 Step 7.
          let targetDate = today;
          if (visible) {
            const ownBatches = await deps.store.getBatchesByPlanSessionId(visible.id);
            const overlapBatches = await deps.store.getBatchesOverlapping({
              horizonStart: visible.horizonStart,
              horizonEnd: visible.horizonEnd,
              statuses: ['planned'],
            });
            const seen = new Set<string>();
            const allBatches = [...ownBatches, ...overlapBatches]
              .filter((b) => (seen.has(b.id) ? false : (seen.add(b.id), true)))
              .filter((b) => b.status === 'planned');
            const nextCook = getNextCookDay(allBatches, today);
            if (nextCook) targetDate = nextCook.date;
          }
          await renderShoppingListForScope(session as never, deps, sink, {
            kind: 'next_cook',
            targetDate,
            remainingDays: computeRemainingDays(targetDate),
          });
          return;
        }
        case 'day':
          await renderShoppingListForScope(session as never, deps, sink, {
            kind: 'day',
            day: view.day,
            remainingDays: computeRemainingDays(view.day),
          });
          return;
        case 'full_week':
          await renderShoppingListForScope(session as never, deps, sink, {
            kind: 'full_week',
            horizonStart,
            horizonEnd,
          });
          return;
        case 'recipe':
          await renderShoppingListForScope(session as never, deps, sink, {
            kind: 'recipe',
            recipeSlug: view.recipeSlug,
          });
          return;
      }
      return;
    }
    case 'progress':
      await renderProgressView(session as never, deps, sink, view.view);
      return;
  }
}
```

- [ ] **Step 2: Typecheck — exhaustiveness check**

Run: `npx tsc --noEmit`
Expected: no errors. The exhaustive switch over `view.surface` + `view.view` is verified by TypeScript narrowing.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: same red state as Tasks 9–18 (existing dispatcher fixtures still need regen). No new failures.

- [ ] **Step 4: Commit**

```bash
git add src/telegram/dispatcher-runner.ts
git commit -m "Plan 030: upgrade rerenderLastView to delegate to view-renderers (closes Plan C TODO)"
```

---

### Task 20: View-renderers integration unit tests

**Rationale:** Tasks 11–17 unit-tested each handler in isolation against stub deps. Task 20 adds higher-fidelity tests that exercise the view-renderers against a `TestStateStore` seeded with a real plan, asserting both the rendered text shape and the `lastRenderedView` state mutation.

**Files:**
- Create: `test/unit/view-renderers.test.ts`

- [ ] **Step 1: Create the unit test file**

Create `test/unit/view-renderers.test.ts` with tests for each renderer. The tests follow this template:

```typescript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { TestStateStore } from '../../src/harness/test-store.js';
import {
  renderNextAction,
  renderWeekOverview,
  renderDayDetail,
  renderCookViewForSlug,
  renderShoppingListForScope,
  renderProgressView,
} from '../../src/telegram/view-renderers.js';
// ... seed canonical plan helper, sink helper, fakeRecipeDb helper

test('renderNextAction: sets lastRenderedView and emits text', async () => {
  // ... seed plan, call renderNextAction, assert sink.replies.length === 1
  // and session.lastRenderedView === { surface: 'plan', view: 'next_action' }
});

test('renderCookViewForSlug: multi-batch picks soonest cook day', async () => {
  // Seed two batches with the same recipeSlug and different cook days.
  // Call renderCookViewForSlug. Assert the cook view rendered for the
  // soonest batch (assert against the recorded text containing the soonest
  // batch's cook day in MarkdownV2 format).
});

test('renderCookViewForSlug: returns not_in_plan when slug missing', async () => {
  // Seed a plan with no matching slug. Assert result === 'not_in_plan'
  // and the sink received no replies.
});

test('renderShoppingListForScope: full_week aggregates across cook days', async () => {
  // Seed two batches on different cook days with overlapping ingredients.
  // Call renderShoppingListForScope with kind=full_week. Assert the
  // ingredient totals match expected aggregation.
});
```

Author one test per renderer + the multi-batch tie-break + the not_in_plan branch + each of the four shopping scopes + each of the two progress views. Total: ~12 tests.

- [ ] **Step 2: Run + commit**

```bash
npm test -- --test-name-pattern="view-renderers"
git add test/unit/view-renderers.test.ts
git commit -m "Plan 030: view-renderers integration unit tests against TestStateStore"
```

---

## Scenario tasks (21–32)

Each scenario task follows the same template:

1. **Author `test/scenarios/NNN-name/spec.ts`** with:
   - A `clock` ISO timestamp pinning the scenario to a stable date.
   - A `seedStore` function that uses `TestStateStore` to seed the canonical plan + recipes the scenario needs.
   - A `script` array of inbound updates (`{ kind: 'text', text: '…' }` or `{ kind: 'callback', data: '…' }`).
   - A short doc comment at the top explaining what the scenario asserts.
2. **Generate `recorded.json`** via `npm run test:generate -- NNN-name`. Wait for completion.
3. **Behaviorally review the recording** per CLAUDE.md § "Verifying recorded output": read every `[TG:OUT]` as if you were the user receiving the message, check the dispatcher fixture's `action` field matches the expected action, check `finalSession.lastRenderedView` and `finalStore` are the expected shapes. **NEVER commit a recording that captures wrong behavior** — fix the code and regenerate.
4. **Add to `test/scenarios/index.md`** in Task 34. Per-scenario tasks do NOT touch the index.
5. **Commit `spec.ts` + `recorded.json`** for the scenario. One commit per scenario.

The next twelve tasks each add one scenario.

---

### Task 21: Scenario 054 — `answer_plan_question`

**Goal:** User on the menu types "When's my next cook day?". Dispatcher picks `answer_plan_question`, replies with the answer derived from the plan summary in context, planFlow stays `null`, surfaceContext stays `'plan'`.

**Setup:**
- Clock: `2026-04-07T10:00:00` (Tuesday morning, mid-plan).
- Seed: a confirmed plan with horizon 2026-04-06 — 2026-04-12, breakfast = oatmeal, two batches: tagine dinner Mon–Wed (cook Mon), grain-bowl lunch Mon–Fri (cook Mon).
- Recipe DB: tagine + grain-bowl + oatmeal.

**Script:**
```typescript
[
  { kind: 'callback', data: 'my_plan' },              // user lands on plan view
  { kind: 'text', text: "When's my next cook day?" }, // dispatcher picks answer_plan_question
]
```

**Behavioral assertions on the recording:**
- After turn 1: `[TG:OUT]` is the Next Action view. `finalSession.surfaceContext === 'plan'`. `lastRenderedView.view === 'next_action'`.
- Turn 2 dispatcher fixture: `action === 'answer_plan_question'`, `params.question` contains "next cook day", `response` references a specific day (Tue or Wed depending on what the seed tagine batch cook day was — verify against the seed).
- After turn 2: `planFlow === null`. `surfaceContext === 'plan'` (unchanged). `lastRenderedView` unchanged.
- The answer text must NOT invent dates or recipes — every claim must be derivable from the seeded plan.

**Steps:**
- [ ] Author `test/scenarios/054-answer-plan-question/spec.ts`.
- [ ] Run `npm run test:generate -- 054-answer-plan-question --yes` and wait for completion.
- [ ] Behavioral review per the assertions above. If the dispatcher fabricated a date or invented a recipe name, the no-fabrication rule failed — fix the prompt (Task 9) and regenerate.
- [ ] `git add test/scenarios/054-answer-plan-question/`
- [ ] `git commit -m "Plan 030: scenario 054 — dispatcher picks answer_plan_question"`

---

### Task 22: Scenario 055 — `answer_recipe_question`

**Goal:** User on a tagine cook view types "Can I freeze this?". Dispatcher picks `answer_recipe_question` with `recipe_slug: 'tagine'`, replies using the recipe index data.

**Setup:**
- Clock: `2026-04-07T18:00:00` (Tuesday evening — tagine cook day).
- Seed: same plan as scenario 054.
- The tagine recipe in the recipe DB has `freezable: true` and a non-empty `reheat` instruction.

**Script:**
```typescript
[
  { kind: 'callback', data: 'cv_<batchId-of-tagine>' }, // user opens cook view
  { kind: 'text', text: 'Can I freeze this?' },
]
```

**Note on `cv_<batchId>`:** the test author needs to know the deterministic batch ID. The seed uses a fixed UUID for the tagine batch (e.g., `'b-tagine-test-001'`) so the script can hard-code `cv_b-tagine-test-001`.

**Behavioral assertions:**
- Turn 1 output: cook view of tagine with scaled ingredients.
- `finalSession.lastRenderedView` after turn 1: `{ surface: 'cooking', view: 'cook_view', batchId: 'b-tagine-test-001', recipeSlug: 'tagine' }`. `lastRecipeSlug === 'tagine'`.
- Turn 2 dispatcher fixture: `action === 'answer_recipe_question'`, `params.recipe_slug === 'tagine'`, `response` mentions freezing being possible (consistent with `freezable: true`).
- The response must NOT invent ingredient quantities or recipe steps.

**Steps:**
- [ ] Author spec.ts.
- [ ] Generate recording.
- [ ] Behavioral review.
- [ ] Commit.

---

### Task 23: Scenario 056 — `answer_domain_question`

**Goal:** User types "What's a substitute for tahini?". Dispatcher picks `answer_domain_question`, replies with a generic substitute suggestion.

**Setup:**
- Clock: `2026-04-07T15:00:00`.
- Seed: an active plan (any plan).

**Script:**
```typescript
[{ kind: 'text', text: "What's a good substitute for tahini?" }]
```

**Behavioral assertions:**
- Dispatcher fixture: `action === 'answer_domain_question'`, `params.question` contains "substitute" and "tahini".
- Response mentions at least one realistic substitute (cashew butter, sunflower seed butter, Greek yogurt — any of these is fine).
- Response is brief (< 200 characters).
- No fabricated specific brand names or studies.

**Steps:**
- [ ] Author + generate + review + commit.

---

### Task 24: Scenario 057 — `show_recipe` for a recipe in the active plan

**Goal:** User on the menu types "show me the calamari pasta", calamari pasta is in one active batch. Dispatcher picks `show_recipe`, handler renders the cook view.

**Setup:**
- Clock: `2026-04-08T09:00:00`.
- Seed: a plan whose batches include a `calamari-pasta` dinner batch (any cook day in the horizon).
- The recipe DB has the calamari-pasta recipe.

**Script:**
```typescript
[{ kind: 'text', text: 'show me the calamari pasta' }]
```

**Behavioral assertions:**
- Dispatcher fixture: `action === 'show_recipe'`, `params.recipe_slug === 'calamari-pasta'`.
- Output text is the cook view (contains scaled batch amounts, not per-serving).
- `finalSession.lastRenderedView` is `{ surface: 'cooking', view: 'cook_view', batchId: …, recipeSlug: 'calamari-pasta' }`.
- `lastRecipeSlug === 'calamari-pasta'`.

**Steps:**
- [ ] Author + generate + review + commit.

---

### Task 25: Scenario 058 — `show_recipe` for a library-only recipe

**Goal:** User types "show me the lasagna", lasagna is in the library but not in any active batch. Dispatcher picks `show_recipe`, handler renders the library view.

**Setup:**
- Clock: `2026-04-08T09:00:00`.
- Seed: a plan WITHOUT a lasagna batch.
- Recipe DB includes a `lasagna` recipe (with full ingredients).

**Script:**
```typescript
[{ kind: 'text', text: 'show me the lasagna' }]
```

**Behavioral assertions:**
- Dispatcher fixture: `action === 'show_recipe'`, `params.recipe_slug === 'lasagna'`.
- Handler called `renderCookViewForSlug` which returned `'not_in_plan'`, then fell back to `renderLibraryRecipeView`.
- Output text is the library recipe view (per-serving amounts).
- `finalSession.lastRenderedView` is `{ surface: 'recipes', view: 'recipe_detail', slug: 'lasagna' }`.
- `lastRecipeSlug === 'lasagna'`.

**Steps:**
- [ ] Author + generate + review + commit.

---

### Task 26: Scenario 059 — `show_recipe` multi-batch tie-break

**Goal:** User types "show me the grain bowl", grain-bowl is in TWO active batches (early batch Mon–Wed, late batch Fri–Sun). Handler picks the soonest cook day (Mon).

**Setup:**
- Clock: `2026-04-06T08:00:00` (Monday before either batch's cook).
- Seed: TWO grain-bowl lunch batches with deterministic IDs `'b-grain-early'` (cook day Mon, eatingDays Mon–Wed) and `'b-grain-late'` (cook day Fri, eatingDays Fri–Sun).

**Script:**
```typescript
[{ kind: 'text', text: 'show me the grain bowl' }]
```

**Behavioral assertions:**
- Dispatcher fixture: `action === 'show_recipe'`, `params.recipe_slug === 'grain-bowl'`.
- Cook view rendered for `b-grain-early` (the Mon batch).
- `finalSession.lastRenderedView.batchId === 'b-grain-early'`.

**Why this is a regression lock:** the disambiguation rule is "soonest cook day, ties broken by batchId". A future change that flips the tie-break would surface here.

**Steps:**
- [ ] Author + generate + review + commit.

---

### Task 27: Scenario 060 — `show_plan` day_detail via natural-language day name

**Goal:** User types "what's Thursday looking like?". Dispatcher resolves "Thursday" to the next Thursday's ISO date and picks `show_plan({ screen: 'day_detail', day: <iso> })`.

**Setup:**
- Clock: `2026-04-07T10:00:00` (Tuesday). Next Thursday is `2026-04-09`.
- Seed: a plan whose horizon includes 2026-04-09 with at least one event/batch on that day (so the day detail has content to render).

**Script:**
```typescript
[{ kind: 'text', text: "what's Thursday looking like?" }]
```

**Behavioral assertions:**
- Dispatcher fixture: `action === 'show_plan'`, `params.screen === 'day_detail'`, `params.day === '2026-04-09'`.
- Output text is the formatted day detail for 2026-04-09.
- `finalSession.lastRenderedView === { surface: 'plan', view: 'day_detail', day: '2026-04-09' }`.

**Steps:**
- [ ] Author + generate + review + commit.

---

### Task 28: Scenario 061 — `show_shopping_list` scope=recipe

**Goal:** User types "shopping list for the tagine". Dispatcher picks `show_shopping_list({ scope: 'recipe', recipe_slug: 'tagine' })`. Handler calls `generateShoppingListForRecipe` and renders the scoped list.

**Setup:**
- Clock: `2026-04-07T10:00:00`.
- Seed: a plan with a tagine batch and at least one other batch (so the test verifies filtering works).

**Script:**
```typescript
[{ kind: 'text', text: 'shopping list for the tagine' }]
```

**Behavioral assertions:**
- Dispatcher fixture: `action === 'show_shopping_list'`, `params === { scope: 'recipe', recipe_slug: 'tagine' }`.
- Output text contains tagine ingredients and ONLY tagine ingredients (no grain-bowl or breakfast items).
- `finalSession.lastRenderedView === { surface: 'shopping', view: 'recipe', recipeSlug: 'tagine' }`.

**Steps:**
- [ ] Author + generate + review + commit. **In review, manually verify that grain-bowl ingredients do NOT appear in the output text** — this is the load-bearing assertion that the new generator scope works.

---

### Task 29: Scenario 062 — `show_shopping_list` scope=full_week

**Goal:** User types "full shopping list for the week". Dispatcher picks `show_shopping_list({ scope: 'full_week' })`. Handler calls `generateShoppingListForWeek` and renders the week-spanning list.

**Setup:**
- Clock: `2026-04-07T10:00:00`.
- Seed: a plan with batches across multiple cook days (e.g., tagine cook Mon, salmon cook Wed, lentil soup cook Fri) so the aggregation has interesting content.

**Script:**
```typescript
[{ kind: 'text', text: 'full shopping list for the week' }]
```

**Behavioral assertions:**
- Dispatcher fixture: `action === 'show_shopping_list'`, `params === { scope: 'full_week' }`.
- Output text contains ingredients from ALL cook days (tagine + salmon + lentil soup) AND prorated breakfast for the full horizon length.
- `finalSession.lastRenderedView === { surface: 'shopping', view: 'full_week' }`.
- Output text label header reads "Full week 2026-04-06 — 2026-04-12" or similar.

**Steps:**
- [ ] Author + generate + review + commit. **In review, verify the breakfast quantities are 7× the per-day amount** (the horizon is 7 days). If they're 4× or some other number, the proration is wrong.

---

### Task 30: Scenario 063 — `show_progress` weekly_report

**Goal:** User types "how am I doing this week?" with measurements logged for both the current week (today) and last week. Dispatcher picks `show_progress({ view: 'weekly_report' })`, handler renders the weekly report.

**Setup:**
- Clock: `2026-04-13T10:00:00` (Monday, start of a new week).
- Seed: 5 measurements last week (2026-04-06 through 2026-04-12) and a measurement for today.
- No active plan needed.

**Script:**
```typescript
[{ kind: 'text', text: 'how am I doing this week?' }]
```

**Behavioral assertions:**
- Dispatcher fixture: `action === 'show_progress'`, `params === { view: 'weekly_report' }`.
- Output text is the weekly report (matches `formatWeeklyReport` output for last week's measurements).
- `finalSession.lastRenderedView === { surface: 'progress', view: 'weekly_report' }`.

**Steps:**
- [ ] Author + generate + review + commit.

---

### Task 31: Scenario 064 — `log_measurement` cross-surface

**Goal:** User on the plan view (NOT in `awaiting_measurement` phase) types "82.3 today". Dispatcher picks `log_measurement({ weight: 82.3 })`, handler delegates to `renderMeasurementConfirmation`. The measurement persists, the user sees the confirmation, `surfaceContext` stays `'plan'`.

**Setup:**
- Clock: `2026-04-07T10:00:00`.
- Seed: an active plan + no measurement logged today.

**Script:**
```typescript
[
  { kind: 'callback', data: 'my_plan' },         // user on plan view
  { kind: 'text', text: '82.3 today' },          // cross-surface log
]
```

**Behavioral assertions:**
- After turn 1: `surfaceContext === 'plan'`, `lastRenderedView.view === 'next_action'`.
- Turn 2 dispatcher fixture: `action === 'log_measurement'`, `params === { weight: 82.3 }`.
- After turn 2: a measurement exists in `finalStore.measurements` with `weightKg: 82.3` and today's date.
- Output text is the confirmation: "Logged: 82.3 ✓" or similar — exact text from `formatMeasurementConfirmation`.
- `surfaceContext` unchanged from `'plan'` (the user does NOT get teleported to the progress surface).
- `progressFlow === null` (the awaiting_measurement phase was never entered).

**Why this is the load-bearing scenario for `log_measurement`:** it locks in JTBD D2's "under 5 seconds, from any surface" requirement.

**Steps:**
- [ ] Author + generate + review + commit. **In review, verify `progressFlow === null` after the log** — if it's set, the cross-surface path accidentally entered the in-flow path and the cross-surface affordance is broken.

---

### Task 32: Scenario 065 — Cross-action state preservation (the load-bearing regression lock)

**Goal:** User is mid-planning at `phase: 'proposal'` with mutation history `[{ constraint: 'initial', … }]`. User types "when's my flex this week?" — dispatcher picks `answer_plan_question`, planFlow preserved. Then types "actually move the flex to Sunday" — dispatcher picks `mutate_plan`, applier's in-session branch runs, mutation history extends to 2 entries. User taps `plan_approve`. The persisted session's `mutationHistory` has BOTH entries.

**This scenario is the direct embodiment of proposal 003 state preservation invariant #1.** It's the most important Plan E scenario.

**Setup:**
- Clock: `2026-04-05T18:00:00` (Sunday — start of a planning session).
- Seed: an empty store (no plan yet).
- Recipe DB: enough recipes for a full week's plan. The first user question ("when's my flex this week?") is mechanically answerable from the plan summary — the flex slot's `day` field is in the injected context — so the dispatcher can pick `answer_plan_question` without needing any specific recipe mix. This matches the design doc § 285 list of questions the v0.0.5 context bundle can support. The scenario deliberately does NOT ask a "why" question about plan composition: the dispatcher prompt instructs the LLM to route "why" questions to `clarify` with an honest "I can tell you what's in your plan but not why" response, and locking a "why" question as `answer_plan_question` here would cement the wrong action boundary.

**Script:**
```typescript
[
  { kind: 'callback', data: 'plan_week' },                  // start planning
  // ... whatever scripted callbacks are needed to reach phase=proposal
  // (breakfast confirm, events done, etc.) — author from existing scenarios 002 / 020
  { kind: 'text', text: "when's my flex this week?" },   // side question, dispatcher → answer_plan_question
  { kind: 'text', text: 'actually move the flex to Sunday' }, // mutation, dispatcher → mutate_plan → in-session branch
  { kind: 'callback', data: 'plan_approve' },               // user confirms
]
```

**Behavioral assertions:**
- Turn N (the side question): dispatcher fixture has `action === 'answer_plan_question'`. After this turn, `planFlow !== null` and `planFlow.phase === 'proposal'`. `planFlow.mutationHistory.length === 1` (the initial mutation from the planning session).
- Turn N+1 (the mutation): dispatcher fixture has `action === 'mutate_plan'`. After this turn, `planFlow.phase === 'proposal'` (unchanged), `planFlow.mutationHistory.length === 2` (the new mutation appended).
- Turn N+2 (`plan_approve` callback): the persisted session in `finalStore.planSessions` has `mutationHistory.length === 2`. Both entries' `constraint` strings match what the user typed.
- The proposal text after the answer turn is unchanged from before the answer turn (state preservation).

**Why this is the most important scenario in Plan E:** if the dispatcher's `answer_plan_question` handler accidentally cleared `planFlow` (or the runner accidentally cleared it on a side conversation), the planning session would die mid-conversation. This scenario catches any such regression.

**Steps:**
- [ ] Author the scenario carefully — copy the planning happy-path callback sequence from scenario 002 or 020 to reach `proposal` phase.
- [ ] Generate the recording.
- [ ] **Manually inspect `recorded.json` for the two assertions above.** If `mutationHistory` has only 1 entry after the mutation turn, the in-session applier branch isn't being called. If `planFlow === null` after the answer turn, the answer handler is clearing flow state — both are bugs.
- [ ] If the recording is correct, `git add test/scenarios/065-answer-then-mutate-state-preservation/` + commit.

---

### Task 33: Regenerate existing scenarios affected by the dispatcher prompt change

**Rationale:** Task 9 flipped the dispatcher prompt for eight Plan E actions from NOT AVAILABLE to AVAILABLE. Every existing scenario that fires text through the dispatcher has a `dispatcher` fixture in `llmFixtures` whose recorded INPUT (the prompt) no longer matches what the new prompt produces. The fixture replay system uses a hash of the request — any prompt change invalidates the hash and the scenario fails with "fixture not found". These scenarios need regeneration.

**Process:**

- [ ] **Step 1: Identify affected scenarios via `npm test`**

Run: `npm test`
Expected: failures with `fixture not found for hash NNNNN, context dispatcher` patterns. Each failing scenario is a regen candidate.

Note the list. Common candidates:
- `017-free-text-fallback`
- `020-planning-intents-from-text`
- `021-planning-cancel-intent`
- `029-recipe-flow-happy-path`
- `032-dispatcher-flow-input-planning` (Plan C)
- `033-dispatcher-out-of-scope` (Plan C)
- `034-dispatcher-return-to-flow` (Plan C)
- `035-dispatcher-clarify-multiturn` (Plan C)
- `037-dispatcher-numeric-prefilter` (Plan C)
- Any Plan D scenario that fires the dispatcher (044–053)

Scenarios not affected by Task 33's regeneration pass fall into two buckets: (1) **pure callback-driven** scenarios that never hit the dispatcher: 001–016, 018, 019, 022–028, 030, 031, 036; and (2) **newly-authored scenarios from this plan** (the 054–065 range added in Tasks 21–32), which are text-dispatcher scenarios by construction BUT are generated AFTER the Task 9 prompt flip, so their captured dispatcher fixtures already use the post-flip prompt. A scenario only needs regeneration in Task 33 if it was recorded BEFORE Task 9 against the old prompt — i.e., anything from Plans A/B/C/D that fires text through the dispatcher.

- [ ] **Step 2: Regenerate each affected scenario IN PARALLEL**

Per CLAUDE.md § "Regenerate in parallel, review serially": delete each target's `recorded.json` first, then launch every regeneration in parallel.

For each affected scenario (e.g., 017, 020, 021, 029, 032, ...):
```bash
rm test/scenarios/<name>/recorded.json
npm run test:generate -- <name> --regenerate --yes &
```

Wait for ALL regenerations to finish.

- [ ] **Step 3: Behaviorally review each regenerated recording, ONE AT A TIME**

Per CLAUDE.md § "Verifying recorded output", read each regenerated `recorded.json` carefully:
- Does the dispatcher's `action` field match what the user's text would expect?
- Does the user-facing output text still convey the correct meaning?
- Is `finalSession` still correct after the new dispatcher routing?
- For scenarios where the dispatcher previously picked `clarify` or `out_of_scope` for what's now an AVAILABLE Plan E action, the new picks should be the AVAILABLE action — verify the action change is INTENTIONAL and the new behavior is correct.

If any recording captures wrong behavior, fix the code (most likely the dispatcher prompt) and regenerate that one scenario.

- [ ] **Step 4: Run the full suite and confirm green**

Run: `npm test`
Expected: PASS. Every scenario green.

- [ ] **Step 5: Commit all regenerated recordings**

```bash
git add test/scenarios/<name1>/recorded.json test/scenarios/<name2>/recorded.json …
git commit -m "Plan 030: regenerate dispatcher-fixture scenarios after Plan E prompt promotion

Scenarios regenerated to capture the new AVAILABLE markers for the eight
Plan E actions. Behavioral review confirmed all recordings reflect the
intended new dispatcher behavior."
```

---

### Task 34: Update `test/scenarios/index.md`

**Files:**
- Modify: `test/scenarios/index.md`

- [ ] **Step 1: Add rows for scenarios 054–065**

Append to the table in `test/scenarios/index.md`:

```markdown
| 054 | answer-plan-question | Plan E: dispatcher picks answer_plan_question for "when's my next cook day?" |
| 055 | answer-recipe-question | Plan E: dispatcher picks answer_recipe_question for "can I freeze the tagine?" |
| 056 | answer-domain-question | Plan E: dispatcher picks answer_domain_question for "substitute for tahini?" |
| 057 | show-recipe-in-plan | Plan E: show_recipe renders cook view when slug is in active batch |
| 058 | show-recipe-library-only | Plan E: show_recipe falls back to library view when slug is not in plan |
| 059 | show-recipe-multi-batch | Plan E: show_recipe multi-batch picks soonest cook day (regression lock) |
| 060 | show-plan-day-detail-natural-language | Plan E: show_plan resolves "Thursday" to next Thursday's ISO date |
| 061 | show-shopping-list-recipe-scope | Plan E: show_shopping_list scope=recipe filters to one recipe |
| 062 | show-shopping-list-full-week | Plan E: show_shopping_list scope=full_week aggregates across cook days |
| 063 | show-progress-weekly-report | Plan E: show_progress weekly_report renders the weekly summary |
| 064 | log-measurement-cross-surface | Plan E: log_measurement persists from any surface, surfaceContext preserved |
| 065 | answer-then-mutate-state-preservation | Plan E: answer → mutate cross-action preserves planFlow + mutationHistory (load-bearing) |
```

- [ ] **Step 2: Commit**

```bash
git add test/scenarios/index.md
git commit -m "Plan 030: index entries for scenarios 054-065"
```

---

### Task 35: Sync `ui-architecture.md`, `flows.md`, and proposal 003 status

**Files:**
- Modify: `docs/product-specs/ui-architecture.md`
- Modify: `docs/product-specs/flows.md`
- Modify: `docs/design-docs/proposals/003-freeform-conversation-layer.md`

- [ ] **Step 1: Flip the eight Plan E rows in the catalog table**

In `docs/product-specs/ui-architecture.md`, find the "v0.0.5 minimal action catalog" table that Plan 028 created and Plans D/E flipped row-by-row. Update each Plan E row to:

```markdown
| `answer_plan_question` | ✅ Plan 030 | Inline answer to factual plan questions, derived from PLAN SUMMARY in dispatcher context. Read-only by construction. |
| `answer_recipe_question` | ✅ Plan 030 | Inline answer to recipe questions (storage, freezing, reheating, substitutions) using RECIPE LIBRARY index data. |
| `answer_domain_question` | ✅ Plan 030 | Inline answer to general food/nutrition questions using model knowledge. |
| `show_recipe` | ✅ Plan 030 | Renders cook view if slug is in active plan (multi-batch tie-break: soonest cook day) or library view otherwise. |
| `show_plan` | ✅ Plan 030 | Routes to next_action / week_overview / day_detail. Day-name resolution ("Thursday") is done by the dispatcher LLM against the plan horizon. |
| `show_shopping_list` | ✅ Plan 030 | Four scopes: next_cook (existing), full_week (aggregates horizon), recipe (filtered to one recipe), day (single cook day). |
| `show_progress` | ✅ Plan 030 | Routes to log_prompt or weekly_report views. |
| `log_measurement` | ✅ Plan 030 | Cross-surface measurement logging via the existing parse → assignWeightWaist → store pipeline. |
```

- [ ] **Step 2: Add a "Secondary actions (Plan 030)" subsection**

Append to the "Freeform conversation layer" section in `ui-architecture.md`:

```markdown
### Secondary actions (Plan 030 / Plan E)

After Plan 030 lands, the v0.0.5 dispatcher catalog is fully live with 13 active actions. The five non-Plan-E actions (`flow_input`, `clarify`, `out_of_scope`, `return_to_flow`, `mutate_plan`) handle in-flow text, ambiguous input, decline, navigation back, and the living-document mutation feature respectively. The eight Plan 030 actions surround them with read-only Q&A, navigation by name, and cross-surface measurement logging.

**Read-only answer actions** (`answer_plan_question`, `answer_recipe_question`, `answer_domain_question`) are inline-answer handlers — the dispatcher writes the response text from its context bundle and the handler delivers it with a side-conversation back button. The "no fabrication" rule in the dispatcher prompt forbids inventing numbers, dates, or recipe details that aren't in the context.

**Navigation actions** (`show_recipe`, `show_plan`, `show_shopping_list`, `show_progress`) route through the new view-renderers in `src/telegram/view-renderers.ts`. Every renderer sets `lastRenderedView` per Plan 027 so subsequent `return_to_flow` re-renders find the correct view to restore.

**`show_recipe` disambiguation rule** (proposal 003 § show_recipe): when the user names a recipe that exists in multiple active batches, the handler picks the batch with the soonest cook day. Ties are broken by `batchId` lexicographic order for determinism. v0.0.5 picks soonest-wins; a future version may add a clarify round-trip if users find the silent pick confusing.

**`show_shopping_list` scope matrix:**
- `next_cook` — existing behavior (filter to today's cook day, prorated breakfast for remaining days). Reuses `generateShoppingList`.
- `full_week` — aggregate every batch in the horizon, breakfast prorated to full horizon length. Reuses `generateShoppingListForWeek`.
- `recipe` — filter to one recipe, no breakfast. Reuses `generateShoppingListForRecipe`.
- `day` — alias for `next_cook` with an explicit target day. Reuses `generateShoppingListForDay` which delegates to `generateShoppingList`.

**Cross-surface `log_measurement`**: when the user types numbers from a non-progress surface, the dispatcher picks `log_measurement` and the handler delegates to `renderMeasurementConfirmation` (extracted from `tryNumericPreFilter` in `dispatcher-runner.ts` in Plan 030 Task 17). The persistence and confirmation behavior is byte-identical to the in-flow path. `surfaceContext` is preserved — the user does NOT get teleported to the progress surface.

**`rerenderLastView` upgrade**: Plan 028 left this helper as a placeholder that emitted "Back to your plan" text. Plan 030 promotes it to delegate to the view-renderers — `return_to_flow` now produces a real re-render of the exact view the user was last on.
```

- [ ] **Step 3: Add three new flow sections to `flows.md`**

In `docs/product-specs/flows.md`, append:

```markdown
## Flow: Side question during any phase (Plan 030)

The user can ask a question at any time without losing flow state.

**Entry points:** Any text/voice message during any phase that the dispatcher classifies as `answer_plan_question`, `answer_recipe_question`, or `answer_domain_question`.

**Flow:**
1. User types a question.
2. Dispatcher classifies and authors the inline answer using the context bundle (plan summary, recipe index, model knowledge).
3. Handler sends the answer with a side-conversation back button (`[← Back to planning]` if a flow is active, main menu otherwise).
4. The user's flow state (`planFlow`, `recipeFlow`, `progressFlow`) is unchanged. Mutation history, proposal state, and pending clarifications all persist.
5. The next user message is dispatched fresh with the answer in `recentTurns` so the dispatcher can follow referential threads ("what about the lamb?" after "can I freeze the tagine?").

**No-fabrication guarantee** (load-bearing): the dispatcher prompt forbids inventing numbers, dates, recipe ingredients, or product concepts that aren't in the context bundle. A wrong answer that admits uncertainty is much better than a confident wrong answer.

## Flow: Natural-language navigation (Plan 030)

The user can navigate by name from any surface.

**Entry points:** Any text/voice message classified as `show_recipe`, `show_plan`, `show_shopping_list`, or `show_progress`.

**Flow:**
1. User types a navigation request ("show me the tagine", "what's Thursday looking like?", "shopping list for the week", "weekly report").
2. Dispatcher picks the corresponding action and extracts the params (recipe slug, screen + day, scope, view).
3. Handler delegates to the matching view-renderer, which loads data, formats text, attaches the keyboard, and replies.
4. `lastRenderedView` is set to the precise variant of the new view, so subsequent `return_to_flow` lands here.

**Day name resolution** (`show_plan` with day_detail): the dispatcher resolves natural day references ("Thursday", "tomorrow", "next Friday") against the plan horizon dates in its context. Genuinely ambiguous references trigger `clarify`.

**Recipe disambiguation** (`show_recipe`): if the slug matches multiple library recipes (e.g., "the chicken one" with two chicken recipes), the dispatcher picks `clarify`. If it matches one recipe in multiple active batches, the handler picks the soonest cook day silently — see ui-architecture.md.

## Flow: Cross-surface measurement logging (Plan 030)

The user can log a measurement from any surface in under 5 seconds.

**Entry points:** Numeric text input from any surface where `progressFlow.phase !== 'awaiting_measurement'`. (When the user is in the awaiting-measurement phase, the numeric pre-filter handles the input directly without calling the dispatcher — same path as Plan 028.)

**Flow:**
1. User types numeric input ("82.3", "82.3 today", "82.3 / 91", "weight 82.3 waist 91").
2. Dispatcher picks `log_measurement` and extracts the numbers into params.
3. Handler synthesizes a `parsed` shape and delegates to `renderMeasurementConfirmation` — the SAME helper the in-flow path calls.
4. The measurement is persisted via `store.logMeasurement` and the user sees the confirmation. If two numbers are ambiguous (could be either weight or waist), the existing disambiguation UI fires.
5. `surfaceContext` is preserved — the user stays on whatever surface they were on. `progressFlow` is NOT entered.

**No undo for measurements** (v0.0.5): the measurement store is upsert-keyed by date. The recovery path for a mistyped weight is "send the correct numbers again". The confirmation message says so.
```

- [ ] **Step 4: Update proposal 003's status marker**

In `docs/design-docs/proposals/003-freeform-conversation-layer.md`, find the existing implementation marker (added by Plan D Task 23). Update to:

```markdown
> Implementation: Plans A (026), B (027), C (028), D (029), E (030) all complete.
> v0.0.5 dispatcher catalog fully live with 13 active actions. The living-document
> feature (mutate_plan) and the secondary catalog (answers, navigation,
> log_measurement) are both shipped.
```

- [ ] **Step 5: Run typecheck + tests**

Run: `npx tsc --noEmit && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add docs/product-specs/ui-architecture.md docs/product-specs/flows.md docs/design-docs/proposals/003-freeform-conversation-layer.md
git commit -m "Plan 030: sync ui-architecture.md, flows.md, and proposal 003 status (v0.0.5 catalog complete)"
```

---

### Task 36: Final baseline + commit chain verification

**Files:** none modified — verification only.

- [ ] **Step 1: Run the full test suite one final time**

Run: `npm test`
Expected: PASS. Test count: Plan D's baseline + ~10 view-renderers unit tests (Task 20) + ~10 dispatcher-secondary-actions unit tests (Tasks 11–17) + ~7 shopping generator scope tests (Task 3) + ~9 dispatcher-agent unit tests (Task 10 additions) + 12 new Plan E scenarios (054–065) + regenerated scenarios from Task 33.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Grep spot-checks — invariants in the final tree**

- `grep -n "answer_plan_question" src/agents/dispatcher.ts` returns hits in `DispatcherAction`, `AVAILABLE_ACTIONS_V0_0_5`, `DispatcherDecision`, `buildSystemPrompt` (with the AVAILABLE marker), and `parseDecision`. The string `"NOT AVAILABLE in v0.0.5 — Plan E"` must NOT appear anywhere — every Plan E action has been promoted.
- `grep -rn "view-renderers" src/` returns the module file plus imports in `core.ts` and `dispatcher-runner.ts`.
- `grep -n "renderCookViewForSlug" src/telegram/view-renderers.ts src/telegram/dispatcher-runner.ts` returns the definition plus the `handleShowRecipeAction` call site.
- `grep -n "generateShoppingListForWeek\|generateShoppingListForRecipe\|generateShoppingListForDay" src/shopping/generator.ts` returns three function definitions.
- `grep -n "ShoppingScope" src/shopping/generator.ts src/telegram/view-renderers.ts src/telegram/dispatcher-runner.ts` returns the type export and consumer references.
- `grep -n "rerenderLastView" src/telegram/dispatcher-runner.ts` returns the upgraded body. The placeholder string "Back to your plan. Tap 📋 My Plan for the current view." must NOT appear.
- `grep -n "renderMeasurementConfirmation" src/telegram/dispatcher-runner.ts` returns one definition and two call sites (in `tryNumericPreFilter` and `handleLogMeasurementAction`, both in the same file — no dynamic import needed).
- `grep -c "setLastRenderedView" src/telegram/view-renderers.ts` returns at least 10 (one per render variant).
- The `LastRenderedView` union in `src/telegram/navigation-state.ts` contains `'shopping' + 'full_week'` and `'shopping' + 'recipe'` variants.

- [ ] **Step 4: Verify the commit chain**

```bash
git log --oneline master..HEAD | head -50
```
Expected: each Plan 030 task produced exactly one commit (or two for tasks that involved both code and a test); the message prefix is "Plan 030:" throughout.

- [ ] **Step 5: Verify scenario count**

```bash
ls test/scenarios/ | grep -E '^[0-9]' | sort | tail -15
```
Expected: scenarios 054–065 all present.

- [ ] **Step 6: Move plan file from `active/` to `completed/`**

```bash
mv docs/plans/active/030-secondary-actions-and-renderers.md docs/plans/completed/030-secondary-actions-and-renderers.md
```

Then update the file header to mark `Status: Completed` and add a one-paragraph "Outcome" section at the bottom summarizing what shipped (eight new actions live, view-renderers extracted, shopping scopes added, twelve scenarios green, full v0.0.5 dispatcher catalog complete).

```bash
git add docs/plans/active/ docs/plans/completed/030-secondary-actions-and-renderers.md
git commit -m "Plan 030: mark complete and move to docs/plans/completed/"
```

- [ ] **Step 7: Run the suite one last time after the move**

Run: `npm test && npx tsc --noEmit`
Expected: PASS.

Plan E is complete. The full v0.0.5 freeform conversation layer from proposal 003 is shipped end-to-end.

---

## Decision log

**Why view-renderers extracted into a leaf module instead of injected via deps:**
Two options were considered. Option A (injection) would have required the dispatcher runner's `runDispatcherFrontDoor` signature to grow with each new render callback. Option B (extraction) creates a new leaf module both `core.ts` and `dispatcher-runner.ts` import without a cycle. Option B is chosen because (a) the runner's signature stays stable, (b) the renderers become independently unit-testable, (c) the refactor pays down `core.ts`'s growing inline-render burden — `core.ts` shrinks by ~150 lines after Task 6.

**Why `renderRecipeLibrary` IS extracted (reversal from initial draft):**
The first draft of Plan 030 argued `renderRecipeLibrary` should NOT be extracted because the proposal's action catalog has no `show_recipe_library` entry and `showRecipeList` has only one call site (the `📖 My Recipes` reply-keyboard button). The second-round review of the plan caught the missing second caller: `rerenderLastView`'s `recipes/library` branch. When `LastRenderedView = { surface: 'recipes', view: 'library' }` — set whenever the user views the library list — and the user types natural-language back navigation like "back to my recipes", proposal 003 state preservation invariant #6 requires the exact prior view to be restored ("`return_to_flow` restores the exact view, not a fresh render"). A hint reply like "Tap 📖 My Recipes for the full library." does NOT satisfy invariant #6. It's also a regression relative to what users experience today when they tap the reply-keyboard button — the library list reappears in-place, not a hint + tap-a-button round-trip. Extracting `showRecipeList` into `renderRecipeLibrary` delivers full-fidelity parity for every `LastRenderedView` variant the union defines, which is what invariant #6 demands. The extraction cost is ~30 lines: widen the parameter to a structural `RenderSession` slice (already required to include `recipeListPage`), swap the closure's `recipes` / `session` reads for explicit parameters, and delegate from `core.ts`'s button handler to the extracted helper. Task 5 Step 5 creates the helper, Task 6 replaces `core.ts`'s `showRecipeList` closure with a thin wrapper, and Task 19 routes the `recipes/library` variant of `rerenderLastView` to the real renderer. No UX downgrade, no deviation from the design doc, one more exported helper.

**Why the shopping generator gains new functions instead of a single multi-scope generator:**
Two options were considered. Option A (one function with a `ShoppingScope` discriminated-union argument) would have been a breaking change to `generateShoppingList`'s public signature, forcing every existing caller to update at the same time. Option B (three new functions, existing function unchanged) keeps the existing `sl_next` / `sl_<date>` callbacks identical and means scenarios 019/031 don't need regeneration. Option B is chosen for blast-radius reasons. The cost is three exports instead of one — a small ergonomic loss for a much smaller diff.

**Why `show_recipe` multi-batch tie-break is "soonest cook day" instead of clarify:**
The proposal 003 § show_recipe text says "v0.0.5 picks the batch with the soonest cook day; the implementation plan may replace this with a clarify round-trip if users find it confusing." Plan 030 picks soonest-wins because (a) the case is uncommon (same recipe in two batches), (b) silent pick is faster for the common case, (c) clarify is always available in a future version if user feedback warrants it.

**Why post-confirmation `answer_plan_question` does not include reasoning history:**
The persisted `mutationHistory` shape is `{ constraint, appliedAt }` — it does NOT carry the re-proposer's reasoning. Answering "why" questions about plan composition would require either (a) persisting reasoning alongside each mutation, or (b) re-deriving reasoning at answer time. Both are out of scope for v0.0.5. The dispatcher prompt instructs the LLM to pick `clarify` for "why" questions with an honest "I can tell you what's in your plan but not why" response.

**Why `log_measurement` reuses `renderMeasurementConfirmation` from `dispatcher-runner.ts` directly (no dynamic import):**
Plan 028 Task 6/8 already moved the measurement fast path from `core.ts`'s `routeTextToActiveFlow` into `tryNumericPreFilter` in `dispatcher-runner.ts`. Since both `tryNumericPreFilter` and `handleLogMeasurementAction` live in the same file, the shared helper is extracted in-place — no cross-module import needed, no circular dependency risk. The helper takes `(session, store, sink, parsed)` and encapsulates the persist → confirm OR disambiguate decisions that both callers share.

**Why the sl_<param> callback in core.ts is refactored to use `renderShoppingListForScope` instead of staying inline:**
Consistency and centralization. Before the refactor, `core.ts`'s sl_<param> case had its own `loadVisiblePlanAndBatches` + `getNextCookDay` + `generateShoppingList` chain inline. After the refactor, `core.ts` constructs a `ShoppingScope` object and delegates to the renderer. Both call sites (the callback and the dispatcher handler) end up in the same code path — any future bug fix lands in one place.

**Why scenarios 061/062 use new shopping scopes instead of testing them via `sl_*` callbacks:**
The new scopes (`full_week`, `recipe`, `day`) don't have callback affordances yet — there are no `[Full week]` or `[For this recipe]` buttons in the UI. The dispatcher is the ONLY way to reach the new scopes in v0.0.5. Adding buttons is a future affordance plan.

**Why scenario 065 (cross-action state preservation) is the highest-stakes Plan E scenario:**
It directly verifies proposal 003 state preservation invariant #1 ("the dispatcher never clears flow state"). If `handleAnswerPlanQuestionAction` accidentally cleared `planFlow`, every mid-planning question would silently kill the planning session and the user would have to start over — exactly the failure mode the proposal exists to prevent. Scenario 065 catches this regression on the next `npm test` after a future bug.

---

## Files NOT modified (deliberate scope guard recap)

- `src/plan/session-to-proposal.ts` (Plan A) — untouched.
- `src/plan/mutate-plan-applier.ts` (Plan D) — untouched.
- `src/agents/plan-reproposer.ts`, `src/agents/plan-flow.ts`, `src/agents/plan-proposer.ts` — untouched.
- `src/solver/solver.ts`, `src/qa/validators/proposal.ts` — untouched.
- `src/state/store.ts`, `src/harness/test-store.ts` — untouched. No schema changes.
- `supabase/migrations/*`, `supabase/schema.sql` — no new migrations.
- `src/telegram/bot.ts`, `src/ai/*` — untouched.
- Plan D's 10 mutation scenarios (044–053) — untouched (some may be regenerated in Task 33 if their dispatcher fixtures contain the now-promoted action references, but their behavior is unchanged).

This plan ships exactly the secondary catalog. No re-proposer changes. No solver changes. No data model changes.





