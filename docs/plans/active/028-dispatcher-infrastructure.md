# Plan 028: Dispatcher Infrastructure + Minimal Actions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Active
**Date:** 2026-04-10
**Affects:** `src/agents/dispatcher.ts` (new), `src/telegram/dispatcher-runner.ts` (new), `src/telegram/core.ts`, `src/agents/plan-flow.ts` (cancel-phrase audit only), `test/unit/dispatcher-agent.test.ts` (new), `test/unit/dispatcher-context.test.ts` (new), several new scenarios under `test/scenarios/`, regeneration of existing scenarios that fire LLM calls on free text, `docs/product-specs/ui-architecture.md`, `docs/product-specs/testing.md`.

**Goal:** Put a single structured LLM call in front of every inbound text/voice message, route the message to one of four minimal catalog actions (`flow_input`, `clarify`, `out_of_scope`, `return_to_flow`), preserve all existing in-flow text behavior, and leave every other capability (plan mutations, answers, navigation, measurement logging) for later plans. **This is Plan C from proposal `003-freeform-conversation-layer.md`.** After this plan, the dispatcher is live end-to-end for the minimal action set: typed "back to planning" routes through `return_to_flow`, off-topic messages route through `out_of_scope`, ambiguous requests hit `clarify`, and in-flow text still reaches the active flow via `flow_input`.

**Architecture:** A pure LLM agent lives in `src/agents/dispatcher.ts` and exposes `dispatchMessage(context, text, llm): Promise<DispatcherDecision>`. It builds a system prompt describing the four actions and a user prompt carrying a compact context bundle (surface, lifecycle, active flow summary, recent conversation turns, plan summary, recipe index), calls `llm.complete` with `model: 'mini'`, `reasoning: 'high'`, `json: true`, and parses a discriminated-union output (`action` + `params` + optional `response` + `reasoning`). A thin runner in `src/telegram/dispatcher-runner.ts` owns everything that touches `BotCoreSession`: it builds the context bundle, invokes the agent, pushes recent turns, and dispatches the chosen action to a deterministic handler. Handlers either forward to the existing flow text router (`flow_input`), send a dispatcher-written reply with the current menu (`clarify`, `out_of_scope`), or handle `return_to_flow` with three tiers of fidelity. **Tier 1 — byte-identical:** when `planFlow.phase === 'proposal'` or `recipeFlow.phase === 'reviewing'`, `rerenderPlanFlow` / `rerenderRecipeFlow` delegate to `getPlanFlowResumeView` / `getRecipeFlowResumeView` (leaf module `flow-resume-views.ts`, extracted in Task 8b) and emit exactly the stored `proposalText` / `renderRecipe(currentRecipe)` the user last saw — scenario 039 locks this in, satisfying invariant #6 for these phases. **Tier 2 — phase-canonical prompt:** every other active-flow phase emits a short re-entry prompt keyed on structural flow state; this is the existing legacy behavior of `getPlanFlowResumeView` inside `core.ts` that Task 8b extracts into the shared leaf module. The prompt is semantically correct but not byte-for-byte identical to whatever the bot said last. **Tier 3 — placeholder reply:** when no flow is active, `rerenderLastView` emits a minimal "Back to plan. Tap 📋 My Plan for the current view." keyed on Plan 027's `lastRenderedView` plus the main menu reply keyboard. Plan E's Task 19 promotes tiers 2 and 3 to byte-identical by adding `lastRenderedText` persistence to flow state and building the extracted view-renderers module. The full three-tier contract is documented in the Plan 028 decision log "staged invariants" entry. The front door in `core.dispatch` is rewired so text/voice messages go through the runner **after** the reply-keyboard main-menu match and **after** a narrow numeric pre-filter that handles the `progressFlow.phase === 'awaiting_measurement'` happy path without an LLM call. Every other entry point (commands, inline callbacks, reply-keyboard menu buttons) stays untouched.

**Tech Stack:** TypeScript, `LLMProvider` via the existing `src/ai/provider.ts` interface, `FixtureLLMProvider` for scenario replay, Node's built-in `node:test`, the existing scenario harness (`src/harness/runner.ts` + `test/scenarios/`). No database changes, no new external dependencies, no changes to the grammY adapter.

**Scope:** Dispatcher agent + runner + front-door wiring + the four minimal actions + scenario coverage. **Out of scope (explicitly deferred to Plan D/E):** `mutate_plan` (Plan D), `answer_plan_question` / `answer_recipe_question` / `answer_domain_question` (Plan E), `show_recipe` / `show_plan` / `show_shopping_list` / `show_progress` (Plan E), `log_measurement` (Plan E), `log_treat` / `log_eating_out` (deferred beyond v0.0.5). The free-text recipe-name lookup that `handleTextInput` does today (`src/telegram/core.ts:1325–1337`) is removed by this plan — it's structurally what `show_recipe` (Plan E) will replace, and keeping it alongside the dispatcher would create two overlapping routing paths. Its scenario coverage (scenario 017) is regenerated in this plan to lock in the new dispatcher behavior.

**Dependencies:** Plan 027 (Navigation State Model — Plan B) **must be completed and merged** before this plan starts. Plan 028 reads `session.lastRenderedView` in the `return_to_flow` handler and would compile-fail without the field. Plan 026 (Plan A — re-proposer post-confirmation enablement) is **not** a dependency: Plan 028 does not implement `mutate_plan`, so it does not call the adapter or the post-confirmation re-proposer path. Plans A and B can land in any order; Plan C must follow B.

---

## Problem

Today, every inbound text and voice message that isn't a slash command, inline callback, or reply-keyboard menu tap lands inside `handleTextInput` (`src/telegram/core.ts:1124–1340`) — a hand-rolled router that checks `session.progressFlow`, then `session.recipeFlow`, then `session.planFlow`'s meta-intent matcher and phase handlers, then an ad-hoc recipe-name fuzzy match, and finally a generic fallback (`replyFreeTextFallback` at `src/telegram/core.ts:255–279`). Five concrete problems fall out of that shape:

1. **The confirmed plan has no conversational entry point for adaptation.** Once `plan_approve` clears `planFlow`, every text message falls through every existing branch except the fuzzy recipe-name match and the fallback. There is no way to type "I'm eating out tonight" and reach the re-proposer — not because the re-proposer can't handle it (Plan 025 built exactly that capability, and Plan A makes it work against a confirmed plan), but because the routing table has no entry for "the user said something about the plan". The dispatcher is the entry point that makes post-confirmation mutation reachable. Plan D implements the `mutate_plan` action on top of it; Plan C builds the infrastructure D needs.

2. **Side questions during flows are silently lost.** A user reviewing a plan proposal who types "why so much pasta?" hits `planFlow.phase === 'proposal'`, which routes the text straight into `handleMutationText` (`src/agents/plan-flow.ts:605`) — the re-proposer treats the question as a mutation request, usually returning a clarification or a confused "no change needed" response. The proposal review gets disturbed by the failed mutation attempt. The state-preservation guarantees in proposal 003's "State preservation invariants" section require that questions, off-topic messages, and natural-language navigation NEVER reach `handleMutationText` unless the dispatcher has decided they are mutations. The dispatcher classifies intent once per message and forwards only genuine flow input to the existing flow handlers.

3. **"Back to the plan" has no keyboard and no text affordance.** The proposal review has a `[← Back to plan]` inline button only after certain side trips, and no text-based equivalent exists anywhere. A user who typed "what's in the tagine?" and saw the recipe gets a reply keyboard back, but typing "ok back to planning" does nothing — it's a fresh free-text turn with no context. The dispatcher adds the `return_to_flow` action so natural-language back navigation works from any surface.

4. **Typing during `awaiting_events` is a dead end for anything that isn't an event.** Today `handleEventText` tries to parse every inbound message as a meal event. A user who types "is the breakfast locked?" during events collection gets the LLM-powered event parser confidently turning "is the breakfast locked" into a bogus event. The dispatcher prevents this by classifying first and only forwarding to `handleEventText` when the message is actually event-shaped.

5. **The numeric-measurement path is structurally correct but has no peer.** `progressFlow.phase === 'awaiting_measurement'` uses a deterministic parser (`parseMeasurementInput` in `src/agents/progress-flow.ts`) and routes straight to the measurement store. This is the right shape — deterministic input, no LLM call needed — but it's the only such path. Proposal 003 formalizes it as a "narrow pre-filter" that runs before the dispatcher for exactly one phase, and leaves the rest of the front door to the LLM. Plan C moves the numeric path into that explicit pre-filter layer and gives the dispatcher everything else.

None of these problems are bugs in the existing code. They are the shape of a routing table that grew ad-hoc from individual flow needs, with no place for a cross-cutting "what does the user mean?" layer. Plan 025 validated that a single structured LLM call can replace ~800 lines of deterministic mutation handlers; Plan C applies that same pattern one level above, at the inbound-message surface, and leaves the existing flow handlers unchanged.

**What Plan C does NOT solve.** After Plan C, typing "show me the tagine recipe" still doesn't work — the dispatcher will classify it as `out_of_scope` (or `clarify`) because `show_recipe` isn't in the v0.0.5 minimal catalog. That capability ships in Plan E. Same for "I'm eating out tonight" — that's Plan D. Plan C's success criterion is narrow: **the dispatcher is live as the front door, the four minimal actions work correctly, the state-preservation invariants hold, the existing flow text handlers still receive exactly the same input they used to (via `flow_input`), and every existing scenario either passes unchanged or has been regenerated with the dispatcher in-path and behaviorally reviewed**.

---

## Plan of work

### File structure

**Files to create:**

- `src/agents/dispatcher.ts` — The pure LLM agent. Exports:
  - `DispatcherAction` — a string-literal union `'flow_input' | 'clarify' | 'out_of_scope' | 'return_to_flow'`.
  - `DispatcherContext` — the input context bundle shape: `{ now, surfaceContext, lastRenderedView?, lifecycle, activeFlowSummary, recentTurns, planSummary, recipeIndex, allowedActions }`.
  - `DispatcherDecision` — the output discriminated union `{ action, params, response?, reasoning }`.
  - `DispatcherFailure` — a distinct error class thrown on parse / retry failures so the runner can apply its fallback policy.
  - `dispatchMessage(context, userText, llm): Promise<DispatcherDecision>` — the single LLM call. Builds prompts, calls `llm.complete({ model: 'mini', reasoning: 'high', json: true, context: 'dispatcher' })`, parses the structured output, validates the action is in `allowedActions`, retries once on parse failure with the error fed back, throws `DispatcherFailure` on second failure. Pure — no imports from `telegram/` or `state/`.
  - Internal helpers: `buildSystemPrompt(context)`, `buildUserPrompt(context, userText)`, `parseDecision(raw, allowedActions)`.

- `src/telegram/dispatcher-runner.ts` — The integration layer. Owns everything that touches `BotCoreSession`. Exports:
  - `ConversationTurn` — `{ role: 'user' | 'bot'; text: string; at: string }`. One line per saved exchange.
  - `buildDispatcherContext(session, store, recipes, now)` — pure function that reads current state (lifecycle, active flow summary, plan summary, recipe index, recent turns, last rendered view, surface) and returns a `DispatcherContext`. No LLM calls, no side effects.
  - `runDispatcherFrontDoor(text, deps, session, sink, routeToActiveFlow)` — the front-door entry point called from `core.dispatch`. Runs the numeric pre-filter, builds context, calls `dispatchMessage`, pushes the inbound user turn, dispatches to the chosen action handler, and on dispatcher failure falls back to `replyFreeTextFallback`. `routeToActiveFlow` is injected by `core.ts` so the runner doesn't import `handleTextInput` directly (keeps the runner testable in isolation).
  - `handleFlowInputAction`, `handleClarifyAction`, `handleOutOfScopeAction`, `handleReturnToFlowAction` — the four action handlers. Each takes `(decision, deps, session, sink, routeToActiveFlow)` and does its side effect. `handleReturnToFlowAction` has two branches: (1) active-flow (planFlow or recipeFlow present) re-renders the flow's current view via `rerenderPlanFlow` / `rerenderRecipeFlow`, which delegate to `getPlanFlowResumeView` / `getRecipeFlowResumeView` in `flow-resume-views.ts`; (2) no-flow reads Plan 027's `lastRenderedView` and emits a minimal placeholder reply via `rerenderLastView` (see below). Fidelity is three-tiered — byte-identical for `proposal`/`reviewing` phases (Tier 1), phase-canonical prompt for other active-flow phases (Tier 2), placeholder for the no-flow case (Tier 3). See the Plan 028 decision log "staged invariants" entry for the full contract. `clarify` / `out_of_scope` handlers also use `planFlow` / `recipeFlow` state to decide whether to attach a `[← Back to X]` inline button via `plan_resume` / `recipe_resume` callbacks.
  - `rerenderLastView(session, deps, sink, now)` — helper used by `handleReturnToFlowAction` **only when no flow is active** (Tier 3). Reads `session.lastRenderedView` and emits a minimal placeholder text reply per variant ("Back to plan. Tap 📋 My Plan for the current view.", "Back to the shopping list. Tap 🛒 Shopping List for the current view.", etc.) rather than fully reproducing the view. This is a **deliberate Plan C limitation** — real re-render parity for the no-flow case requires the extracted view-renderers Plan E builds (`src/telegram/view-renderers.ts`), at which point Plan E's Task 19 promotes `rerenderLastView` to dispatch through those renderers. The placeholder is strictly better than today's behavior (which does nothing for "back to plan" typed while no flow is active) and clearly flagged in the decision log for Plan E upgrade. Scenario 039 exercises the active-flow Tier-1 branch, not this one.
  - `pushTurn(session, role, text)` — ring-buffer append onto `session.recentTurns`, capped at `RECENT_TURNS_MAX = 6` (3 user+bot pairs).
  - `tryNumericPreFilter(text, session, deps, sink)` — returns `true` if the text was parseable as a measurement AND `session.progressFlow?.phase === 'awaiting_measurement'`, after handling the measurement inline. Returns `false` otherwise.

- `test/unit/dispatcher-agent.test.ts` — Unit tests for the pure agent. Uses `FixtureLLMProvider` to exercise: (a) happy path for each of the four actions, (b) parse-failure → retry → success, (c) parse-failure → retry → `DispatcherFailure`, (d) disallowed-action in response → rejected → retry.

- `src/telegram/flow-resume-views.ts` — Leaf module exporting `getPlanFlowResumeView(state)` and `getRecipeFlowResumeView(state)`. Single source of truth for "where you left off" bot copy across the planning and recipe flows. Used by:
  - `core.ts`'s existing `plan_week` menu action (replaces the local `getPlanFlowResumeView` definition).
  - `dispatcher-runner.ts`'s `rerenderPlanFlow` / `rerenderRecipeFlow` helpers (Task 10), which in turn back both the dispatcher's `return_to_flow` branch AND `core.ts`'s `plan_resume` / `recipe_resume` inline callbacks via `handleReturnToFlowAction` delegation (Task 10 Step 5).
  Created in Task 8b. Imports flow state types, keyboards, `renderRecipe`, and `formatDateForMessage` from `src/utils/dates.ts`. Does NOT import `core.ts` or `dispatcher-runner.ts`.

- `test/unit/dispatcher-context.test.ts` — Unit tests for `buildDispatcherContext`. Feeds hand-constructed sessions and asserts the resulting context has the correct lifecycle, active flow summary (including `pendingClarification` when present), plan summary, recipe index formatting, and `allowedActions` set. Plain objects, no harness, no LLM.

- `test/scenarios/037-dispatcher-flow-input-planning/spec.ts` — In-flow text during planning proposal phase routes through the dispatcher as `flow_input` and reaches `handleMutationText` unchanged. Existing planning proposal review behavior is preserved. **Has LLM fixtures** (dispatcher call + any re-proposer calls).

- `test/scenarios/037-dispatcher-flow-input-planning/recorded.json` — Generated.

- `test/scenarios/038-dispatcher-out-of-scope/spec.ts` — User with no active plan types "what's the weather today?" and the dispatcher routes to `out_of_scope` with a short decline + main menu. **Has LLM fixtures** (one dispatcher call).

- `test/scenarios/038-dispatcher-out-of-scope/recorded.json` — Generated.

- `test/scenarios/039-dispatcher-return-to-flow/spec.ts` — User mid-planning types an off-topic message (routed as `out_of_scope` with `[← Back to planning]` button), then types "ok back to planning" and the dispatcher routes to `return_to_flow`, which re-renders the current proposal exactly as it was. State preservation test. **Has LLM fixtures**.

- `test/scenarios/039-dispatcher-return-to-flow/recorded.json` — Generated.

- `test/scenarios/040-dispatcher-clarify-multiturn/spec.ts` — User types "hmm" during a confirmed plan (ambiguous), dispatcher picks `clarify`, asks a follow-up question, user responds with a clearer message, dispatcher picks another action. Tests recent-turns carryover. **Has LLM fixtures**.

- `test/scenarios/040-dispatcher-clarify-multiturn/recorded.json` — Generated.

- `test/scenarios/041-dispatcher-cancel-precedence/spec.ts` — Regression lock for the cancel-vs-return-to-flow precedence rule. User is mid-planning (proposal phase), types "nevermind" — this must route through the existing `matchPlanningMetaIntent('cancel')` path, NOT through the dispatcher's `return_to_flow`. The planFlow is cleared, surface returns to menu. **No LLM fixtures** (cancel pre-filter runs before the dispatcher).

- `test/scenarios/041-dispatcher-cancel-precedence/recorded.json` — Generated.

- `test/scenarios/042-dispatcher-numeric-prefilter/spec.ts` — User taps 📊 Progress (enters `awaiting_measurement`), types "82.3", the numeric pre-filter short-circuits the dispatcher entirely and logs the measurement. Then types "how am I doing" (not in `awaiting_measurement` anymore) which goes through the dispatcher normally. **Has LLM fixtures** for the second turn.

- `test/scenarios/042-dispatcher-numeric-prefilter/recorded.json` — Generated.

- `test/scenarios/043-dispatcher-plan-resume-callback/spec.ts` — Regression lock for proposal 003 invariant #7 (natural-language back ≡ button tap). Mirror of scenario 039 but clicks the `plan_resume` inline button instead of typing "ok back to the plan"; asserts step 6's reply is byte-for-byte identical to scenario 039's step 6 and that no dispatcher LLM fixture is added for the button click. **Has LLM fixtures** (plan proposer + dispatcher for the out-of-scope side question only — NOT for the button click).

- `test/scenarios/043-dispatcher-plan-resume-callback/recorded.json` — Generated.

**Files to modify:**

- `src/telegram/core.ts`:
  - **Imports block (~lines 66–133)**: add imports from `./dispatcher-runner.js` (`runDispatcherFrontDoor`, `ConversationTurn`) and update the import line from `./navigation-state.js` (added in Plan 027) to also re-export what the runner needs if necessary. Add an import of `log.addOperationEvent` consumer for the dispatcher path, if not already present.
  - **`BotCoreSession` interface (~lines 183–201)**: add `recentTurns?: ConversationTurn[]` (optional, initialized on first write by `pushTurn`). This mirrors Plan 027's `lastRenderedView` pattern — the field is absent on fresh/reset sessions so existing scenario recordings do NOT grow a `recentTurns` entry until a turn is actually pushed. See the decision log entry "`recentTurns` is optional on `BotCoreSession`" for the rationale.
  - **`createBotCore` initializer (~lines 228–234)**: no change required — the optional field is absent until `pushTurn` writes for the first time, and `JSON.stringify` drops `undefined`.
  - **`reset()` (~lines 1343–1351 post-Plan-027)**: clear `recentTurns = undefined`.
  - **`dispatch()` text branch (~lines 305–315)**: call `runDispatcherFrontDoor(update.text, { llm, recipes, store }, session, sink, routeTextToActiveFlow)` instead of `handleTextInput(update.text, sink)`. Same for the voice branch (~line 303). `routeTextToActiveFlow` is the renamed-and-trimmed `handleTextInput`.
  - **`handleTextInput` → `routeTextToActiveFlow` (~lines 1124–1340)**: rename the function. Remove:
    - The entire `session.progressFlow && phase === 'awaiting_measurement'` branch (moved to the numeric pre-filter in the runner).
    - The `session.progressFlow && phase === 'confirming_disambiguation'` branch (this still needs to produce its "Use the buttons above" reply — keep it, but it's reachable only through the runner's `flow_input` handler now).
    - The recipe-name fuzzy match (~lines 1325–1337).
    - The final `await replyFreeTextFallback(sink)` (~line 1339). The runner's dispatcher-failure fallback replaces it.
  - **`replyFreeTextFallback` (~lines 255–279)**: keep — it's still the last-resort reply on dispatcher failure, called from the runner's catch block.
  - **`getPlanFlowResumeView` local definition (~lines 894–925)**: DELETE. Replaced by an import from `./flow-resume-views.js` in Task 8b. The single existing call site (the `plan_week` menu action) keeps working unchanged because the imported function has the same shape.
  - **`formatDateForMessage` local definition (~line 1433)**: DELETE. Moved to `src/utils/dates.ts` in Task 8b so the new resume-views module can import it without pulling in `core.ts`.
  - **`plan_resume` / `recipe_resume` inline callback cases in `handleCallback`**: ADD in Task 10 Step 5. A single merged case (`action === 'plan_resume' || action === 'recipe_resume'`) delegates to `handleReturnToFlowAction` from `dispatcher-runner.ts`, so back-button taps and the dispatcher's natural-language `return_to_flow` branch run through the same code path. No separate flow-gone fallback — the delegation naturally produces the Tier 3 placeholder via `rerenderLastView` when the flow has been cleared.

- `src/agents/plan-flow.ts`:
  - **`CANCEL_PATTERNS` (~lines 968–976)**: no list changes; this task only audits the set to make sure the dispatcher's `return_to_flow` phrase set does not overlap. A one-paragraph doc comment is added above `CANCEL_PATTERNS` explaining the precedence rule ("cancel wins on any ambiguity with `return_to_flow`") with a reference to Plan 028.

- `src/utils/dates.ts`:
  - Add an exported `formatDateForMessage(isoDate)` helper (currently a private function in `core.ts:1433`). The function moves verbatim and gets a doc comment. Task 8b.

- `docs/product-specs/ui-architecture.md`:
  - Add a new "Inbound message routing (Plan 028)" subsection describing the dispatcher front door, the minimal v0.0.5 catalog, the numeric pre-filter exception, the state preservation invariants, and the back-button pattern for side conversations. Explicitly note that Plans D and E will extend the catalog and that `handleTextInput` is now called `routeTextToActiveFlow` and is only reachable via `flow_input`.

- `docs/product-specs/testing.md`:
  - Add a short note under the scenario-authoring section that scenarios exercising free text now trigger a dispatcher LLM call per text turn, and that the dispatcher fixture appears as the first `llmFixture` for each text-turn burst.

- `test/scenarios/index.md`:
  - Add rows for scenarios 037–043.

