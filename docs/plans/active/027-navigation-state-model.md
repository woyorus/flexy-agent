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

- `test/scenarios/030-navigation-state-tracking/spec.ts` — A driven scenario that walks the user through every major render surface in sequence (my_plan → week_overview → day_detail → cook_view → recipe list → recipe view → shopping list next_cook → shopping list day-scoped → progress → back to plan) and whose recorded `finalSession.lastRenderedView` verifies the final state is set correctly. No LLM calls (seeded plan + batches).

- `test/scenarios/030-navigation-state-tracking/recorded.json` — Generated via `npm run test:generate`. Committed together with the spec.

- `test/scenarios/031-shopping-list-mid-planning-audit/spec.ts` — A regression-lock scenario that starts a planning flow, progresses to the `proposal` phase, taps 🛒 Shopping List via the main menu, and asserts that **today's behavior** holds: the shopping list renders (using the active plan) AND `planFlow` is cleared (matching the current conditional-clear at `src/telegram/core.ts:1000`). This locks in the audit decision "leave alone" so a later plan that changes this to preserve `planFlow` will show a clean regen diff.

- `test/scenarios/031-shopping-list-mid-planning-audit/recorded.json` — Generated via `npm run test:generate`. Committed.

**No scenario 032.** The broader audit coverage (every other `planFlow`-clear site) is satisfied by existing scenarios, not by new ones — see Task 14's coverage-mapping table where every site is paired with either an existing covering scenario or the new 031. Authoring a per-site scenario for sites whose decision is "leave alone" and whose path is already exercised would be noise per CLAUDE.md's "when a new scenario is NOT needed" rule.

**Files to modify:**

- `src/telegram/core.ts` — Add `lastRenderedView?: LastRenderedView` to the `BotCoreSession` interface (`src/telegram/core.ts:183`). Import and call `setLastRenderedView` from every render call site listed in Task 5. Update `reset()` (`src/telegram/core.ts:1343`) to clear the new field. Update the factory initializer (`src/telegram/core.ts:225`) — nothing to do there because the field is optional, but Task 3 will confirm.

- `docs/product-specs/ui-architecture.md` — Update the "surface context" section (or add a new "Navigation state" subsection) to document the `LastRenderedView` model, the list of variants, and the contract "every render call site must update `lastRenderedView` via `setLastRenderedView`". Mention explicitly that back-button destinations remain hardcoded in v0.0.5 Plan B; Plan C will start reading `lastRenderedView` to compute dynamic back targets.

- `docs/product-specs/testing.md` — Add a one-paragraph note that when authoring scenarios that exercise navigation, the recorded `finalSession.lastRenderedView` is the authoritative assertion for "what the user was last looking at". This is short — the existing testing doc already explains the `finalSession` JSON round-trip.

- `test/scenarios/index.md` — Add rows for scenarios 030, 031, and (if kept) 032.

- `recorded.json` files for existing scenarios whose last emitted output is a navigation render — these will pick up the new `lastRenderedView` field in their `finalSession`. The candidate list, ordered by cost to regenerate (cheapest first):
  - **Cheap (no LLM fixtures)**: `test/scenarios/018-plan-view-navigation/recorded.json`, `test/scenarios/019-shopping-list-tiered/recorded.json`, `test/scenarios/015-progress-logging/recorded.json`, `test/scenarios/016-progress-weekly-report/recorded.json`, `test/scenarios/017-free-text-fallback/recorded.json`, `test/scenarios/022-upcoming-plan-view/recorded.json`, `test/scenarios/029-recipe-flow-happy-path/recorded.json`.
  - **Expensive (LLM fixtures exist)**: Scenarios 001–014 and 020–028 use LLM fixtures but **most end inside the planning flow** (at plan_approve's post-confirmation render, or at plan_cancel, or mid-proposal), which means `lastRenderedView` never gets set in those flows (plan-flow phase transitions are NOT navigation renders — they're flow progressions, and Task 5 explicitly does NOT instrument them). Task 13 runs `npm test` and consumes the failure list to determine exactly which recordings need regeneration. Manual JSON patches are only applied when the test-failure diff is "trivially a missing null" or similar; anything more complex gets a full regeneration with behavioral review.

