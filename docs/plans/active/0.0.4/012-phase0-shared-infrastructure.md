# Plan 012: Phase 0 — Shared Infrastructure

**Status:** Active
**Date:** 2026-04-07
**Affects:** `src/plan/helpers.ts` (NEW), `src/telegram/keyboards.ts`, `src/telegram/core.ts`, `src/models/types.ts`, `src/state/store.ts`, `src/harness/test-store.ts`

## Problem

Multiple v0.0.4 features (Next Action screen, cook view, shopping list, week overview) all need the same foundational pieces:

1. **No lifecycle detection.** Nothing computes whether the user has no plan, is planning, or is in an active plan week. Every downstream feature needs this to decide what to show.

2. **Static main menu.** `mainMenuKeyboard` (keyboards.ts:33) is a `const`. The top-left label is always "Plan Week" and the bottom-right is always "Weekly Budget". The backlog requires lifecycle-driven labels ("Plan Week" / "Resume Plan" / "My Plan") and renaming "Weekly Budget" to "Progress".

3. **Incomplete menu text matching.** `matchMainMenu()` (core.ts:885-893) only recognizes four literal labels. It has no mapping for "Resume Plan", "My Plan", or "Progress".

4. **handleMenu() destroys planFlow unconditionally.** Lines 643-644 of core.ts do `session.recipeFlow = null; session.planFlow = null;` on every menu tap. This means tapping [Resume Plan] (or any other menu button) during an in-progress planning session destroys the session state instead of resuming it.

5. **No surfaceContext on session.** `BotCoreSession` (core.ts:167-173) has `recipeFlow`, `planFlow`, `recipeListPage`, and `pendingReplan` — but no field tracking what screen the user is currently looking at. Downstream features (free-text fallback, back-button navigation, cook view context) all need this.

6. **No plan data helpers.** There is no `src/plan/` directory. Features like cook view, day detail, week overview, and shopping list all need to answer: "What's the next cook day?", "What batches are on day X?", "Is this batch a reheat?", "What serving number is this?".

7. **No single-batch lookup.** `StateStoreLike` (store.ts:44-96) has `getBatchesOverlapping` and `getBatchesByPlanSessionId` but no `getBatch(id)`. The cook view callback `cv_{batchId}` needs to load a single batch by ID.

8. **No callback prefix registry.** Existing prefixes (`rv_`, `rd_`, `re_`, `rp_`) are scattered implicitly. New prefixes (`na_`, `wo_`, `dd_`, `cv_`, `sl_`, `pg_`) need a central index.

Building these independently across features creates merge conflicts and duplicated logic. This plan extracts them as a shared substrate.

## Plan of work

### Step 1: Create `src/plan/helpers.ts` — lifecycle detection + plan data helpers

Create the new file `src/plan/helpers.ts`. This is the only new file in Phase 0.

**Lifecycle detection:**

```ts
export type PlanLifecycle = 'no_plan' | 'planning' | 'active_early' | 'active_mid' | 'active_ending';
```

Function `getPlanLifecycle(session: BotCoreSession, store: StateStoreLike, today: string): Promise<PlanLifecycle>`:
- If `session.planFlow` is non-null, return `'planning'`.
- Call `store.getRunningPlanSession()`. If null, return `'no_plan'`.
- Compute horizon position: `daysSinceStart = dateDiffDays(today, runningSession.horizonStart)`, `daysUntilEnd = dateDiffDays(runningSession.horizonEnd, today)`.
- All lifecycle stages use **horizon position** (today relative to horizonStart/horizonEnd), NOT confirmation age. Per the backlog, a plan confirmed on Saturday for next Monday starts as `active_early` on Monday, not on Saturday.
- Lifecycle boundaries (from backlog lines 26-28):
  - `active_early`: `daysSinceStart <= 1` (day 0 or day 1).
  - `active_mid`: `daysSinceStart >= 2 && daysSinceStart <= 4` (days 2-4).
  - `active_ending`: `daysUntilEnd <= 1` (1-2 days remaining).

Include a pure `dateDiffDays(a: string, b: string): number` helper (difference in calendar days, `a - b`).

**Plan data helpers** (all pure functions operating on `Batch[]` and a `today` string):