- `test/scenarios/017-free-text-fallback/recorded.json` — **regenerate** to capture the new dispatcher behavior (fallback text now authored by the dispatcher's `out_of_scope` action).

- `test/scenarios/020-planning-intents-from-text/recorded.json` — **regenerate**. This scenario fires text during `planFlow.phase === 'proposal'` (the "Put the flex meal on Sunday instead" line and the "Start over" line). Under Plan C, each text turn adds a dispatcher LLM call upstream of the existing re-proposer / meta-intent path. The captured output should be **identical** (dispatcher picks `flow_input` → routes to the same handler), but the `llmFixtures` array gains the new dispatcher fixtures.

- `test/scenarios/021-planning-cancel-intent/recorded.json` — **regenerate** for the same reason. The "nevermind" text is caught by `matchPlanningMetaIntent` BEFORE the dispatcher runs (Plan C task 11 wires the meta-intent check to run inside `routeTextToActiveFlow` which is called via `flow_input`, OR as an early-return inside the runner — the task decides which; see Task 11). The recorded behavior is preserved.

- `test/scenarios/029-recipe-flow-happy-path/recorded.json` — **regenerate**. The recipe flow has text turns (preferences, refinement) that go through the dispatcher. New dispatcher fixtures are added; the user-facing output is unchanged.

**Files NOT modified (deliberate scope guard):**

- `src/telegram/keyboards.ts` — **No changes.** The minimal action handlers use the existing menu and back-button keyboards. New keyboards for Plans D and E come later.
- `src/ai/provider.ts`, `src/ai/openai.ts`, `src/ai/fixture.ts` — No changes. The dispatcher uses the existing `LLMProvider.complete` method with an existing model tier. Fixture replay works unchanged because the hash algorithm (`src/ai/fixture.ts:104–114`) already covers the dispatcher's request shape.
- `src/state/machine.ts`, `src/state/store.ts` — No changes. `recentTurns` lives in-memory only; the persistent `SessionState` doesn't know about them. Bot restarts drop in-progress conversations (same as `planFlow`/`recipeFlow`/`lastRenderedView`).
- `src/agents/plan-reproposer.ts` — No changes. The re-proposer is reachable via `flow_input → handleMutationText` exactly as today. Plan D adds a second entry point for post-confirmation mutations.
- `src/agents/recipe-flow.ts`, `src/agents/progress-flow.ts` — No changes beyond call sites reachable from the renamed `routeTextToActiveFlow`.
- `src/telegram/bot.ts` — No changes. The grammY adapter still calls `core.dispatch` for every update; whether the core routes through the dispatcher or not is a core-internal concern. Voice is still transcribed before dispatch (`bot.ts:176–191`) and the runner sees identical text.
- `src/telegram/navigation-state.ts` — No changes. Plan 027 built this; Plan 028 only reads from it.
- Every scenario that does NOT fire free text during its events (pure button-driven scenarios: 001–016, 018, 019, 022–028, and 030–036 from Plan 027) — no regeneration needed. Their `llmFixtures` arrays are unchanged because no dispatcher calls happen.

### Task order rationale

Tasks run strictly top-to-bottom.

- Tasks 1–3 lay the type foundation and the pure agent module. These are leaf additions that don't touch existing call sites.
- Tasks 4–5 build the context builder and unit-test it against the agent types from Tasks 2–3.
- Tasks 6–7 rename `handleTextInput` → `routeTextToActiveFlow` and trim the branches the runner will take over. After Task 7, `routeTextToActiveFlow` is the function the `flow_input` action handler will call.
- Tasks 8–10 build the runner: context assembly, action handlers, and the `return_to_flow` re-render helper. **Task 8b** sits between Task 8 and Task 9 to extract `getPlanFlowResumeView` / `getRecipeFlowResumeView` into a shared leaf module so Tasks 9, 10, and the existing `plan_week` menu action all call the same source of truth. Task 9 ships the three dispatcher-authored action handlers (`flow_input`, `clarify`, `out_of_scope`) plus the side-conversation keyboard helper. **Task 10** ships `handleReturnToFlowAction` AND the `plan_resume` / `recipe_resume` inline callback wiring in `core.ts` — both back-button callbacks delegate to the same handler the dispatcher's natural-language `return_to_flow` branch calls, which is what makes proposal 003 invariant #7 ("natural-language back commands are equivalent to back-button taps") structurally true. The resume helpers ship the three-tier fidelity model documented in the decision log: byte-identical for `proposal` / `reviewing`, phase-canonical prompt for other active-flow phases, placeholder for no-flow. The runner does not yet get called from `dispatch()` — Task 11 wires it in.
- Task 11 rewires `core.dispatch` to call `runDispatcherFrontDoor` for text and voice, including the numeric pre-filter. This is the single "front door flips on" commit.
- Task 12 audits the cancel-phrase set and updates the dispatcher prompt to respect the precedence rule.
- Task 13 regenerates the scenarios that fire free text (017, 020, 021, 029) and behaviorally reviews each one.
- Tasks 14–19 add six new scenarios (037–042), one task per scenario, generated + reviewed + committed individually. **Task 19b** adds scenario 043 as a button-tap regression lock for proposal 003 invariant #7 — it sits after scenario 042 because it depends on Task 10 Step 5's `plan_resume` callback wiring and is logically paired with scenario 039 (text-path equivalent).
- Task 20 updates `test/scenarios/index.md`.
- Task 21 syncs `ui-architecture.md` and `testing.md`.
- Task 22 is the final baseline.

Every task ends with a commit. `npm test` stays green after every task except Task 11 (where the front door flips on and existing scenarios go red pending Task 13's regeneration — same intentional-red pattern Plan 027 used in Task 5).

---

## Tasks

### Task 1: Green baseline + scenario-number check + no existing dispatcher module

**Files:** none — sanity check.

- [ ] **Step 1: Confirm clean `npm test`**

Run: `npm test`
Expected: all scenarios and unit tests pass. Note the count in the output (something like `# tests NN`) so later tasks can confirm no regressions. Plan 027 (Plan B) must have landed and be green before this plan starts — if `test/scenarios/030-navigation-state-tracking/` or `test/scenarios/031-shopping-list-mid-planning-audit/` do not exist, STOP: Plan 028 has a hard dependency on Plan 027.

- [ ] **Step 2: Confirm Plan 027 artifacts exist**

Run: `ls src/telegram/navigation-state.ts`
Expected: file exists. If it does not, Plan 027 has not landed — STOP and land it first.

Run: `grep -n "lastRenderedView" src/telegram/core.ts`
Expected: multiple hits (the field on `BotCoreSession`, the `setLastRenderedView` imports, the call sites in every render handler). If there are no hits, Plan 027 has not landed.

- [ ] **Step 3: Note the current highest scenario number**

Use the Glob tool with pattern `test/scenarios/*/spec.ts` and note the highest `NNN-` prefix. After Plan 027, 036 is the highest (Plan 027 shipped 030, 031, 032, 033, 035, 036 — 034 is an isolated gap left by the original numbering). Plan 028's new scenarios are numbered sequentially **after** the Plan 027 maximum: 037 through 042. Do not reuse 034 — leaving the gap is clearer than mixing one old number into a new sequence.

- [ ] **Step 4: Confirm there is no existing dispatcher module**

Use the Glob tool with pattern `src/**/dispatcher*.ts` and confirm no files match other than, at most, an empty directory sentinel. Also Grep for `dispatchMessage` across `src/` and confirm no hits — this is the function name the new agent exports.

- [ ] **Step 5: Read `src/telegram/core.ts` once end-to-end to confirm line references**

The line references in later tasks ("~lines 293–316 for `dispatch()`", "~lines 1124–1340 for `handleTextInput`") were captured before Plan 027 landed. Plan 027 inserted `setLastRenderedView` calls and added imports, which may have shifted line numbers by 10–30. Use Grep to locate the exact current positions of:

- The `dispatch()` function signature
- The `handleTextInput` function signature
- The `session.progressFlow && phase === 'awaiting_measurement'` branch
- The `if (session.planFlow)` branch with the meta-intent matcher
- The recipe-name fuzzy match at the end of `handleTextInput`
- The `replyFreeTextFallback` function

Record the current line numbers in a scratch note; each subsequent task references "~line N" — if the current line differs by more than 20 lines from the task's cited number, use the current line and treat the task's number as stale.

No commit — this is a verification step.

---

### Task 2: Add `recentTurns` to `BotCoreSession` + unit test for the ring buffer helper

**Rationale:** The dispatcher needs to see the user's recent conversation history to resolve referential threads ("what about the lamb?" after "can I freeze the tagine?") and to carry clarification context across turns (when `clarify` is picked on turn N, the user's answer on turn N+1 needs turn N's question in scope). This is the only new field Plan C adds to `BotCoreSession`. It's in-memory only — not persisted — so bot restarts drop history, which matches every other in-memory flow field.

The ring buffer is a three-line helper, but it has one sharp edge (capping at `RECENT_TURNS_MAX`) that deserves a unit test so Plan D/E can rely on the guarantee.

**Files:**
- Modify: `src/telegram/core.ts` — interface + initializer + `reset()`.
- Create: `src/telegram/dispatcher-runner.ts` — with **only** the `ConversationTurn` type and `pushTurn` helper for now. The rest of the runner lands in Task 8.
- Create: `test/unit/dispatcher-runner.test.ts` — unit tests for `pushTurn`.

- [ ] **Step 1: Create `src/telegram/dispatcher-runner.ts` with the conversation-turn scaffolding**

Create `src/telegram/dispatcher-runner.ts` with:

```typescript
/**
 * Dispatcher runner — the integration layer between the pure dispatcher LLM
 * agent (`src/agents/dispatcher.ts`) and the telegram core (`src/telegram/core.ts`).
 *
 * Plan 028 (Plan C from proposal 003-freeform-conversation-layer.md). The runner
 * owns everything that touches `BotCoreSession`: context assembly, action
 * handler dispatch, recent-turns bookkeeping, and the numeric pre-filter for
 * the progress measurement fast path. The pure agent module has no knowledge
 * of session state — it takes a context bundle in and returns a decision out.
 * Keeping the two layers separate means the agent is unit-testable against
 * plain objects and the runner is unit-testable against a fake LLM.
 *
 * This file grows across Task 2 (this file's initial shape), Task 8 (context
 * assembly + action handlers), and Task 10 (return_to_flow re-render helper).
 */

/**
 * A single conversation exchange. Written into `session.recentTurns` by the
 * runner around each dispatcher call, and read back by the runner when it
 * builds the next context bundle.
 *
 * - `role: 'user'` — the inbound message the dispatcher is about to classify
 *   OR just classified.
 * - `role: 'bot'` — the LAST reply the bot produced for this turn. Captured
 *   by `wrapSinkForBotTurnCapture` (Task 8) so it covers ALL action branches
 *   uniformly: dispatcher-authored replies (`clarify`, `out_of_scope`),
 *   re-rendered views (`return_to_flow`), AND downstream flow-handler
 *   replies (`flow_input` → re-proposer output, recipe-flow refinements,
 *   etc.). The proposal 003 context-hydration contract (line 257) calls
 *   for "last 3–5 user/bot exchanges"; recording bot turns from every
 *   branch is what makes that contract real for multi-turn threads like
 *   "what about the lamb?" right after a re-proposer reply that mentioned
 *   lamb.
 *
 *   The wrapper buffers each `sink.reply` and **overwrites** the previous
 *   capture, then commits the most recent one via `flushBotTurn` from a
 *   `try/finally` in the runner. This is what handles the recipe-flow
 *   pattern of `sink.reply('Generating your recipe...')` followed by the
 *   actual rendered recipe — a "first reply wins" policy would record the
 *   holding message and miss the substance, breaking referential threads.
 *
 *   Bot-turn text is truncated to `BOT_TURN_TEXT_MAX` chars at capture
 *   time (before `pushTurn`) so a long MarkdownV2 recipe body doesn't
 *   bloat the in-memory ring buffer or the next dispatcher prompt. The
 *   head of the reply is enough to resolve referential threads — the
 *   dispatcher already has full flow state via `planFlow`/`recipeFlow`
 *   summaries for anything it needs beyond the head.
 *
 * `at` is an ISO timestamp stamped when the turn is pushed; used for debug
 * logging and for expiring very-old turns if that becomes necessary later.
 */
export interface ConversationTurn {
  role: 'user' | 'bot';
  text: string;
  at: string;
}

/**
 * Ring-buffer cap for `session.recentTurns`. The dispatcher's context bundle
 * includes the last `RECENT_TURNS_MAX` turns verbatim. 6 = three user+bot
 * pairs, which the proposal document calls out as "last 3–5 user/bot
 * exchanges". At mini-tier prices, 6 short turns is a trivial prompt-size
 * contribution (~200 tokens) and buys enough context to follow referential
 * threads.
 */
export const RECENT_TURNS_MAX = 6;

/**
 * Truncation cap for bot-turn text captured by `wrapSinkForBotTurnCapture`
 * (Task 8). A long MarkdownV2 recipe body or a full plan proposal can be
 * several thousand characters; storing the full text in the in-memory ring
 * buffer is wasteful and inflates the next dispatcher prompt. 500 chars is
 * enough for the head of a reply to anchor referential threads — the
 * dispatcher already has `planFlow`/`recipeFlow` summaries for anything it
 * needs beyond the head. Truncation is applied at capture time, before
 * `pushTurn`, so the ring buffer never holds oversized entries.
 */
export const BOT_TURN_TEXT_MAX = 500;

/**
 * Append a turn to `session.recentTurns` in place, keeping at most
 * `RECENT_TURNS_MAX` items. The oldest turn is dropped when the buffer is
 * full.
 *
 * Mutates the session. Intentionally not pure so the runner can call it
 * without having to thread the array around.
 *
 * @param session - Any object carrying an optional
 *                  `recentTurns?: ConversationTurn[]` field. The helper
 *                  initializes the field to `[]` on first write, so callers
 *                  never have to check for undefined. Structurally typed so
 *                  unit tests can pass plain objects.
 * @param role - 'user' or 'bot' — see `ConversationTurn` doc.
 * @param text - Exact message body. Long messages are NOT truncated here;
 *               the context-bundle builder applies its own truncation when
 *               it serializes for the LLM prompt (Task 8).
 */
export function pushTurn(
  session: { recentTurns?: ConversationTurn[] },
  role: 'user' | 'bot',
  text: string,
): void {
  if (!session.recentTurns) {
    session.recentTurns = [];
  }
  session.recentTurns.push({
    role,
    text,
    at: new Date().toISOString(),
  });
  while (session.recentTurns.length > RECENT_TURNS_MAX) {
    session.recentTurns.shift();
  }
}
```

- [ ] **Step 2: Add `recentTurns` to `BotCoreSession`**

In `src/telegram/core.ts`, locate the `BotCoreSession` interface (currently around lines 183–201; post-Plan-027 the line numbers may have shifted by up to 10, confirm via Grep for `export interface BotCoreSession`). Add the new field **after** the existing `lastRecipeSlug?: string;` line and **before** the `progressFlow` field, so the order is: flow states → navigation state (surface, last recipe, last rendered view, recent turns) → progress flow. Replace the interface with:

```typescript
/**
 * In-memory session state. Hoisted from the previous closure-scoped variables
 * in `bot.ts` so that the harness can seed initial values and inspect the
 * final state for assertions.
 */
export interface BotCoreSession {
  recipeFlow: RecipeFlowState | null;
  planFlow: PlanFlowState | null;
  recipeListPage: number;
  /** D27: pending replan confirmation — set when Plan Week detects a future session */
  pendingReplan?: { replacingSession: import('../models/types.js').PlanSession };
  /** Which screen the user is currently looking at. Used by free-text fallback and back-button nav. */
  surfaceContext: 'plan' | 'cooking' | 'shopping' | 'recipes' | 'progress' | null;
  /** Slug of the last recipe viewed — for contextual back navigation. */
  lastRecipeSlug?: string;
  /**
   * Plan 027: Precise "what the user is looking at" — discriminated union
   * that captures the exact render target (plan subview, cook view, shopping
   * scope, recipe detail vs. library, progress subview) plus its parameters
   * (day, batchId, slug, etc.). The dispatcher in Plan 028 reads this to
   * re-render the last view for `return_to_flow`; set via `setLastRenderedView`
   * immediately before every render's `sink.reply`. Stays `undefined` on
   * session init and after `reset()`.
   */
  lastRenderedView?: LastRenderedView;
  /**
   * Plan 028: Last N conversation exchanges, ring-buffered at
   * `RECENT_TURNS_MAX` (6 = three user+bot pairs). Consumed by the
   * dispatcher's context-bundle builder so it can follow referential
   * threads across turns ("what about the lamb?" after "can I freeze
   * the tagine?") and carry clarification context. Written by
   * `pushTurn` in `./dispatcher-runner.ts`. In-memory only — not
   * persisted, dropped on bot restart.
   *
   * **Optional** so that scenarios that never fire free text keep their
   * existing `recorded.json` files unchanged — `JSON.stringify` drops
   * undefined fields, so only scenarios that actually populate turns
   * grow a `recentTurns` entry in their recording. Same rationale and
   * same pattern as Plan 027's `lastRenderedView` field (see Plan 027
   * decision log entry "lastRenderedView is OPTIONAL").
   */
  recentTurns?: ConversationTurn[];
  /** Progress measurement flow — explicit phase prevents input hijacking after logging. */
  progressFlow: {
    phase: 'awaiting_measurement' | 'confirming_disambiguation';
    pendingWeight?: number;
    pendingWaist?: number;
    /** ISO date when the user entered the numbers — store at parse time so midnight-crossing doesn't shift the log date. */
    pendingDate?: string;
  } | null;
}
```

- [ ] **Step 3: Add the import in `core.ts`**

At the top of `src/telegram/core.ts`, find the imports block (the navigation-state import added by Plan 027 is a good anchor — Grep for `navigation-state.js`). Add a new import immediately after it:

```typescript
import type { ConversationTurn } from './dispatcher-runner.js';
```

Type-only because `ConversationTurn` is the only symbol used in the interface declaration for now; the `pushTurn` helper is imported in Task 11 when the runner wiring lands.

- [ ] **Step 4: Leave `createBotCore()` initializer alone**

Because `recentTurns` is optional, the initializer does NOT need a new entry — the runner's `pushTurn` will initialize the field to `[]` on first write. Leaving the initializer unchanged keeps Task 2 strictly additive: no existing render path's captured session shape changes, no scenarios regenerate for this field alone. Verify by reading the current initializer (Grep for `const session: BotCoreSession`) and confirming it has no `recentTurns` line. Expected: leave as-is.

- [ ] **Step 5: Clear `recentTurns` in `reset()`**

Find the `reset()` function (currently around lines 1343–1351 post-Plan-027; Grep for `session.recipeFlow = null;`). Replace its body with:

```typescript
  // ─── Reset (for harness scenarios) ─────────────────────────────────────
  function reset(): void {
    session.recipeFlow = null;
    session.planFlow = null;
    session.progressFlow = null;
    session.recipeListPage = 0;
    session.surfaceContext = null;
    session.lastRecipeSlug = undefined;
    session.lastRenderedView = undefined;
    session.recentTurns = undefined;
    session.pendingReplan = undefined;
  }
```

(The only change from Plan 027's version is the new `session.recentTurns = undefined;` line. Setting the optional field to `undefined` — not `[]` — matches the initializer's implicit undefined state so post-reset scenarios land back at the same shape as fresh sessions.)

- [ ] **Step 6: Write the unit test for `pushTurn`**

Create `test/unit/dispatcher-runner.test.ts` with:

```typescript
/**
 * Unit tests for `dispatcher-runner.ts` helpers — Plan 028.
 *
 * Task 2 covers only `pushTurn` (ring buffer + cap). Task 8 will extend
 * this file with tests for `buildDispatcherContext`, `runDispatcherFrontDoor`,
 * and the action handlers.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  pushTurn,
  RECENT_TURNS_MAX,
  type ConversationTurn,
} from '../../src/telegram/dispatcher-runner.js';

function newSession(): { recentTurns: ConversationTurn[] } {
  return { recentTurns: [] };
}

test('pushTurn: appends a user turn', () => {
  const s = newSession();
  pushTurn(s, 'user', 'hello');
  assert.equal(s.recentTurns.length, 1);
  assert.equal(s.recentTurns[0]!.role, 'user');
  assert.equal(s.recentTurns[0]!.text, 'hello');
  assert.match(s.recentTurns[0]!.at, /^\d{4}-\d{2}-\d{2}T/);
});

test('pushTurn: appends a bot turn', () => {
  const s = newSession();
  pushTurn(s, 'bot', 'hi');
  assert.equal(s.recentTurns[0]!.role, 'bot');
  assert.equal(s.recentTurns[0]!.text, 'hi');
});

test('pushTurn: preserves order across multiple turns', () => {
  const s = newSession();
  pushTurn(s, 'user', 'one');
  pushTurn(s, 'bot', 'two');
  pushTurn(s, 'user', 'three');
  assert.deepStrictEqual(
    s.recentTurns.map((t) => t.text),
    ['one', 'two', 'three'],
  );
});

test(`pushTurn: caps at RECENT_TURNS_MAX (${RECENT_TURNS_MAX})`, () => {
  const s = newSession();
  for (let i = 0; i < RECENT_TURNS_MAX + 4; i++) {
    pushTurn(s, 'user', `turn-${i}`);
  }
  assert.equal(s.recentTurns.length, RECENT_TURNS_MAX);
  // The oldest four turns are dropped; the remaining are the newest ones.
  assert.equal(s.recentTurns[0]!.text, `turn-${4}`);
  assert.equal(
    s.recentTurns[RECENT_TURNS_MAX - 1]!.text,
    `turn-${RECENT_TURNS_MAX + 3}`,
  );
});

test('pushTurn: mutates the passed session object (no return value)', () => {
  const s = newSession();
  const result = pushTurn(s, 'user', 'x') as unknown;
  assert.equal(result, undefined);
  assert.equal(s.recentTurns.length, 1);
});

test('pushTurn: does not touch unrelated fields on the session', () => {
  const s: { recentTurns: ConversationTurn[]; marker?: string } = {
    recentTurns: [],
    marker: 'keep-me',
  };
  pushTurn(s, 'user', 'x');
  assert.equal(s.marker, 'keep-me');
});
```

- [ ] **Step 7: Typecheck + test**

Run: `npx tsc --noEmit`
Expected: no errors. The new `recentTurns` field on `BotCoreSession` is optional, so `createBotCore`'s initializer doesn't need to set it and the field reads as `undefined` everywhere the dispatcher isn't involved.

Run: `npm test`
Expected: PASS. New unit tests added (+6 test cases). **Existing scenarios are strictly unaffected** because `JSON.stringify` drops `undefined` fields — no scenario's recording gains a `recentTurns` entry until a later task actually writes turns during that scenario's run. This is the same mechanism Plan 027 used for `lastRenderedView`, and it is the reason Task 2 has no "patch 30 recordings" step.

If any scenario fails here, the failure is NOT caused by `recentTurns` — investigate the real diff before continuing.

- [ ] **Step 8: Commit**

```bash
git add src/telegram/core.ts src/telegram/dispatcher-runner.ts test/unit/dispatcher-runner.test.ts
git commit -m "Plan 028: add optional recentTurns to BotCoreSession + pushTurn helper

Introduces the ring buffer that the dispatcher will read on every call.
New unit test covers cap + ordering. Field is optional with on-first-write
initialization, matching Plan 027's lastRenderedView pattern, so no existing
scenario recordings need to change."
```

---

### Task 3: Create the dispatcher agent module — types + `dispatchMessage` skeleton

**Rationale:** The pure agent is a leaf module: it has no imports from `telegram/`, `state/`, or `harness/`, which means the unit test in Task 5 can exercise it against a hand-crafted `FixtureLLMProvider` without constructing any session. Separating the agent (pure) from the runner (stateful) mirrors how the re-proposer is split from `plan-flow.ts` and lets the dispatcher be reasoned about in isolation.

**Files:**
- Create: `src/agents/dispatcher.ts`

- [ ] **Step 1: Create `src/agents/dispatcher.ts` with the type definitions**

Create `src/agents/dispatcher.ts` with:

```typescript
/**
 * Conversation dispatcher — the single structured LLM call that classifies
 * every inbound text/voice message into one of a small catalog of actions.
 *
 * Plan 028 (Plan C from proposal `003-freeform-conversation-layer.md`).
 *
 * ## Architecture position
 *
 * This module is the **pure LLM agent** — it takes a context bundle in and
 * returns a decision out, with no side effects and no session-state access.
 * The integration layer that builds the context bundle, calls this module,
 * and routes the resulting decision to deterministic handlers lives in
 * `src/telegram/dispatcher-runner.ts`.
 *
 * ## Why one structured call, not a tool loop
 *
 * At Flexie's current scale everything the dispatcher needs fits in a single
 * prompt (recipe index ~50 lines, plan summary ~30 lines, recent turns
 * ~15 lines, action catalog ~50 lines — well under the mini-tier context
 * budget). The re-proposer (Plan 025) validated this pattern: one structured
 * call replaces a deterministic router and performs better on ambiguous
 * input. See proposal 003 § "Why one structured LLM call, not a tool-calling
 * loop" for the long-form rationale.
 *
 * ## Minimal action set (Plan 028 / v0.0.5 slice)
 *
 * Plan 028 implements exactly four actions — the ones that make the
 * dispatcher exercisable without any new capability beyond what already
 * exists today:
 *
 *   - `flow_input` — the text belongs to an active flow (recipe or plan);
 *     forward to the existing flow text handler unchanged.
 *   - `clarify` — the dispatcher can't commit to an action; ask a question.
 *   - `out_of_scope` — the text is outside the product's domain; decline
 *     honestly and offer the menu.
 *   - `return_to_flow` — the user typed a natural-language "back" command
 *     ("ok back to the plan", "let's continue planning"); re-render the
 *     last view they were on.
 *
 * Plan D will add `mutate_plan`; Plan E will add the answers / navigation /
 * measurement actions. Adding a new action means: (a) extend
 * `DispatcherAction`, (b) extend `DispatcherDecision`'s `params` union,
 * (c) add the action's description to `buildSystemPrompt`, (d) add a
 * handler in the runner. Nothing else changes.
 *
 * ## Failure modes
 *
 * The LLM can hallucinate an action outside the catalog or return
 * malformed JSON. Both cases retry once with the error fed back into the
 * conversation, then throw `DispatcherFailure`. The runner catches the
 * failure and falls back to `replyFreeTextFallback` — the same
 * surface-aware hint users get today when the legacy `handleTextInput`
 * router can't classify their message.
 */

import type { LLMProvider } from '../ai/provider.js';
import { log } from '../debug/logger.js';

// ─── Action catalog (v0.0.5 minimal slice) ─────────────────────────────────

/**
 * The set of actions the dispatcher can pick from in Plan 028. String-literal
 * union so adding an action in Plan D/E is a compile-time-breaking extension
 * (every switch on action type must be updated or TypeScript will complain).
 */
export type DispatcherAction =
  | 'flow_input'
  | 'clarify'
  | 'out_of_scope'
  | 'return_to_flow';

/**
 * The set of all actions the dispatcher knows about in v0.0.5. `mutate_plan`,
 * the answer actions, the navigation actions, and `log_measurement` are all
 * listed in proposal 003's catalog but are NOT implemented in Plan 028 —
 * they belong to Plans D and E. `log_eating_out` and `log_treat` are the
 * proposal's "deferred architectural commitments" and also not in v0.0.5.
 *
 * The dispatcher's prompt enumerates the FULL proposal catalog with short
 * descriptions of every action (including the deferred ones), but marks
 * each unimplemented action with a clear "NOT AVAILABLE in v0.0.5" note.
 * The LLM's decision is then filtered: if it picks an unavailable action,
 * the runner rejects the decision and retries once with an instruction to
 * pick from the available set. This keeps the prompt consistent with the
 * proposal's full design (so Plan D/E extensions only need to flip the
 * availability flag) while the runtime behavior matches v0.0.5's scope.
 */
export const AVAILABLE_ACTIONS_V0_0_5: readonly DispatcherAction[] = [
  'flow_input',
  'clarify',
  'out_of_scope',
  'return_to_flow',
] as const;

// ─── Context bundle ──────────────────────────────────────────────────────────

/**
 * A single entry in the recent-turns history passed into the dispatcher
 * prompt. Mirrors `ConversationTurn` from `dispatcher-runner.ts` but avoids
 * a circular import — the runner converts its internal `ConversationTurn[]`
 * into this shape when it builds the context.
 */
export interface DispatcherTurn {
  role: 'user' | 'bot';
  text: string;
}

/**
 * A minimal summary of the active flow (if any) that the dispatcher needs
 * to decide whether text is flow input or a side conversation.
 *
 * The runner builds this from `session.planFlow` / `session.recipeFlow`
 * and trims it to what the dispatcher's prompt actually uses. The shape
 * is intentionally small — full flow state is unnecessary because the
 * dispatcher never mutates it.
 */
export type ActiveFlowSummary =
  | { kind: 'none' }
  | {
      kind: 'plan';
      phase:
        | 'context'
        | 'awaiting_events'
        | 'generating_proposal'
        | 'proposal'
        | 'confirmed';
      horizonStart?: string;
      horizonEnd?: string;
      /**
       * Set when the re-proposer previously returned a clarification and
       * is waiting for the user's answer. If the user types a side
       * question instead of answering, the dispatcher must preserve this
       * field in the context for its next decision.
       */
      pendingClarification?: { question: string; originalMessage: string };
    }
  | { kind: 'recipe'; phase: 'awaiting_preferences' | 'awaiting_refinement' | 'reviewing' | 'other' }
  | { kind: 'progress'; phase: 'awaiting_measurement' | 'confirming_disambiguation' };

/**
 * A compact row for each recipe in the library, small enough to fit the
 * entire index in the dispatcher's prompt. The runner assembles this from
 * `RecipeDatabase.getAll()` — see `dispatcher-runner.ts` `buildRecipeIndex`.
 */
export interface DispatcherRecipeRow {
  slug: string;
  name: string;
  cuisine: string;
  mealTypes: ReadonlyArray<'breakfast' | 'lunch' | 'dinner'>;
  fridgeDays: number;
  freezable: boolean;
  /** Short reheat note from the recipe's YAML frontmatter. */
  reheat: string;
  /** Per-serving calories. */
  calories: number;
  /** Per-serving protein grams. */
  protein: number;
}

/**
 * A minimal summary of the active plan (if any). The dispatcher uses this
 * to answer plan questions in Plans D/E; in Plan C it's only used to decide
 * `out_of_scope` vs `clarify` when there's no obvious intent.
 */
export interface DispatcherPlanSummary {
  horizonStart: string;
  horizonEnd: string;
  /** Per-batch one-line summaries: "recipe-slug, 3 servings, Thu–Sat dinner". */
  batchLines: string[];
  /** Flex slots as "day mealTime (+N cal flex)". */
  flexLines: string[];
  /** Events as "day mealTime: name (~N cal)". */
  eventLines: string[];
  /** Weekly calorie target (from config). */
  weeklyCalorieTarget: number;
  /** Weekly protein target (from config). */
  weeklyProteinTarget: number;
}

/**
 * The input passed to `dispatchMessage` on every call. Everything the agent
 * knows about the world lives here. The runner builds it fresh for every
 * inbound message.
 */
export interface DispatcherContext {
  /** Server-local ISO date for "today" — proposal 003's single-user simplification. */
  today: string;
  /** Server-local ISO timestamp for "right now". */
  now: string;
  /** Coarse five-value surface enum from `BotCoreSession`. */
  surface: 'plan' | 'cooking' | 'shopping' | 'recipes' | 'progress' | null;
  /**
   * Precise last-view descriptor from Plan 027. May be `undefined` if the
   * user has not yet seen any navigation view (e.g., fresh session after
   * `/start` with no menu tap).
   */
  lastRenderedView?: {
    surface: 'plan' | 'cooking' | 'shopping' | 'recipes' | 'progress';
    view: string;
    [key: string]: unknown;
  };
  lifecycle: 'no_plan' | 'planning' | 'upcoming' | 'active_early' | 'active_mid' | 'active_ending';
  activeFlow: ActiveFlowSummary;
  recentTurns: DispatcherTurn[];
  /** `null` when no plan exists; present for `upcoming` and `active_*`. */
  planSummary: DispatcherPlanSummary | null;
  recipeIndex: DispatcherRecipeRow[];
  /** Which actions are currently reachable — enforced after parsing the LLM response. */
  allowedActions: readonly DispatcherAction[];
}

// ─── Decision output ──────────────────────────────────────────────────────────

/**
 * The dispatcher's structured output. Discriminated on `action`. `params` is
 * narrow in Plan 028 because the four minimal actions don't need many
 * parameters; Plan D/E extensions will carry richer params (e.g., `request`
 * for `mutate_plan`, `recipe_slug` for `show_recipe`).
 */
export type DispatcherDecision =
  | {
      action: 'flow_input';
      params: Record<string, never>;
      /**
       * Always undefined for `flow_input` — the downstream flow handler
       * authors the user-visible response, not the dispatcher.
       */
      response?: undefined;
      reasoning: string;
    }
  | {
      action: 'clarify';
      params: Record<string, never>;
      /** The clarifying question the dispatcher wants to ask. Required for this action. */
      response: string;
      reasoning: string;
    }
  | {
      action: 'out_of_scope';
      params: { category?: string };
      /** The dispatcher-authored decline message. Required for this action. */
      response: string;
      reasoning: string;
    }
  | {
      action: 'return_to_flow';
      params: Record<string, never>;
      /** Always undefined — the handler re-renders the last view, it doesn't emit new text. */
      response?: undefined;
      reasoning: string;
    };

/**
 * Thrown when `dispatchMessage` fails twice in a row (parse error, invalid
 * action choice, or LLM error). The runner catches this and falls back to
 * `replyFreeTextFallback`.
 */
export class DispatcherFailure extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DispatcherFailure';
  }
}

// ─── Entry point (prompt + call + parse wiring lands in Task 4) ──────────────

/**
 * Classify the user's inbound text and return a structured decision.
 *
 * **Task 3** scaffold: throws `DispatcherFailure('not implemented')`. Task 4
 * fills in `buildSystemPrompt`, `buildUserPrompt`, the `llm.complete` call,
 * `parseDecision`, and the retry loop. Keeping the interface frozen here
 * unblocks Task 4 from dependency-on-dependency uncertainty.
 */
export async function dispatchMessage(
  context: DispatcherContext,
  userText: string,
  llm: LLMProvider,
): Promise<DispatcherDecision> {
  void context;
  void userText;
  void llm;
  log.debug('DISPATCHER', 'dispatchMessage scaffold (Task 3) — not yet wired');
  throw new DispatcherFailure('dispatchMessage is not wired yet (Plan 028 Task 3 scaffold)');
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. The module is self-contained — it only imports from `ai/provider.js` (existing) and `debug/logger.js` (existing).

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS. The scaffold is not called from anywhere, so it has no runtime impact.

- [ ] **Step 4: Commit**

```bash
git add src/agents/dispatcher.ts
git commit -m "Plan 028: scaffold dispatcher agent module with types + stub"
```

---

### Task 4: Implement `dispatchMessage` — prompt building, LLM call, parsing, retry

**Rationale:** The scaffold from Task 3 defined every type; this task writes the actual prompt, the LLM call, and the output parser. The prompt is the load-bearing design artifact of Plan C — the dispatcher's decision quality is bounded by how well it describes the catalog and how compactly it presents context. Compare to `plan-reproposer.ts:170–237` (re-proposer system prompt) and `plan-proposer.ts` for the prevailing style: inline string template, `## SECTION` headers, explicit JSON schema in the prompt, examples of canonical phrasings.

**Files:**
- Modify: `src/agents/dispatcher.ts` (replace the `dispatchMessage` scaffold body and add helpers)

- [ ] **Step 1: Add the system-prompt builder**

In `src/agents/dispatcher.ts`, add the following helper **above** `dispatchMessage`:

```typescript
// ─── Prompt building ─────────────────────────────────────────────────────────

/**
 * System prompt — stable across every call. Describes the full proposal 003
 * catalog (including deferred actions) but marks each one with its v0.0.5
 * availability. Keeping deferred entries in the prompt is deliberate: it
 * gives the LLM the full mental model of the product's intended vocabulary
 * so it can clarify honestly when a user asks for something that isn't built
 * yet ("I want to log a Snickers" → `clarify` with an honest "coming later"
 * response, not a confused flow_input).
 */
function buildSystemPrompt(): string {
  return `You are Flexie's conversation dispatcher. Every inbound user message is routed through you. You read the user's message plus a context bundle (surface, active flow, recent turns, plan summary, recipe library) and pick exactly ONE action from a catalog. You output a JSON object with the action, its parameters, and (for inline-answer actions) the user-visible response text.

Flexie is a flexible-diet meal planning bot. Your job is to classify intent accurately, preserve in-progress flow work, and decline honestly when a request is outside the product's current scope.

## OUTPUT SHAPE

You MUST return a single JSON object with exactly these fields:

{
  "action": string,          // one of the action names listed below
  "params": object,          // action-specific parameters (may be empty: {})
  "response": string | null, // user-visible reply for inline-answer actions; null otherwise
  "reasoning": string        // brief explanation, never shown to the user
}

Do not wrap the JSON in markdown. Do not add text before or after. Return JSON only.

## ACTION CATALOG

Each action has a v0.0.5 availability marker. If you would otherwise pick an action marked NOT AVAILABLE, pick "clarify" or "out_of_scope" with an honest message about the capability not being built yet.

### flow_input  (AVAILABLE)
The user's text is input the active flow expects: an event description during plan_awaiting_events, a mutation request during plan_proposal, a preference description during recipe_awaiting_preferences, a refinement request during recipe_awaiting_refinement, or a question during recipe_reviewing.
Params: {} (empty)
Response: null
When to pick: the active flow is in a text-accepting phase AND the user's message is structurally what that phase expects.
When NOT to pick: no active flow; or the user is clearly asking a side question that does not advance the flow; or the user is cancelling / returning to a prior view.

### clarify  (AVAILABLE)
You cannot confidently pick one action. Ask the user a clarifying question. Leave all state unchanged — the next message will be dispatched fresh with your question in the recent-turns history.
Params: {} (empty)
Response: the clarifying question text (required, user-visible)
When to pick: truly ambiguous phrasings, missing anchors ("earlier"), requests that could mean multiple catalog entries, or capabilities not yet built in v0.0.5 ("log my Snickers" → clarify with honest deferral).
When NOT to pick: obvious in-domain requests with enough context to act.

### out_of_scope  (AVAILABLE)
The user's message is outside Flexie's domain — weather, stock prices, general chit-chat, live web data, unrelated small talk. Decline honestly, briefly, and offer the menu.
Params: { "category": optional short label for the topic, e.g., "weather" }
Response: a short, specific decline (required, user-visible). Template: "I help with meal planning, recipes, and nutrition — not {category}. Try: 'change Thursday dinner' or tap a button."
When to pick: the message is clearly not about meal planning, recipes, nutrition, cooking, shopping for groceries, or the user's weight/measurements.
When NOT to pick: food / nutrition / plan / recipe / shopping / measurement questions, even if the exact capability isn't built (use clarify for those).

### return_to_flow  (AVAILABLE)
Natural-language back button. The user typed a phrase like "ok back to the plan", "let's continue planning", "resume planning", "keep going", "back to my recipes", "show me the plan again". Your handler will re-render the user's last view (active flow's last rendered screen, or the navigation view captured in lastRenderedView).
Params: {} (empty)
Response: null (the handler renders the previous view, no new text needed)
When to pick: short phrases expressing "go back" intent AND there is something to go back to (active flow OR recent lastRenderedView).
When NOT to pick: phrases matching the cancel set — "never mind", "forget it", "not now", "stop", "i'll do this later", "cancel". Those phrases route through the planning flow's cancel handler BEFORE this dispatcher runs; you will never see them when a planning flow is active. If you see "nevermind" without an active flow, prefer out_of_scope over return_to_flow (there is nothing to cancel and nothing meaningful to return to).

### mutate_plan  (NOT AVAILABLE in v0.0.5 — Plan D)
Future: user describes a change to their plan ("move the flex to Sunday", "swap tagine for fish", "I'm eating out tonight"). For v0.0.5 during an active planning proposal phase, pick flow_input — the existing re-proposer path handles mutations. For post-confirmation mutations (no active flow), pick clarify with an honest "post-confirmation plan changes aren't available yet — that ships next" response.

### answer_plan_question  (NOT AVAILABLE in v0.0.5 — Plan E)
### answer_recipe_question  (NOT AVAILABLE in v0.0.5 — Plan E)
### answer_domain_question  (NOT AVAILABLE in v0.0.5 — Plan E)
Future: questions about the plan ("when's my next cook day?"), recipes ("can I freeze the tagine?"), or food/nutrition ("what's a substitute for tahini?"). For v0.0.5, pick clarify with an honest deferral: "answering questions isn't built yet — that's coming next. Want me to show you the plan / your recipes?"

### show_recipe  (NOT AVAILABLE in v0.0.5 — Plan E)
### show_plan  (NOT AVAILABLE in v0.0.5 — Plan E)
### show_shopping_list  (NOT AVAILABLE in v0.0.5 — Plan E)
### show_progress  (NOT AVAILABLE in v0.0.5 — Plan E)
Future: render a specific view by name. For v0.0.5, pick out_of_scope with a short hint pointing at the reply-keyboard buttons: "navigating by name isn't built yet — tap 📋 My Plan / 📖 My Recipes / 🛒 Shopping List / 📊 Progress to jump there."

### log_measurement  (NOT AVAILABLE in v0.0.5 — Plan E)
Future: parse weight/waist from any surface. For v0.0.5, if the user is NOT in the progress measurement phase, pick clarify with "I can only log measurements when you tap 📊 Progress first."
(Note: when the progress flow IS in awaiting_measurement phase and the user sent well-formed numeric input like "82.3", the runner's numeric pre-filter handles it BEFORE you run — you will never see such messages.)

### log_eating_out  (DEFERRED — proposal commitment, no implementation in v0.0.5)
### log_treat  (DEFERRED — proposal commitment, no implementation in v0.0.5)
Future: record restaurant meals / treats. For v0.0.5, pick clarify with honest deferral.

## STATE PRESERVATION — LOAD-BEARING RULES

1. You never clear planFlow or recipeFlow. Your decision is a classification, not a mutation. The runner enforces this.
2. flow_input during an active flow routes back into that flow — it does NOT start a new flow. Never pick flow_input when there is no active flow.
3. When the active flow has a pendingClarification (a sub-agent is waiting for an answer), and the user's text looks like that answer, pick flow_input so the flow consumes it. If the user's text is clearly a side question instead, pick the appropriate side action — the pendingClarification stays preserved for a later turn.
4. recent turns give you referential threads. "What about the lamb?" after "can I freeze the tagine?" is a follow-up question, not an ambiguous orphan.

## FEW-SHOT EXAMPLES

(Active flow: plan / phase: proposal)
User: "Put the flex meal on Sunday instead"
→ { "action": "flow_input", "params": {}, "response": null, "reasoning": "Mutation request during proposal phase — route to re-proposer via flow_input." }

(Active flow: plan / phase: proposal)
User: "why so much pasta this week?"
→ { "action": "clarify", "params": {}, "response": "I can't answer plan questions yet — that's coming soon. Want to keep reviewing the plan, or make a change?", "reasoning": "Side question during proposal; answer actions not available in v0.0.5; clarify honestly without losing the proposal." }

(Active flow: none / lifecycle: active_mid)
User: "ok back to the plan"
→ { "action": "return_to_flow", "params": {}, "response": null, "reasoning": "Natural-language back command with recent plan view in lastRenderedView." }

(Active flow: none / lifecycle: active_mid)
User: "what's the weather today?"
→ { "action": "out_of_scope", "params": { "category": "weather" }, "response": "I help with meal planning, recipes, and nutrition — not weather. Try: 'change Thursday dinner' or tap a button.", "reasoning": "Clearly out-of-domain request." }

(Active flow: none / lifecycle: no_plan)
User: "hmm"
→ { "action": "clarify", "params": {}, "response": "What would you like to do? I can help you plan a week of meals, browse your recipes, or log a measurement.", "reasoning": "Too short to classify; no active flow and no clear intent." }

(Active flow: plan / phase: awaiting_events, pendingClarification: null)
User: "dinner out with friends on Friday"
→ { "action": "flow_input", "params": {}, "response": null, "reasoning": "Event description during awaiting_events — forward to event handler." }

(Active flow: plan / phase: awaiting_events)
User: "is the breakfast locked?"
→ { "action": "clarify", "params": {}, "response": "I can't answer plan questions yet — that's coming soon. Want to keep adding events, or tap Done when you're ready?", "reasoning": "Side question during awaiting_events; answer actions not in v0.0.5." }

Return only the JSON object. No prose.`;
}
```

- [ ] **Step 2: Add the user-prompt builder**

Add this helper **below** `buildSystemPrompt` and **above** `dispatchMessage`:

```typescript
/**
 * Builds the per-call user prompt carrying the full context bundle plus the
 * user's current message. The ordering is: date → surface + lifecycle →
 * active flow → recent turns → plan summary → recipe index → allowed
 * actions → user message. Placing the user message LAST is deliberate: it
 * anchors the model's attention on what to classify while the earlier
 * sections establish the frame.
 *
 * Recipe index is formatted as one line per recipe, compact enough that 50
 * recipes fit in under 400 tokens. Plan summary reuses the pre-formatted
 * lines the runner built.
 */
function buildUserPrompt(ctx: DispatcherContext, userText: string): string {
  const parts: string[] = [];

  parts.push(`## TODAY\n${ctx.today}  (server-local; assume single-user.)`);

  parts.push(
    `## SURFACE\nsurfaceContext: ${ctx.surface ?? 'none'}\nlifecycle: ${ctx.lifecycle}\nlastRenderedView: ${
      ctx.lastRenderedView ? JSON.stringify(ctx.lastRenderedView) : 'none'
    }`,
  );

  parts.push(`## ACTIVE FLOW\n${formatActiveFlow(ctx.activeFlow)}`);

  parts.push(
    `## RECENT TURNS (oldest first)\n${
      ctx.recentTurns.length === 0
        ? '(no prior turns)'
        : ctx.recentTurns
            .map((t) => `[${t.role}] ${t.text.slice(0, 300)}`)
            .join('\n')
    }`,
  );

  parts.push(`## PLAN SUMMARY\n${formatPlanSummary(ctx.planSummary)}`);

  parts.push(
    `## RECIPE LIBRARY (${ctx.recipeIndex.length} recipes)\n${
      ctx.recipeIndex.length === 0
        ? '(no recipes yet)'
        : ctx.recipeIndex.map(formatRecipeRow).join('\n')
    }`,
  );

  parts.push(
    `## ALLOWED ACTIONS\n${ctx.allowedActions.join(', ')}\n(If you would pick a NOT AVAILABLE action, choose clarify or out_of_scope instead with an honest deferral.)`,
  );

  parts.push(`## USER MESSAGE\n${userText}`);

  return parts.join('\n\n');
}

function formatActiveFlow(flow: ActiveFlowSummary): string {
  switch (flow.kind) {
    case 'none':
      return 'none';
    case 'plan': {
      const parts = [`plan / phase=${flow.phase}`];
      if (flow.horizonStart && flow.horizonEnd) {
        parts.push(`horizon=${flow.horizonStart}..${flow.horizonEnd}`);
      }
      if (flow.pendingClarification) {
        parts.push(
          `pendingClarification: ${flow.pendingClarification.question} (original: ${flow.pendingClarification.originalMessage})`,
        );
      }
      return parts.join(' / ');
    }
    case 'recipe':
      return `recipe / phase=${flow.phase}`;
    case 'progress':
      return `progress / phase=${flow.phase}`;
  }
}

function formatPlanSummary(plan: DispatcherPlanSummary | null): string {
  if (!plan) return '(no active plan)';
  const lines = [
    `horizon: ${plan.horizonStart}..${plan.horizonEnd}`,
    `weekly target: ${plan.weeklyCalorieTarget} kcal / ${plan.weeklyProteinTarget}g protein`,
    `batches:`,
    ...(plan.batchLines.length ? plan.batchLines.map((l) => `  - ${l}`) : ['  (none)']),
    `flex slots:`,
    ...(plan.flexLines.length ? plan.flexLines.map((l) => `  - ${l}`) : ['  (none)']),
    `events:`,
    ...(plan.eventLines.length ? plan.eventLines.map((l) => `  - ${l}`) : ['  (none)']),
  ];
  return lines.join('\n');
}

function formatRecipeRow(r: DispatcherRecipeRow): string {
  return `${r.slug} | ${r.name} | ${r.cuisine} | ${r.mealTypes.join('/')} | ${r.calories}kcal ${r.protein}gP | fridge=${r.fridgeDays}d freezable=${r.freezable} | reheat: ${r.reheat.slice(0, 50)}`;
}
```

- [ ] **Step 3: Add the parser**

Add this helper **below** `formatRecipeRow` and **above** `dispatchMessage`:

```typescript
// ─── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parses the raw LLM response into a `DispatcherDecision` and validates:
 *
 *   1. The top-level shape has `action`, `params`, `reasoning`.
 *   2. The action is a known member of `DispatcherAction`.
 *   3. The action is in `allowedActions` (v0.0.5 minimal set).
 *   4. Inline-answer actions (clarify, out_of_scope) have a non-empty
 *      `response` string.
 *   5. flow_input and return_to_flow have `response === null` (or absent,
 *      which we treat as null).
 *
 * Throws on any failure so the retry loop can feed the error back into
 * the LLM conversation.
 */
function parseDecision(
  raw: string,
  allowedActions: readonly DispatcherAction[],
): DispatcherDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Dispatcher response was not valid JSON: ${(err as Error).message}. Response body: ${raw.slice(0, 500)}`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Dispatcher response must be a JSON object.');
  }
  const obj = parsed as Record<string, unknown>;

  const action = obj.action;
  if (typeof action !== 'string') {
    throw new Error('Dispatcher response missing string "action" field.');
  }

  const knownActions: readonly DispatcherAction[] = [
    'flow_input',
    'clarify',
    'out_of_scope',
    'return_to_flow',
  ];
  if (!knownActions.includes(action as DispatcherAction)) {
    throw new Error(
      `Dispatcher picked unknown action "${action}". Must be one of: ${knownActions.join(', ')}.`,
    );
  }

  if (!allowedActions.includes(action as DispatcherAction)) {
    throw new Error(
      `Dispatcher picked disallowed action "${action}" — not in current allowedActions [${allowedActions.join(', ')}]. Choose from the allowed list.`,
    );
  }

  const params = (obj.params ?? {}) as Record<string, unknown>;
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new Error('Dispatcher response "params" must be an object.');
  }

  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : '';

  const rawResponse = obj.response;
  const response =
    typeof rawResponse === 'string'
      ? rawResponse
      : rawResponse === null || rawResponse === undefined
        ? undefined
        : (() => {
            throw new Error('Dispatcher response "response" field must be a string or null.');
          })();

  // Per-action validation.
  switch (action) {
    case 'flow_input':
      if (response !== undefined && response !== '') {
        throw new Error('flow_input must have response: null (the flow handler authors the reply).');
      }
      return { action: 'flow_input', params: {}, reasoning };

    case 'clarify':
      if (!response) {
        throw new Error('clarify requires a non-empty "response" string (the clarifying question).');
      }
      return { action: 'clarify', params: {}, response, reasoning };

    case 'out_of_scope': {
      if (!response) {
        throw new Error('out_of_scope requires a non-empty "response" string (the decline message).');
      }
      const category = typeof params.category === 'string' ? params.category : undefined;
      return {
        action: 'out_of_scope',
        params: category ? { category } : {},
        response,
        reasoning,
      };
    }

    case 'return_to_flow':
      if (response !== undefined && response !== '') {
        throw new Error('return_to_flow must have response: null (the handler re-renders the last view).');
      }
      return { action: 'return_to_flow', params: {}, reasoning };
  }
}
```

- [ ] **Step 4: Replace the `dispatchMessage` scaffold with the real implementation**

Replace the scaffold body of `dispatchMessage`:

```typescript
export async function dispatchMessage(
  context: DispatcherContext,
  userText: string,
  llm: LLMProvider,
): Promise<DispatcherDecision> {
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(context, userText);

  log.debug(
    'DISPATCHER',
    `dispatch request: surface=${context.surface ?? 'none'} lifecycle=${context.lifecycle} activeFlow=${context.activeFlow.kind} turns=${context.recentTurns.length} recipes=${context.recipeIndex.length} user="${userText.slice(0, 80)}"`,
  );

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: userPrompt },
  ];

  const firstResult = await llm.complete({
    model: 'mini',
    reasoning: 'high',
    json: true,
    context: 'dispatcher',
    messages,
  });

  try {
    const decision = parseDecision(firstResult.content, context.allowedActions);
    log.debug(
      'DISPATCHER',
      `decision (first pass): action=${decision.action} reasoning="${decision.reasoning.slice(0, 120)}"`,
    );
    return decision;
  } catch (firstErr) {
    log.warn(
      'DISPATCHER',
      `first-pass parse/validate failed: ${(firstErr as Error).message.slice(0, 200)}. Retrying.`,
    );

    // Feed the error back into a retry conversation so the LLM can correct itself.
    const retryMessages = [
      ...messages,
      { role: 'assistant' as const, content: firstResult.content },
      {
        role: 'user' as const,
        content: `Your previous response was rejected: ${(firstErr as Error).message}\n\nReturn a corrected JSON object following the output shape and the allowed-actions constraint.`,
      },
    ];

    const retryResult = await llm.complete({
      model: 'mini',
      reasoning: 'high',
      json: true,
      context: 'dispatcher-retry',
      messages: retryMessages,
    });

    try {
      const decision = parseDecision(retryResult.content, context.allowedActions);
      log.debug(
        'DISPATCHER',
        `decision (retry): action=${decision.action} reasoning="${decision.reasoning.slice(0, 120)}"`,
      );
      return decision;
    } catch (retryErr) {
      log.error(
        'DISPATCHER',
        `retry also failed: ${(retryErr as Error).message.slice(0, 200)}`,
      );
      throw new DispatcherFailure(
        `Dispatcher failed twice. First error: ${(firstErr as Error).message}. Retry error: ${(retryErr as Error).message}`,
        retryErr,
      );
    }
  }
}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: PASS. `dispatchMessage` is not yet called from any runtime path; only the unit test in Task 5 will exercise it.

- [ ] **Step 7: Commit**

```bash
git add src/agents/dispatcher.ts
git commit -m "Plan 028: implement dispatcher prompt building + parser + retry"
```

---

### Task 5: Unit tests for the dispatcher agent

**Files:**
- Create: `test/unit/dispatcher-agent.test.ts`

- [ ] **Step 1: Write the tests**

Create `test/unit/dispatcher-agent.test.ts` with:

```typescript
/**
 * Unit tests for the pure dispatcher agent — Plan 028.
 *
 * Exercises dispatchMessage against a FakeLLMProvider that returns
 * pre-canned JSON responses. Covers happy path per action, parse failure
 * with successful retry, parse failure with failed retry (DispatcherFailure),
 * disallowed-action rejection with successful retry, and the per-action
 * response-field validation rules.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  dispatchMessage,
  DispatcherFailure,
  AVAILABLE_ACTIONS_V0_0_5,
  type DispatcherContext,
  type DispatcherDecision,
} from '../../src/agents/dispatcher.js';
import type {
  LLMProvider,
  CompletionOptions,
  CompletionResult,
} from '../../src/ai/provider.js';

/**
 * Minimal stub provider — returns a pre-queued list of responses in order.
 * Each entry corresponds to one `complete` call. If the queue runs out, the
 * stub throws.
 */
function stubLLM(responses: string[]): LLMProvider {
  const queue = [...responses];
  return {
    async complete(_: CompletionOptions): Promise<CompletionResult> {
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('stubLLM: unexpected additional complete() call');
      }
      return { content: next, usage: { inputTokens: 0, outputTokens: 0 } };
    },
    async transcribe(): Promise<string> {
      throw new Error('stubLLM: transcribe not supported in dispatcher tests');
    },
  };
}

