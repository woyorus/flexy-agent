/**
 * Core data model types for Flexie.
 *
 * These interfaces define the shape of all data flowing through the system:
 * plan sessions, batches, recipes, meal slots, fun foods, events, and shopping lists.
 *
 * Source of truth: docs/product-specs/data-models.md
 *
 * Key relationships (rolling-horizon model — Plan 007):
 * - A PlanSession is a confirmed 7-day planning horizon. Batches reference it via createdInPlanSessionId.
 * - A Batch is a first-class entity: one recipe, 2-3 servings, 2-3 consecutive eating days.
 *   Cook day = eatingDays[0] (derived, not stored). Batches can span horizon boundaries.
 * - PreCommittedSlot (in solver/types.ts) projects prior sessions' batches into the current horizon.
 * - CookDay and MealSlot are derived views, not persisted (P5).
 *
 * Legacy types (WeeklyPlan, LegacyBatch, CookDay, MealSlot) are retained during the
 * strangler-fig migration and will be deleted in Phase 7b.
 */

// ─── Recipe (parsed from markdown files) ─────────────────────────────────────

/**
 * A recipe parsed from a markdown file with YAML frontmatter.
 *
 * Split into two parts:
 * - YAML frontmatter: structured data (macros, ingredients with roles/amounts, structure).
 *   This is what the solver and scaler operate on. Ingredients have a `component` field
 *   linking them to the meal structure (main, carb_side, side, etc.).
 * - Markdown body: free-form human-readable text (steps, notes, tips).
 *   Steps may contain `{ingredient_name}` placeholders that are resolved at render time
 *   to show batch-total or per-serving amounts contextually. Raw amounts still live in
 *   YAML only — placeholders are just references, not hardcoded values.
 *
 * Recipes store per-serving amounts. Servings are determined at planning time, not stored
 * on the recipe. The system scales ingredient amounts when generating shopping lists or
 * displaying for a specific plan.
 */
export interface Recipe {
  name: string;
  shortName?: string;  // max ~25 chars, for compact display (plan views, week overviews, shopping list headers)
  slug: string;
  mealTypes: Array<'breakfast' | 'lunch' | 'dinner'>;
  cuisine: string;
  tags: string[];
  prepTimeMinutes: number;
  /** Meal composition — e.g., main + carb side, or breakfast components */
  structure: RecipeComponent[];
  perServing: MacrosWithFatCarbs;
  ingredients: RecipeIngredient[];
  storage: RecipeStorage;
  /** Free-form recipe text: description, steps, notes, tips. May contain `{ingredient_name}` placeholders resolved at render time; raw amounts remain in YAML only. */
  body: string;
}

/**
 * A named component of a meal.
 * Lunch/dinner: typically "main" + optional "carb_side" + optional "side".
 * Breakfast: 2-3 named components (e.g., "Avocado Toast", "Egg Omelette", "Oatmeal").
 */
export interface RecipeComponent {
  /** Component type for scaling logic */
  type: 'main' | 'carb_side' | 'side' | 'breakfast_component';
  /** Display name — e.g., "Chicken Pepperonata", "Basmati Rice", "Side Salad" */
  name: string;
}

export interface MacrosWithFatCarbs {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
}

export interface Macros {
  calories: number;
  protein: number;
}

/**
 * An ingredient in a recipe.
 * The `role` field tells the solver which ingredients to adjust when scaling:
 * - protein: adjust last (protect protein)
 * - carb: adjust first (main calorie lever)
 * - fat: adjust second
 * - vegetable: keep stable (volume, nutrition)
 * - base: keep stable (recipe structure)
 * - seasoning: keep stable
 */
export interface RecipeIngredient {
  name: string;
  amount: number;
  unit: string;
  role: IngredientRole;
  /** Which meal component this ingredient belongs to (matches RecipeComponent.name) */
  component: string;
}

export type IngredientRole = 'protein' | 'carb' | 'fat' | 'vegetable' | 'base' | 'seasoning';