- `getNextCookDay(batches: Batch[], today: string): { date: string; batches: Batch[] } | null` — finds the earliest cook day (= `eatingDays[0]`) on or after `today`, returns that date and all batches cooking on that date.
- `getCookDaysForWeek(batches: Batch[]): { date: string; batches: Batch[] }[]` — groups all batches by their cook day (`eatingDays[0]`), sorted chronologically.
- `getBatchForMeal(batches: Batch[], date: string, mealType: 'lunch' | 'dinner'): { batch: Batch; isReheat: boolean; servingNumber: number } | null` — finds the batch covering a given date/mealType, with reheat status and serving number.
- `isReheat(batch: Batch, date: string): boolean` — returns `date > batch.eatingDays[0]`.
- `getServingNumber(batch: Batch, date: string): number` — index of `date` in `batch.eatingDays` + 1 (e.g., "serving 2 of 3").
- `getDayRange(batch: Batch): { first: string; last: string }` — `{ first: eatingDays[0], last: eatingDays[eatingDays.length - 1] }`.

### Step 2: Add `surfaceContext` and `lastRecipeSlug` to `BotCoreSession`

In `src/telegram/core.ts`, extend the `BotCoreSession` interface (line 167):

```ts
export interface BotCoreSession {
  recipeFlow: RecipeFlowState | null;
  planFlow: PlanFlowState | null;
  recipeListPage: number;
  pendingReplan?: { replacingSession: import('../models/types.js').PlanSession };
  // NEW:
  surfaceContext: 'plan' | 'cooking' | 'shopping' | 'recipes' | 'progress' | null;
  lastRecipeSlug?: string;
}
```