function baseContext(overrides: Partial<DispatcherContext> = {}): DispatcherContext {
  return {
    today: '2026-04-10',
    now: '2026-04-10T12:00:00.000Z',
    surface: null,
    lifecycle: 'no_plan',
    activeFlow: { kind: 'none' },
    recentTurns: [],
    planSummary: null,
    recipeIndex: [],
    allowedActions: AVAILABLE_ACTIONS_V0_0_5,
    ...overrides,
  };
}

test('dispatchMessage: flow_input happy path', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'flow_input',
      params: {},
      response: null,
      reasoning: 'Event text during awaiting_events.',
    }),
  ]);
  const decision = await dispatchMessage(
    baseContext({
      activeFlow: { kind: 'plan', phase: 'awaiting_events' },
      lifecycle: 'planning',
    }),
    'dinner out on Friday',
    llm,
  );
  assert.equal(decision.action, 'flow_input');
  assert.deepStrictEqual(decision.params, {});
  assert.equal(decision.response, undefined);
  assert.match(decision.reasoning, /Event text/);
});

test('dispatchMessage: clarify happy path with response string', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'clarify',
      params: {},
      response: 'Do you mean lunch or dinner?',
      reasoning: 'Meal time ambiguous.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'I went to the Indian place', llm);
  assert.equal(decision.action, 'clarify');
  assert.equal(
    (decision as Extract<DispatcherDecision, { action: 'clarify' }>).response,
    'Do you mean lunch or dinner?',
  );
});

test('dispatchMessage: out_of_scope carries category and response', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'out_of_scope',
      params: { category: 'weather' },
      response: "I help with meal planning, recipes, and nutrition — not weather.",
      reasoning: 'Clearly out of domain.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), "what's the weather today?", llm);
  assert.equal(decision.action, 'out_of_scope');
  const dec = decision as Extract<DispatcherDecision, { action: 'out_of_scope' }>;
  assert.equal(dec.params.category, 'weather');
  assert.match(dec.response, /not weather/);
});

test('dispatchMessage: return_to_flow happy path with null response', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'return_to_flow',
      params: {},
      response: null,
      reasoning: 'User wants to resume planning.',
    }),
  ]);
  const decision = await dispatchMessage(
    baseContext({
      activeFlow: { kind: 'plan', phase: 'proposal' },
      lifecycle: 'planning',
    }),
    'ok back to the plan',
    llm,
  );
  assert.equal(decision.action, 'return_to_flow');
});

test('dispatchMessage: first-pass JSON parse error → retries and succeeds', async () => {
  const llm = stubLLM([
    'not json at all',
    JSON.stringify({
      action: 'out_of_scope',
      params: {},
      response: 'I help with meal planning only.',
      reasoning: 'Out of domain (after retry).',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'xyz', llm);
  assert.equal(decision.action, 'out_of_scope');
});

test('dispatchMessage: first-pass disallowed action → retries and succeeds', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'mutate_plan',
      params: { request: 'move flex' },
      response: null,
      reasoning: 'User wants mutation (but mutate_plan is not allowed in v0.0.5).',
    }),
    JSON.stringify({
      action: 'clarify',
      params: {},
      response: 'Plan changes after confirmation are coming soon.',
      reasoning: 'Honest deferral.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'move my flex', llm);
  assert.equal(decision.action, 'clarify');
});

test('dispatchMessage: clarify without response field → retry → succeeds', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'clarify',
      params: {},
      response: null,
      reasoning: 'No question authored (invalid).',
    }),
    JSON.stringify({
      action: 'clarify',
      params: {},
      response: 'What would you like to do?',
      reasoning: 'Corrected.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'hmm', llm);
  assert.equal(decision.action, 'clarify');
});

test('dispatchMessage: both attempts fail → DispatcherFailure', async () => {
  const llm = stubLLM(['total garbage', '{"action":"nonsense"}']);
  await assert.rejects(
    () => dispatchMessage(baseContext(), 'x', llm),
    (err) => err instanceof DispatcherFailure,
  );
});

test('dispatchMessage: flow_input with non-null response is rejected', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'flow_input',
      params: {},
      response: 'This should not be here.',
      reasoning: 'Invalid.',
    }),
    JSON.stringify({
      action: 'flow_input',
      params: {},
      response: null,
      reasoning: 'Corrected.',
    }),
  ]);
  const decision = await dispatchMessage(
    baseContext({
      activeFlow: { kind: 'plan', phase: 'awaiting_events' },
    }),
    'dinner Friday',
    llm,
  );
  assert.equal(decision.action, 'flow_input');
});
```

- [ ] **Step 2: Typecheck + test**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test`
Expected: PASS. +9 new unit tests.

- [ ] **Step 3: Commit**

```bash
git add test/unit/dispatcher-agent.test.ts
git commit -m "Plan 028: unit tests for dispatcher agent happy paths + retry"
```

---

### Task 6: Rename `handleTextInput` → `routeTextToActiveFlow` and trim dispatcher-owned branches

**Rationale:** The existing `handleTextInput` does three jobs: (a) runs the numeric measurement pre-filter, (b) routes to active flow text handlers, (c) falls back to recipe name match + generic fallback. After Plan C, jobs (a) and (c) move to the runner. What's left is a pure active-flow router — rename it to reflect the new responsibility and make it cheap to grep for.

Performing the rename BEFORE wiring in the dispatcher is deliberate: it keeps this task small and mechanical, and the next tasks can reference the renamed function unambiguously.

**Files:**
- Modify: `src/telegram/core.ts`

- [ ] **Step 1: Read the current `handleTextInput` end-to-end**

Open `src/telegram/core.ts` and locate `handleTextInput` (Grep for `async function handleTextInput`). Read the function in full. Note the exact current line ranges for:
- The `session.progressFlow && phase === 'awaiting_measurement'` block (the big one with numeric parsing + disambiguation).
- The `session.progressFlow && phase === 'confirming_disambiguation'` block (the one-line "Use the buttons above" reply).
- The `session.recipeFlow` branch (lands at `handlePreferencesAndGenerate`, etc.).
- The `session.planFlow` branch (meta-intent matcher + phase handlers + fallback).
- The "Not in a flow — recipe name match" branch.
- The final `await replyFreeTextFallback(sink);` line.

Write down the actual line numbers before editing — the task below uses "~line N" but the real numbers may have drifted.

- [ ] **Step 2: Remove the `awaiting_measurement` branch**

Inside the function, delete the entire `if (session.progressFlow.phase === 'awaiting_measurement') { … }` block. Keep the `if (session.progressFlow)` wrapper and the `confirming_disambiguation` branch inside it. The function now starts as:

```typescript
async function routeTextToActiveFlow(text: string, sink: OutputSink): Promise<void> {
  // Progress flow — only the disambiguation fallthrough remains. The numeric
  // pre-filter in dispatcher-runner handles awaiting_measurement before
  // control reaches this function.
  if (session.progressFlow && session.progressFlow.phase === 'confirming_disambiguation') {
    await sink.reply('Use the buttons above to confirm.');
    return;
  }

  // Recipe flow checked first: when both planFlow and recipeFlow are active
  // (user started recipe creation during a planning side trip), text must
  // reach recipeFlow. planFlow's non-text phases would silently swallow it.
  if (session.recipeFlow) {
    // … (unchanged)
```

- [ ] **Step 3: Remove the recipe-name fuzzy match**

At the bottom of the function, delete the entire `// Not in a flow — check if they want to view a specific recipe` block:

```typescript
  // Not in a flow — check if they want to view a specific recipe
  const recipe = recipes
    .getAll()
    .find(
      (r) =>
        r.name.toLowerCase().includes(text.toLowerCase()) ||
        r.slug.includes(text.toLowerCase()),
    );
  if (recipe) {
    log.debug('FLOW', `recipe lookup: "${text}" → ${recipe.slug}`);
    await sink.reply(renderRecipe(recipe), { parse_mode: 'MarkdownV2' });
    return;
  }
```

