# v0.0.4 Task Breakdown — Agent Execution Plan

> Scope: Task decomposition of v0.0.4 (UI/UX overhaul) for parallel agent execution. Tasks are either **isolated** (one agent, no coordination needed) or **coordinated** (a group of agents that share interfaces and must communicate). See [BACKLOG.md](./BACKLOG.md) for the full roadmap, [product-specs/ui-architecture.md](./product-specs/ui-architecture.md) for the design spec.

## How to read this

- **Phase 0** is shared infrastructure that multiple tasks depend on. It must land first.
- **Isolated tasks** can be picked up by a single agent after Phase 0 (unless explicitly marked as independent of Phase 0). They touch code that no other v0.0.4 task modifies.
- **Coordinated group** tasks share files, interfaces, or navigation paths. Agents working on these MUST communicate to avoid conflicts. The shared contract section defines what they agree on before starting.
- **Execution order** matters: some tasks are prerequisites for others. This is marked explicitly.

---

## Phase 0: Shared Infrastructure

**What:** Extract the foundational pieces that multiple tasks depend on. This is not a feature — it's the shared substrate that lets isolated and coordinated tasks proceed in parallel without stepping on each other.

**Why this exists:** The current codebase has a static `mainMenuKeyboard` (keyboards.ts:33), text-matching for only `'📋 Plan Week'` (core.ts:886), and `handleMenu()` that destroys `session.planFlow` on every menu tap (core.ts:643-644). Multiple tasks need the menu to be lifecycle-driven, the session to track surface context, and plan data helpers to exist. Building these independently creates merge conflicts and duplicated logic.

**Scope:**

1. **Plan lifecycle detection:**
   - New utility (e.g., `src/plan/helpers.ts`) that computes lifecycle state from store + session:
     - `no_plan` — no running session, no planFlow in progress.
     - `planning` — `session.planFlow` is non-null.
     - `active_early` — running session exists, `today - horizonStart` ≤ 1 day (day 0-1 of the plan).
     - `active_mid` — running session, `today - horizonStart` is 2-4 days (day 2-4).
     - `active_ending` — running session, `horizonEnd - today` ≤ 1 day (1-2 days remaining).
   - All lifecycle stages use **horizon position** (today relative to horizonStart/horizonEnd), NOT confirmation age. A plan confirmed on Saturday for next Monday starts as `active_early` on Monday, not on Saturday.
   - Helper: `getPlanLifecycle(session, store, today)` → lifecycle enum.

2. **Dynamic main menu keyboard:**
   - Replace static `mainMenuKeyboard` const with `buildMainMenuKeyboard(lifecycle)` function.
   - Label map: `no_plan` → "📋 Plan Week", `planning` → "📋 Resume Plan", `active_*` → "📋 My Plan".
   - Bottom-right: "📊 Progress" (replaces "📊 Weekly Budget").
   - Update every `{ reply_markup: mainMenuKeyboard }` call site in core.ts to use the function.

3. **Menu text matching:**
   - Update `matchMainMenu()` to recognize all lifecycle labels: "📋 Plan Week", "📋 Resume Plan", "📋 My Plan" all map to `plan_week`.
   - "📊 Progress" maps to `progress` (new action).
   - "📊 Weekly Budget" kept as fallback alias during transition.

4. **Fix handleMenu() plan flow destruction:**
   - `handleMenu()` currently does `session.planFlow = null` unconditionally (core.ts:643). This destroys in-progress planning when the user taps any menu button — including [Resume Plan].
   - Fix: only clear `planFlow` when the action explicitly starts a different flow. When `action === 'plan_week'` and `session.planFlow` exists, resume the flow instead of restarting.

5. **Session surface context:**
   - Add `surfaceContext` to `BotCoreSession`: `'plan' | 'cooking' | 'shopping' | 'recipes' | 'progress' | null`.
   - Add `lastRecipeSlug?: string` for the free-text fallback to know if the user has a recipe on screen. Set when entering EITHER cook view (`surfaceContext = 'cooking'`) OR library recipe view (`surfaceContext = 'recipes'`). Both are "recipe on screen" contexts for the free-text fallback.
   - Set `surfaceContext` when entering each surface.
   - **Back-button navigation is deterministic, not stack-based.** Each back button has a hardcoded destination based on where the user is:
     - Cook view `[← Back to plan]` → `surfaceContext = 'plan'`
     - Day Detail `[← Back to week]` → `surfaceContext = 'plan'`
     - Week Overview `[← Back]` → `surfaceContext = 'plan'`
     - Shopping list `[← Back to plan]` → `surfaceContext = 'plan'`
     - Cook view `[View in my recipes]` → `surfaceContext = 'recipes'`
   - No navigation stack or `previousSurfaceContext` needed — the back destination is always known from the current screen. This keeps session state flat and avoids stale-stack bugs.