export interface RecipeStorage {
  fridgeDays: number;
  freezable: boolean;
  reheat: string;
}

// ─── Legacy types (deleted in Plan 007 Phase 7b) ────────────────────────────
// WeeklyPlan, CookDay, LegacyBatch, MealSlot — all removed.
// FunFoodItem retained for machine.ts PlanningData.

export interface FunFoodItem {
  name: string;
  estimatedCalories: number;
  /** ISO date */
  day: string;
  mealTime: 'snack' | 'dessert' | 'with-lunch' | 'with-dinner';
}

/**
 * A flex slot is a meal where the calorie target is boosted above the normal
 * meal-prep baseline. The extra calories come from the fun food pool.
 *
 * Flex slots are planned at plan time (the system suggests them), but the user
 * decides what to eat in real-time — no specific food is assigned. Common uses:
 * burger night, pizza, takeout, a richer home-cooked meal.
 *
 * The remaining fun food pool after flex bonuses = the "treat budget," which
 * the user spends freely on snacks/desserts throughout the week.
 */
export interface FlexSlot {
  /** ISO date */
  day: string;
  mealTime: 'lunch' | 'dinner';
  /** Extra calories on top of the normal meal-prep baseline, drawn from the fun food pool */
  flexBonus: number;
  /** Optional note — e.g., "fun dinner night", "burger or pizza" */
  note?: string;
}

export interface MealEvent {
  name: string;
  /** ISO date */
  day: string;
  mealTime: 'lunch' | 'dinner';
  estimatedCalories: number;
  notes?: string;
}

/**
 * A single user-approved plan mutation, recorded so the re-proposer respects
 * prior choices on subsequent calls. Persisted on `PlanSession.mutationHistory`
 * (Plan 026) so it survives save-before-destroy writes.
 */
export interface MutationRecord {
  /** Natural-language description of what the user asked for */
  constraint: string;
  /** ISO timestamp (Date.toISOString()) when the mutation was applied */
  appliedAt: string;
}

/**
 * One atomic change inside a `SwapRecord` (Plan 033 / design doc 006).
 *
 * The discriminator captures *how* the batch (or breakfast) changed so the
 * reversal parser can name what to undo ("put the passata back"), so the
 * renderer can emit the right delta line, and so the post-agent guardrail
 * validator can check invariants (e.g., `replace` on a precisely-bought
 * ingredient is only legal when the user named that ingredient).
 *
 * - `replace` — ingredient X removed, ingredient Y added in its place.
 * - `remove`  — ingredient removed with no replacement.
 * - `add`     — ingredient introduced (helper pantry staple or rebalance).
 * - `rebalance` — amount of an already-present pantry staple changed.
 * - `rename`  — batch display-name override changed (e.g., "Salmon Pasta" → "Cod Pasta").
 */
export type SwapChange =
  | {
      kind: 'replace';
      from: string;
      to: string;
      fromAmount: number;
      fromUnit: string;
      toAmount: number;
      toUnit: string;
    }
  | { kind: 'remove'; ingredient: string; amount: number; unit: string }
  | {
      kind: 'add';
      ingredient: string;
      amount: number;
      unit: string;
      /** 'helper' = pantry staple introduced alongside a replacement (wine→stock+acid). 'rebalance' = macro correction. */
      reason: 'helper' | 'rebalance';
    }
  | {
      kind: 'rebalance';
      ingredient: string;
      fromAmount: number;
      toAmount: number;
      unit: string;
    }
  | { kind: 'rename'; from: string; to: string };

/**
 * One committed emergency ingredient swap against a Batch or a session's
 * breakfast (Plan 033). Append-only history — never mutated in place.
 *
 * Stored as JSONB on `batches.swap_history` or inside
 * `plan_sessions.breakfast_override.swapHistory`. The reversal agent reads
 * this array to decide what "swap back" / "undo the passata" means.
 */