**Files NOT modified (deliberate scope guard):**

- `src/telegram/keyboards.ts` — **No changes.** Back-button callbacks (`na_show`, `wo_show`, `recipe_back`, `sl_next`) stay hardcoded in v0.0.5 Plan B. Plan C (dispatcher) will introduce dynamic back computation.
- `src/state/machine.ts`, `src/state/store.ts` — No changes. `LastRenderedView` lives in **in-memory** `BotCoreSession` only, not in the persistent `SessionState`. The store never sees it. Bot restarts drop in-progress navigation context, same as they drop `planFlow` and `recipeFlow` today (see proposal 003 Out of scope — "Session state persistence across bot restarts" is v0.1.0 work).
- `src/agents/plan-flow.ts`, `src/agents/recipe-flow.ts`, `src/agents/progress-flow.ts` — No changes. Flow states stay unchanged. Navigation state is orthogonal.
- `src/telegram/bot.ts` (grammY adapter) — No changes. The adapter just forwards updates to `core.dispatch`; it never touches navigation state directly.
- `src/harness/test-store.ts` — No changes. `LastRenderedView` is not persisted, so the store snapshot is unaffected. The harness captures `finalSession` via a separate JSON round-trip on `core.session` (`src/harness/runner.ts:130`), which automatically picks up the new field because `JSON.stringify` walks the whole object.

### Task order rationale

Tasks run strictly top-to-bottom.

- Tasks 1–4 add the foundational type + helper + session field + unit test so the rest of the plan has something to call.
- Tasks 5–12 thread the helper through every existing render site. Each is a small, surgical edit. They are grouped by file region (callback handlers, menu handlers, post-confirmation, progress) to minimize jumping around `core.ts`.
- Task 13 regenerates scenario recordings affected by the new `finalSession` field.
- Task 14 is the planFlow-clear audit: documentation + regression-lock scenarios. This task is last among code tasks so it can reference the final state of `core.ts` after Tasks 5–12.
- Tasks 15–16 are the new navigation-tracking scenarios (030 for the positive path, 031 for the audit lock-in).
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
Expected: `029-recipe-flow-happy-path` is the highest today. New scenarios will be 030, 031, (032 if kept).

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

### Task 3: Add `lastRenderedView` field to `BotCoreSession` and update `reset()`

**Files:**
- Modify: `src/telegram/core.ts:183-201` (interface)
- Modify: `src/telegram/core.ts:1343-1351` (reset function)
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
git commit -m "Plan 027: add lastRenderedView field to BotCoreSession"
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
- [ ] Line ~1110 (near `showRecipeList` reply) — Task 9
- [ ] Line ~924 (near `my_plan` reply) — Task 10
- [ ] Line ~1028 (near `progress`/`already logged` reply) — Task 11
- [ ] Line ~1043 (near `progress`/`log_prompt` reply) — Task 11
- [ ] Line ~658 (near `pg_last_report` reply) — Task 11

