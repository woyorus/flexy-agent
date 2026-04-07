# Plan 016: Plan-Aware UI System

**Status:** Active
**Date:** 2026-04-07
**Affects:** `src/telegram/core.ts`, `src/telegram/keyboards.ts`, `src/telegram/formatters.ts`, `src/agents/plan-flow.ts`, `src/agents/recipe-scaler.ts`, `src/recipes/renderer.ts`, `src/shopping/generator.ts`, `src/models/types.ts`, `src/plan/helpers.ts`, `test/scenarios/*/spec.ts`

## Problem

The confirmed plan is currently a dead end. After tapping "Confirm plan," the user sees "Plan locked for Mon – Sun. Shopping list ready." (plan-flow.ts:722) with two buttons that both lead nowhere useful: `view_shopping_list` replies "Shopping list generation is coming soon!" (core.ts:382), and `view_plan_recipes` dumps to the flat recipe list with no plan context.

There is no way to:
- See what to cook next or browse the week's schedule.
- View a recipe in cook-time mode (batch totals, inline amounts, storage instructions).
- Get a shopping list scoped to the next cook day with breakfast prorated and ingredients intelligently tiered.

This plan implements three surfaces — plan views, recipe display, and shopping list — executed sequentially to avoid file conflicts in shared files (`core.ts`, `keyboards.ts`, `formatters.ts`). Steps are grouped into phases with a clear execution order.

**Dependencies:**
- **Phase 0 (plan 012):** Lifecycle detection (`getPlanLifecycle(session, store, today)`), dynamic `buildMainMenuKeyboard()`, `matchMainMenu()` update, `handleMenu()` fix (no longer destroys `planFlow` on every tap), `surfaceContext` on `BotCoreSession`, plan data helpers (`getNextCookDay()`, `getBatchForMeal()`, `isReheat()`, `getServingNumber()`, `getDayRange()`, `getCookDaysForWeek()`), `getBatch(id)` on `StateStoreLike`, `toLocalISODate` moved to `src/plan/helpers.ts`, callback prefix registry. All phases depend on Phase 0.
- **Plan 015 (copy-messaging-pass):** Plan 015 is **already complete**. The codebase uses MarkdownV2 formatting throughout (bold, italic, monospace). All formatters in plan 016 MUST use MarkdownV2, following the existing patterns in `renderRecipe()`, `formatBudgetReview()`, and plan-flow messages. Use `esc()` and `escapeRecipeBody()` from `src/utils/telegram-markdown.ts`. Pass `parseMode: 'MarkdownV2'` in handler replies.
- **Isolated Task 2 (plan 014):** Recipe Format Evolution — `shortName` field, `{placeholder}` support in recipe body, step-by-step timing, grouped seasonings in prose. Phase 4 depends on this for placeholder resolution and `shortName` button labels. Phase 4 can start library redesign work before Task 2 lands but cannot implement cook-time placeholder resolution until it ships.

---

## Shared contract

Phase 0 delivers the plan data helpers and callback prefix registry. All phases share these integration protocols.

### 0. Shared view model: `BatchView`

All phases share a view model that joins a persisted `Batch` with its loaded `Recipe`. Define and **export** this from `src/models/types.ts`:

```typescript
/**
 * View model: a persisted Batch joined with its loaded Recipe.
 * Used by formatters and keyboards that need recipe display names.
 * `Batch.recipeSlug` is the FK; resolution happens in the handler before calling any formatter.
 */
export interface BatchView {
  batch: Batch;
  recipe: Recipe;
}
```

Every formatter and keyboard in this plan that displays recipe information receives `BatchView[]`, not raw `Batch[]`. Handlers resolve slugs before calling formatters:
```typescript
const batchViews: BatchView[] = allBatches.flatMap(b => {
  const recipe = recipes.getBySlug(b.recipeSlug);
  if (!recipe) { log.warn('CORE', `no recipe for slug ${b.recipeSlug}`); return []; }
  return [{ batch: b, recipe }];
});
```

**Import path:** `import type { BatchView } from '../models/types.js';`

### 1. Cook view entry protocol (Phase 4 defines, Phase 3 calls)

- **Callback format:** `cv_{batchId}` where `batchId` is the batch UUID (36 chars). Total callback data: `cv_` prefix (3 chars) + UUID (36 chars) = 39 bytes, within Telegram's 64-byte limit.
- **Why batch ID, not recipe slug:** After Plan 009 re-batching, the same `(recipeSlug, mealType)` pair can appear in multiple batches (see plan-flow.ts:1570-1576 where `days[0]` disambiguates). The batch UUID uniquely identifies which batch to render.
- **Handler contract (Phase 4):** Receive `cv_{batchId}` callback in `handleCallback()` (core.ts) -> call `store.getBatch(batchId)` (Phase 0) -> load recipe via `recipes.getBySlug(batch.recipeSlug)` -> render cook view with `batch.scaledIngredients`, `batch.eatingDays.length` servings, recipe body with resolved placeholders. Set `surfaceContext = 'cooking'` and `lastRecipeSlug = batch.recipeSlug`.
- **Returns:** Formatted cook-time message + cook view keyboard (`[<- Back to plan]`, `[Edit this recipe]`, `[View in my recipes]`).

### 2. Shopping list entry protocol (Phase 5 defines, Phase 3 calls)

- **Callback formats:**
  - `sl_next` — computes the next cook day via `getNextCookDay()` (Phase 0 helper).
  - `sl_{ISO date}` — scopes to that specific day's cook session (e.g., `sl_2026-04-10`).
  - Main menu `[Shopping List]` with active plan -> equivalent to `sl_next` (menu handler delegates to `sl_*` handler).
- **Handler contract (Phase 5):** Receive `sl_*` callback -> resolve target date (or compute next cook day) -> get batches for that day from store -> load breakfast recipe from plan session -> generate three-tiered, category-grouped shopping list scoped to that day + prorated breakfast. Set `surfaceContext = 'shopping'`.
- **Returns:** Formatted shopping list message + shopping keyboard (`[<- Back to plan]`).

### 3. Ingredient role propagation (Phase 2, unblocks all later phases)

- **Current problem:** `ScaledIngredient` (types.ts:146-152) has only `name`, `amount`, `unit`, `totalForBatch` — no `role`. The shopping generator (generator.ts:58-60) hardcodes all batch ingredients to `'PANTRY'` because it has no role data.
- **Fix:** Add `role: IngredientRole` to `ScaledIngredient` interface. Update three code paths:
  1. `recipe-scaler.ts` output mapping (line 177): post-hoc name-match from LLM output back to `recipe.ingredients[].role`.
  2. `plan-flow.ts` scaler fallback (line 1602): include `role: ing.role` in manual `ScaledIngredient[]` construction.
  3. Test scenario seeds (`test/scenarios/*/spec.ts`): add `role` to every seeded `scaledIngredients` entry.

### 4. File organization

- `core.ts` and `keyboards.ts` are touched by multiple phases. Strategy:
  - Handlers are added in clearly separated, comment-delimited sections.
  - Phase 3 owns the top-level dispatch routing structure, plan view handlers (`na_show`, `wo_show`, `dd_*`), and `handleMenu()` lifecycle-aware routing.
  - Phase 4 adds `cv_` callback handling and recipe list modifications in its own section.
  - Phase 5 adds `sl_` callback handling in its own section.
  - Keyboard functions are separate exported functions (e.g., `nextActionKeyboard()`, `cookViewKeyboard()`, `shoppingListKeyboard()`), not modifications to the same function.