export interface SwapRecord {
  /** ISO timestamp when the swap was applied. */
  appliedAt: string;
  /** Verbatim user message that triggered this swap. */
  userMessage: string;
  /** Atomic changes that make up this swap, in display order. */
  changes: SwapChange[];
  /** Per-serving (or per-day for breakfast) macros AFTER this swap — snapshot for delta reasoning and reversal math. */
  resultingMacros: MacrosWithFatCarbs;
}

/**
 * Per-session override of the locked breakfast recipe's content, materialized
 * the first time an emergency swap commits against this session's breakfast
 * (Plan 033 / design doc 006).
 *
 * `PlanSession.breakfast` stores only `recipeSlug` + `caloriesPerDay` +
 * `proteinPerDay`. The swap flow needs the full ingredient list, step body,
 * and fat/carb macros so it can rewrite them, so we snapshot the scaled
 * breakfast into this override and mutate it in place on subsequent swaps.
 *
 * `scaledIngredientsPerDay` carries PER-DAY amounts (breakfast runs one
 * "serving" per day) so the shopping-list generator multiplies by
 * `horizonDays` with the existing proration math.
 */
export interface BreakfastOverride {
  /** Display-name override. Falls back to the library breakfast recipe's name when absent. */
  nameOverride?: string;
  /** Body/step-text override. Falls back to the library recipe's body when absent. */
  bodyOverride?: string;
  /** Per-day scaled ingredients (one "serving"). */
  scaledIngredientsPerDay: ScaledIngredient[];
  /** Per-day macros after the swap. */
  actualPerDay: MacrosWithFatCarbs;
  /** Ordered swap history on the breakfast target. */
  swapHistory: SwapRecord[];
}

export interface ScaledIngredient {
  name: string;
  amount: number;
  unit: string;
  /** amount × servings — for the shopping list */
  totalForBatch: number;
  role: IngredientRole;
}

// ─── Plan Session + First-class Batch (Plan 007: rolling horizon model) ─────

/**
 * A confirmed plan session — a 7-day rolling horizon.
 *
 * Represents a PERSISTED (confirmed) session. Per D33, there is no such thing as
 * an unpersisted PlanSession — drafts live in memory as DraftPlanSession.
 * Batches are not embedded; they reference this session via createdInPlanSessionId.
 *
 * "What's in this session" is a query: `WHERE created_in_plan_session_id = id`.
 *
 * Plan 026: `mutationHistory` is persisted here (new jsonb column) so
 * post-confirmation mutations can respect every prior user-approved change
 * across save-before-destroy writes.
 */