That is **eleven** call sites instrumented across Tasks 5–11. (Plus one implicit one inside `showRecipeList` that fans out to five callers.) If any of the above is missing a `setLastRenderedView` call, jump back to the responsible task and fix it.

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
| 1 | `src/telegram/core.ts:321-327` | `/start` command | Clears `recipeFlow`, `planFlow`, `progressFlow`, `pendingReplan`, `surfaceContext`, `lastRecipeSlug` | **Leave alone.** Total reset on `/start` is correct and unrelated to freeform navigation. | Exercised implicitly by every scenario (harness `reset()` mirrors `/start`); scenario 017 (`free-text-fallback`) uses `/start` directly. |
| 2 | `src/telegram/core.ts:333-340` | `/cancel` command | Clears `recipeFlow`, `planFlow`, `progressFlow`, `pendingReplan` (leaves `surfaceContext`) | **Leave alone.** Explicit cancel is a clean exit. | Not exercised by any scenario today. Per CLAUDE.md's "new scenario is NOT needed" rule, no new scenario is authored here because the decision is "leave alone" and the behavior is a one-line clear. If a later plan changes `/cancel` semantics, that plan adds the scenario. |
| 3 | `src/telegram/core.ts:363` | `save_recipe` callback | Clears `recipeFlow` only (leaves `planFlow`) | **Leave alone.** Already preserves `planFlow` — matches the freeform-model intent. | Covered by scenario 029 (`recipe-flow-happy-path`) which ends at `save_recipe`. |
| 4 | `src/telegram/core.ts:386` | `discard_recipe` callback | Clears `recipeFlow` only | **Leave alone.** Same reasoning. | Not directly exercised by any scenario. Path is symmetric to `save_recipe` (scenario 029); no new scenario needed because the clear logic is a one-line `session.recipeFlow = null;` identical to site #3. |
| 5 | `src/telegram/core.ts:436` | `re_` (recipe edit) callback | Clears `planFlow`, enters edit flow | **Leave alone.** Under today's non-dispatcher model, entering recipe edit from a plan side trip cannot cleanly return to planning, so the clear is defensive. Plan C may revisit this once the dispatcher can route "back to planning" freeform. | Not directly exercised by any scenario. Exercising it would require reaching an edit affordance (the recipe-detail view has "Edit this recipe" in its keyboard via `re_<slug>`), which is reachable from scenarios 018/029. A dedicated regression lock is not added in Plan 027 because the decision is "leave alone" AND the clear is defensive; if Plan C changes it, Plan C owns the scenario. |
| 6 | `src/telegram/core.ts:466` | `view_shopping_list` post-plan button | Clears `planFlow`, delegates to `sl_next` | **Leave alone.** This button only appears on the post-plan-confirmation keyboard, at which point `planFlow` is already `null` (set by `plan_approve` at line 572). The clear is defensive. | Covered by scenarios 001 (`plan-week-happy-path`) and others that reach `plan_approve` — `planFlow` is already `null` when this button would be tapped, so the clear is a no-op and the defensive line stays. No new scenario needed. |
| 7 | `src/telegram/core.ts:471-472` | `view_plan_recipes` post-plan button | Clears `planFlow`, enters recipe list | **Leave alone.** Same defensive reasoning as #6. | Same as site #6 — `planFlow` is already `null` at this point. No new scenario needed. |
| 8 | `src/telegram/core.ts:572` | `plan_approve` (end of happy path) | Clears `planFlow` after successful persist | **Leave alone.** Canonical clear — the flow is done, its state is no longer needed. | Covered by scenarios 001, 002, 003, 004, 005, 009, 010, 011, 013, 014, 020, 023, 024, 025, 026, 028 — every planning happy-path ends here. Heavily regression-tested. |
| 9 | `src/telegram/core.ts:601` | `plan_cancel` callback inside proposal keyboard | Clears `planFlow`, returns to menu | **Leave alone.** Explicit cancel from the proposal review. | Not directly exercised by any scenario today (scenario 021 uses `metaIntent === 'cancel'` text, not the `plan_cancel` button callback). Gap flagged; the button-tap path is a one-line clear identical to site #13 semantically, so no new scenario is authored in Plan 027. |
| 10 | `src/telegram/core.ts:903-906` | `handleMenu()` entry, ALL menu taps | Clears `recipeFlow` + `progressFlow`, **intentionally leaves `planFlow`** | **Leave alone.** This is the load-bearing "main menu does not nuke planning" pattern. Preserves resume-planning UX. Documented in inline comment (lines 905-906). | Exercised implicitly by every scenario that taps a reply-keyboard button (most of them). Scenario 030 (new) explicitly walks menu taps without losing the absence-of-`planFlow`. |
| 11 | `src/telegram/core.ts:998-1002` | `shopping_list` menu case | **Conditionally** clears `planFlow` if set | **Leave alone — with regression lock.** This is the ONE site proposal 003 explicitly flags as "wrong in some cases". Plan B does NOT change it (no dispatcher yet) but adds scenario 031 to lock in the current behavior so Plan C/D's change shows as a clean diff. | Covered by **new scenario 031** (`shopping-list-mid-planning-audit`) — the regression lock described in this task. |
| 12 | `src/telegram/core.ts:1275` | `metaIntent === 'start_over'` during planFlow text | Clears `planFlow` then restarts | **Leave alone.** Explicit restart is clean. | Covered by scenario 020 (`planning-intents-from-text`) which uses the `start_over` meta-intent mid-proposal. |
| 13 | `src/telegram/core.ts:1283-1286` | `metaIntent === 'cancel'` during planFlow text | Clears `planFlow`, `surfaceContext = null`, returns to menu | **Leave alone.** Explicit cancel. | Covered by scenario 021 (`planning-cancel-intent`) which types "nevermind" mid-proposal. |
| 14 | `src/telegram/core.ts:1343-1351` | `reset()` harness function | Clears everything including Plan 027's `lastRenderedView` (Task 3) | **Leave alone.** Test-harness only. | Exercised implicitly by every scenario's between-run reset. Task 3 extended `reset()` to clear `lastRenderedView`; any scenario that asserts `finalSession.lastRenderedView` independently validates this. |