This branch was a stand-in for the `show_recipe` action that Plan E will implement. Removing it during Plan C leaves a gap: typing a recipe name without an active flow now reaches `flow_input` (which the dispatcher won't pick because no flow is active) or falls through to `out_of_scope` via the dispatcher. That's a temporary regression explicitly accepted in proposal 003's Plan C scope note ("No plan mutations yet, no Q&A, no navigation by name"). Plan E restores this capability as a first-class catalog action with library/batch resolution.

- [ ] **Step 4: Remove the final `replyFreeTextFallback` call**

Delete the final line of the function:

```typescript
  await replyFreeTextFallback(sink);
```

The function now ends after the `session.planFlow` branch. The runner's dispatcher-failure catch block calls `replyFreeTextFallback` as the last-resort recovery path. Within `routeTextToActiveFlow`, reaching the end of the function means the dispatcher picked `flow_input` but no flow was actually active — a dispatcher bug that should be loud.

Add a final defensive log line BEFORE the implicit return:

```typescript
  // If we reach here, the dispatcher picked flow_input but no flow is active.
  // This is a classification error in the dispatcher. The runner logs and
  // falls back, so this path should be unreachable in normal operation.
  log.warn(
    'FLOW',
    'routeTextToActiveFlow reached end with no active flow — dispatcher classification error',
  );
  await replyFreeTextFallback(sink);
}
```

The `replyFreeTextFallback` call stays as a defensive fallback for the unreachable case. Keeping it in place of a throw makes the failure mode graceful for users while still logging loudly for the developer.

- [ ] **Step 5: Rename the function**

Change the function's declaration from `async function handleTextInput` to `async function routeTextToActiveFlow`. Do not touch the callers yet — they live inside `dispatch()` and will be updated in Task 11 when the runner wires in.

**Temporary state:** the `dispatch()` function still calls `handleTextInput` (which no longer exists). TypeScript will fail compilation. To keep the tree buildable through Task 7, add a temporary aliasing line OUTSIDE any function body but WITHIN the `createBotCore` closure, right above `dispatch()`:

```typescript
  // Plan 028 Task 6 transitional: `dispatch()` still references the old
  // name `handleTextInput` until Task 11 rewires it through the dispatcher
  // runner. This alias keeps TypeScript happy without touching call sites.
  // Delete in Task 11.
  const handleTextInput = routeTextToActiveFlow;
```

**If you'd rather not carry a transitional alias**, directly update the two `handleTextInput(...)` call sites in `dispatch()` (one in the `voice` case, one at the bottom of the `text` case) to `routeTextToActiveFlow(...)` in this same commit. Either approach works; pick one and note it in the commit message.

- [ ] **Step 6: Verify the function no longer has a numeric branch or recipe fuzzy match**

Use Grep inside `src/telegram/core.ts`:

- `parseMeasurementInput` — should no longer appear inside `routeTextToActiveFlow`. It may still appear in the imports block (the runner will need it in Task 8).
- `awaiting_measurement` — should no longer appear inside `routeTextToActiveFlow`.
- `recipes.getAll().find` — should no longer appear in the function.

The imports of `parseMeasurementInput`, `assignWeightWaist`, `formatDisambiguationPrompt` can stay — they'll be used by the runner via Task 8.

- [ ] **Step 7: Typecheck + test**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test`
Expected: existing scenarios that only exercise button taps stay green. Existing scenarios that exercised the `awaiting_measurement` numeric path, the recipe-name fuzzy match, or hit the bottom fallback **will fail** because the relevant code paths no longer exist in `routeTextToActiveFlow`.

Expected failures:
- `017-free-text-fallback` — fails at "xyz random text 123" (no more recipe-name match nor bottom fallback in the renamed function — the `replyFreeTextFallback` is now only reached via the dispatcher error path, which isn't wired yet). For Task 6, this is expected red — do NOT regenerate. Task 13 regenerates after the runner is wired.
- Any progress scenario that exercises `awaiting_measurement` → numeric input → confirmation. The scenarios hit `confirming_disambiguation` paths (scenario 015 / 016) are unaffected; scenarios that type a number into `awaiting_measurement` will fail.

Count the failures. If more than 8 scenarios fail, investigate — the renaming may have broken something beyond the two trimmed branches.

- [ ] **Step 8: Commit (tree intentionally red)**

```bash
git add src/telegram/core.ts
git commit -m "Plan 028: rename handleTextInput → routeTextToActiveFlow, trim pre-filter and fuzzy branches

Intentional-red commit. The numeric awaiting_measurement branch moves to
the dispatcher runner's pre-filter (Task 8). The recipe-name fuzzy match
is removed; Plan E's show_recipe action replaces it. The generic fallback
is removed; the dispatcher-failure catch in the runner replaces it.

Affected scenarios regenerate in Task 13 after Task 11 wires the dispatcher
in as the front door."
```

---

### Task 7: Unit-test the dispatcher context assembly (shell)

**Rationale:** Task 8 builds the full `buildDispatcherContext` function, which reads from `session`, `store`, and `recipes` and assembles a compact bundle. Before writing the function, it's worth locking in a unit-test file scaffold so the tests are authored alongside the implementation. This task creates the test file with a single sanity test that imports from `dispatcher-runner.ts` — it fails to compile until Task 8 adds the export, which is fine (the test is committed red and fixed in Task 8).

**Files:**
- Create: `test/unit/dispatcher-context.test.ts`

- [ ] **Step 1: Create the test file scaffold**

Create `test/unit/dispatcher-context.test.ts` with:

```typescript
/**
 * Unit tests for buildDispatcherContext — Plan 028.
 *
 * Feeds hand-constructed session/store/recipes slices into the context
 * builder and asserts the resulting DispatcherContext has the correct
 * lifecycle, active-flow summary, plan summary, recipe index, and
 * allowed-actions set.
 *
 * Task 7 creates the file with a single placeholder test. Task 8 fills in
 * the real assertions once `buildDispatcherContext` is exported.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

test('placeholder: dispatcher-context tests land in Task 8', () => {
  assert.ok(true);
});
```

- [ ] **Step 2: Run the placeholder test**

Run: `npm test`
Expected: the single placeholder test passes. Other scenarios remain red from Task 6.

- [ ] **Step 3: Commit**

```bash
git add test/unit/dispatcher-context.test.ts
git commit -m "Plan 028: dispatcher-context unit test scaffold"
```

---

### Task 8: Implement `buildDispatcherContext` + runner scaffolding

**Rationale:** This task fills in the context-bundle builder and the runner's top-level entry point. The context builder is pure and can be exercised against plain objects; the runner entry point is stubbed until the action handlers land in Task 9. Separating the two keeps each task focused.

**Files:**
- Modify: `src/telegram/dispatcher-runner.ts` — add context builder, runner stub, `tryNumericPreFilter`.
- Modify: `test/unit/dispatcher-context.test.ts` — replace placeholder with real tests.

- [ ] **Step 1: Add imports at the top of `dispatcher-runner.ts`**

Replace the current imports block at the top of `src/telegram/dispatcher-runner.ts` (which so far has only the module doc comment) with:

```typescript
import { config } from '../config.js';
import { log } from '../debug/logger.js';
import type { LLMProvider } from '../ai/provider.js';
import type { RecipeDatabase } from '../recipes/database.js';
import type { StateStoreLike } from '../state/store.js';
import type { BatchView, Recipe } from '../models/types.js';
import {
  getPlanLifecycle,
  getVisiblePlanSession,
  toLocalISODate,
} from '../plan/helpers.js';
import {
  parseMeasurementInput,
  assignWeightWaist,
  formatDisambiguationPrompt,
} from '../agents/progress-flow.js';
import {
  formatMeasurementConfirmation,
} from './formatters.js';
import {
  dispatchMessage,
  DispatcherFailure,
  AVAILABLE_ACTIONS_V0_0_5,
  type DispatcherContext,
  type DispatcherDecision,
  type DispatcherRecipeRow,
  type DispatcherPlanSummary,
  type DispatcherTurn,
  type ActiveFlowSummary,
} from '../agents/dispatcher.js';
import { progressDisambiguationKeyboard, progressReportKeyboard } from './keyboards.js';
```

Note: importing `getPlanLifecycle` needs a type that matches its signature. `getPlanLifecycle` takes `(session, store, today)`. Our runner receives the core session; we pass it through.

Also add these at the bottom of the existing block (if not already present):

```typescript
import type { OutputSink } from './core.js';
```

**Circular-import concern:** importing from `./core.js` may create a cycle (`core.ts` imports from `dispatcher-runner.ts`, which imports `OutputSink` from `core.ts`). To avoid it, move the `OutputSink` interface definition into a new leaf file `src/telegram/output-sink.ts` with only the interface, and update `core.ts` to re-export it. **Alternative**: declare a structurally-equivalent `OutputSink` type locally inside `dispatcher-runner.ts` using the same interface shape. Pick the local-structural-copy approach for Task 8 to keep the task boundary tight:

```typescript
/**
 * Structural OutputSink — mirrors `BotCore`'s OutputSink interface. Declared
 * locally to avoid a circular import (core.ts imports from this module).
 * TypeScript's structural typing makes this compatible with the real
 * OutputSink at call sites. A future cleanup can hoist the interface into
 * `src/telegram/output-sink.ts` and have both files re-import it.
 */
export interface DispatcherOutputSink {
  reply(
    text: string,
    options?: {
      reply_markup?: import('grammy').Keyboard | import('grammy').InlineKeyboard;
      parse_mode?: 'Markdown' | 'MarkdownV2' | 'HTML';
    },
  ): Promise<void>;
  answerCallback(): Promise<void>;
  startTyping(): () => void;
}
```

Use `DispatcherOutputSink` as the sink type throughout this file. At call sites from `core.ts`, the real `OutputSink` structurally conforms.

- [ ] **Step 2: Add the session-shape import**

The runner needs to read from `BotCoreSession` without importing its full type from `core.ts` (circular). Declare a minimal structural session slice at the top of `dispatcher-runner.ts`:

```typescript
/**
 * Structural slice of `BotCoreSession` that the runner reads and mutates.
 * Declared here to avoid a circular import with `core.ts`. The real
 * `BotCoreSession` conforms structurally at call sites.
 */
export interface DispatcherSession {
  recipeFlow: { phase: string } | null;
  planFlow:
    | {
        phase: string;
        horizonStart?: string;
        horizonDays?: string[];
        pendingClarification?: { question: string; originalMessage: string };
      }
    | null;
  progressFlow: { phase: 'awaiting_measurement' | 'confirming_disambiguation'; pendingWeight?: number; pendingWaist?: number; pendingDate?: string } | null;
  surfaceContext: 'plan' | 'cooking' | 'shopping' | 'recipes' | 'progress' | null;
  lastRenderedView?: {
    surface: 'plan' | 'cooking' | 'shopping' | 'recipes' | 'progress';
    view: string;
    [key: string]: unknown;
  };
  recentTurns?: ConversationTurn[];
}
```

- [ ] **Step 3: Implement `buildDispatcherContext`**

Add the context-builder function:

```typescript
/**
 * Assemble the per-call context bundle for the dispatcher. Pure — reads
 * session/store/recipes and returns a fresh object. Does NOT call the LLM,
 * does NOT mutate anything. Safe to call repeatedly.
 *
 * The shape of the returned context is defined in `src/agents/dispatcher.ts`
 * and the prompt is built from it in `buildUserPrompt`. Adding or removing
 * a field here is a load-bearing change — make sure the prompt consumes it.
 */
export async function buildDispatcherContext(
  session: DispatcherSession,
  store: StateStoreLike,
  recipes: RecipeDatabase,
  now: Date,
): Promise<DispatcherContext> {
  const today = toLocalISODate(now);
  const lifecycle = await getPlanLifecycle(session as never, store, today);

  // Plan summary — null when there's no visible plan.
  let planSummary: DispatcherPlanSummary | null = null;
  const planSession = await getVisiblePlanSession(store, today);
  if (planSession) {
    const allBatches = await store.getBatchesByPlanSessionId(planSession.id);
    const plannedBatches = allBatches.filter((b) => b.status === 'planned');

    const batchLines = plannedBatches.map((b) => {
      const recipe = recipes.getBySlug(b.recipeSlug);
      const name = recipe?.shortName ?? recipe?.name ?? b.recipeSlug;
      const days = b.eatingDays.join('/');
      return `${b.recipeSlug} (${name}), ${b.servings} servings, ${days} ${b.mealType}`;
    });
    const flexLines = planSession.flexSlots.map(
      (f) => `${f.day} ${f.mealTime} (+${f.flexBonus} kcal flex${f.note ? ' — ' + f.note : ''})`,
    );
    const eventLines = planSession.events.map(
      (e) => `${e.day} ${e.mealTime}: ${e.name} (~${e.estimatedCalories} kcal)`,
    );

    planSummary = {
      horizonStart: planSession.horizonStart,
      horizonEnd: planSession.horizonEnd,
      batchLines,
      flexLines,
      eventLines,
      weeklyCalorieTarget: config.targets.weekly.calories,
      weeklyProteinTarget: config.targets.weekly.protein,
    };
  }

  // Recipe index — one compact row per recipe.
  const recipeIndex: DispatcherRecipeRow[] = recipes.getAll().map((r: Recipe) => ({
    slug: r.slug,
    name: r.shortName ?? r.name,
    cuisine: r.cuisine,
    mealTypes: r.mealTypes,
    fridgeDays: r.storage.fridgeDays,
    freezable: r.storage.freezable,
    reheat: r.storage.reheat,
    calories: r.perServing.calories,
    protein: r.perServing.protein,
  }));

  // Active flow summary.
  const activeFlow: ActiveFlowSummary = buildActiveFlowSummary(session);

  // Recent turns (convert ConversationTurn → DispatcherTurn by dropping the
  // timestamp). Optional field — absent on sessions that never invoked the
  // dispatcher yet.
  const recentTurns: DispatcherTurn[] = (session.recentTurns ?? []).map((t) => ({
    role: t.role,
    text: t.text,
  }));

  return {
    today,
    now: now.toISOString(),
    surface: session.surfaceContext,
    lastRenderedView: session.lastRenderedView,
    lifecycle,
    activeFlow,
    recentTurns,
    planSummary,
    recipeIndex,
    allowedActions: AVAILABLE_ACTIONS_V0_0_5,
  };
}

/**
 * Collapse `planFlow` / `recipeFlow` / `progressFlow` into the
 * `ActiveFlowSummary` shape the dispatcher prompt consumes. Preference
 * order when multiple flows are alive: progress > recipe > plan
 * (matches the order `routeTextToActiveFlow` checks today).
 */
function buildActiveFlowSummary(session: DispatcherSession): ActiveFlowSummary {
  if (session.progressFlow) {
    return { kind: 'progress', phase: session.progressFlow.phase };
  }
  if (session.recipeFlow) {
    const phase = session.recipeFlow.phase;
    if (
      phase === 'awaiting_preferences' ||
      phase === 'awaiting_refinement' ||
      phase === 'reviewing'
    ) {
      return { kind: 'recipe', phase };
    }
    return { kind: 'recipe', phase: 'other' };
  }
  if (session.planFlow) {
    const pf = session.planFlow;
    return {
      kind: 'plan',
      phase: pf.phase as 'context' | 'awaiting_events' | 'generating_proposal' | 'proposal' | 'confirmed',
      horizonStart: pf.horizonStart,
      horizonEnd: pf.horizonDays ? pf.horizonDays[pf.horizonDays.length - 1] : undefined,
      pendingClarification: pf.pendingClarification,
    };
  }
  return { kind: 'none' };
}
```

**Store method check:** `getBatchesByPlanSessionId` is the assumed store method name — confirm it exists on `StateStoreLike` by Grep for `getBatchesByPlanSessionId` in `src/state/store.ts` and `src/harness/test-store.ts`. If the method is named differently (e.g., `getBatchesForSession`, `listBatches`), update the call. If it doesn't exist at all, use the same pattern `loadPlanBatches` uses in `core.ts` (lines ~1057–1080): iterate `store` APIs or replicate the existing helper. For Task 8 the cheapest path is: copy whatever `loadPlanBatches` does to fetch batches for a given session and call it here — this may require importing `loadPlanBatches` or extracting it into a shared helper. Document the choice in an inline comment.

- [ ] **Step 4: Implement `tryNumericPreFilter`**

Add the numeric pre-filter function. This is the narrow exception to "dispatcher is the front door" — when `progressFlow.phase === 'awaiting_measurement'` and the text is parseable as a measurement, handle it inline without an LLM call.

```typescript
/**
 * Narrow pre-filter for the progress measurement fast path.
 *
 * Returns `true` if the text was handled inline (the measurement was logged
 * or a disambiguation prompt was sent) AND the caller should NOT invoke the
 * dispatcher. Returns `false` if the text should be dispatched normally.
 *
 * The guard conditions are:
 *   1. `session.progressFlow?.phase === 'awaiting_measurement'`
 *   2. `parseMeasurementInput(text)` returns a non-null result
 *
 * If either fails, we return `false` and the runner invokes the dispatcher.
 * In particular: a message like "I'm ready to log my weight" during
 * `awaiting_measurement` is NOT parseable as a number, so it goes through
 * the dispatcher (which picks `flow_input` and routes to
 * `routeTextToActiveFlow`, which returns the "I'm expecting a number"
 * error today — proposal 003 § "Where the dispatcher sits in the message
 * flow" describes exactly this case).
 */
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

  const today = toLocalISODate(new Date());

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
    return true;
  }

  // Two numbers — may need disambiguation.
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
    return true;
  }

  // Ambiguous — enter disambiguation phase.
  session.progressFlow = {
    phase: 'confirming_disambiguation',
    pendingWeight: assignment.weight,
    pendingWaist: assignment.waist,
    pendingDate: today,
  };
  await sink.reply(formatDisambiguationPrompt(assignment.weight, assignment.waist), {
    reply_markup: progressDisambiguationKeyboard,
  });
  return true;
}

/**
 * Helper ported from core.ts to avoid a circular import. Returns the
 * weekly-report keyboard if last week has enough data to render one.
 */
async function getProgressReportKeyboardIfAvailable(
  store: StateStoreLike,
  today: string,
): Promise<typeof progressReportKeyboard | undefined> {
  const { getCalendarWeekBoundaries } = await import('../utils/dates.js');
  const { lastWeekStart, lastWeekEnd } = getCalendarWeekBoundaries(today);
  const lastWeekData = await store.getMeasurements('default', lastWeekStart, lastWeekEnd);
  return lastWeekData.length > 0 ? progressReportKeyboard : undefined;
}
```

The `tryNumericPreFilter` body is a verbatim port of the `awaiting_measurement` block that was removed from `handleTextInput` in Task 6. Keeping it in the runner file (not the agent file) is deliberate: it touches session and store state, which the pure agent must not.

- [ ] **Step 4b: Implement `wrapSinkForBotTurnCapture` + `flushBotTurn`**

```typescript
/**
 * Symbol used to attach the flush function as a non-enumerable property
 * on the wrapped sink. The runner pulls it back off the sink in a
 * `try/finally` after the dispatch action handler returns, so the buffered
 * bot turn is committed exactly once per dispatcher call.
 *
 * A symbol (rather than a string key) keeps the wrapper invisible to
 * everything else that might walk the sink's properties — including
 * tests, the harness, and any future grammY adapter that might inspect
 * its sink.
 */
const FLUSH_BOT_TURN = Symbol('dispatcher.flushBotTurn');

/**
 * Wrap a sink so that the LAST `reply` call on it is captured as a bot
 * turn on `session.recentTurns` when the dispatcher's action handler
 * returns. Multiple calls to `sink.reply` within the same dispatch overwrite
 * the buffered capture; only the most recent reply is committed. The
 * runner triggers the commit by calling `flushBotTurn(wrappedSink)` in a
 * `try/finally` around the action dispatch.
 *
 * **Why "last reply" instead of "first reply":** several flow handlers
 * emit a transient holding message before the substantive reply — the
 * recipe flow's `handlePreferencesAndGenerate` and `handleRefinement`
 * paths each call `sink.reply('Generating your recipe…')` /
 * `sink.reply('Refining your recipe...')` (`core.ts:1230` and `core.ts:1245`)
 * before the rendered recipe. A "first reply wins" policy would record the
 * holding message and miss the recipe entirely, breaking the proposal 003
 * "last 3–5 user/bot exchanges" contract for the most common
 * recipe-flow turn shape. Capturing the last reply guarantees the
 * substantive content reaches `recentTurns` for every multi-message
 * dispatch path. Single-reply dispatches (clarify, out_of_scope,
 * return_to_flow, plain flow_input) still record the only reply they
 * emit — last == only.
 *
 * **Why not "longest reply" or "all replies":** longest is fragile
 * (a long stack-trace error message could outweigh the substantive reply).
 * Recording all replies would emit 2–3 bot turns per dispatch, blowing
 * past the proposal's 3–5 turn budget after just two multi-message
 * dispatches. Last-reply is the simplest policy that handles every
 * known flow correctly: the substantive content is always the final
 * `sink.reply` call in the handler.
 *
 * Proposal 003 § "Context hydration" (line 257) requires the dispatcher to
 * see the "last 3–5 user/bot exchanges". Without this wrapper, flow-handler
 * replies (re-proposer output, recipe renders, etc.) would never land in
 * `recentTurns` — only dispatcher-authored `clarify` / `out_of_scope`
 * replies would. With this wrapper, every action branch contributes a bot
 * turn uniformly, so multi-turn referential threads ("what about the
 * lamb?" right after a re-proposer reply mentioning lamb) work as the
 * proposal intends.
 *
 * `startTyping` and any other sink methods pass through without side
 * effects on `recentTurns`. The wrapper is structural-typed so unit tests
 * can feed plain-object sinks.
 */