6. **Plan data helpers** (in `src/plan/helpers.ts` alongside lifecycle):
   - `getNextCookDay(batches, today)` → `{ date, batches: Batch[] }` or null.
   - `getCookDaysForWeek(batches)` → `{ date, batches: Batch[] }[]`.
   - `getBatchForMeal(batches, date, mealType)` → batch info with cook-or-reheat status.
   - `isReheat(batch, date)` → boolean (date > eatingDays[0]).
   - `getServingNumber(batch, date)` → e.g., "serving 2 of 3".
   - `getDayRange(batch)` → first through last eating day.

7. **Store: getBatch(id) method:**
   - `StateStoreLike` currently has no single-batch lookup by ID (only `getBatchesOverlapping`, `getBatchesByPlanSessionId`). The `cv_{batchId}` cook view callback needs this.
   - Add `getBatch(id: string): Promise<Batch | null>` to `StateStoreLike`.
   - Implement in `src/state/store.ts` (Supabase: `select * from batches where id = $1`) and `src/harness/test-store.ts` (in-memory: find by id in the batches array).

8. **Callback data prefix registry:**
   - Document (as a comment block in keyboards.ts) all callback prefixes, existing and new:
     - Existing: `rv_` (recipe view), `rd_` (recipe delete), `re_` (recipe edit), `rp_` (recipe page)
     - New: `na_` (next action), `wo_` (week overview), `dd_` (day detail, e.g. `dd_mon`), `cv_` (cook view), `sl_` (shopping list), `pg_` (progress)

**Key files:**
- `src/plan/helpers.ts` — NEW: lifecycle detection + plan data helpers
- `src/telegram/keyboards.ts` — dynamic menu function, prefix registry
- `src/telegram/core.ts` — matchMainMenu update, handleMenu fix, surfaceContext on session
- `src/models/types.ts` — BotCoreSession update (if session type lives here)
- `src/state/store.ts` — add `getBatch(id)` to StateStoreLike + Supabase implementation
- `src/harness/test-store.ts` — add `getBatch(id)` to TestStateStore

**Acceptance:**
- `mainMenuKeyboard` is no longer a static const — it's a function of lifecycle state.
- `matchMainMenu()` recognizes all label variants.
- Tapping [Resume Plan] during an in-progress planning session resumes (does NOT destroy `session.planFlow`).
- Plan data helpers are importable and tested (or at minimum, type-checked).
- `npm test` passes (existing scenarios still work — they always start with no plan, so they get "Plan Week" label as before).

---

## Isolated Task 1: Progress Screen

**What:** Build the entire Progress feature end-to-end — measurement input, daily confirmation, weekly report, disambiguation logic.

**Why isolated:** Touches no plan view code, no recipe code, no shopping code. The menu button rename and `progress` action routing land in Phase 0. This task only adds the feature logic behind that route.

**Depends on:** Phase 0 (for `progress` menu action and `surfaceContext`).

**Spec:** `ui-architecture.md` § Screen: Progress (serves D2)

**Scope:**

1. **Measurement persistence:**
   - New `measurements` table in Supabase schema. Add to `supabase/schema.sql`:
     ```sql
     create table measurements (
       id         uuid primary key,
       user_id    text not null,
       date       date not null,
       weight_kg  numeric(5,2) not null,
       waist_cm   numeric(5,2),
       created_at timestamptz default now()
     );
     create unique index measurements_user_date on measurements (user_id, date);
     ```
   - Add SQL migration in `supabase/migrations/`.
   - Extend `StateStoreLike` interface with measurement methods:
     - `logMeasurement(userId, date, weight, waist?)` → upsert for the day.
     - `getTodayMeasurement(userId, date)` → measurement or null.
     - `getWeekMeasurements(userId, weekStart, weekEnd)` → measurement[].
     - `getLastWeekMeasurements(userId, prevWeekStart, prevWeekEnd)` → measurement[].
     - `getLatestMeasurement(userId)` → most recent measurement (for disambiguation).
   - Implement in `src/state/store.ts` (Supabase) and `src/harness/test-store.ts` (in-memory).

2. **Progress flow with explicit phase state:**
   - New `progress` case in `handleMenu()`.
   - Set `surfaceContext = 'progress'`.
   - Add `progressFlow` to `BotCoreSession`:
     ```typescript
     progressFlow: {
       phase: 'awaiting_measurement' | 'confirming_disambiguation' | null;
       pendingWeight?: number;
       pendingWaist?: number;
     } | null;
     ```
   - **Why a flow state, not just surfaceContext:** After "Already logged today ✓" or after a successful log, `surfaceContext` is still `'progress'`. Without a phase, any subsequent text would be parsed as measurement input. The flow state makes input expectation explicit:
     - `awaiting_measurement` → parse incoming text as numbers.
     - `confirming_disambiguation` → parse "yes"/"no" or corrected values.
     - `null` (or no progressFlow) → text goes to normal dispatch (recipe lookup, fallback).
   - If no measurement today → set `progressFlow.phase = 'awaiting_measurement'`, show input prompt.
   - If already logged today → `progressFlow = null`, show "Already logged today ✓" + `[Last weekly report]` button.
   - After successful logging → `progressFlow = null`, show confirmation. Subsequent text is NOT hijacked.