### 5. Line number references

Line numbers cited in this plan (e.g., `plan-flow.ts:722`, `core.ts:382`) reflect the codebase state at plan-writing time. Phase 0 (plan 012) will land before implementation and will shift line numbers. Use function and variable names to locate code, not line numbers. Line numbers are provided as approximate orientation only.

---

## Plan of work

Execution is strictly sequential: Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6. Each phase completes (including `npm test`) before the next begins.

### Phase 1 — Pre-work

Export `BatchView` interface from `src/models/types.ts` (shared contract section above).

### Phase 2 — ScaledIngredient role enrichment (unblocks all later phases)

This changes the `ScaledIngredient` interface and every scenario seed. Must land before any UI work.

#### Step 2.0: Normalize `fromBatchRow` in store.ts for existing production rows

**File:** `src/state/store.ts` — `fromBatchRow()` function (line 368-380)

Existing Supabase batch rows do not have a `role` field in their `scaled_ingredients` JSON (they were persisted before this migration). Without normalization, old rows will produce `ScaledIngredient` objects with `role: undefined`, which will cause type errors and wrong behavior in the shopping generator and renderer.

The current code is a direct passthrough: `scaledIngredients: row.scaled_ingredients`. The stored JSON uses camelCase keys (`name`, `amount`, `unit`, `totalForBatch`) because the insert path writes `batch.scaledIngredients` directly. Add a safe `role` default without breaking the existing passthrough:

```typescript
scaledIngredients: (row.scaled_ingredients ?? []).map((i: any) => ({
  ...i,
  role: i.role ?? 'base',  // 'base' is the safest default for old rows without role
})),
```

This ensures old persisted rows load correctly without requiring a Supabase migration or data backfill.

#### Step 2.1: Add `role` to `ScaledIngredient` interface

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

#### Step 2.2: Update recipe-scaler.ts output mapping

**File:** `src/agents/recipe-scaler.ts` (line 176-184)

The LLM's JSON schema (line 90-95) does NOT include `role` — it only returns `name`, `amount`, `unit`, `total_for_batch`. Role must be mapped post-hoc by matching the LLM's returned ingredient name back to `recipe.ingredients[].role`.

After the `parsed.scaled_ingredients.map(...)` at line 177, add role matching:

