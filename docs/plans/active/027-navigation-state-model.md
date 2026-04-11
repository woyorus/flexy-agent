# Plan 027: Navigation State Model

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Active
**Date:** 2026-04-10
**Affects:** `src/telegram/navigation-state.ts` (new), `src/telegram/core.ts`, `test/unit/navigation-state.test.ts` (new), several new scenarios under `test/scenarios/`, `docs/product-specs/ui-architecture.md`, `docs/product-specs/testing.md`.

**Goal:** Extend the bot's in-memory session with a precise, typed `LastRenderedView` field that captures exactly what the user was last looking at (which subview of plan/cooking/shopping/recipes/progress, plus its parameters), and route every render call site through a single helper that keeps `lastRenderedView` and `surfaceContext` in sync. Audit every site that destructively clears `planFlow` and document the current decision in the plan's decision log with scenario coverage. **This is Plan B from proposal `003-freeform-conversation-layer.md`.**

**Architecture:** A new module `src/telegram/navigation-state.ts` exports a `LastRenderedView` discriminated union and a `setLastRenderedView(session, view)` helper. `BotCoreSession` in `src/telegram/core.ts` gains an optional `lastRenderedView?: LastRenderedView` field. Every current render handler (plan subviews, cook view, shopping list, recipe views, progress) is updated to call the helper with a typed view descriptor immediately before `sink.reply(...)`. Back-button destinations are **not** touched in this plan — they remain hardcoded, as today — because the dispatcher that reads `lastRenderedView` to compute dynamic back targets is Plan C (`dispatcher + minimal actions`) per the proposal's dependency graph. Plan B just lays the state-tracking rails.

**Tech Stack:** TypeScript, Node's built-in `node:test`, the existing scenario harness (`src/harness/runner.ts` + `test/scenarios/`). No database changes, no new external dependencies, no LLM calls added.

**Scope:** Session-state plumbing and scenario coverage only. No dispatcher, no new entry points, no new back-button logic, no behavior changes to existing flows (`handleMenu` clear semantics stay as-is — the audit documents reasoning for each site rather than changing any of them; see the decision log). All verification is via `npm test` and `npx tsc --noEmit`. Plan B has **no runtime dependency on Plan A (Plan 026)** — the two plans can be implemented in any order and merged independently, per proposal 003's dependency graph.

---

## Problem

Today's in-memory session (`BotCoreSession` in `src/telegram/core.ts:183`) tracks "what surface the user is on" at a coarse five-value level:

```typescript
surfaceContext: 'plan' | 'cooking' | 'shopping' | 'recipes' | 'progress' | null;
lastRecipeSlug?: string;
```

That is **not enough** for the navigation guarantees proposal 003 promises for v0.0.5 and beyond. Specifically:

1. **No plan-subview distinction.** Four handlers render distinct plan screens — `na_show` (Next Action, `src/telegram/core.ts:675`), `wo_show` (Week Overview, `src/telegram/core.ts:685`), `dd_<date>` (Day Detail, `src/telegram/core.ts:699`), and `cv_<batchId>` (Cook View, `src/telegram/core.ts:714`) — and all of them collapse into `surfaceContext === 'plan'` (or `'cooking'` for cv_). A user who drilled from Week Overview into Thursday's Day Detail and then branched to a recipe side conversation should return to **Thursday** on back, not to Next Action.
2. **No shopping-scope retention.** The shopping list handler (`src/telegram/core.ts:740`) accepts `sl_next` or `sl_<ISO-date>` and calls a single renderer. The session has no idea afterwards whether the last shopping list shown was next-cook-day or a specific Friday. Proposal 003 requires retaining the scope so a freeform "show me the shopping list again" back-navigates to the same view.
3. **No recipe-context distinction.** The `rv_` handler (`src/telegram/core.ts:401`) and the `cv_` handler (`src/telegram/core.ts:714`) both set recipe-related state, but the session cannot distinguish "library view of a recipe" from "cook view of a batch" after the fact. Plan Day Detail → Cook View and Recipe List → Recipe Detail both write to `lastRecipeSlug`, and any later back operation has to guess which the user meant.
4. **No progress-subview distinction.** The progress menu handler (`src/telegram/core.ts:1013`) may render the log-prompt (first-measurement-of-the-day path) OR the already-logged confirmation with the weekly-report keyboard. Nothing persists which one was shown.
5. **Back buttons are hardcoded to specific destinations, not to "where I came from".** Every `← Back` button in `src/telegram/keyboards.ts` targets a fixed callback (`na_show`, `wo_show`, `recipe_back`). The shopping list's back button targets `na_show` unconditionally (`src/telegram/keyboards.ts:390`) — so a user who entered the shopping list from Thursday Day Detail loses their Day Detail context on back. This is load-bearing for the freeform layer in Plan C/D, which will compute back targets from session state.