3. **Natural-language input parsing:**
   - Parse "82.3 / 91", "82.3 91", "82.3, 91", or just "82.3".
   - Disambiguation: if two numbers and previous measurements exist, use them to resolve which is weight vs waist. If genuinely ambiguous (first entry, or numbers are close), ask once.
   - Waist is optional — weight-only is first-class.

4. **Time-aware prompt:**
   - If local time is afternoon (after 14:00), add: "If this is your morning weight, drop it here."
   - Morning: just "Drop your weight (and waist if you track it):"

5. **Daily response:**
   - "Logged ✓ 82.3 kg / 91 cm" or "Logged ✓ 82.3 kg" (weight-only).
   - No mid-week stats, no averages, no comparisons.

6. **Weekly report:**
   - Computed on request via `[Last weekly report]` inline button (callback: `pg_last_report`).
   - Handle `pg_last_report` callback in core.ts: query measurements for the last completed calendar week + the week before, compute averages, format report with tone-appropriate copy.
   - Weekly averages compared to last week's averages.
   - Tone adapts to scenario — see spec for exact copy per scenario (steady loss, fast loss, plateau, gain).
   - Weekly boundaries are **calendar weeks (Mon–Sun)**, independent of the plan horizon. Progress tracking is not tied to meal planning — a user can log weight without an active plan.
   - **`pg_last_report` behavior (three cases):**
     1. **Completed week with data exists:** Show the most recent completed weekly report. Append "_Next report ready Sunday._" at the bottom so the user knows when fresh data arrives.
     2. **No completed week with data yet** (user started logging this week): "Not enough data for a report yet — keep logging and your first report will be ready Sunday."
     3. **No measurements at all:** This button shouldn't appear (only show `[Last weekly report]` when at least one measurement exists). If somehow reached: same message as case 2.
   - **Trigger design:** The weekly report is NOT proactively pushed (no cron/scheduler needed for v0.0.4). It's computed on demand when the user taps `[Last weekly report]`. Proactive delivery is v0.0.6 (week-end review). This avoids the need for a scheduling mechanism that doesn't exist in the codebase.

**Key files:**
- `supabase/schema.sql` — add measurements table
- `supabase/migrations/` — new migration file
- `src/state/store.ts` — measurement methods
- `src/harness/test-store.ts` — in-memory measurement storage
- `src/telegram/core.ts` — progress dispatch + input parsing
- `src/telegram/formatters.ts` — measurement confirmation + weekly report formatter

**Acceptance:**
- User taps [Progress], types "82.3 / 91", sees "Logged ✓ 82.3 kg / 91 cm".
- Tapping [Progress] again same day: "Already logged today ✓".
- `[Last weekly report]` shows weekly averages with correct tone.
- Disambiguation asks when ambiguous, resolves silently when prior data exists.
- `npm test` passes. A test scenario covers the logging + replay flow.

---

## Isolated Task 2: Recipe Format Evolution

**What:** Update the recipe model, generator prompt, parser, and QA validator to support short names, ingredient placeholders in steps, step-by-step timing, and grouped seasonings.

**Why isolated:** Changes the recipe *format* — the data layer that other tasks consume. No UI rendering changes here (that's the coordinated group's job). This task produces the new recipe shape; other tasks read it.

**Depends on:** Nothing. Can start immediately. (Phase 0 is not a dependency for this task.)

**IMPORTANT: This is a prerequisite for Coordinated Agent B (Recipe Display Contexts).** Must land before cook-time recipe rendering can resolve placeholders. Can run in parallel with Phase 0 and other isolated tasks.

**Spec:** `ui-architecture.md` § Cook-Time Recipe + Recipe naming; `BACKLOG.md` § Recipe generation prompt updates

**Scope:**

1. **Short names (~25 chars):**
   - Add optional `shortName?: string` field to the Recipe interface in `src/models/types.ts`. Optional so existing recipes parse without breaking.
   - Update YAML frontmatter parsing in `src/recipes/parser.ts` to read/write `short_name`.
   - Update recipe generator prompt in `src/agents/recipe-generator.ts` to produce `short_name`.
   - Consumers use `recipe.shortName ?? recipe.name` for compact display (fallback until all recipes have short names).
   - Backfill existing recipes in BOTH `recipes/` AND `test/fixtures/recipes/` with short names.