export function wrapSinkForBotTurnCapture<TSink extends DispatcherOutputSink>(
  sink: TSink,
  session: { recentTurns?: ConversationTurn[] },
): TSink {
  let lastCapture: string | null = null;

  const wrapped = new Proxy(sink, {
    get(target, prop, receiver) {
      if (prop === 'reply') {
        return async (text: string, ...rest: unknown[]) => {
          // Overwrite the buffered capture on every call. The most recent
          // reply will be committed by `flushBotTurn` after the dispatcher
          // action handler returns.
          lastCapture =
            text.length > BOT_TURN_TEXT_MAX
              ? text.slice(0, BOT_TURN_TEXT_MAX) + '…'
              : text;
          return await (target as DispatcherOutputSink).reply(
            text,
            ...(rest as [unknown?]),
          );
        };
      }
      if (prop === FLUSH_BOT_TURN) {
        return () => {
          if (lastCapture !== null) {
            pushTurn(session, 'bot', lastCapture);
            lastCapture = null;
          }
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as TSink;

  return wrapped;
}

/**
 * Commit the buffered bot-turn capture from a sink wrapped by
 * `wrapSinkForBotTurnCapture`. Safe to call on a sink that wasn't wrapped
 * (no-op) and safe to call multiple times (the second call is a no-op
 * because the buffer is cleared after the first commit).
 *
 * The runner calls this in a `try/finally` after dispatching to an action
 * handler, so the most recent `sink.reply` becomes the bot turn for the
 * dispatcher call regardless of whether the handler threw.
 */
export function flushBotTurn(sink: DispatcherOutputSink): void {
  const flush = (sink as unknown as { [FLUSH_BOT_TURN]?: () => void })[FLUSH_BOT_TURN];
  if (typeof flush === 'function') {
    flush();
  }
}
```

**Why a Proxy:** `DispatcherOutputSink` is a structural slice of the real `OutputSink` from `core.ts`, and the runner must pass through every method the caller might use (`reply`, `startTyping`, `answerCallback`, etc.) without losing `this` binding or requiring the runner to know the full method list. A Proxy forwards everything unchanged except `reply` (intercepted to buffer the capture) and the private `FLUSH_BOT_TURN` symbol (intercepted so the runner can commit). This keeps the wrapper future-proof if `DispatcherOutputSink` grows new methods.

**Edge case — handler emits no replies at all:** the buffer stays at `null`, `flushBotTurn` finds nothing to commit, and `recentTurns` does not gain a bot turn for that dispatch. The user turn is still pushed (Task 11 pushes it before the dispatch call), so the buffer ends up odd-length. This is acceptable — a dispatcher decision that produces zero replies is structurally a bug, not a normal case, and the next user turn will resync the buffer naturally.

**Edge case — handler throws after emitting a holding message:** the `try/finally` in the runner still calls `flushBotTurn`, so the holding message lands in `recentTurns`. This is mildly unfortunate but better than silently dropping the failed turn — the dispatcher's next call will see the holding message in history and can react sensibly ("looks like the recipe generation crashed, want to try again?"). Tracked in the decision log; if it ever causes user-visible confusion, the wrapper can grow a "skip holding messages on error" flag.

- [ ] **Step 5: Stub `runDispatcherFrontDoor`**

Add the runner entry point as a stub that the front-door wiring in Task 11 will call. The action handlers land in Task 9; until then, the stub throws so any premature wiring fails loudly.

```typescript
/**
 * Dependencies the runner needs at every call. Matches `BotCoreDeps` from
 * `core.ts` structurally — declared locally here to avoid a circular
 * import.
 */
export interface DispatcherRunnerDeps {
  llm: LLMProvider;
  recipes: RecipeDatabase;
  store: StateStoreLike;
}

/**
 * The front-door entry point. `core.dispatch` calls this for every text /
 * voice inbound after the reply-keyboard menu match has been checked.
 *
 * Flow (final shape — Task 11 wires the full body on top of this stub):
 *   1. Try the numeric pre-filter on the RAW sink. If it handles the
 *      message, return (no recentTurns bookkeeping).
 *   2. Run the planning meta-intent short-circuit (cancel / start_over)
 *      on the RAW sink. No recentTurns bookkeeping.
 *   3. Wrap the sink in `wrapSinkForBotTurnCapture` so every downstream
 *      reply is buffered for bot-turn recording (last reply wins).
 *   4. Build the dispatcher context bundle.
 *   5. Push the user's turn onto `recentTurns`.
 *   6. Call `dispatchMessage` with the context and user text.
 *   7. Dispatch the decision to its action handler (Task 9) inside a
 *      `try/finally` so `flushBotTurn(sink)` always runs and commits
 *      the most recent `sink.reply` to `recentTurns`.
 *   8. On `DispatcherFailure`, log and fall back to `fallback` (also
 *      inside `try/finally` so the fallback message still lands in
 *      recentTurns).
 *
 * `routeToActiveFlow` is passed in rather than imported so the runner
 * stays unit-testable without a full BotCore. `fallback` is the caller's
 * replyFreeTextFallback, passed in for the same reason.
 */
export async function runDispatcherFrontDoor(
  text: string,
  deps: DispatcherRunnerDeps,
  session: DispatcherSession,
  sink: DispatcherOutputSink,
  routeToActiveFlow: (text: string, sink: DispatcherOutputSink) => Promise<void>,
  fallback: (sink: DispatcherOutputSink) => Promise<void>,
): Promise<void> {
  void deps;
  void session;
  void sink;
  void routeToActiveFlow;
  void fallback;
  void text;
  log.debug('DISPATCHER', 'runDispatcherFrontDoor scaffold (Task 8) — handlers land in Task 9');
  throw new Error('runDispatcherFrontDoor is not yet wired (Plan 028 Task 8 scaffold)');
}
```

- [ ] **Step 6: Replace the placeholder in `dispatcher-context.test.ts` with real tests**

Replace the entire contents of `test/unit/dispatcher-context.test.ts` with:

```typescript
/**
 * Unit tests for buildDispatcherContext — Plan 028 Task 8.
 *
 * Exercises the context builder against hand-constructed slices:
 *
 *   - no plan + no active flow → lifecycle=no_plan, planSummary=null, activeFlow.kind=none
 *   - active plan + planFlow in proposal phase → activeFlow.kind=plan, planSummary populated
 *   - active plan + recipeFlow reviewing → activeFlow.kind=recipe (recipe wins over plan per preference order)
 *   - pendingClarification carries through on the active flow summary
 *   - recent turns are passed verbatim (minus timestamps)
 *   - recipe index is built correctly from recipes.getAll()
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  buildDispatcherContext,
  pushTurn,
  type DispatcherSession,
} from '../../src/telegram/dispatcher-runner.js';
import type { RecipeDatabase } from '../../src/recipes/database.js';
import type { Recipe } from '../../src/models/types.js';
import type { StateStoreLike } from '../../src/state/store.js';

function makeSession(overrides: Partial<DispatcherSession> = {}): DispatcherSession {
  return {
    recipeFlow: null,
    planFlow: null,
    progressFlow: null,
    surfaceContext: null,
    // recentTurns deliberately absent — optional field.
    ...overrides,
  };
}

function fakeRecipe(slug: string, overrides: Partial<Recipe> = {}): Recipe {
  return {
    slug,
    name: `${slug} name`,
    shortName: slug,
    mealTypes: ['dinner'],
    cuisine: 'global',
    tags: [],
    prepTimeMinutes: 30,
    structure: [],
    perServing: { calories: 600, protein: 40, fat: 20, carbs: 60 },
    ingredients: [],
    storage: { fridgeDays: 4, freezable: true, reheat: 'microwave 2 min' },
    body: '',
    ...overrides,
  };
}

function fakeRecipeDb(recipes: Recipe[]): RecipeDatabase {
  return {
    getAll: () => recipes,
    getBySlug: (slug: string) => recipes.find((r) => r.slug === slug),
  } as unknown as RecipeDatabase;
}

function fakeStore(): StateStoreLike {
  return {
    getVisiblePlanSession: async () => null,
    getBatchesByPlanSessionId: async () => [],
    getLatestMeasurement: async () => null,
    getMeasurements: async () => [],
    logMeasurement: async () => {},
  } as unknown as StateStoreLike;
}

test('buildDispatcherContext: no plan + no flow', async () => {
  const ctx = await buildDispatcherContext(
    makeSession(),
    fakeStore(),
    fakeRecipeDb([]),
    new Date('2026-04-10T12:00:00Z'),
  );
  assert.equal(ctx.lifecycle, 'no_plan');
  assert.equal(ctx.planSummary, null);
  assert.deepStrictEqual(ctx.activeFlow, { kind: 'none' });
  assert.deepStrictEqual(ctx.recipeIndex, []);
  assert.equal(ctx.today, '2026-04-10');
});

test('buildDispatcherContext: recipeFlow reviewing beats planFlow', async () => {
  const session = makeSession({
    planFlow: { phase: 'proposal' },
    recipeFlow: { phase: 'reviewing' },
  });
  const ctx = await buildDispatcherContext(session, fakeStore(), fakeRecipeDb([]), new Date('2026-04-10T12:00:00Z'));
  assert.equal(ctx.activeFlow.kind, 'recipe');
});

test('buildDispatcherContext: planFlow pending clarification is preserved', async () => {
  const session = makeSession({
    planFlow: {
      phase: 'proposal',
      horizonStart: '2026-04-06',
      horizonDays: ['2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09', '2026-04-10', '2026-04-11', '2026-04-12'],
      pendingClarification: {
        question: 'Lunch or dinner?',
        originalMessage: 'I went to the Indian place',
      },
    },
  });
  const ctx = await buildDispatcherContext(session, fakeStore(), fakeRecipeDb([]), new Date('2026-04-10T12:00:00Z'));
  assert.equal(ctx.activeFlow.kind, 'plan');
  if (ctx.activeFlow.kind === 'plan') {
    assert.deepStrictEqual(ctx.activeFlow.pendingClarification, {
      question: 'Lunch or dinner?',
      originalMessage: 'I went to the Indian place',
    });
  }
});

test('buildDispatcherContext: recipe index is built from getAll', async () => {
  const recipes = [
    fakeRecipe('moroccan-tagine', { cuisine: 'moroccan' }),
    fakeRecipe('chicken-pepperonata', { cuisine: 'italian' }),
  ];
  const ctx = await buildDispatcherContext(
    makeSession(),
    fakeStore(),
    fakeRecipeDb(recipes),
    new Date('2026-04-10T12:00:00Z'),
  );
  assert.equal(ctx.recipeIndex.length, 2);
  assert.equal(ctx.recipeIndex[0]!.slug, 'moroccan-tagine');
  assert.equal(ctx.recipeIndex[0]!.cuisine, 'moroccan');
  assert.equal(ctx.recipeIndex[1]!.cuisine, 'italian');
});

test('buildDispatcherContext: recent turns pass through', async () => {
  const session = makeSession();
  pushTurn(session, 'user', 'hello');
  pushTurn(session, 'bot', 'hi');
  pushTurn(session, 'user', 'how much protein in chicken');

  const ctx = await buildDispatcherContext(
    session,
    fakeStore(),
    fakeRecipeDb([]),
    new Date('2026-04-10T12:00:00Z'),
  );
  assert.equal(ctx.recentTurns.length, 3);
  assert.equal(ctx.recentTurns[0]!.text, 'hello');
  assert.equal(ctx.recentTurns[2]!.text, 'how much protein in chicken');
});

test('buildDispatcherContext: allowedActions is the v0.0.5 minimal set', async () => {
  const ctx = await buildDispatcherContext(
    makeSession(),
    fakeStore(),
    fakeRecipeDb([]),
    new Date('2026-04-10T12:00:00Z'),
  );
  assert.deepStrictEqual(Array.from(ctx.allowedActions), [
    'flow_input',
    'clarify',
    'out_of_scope',
    'return_to_flow',
  ]);
});
```

**Store shape check:** the `fakeStore` cast to `StateStoreLike` is a structural lie — the real interface has more methods. The dispatcher context only uses the handful listed, so the cast is safe. If TypeScript complains about missing methods, widen the cast with `as unknown as StateStoreLike` (already done). If the real `StateStoreLike` interface doesn't export `getVisiblePlanSession` or `getBatchesByPlanSessionId` as method names, update both the context builder and the fake store to use the real names.

- [ ] **Step 7: Typecheck + test**

Run: `npx tsc --noEmit`
Expected: no errors. If there are errors in `dispatcher-runner.ts` about missing store methods, adjust the store call in `buildDispatcherContext` to match the real interface (this is the pattern used in `core.ts` `loadPlanBatches`).

Run: `npm test`
Expected: unit tests added in Task 5 still pass; +6 new unit tests from this task; existing scenarios still red from Task 6 (not yet fixed — Task 13 does the regeneration).

- [ ] **Step 8: Commit**

```bash
git add src/telegram/dispatcher-runner.ts test/unit/dispatcher-context.test.ts
git commit -m "Plan 028: implement buildDispatcherContext + tryNumericPreFilter + runner stub"
```

---

### Task 8b: Extract flow resume views to a shared leaf module

**Rationale:** Proposal 003 invariant #6 ("`return_to_flow` restores the exact view, not a fresh render") and § "return_to_flow" line 328 ("re-renders its last view") are load-bearing. Plan C ships a three-tier fidelity model toward this invariant (byte-identical for `proposal` / `reviewing`, phase-canonical prompt for other active-flow phases, placeholder for no-flow) — see the "staged invariants" decision log entry for the full contract. Task 8b's job is to give that three-tier model a **single source of truth** for the resume strings, not to invent new ones.

Today the canonical "where you left off" rendering for `planFlow` lives in `getPlanFlowResumeView` inside `src/telegram/core.ts` (currently around lines 894–925), used by the `plan_week` menu action when lifecycle is `planning`. That helper ships Tier 2 fidelity for every non-`proposal` phase and Tier 1 for `proposal` (via the stored `proposalText`). There is no equivalent helper for `recipeFlow` — recipe resume strings are scattered across callback handlers in `core.ts` (`refine_recipe` at ~line 386, `re_<slug>` at ~line 452, `new_recipe` at ~line 394) and `recipe-flow.ts` (`handleMealTypeSelected` at ~line 264, post-generation review at ~line 1236).

If Task 9's `recipe_resume` callback and Task 10's `rerenderPlanFlow` / `rerenderRecipeFlow` invent their own resume strings, two things go wrong: (a) the strings drift from the canonical bot copy for phases where byte-identity IS achievable (like `proposal`), breaking invariant #6 for the Tier-1 cases; (b) future copy edits to plan / recipe resume views will need to be made in 3+ places to keep them in sync. The fix is to extract a single source of truth — `src/telegram/flow-resume-views.ts` — that takes flow state and returns `{ text, replyMarkup, parseMode }`. Both `core.ts` (for the existing `plan_week` resume + the new `plan_resume` / `recipe_resume` callbacks) and `dispatcher-runner.ts` (for the rerender helpers) import from it. Extracting the helper does NOT upgrade any phase's fidelity — Task 8b ports the existing Tier-2 approximation verbatim. Plan E Task 19 lifts Tier 2 to Tier 1 separately by adding `lastRenderedText` persistence to flow state.

The new module is a leaf: it imports types from `../agents/plan-flow.js` / `../agents/recipe-flow.js`, keyboards from `./keyboards.js`, and `renderRecipe` from `../recipes/renderer.js`. It does NOT import `core.ts` or `dispatcher-runner.ts`. No circular import.

**Files:**
- Create: `src/telegram/flow-resume-views.ts`
- Modify: `src/utils/dates.ts` — add `formatDateForMessage` (currently a private helper in `core.ts:1433`).
- Modify: `src/telegram/core.ts` — replace the local `getPlanFlowResumeView` body and `formatDateForMessage` definition with imports.

- [ ] **Step 1: Move `formatDateForMessage` into `src/utils/dates.ts`**

Find the existing helper in `src/telegram/core.ts` (Grep `function formatDateForMessage`):

```typescript
/** Format a date for display in messages. */
function formatDateForMessage(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
```

Move it to `src/utils/dates.ts` (Plan 027 already touches this file via `getCalendarWeekBoundaries`). Add an `export` and a doc comment:

```typescript
/**
 * Format an ISO date string ('YYYY-MM-DD') as a human-readable label for
 * Telegram messages. Returns short English weekday + short month + day,
 * e.g. "Mon, Apr 6". Used by `getPlanFlowResumeView` and any other view
 * code that wants a compact day label without dragging in `Intl.DateTimeFormat`
 * configuration.
 */
export function formatDateForMessage(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
```

In `src/telegram/core.ts`, delete the local definition and add the import:

```typescript
import { getCalendarWeekBoundaries, formatDateForMessage } from '../utils/dates.js';
```

(Or extend the existing `getCalendarWeekBoundaries` import line if it's already grouped.)

- [ ] **Step 2: Create `src/telegram/flow-resume-views.ts`**

```typescript
/**
 * Flow resume views — the SINGLE source of truth for "where you left off"
 * bot copy across the planning and recipe flows.
 *
 * Plan 028 (Plan C). Proposal 003 invariant #6 requires
 * `return_to_flow` to "restore the exact view, not a fresh render". Both
 * the existing `plan_week` menu action (which today uses
 * `getPlanFlowResumeView` inside `core.ts`) and Plan 028's new dispatcher
 * `return_to_flow` handler (which lives in `dispatcher-runner.ts`) need to
 * emit the same bot copy for the same flow phase. Putting the resume
 * builders in their own leaf module makes "same bytes" structurally
 * guaranteed instead of relying on agents to manually mirror strings.
 *
 * This module is a LEAF: it imports flow state types, keyboards, the
 * recipe formatter, and a date util. It must NOT import `core.ts` or
 * `dispatcher-runner.ts` — both of those import this module, and a
 * back-edge would create a circular dependency.
 *
 * Adding new flow phases:
 * - If a phase has no stored body (just a question to the user), the
 *   resume text IS that question. Mirror the exact string the in-flow
 *   handler emits when entering the phase.
 * - If a phase has a stored body (a generated proposal, a rendered
 *   recipe), the resume text is the stored body re-formatted via the
 *   same pure formatter the in-flow render path uses.
 * - If two entry paths produce slightly different copy for the same
 *   phase (e.g. recipe edit vs. recipe refine both land in
 *   `awaiting_refinement`), pick the canonical version and document
 *   the variant in this file's doc.
 */

import type { Keyboard, InlineKeyboard } from 'grammy';
import type { PlanFlowState } from '../agents/plan-flow.js';
import type { RecipeFlowState } from '../agents/recipe-flow.js';
import {
  planBreakfastKeyboard,
  planEventsKeyboard,
  planMoreEventsKeyboard,
  planProposalKeyboard,
  recipeReviewKeyboard,
  mealTypeKeyboard,
} from './keyboards.js';
import { renderRecipe } from '../recipes/renderer.js';
import { formatDateForMessage } from '../utils/dates.js';

export interface FlowResumeView {
  text: string;
  replyMarkup?: InlineKeyboard | Keyboard;
  parseMode?: 'MarkdownV2';
}

/**
 * Build a resume view for an in-progress planning flow.
 *
 * **Fidelity contract (Plan 028 / Plan C):**
 *
 * - `proposal` → BYTE-IDENTICAL to the original render. `state.proposalText`
 *   is persisted by `plan-flow.ts:1109` when the proposer completes, so the
 *   resume helper emits exactly the same text the user last saw. Keyboard
 *   is `planProposalKeyboard`, parse mode `MarkdownV2`. Locked in by
 *   scenario 039.
 *
 * - Every OTHER plan phase (`context`, `awaiting_events`,
 *   `generating_proposal`, `confirmed`) → PHASE-CANONICAL PROMPT, NOT
 *   byte-identical to the actual last-rendered message. The resume helper
 *   emits a short re-entry prompt keyed on phase + stored structural state
 *   (weekStart, breakfast, events count). For example, after the user has
 *   added two events and the bot last said `"Got it — <name 2> on <day>
 *   <meal> (~<cal>). Any other meals out?"` (`plan-flow.ts:291`), the
 *   resume helper returns `"You're adding events for the week. Send
 *   another event or tap Done."` with `planMoreEventsKeyboard`. The
 *   keyboard is correct and the re-entry prompt is sensible, but the text
 *   does NOT match the user's last message byte-for-byte.
 *
 *   This is the **existing legacy behavior** of `getPlanFlowResumeView`
 *   inside `core.ts` (the function Task 8b extracts). The `plan_week`
 *   menu action at `lifecycle === 'planning'` already calls this helper,
 *   and users who tap 📋 Plan Week mid-plan today already see the
 *   phase-canonical prompt rather than the exact last message. Plan 028
 *   does NOT rewrite flow handlers to store `lastRenderedText` —
 *   that is Plan E's Task 19 (bundled with the view-renderers module +
 *   `LastRenderedView` extension), which promotes every active-flow
 *   phase to byte-identical resume by capturing `sink.reply(text, opts)`
 *   at the flow-handler level and storing the rendered bytes on flow
 *   state. Until Plan E lands, the non-`proposal` resume behavior is
 *   "phase-canonical, close enough to orient the user, not byte-exact."
 *
 * - `context` — `"Planning <start> – <end>. Breakfast: keep <name>?"` +
 *   `planBreakfastKeyboard`. The real last-rendered message from
 *   `core.ts:884` is `"Planning <start> – <end>.\n\nBreakfast: keep
 *   <name> (<cal>/day)?"` — the resume drops the calorie annotation and
 *   the blank line. Documented drift.
 * - `awaiting_events` — `"You're adding events for the week. Send another
 *   event or tap Done."` + `planEventsKeyboard` or `planMoreEventsKeyboard`
 *   depending on whether any events have been added. Actual last-rendered
 *   messages vary: `plan-flow.ts:240` post-`plan_add_event` entry,
 *   `plan-flow.ts:423` post-event-parsed ack, `plan-flow.ts:291`
 *   post-correction ack, etc. Documented drift.
 * - `generating_proposal` — `"Still working on it…"` without keyboard.
 *   Transient phase, rarely reached via `return_to_flow` because the
 *   proposer call is awaited synchronously. Best-effort text.
 * - `confirmed` — `"Plan already confirmed."`. Transient terminal phase;
 *   the lifecycle guard normally prevents this branch from being hit.
 *   Defensive fallback.
 *
 * Pure: takes flow state, returns text + keyboard. No I/O, no side effects.
 */
export function getPlanFlowResumeView(state: PlanFlowState): FlowResumeView {
  switch (state.phase) {
    case 'context': {
      const weekEnd = state.weekDays[6]!;
      return {
        text: `Planning ${formatDateForMessage(state.weekStart)} – ${formatDateForMessage(weekEnd)}. Breakfast: keep ${state.breakfast.name}?`,
        replyMarkup: planBreakfastKeyboard,
      };
    }
    case 'awaiting_events': {
      const kb = state.events.length === 0 ? planEventsKeyboard : planMoreEventsKeyboard;
      return {
        text: "You're adding events for the week. Send another event or tap Done.",
        replyMarkup: kb,
      };
    }
    case 'generating_proposal':
      return { text: 'Still working on it…' };
    case 'proposal':
      return {
        text: state.proposalText ?? 'Your plan is ready for review.',
        replyMarkup: planProposalKeyboard,
        parseMode: 'MarkdownV2',
      };
    case 'confirmed':
      return { text: 'Plan already confirmed.' };
  }
}

/**
 * Build a resume view for an in-progress recipe flow.
 *
 * **Fidelity contract (Plan 028 / Plan C):**
 *
 * - `reviewing` → BYTE-IDENTICAL to the original render. The helper calls
 *   `renderRecipe(state.currentRecipe)`, the same pure MarkdownV2
 *   formatter `handlePreferencesAndGenerate` / `handleRefinement` use
 *   after generation/refinement (`recipe-flow.ts:293, 332`). Keyboard is
 *   `recipeReviewKeyboard`, parse mode `MarkdownV2`.
 *
 * - Every OTHER recipe phase (`choose_meal_type`, `awaiting_preferences`,
 *   `awaiting_refinement`) → PHASE-CANONICAL PROMPT, NOT byte-identical
 *   to the actual last-rendered message. Same rationale as
 *   `getPlanFlowResumeView` above: Plan 028 does not extend flow state
 *   to store `lastRenderedText`; Plan E's Task 19 does, at which point
 *   all phases promote to byte-identical.
 *
 * - `choose_meal_type` — `'What type of recipe?'` + `mealTypeKeyboard`.
 *   Source: `core.ts:394` (`new_recipe` callback) and `core.ts:409`
 *   (`add_recipe` callback). Both live entry paths emit identical copy,
 *   so this phase IS byte-identical for any user who reaches it via
 *   those two callbacks. The drift case is: a future entry path that
 *   uses different wording would not be mirrored until added here.
 * - `awaiting_preferences` — `"<MealType> recipe.\n\nDescribe what you
 *   want (cuisine, ingredients, style) or just say 'surprise me.'"`
 *   Source: `handleMealTypeSelected` in `recipe-flow.ts:264`. Only one
 *   entry path today, so this phase is byte-identical for current users.
 * - `awaiting_refinement` → **documented drift**. Two entry paths
 *   produce different example lists:
 *   - `core.ts:386` (`refine_recipe` callback after review):
 *     `'What would you like to change? (e.g., "simpler ingredients",
 *     "less fat", "swap chicken for fish")'`
 *   - `core.ts:452` (`re_<slug>` callback from library edit):
 *     `'What would you like to change? (e.g., "swap beef for chicken",
 *     "less oil", "add a side salad")'`
 *   The resume helper emits the `refine_recipe` form regardless of
 *   entry path. This is a deliberate Plan C deviation from invariant #6
 *   for this phase specifically — the helper cannot distinguish which
 *   entry path the user took because `RecipeFlowState` does not record
 *   it, and extending the state (adding an `entryPath?: 'refine' | 'edit'`
 *   field) is scope creep that the Plan E `lastRenderedText`
 *   promotion will supersede anyway. A user who edited a recipe from
 *   the library, branched to a side question, and typed "back to
 *   editing" will see the refine-form prompt — the question is
 *   identical, but the examples differ. Bounded drift, documented in
 *   the Plan 028 decision log.
 *
 * Pure: takes flow state, returns text + keyboard. No I/O, no side effects.
 */
export function getRecipeFlowResumeView(state: RecipeFlowState): FlowResumeView {
  switch (state.phase) {
    case 'choose_meal_type':
      return {
        text: 'What type of recipe?',
        replyMarkup: mealTypeKeyboard,
      };
    case 'awaiting_preferences': {
      const mealType = state.mealType ?? 'dinner';
      const capitalized = mealType.charAt(0).toUpperCase() + mealType.slice(1);
      return {
        text: `${capitalized} recipe.\n\nDescribe what you want (cuisine, ingredients, style) or just say "surprise me."`,
      };
    }
    case 'reviewing': {
      if (!state.currentRecipe) {
        // Defensive — phase invariant guarantees currentRecipe but be safe.
        return {
          text: 'Back to recipe review.',
          replyMarkup: recipeReviewKeyboard,
        };
      }
      return {
        text: renderRecipe(state.currentRecipe),
        replyMarkup: recipeReviewKeyboard,
        parseMode: 'MarkdownV2',
      };
    }
    case 'awaiting_refinement':
      return {
        text: 'What would you like to change? (e.g., "simpler ingredients", "less fat", "swap chicken for fish")',
      };
  }
}
```

- [ ] **Step 3: Replace the local `getPlanFlowResumeView` in `core.ts` with the import**

Find the existing `function getPlanFlowResumeView(state: PlanFlowState)` block (currently around lines 894–925) and DELETE it. Find its single call site (`plan_week` menu action, currently around line 978) and confirm it still works after replacing the call with the imported helper.

Add the import to the existing `./flow-resume-views.js` group at the top of the file:

```typescript
import {
  getPlanFlowResumeView,
  getRecipeFlowResumeView,
  type FlowResumeView,
} from './flow-resume-views.js';
```

The call site remains unchanged because the function shape is identical.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. The new module is a leaf so the type graph stays acyclic. The `plan_week` menu action's behavior is unchanged because the function body was moved verbatim. No scenarios should regress on this task — it's a pure refactor with no behavior change for any existing path.

Run: `npm test`
Expected: same state as end of Task 8 (unit tests green; existing scenarios still red from Task 6).

- [ ] **Step 5: Commit**

```bash
git add src/telegram/flow-resume-views.ts src/utils/dates.ts src/telegram/core.ts
git commit -m "Plan 028: extract getPlanFlowResumeView + getRecipeFlowResumeView to flow-resume-views.ts

Pure refactor in service of proposal 003 invariant #6 ('return_to_flow
restores the exact view'). Moves the existing planning resume copy out
of core.ts and adds a parallel recipe resume helper so the dispatcher
return_to_flow handler (Task 10) and the plan_resume/recipe_resume
inline callbacks (Task 9) share a single source of truth with the
existing plan_week menu action. Ports the existing Tier-2
phase-canonical approximation verbatim — fidelity upgrades across
non-proposal phases are Plan E Task 19's job.

formatDateForMessage moves to src/utils/dates.ts so the new module can
import it without pulling in core.ts."
```

---

### Task 9: Action handlers — `flow_input`, `clarify`, `out_of_scope`

**Rationale:** Three of the four minimal actions have straightforward handlers. `return_to_flow` is more involved because it has two branches (active flow re-render vs. navigation re-render) and needs its own task. Land these three first so Task 10 only has to deal with the hard one.

**Files:**
- Modify: `src/telegram/dispatcher-runner.ts`

- [ ] **Step 1: Add the `flow_input` handler**

Append to `src/telegram/dispatcher-runner.ts`:

```typescript
// ─── Action handlers ─────────────────────────────────────────────────────────

/**
 * `flow_input` — forward the text to the active flow's existing text
 * handler. The handler is injected by the caller (`core.ts`) so the runner
 * does not import `routeTextToActiveFlow` directly.
 *
 * Defensive check: if no flow is active, this is a dispatcher classification
 * error. Log and fall back to the generic hint — the user gets the same UX
 * as today's fallback path, not a silent drop.
 */
export async function handleFlowInputAction(
  decision: Extract<DispatcherDecision, { action: 'flow_input' }>,
  _deps: DispatcherRunnerDeps,
  session: DispatcherSession,
  sink: DispatcherOutputSink,
  userText: string,
  routeToActiveFlow: (text: string, sink: DispatcherOutputSink) => Promise<void>,
  fallback: (sink: DispatcherOutputSink) => Promise<void>,
): Promise<void> {
  void decision;
  const hasActiveFlow =
    session.planFlow !== null ||
    session.recipeFlow !== null ||
    (session.progressFlow !== null &&
      session.progressFlow.phase === 'confirming_disambiguation');
  if (!hasActiveFlow) {
    log.warn(
      'DISPATCHER',
      'flow_input picked but no active flow — classification error, falling back to hint',
    );
    await fallback(sink);
    return;
  }
  await routeToActiveFlow(userText, sink);
}
```

- [ ] **Step 2: Add the `clarify` handler**

```typescript
/**
 * `clarify` — send the dispatcher-authored question as a reply. Leaves
 * session state unchanged. The user's next message will be dispatched
 * fresh with this question in `recentTurns`.
 *
 * **Proposal 003 state-preservation invariant #3:** when a flow is
 * active, the reply MUST include a `[← Back to X]` inline button
 * pointing back to the flow — this branch is satisfied here by
 * `buildSideConversationKeyboard` emitting the `plan_resume` /
 * `recipe_resume` inline callbacks. When no flow is active, invariant
 * #3 says the back button should point at the main view for the
 * current surface context (plan / recipes / shopping / progress);
 * Plan C's minimal implementation falls back to the main menu reply
 * keyboard instead, which is a navigation escape hatch but NOT a
 * surface-scoped back target. Full compliance for the no-flow branch
 * arrives with Plan E's view-renderers (Plan 030 Task 5 + Task 19 —
 * see the Plan 028 decision log entry documenting this deviation).
 * `buildSideConversationKeyboard` handles both cases today.
 */
export async function handleClarifyAction(
  decision: Extract<DispatcherDecision, { action: 'clarify' }>,
  deps: DispatcherRunnerDeps,
  session: DispatcherSession,
  sink: DispatcherOutputSink,
): Promise<void> {
  const kb = await buildSideConversationKeyboard(session, deps.store);
  // `sink` is the wrapped sink from `runDispatcherFrontDoor`. This
  // reply is buffered by `wrapSinkForBotTurnCapture` and committed to
  // `session.recentTurns` after the handler returns via `flushBotTurn`
  // in the runner's `try/finally`. Single-reply branches like clarify
  // record exactly that reply (last == only). No explicit `pushTurn`
  // here — the wrapper is the single source of truth for bot-turn
  // recording across all action branches.
  await sink.reply(decision.response, { reply_markup: kb });
}
```

- [ ] **Step 3: Add the `out_of_scope` handler**

```typescript
/**
 * `out_of_scope` — send the dispatcher's decline. Same keyboard logic as
 * clarify: inline `[← Back to X]` when a flow is active, main menu
 * reply keyboard otherwise.
 */
export async function handleOutOfScopeAction(
  decision: Extract<DispatcherDecision, { action: 'out_of_scope' }>,
  deps: DispatcherRunnerDeps,
  session: DispatcherSession,
  sink: DispatcherOutputSink,
): Promise<void> {
  const kb = await buildSideConversationKeyboard(session, deps.store);
  // Wrapped sink handles bot-turn recording — see handleClarifyAction note.
  await sink.reply(decision.response, { reply_markup: kb });
}
```

- [ ] **Step 4: Add the side-conversation keyboard helper**

```typescript
/**
 * Build the keyboard for a side-conversation reply (clarify / out_of_scope).
 *
 * Proposal 003 state-preservation invariant #3: when a flow is active, the
 * reply includes an inline `[← Back to X]` button pointing back to the
 * flow's last view (so the user can return with a tap as well as via
 * natural language). When no flow is active, the reply uses the
 * lifecycle-aware main menu reply keyboard.
 *
 * The inline-back button is implemented as an `InlineKeyboard` with a
 * single button whose `callback_data` matches an existing navigation
 * callback: `plan_resume` (not a real callback today — registered as a
 * new no-op that re-renders the plan flow via the same path
 * `handleReturnToFlowAction` uses). This keeps the [← Back] button
 * clickable without introducing a new flow branch.
 *
 * **Alternative:** use a `return_to_flow` text imitation by emitting a
 * reply-keyboard button labelled "← Back to planning" that the user can
 * tap. That approach doesn't require a new callback but floods the main
 * menu layout. The inline approach is cleaner and matches the proposal's
 * vocabulary.
 *
 * Task 11 will add the `plan_resume` / `recipe_resume` inline callback
 * handlers in `core.ts` to complete the round-trip. Until then, this
 * helper returns only the main menu for all cases — the inline-back
 * enhancement is a Task 11 follow-up.
 */
async function buildSideConversationKeyboard(
  session: DispatcherSession,
  store: StateStoreLike,
) {
  const { InlineKeyboard } = await import('grammy');
  const { buildMainMenuKeyboard } = await import('./keyboards.js');

  if (session.planFlow) {
    return new InlineKeyboard().text('← Back to planning', 'plan_resume');
  }
  if (session.recipeFlow) {
    return new InlineKeyboard().text('← Back to recipe', 'recipe_resume');
  }

  const today = toLocalISODate(new Date());
  const lifecycle = await getPlanLifecycle(session as never, store, today);
  return buildMainMenuKeyboard(lifecycle);
}
```

- [ ] **Step 5: Typecheck + test**

Run: `npx tsc --noEmit`
Expected: no errors. The three handlers in `dispatcher-runner.ts` (`handleFlowInputAction`, `handleClarifyAction`, `handleOutOfScopeAction`) are exported but not yet called from any runtime path — Task 11 wires them in. `buildSideConversationKeyboard` emits inline buttons for `plan_resume` / `recipe_resume` callbacks that do not yet exist in `core.ts`; Task 10 adds them after `handleReturnToFlowAction` is defined, and at that point the button-tap path becomes functional. Until Task 10 lands, a user tapping the inline back button would produce an unhandled callback — which is fine because this intermediate state is not reachable by any test until Task 11 wires the runner.

Run: `npm test`
Expected: same state as end of Task 8b (unit tests green, some scenarios red from Task 6).

- [ ] **Step 6: Commit**

```bash
git add src/telegram/dispatcher-runner.ts
git commit -m "Plan 028: action handlers for flow_input, clarify, out_of_scope + side-conversation keyboard helper"
```

---

### Task 10: `return_to_flow` handler + `rerenderLastView` helper

**Rationale:** `return_to_flow` is the dispatcher's natural-language back button. It has two cases:

1. **Active flow exists.** Re-render the flow's current view. The active-flow branch is a thin wrapper around the leaf helpers from Task 8b: `rerenderPlanFlow` calls `getPlanFlowResumeView(session.planFlow)` and emits the resulting `{text, replyMarkup, parseMode}`; `rerenderRecipeFlow` calls `getRecipeFlowResumeView(session.recipeFlow)` and does the same. This guarantees **byte-identical** resume copy for the `proposal` and `reviewing` phases (where the rendered body lives on flow state: `proposalText` / `currentRecipe`) and **phase-canonical prompts** for every other active-flow phase (`context`, `awaiting_events`, `generating_proposal`, `confirmed`, `choose_meal_type`, `awaiting_preferences`, `awaiting_refinement`). The non-byte-identical phases inherit the existing legacy approximation used by `core.ts`'s `plan_week` menu action today; Plan E Task 19 promotes them to byte-identical by adding `lastRenderedText` persistence to flow state. See the Task 8b helper doc comments for the full fidelity contract and the decision log entry below for the staged-invariant rationale.

2. **No active flow.** Read `session.lastRenderedView` (Plan 027's field) and emit a **minimal placeholder reply** keyed on its `surface` variant — this is the Tier 3 behavior documented in the "Staged invariants" decision log entry. The `rerenderLastView` helper maps each `surface` value to a short text like "Back to plan. Tap 📋 My Plan for the current view." plus the lifecycle-aware main-menu reply keyboard. This is NOT a full re-render of the user's previous view — it is a navigation escape hatch that gets the user one tap away from the real view. True re-rendering requires calling `core.ts`'s existing render functions (`formatNextAction`, `formatWeekOverview`, `formatDayDetail`, `formatShoppingList`, etc.), which are only importable from the runner without a circular dependency after Plan E Task 5 extracts them into `src/telegram/view-renderers.ts`. At that point Plan E Task 19 rewrites `rerenderLastView` to dispatch through the extracted renderers using the params stored on `session.lastRenderedView`, promoting Tier 3 to byte-identical.

Plan C ships the placeholder deliberately and documents the deviation. The alternative — calling `core.ts` render functions from the runner right now — either re-creates the circular import problem or duplicates hundreds of lines of render code into the runner module. Neither is acceptable for Plan C's "minimal dispatcher infrastructure" scope.

The no-flow branch is where the bulk of the concrete code in this task lives, because each `LastRenderedView` variant needs a distinct placeholder string — but no real render calls. The fidelity upgrade lives in Plan E.

**Files:**
- Modify: `src/telegram/dispatcher-runner.ts`
- Modify: `src/telegram/core.ts` — add `plan_resume` / `recipe_resume` inline callback cases that delegate to `handleReturnToFlowAction`.

- [ ] **Step 1: Add the `handleReturnToFlowAction` stub**

```typescript
/**
 * `return_to_flow` — re-render the user's last view.
 *
 * Two branches:
 *   1. Active flow → re-render the flow's last view from flow state.
 *   2. No active flow → re-render `session.lastRenderedView` (Plan 027).
 *
 * If neither branch has anything to show, fall back to the menu with a
 * brief "you're at the menu" message.
 */
export async function handleReturnToFlowAction(
  _decision: Extract<DispatcherDecision, { action: 'return_to_flow' }>,
  deps: DispatcherRunnerDeps,
  session: DispatcherSession,
  sink: DispatcherOutputSink,
): Promise<void> {
  // Branch 1: active flow.
  if (session.planFlow) {
    await rerenderPlanFlow(session, deps, sink);
    return;
  }
  if (session.recipeFlow) {
    await rerenderRecipeFlow(session, sink);
    return;
  }

  // Branch 2: no active flow, use lastRenderedView.
  if (session.lastRenderedView) {
    await rerenderLastView(session, deps, sink);
    return;
  }

  // Branch 3: nothing to return to.
  const menuKb = await buildMenuKeyboardForSession(session, deps.store);
  await sink.reply("You're at the menu.", { reply_markup: menuKb });
}
```

- [ ] **Step 2: Implement `rerenderPlanFlow`**

```typescript
/**
 * Re-render the plan flow's current view by delegating to the leaf
 * `getPlanFlowResumeView` helper from `flow-resume-views.ts` (Task 8b).
 *
 * Fidelity: byte-identical for `proposal` phase (reads stored
 * `proposalText`); phase-canonical prompt for all other phases. See
 * `getPlanFlowResumeView`'s own doc for the per-phase contract. Plan E
 * Task 19 promotes every phase to byte-identical when it adds
 * `lastRenderedText` persistence to `PlanFlowState`.
 *
 * Proposal 003 invariant #6 ("`return_to_flow` restores the exact view,
 * not a fresh render") is satisfied for the `proposal` phase directly
 * and is achieved structurally for all phases via shared rendering:
 * this function, the `plan_resume` inline callback in `core.ts`, and the
 * existing `plan_week` menu action all call the same pure builder, so
 * the three back-button paths always agree with each other — and any
 * future fidelity upgrade made to the helper automatically lifts all
 * three call sites at once.
 */
async function rerenderPlanFlow(
  session: DispatcherSession,
  _deps: DispatcherRunnerDeps,
  sink: DispatcherOutputSink,
): Promise<void> {
  const { getPlanFlowResumeView } = await import('./flow-resume-views.js');
  // Cast through `unknown` because the runner's structural DispatcherSession
  // interface does not depend on the full PlanFlowState type (it only sees
  // a phase-tagged slice). At runtime the value IS a PlanFlowState because
  // every code path that constructs a DispatcherSession does so from a
  // real BotCoreSession.
  const view = getPlanFlowResumeView(
    session.planFlow as unknown as import('../agents/plan-flow.js').PlanFlowState,
  );
  await sink.reply(view.text, {
    ...(view.replyMarkup && { reply_markup: view.replyMarkup }),
    ...(view.parseMode && { parse_mode: view.parseMode }),
  });
}
```

**Note on `proposalText`:** The runner's structural `DispatcherSession` interface does not list `proposalText` on `planFlow`. `getPlanFlowResumeView` reads `state.proposalText` directly from the real `PlanFlowState` (from `src/agents/plan-flow.ts`). The unknown-cast at the call site bridges the structural gap without forcing the runner's interface to grow recipe/plan internals.

- [ ] **Step 3: Implement `rerenderRecipeFlow`**

```typescript
/**
 * Re-render the recipe flow's current view by delegating to the leaf
 * `getRecipeFlowResumeView` helper from `flow-resume-views.ts` (Task 8b).
 *
 * Fidelity: byte-identical for `reviewing` phase (reads stored
 * `currentRecipe` via `renderRecipe`); phase-canonical prompt for other
 * phases. Notable documented drift: `awaiting_refinement` emits the
 * `refine_recipe` example list regardless of entry path, so
 * library-edit users see the post-review example list instead of the
 * library-edit example list. See `getRecipeFlowResumeView`'s own doc
 * for the per-phase contract and the Plan 028 decision log for the
 * bounded-deviation rationale. Plan E Task 19 promotes every phase to
 * byte-identical by adding `lastRenderedText` persistence to
 * `RecipeFlowState`.
 *
 * No new LLM calls; the helper is a pure function over flow state.
 */
async function rerenderRecipeFlow(
  session: DispatcherSession,
  sink: DispatcherOutputSink,
): Promise<void> {
  const { getRecipeFlowResumeView } = await import('./flow-resume-views.js');
  const view = getRecipeFlowResumeView(
    session.recipeFlow as unknown as import('../agents/recipe-flow.js').RecipeFlowState,
  );
  await sink.reply(view.text, {
    ...(view.replyMarkup && { reply_markup: view.replyMarkup }),
    ...(view.parseMode && { parse_mode: view.parseMode }),
  });
}
```

**Where `confirmed` and `generating_proposal` go:** these are transient plan phases. `getPlanFlowResumeView` returns a defensive fallback (`'Plan already confirmed.'` / `'Still working on it…'`) for them; the runner doesn't add any extra branching here because the helper is exhaustive over the discriminated union. If a future plan phase is added, TypeScript will fail to compile until both the helper and any consumer cover it — there is no scenario where the runner can silently emit a wrong string for a phase the helper doesn't know about.

- [ ] **Step 4: Implement `rerenderLastView` (navigation branch)**

```typescript
/**
 * Re-render the last navigation view the user was looking at. Reads
 * `session.lastRenderedView` (set by Plan 027 handlers) and calls the
 * corresponding render path. This is the single place that translates
 * `LastRenderedView` variants into render operations outside of the
 * callback handlers in `core.ts`.
 *
 * **Implementation note:** rather than duplicating the render code from
 * `core.ts`'s handlers, this function emits a minimal placeholder reply
 * for each variant that says "back to X" and includes the appropriate
 * keyboard. The placeholder is deliberate for Plan C's minimal scope —
 * Plan E will promote this to full re-render parity with the original
 * callback, at which point it may collapse into the dispatcher's
 * `show_plan` / `show_recipe` / `show_shopping_list` / `show_progress`
 * action handlers (since those actions necessarily contain the same
 * render logic).
 *
 * For Plan C the UX is: user types "ok back to the plan", sees a short
 * "Back to plan." text + the main menu keyboard. That's a regression
 * compared to Plan E's vision but still strictly better than today's
 * behavior (which does nothing at all for that phrase).
 */
async function rerenderLastView(
  session: DispatcherSession,
  deps: DispatcherRunnerDeps,
  sink: DispatcherOutputSink,
): Promise<void> {
  const view = session.lastRenderedView!;
  const menuKb = await buildMenuKeyboardForSession(session, deps.store);

  switch (view.surface) {
    case 'plan':
      await sink.reply('Back to your plan. Tap 📋 My Plan for the current view.', {
        reply_markup: menuKb,
      });
      return;
    case 'cooking':
      await sink.reply('Back to cooking. Tap the cook-day button on your plan to return.', {
        reply_markup: menuKb,
      });
      return;
    case 'shopping':
      await sink.reply('Back to the shopping list. Tap 🛒 Shopping List for the current view.', {
        reply_markup: menuKb,
      });
      return;
    case 'recipes':
      await sink.reply('Back to your recipes. Tap 📖 My Recipes for the full library.', {
        reply_markup: menuKb,
      });
      return;
    case 'progress':
      await sink.reply('Back to progress. Tap 📊 Progress to log or see your report.', {
        reply_markup: menuKb,
      });
      return;
    default:
      log.warn('DISPATCHER', `rerenderLastView: unknown surface ${String((view as { surface: string }).surface)}`);
      await sink.reply('Back to the menu.', { reply_markup: menuKb });
  }
}
```

**Plan E note:** the text above is intentionally minimal — proposal 003 § "Return to flow" describes full-fidelity re-rendering of the exact prior view. Plan E will revisit this helper when it implements `show_plan` / `show_recipe` etc., at which point `rerenderLastView` can delegate to those handlers by calling them with the params extracted from `lastRenderedView`. Leaving the TODO explicit here so Plan E's implementer knows where to insert the real logic.

- [ ] **Step 5: Wire the `plan_resume` / `recipe_resume` inline callbacks in `core.ts`**

Now that `handleReturnToFlowAction` is defined, `core.ts`'s `handleCallback` can delegate both back-button callbacks to it. This is what makes proposal 003 invariant #7 real: "Natural-language back commands are equivalent to back-button taps" — because both paths call one function, they cannot diverge by construction. The wiring also wraps the sink with `wrapSinkForBotTurnCapture` / `flushBotTurn` so the re-rendered view contributes a bot turn to `recentTurns`, matching what the dispatcher text path does — otherwise the next referential follow-up ("what about the lamb?") would resolve differently depending on whether the user typed or tapped.

Add the import at the top of `src/telegram/core.ts` (extend the existing `./dispatcher-runner.js` import block — Task 2 added `type ConversationTurn`, this adds three runtime values):

```typescript
import {
  handleReturnToFlowAction,
  wrapSinkForBotTurnCapture,
  flushBotTurn,
  type ConversationTurn,
} from './dispatcher-runner.js';
```

(Task 11 will add `runDispatcherFrontDoor` to this same import block when it wires the front door.)

Find `handleCallback` (Grep for `async function handleCallback`) and add a single case near the other plan-flow callbacks that handles BOTH actions:

```typescript
    if (action === 'plan_resume' || action === 'recipe_resume') {
      // Proposal 003 invariant #7: back-button taps and natural-language
      // "back to X" commands are equivalent. Delegate to the SAME handler
      // the dispatcher uses for `return_to_flow`, so the three-tier
      // fidelity contract (Tier 1 byte-identical for proposal/reviewing,
      // Tier 2 phase-canonical prompt, Tier 3 placeholder keyed on
      // lastRenderedView) applies uniformly whether the user typed or
      // tapped. The synthetic decision object carries no params or
      // response text — the handler reads session state directly.
      //
      // Flow-gone edge case: if the user taps the old inline back button
      // after the flow has been cleared (plan confirmed, recipe saved,
      // etc.), `handleReturnToFlowAction` falls through its active-flow
      // branches into `rerenderLastView`, which reads Plan 027's
      // `lastRenderedView` and emits the Tier 3 placeholder. This is
      // the SAME behavior the natural-language path produces for the
      // same edge case. Earlier drafts of this step had a pair of
      // fallback branches emitting "The planning session has ended."
      // / "The recipe session has ended." + main menu — those
      // fallbacks violated invariant #7 because the dispatcher text
      // path does not produce them. The delegation pattern eliminates
      // the divergence.
      //
      // Bot-turn capture: wrap the sink so the re-rendered view is
      // recorded as a bot turn on `session.recentTurns`, then flush in
      // a `try/finally`. This matches what `runDispatcherFrontDoor`
      // does for the text path: the next dispatcher call needs to see
      // the re-rendered proposal / recipe body in its recent-turns
      // context so referential follow-ups ("what about the lamb?")
      // resolve the same way regardless of whether the user typed
      // "back to the plan" or tapped the inline button. No user turn
      // is pushed — a button tap is not something the user TYPED, so
      // it has no user-side text to record. The asymmetry with the
      // text path (which contributes one user + one bot turn) is
      // intentional and documented in scenario 043's doc comment.
      const wrappedSink = wrapSinkForBotTurnCapture(sink, session);
      try {
        await handleReturnToFlowAction(
          { action: 'return_to_flow', params: {}, reasoning: 'back-button tap' },
          { llm, recipes, store },
          session,
          wrappedSink,
        );
      } finally {
        flushBotTurn(wrappedSink);
      }
      return;
    }
```

**Why one branch for both actions:** `handleReturnToFlowAction` already inspects `session.planFlow` and `session.recipeFlow` to pick the right resume path — it does not need the callback name to know which flow to resume. Merging the two callback cases removes a redundant switch; the button label (`← Back to planning` vs `← Back to recipe`) is set by `buildSideConversationKeyboard` at emission time and is purely cosmetic by the time the callback fires.

**Decision type reminder.** The synthetic decision object uses the `return_to_flow` discriminated union variant from `src/agents/dispatcher.ts`. `reasoning` is optional on the variant (the parser allows it to be absent), so passing a short placeholder string is fine — it will not show up in any user-visible output because `handleReturnToFlowAction`'s `_decision` parameter is underscore-prefixed and unused.

**Why the sink wrap is load-bearing for equivalence.** Proposal 003 combines three requirements that are only jointly satisfied when the button-tap path records the re-render: line 257 says the dispatcher's context includes "Last 3–5 user/bot exchanges" and uses them to "follow referential threads"; line 460 says "Each turn is a fresh dispatch with the updated recent-turns context"; line 466 says natural-language back is equivalent to button taps. If the button-tap re-render is not recorded, then after `text("back") → proposal → text("what about the lamb?")` the dispatcher sees the proposal text and can resolve "lamb", but after `click(plan_resume) → proposal → text("what about the lamb?")` it sees only the older out-of-scope decline and cannot. Wrapping the sink in the callback handler closes that gap — both paths produce the same `recentTurns` content (the proposal body in a bot turn) for the next dispatcher call. The only residual asymmetry is a user turn that exists in the text path (the "ok back to the plan" message) and not in the button path (no typed text); that user turn carries no referential content so it does not affect follow-up resolution. Scenario 043 locks this contract in.

- [ ] **Step 6: Typecheck + test**

Run: `npx tsc --noEmit`
Expected: no errors. `handleReturnToFlowAction` is now imported and called from `core.ts`, closing the loop on the back-button path.

Run: `npm test`
Expected: unchanged from Task 9. The callbacks are reachable via the side-conversation inline keyboard that `buildSideConversationKeyboard` emits, but no scenario exercises that keyboard yet (the runner isn't wired until Task 11 and scenario 043 arrives in Task 19b). No existing behavior changes.

- [ ] **Step 7: Commit**

```bash
git add src/telegram/dispatcher-runner.ts src/telegram/core.ts
git commit -m "Plan 028: return_to_flow handler + plan_resume/recipe_resume callback delegation

Implements handleReturnToFlowAction in dispatcher-runner.ts with the
full three-tier fidelity model (Tier 1 byte-identical for
proposal/reviewing, Tier 2 phase-canonical prompt for other
active-flow phases, Tier 3 placeholder via rerenderLastView for the
no-flow case).

Wires plan_resume and recipe_resume inline callbacks in core.ts'
handleCallback to delegate to the same handleReturnToFlowAction, so
back-button taps and natural-language 'back to X' commands are
structurally equivalent per proposal 003 invariant #7. The flow-gone
edge case now produces the Tier 3 placeholder reply on both paths
instead of diverging to a 'session has ended' menu on the callback
path only."
```

---

### Task 11: Wire the dispatcher into `core.dispatch` as the front door

**Rationale:** This is the "front door flips on" commit. After this task, every inbound text/voice message that isn't a menu button goes through the dispatcher. The tree stays red (scenarios fail) until Task 13 regenerates affected recordings.

**Files:**
- Modify: `src/telegram/core.ts`
- Modify: `src/telegram/dispatcher-runner.ts` — replace the `runDispatcherFrontDoor` stub with the real body.

- [ ] **Step 1: Implement `runDispatcherFrontDoor`**

In `src/telegram/dispatcher-runner.ts`, replace the stub body from Task 8 with:

```typescript
export async function runDispatcherFrontDoor(
  text: string,
  deps: DispatcherRunnerDeps,
  session: DispatcherSession,
  rawSink: DispatcherOutputSink,
  routeToActiveFlow: (text: string, sink: DispatcherOutputSink) => Promise<void>,
  fallback: (sink: DispatcherOutputSink) => Promise<void>,
): Promise<void> {
  // ── Numeric pre-filter (narrow bypass for progress measurement) ──
  // Runs BEFORE the bot-turn wrapper because pre-filter replies are not
  // conversational turns — they're flow outputs that the proposer does
  // not need to see again. This matches the "numeric pre-filter does NOT
  // push turns to recentTurns" decision log entry.
  if (await tryNumericPreFilter(text, session, deps.store, rawSink)) {
    return;
  }

  // ── Planning meta-intents fire BEFORE the dispatcher ──
  // Proposal 003 § "Precedence with existing cancel semantics" is load-bearing:
  // cancel phrases ("never mind", "forget it", etc.) must reach the planning
  // cancel handler, not the dispatcher's return_to_flow. The simplest way to
  // enforce the precedence is to run the existing matcher early and let its
  // result short-circuit the dispatcher.
  //
  // IMPORTANT: no `pushTurn` in this branch AND no bot-turn wrapper around
  // the sink. The cancel short-circuit runs BEFORE any recentTurns
  // bookkeeping — cancel is a flow termination, not a conversational turn,
  // and scenario 041 asserts `recentTurns` stays absent on the recording
  // for this path. Using the raw sink (not the wrapped one) keeps the
  // cancel reply out of the ring buffer and preserves the acceptance
  // criteria.
  if (session.planFlow) {
    const { matchPlanningMetaIntent } = await import('../agents/plan-flow.js');
    const metaIntent = matchPlanningMetaIntent(text);
    if (metaIntent === 'start_over' || metaIntent === 'cancel') {
      // Route back into routeToActiveFlow — `handleTextInput`'s original
      // logic for these cases is still there and handles them correctly.
      await routeToActiveFlow(text, rawSink);
      return;
    }
  }

  // ── Wrap the sink so the LAST bot reply on any branch below lands in
  // `recentTurns` uniformly. Proposal 003 § "Context hydration" requires
  // the dispatcher to see the last 3–5 user/bot exchanges, including
  // replies from downstream flow handlers (re-proposer output, recipe
  // renders) for multi-turn referential threads to work. The wrapper
  // buffers each `sink.reply` overwriting the previous capture, so a
  // recipe-flow turn that emits "Generating your recipe..." followed by
  // the rendered recipe records the recipe — not the holding message.
  // See `wrapSinkForBotTurnCapture` in Task 8 Step 4b for the design
  // notes. ──
  const sink = wrapSinkForBotTurnCapture(rawSink, session);

  // ── Build context bundle ──
  const context = await buildDispatcherContext(session, deps.store, deps.recipes, new Date());

  // ── Push user turn before the LLM call so the dispatcher sees its own
  // message in the recent-turns list (for multi-turn clarify flows). ──
  pushTurn(session, 'user', text);

  // ── Dispatcher call ──
  let decision: DispatcherDecision;
  try {
    decision = await dispatchMessage(context, text, deps.llm);
  } catch (err) {
    if (err instanceof DispatcherFailure) {
      log.error('DISPATCHER', `dispatcher failed; falling back: ${err.message.slice(0, 200)}`);
      try {
        await fallback(sink);
      } finally {
        flushBotTurn(sink);
      }
      return;
    }
    throw err;
  }

  // ── Route the decision to its handler. Every branch receives the
  // wrapped sink. The `try/finally` guarantees `flushBotTurn` runs even
  // if a downstream handler throws — the most recent `sink.reply` is
  // committed to `recentTurns` so the dispatcher sees the actual bot
  // output (not the holding message that came before it) on the next
  // call. ──
  try {
    switch (decision.action) {
      case 'flow_input':
        await handleFlowInputAction(decision, deps, session, sink, text, routeToActiveFlow, fallback);
        return;
      case 'clarify':
        await handleClarifyAction(decision, deps, session, sink);
        return;
      case 'out_of_scope':
        await handleOutOfScopeAction(decision, deps, session, sink);
        return;
      case 'return_to_flow':
        await handleReturnToFlowAction(decision, deps, session, sink);
        return;
    }
  } finally {
    flushBotTurn(sink);
  }
}
```

- [ ] **Step 2: Wire the runner into `core.dispatch`**

In `src/telegram/core.ts`:

1. Delete the transitional alias from Task 6 (`const handleTextInput = routeTextToActiveFlow;`) if it still exists.

2. Add imports at the top of the imports block (near the navigation-state import added in Plan 027):

```typescript
import {
  runDispatcherFrontDoor,
  type ConversationTurn,
} from './dispatcher-runner.js';
```

(Task 2 already added the `type ConversationTurn` import — de-duplicate if needed.)

3. Update the `dispatch()` function's `text` and `voice` branches to call the runner. Find the current dispatch function (Grep for `switch (update.type)`) and replace the text/voice cases with:

```typescript
      case 'voice':
        // Voice is just pre-transcribed text routed through the same path.
        await runDispatcherFrontDoor(
          update.transcribedText,
          { llm, recipes, store },
          session,
          sink,
          routeTextToActiveFlow,
          replyFreeTextFallback,
        );
        return;
      case 'text': {
        // Main menu reply-keyboard taps arrive as text (the button label).
        const menuAction = matchMainMenu(update.text);
        if (menuAction) {
          log.debug('FLOW', `menu: ${menuAction}`);
          await handleMenu(menuAction, sink);
          return;
        }
        await runDispatcherFrontDoor(
          update.text,
          { llm, recipes, store },
          session,
          sink,
          routeTextToActiveFlow,
          replyFreeTextFallback,
        );
        return;
      }
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. If the `DispatcherOutputSink` structural type doesn't match `OutputSink` at the call site, adjust the runner's parameter type or the call site.

- [ ] **Step 4: Run tests (expect major red)**

Run: `npm test`
Expected: **many scenarios fail**. Every scenario that exercises free text (017, 020, 021, 029, and any new test that hits the recipe flow or plan flow via text) will now require at least one new LLM fixture for the dispatcher call, which doesn't exist in the recordings yet. This is intentional. Task 13 regenerates them all.

Count the failures. Write down the list of failing scenarios in a scratch note for Task 13.

Expected failures include (at minimum):
- `017-free-text-fallback` — now routed through the dispatcher.
- `020-planning-intents-from-text` — free text in proposal phase.
- `021-planning-cancel-intent` — "nevermind" is caught by the meta-intent short-circuit before `pushTurn` runs, so `recentTurns` stays absent on the recording. Should pass unchanged — no dispatcher fixture added, no finalSession diff. Verify.
- `029-recipe-flow-happy-path` — free text during recipe flow.
- Any scenario that typed numeric input while in `awaiting_measurement` — now handled by the pre-filter. The final session state should be identical to today's; the intermediate captured outputs should also be identical. Expected to pass, but confirm.

- [ ] **Step 5: Commit (tree intentionally red)**

```bash
git add src/telegram/core.ts src/telegram/dispatcher-runner.ts
git commit -m "Plan 028: wire dispatcher as front door for text/voice

Intentional-red commit. Every free-text message now passes through the
dispatcher LLM call. Scenarios that exercise text will fail because their
recorded.json doesn't have dispatcher fixtures yet. Task 13 regenerates
them.

The numeric pre-filter handles progressFlow.phase === 'awaiting_measurement'
before the dispatcher runs. Planning meta-intents (cancel, start_over)
short-circuit the dispatcher to preserve cancel precedence."
```

---

### Task 12: Cancel-phrase audit + prompt update

**Rationale:** Proposal 003 § "Precedence with existing cancel semantics" requires that `return_to_flow` phrases never overlap with the existing `CANCEL_PATTERNS` set in `plan-flow.ts`. This task is the audit.

**Files:**
- Modify: `src/agents/plan-flow.ts` (doc comment only)
- Modify: `src/agents/dispatcher.ts` (prompt clarification only)

- [ ] **Step 1: Read `CANCEL_PATTERNS` and `START_OVER_PATTERNS`**

Read `src/agents/plan-flow.ts:959–987`. The current patterns:

**START_OVER_PATTERNS:**
- `\bstart\s*over\b`
- `\bstart\s*(from\s*)?scratch\b`
- `\bscrap\s*(this|the\s*plan)?\b`
- `\bre-?do\b`
- `\bre-?plan\b`
- `\bcancel\s+the\s+plan\b`

**CANCEL_PATTERNS:**
- `\bnever\s*mind\b` / `\bnevermind\b`
- `\bforget\s*it\b`
- `\bi'?ll\s*do\s*(this|it)\s*later\b`
- `\bnot\s*now\b`
- `\bstop\s*(planning)?\b`
- `^\s*cancel\s*$`

- [ ] **Step 2: Write down the `return_to_flow` phrase set**

The dispatcher prompt's examples and description for `return_to_flow` use these phrasings:
- "ok back to the plan"
- "let's continue planning"
- "resume planning"
- "keep going"
- "back to my recipes"
- "show me the plan again"
- "back to planning"

- [ ] **Step 3: Check for overlap**

Manually test each return-to-flow phrase against the cancel regex set:

- "ok back to the plan" — no match against any cancel/start-over pattern.
- "let's continue planning" — no match (no "stop planning", it's "continue").
- "resume planning" — no match.
- "keep going" — no match.
- "back to my recipes" — no match.
- "show me the plan again" — no match.
- "back to planning" — no match.

Reverse direction: test each cancel phrase against the dispatcher's return_to_flow examples in the prompt. None of them contain the strings "never mind", "forget it", "later", "stop", or "^cancel$".

**Conclusion:** No overlap. Cancel precedence is preserved because (a) cancel phrases don't contain "back" / "continue" / "resume" / "keep going" / "again", and (b) the runner calls `matchPlanningMetaIntent` BEFORE the dispatcher when a planning flow is active, so "nevermind" during planning always reaches the cancel handler first.

- [ ] **Step 4: Add a precedence doc comment above `CANCEL_PATTERNS`**

In `src/agents/plan-flow.ts`, immediately above the `CANCEL_PATTERNS` declaration (around line 968), add:

```typescript
/**
 * Plan 028 precedence rule (Plan C): cancel phrases always win over the
 * dispatcher's `return_to_flow` action. The runner (`dispatcher-runner.ts`
 * `runDispatcherFrontDoor`) calls `matchPlanningMetaIntent` BEFORE invoking
 * the dispatcher when `session.planFlow` is active, so a "nevermind" typed
 * during planning reaches the cancel branch below — never the dispatcher.
 *
 * The phrase sets are disjoint: cancel phrases contain "never", "forget",
 * "later", "stop", or bare "cancel"; return_to_flow phrases contain "back",
 * "continue", "resume", "keep going", or "again". Any new phrase added to
 * either set must preserve this disjointness — see Plan 028 Task 12 for
 * the verification protocol.
 */
```

(Do not change the pattern list itself.)

- [ ] **Step 5: Typecheck + test**

Run: `npx tsc --noEmit`
Expected: no errors (doc-comment-only change).

Run: `npm test`
Expected: same state as end of Task 11 (many scenarios red, pending Task 13 regeneration).

- [ ] **Step 6: Commit**

```bash
git add src/agents/plan-flow.ts
git commit -m "Plan 028: document cancel-precedence rule above CANCEL_PATTERNS"
```

---

### Task 13: Regenerate affected scenario recordings

**Rationale:** The dispatcher is now the front door for every text/voice message. Each scenario that fires free text now produces an additional LLM call (the dispatcher) that needs to land in `llmFixtures`. For scenarios where the dispatcher picks `flow_input`, the downstream flow handler output is unchanged — but the fixture list grows. For scenario 017 the user-visible output changes (it's now dispatcher-authored decline copy instead of the legacy fallback copy). Regeneration is mechanical for the first case and behavioral-review-sensitive for the second.

**Files:** regenerated `recorded.json` files only.

- [ ] **Step 1: Collect the failing scenario list from Task 11**

Run: `npm test`
Expected: the same set of scenarios fail as at end of Task 11. Write down the list.

Probable failures:
- `017-free-text-fallback` — dispatcher behavior change (fixture AND output change).
- `020-planning-intents-from-text` — free text in proposal (fixture add, output unchanged).
- `021-planning-cancel-intent` — cancel phrase short-circuits before dispatcher; **may pass unchanged**, depends on whether `pushTurn` is called (it isn't, because the cancel branch short-circuits before `pushTurn`). Verify.
- `029-recipe-flow-happy-path` — free text during recipe flow (fixture add, output unchanged).

Any other scenarios that fire free text (`text(...)` events with non-menu labels) will also fail.

**If the failure count exceeds 10** or if any failure is for a scenario that only uses button taps, STOP and investigate — Task 11's wiring may have broken something beyond free-text routing.

- [ ] **Step 2: Regenerate affected scenarios in parallel**

Per CLAUDE.md's `feedback_regenerate_workflow.md`: "delete before regenerate". Also per CLAUDE.md: "regenerate in parallel, review serially". For each failing scenario `NNN-name`, delete its `recorded.json` and launch `npm run test:generate -- NNN-name --regenerate --yes` in parallel.

**Fixture-edited scenarios:** if any failing scenario has a `fixture-edits.md` file, use `npm run test:replay -- <name>` instead of `--regenerate` — `--regenerate` would overwrite the manual edits. Run `ls test/scenarios/*/fixture-edits.md` to find them.

Wait for all regenerations to finish before moving to review.

- [ ] **Step 3: Behavioral review — serial, one scenario at a time**

Per CLAUDE.md's "Verifying recorded output" protocol (`docs/product-specs/testing.md` § "Verifying recorded output"), read each regenerated recording as if you were the user. Follow the 5-step protocol from CLAUDE.md `feedback_scenario_quality_review.md`. Specifically check:

1. **`017-free-text-fallback`:** the three text events ("hello there", "🛒 Shopping List", "xyz random text 123") now produce dispatcher-authored replies. The "🛒 Shopping List" is still caught by `matchMainMenu` and bypasses the dispatcher (no fixture added for it). The "hello there" and "xyz random text 123" turns now each have a dispatcher LLM fixture AND are answered by `clarify` or `out_of_scope`. Verify the replies feel honest and non-generic. If the dispatcher picks `out_of_scope` for "hello there", reconsider — "hello" is a greeting, more appropriate for `clarify` with a warm "What would you like to do?" response. If the LLM's choice feels wrong, don't patch the fixture — reconsider the prompt. This is where Plan C's prompt design gets its first real-world test.

2. **`020-planning-intents-from-text`:** the mutation request ("Put the flex meal on Sunday instead") now goes through the dispatcher, which should pick `flow_input` and forward to the existing re-proposer path. The captured reply text should be byte-for-byte identical to the pre-Plan-028 recording. Two intentional diffs WILL appear in `llmFixtures` / `finalSession`: (a) a new dispatcher fixture upstream of the re-proposer for each free-text turn, and (b) a new `recentTurns` entry on `finalSession` — one user turn per free-text message plus one bot turn per turn captured by the sink wrapper. If the captured REPLY text differs (e.g., slightly different phrasing from the re-proposer due to clock drift, or different batch ordering), investigate. For "Start over", the cancel-precedence rule kicks in BEFORE the dispatcher AND before the wrapper; this turn should have NO dispatcher fixture AND should not contribute to `recentTurns`.

3. **`021-planning-cancel-intent`:** the "nevermind" turn is caught by `matchPlanningMetaIntent` in the runner's pre-dispatcher short-circuit. Verify there is NO dispatcher fixture for this turn. The `finalSession` should show `planFlow === null` (cancelled) and `recentTurns` absent from the recording (the field is optional; `pushTurn` was never called so `JSON.stringify` drops the `undefined`). If `recentTurns` appears in the recording with an entry, Task 11's `pushTurn` placement is wrong — fix it.

4. **`029-recipe-flow-happy-path`:** each free-text turn during the recipe flow (preferences description, refinement text) adds a dispatcher fixture upstream and contributes a user+bot pair to `recentTurns` via the sink wrapper. The bot turn is the head of the **rendered recipe MarkdownV2**, NOT the "Generating your recipe…" / "Refining your recipe..." holding message that the recipe handler emits before the substantive reply (`core.ts:1230`, `core.ts:1245`). The wrapper's last-reply policy is what makes this work — buffer each `sink.reply` overwriting the previous capture, then `flushBotTurn` commits the most recent. The recipe generation / refinement LLM calls are unchanged. Verify the captured REPLY text is byte-for-byte identical except for the new dispatcher fixtures in `llmFixtures` and the expected `recentTurns` growth on `finalSession`. **If `recentTurns[1].text` starts with "Generating your recipe" the wrapper has bugged out — the fix is to confirm `flushBotTurn` runs in the runner's `try/finally`, not inside any handler's mid-call code.**

Any recording that fails behavioral review is a red flag: either the prompt is bad or a handler has a bug. Don't commit a bad recording.

- [ ] **Step 4: Confirm `npm test` is fully green**

Run: `npm test`
Expected: PASS for every scenario. Unit test count same as end of Task 9 plus the context-builder tests from Task 8 (6).

- [ ] **Step 5: Commit**

```bash
git add test/scenarios/*/recorded.json
git commit -m "Plan 028: regenerate scenarios affected by dispatcher front door

Regenerated scenarios with new dispatcher fixtures for free-text turns.
Cancel-phrase scenarios (021) are unchanged — the meta-intent short-circuit
runs before the dispatcher. Recipe-flow and planning-mutation scenarios
add exactly one dispatcher fixture per free-text turn; their downstream
LLM calls and captured outputs are unchanged.

Scenario 017 (free-text-fallback) is now dispatcher-driven: the replies
are authored by the dispatcher's clarify/out_of_scope actions instead of
the legacy fallback copy. Behaviorally reviewed."
```

Include the list of regenerated scenarios in the commit body.

---

### Task 14: Scenario 037 — dispatcher picks `flow_input` during planning mutation

**Rationale:** The positive path for `flow_input` during an active planning proposal phase. Verifies that (a) the dispatcher routes mutation text to the re-proposer unchanged, (b) `planFlow` state is preserved, (c) `recentTurns` grows correctly, (d) the final user-visible output matches today's re-proposer behavior.

This is structurally similar to scenario 020 but written fresh as a Plan 028 regression lock — 020 is a broader happy path; 037 isolates the dispatcher-to-re-proposer handoff and makes it easy to debug if that handoff breaks.

**Files:**
- Create: `test/scenarios/037-dispatcher-flow-input-planning/spec.ts`
- Create: `test/scenarios/037-dispatcher-flow-input-planning/recorded.json` (generated)

- [ ] **Step 1: Write the scenario spec**

Create `test/scenarios/037-dispatcher-flow-input-planning/spec.ts` with:

```typescript
/**
 * Scenario 037 — dispatcher picks flow_input during planning proposal phase.
 *
 * Plan 028 (Plan C). Verifies that the dispatcher correctly classifies
 * mutation text during an active planning flow as flow_input, forwards to
 * the existing re-proposer path, and preserves planFlow state + grows
 * recentTurns.
 *
 * Sequence:
 *   1. /start
 *   2. Tap 📋 Plan Week (lifecycle: no_plan → planning)
 *   3. Tap plan_keep_breakfast
 *   4. Tap plan_no_events
 *   5. (plan-proposer runs, proposal rendered)
 *   6. Type "Move the flex to Sunday" — dispatcher picks flow_input, routes
 *      to handleMutationText, re-proposer regenerates, diff rendered.
 *   7. Tap plan_approve
 *
 * Assertions come from the recorded outputs (rendered plan with flex on
 * Sunday) and finalSession.planFlow === null (confirmed). recentTurns
 * should contain one user turn ("Move the flex to Sunday") followed by
 * one bot turn whose text is the head of the re-proposer's substantive
 * reply (the diff + new proposal text, truncated to BOT_TURN_TEXT_MAX).
 * If the re-proposer emitted a holding message before the diff (e.g.
 * "Updating your plan…"), the wrapper's last-reply policy ensures the
 * holding message is overwritten and only the substantive reply is
 * committed to recentTurns. flow_input DOES contribute a bot turn: the
 * wrapped sink in runDispatcherFrontDoor buffers replies and the
 * runner's try/finally calls flushBotTurn after the handler returns,
 * so proposal 003's "last 3–5 user/bot exchanges" contract is satisfied
 * uniformly across every action branch.
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '037-dispatcher-flow-input-planning',
  description:
    'Dispatcher routes mutation text during planning proposal phase to flow_input → re-proposer. Validates state preservation and recentTurns bookkeeping.',
  clock: '2026-04-05T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [],
    batches: [],
  },
  events: [
    command('start'),
    text('📋 Plan Week'),
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    text('Move the flex to Sunday'),
    click('plan_approve'),
  ],
});
```

- [ ] **Step 2: Generate the recording**

Run: `npm run test:generate -- 037-dispatcher-flow-input-planning --yes`
Expected: recording created. Fixtures will include the plan-proposer call, the dispatcher call, the re-proposer call, and any scaler / recipe-generation calls the re-proposer triggers.

- [ ] **Step 3: Behavioral review**

Apply the 5-step protocol from `docs/product-specs/testing.md`:

1. The initial plan proposal covers all meal slots for the planned week.
2. The mutation response shifts the flex to Sunday; no ghost batches, no orphan slots.
3. Cook days match first eating days.
4. Weekly totals are reasonable (within the target calorie range).
5. `finalSession.planFlow === null` (approved + confirmed).
6. `finalSession.recentTurns` contains exactly one user turn with `text: "Move the flex to Sunday"` followed by a bot turn whose `text` is the head of the re-proposer's **substantive** reply (the rendered diff + new proposal — first ~500 chars). If the recording shows the holding message ("Updating your plan…" or similar) instead of the proposal text, the wrapper's last-reply policy is broken — re-verify that `flushBotTurn` runs in the runner's `try/finally` AFTER the action handler returns and that the wrapper overwrites `lastCapture` on every `sink.reply`. If the recording shows no bot turn at all, `wrapSinkForBotTurnCapture` is not installed on `runDispatcherFrontDoor` correctly.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all scenarios green.

- [ ] **Step 5: Commit**

```bash
git add test/scenarios/037-dispatcher-flow-input-planning/
git commit -m "Plan 028: scenario 037 — dispatcher flow_input during planning"
```

---

### Task 15: Scenario 038 — dispatcher picks `out_of_scope`

**Rationale:** The canonical out-of-domain decline. Simple, cheap, and a regression test for the prompt's out-of-scope handling. Single dispatcher LLM call, no downstream flow calls.

**Files:**
- Create: `test/scenarios/038-dispatcher-out-of-scope/spec.ts`
- Create: `test/scenarios/038-dispatcher-out-of-scope/recorded.json` (generated)

- [ ] **Step 1: Write the scenario spec**

Create `test/scenarios/038-dispatcher-out-of-scope/spec.ts`:

```typescript
/**
 * Scenario 038 — dispatcher out_of_scope decline.
 *
 * Plan 028 (Plan C). Verifies that the dispatcher correctly declines an
 * out-of-domain message with a short, specific, lifecycle-aware reply.
 *
 * Sequence:
 *   1. /start (no plan yet)
 *   2. Type "what's the weather today?"
 *
 * Expected: dispatcher picks out_of_scope with category="weather" and a
 * response that mentions meal planning and offers the menu.
 *
 * finalSession.recentTurns should contain one user turn and one bot turn
 * (the dispatcher's decline).
 */

import { defineScenario, command, text } from '../../../src/harness/define.js';

export default defineScenario({
  name: '038-dispatcher-out-of-scope',
  description:
    'Dispatcher declines an out-of-domain request with out_of_scope and offers the menu. No downstream LLM calls.',
  clock: '2026-04-10T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [],
    batches: [],
  },
  events: [
    command('start'),
    text("what's the weather today?"),
  ],
});
```

- [ ] **Step 2: Generate + review + commit**

Run: `npm run test:generate -- 038-dispatcher-out-of-scope --yes`

Review the recording:
- The reply to the weather question is short, honest, and mentions meal planning.
- A lifecycle-aware keyboard is attached (since lifecycle=no_plan, the keyboard has "📋 Plan Week" as the first button).
- `finalSession.recentTurns` has 2 entries: `[{ role: 'user', text: "what's the weather today?" }, { role: 'bot', text: "..." }]`.

Run: `npm test` → PASS.

Commit:
```bash
git add test/scenarios/038-dispatcher-out-of-scope/
git commit -m "Plan 028: scenario 038 — dispatcher out_of_scope decline"
```

---

### Task 16: Scenario 039 — dispatcher `return_to_flow` during planning

**Rationale:** The return-to-flow re-render path with an active planning flow. User is mid-planning (proposal phase), types an off-topic side question (dispatcher picks `out_of_scope` but planFlow stays alive), then types "ok back to the plan" (dispatcher picks `return_to_flow`, handler re-renders the proposal). State preservation test.

**Files:**
- Create: `test/scenarios/039-dispatcher-return-to-flow/spec.ts`
- Create: `test/scenarios/039-dispatcher-return-to-flow/recorded.json` (generated)

- [ ] **Step 1: Write the scenario spec**

Create `test/scenarios/039-dispatcher-return-to-flow/spec.ts`:

```typescript
/**
 * Scenario 039 — dispatcher return_to_flow during planning.
 *
 * Plan 028 (Plan C). The state-preservation regression test: a side
 * conversation mid-planning does NOT clobber planFlow, and the user can
 * return via natural language.
 *
 * Sequence:
 *   1. /start
 *   2. Tap 📋 Plan Week
 *   3. Tap plan_keep_breakfast
 *   4. Tap plan_no_events  (proposal rendered)
 *   5. Type "what's the weather today?" — dispatcher picks out_of_scope,
 *      planFlow stays at phase === 'proposal'.
 *   6. Type "ok back to the plan" — dispatcher picks return_to_flow, the
 *      handler re-renders the proposal from planFlow.proposalText.
 *   7. Tap plan_approve.
 *
 * Assertions (from captured outputs):
 *   - Step 5's reply is a short out_of_scope decline + menu.
 *   - Step 6's reply is the stored proposalText with the planProposalKeyboard.
 *   - Step 7 confirms the plan successfully.
 *   - finalSession.planFlow === null (confirmed).
 *   - finalSession.recentTurns contains four entries:
 *       1. user "what's the weather today?"
 *       2. bot "<decline text>"          (wrapped-sink capture, out_of_scope)
 *       3. user "ok back to the plan"
 *       4. bot "<proposalText head>"      (wrapped-sink capture, return_to_flow)
 *     return_to_flow DOES push a bot turn via the wrapped sink — the
 *     re-rendered proposal is a reply like any other. The proposal 003
 *     context-hydration contract is what makes this right: the next
 *     dispatcher call needs to see the proposal text in history to
 *     resolve follow-up references ("move the monday one instead").
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '039-dispatcher-return-to-flow',
  description:
    'Side question during planning proposal phase routes to out_of_scope; "ok back to the plan" routes to return_to_flow and re-renders the proposal. planFlow survives the side trip.',
  clock: '2026-04-05T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [],
    batches: [],
  },
  events: [
    command('start'),
    text('📋 Plan Week'),
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    text("what's the weather today?"),
    text('ok back to the plan'),
    click('plan_approve'),
  ],
});
```

- [ ] **Step 2: Generate + review + commit**

Run: `npm run test:generate -- 039-dispatcher-return-to-flow --yes`

Review:
- Step 5: the out-of-scope decline is appropriate AND the captured keyboard is the **inline `← Back to planning` button** (`InlineKeyboard` with a single `plan_resume` callback), NOT the main menu reply keyboard. This is the proposal 003 state-preservation invariant #3 assertion. If the captured keyboard is the main menu, Task 9's `buildSideConversationKeyboard` incorrectly fell through to the no-flow branch — investigate.
- Step 6: the reply text matches the stored `proposalText` (the proposal from step 4), and the keyboard is `planProposalKeyboard`. The dispatcher picked `return_to_flow`, which invoked `handleReturnToFlowAction` → `rerenderPlanFlow` → emitted the stored proposal text.
- Step 7: plan approval proceeds normally.
- `finalSession.planFlow` is `null` after `plan_approve`.

**Critical state check:** before step 6's `return_to_flow` reply, `planFlow.phase` must still be `'proposal'` AND `planFlow.proposal` / `proposalText` must still be populated from step 4. The only way this scenario passes is if the dispatcher's `out_of_scope` handler genuinely left `planFlow` untouched. If the recording shows a "no planFlow" branch in step 6, state preservation is broken in Task 9 — investigate and fix.

Run: `npm test` → PASS.

Commit:
```bash
git add test/scenarios/039-dispatcher-return-to-flow/
git commit -m "Plan 028: scenario 039 — return_to_flow re-renders proposal after side question"
```

---

### Task 17: Scenario 040 — dispatcher `clarify` multi-turn

**Rationale:** The clarify action is load-bearing for ambiguous input. This scenario exercises the multi-turn flow: user types something unclear, dispatcher asks a clarifying question, user answers, dispatcher resolves. Tests that `recentTurns` carries the clarification context into the second dispatcher call.

**Files:**
- Create: `test/scenarios/040-dispatcher-clarify-multiturn/spec.ts`
- Create: `test/scenarios/040-dispatcher-clarify-multiturn/recorded.json` (generated)

- [ ] **Step 1: Write the scenario spec**

Create `test/scenarios/040-dispatcher-clarify-multiturn/spec.ts`:

```typescript
/**
 * Scenario 040 — dispatcher clarify multi-turn.
 *
 * Plan 028 (Plan C). Exercises the clarify → user answers → dispatch again
 * path. Verifies recentTurns carries the clarification context into turn 2
 * so the dispatcher can resolve.
 *
 * Sequence:
 *   1. /start (no plan)
 *   2. Type "hmm" — dispatcher picks clarify with a "what would you like
 *      to do?" question.
 *   3. Type "I want to plan a week" — dispatcher picks clarify again (or
 *      out_of_scope — neither show_plan nor mutate_plan exist) with an
 *      honest "Tap 📋 Plan Week to start" reply.
 *
 * The test verifies that (a) both turns produce dispatcher fixtures, (b)
 * the second dispatcher call sees turn 1's bot response in its recent-turns
 * context, (c) neither turn mutates planFlow / recipeFlow / progressFlow,
 * (d) recentTurns has all 4 entries (2 user + 2 bot).
 */

import { defineScenario, command, text } from '../../../src/harness/define.js';

export default defineScenario({
  name: '040-dispatcher-clarify-multiturn',
  description:
    'Dispatcher clarify with a follow-up turn; recentTurns carries the clarification into the second dispatch.',
  clock: '2026-04-10T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [],
    batches: [],
  },
  events: [
    command('start'),
    text('hmm'),
    text('I want to plan a week'),
  ],
});
```

- [ ] **Step 2: Generate + review + commit**

Run: `npm run test:generate -- 040-dispatcher-clarify-multiturn --yes`

Review:
- Turn 1 ("hmm"): the dispatcher's clarify response is a short, welcoming "What would you like to do?" style question.
- Turn 2 ("I want to plan a week"): the dispatcher picks an action that either (a) honestly declines with a pointer to the 📋 Plan Week button (preferred — `out_of_scope` or `clarify` with the specific hint), or (b) picks `flow_input` with no active flow (which then falls into `handleFlowInputAction`'s defensive branch, calls `replyFreeTextFallback`, and produces the generic hint). Either outcome is acceptable for the minimal catalog; the test locks in whichever the dispatcher produces.
- `finalSession.recentTurns` length should be 4 (2 user + 2 bot).
- `finalSession.planFlow === null` (no planning started — the user typed but never tapped the button).

Run: `npm test` → PASS.

Commit:
```bash
git add test/scenarios/040-dispatcher-clarify-multiturn/
git commit -m "Plan 028: scenario 040 — dispatcher clarify multi-turn with recentTurns"
```

---

### Task 18: Scenario 041 — cancel precedence regression lock

**Rationale:** Locks in the rule that cancel phrases route through the planning cancel handler BEFORE the dispatcher when a planning flow is active. If a future change accidentally routes "nevermind" through the dispatcher, this scenario fails loudly. Zero LLM calls — the cancel short-circuit is pure regex.

**Files:**
- Create: `test/scenarios/041-dispatcher-cancel-precedence/spec.ts`
- Create: `test/scenarios/041-dispatcher-cancel-precedence/recorded.json` (generated)

- [ ] **Step 1: Write the scenario spec**

Create `test/scenarios/041-dispatcher-cancel-precedence/spec.ts`:

```typescript
/**
 * Scenario 041 — cancel-vs-return_to_flow precedence regression lock.
 *
 * Plan 028 (Plan C). The cancel phrase set and the dispatcher's
 * return_to_flow phrase set are disjoint, and the runner calls
 * matchPlanningMetaIntent BEFORE the dispatcher when a planning flow is
 * active. This scenario fails loudly if a future change accidentally
 * routes "nevermind" through the dispatcher.
 *
 * Sequence:
 *   1. /start
 *   2. Tap 📋 Plan Week
 *   3. Tap plan_keep_breakfast
 *   4. Tap plan_no_events  (proposal rendered)
 *   5. Type "nevermind"  — must hit matchPlanningMetaIntent('cancel')
 *      BEFORE the dispatcher runs. No dispatcher fixture should appear
 *      for this turn. planFlow is cleared, surface returns to menu.
 *
 * Expected llmFixtures: only the plan-proposer fixture(s) from step 4.
 * No dispatcher fixture for the "nevermind" turn. No re-proposer fixture
 * either (the cancel short-circuit runs well before handleMutationText).
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '041-dispatcher-cancel-precedence',
  description:
    'Cancel phrase short-circuits the dispatcher during active planning. No dispatcher fixture for the cancel turn.',
  clock: '2026-04-05T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [],
    batches: [],
  },
  events: [
    command('start'),
    text('📋 Plan Week'),
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    text('nevermind'),
  ],
});
```

- [ ] **Step 2: Generate + review + commit**

Run: `npm run test:generate -- 041-dispatcher-cancel-precedence --yes`

Review:
- `finalSession.planFlow === null` (cancelled).
- `finalSession.surfaceContext === null` (the cancel handler clears it).
- `finalSession.recentTurns` is **absent** (the field is optional, `pushTurn` was never called, and `JSON.stringify` drops undefined). This is the critical assertion. The cancel short-circuit runs BEFORE `pushTurn`, so "nevermind" is never added to recentTurns. If `recentTurns` appears in the recording with an entry, Task 11 pushed the user turn before checking the meta-intent — fix by moving `pushTurn` to AFTER the cancel short-circuit.
- `llmFixtures` contains fixture(s) for the plan-proposer call at step 4, but NO dispatcher fixture. Verify by inspecting the fixture array: each fixture has a `context` field (part of the `CompletionOptions` call metadata, though the hash excludes it). Fixtures with `context: 'dispatcher'` should NOT appear.

**Critical check:** if you see a `context: 'dispatcher'` fixture, the cancel short-circuit is in the wrong place in the runner. Before regenerating a fix, trace through `runDispatcherFrontDoor`'s logic:

```
numeric pre-filter → cancel meta-intent → build context → pushTurn → dispatch → route
```

The cancel short-circuit must run BEFORE the context build AND BEFORE `pushTurn`, and must explicitly early-return. If it does not, fix the runner, rerun generation.

Run: `npm test` → PASS.

Commit:
```bash
git add test/scenarios/041-dispatcher-cancel-precedence/
git commit -m "Plan 028: scenario 041 — cancel precedence regression lock"
```

---

### Task 19: Scenario 042 — numeric pre-filter bypass

**Rationale:** Locks in the numeric pre-filter behavior. Verifies that a parseable measurement during `awaiting_measurement` is handled without a dispatcher LLM call, AND that a non-parseable message in the SAME phase goes through the dispatcher normally. Also exercises the "after measurement, text goes through dispatcher" path.

**Files:**
- Create: `test/scenarios/042-dispatcher-numeric-prefilter/spec.ts`
- Create: `test/scenarios/042-dispatcher-numeric-prefilter/recorded.json` (generated)

- [ ] **Step 1: Write the scenario spec**

Create `test/scenarios/042-dispatcher-numeric-prefilter/spec.ts`:

```typescript
/**
 * Scenario 042 — numeric pre-filter bypass + post-measurement dispatch.
 *
 * Plan 028 (Plan C). Verifies two behaviors:
 *   - Numeric input during awaiting_measurement is handled by the runner's
 *     tryNumericPreFilter before the dispatcher runs (no dispatcher fixture).
 *   - After the measurement is logged, the progressFlow is cleared, and
 *     any subsequent free text goes through the dispatcher normally.
 *
 * Sequence:
 *   1. /start
 *   2. Tap 📊 Progress (enters awaiting_measurement)
 *   3. Type "82.3"  — numeric pre-filter logs it, progressFlow cleared
 *   4. Type "how am I doing?"  — dispatcher picks clarify or out_of_scope
 *
 * Expected:
 *   - No dispatcher fixture for turn 3 (pre-filter short-circuits).
 *   - One dispatcher fixture for turn 4.
 *   - finalStore.measurements has one entry for today (82.3, null waist).
 *   - finalSession.progressFlow === null.
 *   - finalSession.recentTurns has two entries for turn 4: the user's
 *     "how am I doing?" and the dispatcher's reply. No entries for the
 *     numeric input — the pre-filter does not push turns.
 */

import { defineScenario, command, text } from '../../../src/harness/define.js';

export default defineScenario({
  name: '042-dispatcher-numeric-prefilter',
  description:
    'Numeric pre-filter short-circuits dispatcher for awaiting_measurement; subsequent text dispatches normally.',
  clock: '2026-04-10T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [],
    batches: [],
  },
  events: [
    command('start'),
    text('📊 Progress'),
    text('82.3'),
    text('how am I doing?'),
  ],
});
```

- [ ] **Step 2: Generate + review + commit**

Run: `npm run test:generate -- 042-dispatcher-numeric-prefilter --yes`

Review:
- Turn 3 ("82.3") produces NO dispatcher fixture. The output is the measurement confirmation with the first-measurement hint text.
- Turn 4 ("how am I doing?") produces exactly ONE dispatcher fixture. The output is a clarify or out_of_scope response.
- `finalStore.measurements` has exactly one entry for `2026-04-10` with weight 82.3 and waist null.
- `finalSession.progressFlow === null`.
- `finalSession.recentTurns.length === 2` — just the turn 4 user message and the turn 4 bot reply.

**Critical check:** if `recentTurns` has turn 3 ("82.3") in it, the pre-filter is calling `pushTurn` when it shouldn't — the pre-filter's job is to short-circuit entirely, so it must not modify `recentTurns`. Remove any `pushTurn` call from `tryNumericPreFilter` if present (it shouldn't be — re-verify Task 8).

Run: `npm test` → PASS.

Commit:
```bash
git add test/scenarios/042-dispatcher-numeric-prefilter/
git commit -m "Plan 028: scenario 042 — numeric pre-filter bypass + post-measurement dispatch"
```

---

### Task 19b: Scenario 043 — `plan_resume` back-button callback equivalence

**Rationale:** Scenario 039 proves that typing "ok back to the plan" re-renders the active planning proposal. It does NOT prove that tapping the inline `← Back to planning` button produces the same behavior — the button-tap path goes through `handleCallback` → `plan_resume` → `handleReturnToFlowAction` (Task 10 Step 5), which is a different entry point from the dispatcher's `return_to_flow` text path. Proposal 003 invariant #7 ("natural-language back commands are equivalent to back-button taps") requires the two paths to produce the same result, and Plan 028 satisfies it by delegating both to `handleReturnToFlowAction` — but without a scenario that actually clicks the button, the callback case is an unproven branch.

Scenario 043 closes the gap. Sequence mirrors 039 exactly except for step 6: instead of typing "ok back to the plan", the user clicks the inline `plan_resume` button that was attached to step 5's out-of-scope reply via `buildSideConversationKeyboard`. The reply text at step 6 must be byte-identical to scenario 039 step 6 (same stored `proposalText`, same `planProposalKeyboard`) — that is the regression lock for invariant #7.

**Files:**
- Create: `test/scenarios/043-dispatcher-plan-resume-callback/spec.ts`
- Create: `test/scenarios/043-dispatcher-plan-resume-callback/recorded.json` (generated)

- [ ] **Step 1: Write the scenario spec**

Create `test/scenarios/043-dispatcher-plan-resume-callback/spec.ts`:

```typescript
/**
 * Scenario 043 — plan_resume back-button callback equivalence.
 *
 * Plan 028 (Plan C). Regression lock for proposal 003 invariant #7:
 * natural-language back commands and back-button taps must produce
 * identical bot output. Scenario 039 exercises the natural-language
 * path ("ok back to the plan" → dispatcher → return_to_flow →
 * handleReturnToFlowAction → rerenderPlanFlow → stored proposalText).
 * This scenario exercises the callback path (plan_resume click →
 * handleCallback → handleReturnToFlowAction → rerenderPlanFlow →
 * stored proposalText). Both paths converge on handleReturnToFlowAction,
 * so the output at step 6 must be byte-identical to scenario 039's
 * step 6 output.
 *
 * Sequence:
 *   1. /start
 *   2. Tap 📋 Plan Week
 *   3. Tap plan_keep_breakfast
 *   4. Tap plan_no_events  (proposal rendered + stored on planFlow.proposalText)
 *   5. Type "what's the weather today?" — dispatcher picks out_of_scope,
 *      the reply carries an inline [← Back to planning] button via
 *      buildSideConversationKeyboard. planFlow stays at phase === 'proposal'.
 *   6. Click plan_resume  — handleCallback delegates to
 *      handleReturnToFlowAction, which calls rerenderPlanFlow, which
 *      emits the stored proposalText + planProposalKeyboard.
 *   7. Tap plan_approve.
 *
 * Assertions (from captured outputs):
 *   - Step 5's reply is a short out_of_scope decline + the inline
 *     [← Back to planning] button (plan_resume callback_data).
 *   - Step 6's reply text matches the stored proposalText from step 4
 *     byte-for-byte, and the keyboard is planProposalKeyboard.
 *     Crucially, NO dispatcher LLM fixture is added for step 6 — the
 *     callback path does not go through runDispatcherFrontDoor.
 *   - Step 7 confirms the plan successfully.
 *   - finalSession.planFlow === null (confirmed).
 *   - finalSession.recentTurns contains exactly THREE entries — the
 *     user turn "what's the weather today?" and the bot decline from
 *     step 5's dispatcher turn (captured via the wrapped sink in
 *     runDispatcherFrontDoor), PLUS the bot proposal re-render from
 *     step 6's button tap (captured via a local wrapSinkForBotTurnCapture
 *     around handleReturnToFlowAction inside handleCallback). The
 *     button tap contributes a bot turn but no user turn — there's
 *     no typed text, so there's nothing to push as role='user'. This
 *     matters for referential follow-up resolution: after step 6,
 *     recentTurns contains the proposal body, so a subsequent
 *     "what about the lamb?" would resolve against the proposal's
 *     actual contents regardless of whether the user got here by
 *     typing or tapping. The asymmetry with scenario 039 (which has
 *     4 entries because the text path adds an extra user turn for
 *     "ok back to the plan") is bounded to one content-free user
 *     turn and does NOT affect the dispatcher's ability to resolve
 *     referential threads on the next turn.
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '043-dispatcher-plan-resume-callback',
  description:
    'plan_resume inline back-button re-renders the planning proposal via handleReturnToFlowAction delegation. Regression lock for proposal 003 invariant #7 (button-tap / natural-language equivalence).',
  clock: '2026-04-05T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [],
    batches: [],
  },
  events: [
    command('start'),
    text('📋 Plan Week'),
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    text("what's the weather today?"),
    click('plan_resume'),
    click('plan_approve'),
  ],
});
```

- [ ] **Step 2: Generate + review + commit**

Run: `npm run test:generate -- 043-dispatcher-plan-resume-callback --yes`

Review (5-step protocol from `docs/product-specs/testing.md`):

1. Step 4 produces a valid plan proposal with all slots covered (same as scenario 039 — the plan itself is not the regression lock here).
2. Step 5's out-of-scope reply is short and non-generic, AND the captured keyboard is the inline `← Back to planning` button (`InlineKeyboard` with callback_data `plan_resume`), NOT the main menu reply keyboard. If the captured keyboard is the main menu, `buildSideConversationKeyboard` incorrectly fell through to the no-flow branch — investigate.
3. **Step 6 is the critical assertion:** the reply text must match the stored `proposalText` from step 4 AND the keyboard must be `planProposalKeyboard` AND the parse mode must be `MarkdownV2`. Open scenario 039's `recorded.json` side by side and verify step 6's output is byte-for-byte identical between the two scenarios — modulo the different scenario names in the recording metadata. This is what proves invariant #7 is real.
4. **`llmFixtures`:** step 6 MUST NOT add a dispatcher fixture. The callback path does not go through `runDispatcherFrontDoor`, so no `context: 'dispatcher'` fixture should appear for the `plan_resume` click. If you see one, something has wired the button tap through the dispatcher by accident — trace the callback path and fix.
5. **`finalSession.recentTurns`:** exactly 3 entries:
   - `{role: 'user', text: "what's the weather today?"}` (pushed by `runDispatcherFrontDoor` before the dispatcher call at step 5)
   - `{role: 'bot', text: "<out_of_scope decline head>"}` (captured by `wrapSinkForBotTurnCapture` during the dispatcher's `out_of_scope` handler at step 5)
   - `{role: 'bot', text: "<proposalText head>"}` (captured by the `wrapSinkForBotTurnCapture` call Task 10 Step 5 added around the `plan_resume` callback delegation in `handleCallback`)
   Step 6's button tap contributes exactly one bot turn — no user turn, because there's no typed text to push as `role: 'user'`. This 3-entry shape is load-bearing: proposal 003 lines 257 + 460 + 466 require the dispatcher's next call to see the same referential content regardless of whether the user typed "back to the plan" or tapped the button. Having the proposal body in the third entry guarantees that a follow-up like "what about the lamb?" resolves equivalently across both paths. **If `recentTurns.length === 2`**, the callback path's sink wrap or flush is missing — add `wrapSinkForBotTurnCapture` around the `handleReturnToFlowAction` call in `handleCallback`'s `plan_resume` / `recipe_resume` case (see Task 10 Step 5). **If `recentTurns.length === 4`** (matching scenario 039's length), the button tap inadvertently produced a user turn somewhere — check that the callback handler is not calling `pushTurn('user', ...)` anywhere, since button taps have no user text.

**Equivalence verification.** After the recording is generated, do a literal side-by-side comparison of scenario 039's step 6 reply block and scenario 043's step 6 reply block. They should differ only in the scenario metadata (`name`, `description`). If step 6's `text` field differs byte-for-byte between the two recordings, `handleReturnToFlowAction` is producing different output for the two entry points — which is impossible if both scenarios are calling the same function on the same session state, so either (a) the state differs (scenario 043's planFlow was mutated by something), or (b) a non-delegation shim was inadvertently left in the callback case. Trace and fix before committing.

Run: `npm test` → PASS.

Commit:
```bash
git add test/scenarios/043-dispatcher-plan-resume-callback/
git commit -m "Plan 028: scenario 043 — plan_resume back-button callback equivalence

Regression lock for proposal 003 invariant #7: natural-language back
commands and back-button taps must produce identical bot output.
Scenario 039 exercises the text path; scenario 043 exercises the
callback path. Both converge on handleReturnToFlowAction, so step 6's
reply must be byte-for-byte identical between the two recordings."
```

---

### Task 20: Update `test/scenarios/index.md`

**Files:**
- Modify: `test/scenarios/index.md`

- [ ] **Step 1: Append rows for scenarios 037–043**

At the bottom of `test/scenarios/index.md` (after scenario 036 from Plan 027), add:

```markdown
| 037 | dispatcher-flow-input-planning | Dispatcher routes mutation text during planning proposal phase to flow_input → re-proposer. Validates state preservation and recentTurns bookkeeping. Plan 028. |
| 038 | dispatcher-out-of-scope | Dispatcher declines an out-of-domain request with out_of_scope and offers the menu. No downstream LLM calls. Plan 028. |
| 039 | dispatcher-return-to-flow | Side question during planning proposal phase routes to out_of_scope; "ok back to the plan" routes to return_to_flow and re-renders the proposal. planFlow survives the side trip. Plan 028. |
| 040 | dispatcher-clarify-multiturn | Dispatcher clarify with a follow-up turn; recentTurns carries the clarification into the second dispatch. Plan 028. |
| 041 | dispatcher-cancel-precedence | Cancel phrase short-circuits the dispatcher during active planning. No dispatcher fixture for the cancel turn. Plan 028. |
| 042 | dispatcher-numeric-prefilter | Numeric pre-filter short-circuits dispatcher for awaiting_measurement; subsequent text dispatches normally. Plan 028. |
| 043 | dispatcher-plan-resume-callback | plan_resume inline back-button re-renders the planning proposal via handleReturnToFlowAction delegation. Regression lock for proposal 003 invariant #7 (button-tap / natural-language equivalence). Plan 028. |
```

Note: scenario 034 is an isolated gap left by Plan 027's original numbering and is deliberately NOT reused — sequential Plan 028 numbers are clearer than reusing an out-of-order slot.

- [ ] **Step 2: Commit**

```bash
git add test/scenarios/index.md
git commit -m "Plan 028: update scenarios index with 037–043"
```

---

### Task 21: Sync `docs/product-specs/ui-architecture.md` and `testing.md`

**Rationale:** Per CLAUDE.md's docs-maintenance rules, product specs must stay in sync with code behavior in the same branch as the change. Plan 028 introduces a concrete runtime concept (the dispatcher front door) that the UI architecture spec must describe, and the testing spec should note that scenarios exercising free text now include dispatcher LLM fixtures.

**Files:**
- Modify: `docs/product-specs/ui-architecture.md`
- Modify: `docs/product-specs/testing.md`

- [ ] **Step 1: Read the current `ui-architecture.md`**

Read `docs/product-specs/ui-architecture.md` in full. Find the section about the "Freeform conversation layer" that proposal 003 says it will supersede (if still present) and the "Navigation state (Plan 027)" section added by the Plan 027 task 17. Both sections are the anchor points for the new content.

- [ ] **Step 2: Supersede the freeform-conversation-layer sketch with the canonical description**

Replace (or significantly rewrite) the existing "Freeform conversation layer" sketch with the Plan 028 reality. Use this content:

```markdown
## Freeform conversation layer — the dispatcher (Plan 028 / v0.0.5 minimal slice)

Every inbound text and voice message that isn't a slash command, an inline
callback, or a reply-keyboard main-menu tap is routed through a single
LLM-driven **dispatcher** that picks exactly one action from a small
catalog. Plan 028 ships the infrastructure + the minimal action set; Plans
D and E extend the catalog with `mutate_plan`, answers, navigation, and
measurement logging.

### Where the dispatcher sits

`core.dispatch()` branches by update type:

- `command` → `handleCommand` (slash commands; bypass the dispatcher)
- `callback` → `handleCallback` (inline button taps; bypass)
- `text` → `matchMainMenu` first (reply-keyboard main-menu buttons bypass),
  then `runDispatcherFrontDoor`
- `voice` → `runDispatcherFrontDoor` directly (transcription happens in
  `bot.ts`)

`runDispatcherFrontDoor` (in `src/telegram/dispatcher-runner.ts`) is the
integration layer. It:

1. Runs the narrow **numeric pre-filter** — when `progressFlow.phase === 'awaiting_measurement'`
   and the text is parseable as a measurement, the measurement is logged
   inline without an LLM call and WITHOUT recentTurns bookkeeping. See
   `tryNumericPreFilter`.
2. Short-circuits **planning meta-intents** — "nevermind", "forget it",
   "start over" etc. reach the existing cancel / restart handler BEFORE
   the dispatcher runs when `planFlow` is active. The raw sink is used
   here (not the bot-turn wrapper); cancel is a flow termination, not a
   conversational turn, so `recentTurns` stays untouched. See
   `matchPlanningMetaIntent` and the Plan 028 precedence doc comment in
   `plan-flow.ts`.
3. Wraps the sink in `wrapSinkForBotTurnCapture` so every downstream
   action branch (flow_input, clarify, out_of_scope, return_to_flow)
   contributes a bot turn uniformly. The wrapper buffers each
   `sink.reply` (overwriting the previous capture) and the runner
   commits the most recent one via `flushBotTurn` in a `try/finally`
   after the action handler returns. This handles multi-message branches
   like the recipe flow (holding message + substantive reply) correctly:
   only the substantive reply lands in `recentTurns`.
4. Builds the **context bundle** via `buildDispatcherContext` — surface,
   lifecycle, active flow summary, recent turns, plan summary, recipe
   index, allowed actions.
5. Pushes the user turn onto `session.recentTurns` (ring-buffered at 6).
6. Calls `dispatchMessage` (the pure agent in `src/agents/dispatcher.ts`)
   with the context and user text.
7. Dispatches the returned `DispatcherDecision` to the action handler
   inside a `try/finally`. `flushBotTurn(sink)` runs in the `finally`
   block so the most recent `sink.reply` from the handler lands in
   `recentTurns` even if the handler throws.
8. On `DispatcherFailure`, falls back to `replyFreeTextFallback` (still
   routed through the wrapped sink — the fallback message also lands in
   recentTurns so the dispatcher sees it on the next turn).

### v0.0.5 minimal action catalog (Plan 028)

Only four actions are implemented. The dispatcher's prompt describes the
full proposal-003 catalog (including deferred actions) but marks each
unimplemented entry with a clear availability note so the LLM can honestly
defer.

| Action | Implemented | Behavior |
|---|---|---|
| `flow_input` | ✅ Plan 028 | Forward text to the active flow's text handler unchanged. |
| `clarify` | ✅ Plan 028 | Dispatcher asks a clarifying question; state unchanged. |
| `out_of_scope` | ✅ Plan 028 | Dispatcher declines honestly and offers the menu. |
| `return_to_flow` | ✅ Plan 028 | Re-render the active flow's last view, or `lastRenderedView`. |
| `mutate_plan` | 🚧 Plan D | Live in Plan D. For v0.0.5 the dispatcher picks flow_input during active planning and clarify (with honest deferral) post-confirmation. |
| `answer_plan_question` | 🚧 Plan E | Deferred; dispatcher clarifies honestly. |
| `answer_recipe_question` | 🚧 Plan E | Deferred; dispatcher clarifies honestly. |
| `answer_domain_question` | 🚧 Plan E | Deferred; dispatcher clarifies honestly. |
| `show_recipe` | 🚧 Plan E | Deferred; dispatcher declines with a "tap a button" hint. |
| `show_plan` | 🚧 Plan E | Same. |
| `show_shopping_list` | 🚧 Plan E | Same. |
| `show_progress` | 🚧 Plan E | Same. |
| `log_measurement` | 🚧 Plan E | Deferred. The numeric pre-filter handles the happy path during `awaiting_measurement`; other cases clarify. |
| `log_eating_out` | 🚫 Deferred beyond v0.0.5 | Proposal-committed but not scoped for v0.0.5. |
| `log_treat` | 🚫 Deferred beyond v0.0.5 | Same. |

### State preservation invariants (Plan 028)

The runner and its action handlers enforce:

1. **The dispatcher never clears `planFlow` or `recipeFlow`.** Only explicit
   flow completions (approve), explicit cancellations (meta-intent or
   slash command), and successful natural completions can clear flow
   state. Side conversations leave flow state untouched.
2. **`flow_input` during an active planning proposal routes to the same
   `handleMutationText` path** — never starts a new planning session.
3. **Cancel precedence:** meta-intent cancel phrases short-circuit the
   dispatcher when a planning flow is active. See the Plan 028 doc
   comment above `CANCEL_PATTERNS` in `src/agents/plan-flow.ts`.
4. **Pending sub-agent clarifications are preserved across side
   conversations.** The re-proposer's `pendingClarification` is carried
   into the dispatcher's context so the LLM knows there's an open
   question, and the clarification stays on `planFlow` state until the
   user eventually answers it via `flow_input`.
5. **`return_to_flow` re-renders; it does not start fresh.** Fidelity is
   three-tiered in Plan 028:
   - **Byte-identical** for `planFlow.phase === 'proposal'` (reads
     `proposalText`) and `recipeFlow.phase === 'reviewing'` (reads
     `currentRecipe` via `renderRecipe`).
   - **Phase-canonical prompt** for every other active-flow phase. The
     `getPlanFlowResumeView` / `getRecipeFlowResumeView` helpers
     (`src/telegram/flow-resume-views.ts`) emit a short re-entry prompt
     keyed on phase + structural state. This is the existing legacy
     behavior of `getPlanFlowResumeView` inside `core.ts`, which Plan C
     extracts into a shared module so both the existing `plan_week`
     menu action and the new dispatcher `return_to_flow` path use the
     same source of truth. The prompt is semantically correct but not
     byte-identical to the actual last-rendered message.
   - **Placeholder reply** for the no-flow case — "Back to X. Tap
     📋 My Plan for the current view." plus the main menu reply
     keyboard.
   Plan E Task 19 promotes tiers 2 and 3 to byte-identical via
   `lastRenderedText` persistence + the view-renderers module. The
   full bounded-deviation rationale lives in Plan 028's decision log.
6. **Recent turns are ring-buffered at 6 entries and capture both sides.**
   `recentTurns` records the user's message plus the **last** bot reply
   for every dispatcher-handled turn — including replies produced by
   downstream flow handlers (`flow_input` → re-proposer output, recipe
   renders) via `wrapSinkForBotTurnCapture`. The wrapper buffers each
   `sink.reply`, overwriting the previous capture, and the runner's
   `try/finally` calls `flushBotTurn` to commit the most recent reply
   after the action handler returns. This is what handles the recipe
   flow's `sink.reply('Generating your recipe…')` followed by the
   actual recipe — only the substantive reply lands in `recentTurns`.
   The dispatcher sees the last 3 user+bot exchanges via the context
   bundle and can follow referential threads ("what about the lamb?"
   after the re-proposer's reply mentioned lamb). The cancel /
   start_over short-circuit and the numeric pre-filter are the two
   documented bypasses: they run with the raw sink and add nothing to
   `recentTurns` because they are flow terminations / parse-only fast
   paths, not conversational turns. Bot turns are truncated to
   `BOT_TURN_TEXT_MAX` chars (500) at capture time so long MarkdownV2
   recipe bodies don't bloat the buffer.

### Numeric measurement pre-filter

One narrow exception to "dispatcher is the front door": during
`progressFlow.phase === 'awaiting_measurement'`, the runner first tries
`parseMeasurementInput(text)`. If it returns a non-null result, the
measurement is logged (possibly after disambiguation) and the runner
returns WITHOUT calling the dispatcher. If parsing fails, the runner
proceeds to the dispatcher normally — the LLM can then decide whether
the message is an event (unlikely during measurement phase), a question,
or noise. The `recentTurns` buffer is NOT updated for pre-filter-handled
turns (the measurement is the state change, not the conversation).
```

- [ ] **Step 3: Update `docs/product-specs/testing.md`**

Find the section that describes scenario fixtures (Plan 027 Task 17 added a note there). Add a short paragraph:

```markdown
### Dispatcher fixtures in v0.0.5+ scenarios (Plan 028)

Every scenario that fires free text (`text(...)` events with non-menu
labels) produces at least one dispatcher LLM fixture per text turn. The
fixture appears in `llmFixtures` with the dispatcher's system prompt as
its first system message. Scenarios with recipe flow or planning flow
text turns add exactly one dispatcher fixture PLUS their downstream
agent fixtures (re-proposer, recipe generator, etc.). Cancel-phrase
turns (the planning meta-intent short-circuit) do NOT produce a
dispatcher fixture — see scenario 041 for the regression lock.

When reviewing a regenerated recording, confirm that:

- Each expected text turn has the correct number of fixtures (1 for
  dispatcher + downstream calls).
- The dispatcher's chosen action matches your expectations for the
  conversational intent.
- `finalSession.recentTurns` length reflects the user turns plus one bot
  turn per dispatcher call from ANY action branch. The runner's sink
  wrapper (`wrapSinkForBotTurnCapture`) buffers replies and commits the
  **last** one via `flushBotTurn` after the action handler returns, so
  every action — `flow_input`, `clarify`, `out_of_scope`, and
  `return_to_flow` — contributes one bot turn each. For multi-message
  branches like the recipe flow ("Generating your recipe…" then the
  rendered recipe), the recorded bot turn is the **substantive reply**,
  not the holding message. Two documented bypasses: the cancel
  meta-intent short-circuit (scenario 041) and the numeric pre-filter
  (scenario 042) both run with the raw sink and contribute nothing to
  `recentTurns`.
```

- [ ] **Step 4: Typecheck + test**

Run: `npx tsc --noEmit` → no errors (docs-only change).
Run: `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/product-specs/ui-architecture.md docs/product-specs/testing.md
git commit -m "Plan 028: sync ui-architecture.md and testing.md with dispatcher front door"
```

---

### Task 22: Final baseline

**Files:** none modified — verification only.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS. Test count: baseline + Task 2's 6 pushTurn tests + Task 4's 9 dispatcher-agent tests + Task 8's 6 context-builder tests + 7 new scenarios (037–043) + regenerated existing scenarios.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Verify the commit chain**

Run: `git log --oneline -25`
Expected: a sequence of commits all starting with "Plan 028:" — roughly one per task from Task 2 onward.

- [ ] **Step 4: Grep spot-checks**

Confirm the following invariants hold in the final tree:

- `grep -rn "handleTextInput" src/telegram/` should return no matches except the Plan 028 transitional-alias-delete comment (if preserved) and possibly stale comments. Any live reference to `handleTextInput` is a bug — Task 6 renamed the function.
- `grep -n "runDispatcherFrontDoor" src/telegram/core.ts` should return exactly 2 matches: one for the `voice` case and one for the `text` case in `dispatch()`.
- `grep -n "tryNumericPreFilter" src/telegram/` should return exactly 2 matches: the definition in `dispatcher-runner.ts` and the call site in `runDispatcherFrontDoor`.
- `grep -n "DispatcherFailure" src/` should show: the class definition in `agents/dispatcher.ts`, the throw sites in `dispatchMessage`, and the catch site in `runDispatcherFrontDoor`.
- `grep -rn "recentTurns" src/` should show at minimum: the optional field on `BotCoreSession`, the `= undefined` clear in `reset`, the reads in `buildDispatcherContext` (always guarded with `?? []`), the writes inside `pushTurn` (lazily initializes the array on first call), the user-turn push in `runDispatcherFrontDoor`, and the bot-turn push inside `wrapSinkForBotTurnCapture`. Do NOT expect explicit `pushTurn` calls in `handleClarifyAction` / `handleOutOfScopeAction` — the wrapper is the single source of truth for bot-turn recording. No initialization line should appear in `createBotCore`.
- `grep -rn "wrapSinkForBotTurnCapture" src/telegram/` should return exactly 3 matches: the definition in `dispatcher-runner.ts`, its call site inside `runDispatcherFrontDoor`, and the call site inside `core.ts`'s `handleCallback` `plan_resume` / `recipe_resume` merged case (Task 10 Step 5). If only 2 matches appear, the callback path is missing its sink wrap — scenario 043 will show `recentTurns.length === 2` instead of 3 and the button-tap path will not contribute the re-rendered proposal to referential-follow-up context.
- `grep -rn "flushBotTurn" src/telegram/` should return exactly 4 matches: the definition, the `runDispatcherFrontDoor` dispatcher-success `try/finally`, the `runDispatcherFrontDoor` `DispatcherFailure` `try/finally`, and the `handleCallback` `plan_resume` / `recipe_resume` `try/finally`.
- `grep -n "getPlanFlowResumeView" src/telegram/` should return the definition in `flow-resume-views.ts` plus exactly 2 call sites: the existing `plan_week` menu action in `core.ts`, and `dispatcher-runner.ts`'s `rerenderPlanFlow` (which is in turn called by `handleReturnToFlowAction`, which is called by BOTH the dispatcher's `return_to_flow` branch AND the `plan_resume` / `recipe_resume` callback cases). Same shape for `getRecipeFlowResumeView` (definition + 1 call site inside `rerenderRecipeFlow`). The `plan_resume` / `recipe_resume` callbacks do NOT call the resume-view helpers directly — they delegate to `handleReturnToFlowAction` so both button-tap and natural-language paths converge on the same code.
- `grep -n "handleReturnToFlowAction" src/telegram/` should return the definition in `dispatcher-runner.ts` plus exactly 2 call sites: the dispatcher switch statement inside `runDispatcherFrontDoor` (via `case 'return_to_flow'`) AND the merged `plan_resume`/`recipe_resume` callback case in `core.ts`'s `handleCallback`.
- `grep -n "function getPlanFlowResumeView" src/telegram/core.ts` should return ZERO matches (the local definition was deleted in Task 8b).
- `grep -n "function formatDateForMessage" src/telegram/core.ts` should return ZERO matches (moved to `src/utils/dates.ts`).

- [ ] **Step 5: No commit needed**

This is a pure verification step. If any of the above fails, jump back to the responsible task and fix it. If everything passes, Plan 028 is done and ready for handoff to Plan D (which depends on it) and Plan E (which extends it).

---

## Progress

- [x] Task 1 — Green baseline + scenario-number check + no existing dispatcher module
- [x] Task 2 — Add `recentTurns` to `BotCoreSession` + unit test for `pushTurn`
- [x] Task 3 — Create dispatcher agent module with types + scaffold
- [x] Task 4 — Implement `dispatchMessage` prompt + parse + retry
- [x] Task 5 — Unit tests for the dispatcher agent
- [x] Task 6 — Rename `handleTextInput` → `routeTextToActiveFlow`, trim branches
- [x] Task 7 — Dispatcher-context unit test scaffold
- [x] Task 8 — Implement `buildDispatcherContext` + `tryNumericPreFilter` + runner stub
- [x] Task 8b — Extract flow resume views to a shared leaf module
- [x] Task 9 — Action handlers: `flow_input`, `clarify`, `out_of_scope`
- [x] Task 10 — `return_to_flow` handler + `rerenderLastView` helper
- [x] Task 11 — Wire the dispatcher into `core.dispatch` as the front door
- [x] Task 12 — Cancel-phrase audit + prompt precedence doc comment
- [x] Task 13 — Regenerate affected scenario recordings
- [x] Task 14 — Scenario 037 — `flow_input` during planning mutation
- [x] Task 15 — Scenario 038 — `out_of_scope` decline
- [x] Task 16 — Scenario 039 — `return_to_flow` after side question
- [x] Task 17 — Scenario 040 — clarify multi-turn
- [x] Task 18 — Scenario 041 — cancel precedence regression lock
- [x] Task 19 — Scenario 042 — numeric pre-filter bypass
- [x] Task 19b — Scenario 043 — plan_resume back-button callback equivalence
- [x] Task 20 — Update `test/scenarios/index.md`
- [x] Task 21 — Sync `ui-architecture.md` and `testing.md`
- [x] Task 22 — Final baseline

---

## Decision log (added entries after self-review)

- **Decision:** `recentTurns` is **optional** on `BotCoreSession`, initialized on first write by `pushTurn`, and cleared back to `undefined` by `reset()`.
  **Rationale:** Making the field required would add `"recentTurns": []` to every scenario's `finalSession`, forcing ~30+ recording regenerations for a single trivially-different line. Optional + initialize-on-write mirrors Plan 027's `lastRenderedView` pattern exactly and keeps Task 2 strictly additive (no recording patches). The runtime cost is a single `if (!session.recentTurns) session.recentTurns = [];` line inside `pushTurn`, which the dispatcher invokes on every call anyway.
  **Date:** 2026-04-10 (added during Plan 028 self-review)

- **Decision:** Side-conversation replies during active flows attach an inline `[← Back to X]` button via new `plan_resume` / `recipe_resume` callbacks handled in `core.ts`. The callbacks **delegate to `handleReturnToFlowAction`** (exported from `dispatcher-runner.ts`) — the same function the dispatcher's natural-language `return_to_flow` branch calls — AND **wrap the sink with `wrapSinkForBotTurnCapture` + `flushBotTurn`** so the re-rendered view contributes a bot turn to `recentTurns`. Both the shared-handler delegation and the sink wrap are load-bearing for proposal 003's equivalence guarantees (invariants #3 and #7).
  **Rationale:** Proposal 003 state-preservation invariant #3 requires side-conversation responses to include a `[← Back to X]` inline button pointing back to the flow's last view; invariant #7 requires natural-language back commands to be equivalent to those button taps; and the context-hydration section (line 257) + side-conversation section (line 460) together require that each dispatch see the most recent user/bot exchanges so referential follow-ups ("what about the lamb?") resolve correctly.

  An earlier Plan 028 draft implemented the two paths separately — the callback path in `core.ts` held inline re-render code and a pair of "session has ended" fallback branches for when the flow was cleared between emission and tap, while the dispatcher path in `dispatcher-runner.ts` went through `handleReturnToFlowAction` → `rerenderLastView` for the same edge case. This produced a real UX divergence: typing "back to the plan" after plan confirmation landed on Plan 027's `lastRenderedView` (correctly, per Tier 3), while tapping the stale back button hit the "session has ended" fallback (wrong — the user's surface state is intact, just the flow is gone). The fourth-round review ("R5F1") caught the divergence and the fourth-round fix merged the `plan_resume` / `recipe_resume` callback cases into one branch that synthesizes a minimal `DispatcherDecision` and delegates to `handleReturnToFlowAction`. That fixed the visible-output divergence.

  The fifth-round review ("R6F1") then caught a subtler divergence: the delegated call still ran on the RAW sink, so the re-rendered proposal was never recorded on `recentTurns`. The text path captured it (via `wrapSinkForBotTurnCapture` installed by `runDispatcherFrontDoor`), but the button-tap path did not. After a `text("back") → proposal → text("what about the lamb?")` sequence the dispatcher saw the proposal in context and could resolve "lamb"; after `click(plan_resume) → proposal → text("what about the lamb?")` it saw only the older out-of-scope decline and could not. The visible output at step 6 was identical across paths, but the conversational state going into the NEXT turn differed — a state-level equivalence violation even though the output-level equivalence held. Fix: wrap the sink inside the callback handler and flush in a `try/finally`, so the re-rendered view contributes one bot turn to `recentTurns`. Scenario 043 asserts `recentTurns.length === 3` (one user turn + two bot turns: the out-of-scope decline from the text turn, and the proposal body from the button tap) — this is the shape that makes both paths produce equivalent dispatcher context for the next call.

  No user turn is pushed for the button tap. A button tap is an action, not typed text, so `role: 'user'` has nothing to carry. The residual asymmetry with scenario 039 is exactly one content-free user turn (scenario 039 has `user: "ok back to the plan"` which carries no referential content); the content that matters for follow-ups — the re-rendered proposal body — is present in both scenarios' `recentTurns` with identical text.

  Circular-import avoidance still holds — `core.ts` → `dispatcher-runner.ts` is the same direction as the existing `runDispatcherFrontDoor` import in Task 11; `dispatcher-runner.ts` does not import `core.ts` back. No code duplication. Scenario 043 in Task 19b is the regression lock for the button-tap path, and the Task 22 grep spot-check verifies the wrap/flush call sites exist.
  **Date:** 2026-04-10 (added during Plan 028 self-review); revised 2026-04-11 for the delegation pattern (R5F1); revised again 2026-04-11 for the sink-wrap equivalence fix (R6F1).

- **Decision:** Self-review discovered state-preservation invariant #3 was initially missed (the first draft of Task 9 used the main menu reply keyboard for clarify / out_of_scope, not the inline back button). The fix split across two tasks: Task 9 Step 4 adds `buildSideConversationKeyboard` (which emits the inline `← Back to X` button with `plan_resume` / `recipe_resume` callback data), and Task 10 Step 5 wires the corresponding inline callback cases in `core.ts`'s `handleCallback` (delegating to `handleReturnToFlowAction`). Scenario 039 was updated to assert the inline back button appears on the out-of-scope reply during active planning, and scenario 043 (Task 19b) regression-locks the button-tap callback path itself.
  **Rationale:** Documenting the correction so future plan readers know the invariant is load-bearing and not optional.
  **Date:** 2026-04-10 (Plan 028 self-review)

## Decision log

- **Decision:** Plan 028 implements exactly four actions (`flow_input`, `clarify`, `out_of_scope`, `return_to_flow`), not the full proposal-003 catalog.
  **Rationale:** Proposal 003 § "Plan C — Dispatcher infrastructure + minimal actions" explicitly lists this set as the minimum that makes the dispatcher exercisable without any new capability (Plan D ships `mutate_plan`, Plan E ships the rest). Building all 13 actions in one plan would overload the coding agent's context and make the regression surface unmanageable. The four minimal actions exercise every architectural concern (routing, state preservation, side-conversation returns, honest declines, retry/failure) without requiring any new downstream capability.
  **Date:** 2026-04-10

- **Decision:** The dispatcher agent (pure) and the runner (stateful) live in separate files — `src/agents/dispatcher.ts` and `src/telegram/dispatcher-runner.ts`.
  **Rationale:** Matches the existing split between `plan-reproposer.ts` (pure) and the call site in `plan-flow.ts` (stateful). The pure agent is unit-testable against plain objects and a stub LLM provider without constructing any session. The runner is unit-testable against a fake LLM and plain session slices. Merging the two would create a large module with mixed responsibilities and make the agent hard to reason about in isolation.
  **Date:** 2026-04-10

- **Decision:** The runner declares its own structural `DispatcherOutputSink` and `DispatcherSession` types rather than importing from `core.ts`.
  **Rationale:** `core.ts` imports `runDispatcherFrontDoor` from `dispatcher-runner.ts`, so a direct import back from `core.ts` would create a circular dependency. TypeScript tolerates some circulars at the type level but not at the value level. Declaring structural slices avoids the cycle entirely and lets unit tests pass plain objects without constructing a BotCore. The real `OutputSink` / `BotCoreSession` conform structurally at call sites.
  **Date:** 2026-04-10

- **Decision:** The ring buffer cap is `RECENT_TURNS_MAX = 6` (3 user+bot pairs).
  **Rationale:** Proposal 003 § "Context hydration" specifies "Last 3–5 user/bot exchanges". 6 turns = 3 pairs, the middle of the stated range. At mini-tier prices with turn text truncated to 300 chars, this adds ~200 tokens per call — negligible compared to the recipe index and plan summary. Larger buffers risk crowding the prompt and introducing stale referents; smaller buffers break multi-turn clarify flows.
  **Date:** 2026-04-10

- **Decision:** Cancel meta-intents short-circuit the dispatcher INSIDE `runDispatcherFrontDoor`, not inside `routeTextToActiveFlow`.
  **Rationale:** The short-circuit must run BEFORE the dispatcher LLM call (otherwise a user types "nevermind" and the LLM may still pick `out_of_scope` or `return_to_flow`, which is a precedence violation). Placing it in the runner gives the precedence rule a single, testable home. The existing `routeTextToActiveFlow` branch for meta-intents stays in place so the `flow_input` path also handles them when routed through — a belt-and-suspenders design. Scenario 041 locks in the precedence behavior.
  **Date:** 2026-04-10

- **Decision:** Plan 028 satisfies proposal 003 state preservation invariants #3 and #6 in **three tiers**, not uniformly. This is a deliberate, documented deviation bounded to the phases/regimes Plan C explicitly does not ship support for:

  **Tier 1 — byte-identical restore.** `planFlow.phase === 'proposal'` (uses stored `proposalText`) and `recipeFlow.phase === 'reviewing'` (uses stored `currentRecipe` rendered via `renderRecipe`). These are the two phases where the rendered body already lives on flow state — so the resume helper can emit exactly what the user last saw. Scenario 039 is the regression lock.

  **Tier 2 — phase-canonical prompt, non-byte-identical.** Every other active-flow phase: `context`, `awaiting_events`, `generating_proposal`, `confirmed`, `choose_meal_type`, `awaiting_preferences`, `awaiting_refinement`. The `getPlanFlowResumeView` / `getRecipeFlowResumeView` helpers (Task 8b) emit a short, phase-appropriate re-entry prompt keyed on structural state (`weekStart`, `breakfast`, `mealType`, event count, etc.). The prompt is **semantically correct** — the user sees a message that matches the phase they're in — but it is NOT guaranteed to be byte-for-byte identical to whatever the bot said last. Two concrete drift examples: (a) after adding two events the bot's last message is `"Got it — <name> on <day> <meal> (~<cal>). Any other meals out?"` but the resume helper returns `"You're adding events for the week. Send another event or tap Done."` with `planMoreEventsKeyboard`; (b) `awaiting_refinement` emits the `refine_recipe` callback's example list regardless of entry path, so library-edit users see a different example list than they originally saw. Tier-2 fidelity is the **existing legacy behavior** of `getPlanFlowResumeView` inside `core.ts` — Plan C extracts the helper unchanged into `flow-resume-views.ts`; it does not attempt to upgrade it. Plan E's Task 19 adds `lastRenderedText?: string` + `lastRenderedKeyboard?` + `lastRenderedParseMode?` fields to `PlanFlowState` / `RecipeFlowState`, captures them via a sink wrapper at every flow-render site in `core.ts`, and flips the resume helpers to prefer the stored fields when present — at which point Tier 2 promotes to Tier 1 without changing any call site.

  **Tier 3 — placeholder reply + main menu.** No active flow, `session.lastRenderedView` populated. `rerenderLastView` emits `"Back to plan. Tap 📋 My Plan for the current view."` (or the variant for the user's surface) plus the lifecycle-aware main menu reply keyboard. The user is one tap away from the real view, but the view itself is not re-rendered. Plan E Task 19 promotes this to byte-identical re-render once the extracted view-renderers module exists.

  **Why staged.** Full byte-identical restore across every tier requires (a) a view-renderers module that can render any `LastRenderedView` variant without going through `core.ts`'s callback handlers (Plan E Task 5), and (b) `lastRenderedText` persistence on flow state with sink-wrapper capture at every flow render site (Plan E Task 19). Either in isolation changes more code than Plan C's "minimal dispatcher infrastructure + 4 minimal actions" mandate allows. Splitting the promotion to Plan E gives Plan C a shippable, testable landing point (Tier 1 is exercised end-to-end by scenario 039) and keeps the deviation bounded, documented, and concretely scheduled for removal.

  **What Plan C does NOT regress.** Every plan-flow user who taps `📋 Plan Week` mid-plan today already lands in `getPlanFlowResumeView`'s Tier-2 path — Plan C preserves that behavior verbatim while making it reachable through natural language. Zero user-visible regression from the Tier-2 drift because it was already Tier 2 before Plan 028.

  **Decision:** ship Plan C with the three-tier model; update the plan's fidelity claims to match; document drift examples explicitly so the Plan E implementer has a concrete checklist to retire.
  **Date:** 2026-04-10 (originally); revised 2026-04-11 to walk back the "every plan/recipe phase byte-identically" claim from the second-round revision and replace it with the honest three-tier model after third-round review.

- **Decision:** Scenario 017 (`free-text-fallback`) is regenerated with new dispatcher-authored replies, NOT preserved as a legacy-fallback lock.
  **Rationale:** The legacy fallback code path is gone after Plan 028 Task 6. Preserving scenario 017 would require either keeping the legacy fallback alive as dead code behind a flag (ugly) or rewriting the scenario to hit a path that no longer exists (wrong). Regenerating it captures what users actually see after Plan 028 and locks in the dispatcher's clarify / out_of_scope behavior for those canonical inputs. The behavioral review step in Task 13 is where the new copy gets signed off on.
  **Date:** 2026-04-10

- **Decision:** The recipe-name fuzzy match in `handleTextInput` is REMOVED in Plan 028 and re-added as Plan E's `show_recipe` action.
  **Rationale:** The fuzzy match was a pre-dispatcher stand-in for `show_recipe`. Keeping it alive alongside the dispatcher would create two overlapping routing paths and mean a user typing "tagine" might hit either depending on fixture ordering. Plan E will implement `show_recipe` properly (batch-aware scaled cook view when the recipe is in the active plan, library view otherwise, multi-match disambiguation). During the Plan 028-through-Plan D window, typing a recipe name without an active flow will trigger `clarify` or `out_of_scope` with a "tap 📖 My Recipes" pointer. This is a regression that's explicit in the proposal's Plan C scope note.
  **Date:** 2026-04-10

- **Decision:** The dispatcher's system prompt describes the FULL proposal-003 catalog (including deferred actions) with availability markers, not just the four actions Plan 028 implements.
  **Rationale:** Keeping the full catalog in the prompt gives the LLM the complete mental model of Flexie's vocabulary from day one, so it can honestly defer unimplemented capabilities with specific hints ("post-confirmation plan changes aren't built yet — that's coming next") instead of picking a wrong action or hallucinating. The parser's `allowedActions` filter enforces runtime correctness. Plans D and E only need to flip the availability marker in the prompt and add a runtime handler — no prompt rewrite. This is the cheapest long-term shape.
  **Date:** 2026-04-10

- **Decision:** Bot turns for EVERY action branch (including `flow_input` and `return_to_flow`) are captured uniformly by `wrapSinkForBotTurnCapture`, a Proxy-based sink wrapper installed at the top of `runDispatcherFrontDoor`. The wrapper buffers each `sink.reply` (overwriting the previous capture), and the runner's `try/finally` calls `flushBotTurn` to commit the **most recent** reply to `session.recentTurns`, truncated to `BOT_TURN_TEXT_MAX` (500 chars). Last-reply, not first-reply.
  **Rationale:** Proposal 003 § "Context hydration" (line 257) specifies "Last 3–5 user/bot exchanges" and relies on multi-turn referential threads ("what about the lamb?" after a re-proposer reply mentioning lamb) to resolve correctly. An earlier plan draft (a) pushed bot turns only inside `handleClarifyAction` / `handleOutOfScopeAction`, so downstream flow handler replies never landed in `recentTurns`; and (b) when wrapped at the sink level, captured the FIRST reply, which is the holding message (`'Generating your recipe…'` / `'Refining your recipe...'`) for the recipe flow's `handlePreferencesAndGenerate` and `handleRefinement` paths (`core.ts:1230`, `core.ts:1245`) — exactly the two paths the wrapper most needs to cover correctly. The third-round fix is to switch to last-reply with a flush-on-completion hook: every `sink.reply` overwrites a buffered capture, the runner commits it via `flushBotTurn` in a `try/finally` regardless of whether the handler threw, and only the substantive content lands in the ring buffer. The Proxy preserves forwarding for every other sink method, exposes the flush via a private symbol, and is future-proof as `DispatcherOutputSink` grows. Bypassed branches (cancel short-circuit, numeric pre-filter) keep using the raw sink to preserve their "not a conversational turn" semantics; scenarios 041 and 042 lock that in.
  **Date:** 2026-04-11 (added after second-round review; revised after third-round review — flipped from first-reply to last-reply to handle recipe-flow holding messages)

- **Decision:** The numeric pre-filter does NOT push turns to `recentTurns`.
  **Rationale:** The pre-filter is a bypass of the conversational layer, not a turn in it. A user who logs their weight during the measurement phase is not having a conversation — they're completing a flow. Pushing the numeric input as a conversation turn would pollute the context for the next dispatcher call ("what did the user say before?" → "82.3" is useless). Keeping the pre-filter entirely outside `recentTurns` keeps the conversation history meaningful. Scenario 042 asserts this explicitly.
  **Date:** 2026-04-10

---

## Validation

After every task: `npm test` stays green (or red only in ways explicitly expected by the task — see Task 6's and Task 11's intentional-red notes). After Task 22, all of these must be true:

- `npm test` passes with:
  - Task 1's baseline test count
  - + 6 `pushTurn` unit tests (Task 2)
  - + 9 dispatcher-agent unit tests (Task 5)
  - + 6 dispatcher-context unit tests (Task 8)
  - + 7 new scenarios (037–042 from Tasks 14–19, plus 043 from Task 19b)
  - + regenerated existing scenarios (017, 020, 021, 029 at minimum; plus any others caught in Task 13)
- `npx tsc --noEmit` reports no errors.
- `src/agents/dispatcher.ts` exists and exports: `DispatcherAction`, `AVAILABLE_ACTIONS_V0_0_5`, `DispatcherContext`, `DispatcherDecision`, `DispatcherFailure`, `DispatcherTurn`, `ActiveFlowSummary`, `DispatcherRecipeRow`, `DispatcherPlanSummary`, `dispatchMessage`.
- `src/telegram/dispatcher-runner.ts` exists and exports: `ConversationTurn`, `RECENT_TURNS_MAX`, `BOT_TURN_TEXT_MAX`, `pushTurn`, `wrapSinkForBotTurnCapture`, `DispatcherSession`, `DispatcherOutputSink`, `DispatcherRunnerDeps`, `buildDispatcherContext`, `tryNumericPreFilter`, `runDispatcherFrontDoor`, `handleFlowInputAction`, `handleClarifyAction`, `handleOutOfScopeAction`, `handleReturnToFlowAction`.
- `src/telegram/flow-resume-views.ts` exists and exports: `FlowResumeView`, `getPlanFlowResumeView`, `getRecipeFlowResumeView`.
- `src/utils/dates.ts` exports `formatDateForMessage` (moved from `core.ts` in Task 8b).
- `src/telegram/core.ts`:
  - `BotCoreSession` has an optional `recentTurns?: ConversationTurn[]` field.
  - `createBotCore` does NOT initialize the field — it starts as `undefined` and is lazily created on first `pushTurn` call.
  - `reset()` clears `recentTurns = undefined`.
  - `dispatch()` calls `runDispatcherFrontDoor` for both `text` (after menu match) and `voice`.
  - `routeTextToActiveFlow` exists (the renamed former `handleTextInput`) without the numeric branch, the recipe-name fuzzy match, or the generic fallback at the end.
  - `replyFreeTextFallback` is still reachable from the runner's failure catch path.
- `src/agents/plan-flow.ts` has a Plan 028 doc comment above `CANCEL_PATTERNS` documenting the precedence rule.
- `docs/product-specs/ui-architecture.md` contains the "Freeform conversation layer — the dispatcher (Plan 028 / v0.0.5 minimal slice)" section.
- `docs/product-specs/testing.md` contains the "Dispatcher fixtures in v0.0.5+ scenarios (Plan 028)" subsection.
- `test/scenarios/index.md` lists scenarios 037–043.
- For scenarios 037, 038, 039, 040, 042, 043: `llmFixtures` contains at least one fixture whose system message mentions "Flexie's conversation dispatcher" (the dispatcher prompt's signature phrase). For scenario 041: NO such fixture exists (cancel precedence short-circuit). For scenario 043 specifically: the dispatcher fixture(s) cover the out-of-scope side question at step 5, NOT the `plan_resume` button click at step 6 — that click runs outside `runDispatcherFrontDoor` and produces no dispatcher fixture, which is the structural signature of the callback path.
- For scenario 043: step 6's reply text and keyboard must be byte-for-byte identical to scenario 039's step 6 output (same stored `proposalText`, same `planProposalKeyboard`, same `MarkdownV2` parse mode). This is the regression lock for proposal 003 invariant #7 — a diff here means `handleCallback`'s `plan_resume` case has re-implemented re-render logic locally instead of delegating to `handleReturnToFlowAction`. `finalSession.recentTurns.length === 3` for scenario 043 (vs 4 for scenario 039): the button-tap path contributes one bot turn (the re-rendered proposal) via the `wrapSinkForBotTurnCapture` wrap inside the callback handler, but no user turn (no typed text). This shape guarantees that the dispatcher's next call sees the proposal body in `recentTurns` regardless of whether the user typed "back to the plan" or tapped the inline button — satisfying proposal 003 lines 257/460/466 jointly.
- For scenario 041: `finalSession.planFlow === null` AND `finalSession.recentTurns` is absent from the recording (the field is optional and `pushTurn` is never called because the cancel short-circuit fires before the dispatcher runs).
- For scenario 042: `finalStore.measurements` has exactly one entry for the clock date with weight 82.3.
- Every existing scenario that was not regenerated in Task 13 still has its original output byte-for-byte — no unintended collateral changes.
- Typing "ok back to the plan" mid-planning (scenario 039) produces a reply whose text contains the same proposal text shown after the previous proposal render, with the `planProposalKeyboard` attached — proving `return_to_flow`'s flow re-render path works end-to-end.
