# Plan 012: Phase 0 — Shared Infrastructure

**Status:** Active
**Date:** 2026-04-07
**Affects:** `src/plan/helpers.ts` (NEW), `src/telegram/keyboards.ts`, `src/telegram/core.ts`, `src/agents/plan-flow.ts`, `src/models/types.ts`, `src/state/store.ts`, `src/harness/test-store.ts`

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
- If `session.planFlow` is non-null **and `session.planFlow.phase !== 'confirmed'`**, return `'planning'`. (A confirmed planFlow is stale — it should have been cleared by `handleApprove`. Treat it as no active flow.)
- Call `store.getRunningPlanSession(today)`. If null, return `'no_plan'`.
- Compute horizon position: `daysSinceStart = dateDiffDays(today, runningSession.horizonStart)`, `daysUntilEnd = dateDiffDays(runningSession.horizonEnd, today)`.
- All lifecycle stages use **horizon position** (today relative to horizonStart/horizonEnd), NOT confirmation age. Per the backlog, a plan confirmed on Saturday for next Monday starts as `active_early` on Monday, not on Saturday.
- Lifecycle boundaries (from backlog lines 26-28). **Evaluation order: check `active_ending` first** (it takes priority when days overlap), then `active_early`, then `active_mid` as default. Boundaries are designed for 7-day horizons (`daysSinceStart + daysUntilEnd = 6`):
  - `active_ending`: `daysUntilEnd <= 1` (1-2 days remaining). **Checked first.**
  - `active_early`: `daysSinceStart <= 1` (day 0 or day 1).
  - `active_mid`: default for all other days (effectively `daysSinceStart >= 2`).

Include a pure `dateDiffDays(a: string, b: string): number` helper (difference in calendar days, `a - b`).

**Important:** `getRunningPlanSession()` currently hardcodes `new Date().toISOString().slice(0, 10)` (UTC) at `store.ts:192`. This can diverge from the local `today` passed to `getPlanLifecycle()` near midnight in UTC+1/+2. To fix, change the store method signature to `getRunningPlanSession(today?: string)` — if provided, use it for the date filter; if omitted, fall back to the current behavior. Update both `StateStore` and `TestStateStore`. This ensures the lifecycle function and the store agree on what "today" means.

**Plan data helpers** (all pure functions operating on `Batch[]` and a `today` string).

All helpers filter to `status === 'planned'` batches only — cancelled batches (tombstoned by D27 supersede) are excluded. Callers pass raw `Batch[]` from the store; the helpers handle the filter internally. `getServingNumber()` returns `0` if `date` is not in `eatingDays` (defensive — should not happen with correct callers). Helpers gracefully handle empty `eatingDays` arrays by returning `null` from lookup functions.

- `getNextCookDay(batches: Batch[], today: string): { date: string; batches: Batch[] } | null` — finds the earliest cook day (= `eatingDays[0]`) on or after `today`, returns that date and all batches cooking on that date.
- `getCookDaysForWeek(batches: Batch[]): { date: string; batches: Batch[] }[]` — groups all batches by their cook day (`eatingDays[0]`), sorted chronologically.
- `getBatchForMeal(batches: Batch[], date: string, mealType: 'lunch' | 'dinner'): { batch: Batch; isReheat: boolean; servingNumber: number } | null` — finds the batch covering a given date/mealType, with reheat status and serving number.
- `isReheat(batch: Batch, date: string): boolean` — returns `date > batch.eatingDays[0]`.
- `getServingNumber(batch: Batch, date: string): number` — index of `date` in `batch.eatingDays` + 1 (e.g., "serving 2 of 3").
- `getDayRange(batch: Batch): { first: string; last: string } | null` — returns `null` if `eatingDays` is empty (should not happen for valid planned batches, but defensive). Otherwise `{ first: eatingDays[0], last: eatingDays[eatingDays.length - 1] }`.

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

Back-button navigation is deterministic, not stack-based. Each back button has a hardcoded destination — no `previousSurfaceContext` field needed.