Initialize `surfaceContext: null` in the session literal (line 200-204). Initialize `lastRecipeSlug: undefined` (omit from literal, it's optional).

Back-button navigation is deterministic, not stack-based. Each back button has a hardcoded destination — no `previousSurfaceContext` field needed. The actual `surfaceContext` assignments happen in later phases when each screen is implemented. Phase 0 only adds the field and initializes it.

### Step 3: Replace static `mainMenuKeyboard` with `buildMainMenuKeyboard(lifecycle)`

In `src/telegram/keyboards.ts`:

1. Remove the `export const mainMenuKeyboard` (lines 33-38).

2. Add a new function:

```ts
export function buildMainMenuKeyboard(lifecycle: PlanLifecycle): Keyboard {
  const planLabel =
    lifecycle === 'planning' ? '📋 Resume Plan' :
    lifecycle === 'no_plan' ? '📋 Plan Week' :
    '📋 My Plan';

  return new Keyboard()
    .text(planLabel).text('🛒 Shopping List')
    .row()
    .text('📖 My Recipes').text('📊 Progress')
    .resized()
    .persistent();
}
```

Import `PlanLifecycle` from `../plan/helpers.js`.

### Step 4: Update `matchMainMenu()` to recognize all label variants

In `src/telegram/core.ts`, update `matchMainMenu()` (line 885-893):

```ts
function matchMainMenu(text: string): string | null {
  const menuMap: Record<string, string> = {
    '📋 Plan Week': 'plan_week',
    '📋 Resume Plan': 'plan_week',   // NEW — same action, different label
    '📋 My Plan': 'plan_week',       // NEW — same action, different label
    '🛒 Shopping List': 'shopping_list',
    '📖 My Recipes': 'my_recipes',
    '📊 Progress': 'progress',        // NEW — replaces Weekly Budget
    '📊 Weekly Budget': 'weekly_budget', // KEPT as fallback alias during transition
  };
  return menuMap[text] ?? null;
}
```

Add a `'progress'` case in the `handleMenu()` switch block (after `'weekly_budget'` case at line 695-696). For now it can return the same stub message as `weekly_budget`. Later phases will implement the Progress screen.

### Step 5: Fix `handleMenu()` plan flow destruction

In `src/telegram/core.ts`, replace lines 642-644:

**Before:**
```ts
async function handleMenu(action: string, sink: OutputSink): Promise<void> {
  session.recipeFlow = null; // exit any active flow
  session.planFlow = null;
```

**After:**
```ts
async function handleMenu(action: string, sink: OutputSink): Promise<void> {
  session.recipeFlow = null; // exit any recipe flow

  // Only clear planFlow when the action explicitly starts a different flow.
  // When action === 'plan_week' and session.planFlow exists, we resume —
  // not restart. Other actions (my_recipes, shopping_list, etc.) leave
  // planFlow intact so the user can check recipes mid-planning and
  // return via [Resume Plan].
  if (action !== 'plan_week') {
    // Don't destroy planFlow — user might be mid-planning and
    // checking recipes or shopping list as a side trip.
    // planFlow persists until the user explicitly cancels or finishes.
  }
```

Wait — the backlog says (line 45): "only clear planFlow when the action explicitly starts a different flow." But also: "When `action === 'plan_week'` and `session.planFlow` exists, resume the flow instead of restarting."

The correct logic is:
- **Remove** the unconditional `session.planFlow = null` from line 644.
- In the `'plan_week'` case (line 660): if `session.planFlow` is already non-null, resume it (re-display the current phase prompt) instead of calling `computeNextHorizonStart` and starting fresh.
- `planFlow` is only cleared when the planning flow itself completes (plan confirmed) or the user runs `/cancel`.

The `'my_recipes'`, `'shopping_list'`, etc. cases should NOT clear `planFlow` — the user is just taking a side trip. They'll come back via [Resume Plan].

Implementation detail for the `'plan_week'` resume path: when `session.planFlow` exists, we need to re-send the current phase's prompt. The simplest approach is to call the existing plan-flow handler with a synthetic "resume" signal that re-emits the current phase's message. This may require a small addition to `plan-flow.ts` (e.g., `getResumeMessage(state)` that returns the appropriate prompt for the current phase). Scope this narrowly — just enough to show "You're in the middle of planning. [current phase prompt]" when the user taps [Resume Plan].

### Step 6: Update all `mainMenuKeyboard` call sites in core.ts

There are 15 `{ reply_markup: mainMenuKeyboard }` call sites in core.ts. Each must become `{ reply_markup: buildMainMenuKeyboard(lifecycle) }` where `lifecycle` is computed at reply time.

To avoid calling `getPlanLifecycle()` (which is async and hits the store) 15 times per flow, add a helper inside `createBotCore`:

```ts
async function getMenuKeyboard(): Promise<Keyboard> {
  const today = toLocalISODate(new Date());
  const lifecycle = await getPlanLifecycle(session, store, today);
  return buildMainMenuKeyboard(lifecycle);
}
```

Then each call site becomes:
```ts
await sink.reply('...', { reply_markup: await getMenuKeyboard() });
```

Update the import in core.ts: replace `mainMenuKeyboard` with `buildMainMenuKeyboard` in the import from `./keyboards.js`. Add import for `getPlanLifecycle` and `PlanLifecycle` from `../plan/helpers.js`.

### Step 7: Add `getBatch(id)` to store interface and implementations

**`src/state/store.ts`:**

1. Add to `StateStoreLike` interface (after `getBatchesByPlanSessionId` at line 92):
   ```ts
   /** Retrieve a single batch by ID. */
   getBatch(id: string): Promise<Batch | null>;
   ```

2. Add implementation in `StateStore` class (after `getBatchesByPlanSessionId` method at line 270):
   ```ts
   async getBatch(id: string): Promise<Batch | null> {
     const { data, error } = await this.client
       .from('batches')
       .select('*')
       .eq('id', id)
       .single();
     if (error) return null;
     return fromBatchRow(data);
   }
   ```

**`src/harness/test-store.ts`:**

Add implementation in `TestStateStore` class (after `getBatchesByPlanSessionId` method at line 238):
```ts
async getBatch(id: string): Promise<Batch | null> {
  const b = this.batchesById.get(id);
  return b ? cloneDeep(b) : null;
}
```

### Step 8: Add callback prefix registry to keyboards.ts

Add a comment block at the top of `src/telegram/keyboards.ts` (after the file doc comment, before the import on line 15):

```ts
/**
 * Callback data prefix registry.
 *
 * Telegram limits callback data to 64 bytes. All inline keyboard callbacks
 * use short prefixes to maximize space for payload (slugs, IDs, indices).
 *
 * Existing:
 *   rv_  — recipe view (payload: slug)
 *   rd_  — recipe delete (payload: slug)
 *   re_  — recipe edit (payload: slug)
 *   rp_  — recipe page (payload: page number)
 *
 * New (v0.0.4):
 *   na_  — next action (payload: action type)
 *   wo_  — week overview (payload: varies)
 *   dd_  — day detail (payload: day abbreviation, e.g. dd_mon)
 *   cv_  — cook view (payload: batch ID)
 *   sl_  — shopping list (payload: varies)
 *   pg_  — progress (payload: varies)
 */
```

## Progress

- [ ] Step 1: Create `src/plan/helpers.ts` with lifecycle detection + plan data helpers
- [ ] Step 2: Add `surfaceContext` and `lastRecipeSlug` to `BotCoreSession`
- [ ] Step 3: Replace static `mainMenuKeyboard` with `buildMainMenuKeyboard(lifecycle)`
- [ ] Step 4: Update `matchMainMenu()` + add `progress` case in `handleMenu()`
- [ ] Step 5: Fix `handleMenu()` plan flow destruction
- [ ] Step 6: Update all 15 `mainMenuKeyboard` call sites in core.ts
- [ ] Step 7: Add `getBatch(id)` to `StateStoreLike` + both implementations
- [ ] Step 8: Add callback prefix registry comment block to keyboards.ts
- [ ] Final: Run `npm test`, verify existing scenarios pass

## Decision log

- **Decision:** `getPlanLifecycle()` is async and takes `store` as a parameter rather than caching lifecycle on the session.
  **Rationale:** The lifecycle depends on horizon dates relative to today. Caching it on the session would go stale across day boundaries. Computing it fresh for each reply ensures correctness. The store call (`getRunningPlanSession`) is a single-row lookup — fast enough to call per reply.
  **Date:** 2026-04-07

- **Decision:** `planFlow` is NOT cleared when the user taps [My Recipes] or [Shopping List] during planning.
  **Rationale:** The backlog explicitly says "only clear planFlow when the action explicitly starts a different flow." Side trips to recipes or shopping should preserve the planning session. The user returns via [Resume Plan]. This matches the ui-architecture rule "the flow never dies" (Rule 3).
  **Date:** 2026-04-07

- **Decision:** The plan data helpers (`getNextCookDay`, `getCookDaysForWeek`, etc.) are pure functions, not methods on a class.
  **Rationale:** They operate on `Batch[]` arrays already loaded from the store. No need for an object — pure functions are simpler, easier to test, and easier to import. The lifecycle function is the only one that needs the store directly.
  **Date:** 2026-04-07

- **Decision:** `surfaceContext` is added in Phase 0 but only initialized to `null`. Actual assignment at each screen transition happens in the respective feature phases.
  **Rationale:** Phase 0 is infrastructure, not features. Adding the field now prevents merge conflicts when multiple feature PRs land. The field having `null` as its default means existing scenarios are unaffected.
  **Date:** 2026-04-07

- **Decision:** Use `getMenuKeyboard()` async helper instead of passing lifecycle through every function.
  **Rationale:** There are 15 call sites in core.ts that send `mainMenuKeyboard`. Threading a `lifecycle` parameter through every handler would be invasive. A single async helper keeps the diff minimal and the pattern consistent.
  **Date:** 2026-04-07

- **Decision:** "Resume Plan" triggers a resume message rather than re-running the full plan start flow.
  **Rationale:** When `planFlow` exists and the user taps [Resume Plan], we should show where they left off — not restart from scratch. This requires a small `getResumeMessage(state)` addition to `plan-flow.ts` that returns the prompt appropriate for the current phase. Minimal scope: just enough to remind the user where they are and re-show the current step's keyboard.
  **Date:** 2026-04-07

## Validation

1. **`npm test` passes.** All existing scenarios start with `no_plan` lifecycle, so they get "Plan Week" label as before. The `matchMainMenu()` still maps "Plan Week" to `plan_week`. No behavioral change in existing scenarios.

2. **Type check passes.** `npx tsc --noEmit` should succeed. `StateStoreLike` gains `getBatch()`, both implementations provide it. `BotCoreSession` gains `surfaceContext` — existing session initialization includes it with `null`.

3. **Manual verification (npm run dev):**
   - Start with no plan: menu shows "Plan Week" and "Progress".
   - Start planning: menu switches to "Resume Plan" and "Progress".
   - Tap [My Recipes] mid-planning: recipe list shows. Tap [Resume Plan]: planning resumes where left off (planFlow not destroyed).
   - Complete a plan: menu shows "My Plan" and "Progress".
   - Tap "Progress": stub message appears (not "Unknown command").

4. **Plan data helpers:** Verified by type-checking. Full behavioral testing deferred to the features that use them (cook view, day detail, etc.).

# Feedback