```typescript
scaledIngredients: parsed.scaled_ingredients.map((ing: Record<string, unknown>) => {
  const name = ing.name as string;
  // Match back to source recipe ingredient to get role.
  // LLM may rename ingredients (e.g., "chicken breast" -> "chicken"),
  // so use case-insensitive substring matching.
  // Note on false positives: bidirectional substring match can produce incorrect matches
  // for generic names like "oil" (matching "olive oil" and "sesame oil" both).
  // `find()` returns the first match, which is deterministic but potentially wrong.
  // The warn log makes mismatches visible in debug.log. For v0.0.4 this is acceptable —
  // the worst outcome is a wrong tier/category assignment, not a crash. If false positives
  // become a recurring problem in practice, replace with a word-boundary regex or a
  // scored/ranked match (longest name that is a substring wins).
  const nameLower = name.toLowerCase();
  const sourceIng = recipe.ingredients.find(
    (ri) => ri.name.toLowerCase().includes(nameLower)
      || nameLower.includes(ri.name.toLowerCase())
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

#### Step 2.3: Update plan-flow.ts scaler fallback

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

#### Step 2.4: Update test scenario seeds

**Spec files with seeded `scaledIngredients` (require manual role annotation):**
- `test/scenarios/005-rolling-continuous/spec.ts` — 6 batches
- `test/scenarios/009-rolling-swap-recipe-with-carryover/spec.ts` — 1 batch
- `test/scenarios/010-rolling-events-with-carryover/spec.ts` — 1 batch
- `test/scenarios/011-rolling-replan-future-only/spec.ts` — 2 batches
- `test/scenarios/012-rolling-replan-abandon/spec.ts` — 1 batch

Every seeded entry must get `role` matching the ingredient:
```typescript
scaledIngredients: [{ name: 'chicken breast', amount: 190, unit: 'g', totalForBatch: 570, role: 'protein' }],
```

**`test/unit/test-store.test.ts`:** This file seeds `scaledIngredients: []` (empty arrays). No entries to annotate — just verify the file still type-checks after the interface change; no mechanical edits required.

#### Step 2.5: Regenerate affected scenario recordings

`ScaledIngredient` is a **required** field change — any recording that persisted batches will fail type-checking or deepStrictEqual comparisons until regenerated. More scenarios are affected than just those with seeded spec data.

**Two categories of affected recordings:**

1. **Scenarios with seeded carry-over batches (spec seeds):** These specs pre-populate store state with batches containing `scaledIngredients`. After 2.1-2.3, the in-flight scaler calls will add `role` to all newly scaled results. Re-run these five:
   - `npm run test:generate -- 005-rolling-continuous --regenerate`
   - `npm run test:generate -- 009-rolling-swap-recipe-with-carryover --regenerate`
   - `npm run test:generate -- 010-rolling-events-with-carryover --regenerate`
   - `npm run test:generate -- 011-rolling-replan-future-only --regenerate`
   - `npm run test:generate -- 012-rolling-replan-abandon --regenerate`

2. **Scenarios that confirm a plan (scaler runs during test):** Any scenario that exercises the plan approval flow will have `scaledIngredients` in its `recorded.json` store snapshot. These must also be regenerated. Grep confirms the following recorded.json files contain `scaledIngredients`:
   - 001, 002, 003, 004, 006, 008, 013, 014 (run `--regenerate` for each)
   - Run: `npm run test:generate -- <scenario-name> --regenerate` for each

**Review protocol for each regenerated recording:** The `git diff` on `recorded.json` should show only `role` fields being added to `scaledIngredients` arrays in the persisted store snapshot. If any message content, keyboard shapes, or non-ingredient fields change, the blast radius is wider than intended — investigate before continuing.

Then run `npm test` to confirm all scenarios pass.

---

### Phase 3 — Plan View Screens + Navigation

**Depends on:** Phase 0 (plan 012) for `getPlanLifecycle()`, `buildMainMenuKeyboard()`, `surfaceContext`, plan data helpers, `getBatch(id)`. Also depends on Phase 2 (role enrichment) for `npm test` — the plan view code itself doesn't read `role`.

#### Step 3.1: Next Action screen formatter

**File:** `src/telegram/formatters.ts`

**Pre-requisite:** Before calling this formatter, the handler (core.ts) must resolve every batch's `recipeSlug` into a recipe name. `Batch` only stores `recipeSlug` — there is no `recipeName` field. Import and use `BatchView` from `src/models/types.ts` (defined in the shared contract section above); do not define a local type.

Resolve via `recipes.getBySlug(batch.recipeSlug)` in the handler, filter out any batches with no matching recipe (warn in log), then pass `BatchView[]` to the formatter.

**MarkdownV2** — use `esc()` from `src/utils/telegram-markdown.ts` for all dynamic text. Follow existing patterns in `formatBudgetReview()`.

Add `formatNextAction(batchViews: BatchView[], events: MealEvent[], flexSlots: FlexSlot[], today: string)` function:
- Takes: resolved `BatchView[]`, `MealEvent[]`, `FlexSlot[]`, and today's ISO date.
- Shows today + next 2 days. For each day:
  - Skip breakfast (not shown — fixed, memorized).
  - Lunch line: recipe name + status (cook/reheat/flex/event).
  - Dinner line: recipe name + status.
  - Cook meals get `🔪 Cook {mealType}: **{recipeName}** — {servings} servings` formatting.
  - Reheat meals: `{recipeName} _(reheat)_`.
  - Flex slots: `Flex` (no calorie number — `FlexSlot.flexBonus` is bonus calories on top of the normal baseline, not a total meal figure; displaying a partial number is misleading).
  - Events: `🍽️ {eventName}`.
- Uses Phase 0 helpers: `getBatchForMeal()`, `isReheat()`.
- Returns formatted string.

Reference mock from ui-architecture.md lines 160-171.

#### Step 3.2: Next Action keyboard

**File:** `src/telegram/keyboards.ts`

Add `nextActionKeyboard(nextCookBatchViews: BatchView[], lifecycle: PlanLifecycle)` function:
- If next cook session upcoming (`active_early` / `active_mid`): `[🔪 {recipeName} — N servings]` button(s) with `cv_{batchId}` callback + `[Get shopping list]` with `sl_next` callback + `[View full week]` with `wo_show` callback.
- If `active_ending`: same buttons as `active_mid`, no extra buttons — `[Plan next week]` is v0.0.5 scope. Do not add an unhandled callback button in v0.0.4.
- If no upcoming cook: just `[View full week]`.
- Recipe button labels use `bv.recipe.shortName ?? bv.recipe.name` (where `bv: BatchView`; depends on Task 2 for `shortName` — fall back to `name` initially).
- The keyboard function receives pre-resolved `BatchView[]`, not raw `Batch[]`.

#### Step 3.3: Week Overview formatter

**File:** `src/telegram/formatters.ts`

**Pre-requisite:** Same recipe resolution requirement as 3.1 — pass `BatchView[]` (pre-resolved), not raw `Batch[]`. Also pass the resolved breakfast recipe, since `PlanSession.breakfast` only stores `recipeSlug` — no name.

**MarkdownV2** — use `esc()` for dynamic text. Follow existing formatter patterns.

Add `formatWeekOverview(session: PlanSession, batchViews: BatchView[], events: MealEvent[], flexSlots: FlexSlot[], breakfastRecipe: Recipe | undefined)` function:
- Header: `**Your week:** Mon Apr 6 – Sun Apr 12`
- Breakfast line: `Breakfast: {breakfastRecipe?.name ?? 'Breakfast'} (daily)` — use the `breakfastRecipe` param passed from the handler.
- For each day: compact format per ui-architecture.md line 208-228:
  - `**Mon** 🔪` (if any cook that day)
  - `L: {name} · D: {name}` with markers (🔪 for cook, 🍽️ for event, **Flex** bold text).
- Footer: `**Weekly target: on track ✓**` (simple status, no calorie numbers).
- Prompt: `_Tap a day for details:_`

#### Step 3.4: Week Overview keyboard

**File:** `src/telegram/keyboards.ts`

Add `weekOverviewKeyboard(weekDays: string[])` function — receives an array of 7 ISO date strings (`[horizonStart, ..., horizonEnd]`):
- Day buttons derived from `weekDays`: `[Mon] [Tue] [Wed] [Thu]` row, `[Fri] [Sat] [Sun]` row. Display label is abbreviated day name (e.g., `'Mon'`), derived from the ISO date.
- Callback data: `dd_{ISO date}` (e.g., `dd_2026-04-06`). The `dd_` prefix is 3 chars + 10-char ISO date = 13 bytes, well within 64-byte limit.
- `[<- Back]` button with callback `na_show` (returns to Next Action).
- The handler (3.8) passes the 7 days of the active session's horizon.

#### Step 3.5: Day Detail formatter

**File:** `src/telegram/formatters.ts`

**Pre-requisite:** Same recipe resolution requirement as 3.1 — pass `BatchView[]` (pre-resolved), not raw `Batch[]`.

Add `formatDayDetail(date: string, batchViews: BatchView[], events: MealEvent[], flexSlots: FlexSlot[])` function:
- Header: `**Thursday, Apr 10**`
- For each meal (lunch, dinner):
  - Cook meal: `🔪 {MealType}: **{recipeName}**\nCook {servings} servings ({dayRange}) · ~{cal} cal each`
  - Reheat: `{MealType}: {recipeName}\n_Reheat (cooked {cookDay}) · serving {N} of {total}_`
  - Uses Phase 0 helpers: `getServingNumber()`, `getDayRange()`, `isReheat()`.
- Reference: ui-architecture.md lines 258-267.

#### Step 3.6: Day Detail keyboard

**File:** `src/telegram/keyboards.ts`

Add `dayDetailKeyboard(date: string, cookBatchViews: BatchView[], today: string)` function:
- For each cook-day meal: `[🔪 {recipeName} — N servings]` with `cv_{batchId}` callback.
- `[Get shopping list]` with `sl_{ISO date}` callback — only show this button if `date >= today` (future or current cook days only). Past cook days should not show the shopping button, to avoid routing users to the rejected-date path in 5.8.
- `[<- Back to week]` with `wo_show` callback.
- Receives pre-resolved `BatchView[]` for recipe name display.

#### Step 3.7: Post-confirmation bridge

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

**Note on recipe name resolution:** `postConfirmData.cookBatches` are raw `Batch[]` from the store. The core.ts handler must resolve each to a `BatchView` before passing to `formatPostConfirmation()`. `handleApprove()` stays pure (no recipe database dependency); name resolution happens in core.ts, consistent with the pattern in Section 0.

**File:** `src/telegram/formatters.ts`

Add `formatPostConfirmation(horizonStart: string, horizonEnd: string, firstCookDay: string, cookBatchViews: BatchView[])` function (note: accepts `BatchView[]`, not `Batch[]`):
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

#### Step 3.8: Dispatch routing in core.ts

**File:** `src/telegram/core.ts`

Add new callback handlers in `handleCallback()` (after existing recipe/plan blocks):

```typescript
// ─── Plan view callbacks (Phase 3) ─────────────────────────
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
1. Computes `today = toLocalISODate(new Date())` (from `src/plan/helpers.ts`).
2. Calls `getPlanLifecycle(session, store, today)` (plan 012 signature — 3 args).
3. Calls `store.getRunningPlanSession(today)` to get the active session (plan 012 adds optional `today` param to avoid UTC/local divergence near midnight).
4. Loads batches using the correct object-based API:
   ```typescript
   const ownBatches = await store.getBatchesByPlanSessionId(session.id);
   const overlapBatches = await store.getBatchesOverlapping({
     horizonStart: session.horizonStart,
     horizonEnd: session.horizonEnd,
     statuses: ['planned'],
   });
   // Deduplicate by id (own batches + carry-over may overlap):
   const seen = new Set<string>();
   const allBatches = [...ownBatches, ...overlapBatches]
     .filter(b => seen.has(b.id) ? false : (seen.add(b.id), true))
     .filter(b => b.status === 'planned');  // exclude cancelled/tombstoned batches
   ```
5. For `dd_` callbacks: validate `date` format (ISO, 10 chars) and that `session.horizonStart <= date <= session.horizonEnd`. If invalid or stale, reply with a refreshed main menu instead.
6. Resolves every batch to a `BatchView` before calling formatters:
   ```typescript
   const batchViews = allBatches.flatMap(b => {
     const recipe = recipes.getBySlug(b.recipeSlug);
     if (!recipe) { log.warn('CORE', `no recipe for slug ${b.recipeSlug}`); return []; }
     return [{ batch: b, recipe }];
   });
   ```