**Phase 0 surfaceContext assignments for existing surfaces** (per backlog line 50: "Set `surfaceContext` when entering each surface"):
- `handleMenu('my_recipes')`: set `session.surfaceContext = 'recipes'`.
- `handleMenu('plan_week')`: set `session.surfaceContext = 'plan'`.
- `handleMenu('shopping_list')`: set `session.surfaceContext = 'shopping'`.
- `handleMenu('progress')` / `handleMenu('weekly_budget')`: set `session.surfaceContext = 'progress'`.
- `handleCallback` for `rv_` (recipe view): set `session.surfaceContext = 'recipes'` and `session.lastRecipeSlug = recipe.slug`.
- New screen-specific surfaces (cook view → `'cooking'`, etc.) are set in their respective feature phases.
- When entering a non-recipe surface, clear `session.lastRecipeSlug = undefined`.

Update `reset()` (core.ts:869-873) to also clear the new fields:

```ts
function reset(): void {
  session.recipeFlow = null;
  session.planFlow = null;
  session.recipeListPage = 0;
  session.surfaceContext = null;       // NEW
  session.lastRecipeSlug = undefined;  // NEW
  session.pendingReplan = undefined;   // NEW — was already missing from reset
}
```

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

Add a `'progress'` case in the `handleMenu()` switch block (after `'weekly_budget'` case at line 695-696). Use a neutral stub: `'Progress is coming soon.'` (not "No active plan yet" — per ui-architecture, Progress is always available regardless of plan lifecycle). Later phases will implement the real Progress screen.

### Step 5: Fix `handleMenu()` plan flow destruction + planFlow lifecycle cleanup

**5a. Remove unconditional planFlow destruction in `handleMenu()`**

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
  // planFlow is NOT cleared here. It persists until the user
  // explicitly confirms the plan or cancels via /cancel.