**Summary of coverage gaps:** Sites #2 (`/cancel` command), #4 (`discard_recipe`), #5 (`re_` recipe edit), and #9 (`plan_cancel` button) have no dedicated scenario today. For Plan B's scope — where every decision is "leave alone" and the clears are all one-line `session.X = null;` assignments — authoring four new scenarios for sites whose behavior is unchanged would be noise per CLAUDE.md's "new scenario is NOT needed" rule ("For code cleanups, refactors, renames, typo fixes, and bug fixes well-covered by existing scenarios, `npm test` alone is the verification"). When Plan C or D decides to change any of these, the responsible plan will add the scenario alongside the change so the diff is clean and focused.

**Files:**
- Create: `test/scenarios/031-shopping-list-mid-planning-audit/spec.ts`
- Create: `test/scenarios/031-shopping-list-mid-planning-audit/recorded.json` (generated)
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

---

### Task 15: New scenario 030 — navigation state tracking across every surface

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
 * Part of Plan 027 (Navigation state model). Exercises every `LastRenderedView`
 * variant currently reachable via callbacks and menu taps, ending with a
 * specific terminal view whose `finalSession.lastRenderedView` asserts the
 * round-trip worked.
 *
 * The scenario walks (in order):
 *   1. 📋 My Plan      → `{ surface: 'plan', view: 'next_action' }`
 *   2. wo_show         → `{ surface: 'plan', view: 'week_overview' }`
 *   3. dd_2026-04-09   → `{ surface: 'plan', view: 'day_detail', day: '2026-04-09' }`
 *   4. cv_<batchId>    → `{ surface: 'cooking', view: 'cook_view', batchId, recipeSlug }`
 *   5. 📖 My Recipes   → `{ surface: 'recipes', view: 'library' }`
 *   6. rv_<slug>       → `{ surface: 'recipes', view: 'recipe_detail', slug }`
 *   7. recipe_back     → `{ surface: 'recipes', view: 'library' }`
 *   8. 🛒 Shopping List → `{ surface: 'shopping', view: 'next_cook' }`
 *   9. sl_2026-04-09   → `{ surface: 'shopping', view: 'day', day: '2026-04-09' }`
 *  10. 📊 Progress     → `{ surface: 'progress', view: 'log_prompt' }`  (no existing measurement)
 *  11. na_show         → `{ surface: 'plan', view: 'next_action' }`  (terminal assertion)
 *
 * Final `lastRenderedView` is the `next_action` variant from step 11. The
 * intermediate values are verified indirectly: each step's captured output
 * (keyboard + text) must match the recorded expected output, which depends
 * on the correct `surfaceContext` being set by the helper.
 *
 * Clock: 2026-04-08T10:00:00Z (active_mid, same as scenario 018).
 * Seed: same active plan + batches as scenario 018 so the batch IDs are
 *       stable and the plan views render predictably.
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