export interface PlanSession {
  id: string;
  /** ISO date — first day of the 7-day horizon */
  horizonStart: string;
  /** ISO date — horizonStart + 6 days */
  horizonEnd: string;
  breakfast: {
    locked: boolean;
    recipeSlug: string;
    caloriesPerDay: number;
    proteinPerDay: number;
  };
  treatBudgetCalories: number;
  flexSlots: FlexSlot[];
  events: MealEvent[];
  /**
   * Accumulated record of user-approved plan mutations on this session and its
   * ancestors. Carried across save-before-destroy writes by the adapter in
   * `src/plan/session-to-proposal.ts` (Plan 026). May be empty on sessions that
   * were confirmed without any in-session mutations.
   */
  mutationHistory: MutationRecord[];
  /**
   * Plan 033: Set the first time an emergency ingredient swap commits
   * against this session's breakfast. Absent means "breakfast matches the
   * library recipe scaled by `breakfast.caloriesPerDay` / `proteinPerDay`".
   * When present, the renderer, the shopping-list generator, and the
   * dispatcher's plan summary all read from this override instead of the
   * library recipe. Cleared by reset-to-original on the breakfast target.
   */
  breakfastOverride?: BreakfastOverride;
  /** Populated by DB default now() on insert */
  confirmedAt: string;
  /** Tombstone flag for D27's replace-future-only flow */
  superseded: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * In-memory draft shape during the planning flow (D33).
 *
 * Accepted by store.confirmPlanSession() and returned by buildPlanSession().
 * Never persisted until the user taps Confirm. The DB fills in confirmedAt
 * (default now()), superseded (default false), createdAt, and updatedAt.
 *
 * The id is assigned client-side at draft creation time so batches can reference
 * their parent via createdInPlanSessionId before the confirm sequence writes.
 *
 * Plan 026: `mutationHistory` is optional at the draft stage so existing draft
 * builders (plan-flow.ts `buildNewPlanSession`) don't need to set it. The
 * store's row mapper writes `[]` as the default when it's absent.
 */
export type DraftPlanSession = Omit<
  PlanSession,
  'confirmedAt' | 'superseded' | 'createdAt' | 'updatedAt' | 'mutationHistory' | 'breakfastOverride'
> & { mutationHistory?: MutationRecord[] };

/**
 * A first-class batch — one recipe, 1-3 servings, 1-3 eating days.
 *
 * Plan 024: eating days need NOT be contiguous. A batch of 3 can span Wed, Fri, Sat
 * (Thursday is a flex or event day). The hard constraint is fridge-life:
 * calendarSpan(eatingDays[0], eatingDays.at(-1)) ≤ recipe.storage.fridgeDays.
 *
 * Only persisted (confirmed) batches exist as instances of this type.
 * In-memory drafts use ProposedBatch (solver/types.ts) until confirmation.
 *
 * Cook day = eatingDays[0] — derived at display time, never stored separately.
 * By invariant D30, eatingDays[0] is always inside the creating session's horizon.
 */
export interface Batch {
  id: string;
  recipeSlug: string;
  mealType: 'lunch' | 'dinner';
  /** ISO dates this batch is eaten on (1-3 days, not necessarily contiguous). Cook day = eatingDays[0]. */
  eatingDays: string[];
  servings: number;
  targetPerServing: Macros;
  actualPerServing: MacrosWithFatCarbs;
  scaledIngredients: ScaledIngredient[];
  /**
   * 'planned' = confirmed and scheduled to cook.
   * 'cancelled' = tombstoned by D27's supersede flow.
   * No 'proposed' — drafts are in-memory only (D33).
   */
  status: 'planned' | 'cancelled';
  /** Immutable FK to the plan session that created this batch (D30). */
  createdInPlanSessionId: string;
  /**
   * Plan 033: Display-name override applied by an emergency ingredient swap.
   * Falls back to `recipe.name` in the cook view and in list formatters when
   * absent. Cleared on reset-to-original.
   */
  nameOverride?: string;
  /**
   * Plan 033: Step-body override applied by an emergency swap. Falls back to
   * `recipe.body` when absent. Placeholder resolution still runs against
   * `scaledIngredients` — the override is template text, not pre-resolved.
   */
  bodyOverride?: string;
  /**
   * Plan 033: Append-only swap history. Empty array on every freshly-created
   * batch; a new `SwapRecord` appended on each successful commit. The
   * reversal agent reads this to decide what "undo" / "put X back" means.
   */
  swapHistory?: SwapRecord[];
}

/**
 * View model: a persisted Batch joined with its loaded Recipe.
 * Used by formatters and keyboards that need recipe display names.
 * `Batch.recipeSlug` is the FK; resolution happens in the handler before calling any formatter.
 */
export interface BatchView {
  batch: Batch;
  recipe: Recipe;
}

// ─── Measurements (progress tracking) ────────────────────────────────────────

export interface Measurement {
  id: string;
  userId: string;
  date: string;       // ISO date
  weightKg: number;
  waistCm: number | null;
  /** Server-generated timestamp (Supabase default now()). Read-only — omit from insert rows. */
  createdAt: string;
}

// ─── Shopping List (derived, not stored) ─────────────────────────────────────

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

export interface ShoppingCategory {
  name: string;
  items: ShoppingItem[];
}

export interface ShoppingItem {
  name: string;
  amount: number;
  unit: string;
  /** Optional annotation shown after the amount, e.g. "(breakfast, 4 days)". */
  note?: string;
}