5. Sets `surfaceContext = 'plan'` (Phase 0).
6. Calls the appropriate formatter + keyboard function.
8. Replies via sink.

**Note on error-path keyboards:** Use `buildMainMenuKeyboard(lifecycle)` (Phase 0 API) in error replies, not the pre-Phase-0 `mainMenuKeyboard` static const. `lifecycle` is computed in step 2 above.

#### Step 3.9: Menu routing updates

**File:** `src/telegram/core.ts` — `handleMenu()` (line 642-698)

Update the `plan_week` case to be lifecycle-aware:
- Uses `getPlanLifecycle()` (Phase 0).
- `no_plan` -> existing plan-start behavior (line 660-689).
- `planning` -> resume flow. Phase 0 fixes the `handleMenu()` destruction bug; verify resume works by re-displaying the current phase's prompt/keyboard instead of restarting.
- `active_*` -> call the Next Action handler (same logic as `na_show` callback).

Update the `shopping_list` case (line 692-694):
- `no_plan` -> "No plan yet — plan your week first to see what you'll need."
- `active_*` -> delegate to Phase 5's shopping list handler with `sl_next` scope.

---

### Phase 4 — Recipe Display Contexts

**Depends on:** Phase 0 (plan 012) for `getBatch(id)`, `surfaceContext`, `lastRecipeSlug`. Isolated Task 2 (plan 014) for `shortName` and `{placeholder}` support.

#### Step 4.1: Cook-time recipe renderer

**File:** `src/recipes/renderer.ts`

Add new function `renderCookView(recipe, batch)`:
- **Header:** `**{recipeName}** — {servings} servings\n_~{cal} cal/serving · {protein}g protein_\n_Divide into {servings} equal portions_`
- **Ingredients section:** `**Ingredients** (total for batch):` using `batch.scaledIngredients` for amounts (the `totalForBatch` field).
  - Group `role: 'seasoning'` ingredients that are unitless (no `unit` field or `unit === ''`) or are in the hardcoded universal-basics set (`'salt'`, `'black pepper'`, `'pepper'`) onto one display line: "Salt, pepper, chili flakes". Do NOT group seasonings that have a measured unit (e.g., `0.5 tsp smoked paprika`) — those get their own line.
  - Other ingredients: `· {name} — \`{totalForBatch}{unit}\`` (monospace for amounts).
- **Body with placeholder resolution:** Replace `{ingredient_name}` placeholders in `recipe.body` with actual batch amounts from `batch.scaledIngredients`. Match by ingredient name (case-insensitive). Fall back to displaying the placeholder name without amount if ingredient not found (defensive — don't crash).
  - **Replacement format:** `{penne pasta}` → `` `225g` penne pasta `` — amount in monospace, followed by the ingredient name. Do not drop the ingredient name (see ui-architecture.md line 306).
  - Requires Task 2 to have landed (recipes must use `{placeholder}` format in body).
  - Until Task 2 lands, the body renders as-is (existing behavior from `renderRecipe()`).
- **Storage instructions:** At bottom: `_Storage: Fridge {fridgeDays} days. {reheat}_` from `recipe.storage` field.
- **Formatting:** Use MarkdownV2, following the existing `renderRecipe()` patterns (bold headers via `*...*`, italic secondary info via `_..._`, monospace amounts via `` `...` ``). Use `esc()` and `escapeRecipeBody()` from `src/utils/telegram-markdown.ts`.
- Keep existing `renderRecipe()` unchanged — it serves the library view. `renderCookView()` is a separate function.

#### Step 4.2: Cook view keyboard

**File:** `src/telegram/keyboards.ts`

Add `cookViewKeyboard(recipeSlug)` function:
- `[<- Back to plan]` with callback `na_show`.
- `[Edit this recipe]` with callback `re_{slug}` (reuses existing recipe edit callback prefix).
- `[View in my recipes]` with callback `rv_{slug}` (reuses existing recipe view callback prefix).

#### Step 4.3: Cook view callback handler

**File:** `src/telegram/core.ts`

Add `cv_` callback handler in `handleCallback()`:

```typescript
// ─── Cook view callback (Phase 4) ─────────────────────────
if (action.startsWith('cv_')) {
  const batchId = action.slice(3);
  const batch = await store.getBatch(batchId);  // Phase 0 method
  if (!batch) {
    // Use Phase 0 lifecycle-aware keyboard, not static mainMenuKeyboard.
    // getPlanLifecycle signature (plan 012): (session, store, today) — 3 args:
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
  session.surfaceContext = 'cooking';     // Phase 0 field
  session.lastRecipeSlug = batch.recipeSlug;  // Phase 0 field
  await sink.reply(
    renderCookView(recipe, batch),
    { reply_markup: cookViewKeyboard(batch.recipeSlug) },
  );
  return;
}
```

#### Step 4.4: Recipe library — plan-aware Cooking Soon section

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
  cookingSoonBatchViews?: BatchView[],  // pre-resolved; NOT the old raw shape
): InlineKeyboard
```

When `cookingSoonBatchViews` is provided and non-empty:
- Section headers (e.g., "COOKING SOON", "ALL RECIPES") go in the message text, not as keyboard row buttons — there is no globally-registered noop callback for this purpose.
- For each cooking-soon batch: `🔪 {bv.recipe.shortName ?? bv.recipe.name}` button with `cv_{bv.batch.id}` callback. Note: if the same recipe appears in two batches (after re-batching), both appear as separate 🔪 buttons with distinct batch IDs.
- Then the existing recipe buttons with `rv_{slug}` callbacks.

**File:** `src/telegram/core.ts` — update the inline `sink.reply()` call inside `showRecipeList()` (line 705)

The live recipe-list path builds its reply inline inside `showRecipeList()` — it does NOT call `formatRecipeList()`. Update the inline message string within `showRecipeList()` directly to include the Cooking Soon section header when applicable. `formatRecipeList()` in formatters.ts is dead code for this path; do not modify it.

**Important scope note on Plan 014 and existing recipes:** Plan 014 adds `{placeholder}` support to newly generated recipes only — it explicitly does NOT backfill existing recipe bodies with placeholders. This means cook view steps for existing (pre-014) recipes will not have inline amounts in the step text, and `renderCookView()` will render their bodies unchanged. The ingredient list at the top of the cook view (using `batch.scaledIngredients`) remains the authoritative amount reference for all recipes. This is acceptable for v0.0.4.

#### Step 4.5: Library view placeholder resolution

**File:** `src/recipes/renderer.ts`

**NOTE:** `renderRecipe()` already has a `resolvePlaceholders()` function (renderer.ts:113) that resolves `{ingredient_name}` patterns using `recipe.ingredients` (per-serving amounts). This was implemented as part of plan 014/015. **This step is a no-op for the library view** — verify that the existing implementation produces the correct format and move on.

**For `renderCookView()`** (Step 4.1): the cook view needs a different resolution path because it uses `batch.scaledIngredients` (batch totals, not per-serving). Either call `resolvePlaceholders()` with adapted input, or write a parallel resolver that matches `{ingredient_name}` against `ScaledIngredient[]` by name (case-insensitive) and substitutes `{totalForBatch}{unit} {name}`.

This step can only be done after Isolated Task 2 (plan 014) ships.

---

### Phase 5 — Shopping List Overhaul

**Depends on:** Phase 0 (plan 012) for `getNextCookDay()`, `getPlanLifecycle()`. Also depends on Phase 2 (role enrichment).

#### Step 5.1: Three-tier ingredient intelligence

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

#### Step 5.2: Category grouping

**File:** `src/shopping/generator.ts`

Replace the current `ROLE_TO_CATEGORY` mapping (line 30-37) with the spec's categories:

```typescript
const CATEGORY_ORDER = [
  'PRODUCE', 'FISH', 'MEAT', 'DAIRY & EGGS', 'PANTRY', 'OILS & FATS',
];
```

Category assignment applies **keyword classification first, then role as fallback**. This order matters: an ingredient with `role: 'base'` that is clearly dairy (e.g., `'Greek yogurt'`) must land in DAIRY & EGGS, not PANTRY.

```
1. Apply keyword classification (name-based, overrides role). Use whole-word matching to avoid false positives (e.g., "eggplant" must not match "egg"):
   - If name matches word `egg` or `eggs`, or contains yogurt/milk/ricotta/mozzarella/feta/halloumi/quark → DAIRY & EGGS
   - If name contains salmon/tuna/shrimp/cod/sea bass/anchovy/prawn/crab/lobster → FISH
   - If name contains butter/cream/crème fraîche/ghee → DAIRY & EGGS
   - (Note: "cheese" is ambiguous — apply only if no other keyword matches to avoid false-positives
      on "cream cheese" being double-classified)