2. **Ingredient placeholders `{ingredient_name}` in steps:**
   - Update recipe generator prompt to use `{ingredient_name}` placeholders in the markdown body (steps) instead of hardcoded amounts.
   - Plain-text seasonings (salt, pepper) stay as-is — no placeholder.
   - The placeholder name must exactly match an ingredient's `name` field in YAML frontmatter.
   - No rendering changes here — the renderer resolves placeholders later (Agent B's job).

3. **Step-by-step timing:**
   - Update recipe generator prompt: every heat step must include an explicit duration.
   - No "until golden" without a time anchor.

4. **Grouped seasonings — display and prompt only, no schema change:**
   - The `RecipeIngredient` interface keeps its existing shape (`amount: number`, `unit: string`). Individual seasonings remain separate entries in the YAML `ingredients` array so they're available for shopping list aggregation and scaling.
   - The change is in the **recipe generator prompt** and the **recipe body/steps**: the generated markdown body groups to-taste seasonings on one line in the prose (e.g., "Season with salt, pepper, and chili flakes"). The YAML ingredients list still has them as separate entries.
   - Only seasonings with specific amounts (e.g., "2 tsp smoked paprika") get called out individually in the steps.
   - The ingredient list section of the rendered recipe can group `role: seasoning` items with no meaningful amount onto one line — but that's a rendering concern for Agent B, not a schema concern for this task.

5. **QA validation for placeholders:**
   - Update `src/qa/validators/recipe.ts`: verify every `{placeholder}` in the recipe body matches an ingredient `name` in the YAML frontmatter. A broken placeholder = QA failure.
   - Validate `short_name` presence (warn if missing, don't fail — migration period).
   - Validate short_name length (≤ 25 chars).

**Key files:**
- `src/models/types.ts` — Recipe interface (add optional `shortName`)
- `src/recipes/parser.ts` — YAML serialization for `short_name`
- `src/agents/recipe-generator.ts` — generation prompt (short names, placeholders, timing, grouped seasonings in prose)
- `src/qa/validators/recipe.ts` — placeholder + short name validation
- `recipes/*.md` — backfill with short names
- `test/fixtures/recipes/**/*.md` — backfill with short names

**NOT in scope:**
- `src/agents/recipe-scaler.ts` — the scaler returns `ScaleRecipeOutput` (scaledIngredients + actualPerServing), not a Recipe object. There is no recipe metadata to preserve. ShortName lives on the Recipe in the DB, untouched by scaling.

**Acceptance:**
- `npm test` passes (existing scenarios still work with updated parser — `shortName` is optional).
- New recipes from the generator have `short_name`, `{placeholders}` in steps, time on every heat step, grouped seasonings in prose.
- QA validator catches mismatched placeholders.
- Existing recipes in both `recipes/` and `test/fixtures/recipes/` parse correctly and have short names backfilled.

---

## Isolated Task 3: Copy and Messaging Quality Pass + Free-Text Fallback

**What:** Two sub-tasks bundled because they both sweep across all message copy:
1. Telegram markdown formatting, jargon removal, and tone alignment across ALL messages.
2. Lifecycle-aware free-text fallback — a small routing addition in core.ts.

**Why bundled:** The free-text fallback IS a routing change (replaces the current generic one-liner at core.ts:865), not just a copy edit. But it's small, touches the same code as the copy pass, and depends on the same prerequisite (Phase 0 `surfaceContext` + lifecycle detection). Keeping them together avoids a separate task for 15 lines of dispatch logic.

**Depends on:** ALL other tasks must land first. This is a final polish pass. If run before other tasks, it polishes messages that will be rewritten.

**Spec:** `ui-architecture.md` § Copy and messaging tone + § Freeform conversation layer (v0.0.4 portion)

**Scope:**

1. **Telegram markdown formatting:**
   - Audit every message the product sends (all formatters, all flow handler responses, all inline prompts).
   - Apply hierarchy: **bold** for headers/names/key numbers, _italic_ for secondary context, `monospace` for amounts sparingly.
   - Don't over-format. Guide the eye, don't decorate.

2. **Jargon removal:**
   - Purge from all user-facing copy: "active plan", "plan session", "cook session", "template", "scaled", "batch target", "batch", "solver", "QA".
   - Replace with user language: "my plan", "my recipes", "what I'm cooking".

3. **Tone alignment:**
   - Calm, brief, action-oriented, non-judgmental.
   - No exclamation marks on routine actions.
   - No calorie-forward messaging.
   - No guilt or urgency.
   - See spec for full avoid list.

4. **Lifecycle-aware free-text fallback:**
   - Replace the current generic fallback at core.ts:865 (`'Use the menu buttons below to get started.'`).
   - Use Phase 0's `getPlanLifecycle()` and `session.surfaceContext` to select the response:
     - **no_plan:** "I can help you plan your week, browse recipes, or log measurements. Tap Plan Week to get started."
     - **active plan, no surface context:** "I can help with your plan, recipes, shopping, or measurements. Try: 'change Thursday dinner' or tap a button."
     - **recipe on screen** (`lastRecipeSlug` is set AND `surfaceContext` is `'cooking'` OR `'recipes'`): "I can help with this recipe or your plan. Try: 'can I freeze this?' or tap a button." Both cook view and library recipe view count as "recipe on screen" — the user has a recipe visible in either case.
   - Don't promise capabilities that don't exist yet (full freeform conversation is v0.0.5).
   - This replaces the existing fallback — it's ~15 lines of lifecycle/context dispatch, not a new flow.

**Key files:**
- `src/telegram/formatters.ts` — all formatters
- `src/telegram/core.ts` — free-text fallback replacement
- `src/agents/plan-flow.ts` — flow response messages
- `src/agents/recipe-flow.ts` — flow response messages
- `src/recipes/renderer.ts` — recipe display copy
- `src/telegram/keyboards.ts` — button labels (if any jargon)

**Acceptance:**
- No internal jargon in any user-visible text.
- Markdown formatting is consistent and readable across all screens.
- Free-text during an active plan outside a flow returns a helpful lifecycle-aware message (not the generic "Use the menu buttons").
- Free-text while viewing a recipe mentions the recipe context.
- `npm test` passes (scenario recordings will likely need regeneration due to copy changes).

---

## Coordinated Group: Plan-Aware UI System

These three tasks share navigation paths, plan data queries, `core.ts` dispatch routing, and `keyboards.ts`. Agents working on them must agree on shared interfaces before starting, then coordinate on file-level changes.

**Depends on:** Phase 0 (lifecycle detection, dynamic menu, plan helpers, surfaceContext, callback prefixes).

### Shared contract (agents agree on this before implementation)

Phase 0 delivers the plan data helpers and callback prefix registry. The coordinated agents additionally agree on:

1. **Cook view entry protocol** — Agent B defines how to open a recipe in cook view. Agent A calls this from plan screens:
   - Callback format: `cv_{batchId}` — uses the batch UUID, NOT the recipe slug. Reason: after plan mutations (Plan 009 re-batching), the same (recipeSlug, mealType) pair can appear in multiple batches. The batch ID uniquely identifies which batch to render. See `plan-flow.ts:1570-1576` where `days[0]` is needed to disambiguate — the batch ID avoids this entirely.
   - Batch IDs are UUIDs (36 chars) which fits within Telegram's 64-byte callback limit with the `cv_` prefix (39 bytes total).
   - Agent B's handler: look up batch by ID from store → get recipe by `batch.recipeSlug` → render cook view with `batch.scaledIngredients` and `batch.eatingDays.length` servings.
   - Returns: formatted cook-time message + keyboard.

2. **Shopping list entry protocol** — Agent C defines how to generate a scoped shopping list. Agent A calls this from plan screens:
   - From Next Action or main menu: `sl_next` — Agent C computes the next cook day.
   - From Day Detail: `sl_{ISO date}` — Agent C scopes to that day's cook session.
   - Agent C needs: target date (or "next"), active plan batches (from store), breakfast recipe.

3. **Ingredient role propagation for shopping list:**
   - Current problem: `ScaledIngredient` (types.ts:146) has only name/amount/unit/totalForBatch — no `role`. The shopping generator (generator.ts:58-60) hardcodes all batch ingredients to 'PANTRY' because it has no role data.
   - Decision: **Enrich ScaledIngredient with `role`**. Add `role: IngredientRole` to the `ScaledIngredient` interface. Update `recipe-scaler.ts` output mapping (line 177) to include role from the source recipe's ingredients. This is the cleanest fix — it flows through the existing pipeline without requiring recipe re-lookups at shopping list time.
   - **Name matching caveat:** The scaler's LLM prompt (recipe-scaler.ts:91) defines only name/amount/unit/total_for_batch in its JSON schema — `role` is NOT in the LLM output. Role must be mapped post-hoc by matching the LLM's returned ingredient name back to `recipe.ingredients[].name`. But the LLM may rename ingredients (e.g., "chicken breast" → "chicken"). Strategy: case-insensitive substring match, fall back to `'base'` role when no match is found, log a warning.
   - **Also fix the fallback path:** When the scaler throws, `plan-flow.ts:1602` builds `ScaledIngredient[]` manually from `recipe.ingredients` — currently without `role`. This must include `role: ing.role` once the field is required.
   - Agent C owns this enrichment work (it's the consumer). See Agent C scope item 1.

4. **File conflict resolution** — core.ts and keyboards.ts are touched by all three agents. Strategy:
   - Each agent adds their handlers in clearly separated sections (comment-delimited blocks).
   - Agent A owns the top-level dispatch routing structure. Agents B and C add handler functions that A's dispatch calls.
   - Keyboard functions go in separate exported functions (not modifications to the same function).

---

### Coordinated Agent A — Plan View Screens + Navigation

**What:** Build the plan view hub: Next Action, Week Overview, Day Detail, Post-confirmation bridge. This is the navigation backbone that the other coordinated agents plug into.

**Spec:** `ui-architecture.md` § Next Action, Week Overview, Day Detail, Post-Confirmation, Navigation Map

**Scope:**

1. **[My Plan] → Next Action screen:**
   - Today + next 2 days. Show meals with status (cook 🔪 / reheat / flex / event).
   - Breakfast NOT shown (fixed, memorized).
   - Inline keyboard: `[🔪 Recipe — N servings]` if cook session upcoming, `[Get shopping list]` (→ `sl_next`), `[View full week]` (→ `wo_show`).
   - New formatter in `formatters.ts`.
   - Set `surfaceContext = 'plan'`.

2. **[View full week] → Week Overview:**
   - Compact day-by-day. Breakfast once at top. Recipe short names + markers (🔪/🍽️/Flex).
   - "Weekly target: on track ✓" — no calorie numbers.
   - Day buttons as inline keyboard (Mon–Sun in rows of 4+3).
   - `[← Back]` returns to Next Action.

3. **Day button → Day Detail:**
   - One day's meals. Cook meals show servings count, day range. Reheat meals show batch origin, serving number (using `getServingNumber()` from Phase 0 helpers).
   - `[🔪 Recipe — N servings]` button for cook-day meals (→ `cv_{batchId}`).
   - `[Get shopping list]` scoped to this day (→ `sl_{date}`).
   - `[← Back to week]` returns to Week Overview.

4. **Post-confirmation bridge:**
   - Replace current "Plan locked" dead-end in `plan-flow.ts` confirmed phase.
   - Show: "Plan locked for {dates} ✓", first cook day info, shopping prompt.
   - `[Get shopping list]` (→ `sl_next`) + `[View full week]` (→ `wo_show`) buttons.
   - This replaces the output of `handleApprove()` in plan-flow.ts — the post-confirmation message and keyboard.

5. **[Plan Week] / [Resume Plan] / [My Plan] routing:**
   - `no_plan` → start planning flow (existing behavior).
   - `planning` → resume in-progress plan flow. Phase 0 fixes the `handleMenu()` destruction bug. This agent verifies the resume path works: if `session.planFlow` exists, re-display the current phase's prompt/keyboard instead of restarting.
   - `active_*` → show Next Action screen.

6. **[Shopping List] main menu routing (state-aware wrapper):**
   - `no_plan` → "No plan yet — plan your week first to see what you'll need."
   - Active plan → delegate to Agent C's shopping list handler with `sl_next` scope.

**Key files:**
- `src/telegram/core.ts` — plan view dispatch routes, menu routing updates
- `src/telegram/keyboards.ts` — Next Action, Week Overview, Day Detail keyboards
- `src/telegram/formatters.ts` — Next Action, Week Overview, Day Detail, Post-confirmation formatters
- `src/agents/plan-flow.ts` — post-confirmation message output

**Coordinates with:**
- **Agent B:** 🔪 recipe buttons emit `cv_{batchId}` callbacks (batch UUID, not slug — disambiguates re-batched duplicates). Agent B handles them.
- **Agent C:** `[Get shopping list]` buttons emit `sl_next` or `sl_{date}` callbacks. Agent C handles them.

---

### Coordinated Agent B — Recipe Display Contexts

**What:** Build cook-time recipe rendering (batch totals, placeholder resolution) and make the recipe library plan-aware (Cooking Soon section, 🔪 routing, two-context display).

**Depends on:** Isolated Task 2 (Recipe Format Evolution) for `{placeholder}` support and `shortName` field. Can begin recipe library redesign immediately while waiting for Task 2 to land; placeholder resolution requires Task 2.

**Spec:** `ui-architecture.md` § Cook-Time Recipe, Recipe Library, Recipe presentation: two contexts

**Scope:**

1. **Cook-time recipe renderer:**
   - New render mode in `renderer.ts` (e.g., `renderCookView(recipe, batch)`): batch totals (not per-serving), servings count at top, "Divide into N equal portions."
   - Resolve `{ingredient_name}` placeholders in recipe body → actual amounts from `batch.scaledIngredients`. Fall back to displaying the placeholder name without amount if ingredient not found (defensive).
   - Group `role: seasoning` ingredients with no meaningful amount onto one display line in the ingredient list section.
   - Storage instructions at the bottom (fridge days, reheat method from recipe YAML `storage` field).
   - Telegram markdown: **bold** for headers/timings, `monospace` for amounts, _italic_ for secondary.
   - `[← Back to plan]` + `[Edit this recipe]` + `[View in my recipes]` buttons.
   - Set `surfaceContext = 'cooking'` and `lastRecipeSlug`.

2. **Library view (existing, refine):**
   - Per-serving amounts, cuisine/tags, edit/delete options. This mostly exists already in `renderRecipe()`.
   - If `{placeholders}` are present in the recipe body, resolve them to per-serving amounts from `recipe.ingredients`.

3. **Two-context routing:**
   - `cv_{batchId}` callback (from plan screens or Cooking Soon) → look up batch by UUID from store → get recipe by `batch.recipeSlug` → render cook view with batch's scaled ingredients and servings.
   - `rv_{slug}` callback (from All Recipes, existing) → library view (existing behavior, preserved). Set `surfaceContext = 'recipes'` and `lastRecipeSlug`.
   - `[View in my recipes]` at bottom of cook view → `rv_{slug}` (library view).
   - `[Edit this recipe]` at bottom of cook view → existing recipe edit flow.
   - One rule: 🔪 = cook view. No 🔪 = library view.

4. **Recipe library plan-aware redesign:**
   - When an active plan exists (lifecycle is `active_*`), show two sections:
     - **COOKING SOON** — upcoming cook-day batches from the active plan (future eatingDays[0] relative to today), sorted by next cook date. Each button prefixed with 🔪, uses `cv_{batchId}` callback. Button label: `🔪 {shortName ?? name}`. Note: if the same recipe appears in two batches (after re-batching), both appear as separate 🔪 buttons with distinct batch IDs.
     - **ALL RECIPES** — full alphabetical list, uses `rv_{slug}` callback (existing pagination).
   - When no active plan: just ALL RECIPES (current behavior).
   - Update `showRecipeList` in `core.ts` and `recipeListKeyboard` in `keyboards.ts`.
   - Use `shortName ?? name` for button labels.

**Key files:**
- `src/recipes/renderer.ts` — cook-time render mode, placeholder resolution
- `src/telegram/core.ts` — `cv_` callback handler, recipe list with Cooking Soon logic
- `src/telegram/keyboards.ts` — recipe list keyboard with Cooking Soon section, cook view keyboard

**Coordinates with:**
- **Agent A:** Receives `cv_{batchId}` callbacks from plan view screens. Agent B looks up the batch by UUID, resolves the recipe and scaled ingredients, and renders cook view.

---

### Coordinated Agent C — Shopping List Overhaul

**What:** Rebuild the shopping list with three-tier ingredient intelligence, category grouping, scope-to-next-cook-day logic, and breakfast prorating.

**Spec:** `ui-architecture.md` § Screen: Shopping List (serves A2)

**Scope:**

1. **Enrich ScaledIngredient with role:**
   - Add `role: IngredientRole` to `ScaledIngredient` interface in `src/models/types.ts`.
   - Update `recipe-scaler.ts` output mapping (~line 177) to include `role` by matching each scaled ingredient's name back to the source recipe's ingredients. The scaler already receives the full `Recipe` as input — it has access to `recipe.ingredients[].role`. **Name matching caveat:** the LLM may rename ingredients during scaling (e.g., "chicken breast" → "chicken"). Use case-insensitive substring matching with a fallback to `'base'` role when no match is found, and log a warning so mismatches are visible in debug.log.
   - **Also update the scaler fallback path in `plan-flow.ts:1602`** — when the scaler fails, `handleApprove()` builds `ScaledIngredient[]` manually from `recipe.ingredients`. This path must also include `role: ing.role` or it will break once `role` is required on `ScaledIngredient`.
   - **Update scenario seeds and recordings:** Test scenarios in `test/scenarios/*/spec.ts` seed batches with `scaledIngredients` arrays (used in `finalStore` assertions and as fixture data). These seeds don't include `role`. Once `role` is required on `ScaledIngredient`, these will fail type-checking or runtime assertions. Add `role` to every seeded `scaledIngredients` entry in spec files, then regenerate affected `recorded.json` files.
   - This unblocks three-tier intelligence without requiring recipe re-lookups at shopping list time.

2. **Three-tier ingredient intelligence:**
   - **Tier 1 (never show):** Hardcoded exclusion list — water, salt, black pepper. These never appear.
   - **Tier 2 ("Check you have"):** Long-lasting pantry items. Heuristic: `role === 'seasoning'` → tier 2 by default. Small additional hardcoded list for cooking oils, vinegar, soy sauce, etc.
   - **Tier 3 (main buy list):** Everything else — proteins, produce, dairy, grains. The actual shopping items with quantities.

3. **Category grouping:**
   - Group by: PRODUCE, FISH, MEAT, DAIRY & EGGS, PANTRY, OILS & FATS.
   - Primary mapping from ingredient `role`: protein → MEAT/FISH (sub-categorize using a small keyword list: salmon/tuna/shrimp/cod → FISH, everything else → MEAT), carb → PANTRY, fat → OILS & FATS, vegetable → PRODUCE, base → PANTRY.
   - Categories sorted in a logical store-aisle order.

4. **Scope to next cook day:**
   - Default (`sl_next`): use `getNextCookDay()` from Phase 0 helpers → that day's batches + prorated breakfast.
   - Specific day (`sl_{date}`): that day's cook batches + prorated breakfast.
   - Batching rule: include at most one day's cooking (both lunch and dinner if both cook that day). Cap: never more than one day.
   - Breakfast ingredients prorated to remaining plan days from the target cook day onward (not full week). If cook day is Thursday with 4 remaining days → 4 avocados.

5. **Breakfast always included:**
   - Regardless of entry point, breakfast ingredients for remaining days are in the list.
   - Breakfast recipe loaded from the plan session's `breakfast.recipeSlug`.

6. **Aggregation:**
   - Merge duplicate ingredients across batches and breakfast (case-insensitive, accumulate amounts).

7. **Copy-friendly formatting:**
   - Header: "**What you'll need** — {day name} {date}"
   - Scope line: "_For: {recipe names} (N servings) + Breakfast_"
   - Category sections with dash-prefix items: `- {item} — {amount}{unit}`.
   - Tier 2 at bottom: "_Check you have: {comma-separated list}_"
   - Footer: "_Long-press to copy. Paste into Notes, then remove what you already have._"
   - `[← Back to plan]` button.

8. **Callback handlers:**
   - `sl_next` → compute next cook day, generate scoped list.
   - `sl_{ISO date}` → generate list scoped to that date.
   - Main menu [Shopping List] with active plan → equivalent to `sl_next`.
   - Set `surfaceContext = 'shopping'`.

**Key files:**
- `src/models/types.ts` — add `role` to `ScaledIngredient`
- `src/agents/recipe-scaler.ts` — include role in output mapping (name-match with fallback)
- `src/agents/plan-flow.ts` — update scaler fallback path (~line 1602) to include `role`
- `src/shopping/generator.ts` — major rewrite (three-tier, categories, scoping, breakfast proration)
- `src/telegram/formatters.ts` — new shopping list formatter
- `src/telegram/core.ts` — `sl_` callback handlers
- `src/telegram/keyboards.ts` — shopping list keyboard
- `test/scenarios/*/spec.ts` — add `role` to seeded `scaledIngredients`
- `test/scenarios/*/recorded.json` — regenerate affected recordings

**Coordinates with:**
- **Agent A:** Receives `sl_next` and `sl_{date}` callbacks from plan view buttons. Agent C handles them. Agent A handles the main-menu [Shopping List] no-plan case.
- Uses Phase 0 plan data helpers (`getNextCookDay`, lifecycle detection).

**Acceptance:**
- `ScaledIngredient` has `role` everywhere: types.ts interface, scaler output mapping, plan-flow fallback, scenario seeds.
- `npm test` passes after updating scenario seeds and regenerating recordings.
- Shopping list groups ingredients by category, excludes tier 1, shows tier 2 in "Check you have" section.
- Scoped to next cook day + prorated breakfast. Full-week list is not generated.
- Main menu [Shopping List] with no plan shows a helpful message, not an error.

---

## Execution order

```
Phase 0: Shared Infrastructure
  (lifecycle detection, dynamic menu, handleMenu fix,
   surfaceContext, plan helpers, callback prefixes)
         │
         ├──────────────────────────────┐
         │                              │
         ▼                              ▼
Phase 1 (parallel):              Isolated Task 2:
├── Isolated Task 1:             Recipe Format Evolution
│   Progress Screen              (no Phase 0 dependency,
│                                 can start immediately)
├── Coordinated Group:
│   ├── Agent A: Plan Views
│   ├── Agent B: Recipe Contexts (placeholder work waits for Task 2)
│   └── Agent C: Shopping List
│
         │
         ▼
Phase 2 (after all above land):
└── Isolated Task 3: Copy & Messaging Pass + Free-Text Fallback
```

**Parallelism notes:**
- Task 2 (Recipe Format) has zero dependencies — it can start before Phase 0 finishes.
- Task 1 (Progress) and the Coordinated Group both depend on Phase 0.
- Within the Coordinated Group, all three agents work in parallel but communicate on shared files. Agent B can start the recipe library redesign while waiting for Task 2 to land, then add placeholder resolution once Task 2 is available.
- Task 3 (Copy Pass) runs last as a final sweep.