```

The `'my_recipes'`, `'shopping_list'`, etc. cases do NOT clear `planFlow` — the user is taking a side trip. They return via [Resume Plan].

**Side-trip text routing contract:** When `planFlow` is preserved during a side trip, `handleTextInput()` (core.ts:713) routes text to `planFlow` first. This is correct — the side trip is menu-based (recipe browsing, shopping list), not text-based. However, the `my_recipes` case at core.ts:650 starts `recipeFlow` when the user has zero recipes and gets "Let's create your first one!" This is the only menu case that starts a text-consuming flow. To handle this:
- When `session.planFlow` is non-null and `session.recipeFlow` is non-null, text routing must check `recipeFlow` first (the user explicitly started recipe creation during a side trip).
- Move the `recipeFlow` check above the `planFlow` check in `handleTextInput()`. Do NOT use the alternative of guarding `planFlow` with `!session.recipeFlow` — that approach has a silent-return bug: `planFlow`'s text handler returns silently for non-text phases (e.g., `'proposal'`), which would swallow the text before `recipeFlow` ever sees it.

**5b. Clear planFlow on plan confirmation**

After `handleApprove()` succeeds (core.ts:487-488), clear planFlow. The `result.state` has `phase: 'confirmed'` but we don't need to keep it — the plan is persisted to the store:

```ts
const result = await handleApprove(session.planFlow, store, recipes, llm);
// Plan is persisted — clear the in-progress flow state.
// getPlanLifecycle() will now return active_* based on the persisted session.
session.planFlow = null;
```

**5c. Clear planFlow on `/cancel` and `/start`**

In `handleCommand()` (core.ts:246-257), add planFlow cleanup to both commands:

```ts
if (command === 'start') {
  session.recipeFlow = null;
  session.planFlow = null;           // NEW: reset all flow state
  session.pendingReplan = undefined;  // NEW
  await sink.reply('Welcome to Flexie! Use the menu below to get started.', {
    reply_markup: await getMenuKeyboard(),
  });
  return;
}
if (command === 'cancel') {
  session.recipeFlow = null;
  session.planFlow = null;           // NEW: clear planning state on cancel
  session.pendingReplan = undefined;  // NEW: clear pending replan too
  await sink.reply('Cancelled.', { reply_markup: await getMenuKeyboard() });
  return;
}
```

**5d. Lifecycle-aware routing for `plan_week` action**

The `'plan_week'` case handles all three lifecycle labels (`Plan Week`, `Resume Plan`, `My Plan`). It must branch by lifecycle — not just by the presence of `planFlow`:

```ts
case 'plan_week': {
  session.surfaceContext = 'plan'; // All plan_week branches are plan surface
  const today = toLocalISODate(new Date());
  const lifecycle = await getPlanLifecycle(session, store, today);

  // Planning in progress → resume where they left off
  if (lifecycle === 'planning' && session.planFlow) {
    const resumeView = getPlanFlowResumeView(session.planFlow);
    await sink.reply(resumeView.text, resumeView.replyMarkup
      ? { reply_markup: resumeView.replyMarkup }
      : undefined);
    return;
  }

  // Active plan → stub placeholder for Next Action (Agent A will implement)
  if (lifecycle.startsWith('active_')) {
    await sink.reply(
      'Your plan is active. Next Action view is coming soon!',
      { reply_markup: await getMenuKeyboard() },
    );
    return;
  }

  // no_plan → check recipe gate, then start new plan
  // Preserve the existing lunchDinnerRecipes.length === 0 gate below.
  // ... existing computeNextHorizonStart logic
}
```

This prevents `[My Plan]` from accidentally starting a new planning flow when a plan is already active. Agent A (Coordinated Agent A — Plan View Screens) will replace the `active_*` stub with the real Next Action screen.

**5e. Add `getPlanFlowResumeView()` to `core.ts`**

Add a helper function inside `createBotCore` (not in `plan-flow.ts`, because it needs access to keyboard constants from `keyboards.ts` and the resume view is a UI concern, not a flow logic concern). `plan-flow.ts` keeps its current contract of returning `{ text, state }` without Telegram UI types.

```ts
function getPlanFlowResumeView(state: PlanFlowState): {
  text: string;
  replyMarkup?: InlineKeyboard | Keyboard;
} { ... }
```

**Prerequisite:** Add a `proposalText?: string` field to `PlanFlowState` (in `plan-flow.ts`). Set it in `handleGenerateProposal()` when the proposal text is generated (the text is currently returned in `FlowResponse.text` but not stored on state). This is needed because the resume view must reconstruct the proposal display without re-running the generator.

Behavior by phase:
- `'context'`: "Planning {weekStart} – {weekEnd}. Breakfast: keep {state.breakfast.name}?" using `state.weekStart` and `state.weekDays[6]`. Keyboard: `planBreakfastKeyboard` (keyboards.ts).
- `'awaiting_events'`: "You're adding events for the week. Send another event or tap Done." Keyboard: `planEventsKeyboard` if `state.events.length === 0`, otherwise `planMoreEventsKeyboard` (keyboards.ts:195 and :200 respectively).
- `'generating_proposal'` / `'generating_recipe'`: "Still working on it…" No keyboard.
- `'recipe_suggestion'`: re-show the recipe gap question using `state.pendingGaps?.[state.activeGapIndex ?? 0]`. Keyboard: `planRecipeGapKeyboard(state.activeGapIndex ?? 0)` (keyboards.ts:213 — 3-button keyboard: Generate it / I have an idea / Pick from my recipes). Returns the first matching batch per date+mealType. The solver guarantees at most one planned batch per slot — multiple matches would indicate data corruption.
- `'awaiting_recipe_prefs'`: "What kind of recipe do you want?" No keyboard (free text).
- `'reviewing_recipe'`: if `state.currentRecipe` exists, re-show it. Keyboard: `planGapRecipeReviewKeyboard` (keyboards.ts:221 — Use it / Different one). If `currentRecipe` is null (edge case — should not happen), fall through to `recipe_suggestion` behavior.
- `'proposal'`: re-show the plan proposal using `state.proposalText`. Keyboard: `planProposalKeyboard` (keyboards.ts — Approve / Swap).
- `'awaiting_swap'`: "Tell me what you'd like to swap." No keyboard (free text).
- `'confirmed'`: should not reach here (handled by the lifecycle guard above).

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

Update the import in core.ts: replace `mainMenuKeyboard` with `buildMainMenuKeyboard` in the import from `./keyboards.js`. Add import for `getPlanLifecycle` and `PlanLifecycle` from `../plan/helpers.js`. Add import for `toLocalISODate` — currently exported from `src/agents/plan-proposer.ts`. Since `toLocalISODate` is a general utility, move it to `src/plan/helpers.ts` and re-export from `plan-proposer.ts` to avoid breaking existing imports.

### Step 7: Add `getBatch(id)` to store + update `getRunningPlanSession(today?)` signature

**`src/state/store.ts`:**

1. Add to `StateStoreLike` interface (after `getBatchesByPlanSessionId` at line 92):
   ```ts
   /** Retrieve a single batch by ID. */
   getBatch(id: string): Promise<Batch | null>;
   ```

2. Update `getRunningPlanSession()` signature in both `StateStoreLike` and `StateStore` to accept an optional `today` parameter:
   ```ts
   // StateStoreLike interface:
   getRunningPlanSession(today?: string): Promise<PlanSession | null>;

   // StateStore implementation:
   async getRunningPlanSession(today?: string): Promise<PlanSession | null> {
     const effectiveToday = today ?? new Date().toISOString().slice(0, 10);
     // ... use effectiveToday instead of the hardcoded date
   }
   ```

3. Add implementation in `StateStore` class (after `getBatchesByPlanSessionId` method at line 270):
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

Update `getRunningPlanSession()` to accept optional `today` parameter (same signature change).

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
 *   dd_  — day detail (payload: ISO date, e.g. dd_2026-04-06)
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
- [ ] Step 5a: Remove unconditional planFlow destruction in `handleMenu()`
- [ ] Step 5b: Clear planFlow on plan confirmation
- [ ] Step 5c: Clear planFlow on `/cancel`
- [ ] Step 5d: Add resume path for `plan_week` action
- [ ] Step 5e: Add `getPlanFlowResumeView()` to `core.ts` + `proposalText` field to `PlanFlowState`
- [ ] Step 6: Update all 15 `mainMenuKeyboard` call sites in core.ts
- [ ] Step 7: Add `getBatch(id)` + update `getRunningPlanSession(today?)` signature
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

- **Decision:** `surfaceContext` is set for existing surfaces in Phase 0 (recipes, plan, shopping stub, progress stub). New screen-specific surfaces (cook view, day detail, etc.) are set in their feature phases.
  **Rationale:** The backlog says "Set `surfaceContext` when entering each surface" in Phase 0 scope. Deferring all assignments would leave downstream features (free-text fallback, navigation) without the contract they depend on. Setting it for surfaces that already exist in core.ts fulfills the backlog requirement while keeping new-screen assignments in their respective phases.
  **Date:** 2026-04-07

- **Decision:** Use `getMenuKeyboard()` async helper instead of passing lifecycle through every function.
  **Rationale:** There are 15 call sites in core.ts that send `mainMenuKeyboard`. Threading a `lifecycle` parameter through every handler would be invasive. A single async helper keeps the diff minimal and the pattern consistent.
  **Date:** 2026-04-07

- **Decision:** "Resume Plan" triggers a resume message rather than re-running the full plan start flow.
  **Rationale:** When `planFlow` exists and the user taps [Resume Plan], we should show where they left off — not restart from scratch. This requires a `getPlanFlowResumeView(state)` export from `plan-flow.ts` that returns the prompt and keyboard appropriate for the current phase. Minimal scope: just enough to remind the user where they are and re-show the current step's keyboard.
  **Date:** 2026-04-07

- **Decision:** `planFlow` is cleared on confirmation and `/cancel`, not left dangling.
  **Rationale:** Review round 1 caught that `handleApprove()` sets `phase = 'confirmed'` but keeps `planFlow` on the session. Since `getPlanLifecycle()` checks `session.planFlow != null`, a stale confirmed flow would make the lifecycle return `'planning'` forever — showing "Resume Plan" instead of "My Plan". Clearing on confirm (in core.ts after `handleApprove`) and on `/cancel` (in `handleCommand`) fixes this.
  **Date:** 2026-04-07

- **Decision:** Text routing prioritizes `recipeFlow` over `planFlow` when both are active.
  **Rationale:** Review round 1 identified that preserving `planFlow` during side trips creates a dual-flow state. The `my_recipes` case can start `recipeFlow` (when zero recipes exist), and `handleTextInput()` currently routes to `planFlow` first. The fix is to check `recipeFlow` before `planFlow` in the text routing, so explicit recipe creation during a side trip works correctly.
  **Date:** 2026-04-07

- **Decision:** `getRunningPlanSession()` accepts an optional `today` parameter.
  **Rationale:** Review round 1 found that the store method hardcodes UTC date while `getPlanLifecycle()` uses local date. Near midnight in UTC+1/+2 (user is in Spain), these diverge. Making the param injectable ensures consistency.
  **Date:** 2026-04-07

- **Decision:** `[My Plan]` (active lifecycle) shows a stub, not the start-new-plan flow.
  **Rationale:** Review round 2 caught that mapping `[My Plan]` to `plan_week` without a lifecycle guard would run `computeNextHorizonStart()` on an active plan — either triggering a replan prompt or starting a duplicate session. The backlog says `active_* → show Next Action screen`. Phase 0 stubs this with a placeholder; Agent A replaces it with the real Next Action view.
  **Date:** 2026-04-07

- **Decision:** `getPlanFlowResumeView()` lives in `core.ts`, not `plan-flow.ts`.
  **Rationale:** Review round 2 identified that `plan-flow.ts` keeps Telegram UI types out of its contract (`FlowResponse` is `{ text, state }`). The resume view needs keyboard constants from `keyboards.ts`. Putting it in `core.ts` (inside `createBotCore`) keeps the UI concern where keyboards already live and avoids leaking Telegram types into the flow module.
  **Date:** 2026-04-07

- **Decision:** Move `toLocalISODate` from `plan-proposer.ts` to `plan/helpers.ts`.
  **Rationale:** `toLocalISODate` is needed by both `getPlanLifecycle()` and `getMenuKeyboard()` in `core.ts`. Currently it's buried in `plan-proposer.ts`. Moving it to the new `plan/helpers.ts` module makes it a proper shared utility. Re-export from `plan-proposer.ts` to avoid breaking existing imports.
  **Date:** 2026-04-07

## Validation

1. **`npm test` passes after regenerating affected scenarios.** The menu label change from "📊 Weekly Budget" to "📊 Progress" will change recorded Telegram outputs in any scenario that captures the main menu keyboard. Scenarios with running/future plan sessions (e.g., scenario 010 with `planSessions: [sessionA]`) may also be affected by lifecycle-driven labels. Adding `surfaceContext: null` to the session will change `finalSession` assertions. **All scenarios must be regenerated** (`npm run test:generate -- <name> --regenerate` for each) and their diffs reviewed to confirm only expected changes: menu label renames, `surfaceContext: null` additions, `finalSession.planFlow` becoming `null` after successful confirmation (Step 5b), and `pendingReplan` clearing. No behavioral regressions beyond these expected structural changes.

2. **Type check passes.** `npx tsc --noEmit` should succeed. `StateStoreLike` gains `getBatch()`, both implementations provide it. `BotCoreSession` gains `surfaceContext` — existing session initialization includes it with `null`.

3. **Manual verification (npm run dev):**
   - Start with no plan: menu shows "Plan Week" and "Progress".
   - Start planning: menu switches to "Resume Plan" and "Progress".
   - Tap [My Recipes] mid-planning: recipe list shows. Tap [Resume Plan]: planning resumes where left off (planFlow not destroyed).
   - Complete a plan: menu shows "My Plan" and "Progress".
   - Tap "Progress": stub message appears (not "Unknown command").

4. **Plan data helpers:** Verified by type-checking. Full behavioral testing deferred to the features that use them (cook view, day detail, etc.).

# Feedback

