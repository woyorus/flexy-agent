# Plan 016: Coordinated Group — Plan-Aware UI System

**Status:** Active
**Date:** 2026-04-07
**Affects:** `src/telegram/core.ts`, `src/telegram/keyboards.ts`, `src/telegram/formatters.ts`, `src/agents/plan-flow.ts`, `src/agents/recipe-scaler.ts`, `src/recipes/renderer.ts`, `src/shopping/generator.ts`, `src/models/types.ts`, `test/scenarios/*/spec.ts`

## Problem

The confirmed plan is currently a dead end. After tapping "Confirm plan," the user sees "Plan locked for Mon – Sun. Shopping list ready." (plan-flow.ts:722) with two buttons that both lead nowhere useful: `view_shopping_list` replies "Shopping list generation is coming soon!" (core.ts:382), and `view_plan_recipes` dumps to the flat recipe list with no plan context.

There is no way to:
- See what to cook next or browse the week's schedule.
- View a recipe in cook-time mode (batch totals, inline amounts, storage instructions).
- Get a shopping list scoped to the next cook day with breakfast prorated and ingredients intelligently tiered.

Three agents must work in parallel on interconnected surfaces — plan views (A), recipe display (B), and shopping list (C) — sharing `core.ts` dispatch, `keyboards.ts`, `formatters.ts`, and plan data structures. This plan defines the shared contract, per-agent scope, file ownership, cross-agent integration points, and implementation order.

**Dependencies:**
- **Phase 0 (plan 012):** Lifecycle detection (`getPlanLifecycle()`), dynamic `buildMainMenuKeyboard()`, `matchMainMenu()` update, `handleMenu()` fix (no longer destroys `planFlow` on every tap), `surfaceContext` on `BotCoreSession`, plan data helpers (`getNextCookDay()`, `getBatchForMeal()`, `isReheat()`, `getServingNumber()`, `getDayRange()`, `getCookDaysForWeek()`), `getBatch(id)` on `StateStoreLike`, callback prefix registry. ALL THREE AGENTS depend on Phase 0.
- **Isolated Task 2 (plan 014):** Recipe Format Evolution — `shortName` field, `{placeholder}` support in recipe body, step-by-step timing, grouped seasonings in prose. Agent B depends on this for placeholder resolution and `shortName` button labels. Agent B can start library redesign work before Task 2 lands but cannot implement cook-time placeholder resolution until it ships.

---

## Shared contract

Phase 0 delivers the plan data helpers and callback prefix registry. The three agents additionally agree on these integration protocols before starting implementation.

### 1. Cook view entry protocol (Agent B defines, Agent A calls)

- **Callback format:** `cv_{batchId}` where `batchId` is the batch UUID (36 chars). Total callback data: `cv_` prefix (3 chars) + UUID (36 chars) = 39 bytes, within Telegram's 64-byte limit.
- **Why batch ID, not recipe slug:** After Plan 009 re-batching, the same `(recipeSlug, mealType)` pair can appear in multiple batches (see plan-flow.ts:1570-1576 where `days[0]` disambiguates). The batch UUID uniquely identifies which batch to render.
- **Agent B's handler contract:** Receive `cv_{batchId}` callback in `handleCallback()` (core.ts) -> call `store.getBatch(batchId)` (Phase 0) -> load recipe via `recipes.getBySlug(batch.recipeSlug)` -> render cook view with `batch.scaledIngredients`, `batch.eatingDays.length` servings, recipe body with resolved placeholders. Set `surfaceContext = 'cooking'` and `lastRecipeSlug = batch.recipeSlug`.
- **Returns:** Formatted cook-time message + cook view keyboard (`[<- Back to plan]`, `[Edit this recipe]`, `[View in my recipes]`).

### 2. Shopping list entry protocol (Agent C defines, Agent A calls)