2. If no keyword matched, fall back to role:
   - protein → MEAT
   - carb → PANTRY (rice, pasta, bread, grains)
   - fat → OILS & FATS
   - vegetable → PRODUCE
   - base → PANTRY
   - seasoning → not in main list (tier 2), but if somehow in tier 3, put in PANTRY
```

This ensures DAIRY & EGGS is populated correctly regardless of the `role` field assigned by the scaler.

#### Step 5.3: Scope to next cook day

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

#### Step 5.4: Aggregation with role-aware merging

**File:** `src/shopping/generator.ts`

Update `addIngredient()` helper (line 106-124):
- Now that `ScaledIngredient` has `role`, use it for category assignment instead of hardcoding `'PANTRY'`.
- When merging duplicates, keep the more specific category (current logic at line 118 already does this, but it was meaningless before because everything was 'PANTRY').
- Case-insensitive key matching (already exists at line 113).
- **Display name preservation:** Use the lowercased name as the dedup key only; store the original-case name from the first occurrence as the display name. Do not lowercase the output `name` field. Example: key `'chicken breast'`, display name `'Chicken breast'` (as given by the recipe).
- **Unit mismatch handling:** If two ingredients match by name but have different units (e.g., `200g salmon` and `2 fillets salmon`), do NOT merge amounts. Keep them as separate line items and log a warning. Merging across units would corrupt totals.

#### Step 5.5: New shopping list data model

**File:** `src/models/types.ts`

The current `ShoppingList` interface (types.ts:234-237) supports `categories` and `customItems` but has no concept of tiers. Update:

```typescript
export interface ShoppingList {
  /** Main buy list — tier 3 ingredients grouped by category */
  categories: ShoppingCategory[];
  /** Tier 2 — "check you have" items (long-lasting pantry, seasonings) */
  checkYouHave: string[];
  /**
   * User-added custom items. Not populated by the generator in v0.0.4 — kept for future use.
   * The formatter should render this array if non-empty, but the generator always produces [].
   * Do not remove; removing would be a breaking interface change for any future custom-item feature.
   */
  customItems: string[];
}
```

Also update `ShoppingItem` to carry a display note:
```typescript
export interface ShoppingItem {
  name: string;
  amount: number;
  unit: string;
  /** Optional annotation shown after the amount, e.g. "(breakfast, 4 days)". */
  note?: string;
}
```

**Breakfast annotation logic (in `generateShoppingList()`):** When aggregating breakfast ingredients, set `note: \`(breakfast, ${remainingDays} days)\`` on the resulting `ShoppingItem`. If a breakfast ingredient name matches a cook-day ingredient (same name, case-insensitive), merge the amounts and keep the breakfast note to indicate it has a dual source. The formatter (5.6) renders the note as italic text after the amount (plain parenthetical if MarkdownV2 is not active).

Note: `formatShoppingList()` in formatters.ts uses the current `ShoppingList` shape. This must be updated in Step 5.6. The `customItems` field is intentionally preserved but will always be `[]` in v0.0.4. The formatter in Step 5.6 can render it if non-empty (forward-compatible) or simply skip it — both are acceptable.

#### Step 5.5b: Update shopping-list QA validator

**File:** `src/qa/validators/shopping-list.ts` (line 54)

The existing validator checks that every batch ingredient is present in `list.categories`. After the tier-3 overhaul, tier-1 ingredients are excluded and tier-2 ingredients move to `list.checkYouHave` — neither will appear in `list.categories`. The old validator will fail on any list that has tier-1 or tier-2 ingredients.

Update the validator to:
- Check that tier-1 ingredients (TIER_1_EXCLUSIONS) are NOT in categories (expected absence).
- Check that tier-2 items appear in `list.checkYouHave`.
- Check that tier-3 items appear in `list.categories`.

This is a required step — without it, the QA validator will reject all new shopping lists.

#### Step 5.6: Shopping list formatter

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

Breakfast items in produce/dairy get a `(breakfast, N days)` annotation (using the `ShoppingItem.note` field added in 5.5). Render the note as italic text if MarkdownV2 is active (plan 015), otherwise render as plain parenthetical: `Avocado — 4 (breakfast, 4 days)`.

#### Step 5.7: Shopping list keyboard

**File:** `src/telegram/keyboards.ts`

Add `buildShoppingListKeyboard()` function (replacing the existing `shoppingListKeyboard` exported const at line 97-99 — renamed to a function to make const-vs-call distinction clear):
- `[<- Back to plan]` with callback `na_show`.
- **Rename note:** Any import of the old `shoppingListKeyboard` const must be updated to call `buildShoppingListKeyboard()`. Search core.ts for all usages before removing the old const.

#### Step 5.8: Callback handlers

**File:** `src/telegram/core.ts`

Add `sl_` callback handlers in `handleCallback()`.

**Note on `getNextCookDay()` signature (Phase 0, plan 012):** The helper must accept a `today: string` parameter (ISO date) rather than calling `new Date()` internally. This keeps it pure and testable — the harness can inject a fixed date via `store.getToday()`. Production callers pass `new Date().toISOString().slice(0, 10)`. If plan 012 defines the helper differently, align to this interface before implementing 5.8.