export default defineScenario({
  name: '030-navigation-state-tracking',
  description:
    'Navigation state: walks through every render surface (plan subviews, cook view, shopping scopes, recipe library/detail, progress) and verifies lastRenderedView updates correctly at each step.',
  clock: '2026-04-08T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [activeSession],
    batches: activeBatches,
  },
  events: [
    text('📋 My Plan'),                                                  // step 1 — plan/next_action
    click('wo_show'),                                                     // step 2 — plan/week_overview
    click('dd_2026-04-09'),                                               // step 3 — plan/day_detail
    click('cv_batch-030-lunch2-0000-0000-000000000003'),                  // step 4 — cooking/cook_view
    text('📖 My Recipes'),                                                // step 5 — recipes/library
    click('rv_chicken-black-bean-avocado-rice-bowl'),                     // step 6 — recipes/recipe_detail
    click('recipe_back'),                                                 // step 7 — recipes/library (again)
    text('🛒 Shopping List'),                                             // step 8 — shopping/next_cook
    click('sl_2026-04-09'),                                               // step 9 — shopping/day
    text('📊 Progress'),                                                  // step 10 — progress/log_prompt
    click('na_show'),                                                     // step 11 — plan/next_action (terminal)
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
10. **📊 Progress** — Log prompt text ("Drop your weight...") + no keyboard (progress prompt is plain text).
11. **na_show** — Next Action view again (terminal).

**Verify `finalSession.lastRenderedView`** in the recording: it MUST be `{ surface: 'plan', view: 'next_action' }` because step 11 is the last render. If it's anything else (e.g., stuck on progress), Task 10 or 11 has a bug.

**Verify `finalSession.surfaceContext`**: MUST be `'plan'` for the same reason.

**Verify `finalSession.planFlow`**: MUST be `null` — scenario 030 never starts a planning flow.

**Verify `finalSession.lastRecipeSlug`**: the last recipe touched was either in the recipe-view at step 6 (`'chicken-black-bean-avocado-rice-bowl'`, set by `rv_`) or the cook view at step 4 (`'ground-beef-rigatoni-bolognese'`, set by `cv_`). Whichever was set later wins. Walking the scenario: step 4 sets cook view slug, step 6 sets rv_ slug. Step 7 is `recipe_back` which calls `showRecipeList()` — does NOT touch `lastRecipeSlug`. Steps 8–11 don't touch it either. So the final value is `'chicken-black-bean-avocado-rice-bowl'` from step 6. Confirm this in the recording.

**Verify `finalSession.recipeListPage`**: should be `0` (never paged).

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all scenarios green.

- [ ] **Step 5: Commit**

```bash
git add test/scenarios/030-navigation-state-tracking/
git commit -m "Plan 027: add scenario 030 — navigation state tracking across every surface"
```

---

### Task 16: Update `test/scenarios/index.md`

**Files:**
- Modify: `test/scenarios/index.md`

- [ ] **Step 1: Append new rows to the scenario table**

In `test/scenarios/index.md`, add these rows at the bottom of the table (after scenario 029):

```markdown
| 030 | navigation-state-tracking | Navigation state model: walks through every render surface (plan subviews, cook view, shopping scopes, recipe library/detail, progress) and verifies lastRenderedView updates correctly at each step. Plan 027. |
| 031 | shopping-list-mid-planning-audit | Regression lock: user starts next-week planning, taps 🛒 Shopping List — planFlow is cleared (current behavior, Plan 027 leaves alone), shopping list of the ACTIVE plan renders. Locks in the audit decision for future freeform-model work. |
```

- [ ] **Step 2: Commit**

```bash
git add test/scenarios/index.md
git commit -m "Plan 027: update scenarios index with 030 and 031"
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

In `docs/product-specs/testing.md`, find the section about scenario assertions (`finalSession` / `finalStore`). Add a short paragraph:

```markdown
### Asserting on `lastRenderedView` (Plan 027)

Scenarios that exercise navigation can assert on `finalSession.lastRenderedView`
to verify what the user was last looking at. The field is a discriminated union
defined in `src/telegram/navigation-state.ts`; the variant recorded at the end
of a scenario should match the last navigation render the scenario's events
produced. See scenario 030 (`navigation-state-tracking`) for the canonical
positive-path example and scenario 031 (`shopping-list-mid-planning-audit`)
for a regression lock that exercises the planFlow-clear audit decisions
from Plan 027.
```

- [ ] **Step 4: Typecheck and test**

Run: `npx tsc --noEmit`
Expected: no errors (docs changes don't affect the type graph).

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/product-specs/ui-architecture.md docs/product-specs/testing.md
git commit -m "Plan 027: sync ui-architecture.md and testing.md with navigation state model"
```

---

### Task 18: Final baseline

**Files:** none modified — baseline check only.

- [ ] **Step 1: Run the full test suite one final time**

Run: `npm test`
Expected: PASS. Same test count as Task 1's baseline plus the new unit tests from Task 4 and the new scenarios from Tasks 14 and 15 (roughly +12 unit tests and +2 scenarios). Some existing scenarios may have been regenerated in Task 13 with updated `lastRenderedView` fields.

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
- [ ] Task 3 — Add `lastRenderedView` field to `BotCoreSession` + update `reset()`
- [ ] Task 4 — Unit test `setLastRenderedView` against every variant
- [ ] Task 5 — Instrument `na_show`, `wo_show`, `dd_` plan-subview handlers
- [ ] Task 6 — Instrument `cv_` cook-view handler
- [ ] Task 7 — Instrument `sl_` shopping-list handler (both scopes)
- [ ] Task 8 — Instrument `rv_` recipe-view handler
- [ ] Task 9 — Instrument `showRecipeList` chokepoint
- [ ] Task 10 — Instrument `my_plan` menu handler
- [ ] Task 11 — Instrument `progress` menu + `pg_last_report`
- [ ] Task 12 — Verification checklist: instrumented vs. not
- [ ] Task 13 — Regenerate affected scenario recordings
- [ ] Task 14 — PlanFlow-clear audit + scenario 031 regression lock
- [ ] Task 15 — New scenario 030 — navigation state tracking across every surface
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

---

## Validation

After every task: `npm test` stays green (or red only in ways explicitly expected by the task — see Task 5's intermediate-red note). After Task 18, all of these must be true:

- Every unit test added by this plan passes: the twelve `setLastRenderedView` variant tests from Task 4.
- `npx tsc --noEmit` reports no errors.
- `npm test` passes with a scenario count equal to Task 1's baseline **+ 2 new scenarios** (030 and 031) **+ regenerated scenarios for navigation-ending flows** (018, 019, 022 at minimum; plus any others Task 13's run caught).
- `src/telegram/navigation-state.ts` exists and exports exactly three symbols: `LastRenderedView` (type), `NavigationSessionSlice` (type), `setLastRenderedView` (function).
- `grep -n "setLastRenderedView(" src/telegram/core.ts` returns exactly **11 call sites** (the list enumerated in Task 12 Step 2).
- `grep -n "surfaceContext = 'plan'" src/telegram/core.ts` returns NO duplicates left over from Tasks 10 and 11 (`my_plan` menu and `progress` menu no longer set `surfaceContext` directly). Any remaining references are inside the plan-view callbacks branch (`src/telegram/core.ts:673`), which stays because it sets `surfaceContext` BEFORE the sub-branches and is a redundant-but-harmless initializer — removing it would be a cosmetic cleanup outside Plan 027's scope.
- `grep -n "session.surfaceContext = 'shopping'" src/telegram/core.ts` returns **exactly one** remaining hit: inside the `shopping_list` menu case (`src/telegram/core.ts:996`), which is the defensive initializer BEFORE the conditional clear of `planFlow` and the delegation to `sl_next`. The `sl_next` handler will set it via `setLastRenderedView`, so this early-setter is redundant — but removing it is outside Plan 027's scope (the audit decision is "leave the shopping_list case alone").
- `finalSession.lastRenderedView` is present and correctly populated in the recording for scenario 030 AND for every regenerated navigation-ending scenario from Task 13.
- `finalSession.planFlow === null` in the recording for scenario 031 (the audit regression lock).
- `docs/product-specs/ui-architecture.md` contains a "Navigation state (Plan 027)" section listing all ten variants.
- `docs/product-specs/testing.md` contains the "Asserting on `lastRenderedView`" note.
- `test/scenarios/index.md` lists scenarios 030 and 031.