Plan B does not fix the back-button destinations (that's Plan C's job) and does not change any flow-clearing semantics (that's part of the freeform experience work in Plan D). It adds the **precise state-tracking** that those later plans need to read, plus scenario tests that lock in the current behavior so Plan C/D changes show up as clean diffs.

Alongside the state extension, proposal 003 requires an **audit** of every site that currently clears `planFlow` destructively, with a documented decision per site (preserve / change / leave alone) and scenario coverage for each outcome. This plan performs that audit, decides **leave alone** for every current clear site (conservative-by-default — see the decision log for per-site reasoning), and adds scenario coverage where none exists so any later change under the freeform model produces a visible diff.

---

## Plan of work

### File structure

**Files to create:**

- `src/telegram/navigation-state.ts` — The `LastRenderedView` discriminated union, the minimal `NavigationSessionSlice` structural type the helper operates on, and the `setLastRenderedView(session, view)` helper. Pure — no imports from `core.ts`, no side effects beyond mutating its first argument.

- `test/unit/navigation-state.test.ts` — Unit tests for `setLastRenderedView`. Asserts that every variant of `LastRenderedView` is stored verbatim on `session.lastRenderedView` AND that `session.surfaceContext` is updated to the view's surface. One test per variant + one test for "setting a new view replaces an older one".

- `test/scenarios/030-navigation-state-tracking/spec.ts` — A driven scenario that walks the user through every major render surface in sequence (my_plan → week_overview → day_detail → cook_view → recipe list → recipe view → shopping list next_cook → shopping list day-scoped → progress → pg_last_report) with `captureStepState: true` so every intermediate `lastRenderedView` variant is asserted end-to-end via `sessionAt[0..10]`. Covers nine of ten variants; the tenth (`progress/log_prompt`) is covered by sibling scenario 035. No LLM calls (seeded plan + batches + measurements).

- `test/scenarios/030-navigation-state-tracking/recorded.json` — Generated via `npm run test:generate`. Committed together with the spec.

- `test/scenarios/035-navigation-progress-log-prompt/spec.ts` — A single-step sibling to scenario 030 that taps 📊 Progress with no measurement seeded, asserting the terminal `progress/log_prompt` variant. Required because 030's `weekly_report` coverage depends on seeding today's measurement, which is mutually exclusive with hitting the `log_prompt` branch.

- `test/scenarios/035-navigation-progress-log-prompt/recorded.json` — Generated via `npm run test:generate`. Committed.

- `test/scenarios/036-day-detail-back-button-audit/spec.ts` — Regression lock for proposal 003 §755's second explicitly-named audit outcome: "user drills into day detail then back — returns to day detail or to week overview?". Walks `my_plan → wo_show → dd_<date> → wo_show` (the fourth step simulates tapping the hardcoded "← Back to week" button from `dayDetailKeyboard` at `src/telegram/keyboards.ts:354`) and asserts via per-step `sessionAt[]` that the user lands on `plan/week_overview` at step 4. Locks in the v0.0.5 hardcoded back-button outcome so Plan C's eventual dispatcher-driven back computation produces a focused, visible diff. Added in Task 15. Zero LLM calls.

- `test/scenarios/036-day-detail-back-button-audit/recorded.json` — Generated via `npm run test:generate`. Committed.

- `test/scenarios/031-shopping-list-mid-planning-audit/spec.ts` — A regression-lock scenario that starts a planning draft for the next week (parking `planFlow` at `phase === 'context'` with zero LLM calls — see Task 14's rationale for why `context` is the chosen phase rather than `proposal`), then taps 🛒 Shopping List via the main menu, and asserts that **today's behavior** holds: the shopping list renders (using the active plan) AND `planFlow` is cleared (matching the current conditional-clear at `src/telegram/core.ts:1000`). This locks in the audit decision "leave alone" so a later plan that changes this to preserve `planFlow` will show a clean regen diff.

- `test/scenarios/031-shopping-list-mid-planning-audit/recorded.json` — Generated via `npm run test:generate`. Committed.

- `test/scenarios/032-discard-recipe-audit/spec.ts` — A regression-lock scenario for audit site #4 (`discard_recipe` callback). User taps into a fresh recipe flow, then Discard; scenario asserts `recipeFlow === null` after the clear. Zero LLM calls. Added in Task 14.

- `test/scenarios/032-discard-recipe-audit/recorded.json` — Generated via `npm run test:generate`. Committed.

- `test/scenarios/033-recipe-edit-clears-planflow-audit/spec.ts` — A regression-lock scenario for audit site #5 (`re_<slug>` recipe-edit callback). User enters `planFlow.phase === 'context'` via Plan Week, navigates to a recipe detail, taps Edit; scenario asserts `planFlow === null` after the clear. Zero LLM calls. Added in Task 14.

- `test/scenarios/033-recipe-edit-clears-planflow-audit/recorded.json` — Generated via `npm run test:generate`. Committed.

**Why this audit coverage is exhaustive** (given that site #9 `plan_cancel` is dead code). Three new zero-LLM regression scenarios (031/032/033) cover the user-reachable uncovered paths; sites already covered by existing scenarios (save_recipe → 029, `/cancel` → 012, plan_approve → 001 and many others, `metaIntent === 'start_over'` → 020, `metaIntent === 'cancel'` → 021) do NOT need new scenarios; site #9 (`plan_cancel` button callback) is dead code after Plan 025 removed the cancel button from `planProposalKeyboard`, so authoring a scenario for it would exercise an internal code branch that no user can reach — which is explicitly NOT what proposal 003's "scenario tests for each path" requirement is asking for. The audit table flags #9 as dead code and defers to a future plan to either delete the handler or re-expose the button.

The first draft of this plan skipped all four audit scenarios under CLAUDE.md's "NOT needed" heuristic. A subsequent review corrected that — proposal 003's explicit verification requirement at `docs/design-docs/proposals/003-freeform-conversation-layer.md:480` overrides the general debugging heuristic. The three scenarios now added close the gap for every user-reachable path at minimal cost (~50 lines of spec + small recorded.json each, zero LLM).

**Files to modify:**

- `src/telegram/core.ts` — Add `lastRenderedView?: LastRenderedView` to the `BotCoreSession` interface (`src/telegram/core.ts:183`). Import and call `setLastRenderedView` from every render call site listed in Task 5. Update `reset()` (`src/telegram/core.ts:1343`), the `/start` command handler (`src/telegram/core.ts:321-331`), and the `/cancel` command handler (`src/telegram/core.ts:333-340`) to clear the new field — without this, a `lastRenderedView` set by a render before `/start` or `/cancel` would survive the reset and be read as current by Plan C's dispatcher. Update the factory initializer (`src/telegram/core.ts:225`) — nothing to do there because the field is optional, but Task 3 will confirm.

- `docs/product-specs/ui-architecture.md` — Update the "surface context" section (or add a new "Navigation state" subsection) to document the `LastRenderedView` model, the list of variants, and the contract "every render call site must update `lastRenderedView` via `setLastRenderedView`". Mention explicitly that back-button destinations remain hardcoded in v0.0.5 Plan B; Plan C will start reading `lastRenderedView` to compute dynamic back targets.

- `docs/product-specs/testing.md` — Add a one-paragraph note that when authoring scenarios that exercise navigation, the recorded `finalSession.lastRenderedView` is the authoritative assertion for "what the user was last looking at". This is short — the existing testing doc already explains the `finalSession` JSON round-trip.

- `test/scenarios/index.md` — Add rows for the six new scenarios authored by this plan: 030 (navigation walkthrough with per-step assertions), 031 (shopping-list audit), 032 (discard_recipe audit), 033 (recipe-edit audit), 035 (progress log_prompt sibling), and 036 (day-detail back-button audit, proposal 003 §755 named outcome). Scenario 034 is intentionally skipped — see Task 14 row #9 for the reason (dead code).

- `recorded.json` files for existing scenarios whose last emitted output is a navigation render — these will pick up the new `lastRenderedView` field in their `finalSession`. The candidate list, ordered by cost to regenerate (cheapest first):
  - **Cheap (no LLM fixtures)**: `test/scenarios/018-plan-view-navigation/recorded.json`, `test/scenarios/019-shopping-list-tiered/recorded.json`, `test/scenarios/015-progress-logging/recorded.json`, `test/scenarios/016-progress-weekly-report/recorded.json`, `test/scenarios/017-free-text-fallback/recorded.json`, `test/scenarios/022-upcoming-plan-view/recorded.json`, `test/scenarios/029-recipe-flow-happy-path/recorded.json`.
  - **Expensive (LLM fixtures exist)**: Scenarios 001–014 and 020–028 use LLM fixtures but **most end inside the planning flow** (at plan_approve's post-confirmation render, or at plan_cancel, or mid-proposal), which means `lastRenderedView` never gets set in those flows (plan-flow phase transitions are NOT navigation renders — they're flow progressions, and Task 5 explicitly does NOT instrument them). Task 13 runs `npm test` and consumes the failure list to determine exactly which recordings need regeneration. Manual JSON patches are only applied when the test-failure diff is "trivially a missing null" or similar; anything more complex gets a full regeneration with behavioral review.

**Files NOT modified (deliberate scope guard):**

- `src/telegram/keyboards.ts` — **No changes.** Back-button callbacks (`na_show`, `wo_show`, `recipe_back`, `sl_next`) stay hardcoded in v0.0.5 Plan B. Plan C (dispatcher) will introduce dynamic back computation.
- `src/state/machine.ts`, `src/state/store.ts` — No changes. `LastRenderedView` lives in **in-memory** `BotCoreSession` only, not in the persistent `SessionState`. The store never sees it. Bot restarts drop in-progress navigation context, same as they drop `planFlow` and `recipeFlow` today (see proposal 003 Out of scope — "Session state persistence across bot restarts" is v0.1.0 work).
- `src/agents/plan-flow.ts`, `src/agents/recipe-flow.ts`, `src/agents/progress-flow.ts` — No changes. Flow states stay unchanged. Navigation state is orthogonal.
- `src/telegram/bot.ts` (grammY adapter) — No changes. The adapter just forwards updates to `core.dispatch`; it never touches navigation state directly.
- `src/harness/test-store.ts` — No changes. `LastRenderedView` is not persisted, so the store snapshot is unaffected. The harness captures `finalSession` via a separate JSON round-trip on `core.session` (`src/harness/runner.ts:130`), which automatically picks up the new field because `JSON.stringify` walks the whole object.

  **Note on other harness files:** `src/harness/runner.ts`, `src/harness/types.ts`, the generator file, and `test/scenarios.test.ts` ARE modified in Task 4b, which extends the harness with opt-in per-step session-state capture. The change is surgical (~30 lines total), guarded behind `Scenario.captureStepState: true`, and leaves existing scenarios byte-identical on the result side. See Task 4b for the full delta and the decision log for the rationale.

### Task order rationale

Tasks run strictly top-to-bottom.

- Tasks 1–4 add the foundational type + helper + session field + unit test so the rest of the plan has something to call.
- Task 4b extends the scenario harness with opt-in per-step session-state capture so scenario 030 (Task 15) can assert every navigation variant end-to-end from a single walkthrough, not just the terminal one. This task lands before the instrumentation tasks so they can rely on the new assertion shape when regeneration runs in Task 13.
- Tasks 5–12 (including 8b) thread the helper through every existing render site, including the free-text recipe lookup branch. Each is a small, surgical edit. They are grouped by file region (callback handlers, menu handlers, post-confirmation, progress) to minimize jumping around `core.ts`.
- Task 13 regenerates scenario recordings affected by the new `finalSession` field.
- Task 14 is the planFlow-clear audit: documentation + regression-lock scenarios 031/032/033 for the user-reachable uncovered paths. Audit site #9 is flagged as dead code (no scenario). This task is last among code tasks so it can reference the final state of `core.ts` after Tasks 5–12.
- Task 15 adds scenarios 030 (navigation-state walkthrough with per-step assertions covering 9 of 10 variants), 035 (single-step sibling for the 10th variant, `progress/log_prompt`, which requires mutually exclusive seed state), and 036 (regression lock for proposal 003 §755's explicitly-named back-button audit outcome: day detail → "← Back to week" → week overview).
- Task 16 updates `test/scenarios/index.md` with the new rows.
- Task 17 syncs `docs/product-specs/ui-architecture.md` and `docs/product-specs/testing.md`.
- Task 18 is the final `npm test` + `npx tsc --noEmit` + baseline + commit.

Every task ends with a commit. `npm test` stays green after every task.

---

## Tasks

### Task 1: Green baseline

**Files:** none — sanity check.

- [ ] **Step 1: Confirm clean `npm test`**

Run: `npm test`
Expected: all scenarios and unit tests pass. Note the count in the output (something like `# tests NN`) so later tasks can confirm no regressions.

- [ ] **Step 2: Note current highest scenario number**

Run: `ls test/scenarios/ | grep -E '^[0-9]+' | sort -r | head -5`
Expected: `029-recipe-flow-happy-path` is the highest today. New scenarios added by this plan will be 030 (navigation walkthrough, Task 15), 031 (shopping-list audit, Task 14), 032 (discard_recipe audit, Task 14), 033 (recipe-edit audit, Task 14), 035 (progress log_prompt sibling, Task 15), and 036 (day-detail back-button audit, Task 15). Scenario 034 was drafted but removed after review found `plan_cancel` is dead code — see audit row #9 in Task 14. Scenario 035 skips 034 for this reason and to keep scenarios 030/035/036 visibly grouped as navigation scenarios.

- [ ] **Step 3: Confirm there is no existing `src/telegram/navigation-state.ts`**

Run: `ls src/telegram/navigation-state.ts 2>&1 || echo "not found"`
Expected: "not found" (or a "No such file" error). Task 2 creates it.

No commit — this is a verification step.

---

### Task 2: Create `src/telegram/navigation-state.ts` with the `LastRenderedView` type and helper

**Rationale:** The new module is a leaf — it has no imports from `core.ts` or any other module in the telegram layer. Keeping it standalone lets Task 4's unit test exercise it directly without constructing a whole `BotCore`. The helper takes a structural `NavigationSessionSlice` rather than the full `BotCoreSession` so it's testable against plain `{}`-shaped objects AND usable by `core.ts` (whose `BotCoreSession` conforms to the slice shape structurally once Task 3 adds the field).

**Files:**
- Create: `src/telegram/navigation-state.ts`

- [ ] **Step 1: Create the module**

Create `src/telegram/navigation-state.ts` with:

```typescript
/**
 * Navigation state — the precise "what the user is looking at" model.
 *
 * Part of Plan 027 (Navigation state model, Plan B from proposal
 * `003-freeform-conversation-layer.md`). The goal of this module is to
 * capture, with discriminated-union precision, every render target the bot
 * produces so later plans (the dispatcher in Plan C, the back-button
 * computation in Plan D) can read session state and reconstruct the last
 * view exactly — including parameters (day, batchId, slug, scope, etc.) —
 * without having to re-derive them from loose fields.
 *
 * ## Design choices
 *
 *   - **Discriminated union, not an open string.** A typed union catches
 *     typos at compile time and lets TypeScript narrow on the `surface`
 *     discriminant inside handler code. The price is that every new render
 *     target must be added here first, which is exactly the bookkeeping we
 *     want.
 *
 *   - **Surface discriminant matches `BotCoreSession.surfaceContext`.** The
 *     `surface` field of every variant is one of the existing five values
 *     (`'plan' | 'cooking' | 'shopping' | 'recipes' | 'progress'`). The
 *     null case is represented by `session.lastRenderedView` being
 *     `undefined`, not by a null variant. The invariant `setLastRenderedView`
 *     enforces is: after calling it, `session.surfaceContext` equals
 *     `view.surface`.
 *
 *   - **Cook view's surface is `'cooking'`, not `'plan'`.** This matches
 *     today's `surfaceContext` convention where `cv_*` sets
 *     `surfaceContext = 'cooking'` (`src/telegram/core.ts:730`). Proposal
 *     003's "Navigation state model" description groups cook view under
 *     "plan subview" conceptually, but the live code uses `'cooking'` as
 *     the surface value; we match the live code to avoid churning existing
 *     behavior. A future plan may unify these.
 *
 *   - **Shopping scope is minimal in v0.0.5: `next_cook` and `day`.** The
 *     proposal lists `full_week` and `recipe` scopes as well, but those
 *     require extending the shopping generator and are explicitly out of
 *     Plan B's scope (Plan E implements them). The union intentionally
 *     omits them; adding them later is a non-breaking extension.
 *
 *   - **Recipe library view does not carry `page`.** The current session
 *     already tracks `recipeListPage` as a top-level field, and the
 *     library renderer reads it. Duplicating it into `LastRenderedView`
 *     would create two sources of truth. The re-render helper (Plan C)
 *     will read `recipeListPage` separately when rehydrating the library
 *     view.
 *
 *   - **`setLastRenderedView` mutates in place and does NOT clear
 *     `lastRecipeSlug`.** The existing handlers that care about
 *     `lastRecipeSlug` (free-text fallback in `src/telegram/core.ts:260`)
 *     read it independently. Centralizing `lastRecipeSlug` management here
 *     would change the existing free-text fallback behavior, which is
 *     explicitly out of Plan B's scope. Callers that need to clear it
 *     continue to do so explicitly where they do today.
 */

/**
 * The discriminated union of every navigation render the bot produces.
 *
 * Every variant must be reachable from exactly one handler call site in
 * `src/telegram/core.ts`. Adding a new render target = adding a variant
 * here AND adding a `setLastRenderedView` call at the new handler.
 *
 * The shape follows two discriminants:
 *   - `surface`: one of the five surface-context values
 *   - a secondary discriminant (`view` for most surfaces, inlined into the
 *     variant) that identifies the specific subview
 *
 * Parameters carried by each variant are the minimum needed to rerender
 * the view later. Anything already stored elsewhere on `BotCoreSession`
 * (e.g., `recipeListPage`) is not duplicated.
 */
export type LastRenderedView =
  | { surface: 'plan'; view: 'next_action' }
  | { surface: 'plan'; view: 'week_overview' }
  | { surface: 'plan'; view: 'day_detail'; day: string }
  | { surface: 'cooking'; view: 'cook_view'; batchId: string; recipeSlug: string }
  | { surface: 'shopping'; view: 'next_cook' }
  | { surface: 'shopping'; view: 'day'; day: string }
  | { surface: 'recipes'; view: 'library' }
  | { surface: 'recipes'; view: 'recipe_detail'; slug: string }
  | { surface: 'progress'; view: 'log_prompt' }
  | { surface: 'progress'; view: 'weekly_report' };

/**
 * The subset of `BotCoreSession` fields that `setLastRenderedView` touches.
 * Declared structurally so the helper can be unit-tested against plain
 * objects and doesn't have to import `BotCoreSession` (which would create
 * a circular dependency with `core.ts`).
 */
export interface NavigationSessionSlice {
  surfaceContext: 'plan' | 'cooking' | 'shopping' | 'recipes' | 'progress' | null;
  lastRenderedView?: LastRenderedView;
}

/**
 * Record that a navigation view was just rendered.
 *
 * Mutates the session in place:
 *   - `session.lastRenderedView = view`
 *   - `session.surfaceContext = view.surface`
 *
 * Does NOT touch:
 *   - `session.lastRecipeSlug` — legacy field managed by specific handlers;
 *     see the module doc-comment for why it stays independent.
 *   - any flow state (`planFlow`, `recipeFlow`, `progressFlow`) — navigation
 *     state is orthogonal to flow state and must never mutate flows.
 *
 * Call this **immediately before** `sink.reply(...)` at every render site.
 * Placing it right before the reply minimizes the window in which the
 * session is inconsistent with what the user will see.
 *
 * @param session - A session object conforming to `NavigationSessionSlice`.
 *                  The real caller is `BotCoreSession` from `core.ts`, but
 *                  unit tests pass plain objects.
 * @param view - The discriminated-union descriptor of the view just rendered.
 */
export function setLastRenderedView(
  session: NavigationSessionSlice,
  view: LastRenderedView,
): void {
  session.lastRenderedView = view;
  session.surfaceContext = view.surface;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. The new file is self-contained and doesn't touch anything else yet.

- [ ] **Step 3: Commit**

```bash
git add src/telegram/navigation-state.ts
git commit -m "Plan 027: add LastRenderedView type and setLastRenderedView helper"
```

---

### Task 3: Add `lastRenderedView` field to `BotCoreSession`, update `reset()`, and clear it in `/start` and `/cancel`

**Files:**
- Modify: `src/telegram/core.ts:183-201` (interface)
- Modify: `src/telegram/core.ts:1343-1351` (reset function)
- Modify: `src/telegram/core.ts:321-331` (`/start` command handler)
- Modify: `src/telegram/core.ts:333-340` (`/cancel` command handler)
- Modify: `src/telegram/core.ts:66-89` (imports block — add the new import)

- [ ] **Step 1: Import the type and helper**

In `src/telegram/core.ts`, add a new import line directly after the `keyboards.js` import block ends (around line 89). Before Task 3, line 89 is the closing `} from './keyboards.js';`. After Task 3, a new line follows:

```typescript
import { setLastRenderedView, type LastRenderedView } from './navigation-state.js';
```

The type-only re-export keeps the import surface tight — `core.ts` uses the type on the interface and the helper in handler bodies.

- [ ] **Step 2: Add `lastRenderedView?: LastRenderedView` to the interface**

Replace the current `BotCoreSession` interface in `src/telegram/core.ts:183-201` with:

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
   * (day, batchId, slug, etc.). The dispatcher in Plan C reads this to
   * compute dynamic back-button targets; set via `setLastRenderedView`
   * immediately before every render's `sink.reply`. Stays `undefined` on
   * session init and after `reset()`.
   */
  lastRenderedView?: LastRenderedView;
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

- [ ] **Step 3: Update `reset()` to clear the new field**

Replace the `reset()` function body in `src/telegram/core.ts:1343-1351` with:

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
    session.pendingReplan = undefined;
  }
```

(The only change is the new `session.lastRenderedView = undefined;` line, inserted after `session.lastRecipeSlug = undefined;`.)

- [ ] **Step 3b: Update the `/start` command handler to clear `lastRenderedView`**

The `/start` handler (`src/telegram/core.ts:321-331`) already clears `recipeFlow`, `planFlow`, `progressFlow`, `pendingReplan`, `surfaceContext`, and `lastRecipeSlug`. It represents a complete reset of the user's surface state. Without also clearing `lastRenderedView`, a render that happened before `/start` would survive the reset and Plan C's dispatcher would read a stale view. Replace the handler with:

```typescript
    if (command === 'start') {
      session.recipeFlow = null;
      session.planFlow = null;
      session.progressFlow = null;
      session.pendingReplan = undefined;
      session.surfaceContext = null;
      session.lastRecipeSlug = undefined;
      session.lastRenderedView = undefined;
      await sink.reply('Welcome to Flexie. Use the menu below to get started.', {
        reply_markup: await getMenuKeyboard(),
      });
      return;
    }
```

(The only change is the new `session.lastRenderedView = undefined;` line immediately after `session.lastRecipeSlug = undefined;`.)

- [ ] **Step 3c: Update the `/cancel` command handler to clear `lastRenderedView`**

The existing `/cancel` handler (`src/telegram/core.ts:333-340`) clears the three flow states and `pendingReplan` but intentionally leaves `surfaceContext` and `lastRecipeSlug` alone — a pre-existing quirk that Plan 027 does NOT change. However, for the new `lastRenderedView` field, the correct behavior at `/cancel` time is to clear it: an explicit cancel means "drop the current context", and leaving `lastRenderedView` populated would let Plan C's dispatcher compute back-button targets for a view the user just explicitly escaped. This is a deliberate, small expansion of `/cancel`'s cleanup scope — justified because the new field is ONLY added in this plan (no prior behavior to preserve) and because keeping the new field stale would silently contradict Plan C's contract.

Replace the handler with:

```typescript
    if (command === 'cancel') {
      session.recipeFlow = null;
      session.planFlow = null;
      session.progressFlow = null;
      session.pendingReplan = undefined;
      session.lastRenderedView = undefined;
      await sink.reply('Cancelled.', { reply_markup: await getMenuKeyboard() });
      return;
    }
```

(The only change is the new `session.lastRenderedView = undefined;` line after `session.pendingReplan = undefined;`. The pre-existing omission of `surfaceContext` and `lastRecipeSlug` clearing is kept verbatim — scope-guarded against other fixes.)

- [ ] **Step 4: Leave `createBotCore()` initializer alone**

The initial `session` object built in `createBotCore()` (`src/telegram/core.ts:228-234`) does not need a new entry — `lastRenderedView` is optional and defaults to `undefined` when not set. Verify by reading lines 228-234 and confirming there's no `surfaceContext: null` pattern the new field should match. Expected: leave as-is.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. The `setLastRenderedView` import is unused (warnings-as-errors may fail here if strict), in which case temporarily comment out the helper import and leave only the type import, then Task 5 adds the first real caller.

**If the unused-import warning fails the typecheck**: tsc by default does NOT emit warnings for unused imports, so this is unlikely unless the project has enabled `noUnusedLocals` or an ESLint integration. Check `tsconfig.json` for `noUnusedLocals`; if set, change the import line for this task only to just the type:

```typescript
import type { LastRenderedView } from './navigation-state.js';
```

…and restore the full import with the helper in Task 5's first sub-step. Either way, the final tree after Task 5 has both imported.

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: PASS. Adding an optional field cannot affect any scenario's recorded output because no handler yet sets it, and `JSON.stringify` on an object with `undefined` fields drops them.

- [ ] **Step 7: Commit**

```bash
git add src/telegram/core.ts
git commit -m "Plan 027: add lastRenderedView field to BotCoreSession and clear it in reset/start/cancel"
```

---

### Task 4: Unit test — `setLastRenderedView` against every variant

**Files:**
- Create: `test/unit/navigation-state.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/navigation-state.test.ts` with:

```typescript
/**
 * Unit tests for `setLastRenderedView` — Plan 027.
 *
 * Verifies every `LastRenderedView` variant round-trips onto a session
 * slice correctly and that `surfaceContext` always mirrors the view's
 * surface field. Plain objects are used as session slices so the test
 * doesn't need to construct a full BotCore.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  setLastRenderedView,
  type LastRenderedView,
  type NavigationSessionSlice,
} from '../../src/telegram/navigation-state.js';

/** Fresh slice with both tracked fields cleared. */
function newSlice(): NavigationSessionSlice {
  return { surfaceContext: null, lastRenderedView: undefined };
}

test('setLastRenderedView: plan/next_action', () => {
  const s = newSlice();
  const view: LastRenderedView = { surface: 'plan', view: 'next_action' };
  setLastRenderedView(s, view);
  assert.deepStrictEqual(s.lastRenderedView, view);
  assert.equal(s.surfaceContext, 'plan');
});

test('setLastRenderedView: plan/week_overview', () => {
  const s = newSlice();
  const view: LastRenderedView = { surface: 'plan', view: 'week_overview' };
  setLastRenderedView(s, view);
  assert.deepStrictEqual(s.lastRenderedView, view);
  assert.equal(s.surfaceContext, 'plan');
});

test('setLastRenderedView: plan/day_detail carries day', () => {
  const s = newSlice();
  const view: LastRenderedView = { surface: 'plan', view: 'day_detail', day: '2026-04-09' };
  setLastRenderedView(s, view);
  assert.deepStrictEqual(s.lastRenderedView, view);
  assert.equal(s.surfaceContext, 'plan');
});

test('setLastRenderedView: cooking/cook_view carries batchId and recipeSlug', () => {
  const s = newSlice();
  const view: LastRenderedView = {
    surface: 'cooking',
    view: 'cook_view',
    batchId: 'batch-123',
    recipeSlug: 'moroccan-beef-tagine',
  };
  setLastRenderedView(s, view);
  assert.deepStrictEqual(s.lastRenderedView, view);
  assert.equal(s.surfaceContext, 'cooking');
});

test('setLastRenderedView: shopping/next_cook', () => {
  const s = newSlice();
  const view: LastRenderedView = { surface: 'shopping', view: 'next_cook' };
  setLastRenderedView(s, view);
  assert.deepStrictEqual(s.lastRenderedView, view);
  assert.equal(s.surfaceContext, 'shopping');
});

test('setLastRenderedView: shopping/day carries day', () => {
  const s = newSlice();
  const view: LastRenderedView = { surface: 'shopping', view: 'day', day: '2026-04-09' };
  setLastRenderedView(s, view);
  assert.deepStrictEqual(s.lastRenderedView, view);
  assert.equal(s.surfaceContext, 'shopping');
});

test('setLastRenderedView: recipes/library', () => {
  const s = newSlice();
  const view: LastRenderedView = { surface: 'recipes', view: 'library' };
  setLastRenderedView(s, view);
  assert.deepStrictEqual(s.lastRenderedView, view);
  assert.equal(s.surfaceContext, 'recipes');
});

test('setLastRenderedView: recipes/recipe_detail carries slug', () => {
  const s = newSlice();
  const view: LastRenderedView = { surface: 'recipes', view: 'recipe_detail', slug: 'lemon-chicken' };
  setLastRenderedView(s, view);
  assert.deepStrictEqual(s.lastRenderedView, view);
  assert.equal(s.surfaceContext, 'recipes');
});

test('setLastRenderedView: progress/log_prompt', () => {
  const s = newSlice();
  const view: LastRenderedView = { surface: 'progress', view: 'log_prompt' };
  setLastRenderedView(s, view);
  assert.deepStrictEqual(s.lastRenderedView, view);
  assert.equal(s.surfaceContext, 'progress');
});

test('setLastRenderedView: progress/weekly_report', () => {
  const s = newSlice();
  const view: LastRenderedView = { surface: 'progress', view: 'weekly_report' };
  setLastRenderedView(s, view);
  assert.deepStrictEqual(s.lastRenderedView, view);
  assert.equal(s.surfaceContext, 'progress');
});

test('setLastRenderedView: setting a new view replaces an older one', () => {
  const s = newSlice();
  setLastRenderedView(s, { surface: 'plan', view: 'next_action' });
  setLastRenderedView(s, { surface: 'shopping', view: 'next_cook' });
  assert.deepStrictEqual(s.lastRenderedView, { surface: 'shopping', view: 'next_cook' });
  assert.equal(s.surfaceContext, 'shopping');
});

test('setLastRenderedView: does not touch other slice fields it does not own', () => {
  const s: NavigationSessionSlice & { lastRecipeSlug?: string; marker?: string } = {
    surfaceContext: null,
    lastRenderedView: undefined,
    lastRecipeSlug: 'keep-me',
    marker: 'untouched',
  };
  setLastRenderedView(s, { surface: 'plan', view: 'next_action' });
  assert.equal(s.lastRecipeSlug, 'keep-me');
  assert.equal(s.marker, 'untouched');
});
```

- [ ] **Step 2: Run the unit test**

Run: `npm test -- --test-name-pattern="setLastRenderedView"`
Expected: PASS — all twelve test cases succeed.

If the harness-wrapper script `npm test` doesn't accept `--test-name-pattern` directly, fall back to running `node --test test/unit/navigation-state.test.ts` (compiling first via `npx tsc` if the test runner is not picking up `.ts` files). The project's primary test runner is `node:test` via `npm test`; if in doubt, read `package.json`'s `scripts.test` to confirm.

- [ ] **Step 3: Run full tests**

Run: `npm test`
Expected: PASS. The new unit tests should be included in the count; no existing scenarios should regress.

- [ ] **Step 4: Commit**

```bash
git add test/unit/navigation-state.test.ts
git commit -m "Plan 027: unit tests for setLastRenderedView"
```

---

### Task 4b: Extend the scenario harness with opt-in per-step session-state capture

**Rationale:** Proposal 003's verification contract for Plan B (`docs/design-docs/proposals/003-freeform-conversation-layer.md:755`) is explicit: "Scenarios that drive the user through existing flows and verify the new state is tracked correctly." The existing harness only asserts `finalSession` ONCE at the end of each scenario (`test/scenarios.test.ts:102-106`), so a walkthrough that renders ten different views only ever verifies the terminal variant. For `LastRenderedView` specifically — the whole point of this plan — that means nine of ten variants in scenario 030's walkthrough would have NO end-to-end assertion, only unit-test coverage from Task 4. That fails to deliver the design doc's requirement.

This task closes the gap by extending the harness with an **opt-in per-step session-state capture**. Scenarios that declare `captureStepState: true` in their spec get a `sessionAt: unknown[]` array recorded alongside `finalSession` — one entry per event, captured immediately after `core.dispatch(...)` returns. When the test replays the scenario, a fourth `deepStrictEqual` compares `result.sessionAt` to `recorded.expected.sessionAt` if the recording has one; scenarios that don't opt in see no behavior change.

**Why opt-in, not always-on.** Always-on would inflate every existing scenario's `recorded.json` with 4-10 full session snapshots. For a non-navigation scenario (say 002-plan-week-flex-move-regression), those snapshots are noise that adds bytes but no signal, and any regeneration would have to re-capture them. Opt-in keeps the new capture surgical: only scenarios that actually care about per-step state declare it, and exactly one scenario in Plan 027 (030) uses it.

**Why not a separate "state snapshot scenario" type.** A separate type would be a bigger API change to the harness and would force scenarios to choose between "drive the walkthrough" OR "assert per-step" — but the point of scenario 030 is to do both. Adding an opt-in field to the existing `Scenario` interface is the minimum-diff shape.

**Files:**
- Modify: `src/harness/types.ts` — add `captureStepState?: boolean` to `Scenario`, add `sessionAt?: unknown[]` to `ScenarioExpected` and `ScenarioResult`.
- Modify: `src/harness/runner.ts` — when `spec.captureStepState` is true, capture `normalizeUuids(JSON.parse(JSON.stringify(core.session)))` immediately after each `core.dispatch(...)` and push to a `sessionAt` array. Return it in the result. When false, leave the result's `sessionAt` undefined.
- Modify: `src/harness/generator.ts` — mirror the same capture logic so `recorded.json` includes `sessionAt` when the spec opts in.
- Modify: `test/scenarios.test.ts` — after the existing three `deepStrictEqual` checks, add a fourth that compares `result.sessionAt` to `recorded.expected.sessionAt` **only if** the recording has one. Scenarios that don't opt in are unaffected.

- [ ] **Step 1: Extend `Scenario`, `ScenarioExpected`, and `ScenarioResult` types**

In `src/harness/types.ts`, add the new optional field to `Scenario`:

```typescript
export interface Scenario {
  name: string;
  description: string;
  clock: string;
  recipeSet: string;
  initialState: ScenarioInitialState;
  events: ScenarioEvent[];
  /**
   * Plan 027: if true, the runner captures a snapshot of `core.session`
   * after every dispatched event and exposes it as `result.sessionAt`.
   * The generator writes the same array to `recorded.expected.sessionAt`.
   * The test file's fourth `deepStrictEqual` asserts them equal if
   * `recorded.expected.sessionAt` is present. Opt-in so scenarios that
   * don't need per-step state assertions don't inflate their recordings.
   */
  captureStepState?: boolean;
}
```

Add the new optional field to `ScenarioExpected`:

```typescript
export interface ScenarioExpected {
  outputs: CapturedOutput[];
  finalSession: unknown;
  finalStore: unknown;
  /**
   * Plan 027: per-step snapshots of `core.session` captured after every
   * dispatched event. Present only when the scenario opts in via
   * `captureStepState: true`. Length equals `spec.events.length` when
   * present.
   */
  sessionAt?: unknown[];
}
```

Add the same to `ScenarioResult`:

```typescript
export interface ScenarioResult {
  outputs: CapturedOutput[];
  finalSession: unknown;
  finalStore: unknown;
  sessionAt?: unknown[];
}
```

- [ ] **Step 2: Capture per-step session state in `runScenario`**

In `src/harness/runner.ts`, extend the dispatch loop. Replace:

```typescript
    for (const event of spec.events) {
      await core.dispatch(toUpdate(event), sink);
    }

    // Snapshot-serialize both state fields via JSON round-trip, then
    // normalize UUIDs to stable placeholders so the comparison tolerates
    // the non-deterministic ids produced by `uuid.v4()` in plan-flow.
    // Output text may also contain UUIDs (e.g. inside error messages) —
    // normalize the outputs array too for symmetry with the recording.
    return {
      outputs: normalizeUuids(JSON.parse(JSON.stringify(sink.captured))),
      finalSession: normalizeUuids(JSON.parse(JSON.stringify(core.session))),
      finalStore: normalizeUuids(JSON.parse(JSON.stringify(store.snapshot()))),
    };
```

with:

```typescript
    const sessionAt: unknown[] = [];
    for (const event of spec.events) {
      await core.dispatch(toUpdate(event), sink);
      if (spec.captureStepState) {
        // Snapshot-serialize the session after every dispatched event so
        // per-step assertions can verify navigation state transitions.
        // Matches the same JSON+normalizeUuids contract as finalSession.
        sessionAt.push(normalizeUuids(JSON.parse(JSON.stringify(core.session))));
      }
    }

    // Snapshot-serialize both state fields via JSON round-trip, then
    // normalize UUIDs to stable placeholders so the comparison tolerates
    // the non-deterministic ids produced by `uuid.v4()` in plan-flow.
    // Output text may also contain UUIDs (e.g. inside error messages) —
    // normalize the outputs array too for symmetry with the recording.
    const result: ScenarioResult = {
      outputs: normalizeUuids(JSON.parse(JSON.stringify(sink.captured))),
      finalSession: normalizeUuids(JSON.parse(JSON.stringify(core.session))),
      finalStore: normalizeUuids(JSON.parse(JSON.stringify(store.snapshot()))),
    };
    if (spec.captureStepState) {
      result.sessionAt = sessionAt;
    }
    return result;
```

The key discipline: only attach `sessionAt` to the result when the spec opted in. A scenario that did NOT opt in gets a result with no `sessionAt` field, which `JSON.stringify` drops on the recording side and the assertion below ignores.

- [ ] **Step 3: Mirror the capture in the generator**

The generator (`src/harness/generator.ts` or whatever the entry point resolves to) runs the same dispatch loop and writes `recorded.json`. Read the file to confirm its location — it may be `src/harness/generator.ts`, `src/harness/record.ts`, or inside another file depending on the current code shape. Grep for the write site:

```bash
# Expected grep from scratch — do not hardcode the exact file:
npx grep -rn "sessionAt\|finalSession.*store.snapshot\|recorded\.json" src/harness/
```

Whichever file writes `recorded.expected.finalSession`, extend it to also capture per-step snapshots when `spec.captureStepState === true`:

```typescript
// Inside the event loop (conceptual; adjust to the file's existing shape):
const sessionAt: unknown[] = [];
for (const event of spec.events) {
  await core.dispatch(toUpdate(event), sink);
  if (spec.captureStepState) {
    sessionAt.push(normalizeUuids(JSON.parse(JSON.stringify(core.session))));
  }
}

// When building the recording:
const expected: ScenarioExpected = {
  outputs: normalizeUuids(JSON.parse(JSON.stringify(sink.captured))),
  finalSession: normalizeUuids(JSON.parse(JSON.stringify(core.session))),
  finalStore: normalizeUuids(JSON.parse(JSON.stringify(store.snapshot()))),
};
if (spec.captureStepState) {
  expected.sessionAt = sessionAt;
}
```

The implementation code is nearly identical to Step 2's runner change — the generator is structurally the same loop, just with a real LLM provider and a writing wrapper. Implementation may deduplicate via a shared helper, but that refactor is optional and outside Plan 027's scope; copying the ~6 lines is acceptable.

- [ ] **Step 4: Add the fourth assertion in `test/scenarios.test.ts`**

In `test/scenarios.test.ts` (around lines 97-112), after the three existing `assert.deepStrictEqual` calls, add:

```typescript
    // Plan 027: per-step session assertions for scenarios that opt in.
    // The recording's `sessionAt` is undefined for scenarios without
    // `captureStepState: true`, and `deepStrictEqual(undefined, undefined)`
    // passes trivially — so this check is a no-op for existing scenarios.
    if (recorded.expected.sessionAt !== undefined) {
      assert.deepStrictEqual(
        result.sessionAt,
        recorded.expected.sessionAt,
        'sessionAt diverged from recorded per-step state',
      );
    }
```

This guard is load-bearing: existing scenarios have no `sessionAt` in their recordings, so the check is skipped. Only scenarios that opt in produce a `sessionAt` in their recording AND return a `sessionAt` in the runner result; those scenarios DO run the assertion.

- [ ] **Step 5: Typecheck and run tests**

Run: `npx tsc --noEmit`
Expected: no errors. The new field is optional, so existing scenarios' recordings (which lack `sessionAt`) still typecheck against `ScenarioExpected`.

Run: `npm test`
Expected: all existing scenarios pass unchanged — no scenario has opted in yet, so the new assertion is a no-op everywhere.

- [ ] **Step 6: Commit**

```bash
git add src/harness/types.ts src/harness/runner.ts src/harness/generator.ts test/scenarios.test.ts
git commit -m "Plan 027: harness — opt-in per-step session-state capture for navigation scenarios"
```

**Note on the generator file path.** The exact file that gets added to the commit depends on the current harness shape. If the generator lives at a different path than `src/harness/generator.ts`, adjust the `git add` line accordingly; the import graph and behavior are what matter.

---

### Task 5: Instrument plan subview handlers — `na_show`, `wo_show`, `dd_<date>`

**Rationale:** These three callbacks are co-located in `src/telegram/core.ts:663-711` inside a single `if` branch. Instrumenting all three in one task is simpler than splitting them because they share setup (`planSession`, `batchViews`). The helper call goes immediately before each `sink.reply`.

**Files:**
- Modify: `src/telegram/core.ts:663-711`

- [ ] **Step 1: Add the `setLastRenderedView` import (if not already present from Task 3)**

Verify `src/telegram/core.ts` has this import line near the top (added in Task 3):

```typescript
import { setLastRenderedView, type LastRenderedView } from './navigation-state.js';
```

If Task 3 temporarily downgraded the import to `type`-only because of `noUnusedLocals`, restore the full import now.

- [ ] **Step 2: Instrument `na_show`**

In the `na_show` branch (`src/telegram/core.ts:675-682`), insert the helper call just before `sink.reply(text, {...})`. Replace:

```typescript
      if (action === 'na_show') {
        const text = formatNextAction(batchViews, planSession.events, planSession.flexSlots, today, planSession.horizonStart);
        const nextCook = getNextCookDay(allBatches, today);
        const nextCookBatchViews = nextCook
          ? batchViews.filter(bv => bv.batch.eatingDays[0] === nextCook.date)
          : [];
        await sink.reply(text, { reply_markup: nextActionKeyboard(nextCookBatchViews, lifecycle), parse_mode: 'MarkdownV2' });
        return;
      }
```

with:

```typescript
      if (action === 'na_show') {
        const text = formatNextAction(batchViews, planSession.events, planSession.flexSlots, today, planSession.horizonStart);
        const nextCook = getNextCookDay(allBatches, today);
        const nextCookBatchViews = nextCook
          ? batchViews.filter(bv => bv.batch.eatingDays[0] === nextCook.date)
          : [];
        setLastRenderedView(session, { surface: 'plan', view: 'next_action' });
        await sink.reply(text, { reply_markup: nextActionKeyboard(nextCookBatchViews, lifecycle), parse_mode: 'MarkdownV2' });
        return;
      }
```

The helper call replaces `surfaceContext = 'plan'` one-shot on line 673. But line 673 runs BEFORE the branch split (it applies to all three subviews). Do NOT remove line 673 — leave `session.surfaceContext = 'plan';` as-is, because the helper calls for `wo_show` and `dd_` (below) ALSO set `surfaceContext = 'plan'` via the helper, so the line 673 assignment is redundant-but-harmless. Removing it would be a separate cleanup; keep it to avoid diff churn.

- [ ] **Step 3: Instrument `wo_show`**

Replace the `wo_show` block (`src/telegram/core.ts:685-696`):

```typescript
      if (action === 'wo_show') {
        const breakfastRecipe = recipes.getBySlug(planSession.breakfast.recipeSlug);
        const text = formatWeekOverview(planSession, batchViews, planSession.events, planSession.flexSlots, breakfastRecipe);
        // Build 7-day array from horizon
        const weekDays: string[] = [];
        const d = new Date(planSession.horizonStart + 'T00:00:00');
        for (let i = 0; i < 7; i++) {
          weekDays.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
          d.setDate(d.getDate() + 1);
        }
        await sink.reply(text, { reply_markup: weekOverviewKeyboard(weekDays), parse_mode: 'MarkdownV2' });
        return;
      }
```

with:

```typescript
      if (action === 'wo_show') {
        const breakfastRecipe = recipes.getBySlug(planSession.breakfast.recipeSlug);
        const text = formatWeekOverview(planSession, batchViews, planSession.events, planSession.flexSlots, breakfastRecipe);
        // Build 7-day array from horizon
        const weekDays: string[] = [];
        const d = new Date(planSession.horizonStart + 'T00:00:00');
        for (let i = 0; i < 7; i++) {
          weekDays.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
          d.setDate(d.getDate() + 1);
        }
        setLastRenderedView(session, { surface: 'plan', view: 'week_overview' });
        await sink.reply(text, { reply_markup: weekOverviewKeyboard(weekDays), parse_mode: 'MarkdownV2' });
        return;
      }
```

- [ ] **Step 4: Instrument `dd_<date>`**

Replace the `dd_` block (`src/telegram/core.ts:699-710`):

```typescript
      if (action.startsWith('dd_')) {
        const date = action.slice(3);
        // Validate ISO date and within horizon
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < planSession.horizonStart || date > planSession.horizonEnd) {
          await sink.reply('Invalid or expired date.', { reply_markup: buildMainMenuKeyboard(lifecycle) });
          return;
        }
        const text = formatDayDetail(date, batchViews, planSession.events, planSession.flexSlots);
        const cookBatchViews = batchViews.filter(bv => bv.batch.eatingDays[0] === date);
        await sink.reply(text, { reply_markup: dayDetailKeyboard(date, cookBatchViews, today), parse_mode: 'MarkdownV2' });
        return;
      }
```

with:

```typescript
      if (action.startsWith('dd_')) {
        const date = action.slice(3);
        // Validate ISO date and within horizon
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < planSession.horizonStart || date > planSession.horizonEnd) {
          await sink.reply('Invalid or expired date.', { reply_markup: buildMainMenuKeyboard(lifecycle) });
          return;
        }
        const text = formatDayDetail(date, batchViews, planSession.events, planSession.flexSlots);
        const cookBatchViews = batchViews.filter(bv => bv.batch.eatingDays[0] === date);
        setLastRenderedView(session, { surface: 'plan', view: 'day_detail', day: date });
        await sink.reply(text, { reply_markup: dayDetailKeyboard(date, cookBatchViews, today), parse_mode: 'MarkdownV2' });
        return;
      }
```

**Note on the `Invalid or expired date` error branch:** it does not set `lastRenderedView` because it's an error path, not a render of a valid view. The user stays on whatever view they were on before the bogus callback arrived. That matches today's behavior for `surfaceContext` (which also stays unchanged on the error path).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: some scenarios touching plan subviews may now fail with a `lastRenderedView` diff (e.g., scenario 018 which ends with `na_show`). Note the failures — Task 13 regenerates them in a batch. Scenarios that do NOT touch these handlers should still pass. If the Task 3 baseline had N scenarios passing, expect roughly N-3 to N-5 passing now (depending on which ones exercise plan subviews at their final step). If the failure count exceeds 10, investigate: the type mismatch from an unused import or a transposed variant may be breaking more than expected.

- [ ] **Step 7: Commit**

```bash
git add src/telegram/core.ts
git commit -m "Plan 027: instrument na_show, wo_show, dd_ handlers with setLastRenderedView"
```

**Note on intermediate red tests:** The commit leaves `npm test` red for the scenarios that end on na_/wo_/dd_. That's deliberate — the state IS correct, the recordings just need to catch up in Task 13. Plan A's Tasks 3–5 used the same pattern (intentionally leaving the tree broken during the type-and-store plumbing phase, then fixing it in a wrap-up task). The same applies here. Do NOT attempt to regenerate recordings inside Task 5; wait until Task 13 where regeneration is centralized.

---

### Task 6: Instrument `cv_<batchId>` cook view handler

**Files:**
- Modify: `src/telegram/core.ts:714-737`

- [ ] **Step 1: Add `setLastRenderedView` call**

Replace the cv_ block (`src/telegram/core.ts:714-737`):

```typescript
    // ─── Cook view callback (Phase 4) ─────────────────────────────────
    if (action.startsWith('cv_')) {
      const batchId = action.slice(3);
      const batch = await store.getBatch(batchId);
      if (!batch) {
        const today = toLocalISODate(new Date());
        const lifecycle = await getPlanLifecycle(session, store, today);
        await sink.reply('Batch not found.', { reply_markup: buildMainMenuKeyboard(lifecycle) });
        return;
      }
      const recipe = recipes.getBySlug(batch.recipeSlug);
      if (!recipe) {
        const today = toLocalISODate(new Date());
        const lifecycle = await getPlanLifecycle(session, store, today);
        await sink.reply('Recipe not found.', { reply_markup: buildMainMenuKeyboard(lifecycle) });
        return;
      }
      session.surfaceContext = 'cooking';
      session.lastRecipeSlug = batch.recipeSlug;
      await sink.reply(
        renderCookView(recipe, batch),
        { reply_markup: cookViewKeyboard(batch.recipeSlug), parse_mode: 'MarkdownV2' },
      );
      return;
    }
```

with:

```typescript
    // ─── Cook view callback (Phase 4) ─────────────────────────────────
    if (action.startsWith('cv_')) {
      const batchId = action.slice(3);
      const batch = await store.getBatch(batchId);
      if (!batch) {
        const today = toLocalISODate(new Date());
        const lifecycle = await getPlanLifecycle(session, store, today);
        await sink.reply('Batch not found.', { reply_markup: buildMainMenuKeyboard(lifecycle) });
        return;
      }
      const recipe = recipes.getBySlug(batch.recipeSlug);
      if (!recipe) {
        const today = toLocalISODate(new Date());
        const lifecycle = await getPlanLifecycle(session, store, today);
        await sink.reply('Recipe not found.', { reply_markup: buildMainMenuKeyboard(lifecycle) });
        return;
      }
      session.lastRecipeSlug = batch.recipeSlug;
      setLastRenderedView(session, {
        surface: 'cooking',
        view: 'cook_view',
        batchId,
        recipeSlug: batch.recipeSlug,
      });
      await sink.reply(
        renderCookView(recipe, batch),
        { reply_markup: cookViewKeyboard(batch.recipeSlug), parse_mode: 'MarkdownV2' },
      );
      return;
    }
```

Note: the explicit `session.surfaceContext = 'cooking';` line is removed because `setLastRenderedView` sets it. `session.lastRecipeSlug = batch.recipeSlug;` stays (the helper does NOT touch `lastRecipeSlug` — by design — and the free-text fallback at `src/telegram/core.ts:260` depends on this field being set).

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: same or slightly more scenarios red (scenario 018 was already red from Task 5; it now has an additional cv_ diff). All other scenarios behave the same.

- [ ] **Step 4: Commit**

```bash
git add src/telegram/core.ts
git commit -m "Plan 027: instrument cv_ cook-view handler with setLastRenderedView"
```

---

### Task 7: Instrument `sl_<param>` shopping list handler (both `next` and date scopes)

**Files:**
- Modify: `src/telegram/core.ts:740-803`

- [ ] **Step 1: Replace the sl_ block**

The block spans from `if (action.startsWith('sl_'))` down through its closing `return;`. Replace `src/telegram/core.ts:740-803` with:

```typescript
    // ─── Shopping list callbacks (Phase 5) ─────────────────────────────
    if (action.startsWith('sl_')) {
      const param = action.slice(3); // "next" or ISO date
      const today = toLocalISODate(new Date());
      const lifecycle = await getPlanLifecycle(session, store, today);
      const planSession = await getVisiblePlanSession(store, today);
      if (!planSession) {
        await sink.reply('No plan for this week.', { reply_markup: buildMainMenuKeyboard(lifecycle) });
        return;
      }

      const { allBatches } = await loadPlanBatches(planSession, recipes);
      const plannedBatches = allBatches.filter(b => b.status === 'planned');

      let targetDate: string;
      let scopeView: LastRenderedView;
      if (param === 'next') {
        const nextCook = getNextCookDay(plannedBatches, today);
        if (!nextCook) {
          await sink.reply('All meals are prepped — no shopping needed\\!', { parse_mode: 'MarkdownV2' });
          return;
        }
        targetDate = nextCook.date;
        scopeView = { surface: 'shopping', view: 'next_cook' };
      } else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(param) || param < today || param < planSession.horizonStart || param > planSession.horizonEnd) {
          await sink.reply('This shopping list is from a different plan week.', { reply_markup: buildMainMenuKeyboard(lifecycle) });
          return;
        }
        targetDate = param;
        scopeView = { surface: 'shopping', view: 'day', day: targetDate };
      }

      const cookBatchesForDay = plannedBatches.filter(b => b.eatingDays[0] === targetDate);
      if (cookBatchesForDay.length === 0 && param !== 'next') {
        await sink.reply('No cooking scheduled for that day.', { reply_markup: buildMainMenuKeyboard(lifecycle) });
        return;
      }

      const breakfastRecipe = recipes.getBySlug(planSession.breakfast.recipeSlug);
      if (!breakfastRecipe) {
        log.warn('CORE', `breakfast recipe not found: ${planSession.breakfast.recipeSlug}`);
      }

      // Compute remaining days inclusive
      const horizonEnd = new Date(planSession.horizonEnd + 'T12:00:00');
      const target = new Date(targetDate + 'T12:00:00');
      const remainingDays = Math.round((horizonEnd.getTime() - target.getTime()) / 86400000) + 1;

      const list = generateShoppingList(plannedBatches, breakfastRecipe ?? undefined, {
        targetDate,
        remainingDays,
      });

      // Build scope description
      const scopeParts = cookBatchesForDay.map(b => {
        const recipe = recipes.getBySlug(b.recipeSlug);
        return `${recipe?.name ?? b.recipeSlug} (${b.servings} servings)`;
      });
      if (breakfastRecipe) scopeParts.push('Breakfast');

      setLastRenderedView(session, scopeView);
      await sink.reply(
        formatShoppingList(list, targetDate, scopeParts.join(' + ')),
        { reply_markup: buildShoppingListKeyboard(), parse_mode: 'MarkdownV2' },
      );
      return;
    }
```

The changes from the pre-Task-7 version:

1. Introduce a `scopeView: LastRenderedView` variable at the top of the branch, set to the right variant inside each branch of the `param === 'next'` split.
2. Replace `session.surfaceContext = 'shopping';` (formerly at the old line 797) with `setLastRenderedView(session, scopeView);` immediately before `sink.reply`.

The early-return error paths ("No plan for this week.", "All meals are prepped", "This shopping list is from a different plan week.", "No cooking scheduled for that day.") do NOT set `lastRenderedView` — they are error responses, not successful shopping-list renders. This mirrors today's behavior where `surfaceContext` was also NOT updated on those early returns.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. The `LastRenderedView` discriminated union is fully narrowed inside the two branches, so TypeScript should accept both `scopeView` assignments.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: scenario 019 (`shopping-list-tiered`) was already red from Task 5 (its final callback is `na_show`), and is now also red at intermediate `sl_` outputs. No new non-shopping scenarios should fail.

- [ ] **Step 4: Commit**

```bash
git add src/telegram/core.ts
git commit -m "Plan 027: instrument sl_ shopping-list handler with scope-aware setLastRenderedView"
```

---

### Task 8: Instrument recipe view `rv_<slug>` handler

**Files:**
- Modify: `src/telegram/core.ts:401-413`

- [ ] **Step 1: Replace the rv_ block**

Replace `src/telegram/core.ts:401-413` with:

```typescript
    // Recipe list: view a specific recipe by slug
    if (action.startsWith('rv_')) {
      const slug = action.slice(3);
      const recipe = recipes.getBySlug(slug) ?? findBySlugPrefix(recipes, slug);
      if (recipe) {
        session.lastRecipeSlug = recipe.slug;
        setLastRenderedView(session, { surface: 'recipes', view: 'recipe_detail', slug: recipe.slug });
        log.debug('FLOW', `recipe view: ${slug}`);
        await sink.reply(renderRecipe(recipe), { reply_markup: recipeViewKeyboard(slug), parse_mode: 'MarkdownV2' });
      } else {
        await sink.reply('Recipe not found.', { reply_markup: await getMenuKeyboard() });
      }
      return;
    }
```

Changes: removed the `session.surfaceContext = 'recipes';` line (the helper sets it), inserted the `setLastRenderedView` call. `session.lastRecipeSlug = recipe.slug;` stays for the same reason as in Task 6 — the free-text fallback reads it directly.

The "Recipe not found" branch does NOT set `lastRenderedView` — it's an error response, not a successful render.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: same red scenarios as before, possibly with additional intermediate diffs in any scenario that walks through a recipe view mid-run.

- [ ] **Step 4: Commit**

```bash
git add src/telegram/core.ts
git commit -m "Plan 027: instrument rv_ recipe-view handler with setLastRenderedView"
```

---

### Task 8b: Instrument free-text recipe lookup render path

**Rationale:** `handleTextInput` has a fall-through branch at `src/telegram/core.ts:1325-1337` that searches the recipe library for a name match against the user's free text and — if a match is found — calls `renderRecipe(recipe)` and replies with its body. This is a **recipe detail render** reached via chat (e.g., the user types "lemon chicken" with no active flow). It produces the same visual surface as the `rv_` callback from Task 8 but is structurally separate: the free-text branch does NOT set `surfaceContext`, does NOT set `lastRecipeSlug`, and attaches no keyboard.

Because it's a recipe render, a user coming here IS "looking at a recipe" — the whole point of Plan 027 is that the session must know this. Not instrumenting it leaves a hole where Plan C's dispatcher reads `lastRenderedView === undefined` even though the user is clearly on a recipe.

Plan 027 closes this hole with a minimum-blast-radius fix: call `setLastRenderedView` with the `recipe_detail` variant, set `lastRecipeSlug` to match the `rv_` callback, and DO NOT change the reply (no keyboard added — that would be a user-facing change outside Plan B's "nothing user-facing" scope). The small behavior change this introduces — the next free-text fallback will now take the "recipe on screen" branch (`src/telegram/core.ts:260`) instead of the generic branch — is a **correctness fix**: today's fallback is wrong to offer the generic hint when the user is staring at a recipe they just looked up. Plan 027's goal is precisely that every render call site updates navigation state, and this site is part of "every".

**Files:**
- Modify: `src/telegram/core.ts:1325-1337`

- [ ] **Step 1: Replace the free-text recipe lookup block**

Replace `src/telegram/core.ts:1325-1337`:

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

with:

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
      session.lastRecipeSlug = recipe.slug;
      setLastRenderedView(session, { surface: 'recipes', view: 'recipe_detail', slug: recipe.slug });
      await sink.reply(renderRecipe(recipe), { parse_mode: 'MarkdownV2' });
      return;
    }
```

Changes:
1. Insert `session.lastRecipeSlug = recipe.slug;` before the helper call — matches the pattern used in Task 8's `rv_` handler and ensures the free-text fallback at `src/telegram/core.ts:260` recognizes the recipe on screen.
2. Insert `setLastRenderedView(session, { surface: 'recipes', view: 'recipe_detail', slug: recipe.slug });` immediately before `sink.reply`. The helper sets `surfaceContext = 'recipes'` as a side effect.
3. The `sink.reply(...)` call is unchanged — no keyboard added. Keyboard attachment is a user-facing change and is deliberately outside Plan 027's scope; the missing keyboard stays as a pre-existing quirk for a future plan to address.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. Reuses the `recipe_detail` variant from the discriminated union.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: any scenario whose final event is a free-text recipe name lookup gains a new `lastRenderedView` field in its recording. Scenario 017 (`free-text-fallback`) does NOT hit this site (its texts don't match any recipe name — they exercise the fallback branches, not the recipe-found branch), so it should be unaffected. No known scenario terminates on this site today; a fresh terminal-assertion scenario is added below in Task 15.

- [ ] **Step 4: Commit**

```bash
git add src/telegram/core.ts
git commit -m "Plan 027: instrument free-text recipe lookup with setLastRenderedView"
```

---

### Task 9: Instrument recipe library renderer `showRecipeList` (single chokepoint)

**Rationale:** The recipe library is rendered from **five** distinct call sites:
- `src/telegram/core.ts:424` — after deleting a recipe via `rd_`
- `src/telegram/core.ts:453` — page navigation via `rp_`
- `src/telegram/core.ts:460` — `recipe_back` callback
- `src/telegram/core.ts:476` — `view_plan_recipes` post-plan button
- `src/telegram/core.ts:941` — `my_recipes` menu case (via the `else` branch when `all.length > 0`)

Instrumenting all five at each call site is redundant and error-prone. Instead, instrument **inside `showRecipeList` itself** — the only function that renders the library — and every caller benefits automatically. This is the same chokepoint pattern used for plan subview callbacks, just applied at function granularity rather than statement granularity.

**Files:**
- Modify: `src/telegram/core.ts:1083-1113`

- [ ] **Step 1: Add the helper call inside `showRecipeList`**

Replace `src/telegram/core.ts:1083-1113`:

```typescript
  // ─── Paginated recipe list ─────────────────────────────────────────────
  async function showRecipeList(sink: OutputSink): Promise<void> {
    const all = recipes.getAll();
    const pageSize = 5;

    // Check if there's an active plan with upcoming cook batches
    const today = toLocalISODate(new Date());
    const lifecycle = await getPlanLifecycle(session, store, today);
    let cookingSoonBatchViews: BatchView[] | undefined;

    if (lifecycle.startsWith('active_') || lifecycle === 'upcoming') {
      const planSession = await getVisiblePlanSession(store, today);
      if (planSession) {
        const { batchViews } = await loadPlanBatches(planSession, recipes);
        cookingSoonBatchViews = batchViews
          .filter(bv => bv.batch.eatingDays.length > 0 && bv.batch.eatingDays[0]! >= today)
          .sort((a, b) => a.batch.eatingDays[0]!.localeCompare(b.batch.eatingDays[0]!));
      }
    }

    // Build the message text with section headers
    let msg: string;
    if (cookingSoonBatchViews && cookingSoonBatchViews.length > 0) {
      msg = `COOKING SOON\n\nALL RECIPES (${all.length}):`;
    } else {
      msg = `Your recipes (${all.length}):`;
    }

    await sink.reply(msg, {
      reply_markup: recipeListKeyboard(all, session.recipeListPage, pageSize, cookingSoonBatchViews),
    });
  }
```

with:

```typescript
  // ─── Paginated recipe list ─────────────────────────────────────────────
  async function showRecipeList(sink: OutputSink): Promise<void> {
    const all = recipes.getAll();
    const pageSize = 5;

    // Check if there's an active plan with upcoming cook batches
    const today = toLocalISODate(new Date());
    const lifecycle = await getPlanLifecycle(session, store, today);
    let cookingSoonBatchViews: BatchView[] | undefined;

    if (lifecycle.startsWith('active_') || lifecycle === 'upcoming') {
      const planSession = await getVisiblePlanSession(store, today);
      if (planSession) {
        const { batchViews } = await loadPlanBatches(planSession, recipes);
        cookingSoonBatchViews = batchViews
          .filter(bv => bv.batch.eatingDays.length > 0 && bv.batch.eatingDays[0]! >= today)
          .sort((a, b) => a.batch.eatingDays[0]!.localeCompare(b.batch.eatingDays[0]!));
      }
    }

    // Build the message text with section headers
    let msg: string;
    if (cookingSoonBatchViews && cookingSoonBatchViews.length > 0) {
      msg = `COOKING SOON\n\nALL RECIPES (${all.length}):`;
    } else {
      msg = `Your recipes (${all.length}):`;
    }

    setLastRenderedView(session, { surface: 'recipes', view: 'library' });
    await sink.reply(msg, {
      reply_markup: recipeListKeyboard(all, session.recipeListPage, pageSize, cookingSoonBatchViews),
    });
  }
```

The only change is the `setLastRenderedView` call inserted immediately before `sink.reply`. The function still reads `session.recipeListPage` on line 1111 to build the keyboard; `LastRenderedView` does not duplicate the page number — see Task 2's module doc-comment for the reasoning.

- [ ] **Step 2: Verify `my_recipes` menu handler does not duplicate the helper**

The `my_recipes` case at `src/telegram/core.ts:930-943` currently sets `session.surfaceContext = 'recipes';` on line 931 and `session.lastRecipeSlug = undefined;` on line 932 before calling `showRecipeList(sink)` on line 941. Leave these lines AS-IS:
- `surfaceContext = 'recipes'` is redundant (the helper inside `showRecipeList` will overwrite it), but removing it is a cosmetic change unrelated to Plan B's scope. Leave it.
- `lastRecipeSlug = undefined` is a deliberate clear (the user arrived at the library from the main menu — no active recipe). Leave it.

Similarly, `view_plan_recipes` at `src/telegram/core.ts:471-478` sets `surfaceContext = 'recipes'` and clears `lastRecipeSlug` before calling `showRecipeList`. Leave those lines AS-IS.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: scenario 029 (`recipe-flow-happy-path`) may now have additional intermediate diffs if it walks through the library. Other scenarios unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/core.ts
git commit -m "Plan 027: instrument showRecipeList chokepoint with setLastRenderedView"
```

---

### Task 10: Instrument `my_plan` menu handler (renders Next Action inline)

**Rationale:** The `my_plan` case at `src/telegram/core.ts:909-928` renders the Next Action view **directly inline** (it does NOT re-dispatch `handleCallback('na_show')`). That means Task 5's instrumentation of `na_show` does NOT cover the `my_plan` path. A separate helper call is needed here.

**Files:**
- Modify: `src/telegram/core.ts:909-928`

- [ ] **Step 1: Add the helper call**

Replace `src/telegram/core.ts:909-928`:

```typescript
      case 'my_plan': {
        // "📋 My Plan" tapped with active or upcoming plan → show Next Action view
        session.surfaceContext = 'plan';
        session.lastRecipeSlug = undefined;
        const today = toLocalISODate(new Date());
        const lifecycle = await getPlanLifecycle(session, store, today);
        const planSession = await getVisiblePlanSession(store, today);
        if (planSession && (lifecycle.startsWith('active_') || lifecycle === 'upcoming')) {
          const { batchViews, allBatches } = await loadPlanBatches(planSession, recipes);
          const text = formatNextAction(batchViews, planSession.events, planSession.flexSlots, today, planSession.horizonStart);
          const nextCook = getNextCookDay(allBatches, today);
          const nextCookBatchViews = nextCook
            ? batchViews.filter(bv => bv.batch.eatingDays[0] === nextCook.date)
            : [];
          await sink.reply(text, { reply_markup: nextActionKeyboard(nextCookBatchViews, lifecycle), parse_mode: 'MarkdownV2' });
          return;
        }
        // Fallback: no plan at all — treat as plan_week
        await handleMenu('plan_week', sink);
        return;
      }
```

with:

```typescript
      case 'my_plan': {
        // "📋 My Plan" tapped with active or upcoming plan → show Next Action view
        session.lastRecipeSlug = undefined;
        const today = toLocalISODate(new Date());
        const lifecycle = await getPlanLifecycle(session, store, today);
        const planSession = await getVisiblePlanSession(store, today);
        if (planSession && (lifecycle.startsWith('active_') || lifecycle === 'upcoming')) {
          const { batchViews, allBatches } = await loadPlanBatches(planSession, recipes);
          const text = formatNextAction(batchViews, planSession.events, planSession.flexSlots, today, planSession.horizonStart);
          const nextCook = getNextCookDay(allBatches, today);
          const nextCookBatchViews = nextCook
            ? batchViews.filter(bv => bv.batch.eatingDays[0] === nextCook.date)
            : [];
          setLastRenderedView(session, { surface: 'plan', view: 'next_action' });
          await sink.reply(text, { reply_markup: nextActionKeyboard(nextCookBatchViews, lifecycle), parse_mode: 'MarkdownV2' });
          return;
        }
        // Fallback: no plan at all — treat as plan_week
        await handleMenu('plan_week', sink);
        return;
      }
```

Changes:
1. Removed `session.surfaceContext = 'plan';` (the helper sets it).
2. Inserted `setLastRenderedView(session, { surface: 'plan', view: 'next_action' });` immediately before `sink.reply`.
3. `session.lastRecipeSlug = undefined;` stays (deliberate clear on main-menu transition).
4. The fallback path `handleMenu('plan_week', sink)` is left alone — `plan_week` starts a planning flow (which is not a navigation render) and does NOT call `setLastRenderedView`. See Task 12 for the `plan_week` case.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: more plan-navigation scenarios may become red (any that ends with `📋 My Plan` tap). Other scenarios unaffected.

- [ ] **Step 4: Commit**

```bash
git add src/telegram/core.ts
git commit -m "Plan 027: instrument my_plan menu handler with setLastRenderedView"
```

---

### Task 11: Instrument `progress` menu handler

**Rationale:** The progress menu handler at `src/telegram/core.ts:1013-1043` has **two render branches**: (a) already-logged-today → weekly-report keyboard, and (b) not-yet-logged → log prompt text + progress flow phase. Both are navigation renders and must set `lastRenderedView`. The "Already logged today" branch can also render a message without a keyboard when no previous week is available — it's still a rendered view; we tag it as `weekly_report` because that's the semantic page the user lands on (the "progress report" surface's default view).

The `pg_last_report` callback at `src/telegram/core.ts:646-660` renders the weekly report body on demand — a `weekly_report` view. That's instrumented here as well.

The `pg_disambig_yes/no` callbacks at `src/telegram/core.ts:610-644` write the measurement and reply with a confirmation (`confirmText`), optionally with the weekly-report keyboard attached. That's a confirmation, not a navigation to a new view — **do NOT instrument it** (the user is still conceptually on the `log_prompt` path, having just completed it). The next inbound navigation will set a fresh `lastRenderedView`.

**Files:**
- Modify: `src/telegram/core.ts:1013-1043` (`progress` menu case)
- Modify: `src/telegram/core.ts:646-660` (`pg_last_report` callback)

- [ ] **Step 1: Instrument `progress` menu case**

Replace `src/telegram/core.ts:1013-1043`:

```typescript
      case 'progress': {
        session.surfaceContext = 'progress';
        session.lastRecipeSlug = undefined;

        const today = toLocalISODate(new Date());
        const existing = await store.getTodayMeasurement('default', today);

        if (existing) {
          session.progressFlow = null;
          const { lastWeekStart, lastWeekEnd } = getCalendarWeekBoundaries(today);
          const lastWeekData = await store.getMeasurements('default', lastWeekStart, lastWeekEnd);
          const hasCompletedWeekReport = lastWeekData.length > 0;
          const alreadyText = 'Already logged today ✓';
          if (hasCompletedWeekReport) {
            await sink.reply(alreadyText, { reply_markup: progressReportKeyboard });
          } else {
            await sink.reply(alreadyText);
          }
          return;
        }

        // No measurement today — prompt for input
        session.progressFlow = { phase: 'awaiting_measurement' };
        const hour = new Date().getHours();
        const timeQualifier = hour >= 14
          ? '\n\nIf this is your morning weight, drop it here.'
          : '';
        const prompt = `Drop your weight (and waist if you track it):\n\nExamples: "82.3 / 91" or just "82.3"${timeQualifier}`;
        await sink.reply(prompt);
        return;
      }
```

with:

```typescript
      case 'progress': {
        session.lastRecipeSlug = undefined;

        const today = toLocalISODate(new Date());
        const existing = await store.getTodayMeasurement('default', today);

        if (existing) {
          session.progressFlow = null;
          const { lastWeekStart, lastWeekEnd } = getCalendarWeekBoundaries(today);
          const lastWeekData = await store.getMeasurements('default', lastWeekStart, lastWeekEnd);
          const hasCompletedWeekReport = lastWeekData.length > 0;
          const alreadyText = 'Already logged today ✓';
          setLastRenderedView(session, { surface: 'progress', view: 'weekly_report' });
          if (hasCompletedWeekReport) {
            await sink.reply(alreadyText, { reply_markup: progressReportKeyboard });
          } else {
            await sink.reply(alreadyText);
          }
          return;
        }

        // No measurement today — prompt for input
        session.progressFlow = { phase: 'awaiting_measurement' };
        const hour = new Date().getHours();
        const timeQualifier = hour >= 14
          ? '\n\nIf this is your morning weight, drop it here.'
          : '';
        const prompt = `Drop your weight (and waist if you track it):\n\nExamples: "82.3 / 91" or just "82.3"${timeQualifier}`;
        setLastRenderedView(session, { surface: 'progress', view: 'log_prompt' });
        await sink.reply(prompt);
        return;
      }
```

Changes:
1. Removed `session.surfaceContext = 'progress';` at the top (the helper sets it).
2. Added `setLastRenderedView(session, { surface: 'progress', view: 'weekly_report' });` in the `if (existing)` branch, immediately before `sink.reply`.
3. Added `setLastRenderedView(session, { surface: 'progress', view: 'log_prompt' });` in the else branch, immediately before `sink.reply(prompt)`.

- [ ] **Step 2: Instrument `pg_last_report` callback**

Replace `src/telegram/core.ts:646-660`:

```typescript
    if (action === 'pg_last_report') {
      const today = toLocalISODate(new Date());
      const { lastWeekStart, lastWeekEnd, prevWeekStart, prevWeekEnd } = getCalendarWeekBoundaries(today);
      const lastWeekData = await store.getMeasurements('default', lastWeekStart, lastWeekEnd);

      if (lastWeekData.length === 0) {
        await sink.reply('Not enough data for a report yet -- keep logging and your first report will be ready Sunday.');
        return;
      }

      const prevWeekData = await store.getMeasurements('default', prevWeekStart, prevWeekEnd);
      const report = formatWeeklyReport(lastWeekData, prevWeekData, lastWeekStart, lastWeekEnd);
      await sink.reply(report, { parse_mode: 'Markdown' });
      return;
    }
```

with:

```typescript
    if (action === 'pg_last_report') {
      const today = toLocalISODate(new Date());
      const { lastWeekStart, lastWeekEnd, prevWeekStart, prevWeekEnd } = getCalendarWeekBoundaries(today);
      const lastWeekData = await store.getMeasurements('default', lastWeekStart, lastWeekEnd);

      if (lastWeekData.length === 0) {
        await sink.reply('Not enough data for a report yet -- keep logging and your first report will be ready Sunday.');
        return;
      }

      const prevWeekData = await store.getMeasurements('default', prevWeekStart, prevWeekEnd);
      const report = formatWeeklyReport(lastWeekData, prevWeekData, lastWeekStart, lastWeekEnd);
      setLastRenderedView(session, { surface: 'progress', view: 'weekly_report' });
      await sink.reply(report, { parse_mode: 'Markdown' });
      return;
    }
```

The "Not enough data" error branch does NOT set `lastRenderedView` (it's an error, not a view render — the user stays on whatever view they were on).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: scenarios 015 and 016 may have diffs in their final `finalSession.lastRenderedView`. Other scenarios unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/core.ts
git commit -m "Plan 027: instrument progress menu and pg_last_report with setLastRenderedView"
```

---

### Task 12: Confirm which other handlers deliberately do NOT set `lastRenderedView`

**Rationale:** Not every handler renders a navigation view. Some render transitional flow messages (breakfast confirmation, event prompt, proposal review, measurement confirmation, recipe review) that are flow progressions, not navigation targets. These must NOT call `setLastRenderedView` — their state belongs to the flow, not to the navigation model. This task is **verification only**: no code changes, just a checklist to confirm the instrumentation in Tasks 5–11 is complete and nothing was missed.

**Files:** none modified — this is a verification-only task.

- [ ] **Step 1: Grep for every `sink.reply(` call in `src/telegram/core.ts`**

Run: `npx grep -n "sink\.reply(" src/telegram/core.ts`

(Use the Grep tool rather than `grep` if available — the project convention is dedicated tools over shell commands. Either works for this verification step.)

Read the full list and classify each call as one of:

- **Navigation render** — already instrumented in Tasks 5–11. Must be immediately preceded by `setLastRenderedView(...)`.
- **Flow progression** — message inside a flow (breakfast prompt, events loop, proposal text, recipe review, measurement prompt). Not a navigation view. Must NOT call `setLastRenderedView`.
- **Confirmation / terminal** — "Saved", "Cancelled", "Plan confirmed", "Measurement logged" replies. Transitional. Must NOT call `setLastRenderedView` — the user is still conceptually on the same surface, and the next navigation will set a fresh view.
- **Error** — "Recipe not found", "Invalid date", "Something went wrong". Must NOT call `setLastRenderedView` — error responses don't change the view.

- [ ] **Step 2: Checklist of call sites that MUST have `setLastRenderedView` already attached**

Confirm each of these lines (approximate, may drift slightly with prior tasks' edits) has a `setLastRenderedView(...)` call on the line immediately above it:

- [ ] Line ~682 (near `na_show` reply) — Task 5
- [ ] Line ~696 (near `wo_show` reply) — Task 5
- [ ] Line ~710 (near `dd_` reply) — Task 5
- [ ] Line ~735 (near `cv_` reply) — Task 6
- [ ] Line ~800 (near `sl_` reply) — Task 7
- [ ] Line ~409 (near `rv_` reply) — Task 8
- [ ] Line ~1335 (near free-text recipe lookup reply) — Task 8b
- [ ] Line ~1110 (near `showRecipeList` reply) — Task 9
- [ ] Line ~924 (near `my_plan` reply) — Task 10
- [ ] Line ~1028 (near `progress`/`already logged` reply) — Task 11
- [ ] Line ~1043 (near `progress`/`log_prompt` reply) — Task 11
- [ ] Line ~658 (near `pg_last_report` reply) — Task 11

That is **twelve** call sites instrumented across Tasks 5–11 (Task 8b adds the free-text recipe lookup site that the original plan missed). Plus one implicit one inside `showRecipeList` that fans out to five callers. If any of the above is missing a `setLastRenderedView` call, jump back to the responsible task and fix it.

- [ ] **Step 3: Checklist of call sites that MUST NOT have `setLastRenderedView` attached**

Verify none of these has a `setLastRenderedView` call:

- `/start` reply (line ~328) — welcome message, not a navigation view.
- `/cancel` reply (line ~338) — cancel confirmation.
- `save_recipe` reply (line ~364) — recipe save confirmation.
- `refine_recipe` reply (line ~373) — refinement prompt.
- `discard_recipe` reply (line ~388) — discard confirmation.
- `add_recipe` / `new_recipe` reply — meal type prompt during recipe flow.
- `rd_` reply (line ~422) — "Deleted X" confirmation (followed by `showRecipeList` which DOES instrument).
- `re_` reply (line ~439) — refinement prompt during edit flow.
- `rp_` handler (line ~453) — page navigation, calls `showRecipeList` which instruments.
- `recipe_back` handler (line ~459) — calls `showRecipeList` which instruments.
- `view_shopping_list` handler (line ~468) — delegates to `sl_next` which instruments.
- `view_plan_recipes` handler (line ~476) — calls `showRecipeList` which instruments.
- `plan_replan_confirm` / `plan_replan_cancel` (line ~481, ~496) — flow transitions.
- **All `plan_*` callbacks** inside the `if (action.startsWith('plan_') && session.planFlow)` block at line ~503 — every single reply here is a flow-progression message (breakfast kept, events loop, proposal review, approve confirmation, cancel). None is a navigation view.
- `pg_disambig_yes` / `pg_disambig_no` (line ~610) — measurement confirmation after disambiguation, not a navigation.
- `handleTextInput` progress flow replies (line ~1128-ish) — flow prompts and confirmations.
- `handleTextInput` recipeFlow replies — flow prompts.
- `handleTextInput` planFlow event/mutation replies (line ~1291, ~1305) — flow progressions.
- `replyFreeTextFallback` (line ~255 onward) — fallback hint, not a navigation.
- `showRecipeList` is the only exception above: it is a navigation render, instrumented in Task 9.

- [ ] **Step 4: Run tests to confirm the instrumentation matches expectations**

Run: `npm test`
Expected: the same set of scenarios are red as at the end of Task 11 (those whose final output is a navigation view). No new failures.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

**No commit** — Task 12 is verification only. If any fix was needed during this task, it belongs to the appropriate earlier task (go back, fix, amend — or in this plan's TDD-of-TDD style, write a fresh commit like `Plan 027: fix missing instrumentation at <site>`).

---

### Task 13: Regenerate affected scenario recordings

**Rationale:** Tasks 5–11 introduced a new `lastRenderedView` field on `BotCoreSession`. Any scenario whose final event is a navigation render will now have that field in its `finalSession`, and its `recorded.json` will be stale. This task runs the test suite, collects the failures, regenerates them, and reviews the diffs behaviorally before committing.

**Per-scenario regeneration is mechanical** for scenarios whose ONLY diff is `lastRenderedView` appearing or changing — no LLM behavior changes, no new fixtures needed. But each regenerated recording **must still be reviewed per CLAUDE.md's "Verifying recorded output" protocol** because the scenario harness is Flexie's primary correctness check. If regeneration produces any unexpected diff beyond `lastRenderedView`, stop and investigate.

**Cost consideration — scenarios with LLM fixtures.** Most Plan-027-affected scenarios have empty `llmFixtures` (018, 019, 022, 017 — plan-view-navigation, shopping-list-tiered, upcoming-plan-view, free-text-fallback). Regenerating them is cheap and deterministic. Progress scenarios (015, 016) also have no LLM calls. Recipe-flow and planning scenarios DO have LLM fixtures, but they typically end inside a flow (`plan_approve` or mid-proposal), where `lastRenderedView` stays `undefined` — so they should NOT need regeneration. Any exception is a finding worth investigating before rubber-stamping a regen.

**Files:** regenerated `recorded.json` files across affected scenarios. No new files.

- [ ] **Step 1: Run `npm test` and capture the failure list**

Run: `npm test`
Expected: a set of scenarios fail with `deepStrictEqual` diffs pointing at `finalSession.lastRenderedView`. Write down the list of failing scenario names.

**If more than 10 scenarios fail**, or if any failure diff is NOT about `lastRenderedView` (e.g., a `finalStore` drift, a fixture mismatch, a captured output text change), **stop and investigate before regenerating**. Something in Tasks 5–11 is doing more than intended.

- [ ] **Step 2: For each failing scenario, delete its `recorded.json` then regenerate it**

Per CLAUDE.md's `feedback_regenerate_workflow.md`: "delete before regenerate". Run regenerations **in parallel** to save wall-clock time (also per CLAUDE.md), then review **serially**.

For each failing scenario `NNN-name`:

```bash
rm test/scenarios/NNN-name/recorded.json
npm run test:generate -- NNN-name --regenerate --yes
```

(The `--regenerate --yes` combination is the standard invocation per the Plan A reference; confirm the exact flags in `package.json` if in doubt.)

Run all deletes + generates in parallel using a single shell script or by dispatching multiple Bash tool calls in a single message. Wait for every regeneration to finish before moving to the review step.

- [ ] **Step 3: Review each regenerated recording serially**

Per CLAUDE.md's "Verifying recorded output" protocol (`docs/product-specs/testing.md`), read each regenerated `recorded.json` and verify:

1. **Only `lastRenderedView` changed in `finalSession`.** Diff the old recording (git show HEAD:test/scenarios/NNN-name/recorded.json) against the new one. The only delta should be: a new `"lastRenderedView": { ... }` object inside `finalSession` (or a changed one if the scenario already exited a view and entered another), and possibly normalized field ordering from the JSON serializer. No other field changes.

2. **The `lastRenderedView` value matches expectations.** Walk the scenario's final events — the last event that produces a navigation render is the one that sets `lastRenderedView`. Confirm the recorded value matches:
   - `na_show` → `{ surface: 'plan', view: 'next_action' }`
   - `wo_show` → `{ surface: 'plan', view: 'week_overview' }`
   - `dd_<date>` → `{ surface: 'plan', view: 'day_detail', day: '<date>' }`
   - `cv_<batchId>` → `{ surface: 'cooking', view: 'cook_view', batchId: '<batchId>', recipeSlug: '<slug>' }`
   - `sl_next` → `{ surface: 'shopping', view: 'next_cook' }`
   - `sl_<date>` → `{ surface: 'shopping', view: 'day', day: '<date>' }`
   - `rv_<slug>` → `{ surface: 'recipes', view: 'recipe_detail', slug: '<slug>' }`
   - Any route through `showRecipeList` → `{ surface: 'recipes', view: 'library' }`
   - `📋 My Plan` menu tap (when plan exists) → `{ surface: 'plan', view: 'next_action' }`
   - Progress menu tap (already logged) → `{ surface: 'progress', view: 'weekly_report' }`
   - Progress menu tap (not logged) → `{ surface: 'progress', view: 'log_prompt' }`
   - `pg_last_report` → `{ surface: 'progress', view: 'weekly_report' }`

3. **`outputs` and `finalStore` are unchanged** (byte-for-byte except for whitespace normalization from the generator).

4. **Read each regenerated recording's last output message as if you were the user** — per CLAUDE.md's mandatory behavioral-review rule. If the scenario's UX is coherent, the recording is good. If something is off (wrong keyboard, wrong copy, stale field), the regeneration has caught a real bug and Task 5–11 needs revisiting. **Tests-green alone proves nothing — behavioral validity is the point.**

- [ ] **Step 4: Confirm `npm test` is fully green**

Run: `npm test`
Expected: PASS for every scenario. The unit tests from Task 4 and the instrumented render paths now produce recordings that match `lastRenderedView` expectations.

- [ ] **Step 5: Commit regenerated recordings**

```bash
git add test/scenarios/*/recorded.json
git commit -m "Plan 027: regenerate affected scenario recordings with lastRenderedView"
```

Include the full list of regenerated scenarios in the commit message body (one per line) so future readers can see exactly which ones were touched.

**If a scenario fails behavioral review** (the regenerated recording has an actual regression, not a harmless `lastRenderedView` addition), DO NOT commit. Instead: identify the root cause, fix it in `src/telegram/core.ts` (likely a bug introduced in Tasks 5–11), run `npm test` again, re-regenerate the affected scenario, and re-review. Only commit when behavioral review is green across the board.

---

### Task 14: PlanFlow-clear audit — document decisions + add scenario 031 (shopping_list regression lock)

**Rationale:** Proposal 003 requires an audit of every site that destructively clears `planFlow`, a documented decision per site (preserve / change / leave alone), and scenario coverage for the decisions. Plan B's conservative call is **"leave alone everywhere"** — no behavior changes — because Plan B has no dispatcher in place and altering existing flow semantics introduces risk without a corresponding benefit in v0.0.5. The decisions are documented in this plan's decision log (end of file) AND a regression-lock scenario (031) is added for the most-cited case so any later change under Plan C/D produces a clean diff rather than a silent behavior drift.

**The audit sites (confirmed by reading `src/telegram/core.ts` for Plan 027):**

| # | Location (file:line) | Trigger | Current behavior | Plan 027 decision | Regression test coverage |
|---|---|---|---|---|---|
| 1 | `src/telegram/core.ts:321-331` | `/start` command | Clears `recipeFlow`, `planFlow`, `progressFlow`, `pendingReplan`, `surfaceContext`, `lastRecipeSlug` (and `lastRenderedView` after Task 3) | **Leave alone — but extend the total reset to also clear `lastRenderedView`** (added in Task 3 Step 3b). `/start` is a complete surface reset; adding the new field to the reset is the consistent choice. | Exercised implicitly by every scenario (harness `reset()` mirrors `/start`); scenario 017 (`free-text-fallback`) uses `/start` directly. |
| 2 | `src/telegram/core.ts:333-340` | `/cancel` command | Clears `recipeFlow`, `planFlow`, `progressFlow`, `pendingReplan` (leaves `surfaceContext` and `lastRecipeSlug`; clears `lastRenderedView` after Task 3) | **Leave alone for the legacy fields — but clear `lastRenderedView`** (added in Task 3 Step 3c). The pre-existing omission of `surfaceContext`/`lastRecipeSlug` clearing stays untouched as a deliberate scope guard; the new field is cleared because an explicit cancel means "drop the current view" and leaving it populated would mislead Plan C's dispatcher. | Covered by scenario 012 (`rolling-replan-abandon`), which taps Plan Week → `plan_replan_confirm` → `command('cancel')` and verifies the post-cancel state. Scenario 012 does NOT need regeneration in Task 13 because none of its events set `lastRenderedView` in the first place (the replan prompt and breakfast prompt are flow progressions, not navigation renders), so the new `/cancel` clear is a no-op in this scenario and `JSON.stringify` already drops the undefined field from the recording. |
| 3 | `src/telegram/core.ts:363` | `save_recipe` callback | Clears `recipeFlow` only (leaves `planFlow`) | **Leave alone.** Already preserves `planFlow` — matches the freeform-model intent. | Covered by scenario 029 (`recipe-flow-happy-path`) which ends at `save_recipe`. |
| 4 | `src/telegram/core.ts:386` | `discard_recipe` callback | Clears `recipeFlow` only | **Leave alone.** Same reasoning. | Covered by **new scenario 032** (`discard-recipe-audit`) — user enters a fresh recipe flow via `add_recipe`, then taps `discard_recipe`, scenario asserts `recipeFlow === null` after the tap. Added in Task 14 below. |
| 5 | `src/telegram/core.ts:436` | `re_` (recipe edit) callback | Clears `planFlow`, enters edit flow | **Leave alone.** Under today's non-dispatcher model, entering recipe edit from a plan side trip cannot cleanly return to planning, so the clear is defensive. Plan C may revisit this once the dispatcher can route "back to planning" freeform. | Covered by **new scenario 033** (`recipe-edit-clears-planflow-audit`) — user enters `planFlow.phase === 'context'` via Plan Week, then taps `re_<slug>` from a recipe view, scenario asserts `planFlow === null` and `recipeFlow` is an edit flow state. Added in Task 14 below. |
| 6 | `src/telegram/core.ts:466` | `view_shopping_list` post-plan button | Clears `planFlow`, delegates to `sl_next` | **Leave alone.** This button only appears on the post-plan-confirmation keyboard, at which point `planFlow` is already `null` (set by `plan_approve` at line 572). The clear is defensive. | Covered by scenarios 001 (`plan-week-happy-path`) and others that reach `plan_approve` — `planFlow` is already `null` when this button would be tapped, so the clear is a no-op and the defensive line stays. No new scenario needed. |
| 7 | `src/telegram/core.ts:471-472` | `view_plan_recipes` post-plan button | Clears `planFlow`, enters recipe list | **Leave alone.** Same defensive reasoning as #6. | Same as site #6 — `planFlow` is already `null` at this point. No new scenario needed. |
| 8 | `src/telegram/core.ts:572` | `plan_approve` (end of happy path) | Clears `planFlow` after successful persist | **Leave alone.** Canonical clear — the flow is done, its state is no longer needed. | Covered by scenarios 001, 002, 003, 004, 005, 009, 010, 011, 013, 014, 020, 023, 024, 025, 026, 028 — every planning happy-path ends here. Heavily regression-tested. |
| 9 | `src/telegram/core.ts:601` | `plan_cancel` callback inside the `plan_*` handler block | Clears `planFlow`, returns to menu | **Leave alone — but flagged as dead code.** `planProposalKeyboard` at `src/telegram/keyboards.ts:263-264` no longer exposes a `plan_cancel` button (Plan 025's mutation-text rework removed "Swap something" and did not re-add a cancel; only "Looks good" → `plan_approve` remains). The handler is therefore unreachable from any current user-facing keyboard. Plan 027 does NOT remove the handler (code deletion is outside the navigation-state scope guard) and does NOT author a scenario for an unreachable code path — sending the callback directly from the harness would test an internal branch, not a real user flow, which is the opposite of what proposal 003's "scenarios for each path" requirement is asking for. If a future plan re-exposes a cancel button (or deletes the handler), that plan owns the scenario or the deletion. | No scenario coverage — unreachable code path. The `metaIntent === 'cancel'` text path at site #13 (covered by scenario 021) is the only user-facing planning-cancel affordance today. |
| 10 | `src/telegram/core.ts:903-906` | `handleMenu()` entry, ALL menu taps | Clears `recipeFlow` + `progressFlow`, **intentionally leaves `planFlow`** | **Leave alone.** This is the load-bearing "main menu does not nuke planning" pattern. Preserves resume-planning UX. Documented in inline comment (lines 905-906). | Exercised implicitly by every scenario that taps a reply-keyboard button (most of them). Scenario 030 (new) explicitly walks menu taps without losing the absence-of-`planFlow`. |
| 11 | `src/telegram/core.ts:998-1002` | `shopping_list` menu case | **Conditionally** clears `planFlow` if set | **Leave alone — with regression lock.** This is the ONE site proposal 003 explicitly flags as "wrong in some cases". Plan B does NOT change it (no dispatcher yet) but adds scenario 031 to lock in the current behavior so Plan C/D's change shows as a clean diff. | Covered by **new scenario 031** (`shopping-list-mid-planning-audit`) — the regression lock described in this task. |
| 12 | `src/telegram/core.ts:1275` | `metaIntent === 'start_over'` during planFlow text | Clears `planFlow` then restarts | **Leave alone.** Explicit restart is clean. | Covered by scenario 020 (`planning-intents-from-text`) which uses the `start_over` meta-intent mid-proposal. |
| 13 | `src/telegram/core.ts:1283-1286` | `metaIntent === 'cancel'` during planFlow text | Clears `planFlow`, `surfaceContext = null`, returns to menu | **Leave alone.** Explicit cancel. | Covered by scenario 021 (`planning-cancel-intent`) which types "nevermind" mid-proposal. |
| 14 | `src/telegram/core.ts:1343-1351` | `reset()` harness function | Clears everything including Plan 027's `lastRenderedView` (Task 3) | **Leave alone.** Test-harness only. | Exercised implicitly by every scenario's between-run reset. Task 3 extended `reset()` to clear `lastRenderedView`; any scenario that asserts `finalSession.lastRenderedView` independently validates this. |

**Summary of coverage:** After the corrections above, every audit site in the table falls into one of four categories: (a) has existing scenario coverage (e.g., sites #1, #3, #6, #7, #8, #10, #12, #13, #14), (b) is covered by the `shopping_list` regression lock in new scenario 031 (site #11), (c) gets a new dedicated zero-LLM regression scenario in this task — 032 for `discard_recipe` (site #4) and 033 for `re_` recipe edit (site #5) — or (d) is flagged as dead code with no scenario because the handler has no user-reachable entry point (site #9 `plan_cancel`, removed from `planProposalKeyboard` in Plan 025). The earlier draft of this plan argued that sites #4, #5, and #9 could be skipped under CLAUDE.md's "new scenario is NOT needed" heuristic, but proposal 003's verification contract at `docs/design-docs/proposals/003-freeform-conversation-layer.md:480` is explicit: **"The implementation plan must list every site, decide whether to preserve or clear, and add scenario tests for each path."** A design-doc requirement overrides a general debugging heuristic when they conflict — but the "every path" requirement is about user-reachable paths, not internal branches with no UI wiring, which is why #9 is flagged as dead code rather than artificially tested via a direct callback injection. The two new zero-LLM scenarios (032, 033) close the gap at minimal cost for the two remaining user-reachable sites.

**`command('cancel')` coverage correction:** the previous draft of row #2 claimed `/cancel` was not exercised by any scenario. That was wrong. Scenario 012 (`rolling-replan-abandon`) explicitly uses `command('cancel')` after `plan_replan_confirm` to abandon a mid-draft planning session. Row #2 is now marked as covered by 012; no new `/cancel`-specific scenario is needed because the existing one already exercises the path.

**Files:**
- Create: `test/scenarios/031-shopping-list-mid-planning-audit/spec.ts`
- Create: `test/scenarios/031-shopping-list-mid-planning-audit/recorded.json` (generated)
- Create: `test/scenarios/032-discard-recipe-audit/spec.ts`
- Create: `test/scenarios/032-discard-recipe-audit/recorded.json` (generated)
- Create: `test/scenarios/033-recipe-edit-clears-planflow-audit/spec.ts`
- Create: `test/scenarios/033-recipe-edit-clears-planflow-audit/recorded.json` (generated)
- No code changes to `src/telegram/core.ts` in this task.

- [ ] **Step 1: Pick a stable clock and seed data for scenario 031**

The scenario needs: a mid-planning session where the user has reached the `proposal` phase of `planFlow`, THEN taps 🛒 Shopping List, and the active plan being viewable must either exist (so `sl_next` succeeds) or not (and the shopping_list handler replies with "no plan yet"). To keep the test focused on the clear behavior, seed an **active plan** so the shopping list DOES render, and make the user's planning target a FUTURE week (scenario 011-rolling-replan-future-only is a good structural reference).

However, reaching the `proposal` phase requires going through the full planning flow (breakfast → events → generate_proposal), which involves the LLM. That makes scenario 031 an LLM-calling scenario with regenerate cost.

**Simpler alternative:** start the scenario with `planFlow` pre-seeded at `phase: 'awaiting_events'` (the phase right before generate_proposal). The proposal phase is not strictly needed — the clear-on-shopping-tap happens regardless of phase. `awaiting_events` is reachable without any LLM call and exercises the same clear behavior.

**Simpler still:** use `phase: 'context'` (the phase right after `plan_week` starts, before any events are added). This requires zero LLM calls. The user taps 🛒 Shopping List; the handler conditionally clears `planFlow` (which is present) and delegates to `sl_next`. `sl_next` reads the active plan and renders the list. Final state: `planFlow === null`, shopping list rendered, `lastRenderedView === { surface: 'shopping', view: 'next_cook' }`.

**Challenge: how do you seed a `BotCoreSession.planFlow` in a scenario?** Scenarios seed `initialState` which populates `TestStateStore` (database), but `BotCoreSession` is NOT persisted — it's pure in-memory state. The harness's `initialState.session` field (`src/harness/types.ts:43-44`) seeds the **persistent** `SessionState` from `src/state/machine.ts`, not `BotCoreSession`. There is no scenario-author-facing hook to seed `BotCoreSession.planFlow` directly.

**Resolution:** drive the scenario through the real flow up to `phase: 'context'`. That requires one tap of the menu button "📋 Plan Week" and one tap of "Keep breakfast" (to transition from context → awaiting_events) or zero taps if the test only needs `context` phase. "Plan Week" on an empty-no-plan state hits `doStartPlanFlow` which sets `planFlow.phase = 'context'` and replies with the breakfast prompt. No LLM call. That is the state we want.

But wait — with an ACTIVE plan seeded, "📋 My Plan" would show Next Action, not start a new planning session. The menu label depends on lifecycle. To have an active plan AND start planning for the NEXT week, the seed needs:
- An active plan session in the near past / current window (so `getPlanLifecycle` returns `active_*`)
- The user taps "📋 Plan Week" — which under `active_*` lifecycle goes through the `plan_week` menu case at `src/telegram/core.ts:945` and calls `computeNextHorizonStart` to compute the next-week horizon

`computeNextHorizonStart` returns a `{ start, replacingSession? }` object. If there's an active plan for this week and no future-only plan, it returns `{ start: nextMonday }` with no `replacingSession` → goes directly to `doStartPlanFlow(horizon, undefined, sink)`. This seeds a **fresh** planFlow for next week with no LLM calls.

Now the user is in `planFlow.phase = 'context'` planning next week, while a separate ACTIVE plan exists for this week. They tap 🛒 Shopping List. The handler at `src/telegram/core.ts:995` sets `surfaceContext = 'shopping'`, clears `planFlow` (the current behavior being locked in), and delegates to `sl_next` which renders the active plan's shopping. Final state:
- `planFlow === null` (cleared — the lock-in assertion)
- `lastRenderedView === { surface: 'shopping', view: 'next_cook' }`
- `surfaceContext === 'shopping'`
- The shopping list text reflects the ACTIVE plan, not the abandoned draft.

This is a clean zero-LLM scenario.

- [ ] **Step 2: Write the scenario spec**

Create `test/scenarios/031-shopping-list-mid-planning-audit/spec.ts` with:

```typescript
/**
 * Scenario 031 — shopping list tap mid-planning: audit regression lock.
 *
 * Part of Plan 027 (Navigation state model / Plan B audit). Proposal 003
 * explicitly flags the `shopping_list` menu handler's conditional clear of
 * `planFlow` (at `src/telegram/core.ts:1001`) as "wrong in some cases".
 * Plan B's decision is to LEAVE IT ALONE — no behavior change — and lock
 * in the current behavior with this scenario so a later plan that flips it
 * produces a visible regen diff.
 *
 * Setup: an active plan for this week (Mon–Sun Apr 6–12) is seeded so the
 * user's "📋 Plan Week" tap kicks off a NEXT-week planning draft. The user
 * reaches `planFlow.phase === 'context'` (no LLM calls — just the breakfast
 * prompt), then taps 🛒 Shopping List. Assertions:
 *
 *   - `planFlow` is `null` after the shopping-list tap (current conditional
 *     clear behavior is preserved).
 *   - `surfaceContext` is `'shopping'`.
 *   - `lastRenderedView` is `{ surface: 'shopping', view: 'next_cook' }`.
 *   - The shopping list text reflects the ACTIVE plan (this week), not
 *     the abandoned NEXT-week draft.
 *
 * Clock: 2026-04-08T10:00:00Z (Wed in the active week — active_mid).
 */

import { defineScenario, text } from '../../../src/harness/define.js';
import type { PlanSession, Batch } from '../../../src/models/types.js';

const activeSession: PlanSession = {
  id: 'session-031-0000-0000-0000-000000000001',
  horizonStart: '2026-04-06',
  horizonEnd: '2026-04-12',
  breakfast: {
    locked: true,
    recipeSlug: 'salmon-avocado-toast-soft-eggs-cinnamon-yogurt',
    caloriesPerDay: 390,
    proteinPerDay: 31,
  },
  treatBudgetCalories: 1050,
  flexSlots: [],
  events: [],
  confirmedAt: '2026-04-06T08:00:00.000Z',
  superseded: false,
  createdAt: '2026-04-06T08:00:00.000Z',
  updatedAt: '2026-04-06T08:00:00.000Z',
};

const activeBatches: Batch[] = [
  // Single lunch batch cooking on Thu Apr 9, remaining for Thu–Sat
  // (eatingDays[0] === Thu Apr 9 → sl_next will target that day)
  {
    id: 'batch-031-lunch-0000-0000-000000000001',
    recipeSlug: 'chicken-black-bean-avocado-rice-bowl',
    mealType: 'lunch',
    eatingDays: ['2026-04-09', '2026-04-10', '2026-04-11'],
    servings: 3,
    targetPerServing: { calories: 893, protein: 56 },
    actualPerServing: { calories: 893, protein: 56, fat: 46, carbs: 68 },
    scaledIngredients: [
      { name: 'chicken breast, raw', amount: 190, unit: 'g', totalForBatch: 570, role: 'protein' as const },
      { name: 'black beans, canned, drained', amount: 75, unit: 'g', totalForBatch: 225, role: 'carb' as const },
      { name: 'small avocado', amount: 1, unit: 'whole', totalForBatch: 3, role: 'fat' as const },
      { name: 'olive oil', amount: 22, unit: 'ml', totalForBatch: 66, role: 'fat' as const },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
];

export default defineScenario({
  name: '031-shopping-list-mid-planning-audit',
  description:
    'Audit regression lock: user starts drafting next-week plan, taps 🛒 Shopping List — planFlow is cleared (current behavior, Plan B leaves alone), shopping list of the ACTIVE plan renders.',
  clock: '2026-04-08T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [activeSession],
    batches: activeBatches,
  },
  events: [
    // Kick off next-week planning. lifecycle=active_mid → `plan_week` case
    // computes nextMonday via computeNextHorizonStart and calls
    // doStartPlanFlow, leaving planFlow.phase === 'context'.
    text('📋 Plan Week'),
    // Tap shopping list while planFlow is alive in context phase.
    // Handler clears planFlow and delegates to sl_next.
    text('🛒 Shopping List'),
  ],
});
```

- [ ] **Step 3: Generate the recording**

Run: `npm run test:generate -- 031-shopping-list-mid-planning-audit --yes`
Expected: a new `test/scenarios/031-shopping-list-mid-planning-audit/recorded.json` is written. No LLM fixtures are needed (the scenario has zero LLM calls).

- [ ] **Step 4: Behavioral review**

Per CLAUDE.md's mandatory review protocol, read the recording:

1. **First output** — the breakfast prompt from `doStartPlanFlow`, with the breakfast keyboard. Text should mention "Planning Mon, Apr 13 – Sun, Apr 19" (next week) and the breakfast name.
2. **Second output** — the shopping list for Thu Apr 9 (next cook day from Wed Apr 8), with `buildShoppingListKeyboard` (Back to plan button). Text should list the chicken-black-bean-rice-bowl ingredients.
3. **`finalSession.planFlow`** — MUST be `null`. If it's not, the `shopping_list` menu handler stopped clearing and the audit assumption is wrong. Investigate.
4. **`finalSession.surfaceContext`** — MUST be `'shopping'`.
5. **`finalSession.lastRenderedView`** — MUST be `{ surface: 'shopping', view: 'next_cook' }`. If it's anything else, Task 7's `sl_` instrumentation is wrong.

If all five checks pass, the recording is valid.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all scenarios green (including the new 031).

- [ ] **Step 6: Commit**

```bash
git add test/scenarios/031-shopping-list-mid-planning-audit/
git commit -m "Plan 027: add scenario 031 — planFlow-clear audit regression lock for shopping_list"
```

- [ ] **Step 7: Write scenario 032 — `discard_recipe` clear audit**

Create `test/scenarios/032-discard-recipe-audit/spec.ts`:

```typescript
/**
 * Scenario 032 — `discard_recipe` callback clears `recipeFlow` (audit lock).
 *
 * Part of Plan 027 (Navigation state model / Plan B audit). Covers audit
 * site #4 from the plan's decision table. The user enters the recipe-creation
 * flow via 📖 My Recipes → Add new recipe → Lunch meal type (no LLM call;
 * the flow is parked at `phase === 'awaiting_preferences'`), then taps
 * Discard. The scenario asserts:
 *
 *   - `recipeFlow === null` after the discard tap (audit decision "leave
 *     alone" — current behavior preserved).
 *   - No plan state was disturbed (the user was not in a planFlow).
 *
 * Clock: 2026-04-08T10:00:00Z. Zero LLM calls (no recipe generation, no
 * plan lifecycle queries).
 */

import { defineScenario, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '032-discard-recipe-audit',
  description:
    'Audit regression lock: user enters recipe flow, taps Discard — recipeFlow cleared (Plan 027 decision "leave alone").',
  clock: '2026-04-08T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: { session: null },
  events: [
    text('📖 My Recipes'),          // library renders, recipeFlow unchanged
    click('add_recipe'),            // enters recipeFlow, meal-type keyboard
    click('meal_type_lunch'),       // phase → awaiting_preferences (no LLM yet)
    click('discard_recipe'),        // CLEARS recipeFlow
  ],
});
```

- [ ] **Step 8: Generate, review, commit scenario 032**

```bash
npm run test:generate -- 032-discard-recipe-audit --yes
```

Behavioral review:
1. Output 1: library render ("Your recipes (6):" or similar) + recipeListKeyboard.
2. Output 2: "What type of recipe?" + meal-type keyboard.
3. Output 3: "Great — tell me about the lunch you want..." (or exact awaiting_preferences prompt text).
4. Output 4: "Discarded." + main menu keyboard.
5. `finalSession.recipeFlow` MUST be `null`.
6. `finalSession.planFlow` MUST be `null`.
7. `finalSession.lastRenderedView` — confirm this is whatever `showRecipeList` set in step 1 (`{recipes, library}`) because steps 2-4 are all flow progressions + a confirmation, none of which update `lastRenderedView`. This is deliberate and verifies the plan's "flow progressions do NOT update lastRenderedView" contract.

Commit:

```bash
git add test/scenarios/032-discard-recipe-audit/
git commit -m "Plan 027: add scenario 032 — discard_recipe audit regression lock"
```

- [ ] **Step 9: Write scenario 033 — `re_` clears `planFlow` audit**

Create `test/scenarios/033-recipe-edit-clears-planflow-audit/spec.ts`:

```typescript
/**
 * Scenario 033 — `re_<slug>` callback clears `planFlow` (audit lock).
 *
 * Part of Plan 027 (Navigation state model / Plan B audit). Covers audit
 * site #5 from the plan's decision table. The user taps Plan Week (kicking
 * off a fresh planning draft with `planFlow.phase === 'context'`), then
 * navigates to the recipe library via 📖 My Recipes (which does NOT clear
 * planFlow — see handleMenu's inline comment at src/telegram/core.ts:905),
 * taps a recipe (rv_), then taps "Edit this recipe" (re_). The scenario
 * asserts:
 *
 *   - `planFlow === null` after the re_ tap (audit decision "leave alone" —
 *     current defensive clear behavior preserved).
 *   - `recipeFlow` is set to an edit flow state (the tap enters the edit UX).
 *
 * Setup: no active plan exists — this is a fresh user starting their first
 * plan. With no future, running, or historical session, `computeNextHorizonStart`
 * falls through to its "tomorrow" branch (`src/agents/plan-flow.ts:208`) and
 * returns `addDays(today, 1)` = `2026-04-09` (Thu). The horizon is Thu Apr 9
 * through Wed Apr 15 — a rolling-7-day window starting tomorrow, NOT a
 * Monday-aligned calendar week. `doStartPlanFlow` parks planFlow at
 * `phase === 'context'` and replies with the breakfast prompt, without any
 * LLM call.
 *
 * Clock: 2026-04-08T10:00:00Z. Zero LLM calls.
 */

import { defineScenario, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '033-recipe-edit-clears-planflow-audit',
  description:
    'Audit regression lock: user has planFlow alive at phase=context, taps re_<slug> from recipe view — planFlow cleared (Plan 027 decision "leave alone").',
  clock: '2026-04-08T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: { session: null },
  events: [
    text('📋 Plan Week'),                             // planFlow.phase === 'context', breakfast prompt rendered
    text('📖 My Recipes'),                            // library renders, planFlow UNTOUCHED (handleMenu only clears recipeFlow/progressFlow)
    click('rv_chicken-black-bean-avocado-rice-bowl'), // recipe detail, planFlow still untouched
    click('re_chicken-black-bean-avocado-rice-bowl'), // CLEARS planFlow, enters edit flow
  ],
});
```

- [ ] **Step 10: Generate, review, commit scenario 033**

```bash
npm run test:generate -- 033-recipe-edit-clears-planflow-audit --yes
```

Behavioral review:
1. Output 1: "Planning Thu, Apr 9 – Wed, Apr 15…" with `planBreakfastKeyboard` — confirms planFlow.phase = 'context'. The window is a rolling 7-day horizon starting tomorrow (Apr 9), NOT a Monday-aligned calendar week — because `computeNextHorizonStart` returns `addDays(today, 1)` when there's no prior session (see `src/agents/plan-flow.ts:208`). If the recording shows a different window, either the clock is wrong or `computeNextHorizonStart`'s fallback branch changed — either way, stop and investigate before accepting the recording.
2. Output 2: library render (via showRecipeList) + recipeListKeyboard.
3. Output 3: recipe detail for chicken-black-bean-avocado-rice-bowl + recipeViewKeyboard with Edit and View buttons.
4. Output 4: "What would you like to change? …" — the edit flow's refinement prompt.
5. `finalSession.planFlow` MUST be `null` — the critical audit assertion.
6. `finalSession.recipeFlow` MUST be set to an edit flow state (non-null, `phase === 'awaiting_refinement'`).
7. `finalSession.lastRenderedView` — set by Task 8's `rv_` instrumentation to `{recipes, recipe_detail, slug: 'chicken-black-bean-avocado-rice-bowl'}` at step 3 and NOT overwritten by step 4 (the `re_` handler replies with a prompt, not a navigation render, so it does NOT call `setLastRenderedView`).

Commit:

```bash
git add test/scenarios/033-recipe-edit-clears-planflow-audit/
git commit -m "Plan 027: add scenario 033 — re_ edit callback audit regression lock"
```

**Step 11-12 removed.** The earlier draft of this plan included steps to author a `plan_cancel-button-audit` scenario (would have been scenario 034). Review caught that `planProposalKeyboard` at `src/telegram/keyboards.ts:263-264` exposes ONLY `plan_approve` — the `plan_cancel` button was removed in Plan 025's mutation-text rework. The handler at `src/telegram/core.ts:601` therefore has no user-reachable entry point, and sending the callback directly from the harness would lock in an internal branch rather than a real path. Audit site #9 is now flagged as dead code in the audit table; no scenario is authored. If a future plan re-exposes the cancel button or deletes the handler, that plan owns the follow-up scenario or deletion.

---

### Task 15: New scenarios 030, 035, and 036 — navigation state tracking across every surface with per-step assertions and back-button regression lock

**Rationale:** Scenario 030 is the positive-path test for Plan 027's new state model. It walks the user through every major render surface in sequence, asserting at the end that `lastRenderedView` holds the expected variant for the last-rendered view. Unlike scenario 031 which locks in a clear decision, scenario 030 covers the *new capability* itself.

**Files:**
- Create: `test/scenarios/030-navigation-state-tracking/spec.ts`
- Create: `test/scenarios/030-navigation-state-tracking/recorded.json` (generated)

- [ ] **Step 1: Write the scenario spec**

Create `test/scenarios/030-navigation-state-tracking/spec.ts` with:

```typescript
/**
 * Scenario 030 — navigation state tracking across every render surface.
 *
 * Part of Plan 027 (Navigation state model). Drives the user through
 * nine of ten `LastRenderedView` variants via menu taps and inline
 * callbacks, and uses Task 4b's opt-in per-step session capture
 * (`captureStepState: true`) to assert EACH variant end-to-end at its
 * step — not just the terminal one. This satisfies proposal 003's
 * verification contract: "Scenarios that drive the user through existing
 * flows and verify the new state is tracked correctly"
 * (`docs/design-docs/proposals/003-freeform-conversation-layer.md:755`).
 *
 * The tenth variant — `progress/log_prompt` — requires a seed state
 * where NO measurement has been logged today, which is mutually
 * exclusive with this scenario's `progress/weekly_report` assertion at
 * step 10 (which needs today's measurement pre-logged). That variant is
 * covered by sibling scenario 035 below.
 *
 * The scenario walks (in order). `sessionAt[n]` is the session snapshot
 * captured immediately after event `n` (zero-based):
 *
 *   sessionAt[0]:  📋 My Plan       → { surface: 'plan', view: 'next_action' }
 *   sessionAt[1]:  wo_show          → { surface: 'plan', view: 'week_overview' }
 *   sessionAt[2]:  dd_2026-04-09    → { surface: 'plan', view: 'day_detail', day: '2026-04-09' }
 *   sessionAt[3]:  cv_<batchId>     → { surface: 'cooking', view: 'cook_view', batchId, recipeSlug }
 *   sessionAt[4]:  📖 My Recipes    → { surface: 'recipes', view: 'library' }
 *   sessionAt[5]:  rv_<slug>        → { surface: 'recipes', view: 'recipe_detail', slug }
 *   sessionAt[6]:  recipe_back      → { surface: 'recipes', view: 'library' }  (same variant, different call site)
 *   sessionAt[7]:  🛒 Shopping List → { surface: 'shopping', view: 'next_cook' }
 *   sessionAt[8]:  sl_2026-04-09    → { surface: 'shopping', view: 'day', day: '2026-04-09' }
 *   sessionAt[9]:  📊 Progress      → { surface: 'progress', view: 'weekly_report' }  (already-logged branch)
 *   sessionAt[10]: pg_last_report   → { surface: 'progress', view: 'weekly_report' }  (prior-week data branch)
 *
 * **Why per-step assertions matter.** Without `captureStepState: true`,
 * only the terminal variant (step 10 → `weekly_report`) would be
 * asserted end-to-end — and sl_next and sl_2026-04-09 produce identical
 * output text on this seed, so the harness's outputs comparison cannot
 * distinguish them. With per-step capture, every intermediate session
 * snapshot lands in `recorded.expected.sessionAt[]` and is compared via
 * the fourth `deepStrictEqual` in `test/scenarios.test.ts`. Any
 * instrumentation bug at any step produces a focused diff at that step's
 * index — the failure report pinpoints which handler is broken.
 *
 * **Why steps 9 and 10 both assert `weekly_report`.** They exercise
 * DIFFERENT call sites of the same variant: step 9 hits the "already
 * logged today" branch of the progress menu handler
 * (`src/telegram/core.ts:~1028` after Task 11), and step 10 hits the
 * `pg_last_report` callback handler (`src/telegram/core.ts:~658` after
 * Task 11). Both must call `setLastRenderedView` with the same variant
 * but through independent code paths — covering both via sessionAt
 * verifies both instrumentation sites.
 *
 * Clock: 2026-04-08T10:00:00Z (active_mid, same as scenario 018).
 * Seed: active plan + batches as scenario 018, plus today's measurement
 *       AND prior-week measurements so step 9 hits the "already logged"
 *       branch and step 10's pg_last_report has data. See `measurements`
 *       in the scenario body below.
 */

import { defineScenario, text, click } from '../../../src/harness/define.js';
import type { PlanSession, Batch } from '../../../src/models/types.js';

const activeSession: PlanSession = {
  id: 'session-030-0000-0000-0000-000000000001',
  horizonStart: '2026-04-06',
  horizonEnd: '2026-04-12',
  breakfast: {
    locked: true,
    recipeSlug: 'salmon-avocado-toast-soft-eggs-cinnamon-yogurt',
    caloriesPerDay: 390,
    proteinPerDay: 31,
  },
  treatBudgetCalories: 1050,
  flexSlots: [
    { day: '2026-04-12', mealTime: 'lunch' as const, flexBonus: 300, note: 'flex lunch' },
  ],
  events: [
    { name: 'Sunday dinner out', day: '2026-04-12', mealTime: 'dinner' as const, estimatedCalories: 900 },
  ],
  confirmedAt: '2026-04-06T08:00:00.000Z',
  superseded: false,
  createdAt: '2026-04-06T08:00:00.000Z',
  updatedAt: '2026-04-06T08:00:00.000Z',
};

/**
 * Same batch layout as scenario 018. Thu Apr 9 is the next cook day
 * (batch 3 lunch, batch 4 dinner). Mon–Wed meals are reheats of
 * batches 1 and 2 (cooked Apr 6).
 */
const activeBatches: Batch[] = [
  // Batch 1: Mon–Wed Lunch (reheat phase on Apr 8)
  {
    id: 'batch-030-lunch1-0000-0000-000000000001',
    recipeSlug: 'chicken-black-bean-avocado-rice-bowl',
    mealType: 'lunch',
    eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
    servings: 3,
    targetPerServing: { calories: 893, protein: 56 },
    actualPerServing: { calories: 893, protein: 56, fat: 46, carbs: 68 },
    scaledIngredients: [
      { name: 'chicken breast, raw', amount: 190, unit: 'g', totalForBatch: 570, role: 'protein' as const },
      { name: 'black beans, canned, drained', amount: 75, unit: 'g', totalForBatch: 225, role: 'carb' as const },
      { name: 'small avocado', amount: 1, unit: 'whole', totalForBatch: 3, role: 'fat' as const },
      { name: 'olive oil', amount: 22, unit: 'ml', totalForBatch: 66, role: 'fat' as const },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
  // Batch 2: Mon–Wed Dinner
  {
    id: 'batch-030-dinner1-0000-0000-000000000002',
    recipeSlug: 'moroccan-beef-tagine-style-skillet-with-lemon-couscous',
    mealType: 'dinner',
    eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
    servings: 3,
    targetPerServing: { calories: 720, protein: 48 },
    actualPerServing: { calories: 720, protein: 48, fat: 28, carbs: 72 },
    scaledIngredients: [
      { name: 'ground beef', amount: 200, unit: 'g', totalForBatch: 600, role: 'protein' as const },
      { name: 'couscous', amount: 80, unit: 'g', totalForBatch: 240, role: 'carb' as const },
      { name: 'olive oil', amount: 15, unit: 'ml', totalForBatch: 45, role: 'fat' as const },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
  // Batch 3: Thu–Sat Lunch (next cook day is Thu Apr 9)
  {
    id: 'batch-030-lunch2-0000-0000-000000000003',
    recipeSlug: 'ground-beef-rigatoni-bolognese',
    mealType: 'lunch',
    eatingDays: ['2026-04-09', '2026-04-10', '2026-04-11'],
    servings: 3,
    targetPerServing: { calories: 780, protein: 52 },
    actualPerServing: { calories: 780, protein: 52, fat: 32, carbs: 78 },
    scaledIngredients: [
      { name: 'ground beef', amount: 180, unit: 'g', totalForBatch: 540, role: 'protein' as const },
      { name: 'rigatoni', amount: 90, unit: 'g', totalForBatch: 270, role: 'carb' as const },
      { name: 'cherry tomatoes', amount: 150, unit: 'g', totalForBatch: 450, role: 'vegetable' as const },
      { name: 'olive oil', amount: 15, unit: 'ml', totalForBatch: 45, role: 'fat' as const },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
  // Batch 4: Thu–Sat Dinner
  {
    id: 'batch-030-dinner2-0000-0000-000000000004',
    recipeSlug: 'soy-ginger-pork-rice-bowls-broccoli-carrots-scallions',
    mealType: 'dinner',
    eatingDays: ['2026-04-09', '2026-04-10', '2026-04-11'],
    servings: 3,
    targetPerServing: { calories: 650, protein: 44 },
    actualPerServing: { calories: 650, protein: 44, fat: 22, carbs: 65 },
    scaledIngredients: [
      { name: 'pork tenderloin', amount: 180, unit: 'g', totalForBatch: 540, role: 'protein' as const },
      { name: 'broccoli', amount: 100, unit: 'g', totalForBatch: 300, role: 'vegetable' as const },
      { name: 'basmati rice', amount: 80, unit: 'g', totalForBatch: 240, role: 'carb' as const },
      { name: 'soy sauce', amount: 20, unit: 'ml', totalForBatch: 60, role: 'seasoning' as const },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
];

/**
 * Measurements seed: one measurement today (so step 10's progress menu
 * tap takes the "already logged today" branch that sets `weekly_report`)
 * AND enough prior-week data that `getMeasurements(lastWeekStart, lastWeekEnd)`
 * returns a non-empty array — this triggers `progressReportKeyboard` on
 * step 10's output AND makes step 11's `pg_last_report` take the
 * "has data" branch rather than the "not enough data" error.
 *
 * Today (scenario clock) = 2026-04-08 (Wed). Current week starts Mon
 * 2026-04-06. `getCalendarWeekBoundaries(today)` returns last completed
 * week as Mon 2026-03-30 → Sun 2026-04-05. Seed at least 4 measurements
 * in that range so the weekly report is computable.
 */
const measurements = [
  { userId: 'default', date: '2026-04-08', weight: 82.5, waist: 91 }, // today
  { userId: 'default', date: '2026-04-05', weight: 82.7, waist: 91 }, // prior week Sun
  { userId: 'default', date: '2026-04-04', weight: 82.8, waist: 91 }, // prior week Sat
  { userId: 'default', date: '2026-04-02', weight: 83.0, waist: 92 }, // prior week Thu
  { userId: 'default', date: '2026-03-31', weight: 83.2, waist: 92 }, // prior week Tue
];

export default defineScenario({
  name: '030-navigation-state-tracking',
  description:
    'Navigation state: walks through every render surface (plan subviews, cook view, shopping scopes, recipe library/detail, progress) with per-step session assertions that verify every LastRenderedView variant end-to-end.',
  clock: '2026-04-08T10:00:00Z',
  recipeSet: 'six-balanced',
  captureStepState: true,  // Plan 027 Task 4b — assert sessionAt[] per step
  initialState: {
    session: null,
    planSessions: [activeSession],
    batches: activeBatches,
    measurements,
  },
  events: [
    text('📋 My Plan'),                                                  // sessionAt[0] — plan/next_action
    click('wo_show'),                                                     // sessionAt[1] — plan/week_overview
    click('dd_2026-04-09'),                                               // sessionAt[2] — plan/day_detail
    click('cv_batch-030-lunch2-0000-0000-000000000003'),                  // sessionAt[3] — cooking/cook_view
    text('📖 My Recipes'),                                                // sessionAt[4] — recipes/library
    click('rv_chicken-black-bean-avocado-rice-bowl'),                     // sessionAt[5] — recipes/recipe_detail
    click('recipe_back'),                                                 // sessionAt[6] — recipes/library (again)
    text('🛒 Shopping List'),                                             // sessionAt[7] — shopping/next_cook
    click('sl_2026-04-09'),                                               // sessionAt[8] — shopping/day
    text('📊 Progress'),                                                  // sessionAt[9] — progress/weekly_report (already-logged-today branch)
    click('pg_last_report'),                                              // sessionAt[10] — progress/weekly_report (pg_last_report handler)
  ],
});
```

- [ ] **Step 2: Generate the recording**

Run: `npm run test:generate -- 030-navigation-state-tracking --yes`
Expected: a new `test/scenarios/030-navigation-state-tracking/recorded.json` is written. No LLM fixtures are needed (the scenario has zero LLM calls — all events are callbacks or reply-keyboard taps against a pre-seeded plan).

- [ ] **Step 3: Behavioral review**

Read the recorded outputs in order and verify each step produces the expected UX:

1. **📋 My Plan** — Next Action text (Wed Apr 8 with reheat info, Thu Apr 9 with cook buttons, Fri Apr 10 reheat) + nextActionKeyboard.
2. **wo_show** — Week Overview text (Mon–Sun grid) + weekOverviewKeyboard with day buttons.
3. **dd_2026-04-09** — Day Detail for Thu Apr 9 (cooking day) + dayDetailKeyboard with cook buttons for lunch and dinner batches.
4. **cv_batch-030-lunch2-...** — Cook view for the ground-beef-rigatoni-bolognese batch (scaled ingredients for 3 servings) + cookViewKeyboard.
5. **📖 My Recipes** — Recipe list with "COOKING SOON" header + library kb.
6. **rv_chicken-...** — Recipe detail for the chicken rice bowl + recipeViewKeyboard.
7. **recipe_back** — Recipe list again (same as step 5).
8. **🛒 Shopping List** — Shopping list for Thu Apr 9 (lunch + dinner + breakfast proration) + buildShoppingListKeyboard.
9. **sl_2026-04-09** — Same shopping list as step 8 (cook day is Thu Apr 9 → sl_next and sl_2026-04-09 target the same day; the distinction is in `lastRenderedView`, not in the rendered output).
10. **📊 Progress** — "Already logged today ✓" + `progressReportKeyboard` (inline button for last weekly report). The seeded measurement for 2026-04-08 takes the handler's `if (existing)` branch, and the seeded prior-week measurements make `hasCompletedWeekReport === true`, so the reply includes the report keyboard.
11. **pg_last_report** — The weekly-report body for 2026-03-30 → 2026-04-05 formatted via `formatWeeklyReport`, sent as plain text with `parse_mode: 'Markdown'` and no keyboard.

**Verify `finalSession.lastRenderedView`** in the recording: it MUST be `{ surface: 'progress', view: 'weekly_report' }` because step 11 (`pg_last_report`, "has data" branch) is the last render that updates the field. If it's anything else, Task 11 has a bug.

**Verify `finalSession.sessionAt`** — the per-step session snapshot array, which is the LOAD-BEARING assertion for proposal 003's "verify the new state is tracked correctly" requirement. It MUST have exactly 11 entries, one per event. Spot-check each entry:
- `sessionAt[0].lastRenderedView === { surface: 'plan', view: 'next_action' }`
- `sessionAt[1].lastRenderedView === { surface: 'plan', view: 'week_overview' }`
- `sessionAt[2].lastRenderedView === { surface: 'plan', view: 'day_detail', day: '2026-04-09' }`
- `sessionAt[3].lastRenderedView === { surface: 'cooking', view: 'cook_view', batchId: 'batch-030-lunch2-…', recipeSlug: 'ground-beef-rigatoni-bolognese' }`
- `sessionAt[4].lastRenderedView === { surface: 'recipes', view: 'library' }`
- `sessionAt[5].lastRenderedView === { surface: 'recipes', view: 'recipe_detail', slug: 'chicken-black-bean-avocado-rice-bowl' }`
- `sessionAt[6].lastRenderedView === { surface: 'recipes', view: 'library' }` (recipe_back → showRecipeList chokepoint; sibling of sessionAt[4])
- `sessionAt[7].lastRenderedView === { surface: 'shopping', view: 'next_cook' }`
- `sessionAt[8].lastRenderedView === { surface: 'shopping', view: 'day', day: '2026-04-09' }`
- `sessionAt[9].lastRenderedView === { surface: 'progress', view: 'weekly_report' }` (set by the already-logged branch of the progress menu handler)
- `sessionAt[10].lastRenderedView === { surface: 'progress', view: 'weekly_report' }` (set by the `pg_last_report` handler)

If any of the eleven snapshots has the wrong variant, find the handler at the corresponding step and verify its Task 5/6/7/8/9/10/11 instrumentation. Failures at step 3, 8, or 9 are particularly important — those assert `day_detail` / `next_cook` / `day` variants that the earlier draft could not verify at all.

**Verify `finalSession.surfaceContext`**: MUST be `'progress'` (set by the helper at step 11).

**Verify `finalSession.progressFlow`**: MUST be `null` — the "already logged today" branch at step 10 explicitly sets `session.progressFlow = null` (`src/telegram/core.ts:1021`), and step 11 doesn't touch it.

**Verify `finalSession.planFlow`**: MUST be `null` — scenario 030 never starts a planning flow.

**Verify `finalSession.lastRecipeSlug`**: MUST be `undefined`. Walk the scenario carefully:
- Step 1 (`📋 My Plan` → `my_plan` case) clears `lastRecipeSlug` to `undefined`.
- Step 4 (`cv_`) sets `lastRecipeSlug = 'ground-beef-rigatoni-bolognese'`.
- Step 5 (`📖 My Recipes`) **clears** to `undefined`.
- Step 6 (`rv_`) sets `lastRecipeSlug = 'chicken-black-bean-avocado-rice-bowl'`.
- Step 7 (`recipe_back` → `showRecipeList`) does NOT touch `lastRecipeSlug`.
- Step 8 (`🛒 Shopping List`) **clears** to `undefined`.
- Step 9 (`sl_`) does NOT touch `lastRecipeSlug`.
- Step 10 (`📊 Progress`) **clears** (already `undefined`).
- Step 11 (`pg_last_report` — callback handler, NOT a menu case) does NOT touch `lastRecipeSlug`.
- Final value: **`undefined`**.

**Verify `finalSession.recipeListPage`**: should be `0` (never paged).

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all scenarios green. Scenario 030's recording has `sessionAt` (11 entries); scenario 035's recording will have `sessionAt` (1 entry) once it's authored in Step 6 below. All other scenarios do not opt in and the fourth assertion is skipped for them.

- [ ] **Step 5: Commit scenario 030**

```bash
git add test/scenarios/030-navigation-state-tracking/
git commit -m "Plan 027: add scenario 030 — navigation state tracking with per-step assertions"
```

- [ ] **Step 6: Write sibling scenario 035 — progress log_prompt terminal**

Scenario 030 covers nine of the ten `LastRenderedView` variants end-to-end via its `sessionAt[]` array. The tenth variant — `progress/log_prompt` — requires a seed state where no measurement has been logged today, which is mutually exclusive with scenario 030's "already logged today" branch at step 10. A tiny sibling scenario covers log_prompt as its sole terminal assertion.

Create `test/scenarios/035-navigation-progress-log-prompt/spec.ts`:

```typescript
/**
 * Scenario 035 — navigation state for progress/log_prompt variant.
 *
 * Part of Plan 027 (Navigation state model). Companion to scenario 030
 * which covers nine of ten `LastRenderedView` variants via per-step
 * assertions. Scenario 030 cannot cover `progress/log_prompt` because
 * its seed includes today's measurement (needed for steps 10 and 11 to
 * hit the "already logged" + `pg_last_report` branches that both set
 * `weekly_report`). This sibling uses the opposite seed — NO measurement
 * today — so the progress menu handler takes the "no measurement today"
 * branch that sets `lastRenderedView = { surface: 'progress', view: 'log_prompt' }`.
 *
 * Single-step scenario: tap 📊 Progress. Terminal variant is log_prompt.
 *
 * Clock: 2026-04-08T10:00:00Z. Zero LLM calls. No plan needed.
 */

import { defineScenario, text } from '../../../src/harness/define.js';

export default defineScenario({
  name: '035-navigation-progress-log-prompt',
  description:
    'Navigation state: single-step scenario asserting progress/log_prompt terminal variant (the one variant scenario 030 cannot cover).',
  clock: '2026-04-08T10:00:00Z',
  recipeSet: 'six-balanced',
  captureStepState: true,
  initialState: { session: null }, // no measurements seeded
  events: [
    text('📊 Progress'), // sessionAt[0] — progress/log_prompt
  ],
});
```

- [ ] **Step 7: Generate, review, commit scenario 035**

```bash
npm run test:generate -- 035-navigation-progress-log-prompt --yes
```

Behavioral review:
1. Output 1: "Drop your weight (and waist if you track it): …" — the log-prompt text. No `reply_markup` (progress prompt is plain text).
2. `finalSession.progressFlow` MUST be `{ phase: 'awaiting_measurement' }` — the handler sets this immediately before the setLastRenderedView call.
3. `finalSession.lastRenderedView` MUST be `{ surface: 'progress', view: 'log_prompt' }`.
4. `finalSession.sessionAt` MUST have exactly one entry: `sessionAt[0].lastRenderedView === { surface: 'progress', view: 'log_prompt' }`.
5. `finalSession.surfaceContext` MUST be `'progress'` (set by the helper).

Commit:

```bash
git add test/scenarios/035-navigation-progress-log-prompt/
git commit -m "Plan 027: add scenario 035 — navigation progress/log_prompt terminal"
```

- [ ] **Step 8: Write scenario 036 — day-detail back-button regression lock**

Proposal 003's Plan B verification contract at `docs/design-docs/proposals/003-freeform-conversation-layer.md:755` explicitly names TWO audit outcomes Plan B must deliver scenario coverage for: "user taps shopping list mid-planning — does planFlow persist or not?" (scenario 031, covered) AND **"user drills into day detail then back — returns to day detail or to week overview?"** (NOT covered by 031, 032, 033, 030, or 035). The current user-visible answer is **week overview**, hardcoded at `src/telegram/keyboards.ts:354` where `dayDetailKeyboard` adds `.text('← Back to week', 'wo_show')`.

Plan 027's scope guard at line 92 says keyboards are NOT modified — back-button targets stay hardcoded, Plan C (dispatcher) will introduce dynamic back computation. But the design-doc requirement is explicit: scenario coverage for THIS audit outcome, as delivered by THIS plan. Scenario 036 is the regression lock: it walks the real user journey (my_plan → wo_show → dd_<date> → wo_show) and asserts via per-step `sessionAt[]` that tapping the "← Back to week" button from day detail lands the user back on week overview. When Plan C eventually touches back-button routing (either by changing the target or by introducing dynamic computation), this scenario's regeneration will produce a clean, focused diff against the v0.0.5 baseline.

**Why a dedicated scenario rather than extending scenario 030.** Scenario 030 walks `dd_<date> → cv_<batchId>` — it never taps the back button from day detail, so the `wo_show`-from-`day_detail` transition is not exercised. Extending 030 with additional steps would dilute its "per-surface walkthrough" purpose and force renumbering of every `sessionAt[n]` assertion. A dedicated 4-step regression-lock scenario keeps the purpose clean and matches the shape of scenario 031 (a small focused regression lock for the other proposal-003-named audit outcome). Both scenarios become the reference pair for "scenarios covering each audit outcome".

Create `test/scenarios/036-day-detail-back-button-audit/spec.ts`:

```typescript
/**
 * Scenario 036 — day detail "← Back to week" button regression lock.
 *
 * Part of Plan 027 (Navigation state model / Plan B audit). Directly answers
 * proposal 003's explicitly-named audit outcome at
 * `docs/design-docs/proposals/003-freeform-conversation-layer.md:755`:
 * "user drills into day detail then back — returns to day detail or to
 * week overview?"
 *
 * The current user-visible answer is **week overview**, enforced by the
 * hardcoded callback at `src/telegram/keyboards.ts:354`
 * (`kb.text('← Back to week', 'wo_show')`). Plan 027 does NOT change this
 * (scope guard: no keyboard modifications), but this scenario LOCKS IN
 * the current behavior so Plan C's eventual dispatcher-driven back
 * computation produces a focused, visible diff rather than a silent
 * behavioral drift.
 *
 * Journey (all clicks; no LLM calls):
 *   [0]  📋 My Plan          → { surface: 'plan', view: 'next_action' }
 *   [1]  wo_show              → { surface: 'plan', view: 'week_overview' }
 *   [2]  dd_2026-04-09        → { surface: 'plan', view: 'day_detail', day: '2026-04-09' }
 *   [3]  wo_show (back tap)   → { surface: 'plan', view: 'week_overview' }
 *
 * The load-bearing assertion is `sessionAt[3].lastRenderedView.view ===
 * 'week_overview'`: after tapping "← Back to week" from day detail, the
 * user MUST land on week overview. Any Plan C change that re-routes this
 * button will fail this scenario on the next `npm test` until the
 * regeneration review confirms the new behavior is intentional.
 *
 * Clock: 2026-04-08T10:00:00Z (active_mid, same seed shape as scenarios
 * 018 and 030 so the batch IDs and day references match).
 * Seed: active plan + batches sufficient for `dd_2026-04-09` to render
 *       (Thu Apr 9 is the next cook day).
 */

import { defineScenario, text, click } from '../../../src/harness/define.js';
import type { PlanSession, Batch } from '../../../src/models/types.js';

const activeSession: PlanSession = {
  id: 'session-036-0000-0000-0000-000000000001',
  horizonStart: '2026-04-06',
  horizonEnd: '2026-04-12',
  breakfast: {
    locked: true,
    recipeSlug: 'salmon-avocado-toast-soft-eggs-cinnamon-yogurt',
    caloriesPerDay: 390,
    proteinPerDay: 31,
  },
  treatBudgetCalories: 1050,
  flexSlots: [],
  events: [],
  confirmedAt: '2026-04-06T08:00:00.000Z',
  superseded: false,
  createdAt: '2026-04-06T08:00:00.000Z',
  updatedAt: '2026-04-06T08:00:00.000Z',
};

/** Minimum batches so dd_2026-04-09 renders a non-empty day detail view. */
const activeBatches: Batch[] = [
  {
    id: 'batch-036-lunch-0000-0000-000000000001',
    recipeSlug: 'ground-beef-rigatoni-bolognese',
    mealType: 'lunch',
    eatingDays: ['2026-04-09', '2026-04-10', '2026-04-11'],
    servings: 3,
    targetPerServing: { calories: 780, protein: 52 },
    actualPerServing: { calories: 780, protein: 52, fat: 32, carbs: 78 },
    scaledIngredients: [
      { name: 'ground beef', amount: 180, unit: 'g', totalForBatch: 540, role: 'protein' as const },
      { name: 'rigatoni', amount: 90, unit: 'g', totalForBatch: 270, role: 'carb' as const },
      { name: 'olive oil', amount: 15, unit: 'ml', totalForBatch: 45, role: 'fat' as const },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
];

export default defineScenario({
  name: '036-day-detail-back-button-audit',
  description:
    'Audit regression lock (proposal 003 §755 named outcome): user drills my_plan → wo_show → dd_<date>, taps "← Back to week" (which sends wo_show), and lands on week_overview. Per-step sessionAt[] assertions lock in the v0.0.5 back-button outcome before Plan C changes it.',
  clock: '2026-04-08T10:00:00Z',
  recipeSet: 'six-balanced',
  captureStepState: true,
  initialState: {
    session: null,
    planSessions: [activeSession],
    batches: activeBatches,
  },
  events: [
    text('📋 My Plan'),         // sessionAt[0] — plan/next_action
    click('wo_show'),            // sessionAt[1] — plan/week_overview
    click('dd_2026-04-09'),      // sessionAt[2] — plan/day_detail
    click('wo_show'),            // sessionAt[3] — plan/week_overview (back-button outcome)
  ],
});
```

- [ ] **Step 9: Generate, review, commit scenario 036**

```bash
npm run test:generate -- 036-day-detail-back-button-audit --yes
```

Behavioral review:
1. **Output 1** — Next Action text with `nextActionKeyboard`. The batch list reflects the single seeded lunch batch (Thu Apr 9 cook day).
2. **Output 2** — Week Overview grid with `weekOverviewKeyboard` containing day buttons including `dd_2026-04-09`.
3. **Output 3** — Day Detail for Thu Apr 9 with `dayDetailKeyboard`. The keyboard MUST include the "← Back to week" button with callback `wo_show` — if it's missing or targets a different callback, scenario is exercising the wrong shape.
4. **Output 4** — Week Overview grid again (same text + keyboard as Output 2). Byte-identical except for any sub-expressions that depend on state; since neither plan state nor batches changed between steps 2 and 4, the outputs should match exactly.
5. **`finalSession.sessionAt`** MUST have exactly 4 entries:
   - `sessionAt[0].lastRenderedView === { surface: 'plan', view: 'next_action' }`
   - `sessionAt[1].lastRenderedView === { surface: 'plan', view: 'week_overview' }`
   - `sessionAt[2].lastRenderedView === { surface: 'plan', view: 'day_detail', day: '2026-04-09' }`
   - `sessionAt[3].lastRenderedView === { surface: 'plan', view: 'week_overview' }` ← **the load-bearing assertion**
6. **`finalSession.lastRenderedView`** MUST be `{ surface: 'plan', view: 'week_overview' }` (matches `sessionAt[3]`).
7. **`finalSession.planFlow`** MUST be `null` — the scenario never starts a planning flow.

If `sessionAt[3]` is anything other than `week_overview` — e.g., `day_detail` still, or `next_action` — either the day-detail back button was silently changed, or Task 5's `wo_show` instrumentation is wrong. Fix the code, do NOT accept a regenerated recording with a different back-button target unless the change is intentional and documented.

Commit:

```bash
git add test/scenarios/036-day-detail-back-button-audit/
git commit -m "Plan 027: add scenario 036 — day-detail back-button audit regression lock (proposal 003 §755)"
```

---

### Task 16: Update `test/scenarios/index.md`

**Files:**
- Modify: `test/scenarios/index.md`

- [ ] **Step 1: Append new rows to the scenario table**

In `test/scenarios/index.md`, add these rows at the bottom of the table (after scenario 029):

```markdown
| 030 | navigation-state-tracking | Navigation state model: walks through every render surface (plan subviews, cook view, shopping scopes, recipe library/detail, progress) and asserts every intermediate `lastRenderedView` variant via per-step session snapshots (Task 4b harness extension). Covers 9 of 10 variants. Plan 027. |
| 031 | shopping-list-mid-planning-audit | Regression lock: user starts next-week planning, taps 🛒 Shopping List — planFlow is cleared (current behavior, Plan 027 leaves alone), shopping list of the ACTIVE plan renders. Locks in the audit decision for future freeform-model work. Plan 027. |
| 032 | discard-recipe-audit | Regression lock: user enters a recipe flow, taps Discard — recipeFlow cleared (Plan 027 audit decision "leave alone"). Plan 027. |
| 033 | recipe-edit-clears-planflow-audit | Regression lock: user has planFlow alive at phase=context, taps re_<slug> from a recipe view — planFlow cleared (Plan 027 audit decision "leave alone"; defensive clear because the non-dispatcher model can't cleanly return to planning after recipe edit). Plan 027. |
| 035 | navigation-progress-log-prompt | Single-step sibling to 030: covers the one `LastRenderedView` variant (progress/log_prompt) that 030 cannot reach because it requires mutually exclusive seed state (no today measurement). Plan 027. |
| 036 | day-detail-back-button-audit | Regression lock (proposal 003 §755 named audit outcome): user drills `my_plan → wo_show → dd_<date>`, taps "← Back to week" (which sends `wo_show`), and lands on week_overview. Per-step `sessionAt[]` assertions lock in the v0.0.5 hardcoded back-button outcome. Plan 027. |
```

- [ ] **Step 2: Commit**

```bash
git add test/scenarios/index.md
git commit -m "Plan 027: update scenarios index with 030/031/032/033/035/036"
```

---

### Task 17: Sync `docs/product-specs/ui-architecture.md` and `testing.md`

**Rationale:** Per CLAUDE.md's docs-maintenance rules, product specs must stay in sync with code behavior in the same commit as the change. Plan 027 adds a concrete runtime concept (`LastRenderedView`, with the invariant that every render call site populates it). The UI architecture spec must reflect this, and the testing spec should note that `finalSession.lastRenderedView` is now an assertable property.

**Files:**
- Modify: `docs/product-specs/ui-architecture.md`
- Modify: `docs/product-specs/testing.md`

- [ ] **Step 1: Read the current `ui-architecture.md`**

Read `docs/product-specs/ui-architecture.md` in full (it's short relative to the other specs). Identify the section describing the "surface context" model and the "freeform conversation layer" section that proposal 003 mentions it will supersede.

- [ ] **Step 2: Add a "Navigation state" subsection**

Add a new subsection under the existing "Surface context" or "Navigation model" heading (whichever exists; if neither, add it near the top of the architecture narrative). Content:

```markdown
## Navigation state (Plan 027)

The bot's in-memory session carries two layers of navigation state:

1. **`surfaceContext`** — coarse five-value enum (`'plan' | 'cooking' | 'shopping' | 'recipes' | 'progress' | null`) used by the free-text fallback to pick a contextual hint.
2. **`lastRenderedView`** — precise discriminated union that captures the exact render target AND its parameters. Defined in `src/telegram/navigation-state.ts`.

Every handler that produces a navigation render (Next Action, Week Overview, Day Detail, Cook view, Shopping list at any scope, Recipe library or detail, Progress log prompt or weekly report) calls `setLastRenderedView(session, view)` immediately before its `sink.reply(...)`. The helper mutates both fields atomically so `surfaceContext` always matches `lastRenderedView.surface`.

**What `lastRenderedView` is for.** It is the source of truth for "what the user was last looking at" and is read by the dispatcher in Plan C (freeform conversation layer) to compute dynamic back-button targets and to answer questions like "show me that recipe again". Plan 027 (this plan) lays the state rails; the dispatcher that reads them is a later plan. **Back-button callbacks remain hardcoded in v0.0.5 Plan B** — `cookViewKeyboard` still targets `na_show`, `buildShoppingListKeyboard` still targets `na_show`, etc.

**What `lastRenderedView` does NOT track.**
- In-flow transitional messages (breakfast confirmation, events prompt, proposal review, measurement confirmation, recipe generation review) are flow progressions, not navigation views. They do not update `lastRenderedView`.
- Recipe library pagination is tracked separately on `session.recipeListPage`; `lastRenderedView` only records that the user is on the library page.
- `lastRecipeSlug` (legacy field) continues to be managed independently by the recipe-view handler and the free-text fallback — `setLastRenderedView` does not touch it. This is deliberate to avoid changing the fallback behavior in Plan B.

**Variants** (see `src/telegram/navigation-state.ts` for the authoritative definition):

- `{ surface: 'plan', view: 'next_action' }`
- `{ surface: 'plan', view: 'week_overview' }`
- `{ surface: 'plan', view: 'day_detail', day: <ISO-date> }`
- `{ surface: 'cooking', view: 'cook_view', batchId, recipeSlug }`
- `{ surface: 'shopping', view: 'next_cook' }`
- `{ surface: 'shopping', view: 'day', day: <ISO-date> }`
- `{ surface: 'recipes', view: 'library' }`
- `{ surface: 'recipes', view: 'recipe_detail', slug }`
- `{ surface: 'progress', view: 'log_prompt' }`
- `{ surface: 'progress', view: 'weekly_report' }`

New render targets (e.g., `full_week` shopping scope in Plan E, product-question answers in a future plan) will be added here as new variants.
```

Also find the "Freeform conversation layer" sketch section (if present — proposal 003 says "This proposal supersedes the 'Freeform conversation layer' sketch in `docs/product-specs/ui-architecture.md`") and add a one-line pointer:

```markdown
> **Plan 027 (Navigation state model)** lays the precise state-tracking rails this freeform layer will read. See the Navigation state section above.
```

Do NOT rewrite the whole freeform layer section — that's proposal 003's job when it's promoted to a design doc. Plan 027 only adds the navigation-state footnote.

- [ ] **Step 3: Add a testing-docs note**

In `docs/product-specs/testing.md`, find the section headed **"What the tests assert"** (around line 298). That section today lists three assertions per scenario: `outputs`, `finalSession`, `finalStore`. Plan 027 adds a fourth (opt-in) — `sessionAt` — plus a new field-level assertion (`lastRenderedView`) that any scenario can read off `finalSession`. Both need to be documented so future agents know the capabilities exist and when to use them.

**Sub-step 3a: extend the "What the tests assert" list.**

Replace the numbered list in the "What the tests assert" section with:

```markdown
Every scenario asserts three things independently via `assert.deepStrictEqual`, plus one optional fourth:

1. **`outputs`** — the full captured Telegram transcript (text + keyboard shape for each reply).
2. **`finalSession`** — `BotCore.session` at the end of the event loop.
3. **`finalStore`** — the `TestStateStore.snapshot()` result at the end of the scenario.
4. **`sessionAt`** (optional, opt-in per scenario) — a per-event snapshot of `BotCore.session` captured immediately after each dispatched event. Scenarios that need to verify **intermediate** state transitions (e.g., that every step of a navigation walkthrough set the right `lastRenderedView` variant) set `captureStepState: true` in their spec. See "Opt-in per-step session capture" below. Scenarios that don't opt in see no behavior change — their recording has no `sessionAt` field and the fourth assertion is skipped.

A bug that produces a correct transcript but skips persistence still fires because `finalStore` diverges. A bug that persists correctly but sends the wrong message fires on `outputs`. A bug that's correct at end-state but wrong at an intermediate step (e.g., step 4 sets `cook_view` but scenario ends on `next_action`) is only caught by the per-step `sessionAt` assertion. All four assertions are load-bearing — the harness exists to catch the exact class of silent failure where one is right and another isn't.
```

**Sub-step 3b: add the "Opt-in per-step session capture" subsection.**

Immediately after the extended "What the tests assert" section, add a new subsection:

```markdown
### Opt-in per-step session capture

Plan 027 added a fourth, opt-in assertion for scenarios that need to verify session state AT each step, not just at the end. The use case: scenarios like `030-navigation-state-tracking` walk the user through every `LastRenderedView` variant in sequence, and the harness's `finalSession` check would only ever verify the terminal variant. Intermediate variants (each set and then overwritten) would have no end-to-end coverage. Per-step capture closes that gap.

**How to opt in.** Add `captureStepState: true` to your scenario's `defineScenario({...})` call:

```typescript
export default defineScenario({
  name: '030-navigation-state-tracking',
  description: '…',
  clock: '…',
  recipeSet: 'six-balanced',
  captureStepState: true,  // ← opt in
  initialState: { … },
  events: [ … ],
});
```

**What it does.** When `captureStepState === true`, the runner captures `normalizeUuids(JSON.parse(JSON.stringify(core.session)))` immediately after every `core.dispatch(event, sink)` call and stores the snapshots in an array. The generator writes the array to `recorded.expected.sessionAt`. At replay time, the test runner adds a fourth `deepStrictEqual` comparing `result.sessionAt` to `recorded.expected.sessionAt`. The comparison fires only if `recorded.expected.sessionAt !== undefined`, so scenarios that don't opt in are completely unaffected.

**When to use it.**

- **Navigation walkthroughs** — verifying `lastRenderedView` (or `surfaceContext`, or any other field) changes correctly at every step as the user moves through subviews.
- **Multi-phase flow transitions** — verifying a recipe flow correctly progresses through `awaiting_meal_type → awaiting_preferences → reviewing`, not just lands on the final phase.
- **State-leak regression tests** — verifying that a sequence of events never sets a field that should stay untouched (e.g., `planFlow` remaining `null` across a 10-step recipe navigation).

**When NOT to use it.**

- **Most existing scenarios.** The final-state assertion is enough for scenarios whose purpose is "does the terminal outcome match expectations". Opt-in keeps recordings small — a non-navigation scenario with 15 events would add 15 full session snapshots to its `recorded.json` for no test signal.
- **Scenarios with long event sequences where intermediate state is irrelevant.** If you only care about the final state, don't opt in.

**Reviewing `sessionAt` in a recording.** When behaviorally reviewing a regenerated scenario with `captureStepState: true`, read through `recorded.expected.sessionAt[n]` entry-by-entry and verify each snapshot matches what you'd expect after event `n`. The array length should equal `spec.events.length`. A scenario asserting `lastRenderedView` variants should have one snapshot per step with the expected discriminated-union value set. Any mismatch at a particular index points directly at the handler that dispatched event `n`.

**Authoritative example.** See `test/scenarios/030-navigation-state-tracking/spec.ts` — the canonical scenario that uses per-step capture to assert nine distinct `LastRenderedView` variants end-to-end in a single walkthrough. Sibling scenario 035 (`navigation-progress-log-prompt`) uses the same mechanism for a single-step terminal assertion.

### Asserting on `lastRenderedView` (Plan 027)

Scenarios that exercise navigation can assert on `finalSession.lastRenderedView` (or any `sessionAt[n].lastRenderedView` entry when opted in) to verify what the user was last looking at. The field is a discriminated union defined in `src/telegram/navigation-state.ts`; the variant at the end of a scenario — or at any intermediate step — should match the last navigation render the scenario's events produced up to that point. See scenario 030 (`navigation-state-tracking`) for per-step variant coverage, scenario 035 (`navigation-progress-log-prompt`) for a single-step terminal, and scenarios 031/032/033 (`shopping-list-mid-planning-audit`, `discard-recipe-audit`, `recipe-edit-clears-planflow-audit`) for regression locks that exercise the planFlow-clear audit decisions from Plan 027.
```

**Sub-step 3c: verify placement.**

Re-read the modified section start-to-end. It should read as three layers of detail:
1. The "What the tests assert" list now mentions the opt-in fourth assertion.
2. The "Opt-in per-step session capture" subsection explains the mechanism, when to use it, and points to scenario 030 as the canonical example.
3. The "Asserting on `lastRenderedView`" subsection documents the field-level assertion available in both `finalSession` and `sessionAt` entries, and points to the other Plan 027 scenarios.

If any of the three layers is out of order or duplicated, fix the placement before committing.

- [ ] **Step 4: Typecheck and test**

Run: `npx tsc --noEmit`
Expected: no errors (docs changes don't affect the type graph).

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/product-specs/ui-architecture.md docs/product-specs/testing.md
git commit -m "Plan 027: sync ui-architecture.md with navigation state model and testing.md with captureStepState + lastRenderedView assertions"
```

---

### Task 18: Final baseline

**Files:** none modified — baseline check only.

- [ ] **Step 1: Run the full test suite one final time**

Run: `npm test`
Expected: PASS. Same test count as Task 1's baseline plus the new unit tests from Task 4 (+12 `setLastRenderedView` variant tests) and the six new scenarios from Tasks 14 and 15 (030 walkthrough, 031 shopping-list audit, 032 discard_recipe audit, 033 recipe-edit audit, 035 log_prompt sibling, 036 day-detail back-button audit). Some existing scenarios will have been regenerated in Task 13 with updated `lastRenderedView` fields; scenario 012 will NOT have been regenerated because none of its events set `lastRenderedView` (see the validation section below for the full regeneration scope).

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Verify the commit chain**

Run: `git log --oneline -20`
Expected: a sequence of commits all starting with "Plan 027:" — roughly one per task from Task 2 onward, plus the doc sync and regenerations.

- [ ] **Step 4: No commit needed**

This is a pure verification step. If any of the above fails, jump back to the responsible task and fix it. If everything passes, Plan 027 is done and ready for handoff to Plan C (which depends on it).

---

## Progress

- [ ] Task 1 — Green baseline
- [ ] Task 2 — Create `src/telegram/navigation-state.ts` with `LastRenderedView` + helper
- [ ] Task 3 — Add `lastRenderedView` field to `BotCoreSession` + update `reset()` + clear in `/start` and `/cancel`
- [ ] Task 4 — Unit test `setLastRenderedView` against every variant
- [ ] Task 4b — Extend scenario harness with opt-in per-step session-state capture
- [ ] Task 5 — Instrument `na_show`, `wo_show`, `dd_` plan-subview handlers
- [ ] Task 6 — Instrument `cv_` cook-view handler
- [ ] Task 7 — Instrument `sl_` shopping-list handler (both scopes)
- [ ] Task 8 — Instrument `rv_` recipe-view handler
- [ ] Task 8b — Instrument free-text recipe lookup render path
- [ ] Task 9 — Instrument `showRecipeList` chokepoint
- [ ] Task 10 — Instrument `my_plan` menu handler
- [ ] Task 11 — Instrument `progress` menu + `pg_last_report`
- [ ] Task 12 — Verification checklist: instrumented vs. not
- [ ] Task 13 — Regenerate affected scenario recordings
- [ ] Task 14 — PlanFlow-clear audit + scenarios 031/032/033 regression locks
- [ ] Task 15 — New scenarios 030 (walkthrough with per-step assertions), 035 (log_prompt sibling), and 036 (day-detail back-button audit)
- [ ] Task 16 — Update `test/scenarios/index.md`
- [ ] Task 17 — Sync `docs/product-specs/ui-architecture.md` and `testing.md`
- [ ] Task 18 — Final baseline

---

## Decision log

- **Decision:** `LastRenderedView` is a discriminated union with `surface` as the primary discriminant, matching `BotCoreSession.surfaceContext`'s value space.
  **Rationale:** A discriminated union catches typos at compile time and enables TypeScript narrowing inside handler code. Matching `surfaceContext`'s values as the discriminant lets `setLastRenderedView` enforce the invariant "surfaceContext always mirrors lastRenderedView.surface" in one line. An alternative (open string keys) was rejected because it would silently accept new surfaces without forcing the developer to declare them.
  **Date:** 2026-04-10

- **Decision:** `lastRenderedView` is OPTIONAL on `BotCoreSession`, not `T | null`.
  **Rationale:** `JSON.stringify` drops `undefined` fields, so an optional field only appears in recorded scenarios that actually hit a render path. Using `T | null` would force EVERY scenario's `recorded.json` to grow a `"lastRenderedView": null` line, triggering dozens of regenerations (including expensive LLM-fixture scenarios like the re-proposer suite) for no behavioral reason. The optional shape minimizes churn. It also matches the existing `lastRecipeSlug?: string` pattern on the same interface.
  **Date:** 2026-04-10

- **Decision:** `setLastRenderedView` does NOT touch `lastRecipeSlug`.
  **Rationale:** `lastRecipeSlug` is a legacy field that the free-text fallback (`src/telegram/core.ts:260`) reads independently of `surfaceContext` to decide whether to offer recipe-specific help. Centralizing `lastRecipeSlug` management in the helper would either (a) change fallback behavior in scenarios that don't touch recipes (risky) or (b) require the helper to special-case which variants should clear the slug and which should set it (brittle). Leaving `lastRecipeSlug` to the specific handlers that care about it preserves current behavior exactly and keeps the helper simple.
  **Date:** 2026-04-10

- **Decision:** Cook view's surface is `'cooking'`, matching the existing `surfaceContext` convention, not `'plan'`.
  **Rationale:** Proposal 003 describes cook view as a "plan subview" in the navigation-state model section but also mentions it under "recipe context". Today's code uses `surfaceContext = 'cooking'` at the `cv_` handler (`src/telegram/core.ts:730`), distinct from the `'plan'` surface used by Next Action / Week Overview / Day Detail. Matching today's convention avoids breaking the free-text fallback (which branches on `surfaceContext === 'cooking' || surfaceContext === 'recipes'` for the "recipe on screen" hint at line 260). A future plan may unify cook view under a single surface; Plan 027 stays faithful to the existing semantics.
  **Date:** 2026-04-10

- **Decision:** Recipe library view does NOT carry a `page` parameter; the existing `session.recipeListPage` stays the source of truth.
  **Rationale:** Duplicating the page number into `LastRenderedView` would create two sources of truth. The library re-render call (`showRecipeList`) already reads `recipeListPage` directly. A future dispatcher that wants to re-render the library just calls the same function. Keeping the discriminated union focused on the minimum unique parameters per variant aligns with the "snapshot of what's unique, not a deep copy of the world" design principle.
  **Date:** 2026-04-10

- **Decision:** `showRecipeList` is instrumented inside the function, not at each of its five callers.
  **Rationale:** `showRecipeList` is called from `rd_`, `rp_`, `recipe_back`, `view_plan_recipes`, and `my_recipes` — five sites, all of which render the same library view. Instrumenting each call site is five times the diff and five places where a future maintainer can forget. Instrumenting the function once applies to every caller for free. This matches the design principle "files that change together should live together, and chokepoints should be the single place for invariant-preserving logic".
  **Date:** 2026-04-10

- **Decision:** Every `planFlow`-clearing site is **"leave alone"** under Plan 027.
  **Rationale:** Proposal 003 asks for an audit with decisions per site (preserve / change / leave alone) and cites the shopping-list menu handler as "wrong in some cases" under the freeform model. Plan 027 is the navigation-state plumbing plan, not a behavior-change plan — there is no dispatcher yet that would make preserving `planFlow` across menu taps useful, and changing semantics without the dispatcher present risks user-hostile intermediate states (e.g., a preserved `planFlow.phase === 'awaiting_events'` consuming stray text as an event). A conservative "leave alone" decision + a regression-lock scenario (031) for the most-cited site gives later plans a clean diff baseline when they DO revisit the decision.
  **Date:** 2026-04-10

- **Decision:** Scenario 031 seeds an ACTIVE plan for the current week + user drafts NEXT week's plan → taps shopping list. No LLM calls.
  **Rationale:** The audit decision for `shopping_list` depends on `planFlow` being alive at the moment of the tap. Reaching a live `planFlow` requires going through `doStartPlanFlow`, which requires a future horizon. Seeding an active plan for the current week makes `computeNextHorizonStart` return `nextMonday` cleanly. The user then taps "📋 Plan Week", `planFlow.phase` becomes `'context'` (no LLM call), and they tap 🛒 Shopping List. This is the minimum-cost way to exercise the clear behavior without LLM generation cost. Alternative approaches (seeding `BotCoreSession.planFlow` directly) are blocked because the harness only seeds the persistent `SessionState`, not the in-memory `BotCoreSession`.
  **Date:** 2026-04-10

- **Decision:** Plan 027 does NOT update `src/telegram/keyboards.ts` (back-button targets stay hardcoded).
  **Rationale:** Proposal 003's Plan B scope explicitly says "Nothing user-facing. Back buttons already exist; this plan just makes them more precise when they eventually get exercised through the dispatcher." The dispatcher is Plan C. Plan 027 populates the state that Plan C will read, but does not itself change any back-button callback. This scope guard is load-bearing: changing back-button targets without the dispatcher's context-aware routing would produce worse UX in the intermediate state, not better.
  **Date:** 2026-04-10

- **Decision:** Plan 027 has no runtime dependency on Plan 026 (Re-Proposer enablement for post-confirmation).
  **Rationale:** Proposal 003's dependency graph lists Plans A and B as independent — they can be implemented in any order and merged independently. Plan 027 touches `src/telegram/core.ts` (session layer) and a new `navigation-state.ts` module; Plan 026 touches `src/plan/session-to-proposal.ts`, `src/models/types.ts` (PlanSession field), and the store. The only shared touchpoint is `src/models/types.ts`, and Plan 027 does not modify it at all (navigation state lives in `BotCoreSession`, not the persisted model). If both plans run in the same branch, their commits are independently mergeable.
  **Date:** 2026-04-10

- **Decision:** `/start` and `/cancel` command handlers are extended to clear `lastRenderedView` (Task 3 Steps 3b and 3c), but `/cancel` continues NOT to clear `surfaceContext` or `lastRecipeSlug`.
  **Rationale:** A review of the first draft of this plan surfaced a hole — the plan cleared `lastRenderedView` only in the harness `reset()` function, not in the real `/start` and `/cancel` handlers, which DO clear other session fields. Leaving the new field stale across `/start` or `/cancel` would let Plan C's dispatcher compute back-button targets for a view the user just escaped. The fix: clear `lastRenderedView` in both handlers. The asymmetry in `/cancel` (continues to leave `surfaceContext` and `lastRecipeSlug` alone) is preserved as a deliberate scope guard — those omissions are pre-existing behavior that Plan 027 does not touch. The new field, on the other hand, is being added in this plan; setting the correct behavior from day one is the right call because there is no prior behavior to preserve.
  **Date:** 2026-04-11

- **Decision:** The free-text recipe lookup branch at `src/telegram/core.ts:1325-1337` IS instrumented with `setLastRenderedView` (Task 8b), counting as the 12th call site rather than the 11th.
  **Rationale:** A review of the first draft found that the plan's call-site inventory listed `rv_` (Task 8) but missed this free-text branch, even though both code paths call `renderRecipe()` and therefore render a recipe detail view. Plan 027's goal statement is "route every render call site through a single helper" — "every" must include this one. Instrumenting it sets `lastRecipeSlug` and `lastRenderedView` to match the `rv_` handler's behavior, and as a side effect causes the free-text fallback at `src/telegram/core.ts:260` to take its "recipe on screen" branch on the next user input. That side effect is a correctness improvement, not a regression: today's fallback wrongly offers the generic hint when the user is staring at a recipe they just looked up. The reply body and parse_mode are unchanged — no keyboard is added, because attaching one would be a user-facing change outside Plan B's "nothing user-facing" scope.
  **Date:** 2026-04-11

- **Decision:** The scenario harness is extended (Task 4b) with opt-in per-step session-state capture so scenario 030 can assert every `LastRenderedView` variant end-to-end from a single walkthrough. This is a small harness feature (~30 lines across `types.ts`, `runner.ts`, the generator, and `scenarios.test.ts`), guarded behind `Scenario.captureStepState: true` so existing scenarios are unaffected.
  **Rationale:** Proposal 003's Plan B verification contract at `docs/design-docs/proposals/003-freeform-conversation-layer.md:755` requires "Scenarios that drive the user through existing flows and verify the new state is tracked correctly." The existing harness only asserts `finalSession` once at scenario end (`test/scenarios.test.ts:102-106`), so a walkthrough that visits ten different views only ever verifies the terminal variant — all the intermediate variants would have no end-to-end assertion. Two options close the gap: (a) extend the harness with per-step capture, or (b) write 6-7 separate terminal-assertion scenarios, one per variant. Option (a) is chosen because it is the minimum-diff fix to the harness (a single opt-in flag, an optional `sessionAt: unknown[]` field in the recording, and a fourth `deepStrictEqual` guarded on presence), and because scenario 030 already walks through every variant — duplicating those walks across 6-7 sibling scenarios would triple the scenario count for no additional signal. Option (b) was in an earlier draft of this plan and was rejected in review because deferring end-to-end coverage to Plan C under-delivers the design doc's explicit requirement for this plan. With Task 4b + `captureStepState: true` on scenario 030, all nine variants reachable from its seed are asserted end-to-end; sibling scenario 035 covers the tenth (`progress/log_prompt`, which requires a mutually exclusive seed).
  **Date:** 2026-04-11

- **Decision:** A dedicated regression-lock scenario (036) is added for the second audit outcome proposal 003 explicitly names at `docs/design-docs/proposals/003-freeform-conversation-layer.md:755`: "user drills into day detail then back — returns to day detail or to week overview?".
  **Rationale:** The earlier revision of this plan left this audit outcome uncovered on the reasoning that scenario 030 already walked through `dd_<date>` and therefore exercised day-detail rendering. Review caught that this confuses two things: scenario 030 verifies the navigation-state TRACKING (that `lastRenderedView` is set correctly during the walk), but NOT the back-button LANDING behavior (that tapping "← Back to week" from day detail routes the user back to week overview). The back-button behavior is hardcoded at `src/telegram/keyboards.ts:354` (`kb.text('← Back to week', 'wo_show')`), and Plan 027's scope guard at the top of this plan explicitly says keyboards are not modified — but proposal 003's verification contract still expects a scenario locking in the current user-visible outcome. Scenario 036 is the minimal fix: a 4-step walk (my_plan → wo_show → dd_<date> → wo_show) with `captureStepState: true`, asserting that `sessionAt[3].lastRenderedView.view === 'week_overview'`. When Plan C introduces dispatcher-driven back-button routing and changes the target, this scenario's regeneration produces a focused, visible diff against the v0.0.5 baseline — which is the entire point of an audit regression lock. The scenario parallels scenario 031 (the regression lock for proposal 003's first explicitly-named audit outcome) in shape, cost, and purpose, and is sited in Task 15 alongside 030/035 because it's a navigation scenario, not a planFlow-clearing scenario.
  **Date:** 2026-04-11

- **Decision:** Scenario 030's events now end with `📊 Progress` + `pg_last_report` (not the earlier draft's `click('na_show')` step 11), and today's measurement is seeded so the progress menu takes the "already logged today" branch.
  **Rationale:** Review of the first-revision draft found that the earlier "terminate on `click('na_show')`" plan left `progressFlow` stuck in `phase: 'awaiting_measurement'` as an odd test termination state and sent a callback that was only reachable by scrolling back to an older message's inline keyboard. Restructuring scenario 030 to terminate on `pg_last_report` (with today's measurement pre-logged so the previous step's reply has `progressReportKeyboard` attached) solves both problems: `pg_last_report` is reachable via that keyboard, `progressFlow` is cleanly `null` after the "already logged today" branch, and the two progress variants (`weekly_report` at step 10 via the menu handler's already-logged branch, and `weekly_report` again at step 11 via the `pg_last_report` handler) exercise both call sites that should set `weekly_report`. The one variant this seed cannot reach — `progress/log_prompt`, which requires NO today measurement — is covered by sibling scenario 035.
  **Date:** 2026-04-11

- **Decision:** The `planFlow`-clear audit is exhaustive for every **user-reachable** path — uncovered reachable sites get a dedicated zero-LLM scenario (032/033), and audit site #9 (`plan_cancel` button callback) is flagged as dead code.
  **Rationale:** Proposal 003 at `docs/design-docs/proposals/003-freeform-conversation-layer.md:480` is explicit: "The implementation plan must list every site, decide whether to preserve or clear, and add scenario tests for each path." The earlier draft of this plan argued that authoring scenarios for one-line clears was "noise per CLAUDE.md's new-scenario-not-needed rule". That argument is defensible as a general debugging heuristic but is overridden here by the design doc's specific requirement — design commitments beat general heuristics when they conflict. The first draft also contained a factual error in the audit table's row #2 ("Not exercised by any scenario today" for `/cancel` was wrong — scenario 012 uses `command('cancel')` after `plan_replan_confirm`). That row is now corrected, and two new scenarios (032 `discard_recipe`, 033 `re_`) close the reachable gap. A third scenario (034 `plan_cancel-button-audit`) was drafted but subsequently removed: `planProposalKeyboard` at `src/telegram/keyboards.ts:263-264` exposes ONLY `plan_approve` (the cancel button was removed in Plan 025's mutation-text rework), so the `plan_cancel` handler at `src/telegram/core.ts:601` is unreachable from any real user action. Proposal 003's "scenarios for each path" requirement is about paths users can take, not internal code branches — sending a callback directly from the harness would lock in dead code, which is the opposite of the intent. Audit row #9 now flags this as dead code; when a future plan either re-exposes a cancel button or deletes the handler, that plan adds the scenario or the deletion. Every scenario that IS added is zero-LLM, ~50 lines, targets a single clear path, and asserts the post-clear session state as a regression lock so Plan C or Plan D's eventual behavior changes produce clean diffs against a documented baseline.
  **Date:** 2026-04-11

---

## Validation

After every task: `npm test` stays green (or red only in ways explicitly expected by the task — see Task 5's intermediate-red note). After Task 18, all of these must be true:

- Every unit test added by this plan passes: the twelve `setLastRenderedView` variant tests from Task 4.
- `npx tsc --noEmit` reports no errors.
- `npm test` passes with a scenario count equal to Task 1's baseline **+ 6 new scenarios** (030 walkthrough with per-step assertions, 031 shopping-list audit, 032 discard_recipe audit, 033 recipe-edit audit, 035 progress log_prompt sibling, 036 day-detail back-button audit) **+ regenerated scenarios for navigation-ending flows** (018, 019, 022, 029, 015, 016 at minimum; plus any others Task 13's run caught). Scenario 012 (`rolling-replan-abandon`) does NOT need regeneration despite the `/cancel` extension — it walks `/start → 📋 Plan Week → plan_replan_confirm → /cancel`, and none of those events ever set `lastRenderedView` (the replan prompt and breakfast prompt are flow progressions, not navigation renders), so the new clear in `/cancel` is a no-op in this scenario and `JSON.stringify` drops the undefined field. Note: scenario 034 was drafted but removed — `plan_cancel` is dead code after Plan 025.
- `src/telegram/navigation-state.ts` exists and exports exactly three symbols: `LastRenderedView` (type), `NavigationSessionSlice` (type), `setLastRenderedView` (function).
- `grep -n "setLastRenderedView(" src/telegram/core.ts` returns exactly **12 call sites** (the list enumerated in Task 12 Step 2, which includes the Task 8b free-text recipe lookup site in addition to the 11 handler call sites).
- `grep -n "surfaceContext = 'plan'" src/telegram/core.ts` returns **exactly two** remaining hits: (a) the plan-view callbacks branch initializer at `src/telegram/core.ts:673` (which sets `surfaceContext` BEFORE the `na_show`/`wo_show`/`dd_` sub-branches and is a redundant-but-harmless initializer — the helper calls in Tasks 5/6 also set it, but the line stays to avoid diff churn), and (b) the `plan_week` menu case at `src/telegram/core.ts:946` (which is an entry point to the planning FLOW, not a navigation render — it replies with the breakfast prompt which is a flow-progression message, so `setLastRenderedView` is deliberately NOT called here per Task 12's "MUST NOT" list, but `surfaceContext` is still set manually because the user is conceptually on the plan surface as soon as they tap Plan Week). The `my_plan` menu case (formerly at line 911) and the `progress` menu case no longer set `surfaceContext` directly — Tasks 10 and 11 removed those assignments in favor of the `setLastRenderedView` helper. Removing either of the remaining two lines would be a cosmetic cleanup outside Plan 027's scope.
- `grep -n "session.surfaceContext = 'shopping'" src/telegram/core.ts` returns **exactly one** remaining hit: inside the `shopping_list` menu case (`src/telegram/core.ts:996`), which is the defensive initializer BEFORE the conditional clear of `planFlow` and the delegation to `sl_next`. The `sl_next` handler will set it via `setLastRenderedView`, so this early-setter is redundant — but removing it is outside Plan 027's scope (the audit decision is "leave the shopping_list case alone").
- `grep -n "session.lastRenderedView = undefined" src/telegram/core.ts` returns **exactly three** hits: one in `reset()`, one in the `/start` handler (Task 3 Step 3b), and one in the `/cancel` handler (Task 3 Step 3c).
- `finalSession.lastRenderedView` is present and correctly populated in the recording for scenario 030 (`{ surface: 'progress', view: 'weekly_report' }` — terminal is step 11's `pg_last_report`), scenario 035 (`{ surface: 'progress', view: 'log_prompt' }` — single-step terminal), AND for every regenerated navigation-ending scenario from Task 13.
- `finalSession.planFlow === null` in the recording for scenario 031 (shopping-list audit) and scenario 033 (recipe-edit audit).
- `finalSession.recipeFlow === null` in the recording for scenario 032 (discard_recipe audit).
- Scenario 030 asserts all nine variants reachable from its seed via `finalSession.sessionAt[0..10]`. Scenario 035 asserts the tenth variant (`progress/log_prompt`) as its single terminal. Together they give end-to-end scenario coverage for every `LastRenderedView` variant the union currently defines.
- Scenario 036 asserts via `sessionAt[3].lastRenderedView === { surface: 'plan', view: 'week_overview' }` that tapping the hardcoded "← Back to week" button in `dayDetailKeyboard` routes the user back to week overview. This satisfies proposal 003's second explicitly-named audit outcome ("user drills into day detail then back — returns to day detail or to week overview?"). If this assertion fails in a future plan, Plan C's back-button refactor produced a visible diff — the whole point of the regression lock.
- `docs/product-specs/ui-architecture.md` contains a "Navigation state (Plan 027)" section listing all ten variants.
- `docs/product-specs/testing.md` contains (a) an extended "What the tests assert" list that mentions the opt-in fourth `sessionAt` assertion, (b) an "Opt-in per-step session capture" subsection explaining `captureStepState: true`, and (c) the "Asserting on `lastRenderedView`" note. Future agents reading testing.md should be able to discover per-step assertions without needing to trace back to Plan 027.
- `test/scenarios/index.md` lists scenarios 030, 031, 032, 033, 035, and 036.