```typescript
// ─── Shopping list callbacks (Phase 5) ──────────────────────
if (action.startsWith('sl_')) {
  const param = action.slice(3);  // "next" or ISO date
  // toLocalISODate is in src/plan/helpers.ts after Phase 0 (plan 012) relocates it:
  const today = toLocalISODate(new Date());
  // getPlanLifecycle signature (plan 012): (session, store, today) — 3 args:
  const lifecycle = await getPlanLifecycle(session, store, today);
  // getRunningPlanSession accepts optional today after Phase 0 (plan 012 step 7):
  const planSession = await store.getRunningPlanSession(today);
  if (!planSession) {
    // Use Phase 0 lifecycle-aware keyboard, not static mainMenuKeyboard:
    await sink.reply('No plan for this week.', { reply_markup: buildMainMenuKeyboard(lifecycle) });
    return;
  }
  // Include carry-over batches from prior plan sessions that overlap the current horizon.
  // Use the correct object-based API (not positional args):
  const ownBatches = await store.getBatchesByPlanSessionId(planSession.id);
  const overlapBatches = await store.getBatchesOverlapping({
    horizonStart: planSession.horizonStart,
    horizonEnd: planSession.horizonEnd,
    statuses: ['planned'],
  });
  // Deduplicate by id inline (dedupeById is not a library function):
  const seen = new Set<string>();
  const allBatches = [...ownBatches, ...overlapBatches].filter(b => seen.has(b.id) ? false : (seen.add(b.id), true));
  const plannedBatches = allBatches.filter(b => b.status === 'planned');
  
  let targetDate: string;
  if (param === 'next') {
    // `getNextCookDay()` accepts a `today` string parameter so the harness can inject a fixed date.
    // Use toLocalISODate() to avoid UTC midnight divergence in Europe/Madrid timezone:
    const today = toLocalISODate(new Date());
    const nextCook = getNextCookDay(plannedBatches, today);
    if (!nextCook) {
      await sink.reply('All meals are prepped — no shopping needed!');
      return;
    }
    targetDate = nextCook.date;
  } else {
    // Validate ISO date shape and that it falls within the current plan horizon.
    // Stale Telegram messages can fire callbacks from old plans — guard against this.
    // Also reject past-cook-day dates (today or earlier) — those sessions have passed.
    const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    if (!ISO_DATE_RE.test(param) || param < today || param < planSession.horizonStart || param > planSession.horizonEnd) {
      // Stale or invalid callback — show the current plan's main menu:
      await sink.reply('This shopping list is from a different plan week.', { reply_markup: buildMainMenuKeyboard(lifecycle) });
      return;
    }
    targetDate = param;
  }
  
  // Guard: if there are no cook batches for the target date, it's not a cook day.
  // This handles edge cases like forged callbacks or rest days inside the horizon.
  const cookBatchesForDay = plannedBatches.filter(b => b.eatingDays[0] === targetDate);
  if (cookBatchesForDay.length === 0 && param !== 'next') {
    // `sl_next` already validated via getNextCookDay; only guard explicit-date path:
    await sink.reply('No cooking scheduled for that day.', { reply_markup: buildMainMenuKeyboard(lifecycle) });
    return;
  }
  
  const breakfastRecipe = recipes.getBySlug(planSession.breakfast.recipeSlug);
  if (!breakfastRecipe) {
    log.warn('CORE', `breakfast recipe not found: ${planSession.breakfast.recipeSlug} — shopping list will omit breakfast`);
    // Continue — produce a cook-only list rather than failing hard; user can still shop for dinner/lunch.
  }
  // Compute remaining days inclusive (target day counts):
  const horizonEnd = new Date(planSession.horizonEnd + 'T12:00:00');
  const target = new Date(targetDate + 'T12:00:00');
  const remainingDays = Math.round((horizonEnd.getTime() - target.getTime()) / 86400000) + 1;
  
  const list = generateShoppingList(plannedBatches, breakfastRecipe, {
    targetDate,
    remainingDays,
  });
  
  // Build scope description — resolve recipe names for display:
  const cookBatches = plannedBatches.filter(b => b.eatingDays[0] === targetDate);
  const scopeParts = cookBatches.map(b => {
    const recipe = recipes.getBySlug(b.recipeSlug);
    return `${recipe?.name ?? b.recipeSlug} (${b.servings} servings)`;
  });
  if (breakfastRecipe) scopeParts.push('Breakfast');
  
  session.surfaceContext = 'shopping';
  await sink.reply(
    formatShoppingList(list, targetDate, scopeParts.join(' + ')),
    { reply_markup: buildShoppingListKeyboard() },
  );
  return;
}
```

**Note on `toLocalISODate`:** Plan 012 moves this utility from `plan-proposer.ts` to `src/plan/helpers.ts` (re-exported from `plan-proposer.ts` for backwards compatibility). Import from `src/plan/helpers.ts` in all 016 code. Do not use `new Date().toISOString().slice(0, 10)` which gives UTC midnight (wrong near midnight in Europe/Madrid).

---

## Progress

### Phase 1 — Pre-work
- [ ] Export `BatchView` interface from `src/models/types.ts`

### Phase 2 — ScaledIngredient role enrichment
- [ ] 2.0: Normalize `fromBatchRow` in store.ts with `role ?? 'base'` fallback for old Supabase rows
- [ ] 2.1: Add `role: IngredientRole` to `ScaledIngredient` interface in types.ts
- [ ] 2.2: Update recipe-scaler.ts output mapping with post-hoc name matching
- [ ] 2.3: Update plan-flow.ts scaler fallback path to include `role`
- [ ] 2.4: Add `role` to all seeded `scaledIngredients` in scenario spec files
- [ ] 2.5: Regenerate affected scenario recordings and verify diffs
- [ ] 2.6: `npm test` passes

### Phase 3 — Plan View Screens + Navigation
- [ ] 3.1: Next Action formatter in formatters.ts
- [ ] 3.2: Next Action keyboard in keyboards.ts
- [ ] 3.3: Week Overview formatter in formatters.ts
- [ ] 3.4: Week Overview keyboard in keyboards.ts
- [ ] 3.5: Day Detail formatter in formatters.ts
- [ ] 3.6: Day Detail keyboard in keyboards.ts
- [ ] 3.7: Post-confirmation bridge (plan-flow.ts return data + formatter + keyboard)
- [ ] 3.8: Plan view callback handlers in core.ts (`na_show`, `wo_show`, `dd_*`)
- [ ] 3.9: Menu routing updates (lifecycle-aware `plan_week` + `shopping_list` cases)

### Phase 4 — Recipe Display Contexts
- [ ] 4.1: Cook-time recipe renderer (`renderCookView()`) in renderer.ts
- [ ] 4.2: Cook view keyboard in keyboards.ts
- [ ] 4.3: Cook view callback handler (`cv_*`) in core.ts
- [ ] 4.4: Recipe library plan-aware redesign (Cooking Soon section in `showRecipeList()` + keyboard)
- [ ] 4.5: Library view placeholder resolution in `renderRecipe()` (blocked on Task 2)

### Phase 5 — Shopping List Overhaul
- [ ] 5.1: Three-tier ingredient intelligence (tier definitions + classification)
- [ ] 5.2: Category grouping (PRODUCE, FISH, MEAT, DAIRY & EGGS, PANTRY, OILS & FATS)
- [ ] 5.3: Scope to next cook day (rewrite `generateShoppingList()` signature + filtering)
- [ ] 5.4: Aggregation with role-aware merging
- [ ] 5.5: Update `ShoppingList` interface with `checkYouHave` field + add `note?` to `ShoppingItem`
- [ ] 5.5b: Update shopping-list QA validator for three-tier structure
- [ ] 5.6: Shopping list formatter (replace `formatShoppingList()`)
- [ ] 5.7: Shopping list keyboard (rename to `buildShoppingListKeyboard()`, update all call sites)
- [ ] 5.8: `sl_*` callback handlers in core.ts

### Phase 6 — New scenarios + final validation
- [ ] Author `test/scenarios/018-plan-view-navigation/spec.ts` (seed + events per Validation § V3)
- [ ] `npm run test:generate -- 018-plan-view-navigation` + verify recorded outputs
- [ ] Author `test/scenarios/019-shopping-list-tiered/spec.ts`
- [ ] `npm run test:generate -- 019-shopping-list-tiered` + verify tier-1/2/3 + breakfast annotation in recorded outputs
- [ ] Regenerate `001-plan-week-happy-path` after 3.7 (post-confirm message changes)
- [ ] `npm test` passes — all scenarios green
- [ ] Update `test/scenarios/index.md` with rows for 018 and 019

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