- **Callback formats:**
  - `sl_next` — Agent C computes the next cook day via `getNextCookDay()` (Phase 0 helper).
  - `sl_{ISO date}` — Agent C scopes to that specific day's cook session (e.g., `sl_2026-04-10`).
  - Main menu `[Shopping List]` with active plan -> equivalent to `sl_next` (Agent A delegates to Agent C's handler).
- **Agent C's handler contract:** Receive `sl_*` callback -> resolve target date (or compute next cook day) -> get batches for that day from store -> load breakfast recipe from plan session -> generate three-tiered, category-grouped shopping list scoped to that day + prorated breakfast. Set `surfaceContext = 'shopping'`.
- **Returns:** Formatted shopping list message + shopping keyboard (`[<- Back to plan]`).

### 3. Ingredient role propagation (Agent C owns, all agents benefit)

- **Current problem:** `ScaledIngredient` (types.ts:146-152) has only `name`, `amount`, `unit`, `totalForBatch` — no `role`. The shopping generator (generator.ts:58-60) hardcodes all batch ingredients to `'PANTRY'` because it has no role data.
- **Fix:** Add `role: IngredientRole` to `ScaledIngredient` interface. Update three code paths:
  1. `recipe-scaler.ts` output mapping (line 177): post-hoc name-match from LLM output back to `recipe.ingredients[].role`.
  2. `plan-flow.ts` scaler fallback (line 1602): include `role: ing.role` in manual `ScaledIngredient[]` construction.
  3. Test scenario seeds (`test/scenarios/*/spec.ts`): add `role` to every seeded `scaledIngredients` entry.

### 4. File conflict resolution

- `core.ts` and `keyboards.ts` are touched by all three agents. Strategy:
  - Each agent adds handlers in clearly separated, comment-delimited sections.
  - Agent A owns the top-level dispatch routing structure and plan view handlers.
  - Agent B adds `cv_` callback handling and recipe list modifications in its own section.
  - Agent C adds `sl_` callback handling in its own section.
  - Keyboard functions are separate exported functions (e.g., `nextActionKeyboard()`, `cookViewKeyboard()`, `shoppingListKeyboard()`), not modifications to the same function.

---

## Plan of work

### Agent C — ScaledIngredient role enrichment (do first, unblocks all agents)

Agent C's role enrichment work is a prerequisite for all three agents because it changes the `ScaledIngredient` interface and every scenario seed. This sub-task must land first.

#### Step C0.1: Add `role` to `ScaledIngredient` interface

**File:** `src/models/types.ts` (line 146-152)

```typescript
// Current:
export interface ScaledIngredient {
  name: string;
  amount: number;
  unit: string;
  totalForBatch: number;
}

// New:
export interface ScaledIngredient {
  name: string;
  amount: number;
  unit: string;
  totalForBatch: number;
  role: IngredientRole;
}
```

`IngredientRole` is already defined at types.ts:96.

#### Step C0.2: Update recipe-scaler.ts output mapping

**File:** `src/agents/recipe-scaler.ts` (line 176-184)

The LLM's JSON schema (line 90-95) does NOT include `role` — it only returns `name`, `amount`, `unit`, `total_for_batch`. Role must be mapped post-hoc by matching the LLM's returned ingredient name back to `recipe.ingredients[].role`.

After the `parsed.scaled_ingredients.map(...)` at line 177, add role matching:

```typescript
scaledIngredients: parsed.scaled_ingredients.map((ing: Record<string, unknown>) => {
  const name = ing.name as string;
  // Match back to source recipe ingredient to get role.
  // LLM may rename ingredients (e.g., "chicken breast" -> "chicken"),
  // so use case-insensitive substring matching.
  const sourceIng = recipe.ingredients.find(
    (ri) => ri.name.toLowerCase().includes(name.toLowerCase())
      || name.toLowerCase().includes(ri.name.toLowerCase())
  );
  if (!sourceIng) {
    log.warn('SCALER', `no role match for scaled ingredient "${name}" in ${recipe.slug}, defaulting to 'base'`);
  }
  return {
    name,
    amount: ing.amount as number,
    unit: ing.unit as string,
    totalForBatch: ing.total_for_batch as number,
    role: sourceIng?.role ?? 'base',
  };
}),
```

The `recipe` parameter is already in scope (line 58: `const { recipe, ... } = input;`). The `log` import exists at line 26.

#### Step C0.3: Update plan-flow.ts scaler fallback

**File:** `src/agents/plan-flow.ts` (line 1602-1607)

Current fallback when scaler throws:
```typescript
scaledIngredients = recipe.ingredients.map((ing) => ({
  name: ing.name,
  amount: ing.amount,
  unit: ing.unit,
  totalForBatch: ing.amount * eatingDays.length,
}));
```

Add `role: ing.role`:
```typescript
scaledIngredients = recipe.ingredients.map((ing) => ({
  name: ing.name,
  amount: ing.amount,
  unit: ing.unit,
  totalForBatch: ing.amount * eatingDays.length,
  role: ing.role,
}));
```

#### Step C0.4: Update test scenario seeds

**Files:** All `test/scenarios/*/spec.ts` files with `scaledIngredients` arrays (11 files found via grep).

Every seeded `scaledIngredients` entry currently looks like:
```typescript
scaledIngredients: [{ name: 'chicken breast', amount: 190, unit: 'g', totalForBatch: 570 }],
```

Add `role: 'protein'` (or appropriate role matching the ingredient) to each:
```typescript
scaledIngredients: [{ name: 'chicken breast', amount: 190, unit: 'g', totalForBatch: 570, role: 'protein' }],
```

Affected spec files (from grep results):
- `005-rolling-continuous/spec.ts` — 6 batches
- `009-rolling-swap-recipe-with-carryover/spec.ts` — 1 batch
- `010-rolling-events-with-carryover/spec.ts` — 1 batch
- `011-rolling-replan-future-only/spec.ts` — 2 batches
- `012-rolling-replan-abandon/spec.ts` — 1 batch

#### Step C0.5: Regenerate affected scenario recordings

Run `npm run test:generate -- <name> --regenerate` for each affected scenario. The `recorded.json` files will change because the scaler output mapping now includes `role`. Review each diff: only the `scaledIngredients` arrays in persisted batches should change (adding `role` fields). If anything else changes, the blast radius is wider than intended.

Then run `npm test` to confirm all scenarios pass.

---

### Agent A — Plan View Screens + Navigation

**Depends on:** Phase 0 (plan 012) for `getPlanLifecycle()`, `buildMainMenuKeyboard()`, `surfaceContext`, plan data helpers, `getBatch(id)`. Also depends on Agent C's Step C0 (role enrichment) only if running `npm test` — the plan view code itself doesn't read `role`.

#### Step A1: Next Action screen formatter

**File:** `src/telegram/formatters.ts`

Add `formatNextAction(batches, events, flexSlots, today)` function:
- Takes: active plan's `Batch[]`, `MealEvent[]`, `FlexSlot[]`, and today's ISO date.
- Shows today + next 2 days. For each day:
  - Skip breakfast (not shown — fixed, memorized).
  - Lunch line: recipe name + status (cook/reheat/flex/event).
  - Dinner line: recipe name + status.
  - Cook meals get `🔪 Cook {mealType}: **{recipeName}** — {servings} servings` formatting.
  - Reheat meals: `{recipeName} _(reheat)_`.
  - Flex slots: `**Flex** (~{calories} cal)`.
  - Events: `🍽️ {eventName}`.
- Uses Phase 0 helpers: `getBatchForMeal()`, `isReheat()`.
- Returns formatted string.

Reference mock from ui-architecture.md lines 160-171.

#### Step A2: Next Action keyboard

**File:** `src/telegram/keyboards.ts`

Add `nextActionKeyboard(nextCookBatches, hasUpcomingCook)` function:
- If next cook session upcoming: `[🔪 {recipeName} — N servings]` button(s) with `cv_{batchId}` callback + `[Get shopping list]` with `sl_next` callback + `[View full week]` with `wo_show` callback.
- If no upcoming cook: just `[View full week]`.
- Recipe button labels use `shortName ?? name` (depends on Task 2 for `shortName` — fall back to `name` initially).

#### Step A3: Week Overview formatter

**File:** `src/telegram/formatters.ts`

Add `formatWeekOverview(session, batches, events, flexSlots)` function:
- Header: `**Your week:** Mon Apr 6 – Sun Apr 12`
- Breakfast line: `_Breakfast: {breakfastRecipeName} (daily)_`
- For each day: compact format per ui-architecture.md line 208-228:
  - `**Mon** 🔪` (if any cook that day)
  - `L: {name} · D: {name}` with markers (🔪 for cook, 🍽️ for event, **Flex** bold text).
- Footer: `**Weekly target: on track ✓**` (simple status, no calorie numbers).
- Prompt: `_Tap a day for details:_`

#### Step A4: Week Overview keyboard

**File:** `src/telegram/keyboards.ts`

Add `weekOverviewKeyboard()` function:
- Day buttons: `[Mon] [Tue] [Wed] [Thu]` row, `[Fri] [Sat] [Sun]` row.
- Callback data: `dd_{ISO date}` (e.g., `dd_2026-04-06`). The `dd_` prefix is 3 chars + 10-char ISO date = 13 bytes, well within 64-byte limit.
- `[<- Back]` button with callback `na_show` (returns to Next Action).

#### Step A5: Day Detail formatter

**File:** `src/telegram/formatters.ts`

Add `formatDayDetail(date, batches, events, flexSlots)` function:
- Header: `**Thursday, Apr 10**`
- For each meal (lunch, dinner):
  - Cook meal: `🔪 {MealType}: **{recipeName}**\nCook {servings} servings ({dayRange}) · ~{cal} cal each`
  - Reheat: `{MealType}: {recipeName}\n_Reheat (cooked {cookDay}) · serving {N} of {total}_`
  - Uses Phase 0 helpers: `getServingNumber()`, `getDayRange()`, `isReheat()`.
- Reference: ui-architecture.md lines 258-267.

#### Step A6: Day Detail keyboard

**File:** `src/telegram/keyboards.ts`

Add `dayDetailKeyboard(date, cookBatches)` function:
- For each cook-day meal: `[🔪 {recipeName} — N servings]` with `cv_{batchId}` callback.
- `[Get shopping list]` with `sl_{ISO date}` callback (only if cook day).
- `[<- Back to week]` with `wo_show` callback.

#### Step A7: Post-confirmation bridge

**File:** `src/agents/plan-flow.ts` (line 720-724) — modify `handleApprove()` return message.

Current:
```typescript
return {
  text: `Plan locked for ${formatDayShort(state.weekStart)} – ${formatDayShort(state.weekDays[6]!)}. Shopping list ready.`,
  state,
};
```

New: Build a richer post-confirmation message showing the first cook day info. This requires computing the first cook day from the freshly-built batches.

Either:
- (a) Extend `handleApprove()` to return extra data (first cook day batches) alongside the text, and let core.ts format it. This keeps plan-flow.ts pure.
- (b) Build the message inside `handleApprove()` using a new formatter.

Decision: option (a) — return structured data, let core.ts call the formatter. `handleApprove()` already returns `FlowResponse` which has `text` and `state`. We can add an optional `postConfirmData?: { firstCookDay: string; cookBatches: Batch[] }` to `FlowResponse`.

**File:** `src/telegram/formatters.ts`

Add `formatPostConfirmation(horizonStart, horizonEnd, firstCookDay, cookBatches)` function:
- Format per ui-architecture.md lines 474-483.
- `Plan locked for Mon Apr 6 – Sun Apr 12 ✓`
- `Your first cook day is {day}:` + list of cook batches.
- `You'll need to shop for both + breakfast.`

**File:** `src/telegram/keyboards.ts`

Add `postConfirmationKeyboard()` function (replaces `planConfirmedKeyboard`):
- `[Get shopping list]` with `sl_next` callback.
- `[View full week]` with `wo_show` callback.

**File:** `src/telegram/core.ts` (line 484-495) — update the `plan_approve` handler:
- After `handleApprove()` returns, call the new formatter with the post-confirmation data.
- Use `postConfirmationKeyboard()` instead of `planConfirmedKeyboard`.

#### Step A8: Dispatch routing in core.ts

**File:** `src/telegram/core.ts`

Add new callback handlers in `handleCallback()` (after existing recipe/plan blocks):

```typescript
// ─── Plan view callbacks (Agent A) ─────────────────────────
if (action === 'na_show') {
  // ... load plan session, batches, format Next Action, reply
}
if (action === 'wo_show') {
  // ... load plan session, batches, format Week Overview, reply
}
if (action.startsWith('dd_')) {
  const date = action.slice(3); // ISO date
  // ... format Day Detail for that date, reply
}
```

Each handler:
1. Calls `store.getRunningPlanSession()` to get the active session.
2. Calls `store.getBatchesByPlanSessionId(session.id)` for all batches. Also `store.getBatchesOverlapping(...)` to include carry-over batches from prior sessions.
3. Sets `surfaceContext = 'plan'` (Phase 0).
4. Calls the appropriate formatter + keyboard function.
5. Replies via sink.

#### Step A9: Menu routing updates

**File:** `src/telegram/core.ts` — `handleMenu()` (line 642-698)

Update the `plan_week` case to be lifecycle-aware:
- Uses `getPlanLifecycle()` (Phase 0).
- `no_plan` -> existing plan-start behavior (line 660-689).
- `planning` -> resume flow. Phase 0 fixes the `handleMenu()` destruction bug; this agent verifies resume works by re-displaying the current phase's prompt/keyboard instead of restarting.
- `active_*` -> call the Next Action handler (same logic as `na_show` callback).

Update the `shopping_list` case (line 692-694):
- `no_plan` -> "No plan yet — plan your week first to see what you'll need."
- `active_*` -> delegate to Agent C's shopping list handler with `sl_next` scope.

---

### Agent B — Recipe Display Contexts

**Depends on:** Phase 0 (plan 012) for `getBatch(id)`, `surfaceContext`, `lastRecipeSlug`. Isolated Task 2 (plan 014) for `shortName` and `{placeholder}` support.

#### Step B1: Cook-time recipe renderer

**File:** `src/recipes/renderer.ts`

Add new function `renderCookView(recipe, batch)`:
- **Header:** `**{recipeName}** — {servings} servings\n_~{cal} cal/serving · {protein}g protein_\n_Divide into {servings} equal portions_`
- **Ingredients section:** `**Ingredients** (total for batch):` using `batch.scaledIngredients` for amounts (the `totalForBatch` field).
  - Group `role: 'seasoning'` ingredients with no meaningful amount (amount < 1 or common seasonings) onto one display line: "Salt, pepper, chili flakes".
  - Other ingredients: `· {name} — \`{totalForBatch}{unit}\`` (monospace for amounts).
- **Body with placeholder resolution:** Replace `{ingredient_name}` placeholders in `recipe.body` with actual batch amounts from `batch.scaledIngredients`. Match by ingredient name (case-insensitive). Fall back to displaying the placeholder name without amount if ingredient not found (defensive — don't crash).
  - Requires Task 2 to have landed (recipes must use `{placeholder}` format in body).
  - Until Task 2 lands, the body renders as-is (existing behavior from `renderRecipe()`).
- **Storage instructions:** At bottom: `_Storage: Fridge {fridgeDays} days. {reheat}_` from `recipe.storage` field.
- **Formatting:** Bold for headers/timings, monospace for amounts, italic for secondary info. Plain text that copies cleanly.
- Keep existing `renderRecipe()` unchanged — it serves the library view. `renderCookView()` is a separate function.

#### Step B2: Cook view keyboard

**File:** `src/telegram/keyboards.ts`

Add `cookViewKeyboard(recipeSlug)` function:
- `[<- Back to plan]` with callback `na_show`.
- `[Edit this recipe]` with callback `re_{slug}` (reuses existing recipe edit callback prefix).
- `[View in my recipes]` with callback `rv_{slug}` (reuses existing recipe view callback prefix).

#### Step B3: Cook view callback handler

**File:** `src/telegram/core.ts`

Add `cv_` callback handler in `handleCallback()`:

```typescript
// ─── Cook view callback (Agent B) ─────────────────────────
if (action.startsWith('cv_')) {
  const batchId = action.slice(3);
  const batch = await store.getBatch(batchId);  // Phase 0 method
  if (!batch) {
    await sink.reply('Batch not found.', { reply_markup: mainMenuKeyboard });
    return;
  }
  const recipe = recipes.getBySlug(batch.recipeSlug);
  if (!recipe) {
    await sink.reply('Recipe not found.', { reply_markup: mainMenuKeyboard });
    return;
  }
  session.surfaceContext = 'cooking';     // Phase 0 field
  session.lastRecipeSlug = batch.recipeSlug;  // Phase 0 field
  await sink.reply(
    renderCookView(recipe, batch),
    { reply_markup: cookViewKeyboard(batch.recipeSlug) },
  );
  return;
}
```

#### Step B4: Recipe library — plan-aware Cooking Soon section

**File:** `src/telegram/core.ts` — `showRecipeList()` (line 702-708)

Update to check lifecycle:
1. If active plan (`getPlanLifecycle()` returns `active_*`):
   - Load plan session and batches.
   - Filter to upcoming cook-day batches: `batch.eatingDays[0] >= today` (future cook days).
   - Sort by `eatingDays[0]` ascending (soonest first).
   - Pass both "cooking soon" batches and all recipes to the updated keyboard.
2. If no plan: existing behavior (flat recipe list).

**File:** `src/telegram/keyboards.ts` — update `recipeListKeyboard()`

Add optional parameter for cooking-soon batches:
```typescript
export function recipeListKeyboard(
  recipes: { name: string; slug: string; shortName?: string }[],
  page: number,
  pageSize?: number,
  cookingSoonBatches?: Array<{ id: string; recipeSlug: string; recipeName: string; shortName?: string }>,
): InlineKeyboard
```

When `cookingSoonBatches` is provided and non-empty:
- Add "COOKING SOON" header row (using a noop callback button for the label, or just listing them first).
- For each cooking-soon batch: `🔪 {shortName ?? name}` button with `cv_{batchId}` callback. Note: if the same recipe appears in two batches (after re-batching), both appear as separate 🔪 buttons with distinct batch IDs.
- Add "ALL RECIPES" header.
- Then the existing recipe buttons with `rv_{slug}` callbacks.

**File:** `src/telegram/formatters.ts` — update `formatRecipeList()`

Update the message text to include the Cooking Soon section header when applicable.

#### Step B5: Library view placeholder resolution

**File:** `src/recipes/renderer.ts` — update existing `renderRecipe()`

If `{placeholder}` patterns are present in `recipe.body` (after Task 2 lands), resolve them to per-serving amounts from `recipe.ingredients`. This is the library context, so amounts are per-serving (not batch totals).

Match `{ingredient_name}` -> find matching ingredient -> replace with `{amount}{unit}`.

This step can only be done after Isolated Task 2 (plan 014) ships.

---

### Agent C — Shopping List Overhaul

**Depends on:** Phase 0 (plan 012) for `getNextCookDay()`, `getPlanLifecycle()`. Also depends on its own Step C0 (role enrichment) completing first.

#### Step C1: Three-tier ingredient intelligence

**File:** `src/shopping/generator.ts` — major rewrite

Define the three tiers:

```typescript
// Tier 1: never show (universal basics)
const TIER_1_EXCLUSIONS = new Set([
  'water', 'salt', 'black pepper', 'pepper',
]);

// Tier 2: "check you have" (long-lasting pantry items)
// Default: role === 'seasoning' -> tier 2
// Additional hardcoded list:
const TIER_2_PANTRY = new Set([
  'olive oil', 'vegetable oil', 'cooking oil', 'sesame oil',
  'soy sauce', 'fish sauce', 'vinegar', 'rice vinegar',
  'balsamic vinegar', 'honey', 'maple syrup',
]);

// Tier 3: everything else (main buy list)
```

Tier assignment logic:
1. If `name.toLowerCase()` is in `TIER_1_EXCLUSIONS` -> exclude entirely.
2. If `role === 'seasoning'` OR `name.toLowerCase()` is in `TIER_2_PANTRY` -> tier 2 ("check you have").
3. Everything else -> tier 3 (main buy list).

#### Step C2: Category grouping

**File:** `src/shopping/generator.ts`

Replace the current `ROLE_TO_CATEGORY` mapping (line 30-37) with the spec's categories:

```typescript
const CATEGORY_ORDER = [
  'PRODUCE', 'FISH', 'MEAT', 'DAIRY & EGGS', 'PANTRY', 'OILS & FATS',
];
```

Category assignment from ingredient `role`:
- `protein` -> MEAT by default. Sub-categorize using keyword list: if ingredient name contains salmon/tuna/shrimp/cod/sea bass/anchovy/prawn/crab/lobster -> FISH, else MEAT.
- `carb` -> PANTRY (rice, pasta, bread, grains).
- `fat` -> OILS & FATS.
- `vegetable` -> PRODUCE.
- `base` -> PANTRY.
- `seasoning` -> not in main list (tier 2), but if somehow in tier 3, put in PANTRY.

#### Step C3: Scope to next cook day

**File:** `src/shopping/generator.ts`

Rewrite `generateShoppingList()` signature:

```typescript
export function generateShoppingList(
  batches: Batch[],
  breakfastRecipe: Recipe | undefined,
  options: {
    /** Target cook date — batches with eatingDays[0] === date are included */
    targetDate: string;
    /** Remaining plan days from target date onward (for breakfast proration) */
    remainingDays: number;
  },
): ShoppingList
```

Logic:
1. Filter `batches` to those where `eatingDays[0] === options.targetDate` (cook day = first eating day). This includes at most one day's cooking (both lunch and dinner if both cook that day).
2. Breakfast ingredients prorated: `ing.amount * options.remainingDays` (not full week).
3. Aggregate across cook-day batches and breakfast.
4. Apply three-tier filtering.
5. Group tier 3 by category.

The caller (core.ts handler) is responsible for:
- Resolving `targetDate` from `sl_next` (via `getNextCookDay()`) or `sl_{date}`.
- Computing `remainingDays` from target date to `session.horizonEnd`.
- Loading the breakfast recipe from `session.breakfast.recipeSlug`.

#### Step C4: Aggregation with role-aware merging

**File:** `src/shopping/generator.ts`

Update `addIngredient()` helper (line 106-124):
- Now that `ScaledIngredient` has `role`, use it for category assignment instead of hardcoding `'PANTRY'`.
- When merging duplicates, keep the more specific category (current logic at line 118 already does this, but it was meaningless before because everything was 'PANTRY').
- Case-insensitive key matching (already exists at line 113).

#### Step C5: New shopping list data model

**File:** `src/models/types.ts`

The current `ShoppingList` interface (types.ts:234-237) supports `categories` and `customItems` but has no concept of tiers. Update:

```typescript
export interface ShoppingList {
  /** Main buy list — tier 3 ingredients grouped by category */
  categories: ShoppingCategory[];
  /** Tier 2 — "check you have" items (long-lasting pantry, seasonings) */
  checkYouHave: string[];
  customItems: string[];
}
```

Note: `formatShoppingList()` in formatters.ts (line 69-87) uses the current `ShoppingList` shape. This must be updated in Step C6.

#### Step C6: Shopping list formatter

**File:** `src/telegram/formatters.ts`

Replace current `formatShoppingList()` (line 69-87) with a new implementation:

```typescript
export function formatShoppingList(
  list: ShoppingList,
  targetDate: string,
  scopeDescription: string,  // e.g., "Salmon Pasta (3 servings) + Breakfast"
): string
```

Format per ui-architecture.md lines 354-378:
- Header: `**What you'll need** — {day name} {date}`
- Scope line: `_For: {scopeDescription}_`
- Category sections: `**PRODUCE**\n- {item} — {amount}{unit}\n...`
- Tier 2 at bottom: `_Check you have:\n{comma-separated list}_`
- Footer: `_Long-press to copy. Paste into Notes,\nthen remove what you already have._`

Breakfast items in produce/dairy get a `(breakfast, remaining days)` annotation.

#### Step C7: Shopping list keyboard

**File:** `src/telegram/keyboards.ts`

Add `shoppingListKeyboard()` function (replaces existing `shoppingListKeyboard` const at line 97-99):
- `[<- Back to plan]` with callback `na_show`.

#### Step C8: Callback handlers

**File:** `src/telegram/core.ts`

Add `sl_` callback handlers in `handleCallback()`:

```typescript
// ─── Shopping list callbacks (Agent C) ──────────────────────
if (action.startsWith('sl_')) {
  const param = action.slice(3);  // "next" or ISO date
  const planSession = await store.getRunningPlanSession();
  if (!planSession) {
    await sink.reply('No active plan.', { reply_markup: mainMenuKeyboard });
    return;
  }
  const allBatches = await store.getBatchesByPlanSessionId(planSession.id);
  const plannedBatches = allBatches.filter(b => b.status === 'planned');
  
  let targetDate: string;
  if (param === 'next') {
    const nextCook = getNextCookDay(plannedBatches, todayISO());
    if (!nextCook) {
      await sink.reply('All meals are prepped — no shopping needed!');
      return;
    }
    targetDate = nextCook.date;
  } else {
    targetDate = param;  // ISO date
  }
  
  const breakfastRecipe = recipes.getBySlug(planSession.breakfast.recipeSlug);
  const horizonEnd = new Date(planSession.horizonEnd + 'T00:00:00');
  const target = new Date(targetDate + 'T00:00:00');
  const remainingDays = Math.ceil((horizonEnd.getTime() - target.getTime()) / 86400000) + 1;
  
  const list = generateShoppingList(plannedBatches, breakfastRecipe, {
    targetDate,
    remainingDays,
  });
  
  // Build scope description
  const cookBatches = plannedBatches.filter(b => b.eatingDays[0] === targetDate);
  const scopeParts = cookBatches.map(b => {
    const recipe = recipes.getBySlug(b.recipeSlug);
    return `${recipe?.name ?? b.recipeSlug} (${b.servings} servings)`;
  });
  if (breakfastRecipe) scopeParts.push('Breakfast');
  
  session.surfaceContext = 'shopping';
  await sink.reply(
    formatShoppingList(list, targetDate, scopeParts.join(' + ')),
    { reply_markup: shoppingListKeyboard() },
  );
  return;
}
```

---

## Progress

### Agent C — ScaledIngredient role enrichment (Step C0 — do first)
- [ ] C0.1: Add `role: IngredientRole` to `ScaledIngredient` interface in types.ts
- [ ] C0.2: Update recipe-scaler.ts output mapping with post-hoc name matching
- [ ] C0.3: Update plan-flow.ts scaler fallback path to include `role`
- [ ] C0.4: Add `role` to all seeded `scaledIngredients` in scenario spec files
- [ ] C0.5: Regenerate affected scenario recordings and verify diffs
- [ ] C0.6: `npm test` passes

### Agent A — Plan View Screens + Navigation
- [ ] A1: Next Action formatter in formatters.ts
- [ ] A2: Next Action keyboard in keyboards.ts
- [ ] A3: Week Overview formatter in formatters.ts
- [ ] A4: Week Overview keyboard in keyboards.ts
- [ ] A5: Day Detail formatter in formatters.ts
- [ ] A6: Day Detail keyboard in keyboards.ts
- [ ] A7: Post-confirmation bridge (plan-flow.ts return data + formatter + keyboard)
- [ ] A8: Plan view callback handlers in core.ts (`na_show`, `wo_show`, `dd_*`)
- [ ] A9: Menu routing updates (lifecycle-aware `plan_week` + `shopping_list` cases)

### Agent B — Recipe Display Contexts
- [ ] B1: Cook-time recipe renderer (`renderCookView()`) in renderer.ts
- [ ] B2: Cook view keyboard in keyboards.ts
- [ ] B3: Cook view callback handler (`cv_*`) in core.ts
- [ ] B4: Recipe library plan-aware redesign (Cooking Soon section in `showRecipeList()` + keyboard)
- [ ] B5: Library view placeholder resolution in `renderRecipe()` (blocked on Task 2)

### Agent C — Shopping List Overhaul
- [ ] C1: Three-tier ingredient intelligence (tier definitions + classification)
- [ ] C2: Category grouping (PRODUCE, FISH, MEAT, DAIRY & EGGS, PANTRY, OILS & FATS)
- [ ] C3: Scope to next cook day (rewrite `generateShoppingList()` signature + filtering)
- [ ] C4: Aggregation with role-aware merging
- [ ] C5: Update `ShoppingList` interface with `checkYouHave` field
- [ ] C6: Shopping list formatter (replace `formatShoppingList()`)
- [ ] C7: Shopping list keyboard (replace static `shoppingListKeyboard`)
- [ ] C8: `sl_*` callback handlers in core.ts

### Integration verification
- [ ] End-to-end flow: Plan confirm -> post-confirmation -> shopping list -> back to plan
- [ ] End-to-end flow: My Plan -> Next Action -> View full week -> Day Detail -> Cook view -> Back to plan
- [ ] End-to-end flow: My Recipes -> Cooking Soon 🔪 -> Cook view -> View in my recipes -> Library view
- [ ] End-to-end flow: Shopping List main menu -> scoped shopping list -> Back to plan
- [ ] `npm test` passes with all scenario seeds updated

---

## Decision log

- **Decision:** `cv_{batchId}` uses the batch UUID, not the recipe slug.
  **Rationale:** After Plan 009 re-batching, the same (recipeSlug, mealType) pair can appear in multiple batches. The batch ID uniquely identifies which batch to render without the `days[0]` disambiguation that plan-flow.ts:1570-1576 requires. UUID (36 chars) + `cv_` prefix (3 chars) = 39 bytes, within Telegram's 64-byte callback limit.
  **Date:** 2026-04-07

- **Decision:** Role enrichment on `ScaledIngredient` is a required field, not optional.
  **Rationale:** Making it optional (`role?: IngredientRole`) would require null checks everywhere in the shopping generator and renderer. The scaler already has access to `recipe.ingredients[].role`, and the fallback path in plan-flow.ts has `ing.role` directly. The only cost is updating scenario seeds, which is a one-time mechanical task. A required field is simpler for all consumers.
  **Date:** 2026-04-07

- **Decision:** Post-hoc name matching for role in scaler output uses bidirectional case-insensitive substring matching with `'base'` fallback.
  **Rationale:** The LLM may rename ingredients during scaling (e.g., "chicken breast" -> "chicken", "penne pasta" -> "pasta"). Exact match would miss these. Substring match in both directions catches both shortening and lengthening. `'base'` is the safest fallback role — it means "keep stable" in the scaling system and "PANTRY" in the shopping categorization. A warning log makes mismatches visible in debug.log for monitoring.
  **Date:** 2026-04-07

- **Decision:** `FlowResponse` extended with optional `postConfirmData` rather than building the post-confirmation message inside `handleApprove()`.
  **Rationale:** `handleApprove()` in plan-flow.ts is a pure flow handler — it persists the plan and returns text. Building Telegram-specific formatted messages inside it would couple the flow handler to the UI layer. By returning structured data (first cook day + batches), the core.ts handler calls the formatter. This preserves the three-layer architecture (ui / agent / store).
  **Date:** 2026-04-07

- **Decision:** Agent C does the `ScaledIngredient` role enrichment before the main shopping list work, and before Agents A and B start.
  **Rationale:** The interface change to `ScaledIngredient` is a breaking change that affects scenario seeds, the scaler, and plan-flow. Landing it first as an isolated sub-task avoids merge conflicts and ensures `npm test` stays green for all three agents. Agent C is the primary consumer of role data, so it owns the enrichment.
  **Date:** 2026-04-07

- **Decision:** Shopping list breakfast proration uses remaining plan days (not full week).
  **Rationale:** If the user shops on Thursday with 4 remaining days, they need 4 avocados, not 7. This is stateless — no tracking of prior shopping lists needed. The user removes what they already have during manual reconciliation (per ui-architecture.md line 395).
  **Date:** 2026-04-07

- **Decision:** Day buttons in Week Overview use `dd_{ISO date}` callback, not `dd_mon`/`dd_tue` abbreviations.
  **Rationale:** ISO dates are unambiguous across plan horizons. Abbreviations require resolving which week's Monday is meant. ISO dates are 10 chars; with `dd_` prefix = 13 bytes, well within 64-byte limit.
  **Date:** 2026-04-07

---

## Validation

1. **`npm test`** — all existing scenarios pass after Step C0 (role enrichment + scenario seed updates + recording regeneration).
2. **New scenarios** — at minimum one scenario per agent:
   - Agent A: scenario exercising My Plan -> Next Action -> View full week -> Day Detail flow with an active plan seeded.
   - Agent B: scenario exercising cook view entry from plan screen (`cv_` callback) and from Cooking Soon list.
   - Agent C: scenario exercising `sl_next` shopping list generation with role-enriched ingredients, verifying three-tier output.
3. **Manual Telegram verification** (`npm run dev`) — final UX check:
   - Keyboard layouts render correctly on phone.
   - Message formatting (bold, italic, monospace) displays as intended.
   - Back navigation works across all surfaces.
   - Shopping list copies cleanly to Notes.
4. **Cross-agent integration** — verify all entry/exit points:
   - Plan view 🔪 button -> cook view -> back to plan.
   - Plan view shopping button -> shopping list -> back to plan.
   - My Recipes Cooking Soon -> cook view -> view in my recipes -> library view.
   - Main menu Shopping List -> scoped shopping list.

---

# Feedback