- **Decision:** `ScaledIngredient` role enrichment (Phase 2) must land before any UI work (Phases 3–5).
  **Rationale:** The interface change to `ScaledIngredient` is a breaking change that affects scenario seeds, the scaler, and plan-flow. Landing it first as an isolated phase avoids type errors and ensures `npm test` stays green for all subsequent phases.
  **Date:** 2026-04-07

- **Decision:** Shopping list breakfast proration uses remaining plan days (not full week).
  **Rationale:** If the user shops on Thursday with 4 remaining days, they need 4 avocados, not 7. This is stateless — no tracking of prior shopping lists needed. The user removes what they already have during manual reconciliation (per ui-architecture.md line 395).
  **Date:** 2026-04-07

- **Decision:** Day buttons in Week Overview use `dd_{ISO date}` callback, not `dd_mon`/`dd_tue` abbreviations.
  **Rationale:** ISO dates are unambiguous across plan horizons. Abbreviations require resolving which week's Monday is meant. ISO dates are 10 chars; with `dd_` prefix = 13 bytes, well within 64-byte limit.
  **Date:** 2026-04-07

---

## Validation

### V1 — Baseline before any work starts

Run `npm test` and confirm it is green. If it is not, stop and fix the existing failure before starting.

---

### V2 — After Phase 2 (role enrichment)

Steps 2.0–2.5 change `ScaledIngredient` (interface + store normalization + scaler output) and update every scenario spec seed. After these steps:

1. Update the 5 spec files listed in 2.4 with `role` on every seeded `scaledIngredients` entry.
2. Run regeneration for ALL scenarios that persist batches (the scaler now emits `role` in new recordings):
   ```bash
   npm run test:generate -- 001-plan-week-happy-path --regenerate
   npm run test:generate -- 002-plan-week-flex-move-regression --regenerate
   npm run test:generate -- 003-plan-week-minimal-recipes --regenerate
   npm run test:generate -- 004-rolling-first-plan --regenerate
   npm run test:generate -- 005-rolling-continuous --regenerate
   npm run test:generate -- 006-rolling-gap-vacation --regenerate
   npm run test:generate -- 008-rolling-flex-move-at-edge --regenerate
   npm run test:generate -- 009-rolling-swap-recipe-with-carryover --regenerate
   npm run test:generate -- 010-rolling-events-with-carryover --regenerate
   npm run test:generate -- 011-rolling-replan-future-only --regenerate
   npm run test:generate -- 012-rolling-replan-abandon --regenerate
   npm run test:generate -- 013-flex-move-rebatch-carryover --regenerate
   npm run test:generate -- 014-proposer-orphan-fill --regenerate
   ```
   **Apply fixture edits for 014** after regeneration (see `test/scenarios/014-proposer-orphan-fill/fixture-edits.md`), then run `npm run test:replay -- 014-proposer-orphan-fill` (NOT `--regenerate` — regenerating after fixture edits would destroy them; see CLAUDE.md).
3. For each regenerated recording, verify via `git diff recorded.json` that only `scaledIngredients` arrays changed (added `role` fields). If any message text, keyboard shapes, or non-ingredient store fields changed, stop and investigate.
4. Run `npm test` — all scenarios must pass.

---

### V3 — New scenarios (one per new code surface)

The new plan view, cook view, and shopping list handlers are pure callback handlers (no LLM calls). These scenarios run at no cost in generate mode and need only seeded store state to exercise the new code.

#### Shared seed data

Both scenarios below use the same active plan seed. Define this as shared constants at the top of each spec file.

**Session** (`horizonStart: 2026-04-06`, `horizonEnd: 2026-04-12`, clock `2026-04-08` = Wed, `active_mid` lifecycle):

```typescript
const activeSession: PlanSession = {
  id: 'session-016-0000-0000-0000-000000000001',
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
```

**Batches** — 4 batches covering Mon–Sat (Sun covered by flex + event). Cook days: Mon Apr 6 (past) and Thu Apr 9 (upcoming from clock's perspective of Wed Apr 8). Seeded ingredients must include `role` on every entry per the Phase 2 interface change:

```typescript
const activeBatches: Batch[] = [
  // Batch 1: Mon-Tue-Wed Lunch. Cook day = Apr 6 (past — reheat on clock date Apr 8).
  {
    id: 'batch-016-lunch1-0000-0000-000000000001',
    recipeSlug: 'chicken-black-bean-avocado-rice-bowl',
    mealType: 'lunch',
    eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
    servings: 3,
    targetPerServing: { calories: 893, protein: 56 },
    actualPerServing: { calories: 893, protein: 56, fat: 46, carbs: 68 },
    scaledIngredients: [
      { name: 'chicken breast, raw', amount: 190, unit: 'g', totalForBatch: 570, role: 'protein' },
      { name: 'black beans, canned, drained', amount: 75, unit: 'g', totalForBatch: 225, role: 'carb' },
      { name: 'small avocado', amount: 1, unit: 'whole', totalForBatch: 3, role: 'fat' },
      { name: 'olive oil', amount: 22, unit: 'ml', totalForBatch: 66, role: 'fat' },
      { name: 'smoked paprika', amount: 1, unit: 'tsp', totalForBatch: 3, role: 'seasoning' },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
  // Batch 2: Mon-Tue-Wed Dinner. Cook day = Apr 6 (past — reheat on clock date).
  {
    id: 'batch-016-dinner1-0000-0000-000000000002',
    recipeSlug: 'moroccan-beef-tagine-style-skillet-with-lemon-couscous',
    mealType: 'dinner',
    eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
    servings: 3,
    targetPerServing: { calories: 720, protein: 48 },
    actualPerServing: { calories: 720, protein: 48, fat: 28, carbs: 72 },
    scaledIngredients: [
      { name: 'ground beef', amount: 200, unit: 'g', totalForBatch: 600, role: 'protein' },
      { name: 'couscous', amount: 80, unit: 'g', totalForBatch: 240, role: 'carb' },
      { name: 'olive oil', amount: 15, unit: 'ml', totalForBatch: 45, role: 'fat' },
      { name: 'salt', amount: 0, unit: '', totalForBatch: 0, role: 'seasoning' },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
  // Batch 3: Thu-Fri-Sat Lunch. Cook day = Apr 9 (UPCOMING — next cook day from Apr 8).
  {
    id: 'batch-016-lunch2-0000-0000-000000000003',
    recipeSlug: 'ground-beef-rigatoni-bolognese',
    mealType: 'lunch',
    eatingDays: ['2026-04-09', '2026-04-10', '2026-04-11'],
    servings: 3,
    targetPerServing: { calories: 780, protein: 52 },
    actualPerServing: { calories: 780, protein: 52, fat: 32, carbs: 78 },
    scaledIngredients: [
      { name: 'ground beef', amount: 180, unit: 'g', totalForBatch: 540, role: 'protein' },
      { name: 'rigatoni', amount: 90, unit: 'g', totalForBatch: 270, role: 'carb' },
      { name: 'cherry tomatoes', amount: 150, unit: 'g', totalForBatch: 450, role: 'vegetable' },
      { name: 'olive oil', amount: 15, unit: 'ml', totalForBatch: 45, role: 'fat' },
      { name: 'black pepper', amount: 0, unit: '', totalForBatch: 0, role: 'seasoning' },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
  // Batch 4: Thu-Fri-Sat Dinner. Cook day = Apr 9 (UPCOMING).
  {
    id: 'batch-016-dinner2-0000-0000-000000000004',
    recipeSlug: 'soy-ginger-pork-rice-bowls-broccoli-carrots-scallions',
    mealType: 'dinner',
    eatingDays: ['2026-04-09', '2026-04-10', '2026-04-11'],
    servings: 3,
    targetPerServing: { calories: 650, protein: 44 },
    actualPerServing: { calories: 650, protein: 44, fat: 22, carbs: 65 },
    scaledIngredients: [
      { name: 'pork tenderloin', amount: 180, unit: 'g', totalForBatch: 540, role: 'protein' },
      { name: 'broccoli', amount: 100, unit: 'g', totalForBatch: 300, role: 'vegetable' },
      { name: 'basmati rice', amount: 80, unit: 'g', totalForBatch: 240, role: 'carb' },
      { name: 'soy sauce', amount: 20, unit: 'ml', totalForBatch: 60, role: 'seasoning' },
      { name: 'sesame oil', amount: 10, unit: 'ml', totalForBatch: 30, role: 'fat' },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
];
```

> **Slot coverage:** Mon-Wed: Batches 1+2 (lunch + dinner). Thu-Sat: Batches 3+4 (lunch + dinner). Sun: FlexSlot (lunch) + Event (dinner). All 14 slots covered.

> **UUID note:** Batch IDs above are UUID-shaped strings. The harness normalizes them to `{{uuid:N}}` tokens in `recorded.json`. When writing `click('cv_batch-016-lunch2-0000-0000-000000000003')`, the recording will show `cv_{{uuid:2}}`. This is correct — the relationship between the seed ID and the callback is preserved in the normalized form.

---

#### Scenario 018: `018-plan-view-navigation`

**Purpose:** Exercises plan view screens (Next Action, Week Overview, Day Detail) and cook view, connected through the natural navigation flow.

**Clock:** `2026-04-08T10:00:00Z` (Wednesday — `active_mid` lifecycle, next cook day = Thu Apr 9)

**recipeSet:** `six-balanced`

**Events:**
```typescript
events: [
  text('📋 My Plan'),                     // handleMenu 'plan_week' → active_mid → na_show handler
  click('wo_show'),                        // Week Overview
  click('dd_2026-04-09'),                  // Day Detail — Thu Apr 9 (upcoming cook day, shows 🔪 buttons)
  click('cv_batch-016-lunch2-0000-0000-000000000003'),  // Cook view: Ground Beef Rigatoni lunch
  click('na_show'),                        // Back to Next Action
]
```

**After generating, verify these outputs in recorded.json:**
- `text('📋 My Plan')` → Next Action message shows:
  - Wed Apr 8 meals as reheat (Batch 1 lunch, Batch 2 dinner, both cooked Mon)
  - Thu Apr 9 meals with "Cook" marker (Batch 3 lunch, Batch 4 dinner — upcoming)
  - Keyboard has `[🔪 Ground Beef Rigatoni Bolognese — 3 servings]` (or similar) + `[Get shopping list]` + `[View full week]`
- `click('wo_show')` → Week Overview message shows all 7 days Mon–Sun, with Mon–Sat meal names, Flex on Sun lunch, Event on Sun dinner. Back button present.
- `click('dd_2026-04-09')` → Day Detail for Thu Apr 9 shows lunch + dinner both as cook meals. Keyboard has two `🔪` buttons (one per batch) + `[Get shopping list]` + `[Back to week]`.
- `click('cv_...')` → Cook view shows Ground Beef Rigatoni recipe header, ingredients list with batch totals, recipe body. Keyboard has `[Back to plan]` + `[Edit this recipe]` + `[View in my recipes]`.
- `click('na_show')` → Returns to Next Action message (same as first output).

---

#### Scenario 019: `019-shopping-list-tiered`

**Purpose:** Exercises shopping list — `sl_next` path from main menu and `sl_{date}` path from a direct callback — verifying three-tier ingredient output and breakfast annotation.

**Clock:** `2026-04-08T10:00:00Z`

**recipeSet:** `six-balanced`

**Events:**
```typescript
events: [
  text('🛒 Shopping List'),               // handleMenu 'shopping_list' → active_mid → sl_next
  click('sl_2026-04-09'),                 // Direct date-scoped: same cook day, explicit path
  click('na_show'),                       // Back to Next Action (from second shopping list)
]
```

**After generating, verify these outputs in recorded.json:**
- `text('🛒 Shopping List')` → Shopping list message scoped to Thu Apr 9 cook day (next cook day from Apr 8). Verify:
  - Header: something like `What you'll need — Thursday Apr 9`
  - Scope line: mentions `Ground Beef Rigatoni Bolognese (3 servings)` + `Soy-Ginger Pork (3 servings)` + `Breakfast`
  - **Tier 1 absent:** `salt`, `black pepper`, `water` not in the list at all
  - **Tier 2 present:** `checkYouHave` in `finalStore` OR in message text — smoked paprika, soy sauce, sesame oil (seasonings/pantry oils)
  - **Tier 3 grouped:** PRODUCE section (broccoli, cherry tomatoes), MEAT section (ground beef, pork tenderloin), PANTRY section (rigatoni, basmati rice, couscous if included), OILS & FATS if olive oil not tier-2'd
  - **Breakfast annotated:** Breakfast ingredients (salmon, avocado, eggs from the breakfast recipe) appear with `(breakfast, 4 days)` note (remainingDays = Apr 9–12 = 4 days)
  - Keyboard: `[Back to plan]` button only
- `click('sl_2026-04-09')` → Same scoped list (explicit date, same cook day as `sl_next` result)
- `click('na_show')` → Next Action screen (same content as scenario 018's first output)

> **Breakfast ingredients note:** The seeded session uses `salmon-avocado-toast-soft-eggs-cinnamon-yogurt` as breakfast. Load that fixture recipe from `test/fixtures/recipes/six-balanced/` and manually confirm which of its ingredients appear in the shopping list output and which are excluded (tier 1 = salt/pepper/water).

---

#### Scenario 001 regeneration after Step 3.7

Step 3.7 changes the post-confirmation message (currently "Plan locked for ... Shopping list ready." with two stub buttons). After 3.7 is implemented, the output of `click('plan_approve')` in scenario 001 changes. Regenerate:

```bash
npm run test:generate -- 001-plan-week-happy-path --regenerate
```

Verify that only the post-confirmation reply changed (text + keyboard). All prior messages in the transcript must be unchanged.

---

### V4 — Full npm test after all phases complete

After all phases finish:

```bash
npm test
```

All scenarios must pass, including the two new 018 and 019 scenarios.

---

### V5 — Manual Telegram verification (`npm run dev`)

Reserve for the final UX sanity check — not the primary feedback loop:

- Main menu `[My Plan]` → Next Action renders correctly on phone
- `[View full week]` → Week Overview day buttons are correct layout
- Cook view renders recipe body readable without formatting
- Shopping list: long-press to copy, paste into Notes — confirm the plain text copies cleanly
- Back navigation works across all surfaces (na_show, wo_show, recipe_back)

---

### Update `test/scenarios/index.md`

After scenarios 018 and 019 are authored, add them to the table:

| # | Name | What it tests |
|---|------|---------------|
| 018 | plan-view-navigation | Active-plan navigation: My Plan → Next Action → Week Overview → Day Detail → Cook view → back to plan. Exercises plan view screens and cook view handler. |
| 019 | shopping-list-tiered | Three-tier shopping list: sl_next + sl_{date} with role-enriched ingredients. Verifies tier-1 exclusion, tier-2 checkYouHave, tier-3 category grouping, and breakfast annotation. |
