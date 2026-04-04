/**
 * Core data model types for Flexie.
 *
 * These interfaces define the shape of all data flowing through the system:
 * weekly plans, recipes, meal slots, fun foods, events, batches, and shopping lists.
 *
 * Source of truth: docs/SPEC.md Sections 5.1–5.3.
 *
 * Key relationships:
 * - A WeeklyPlan contains MealSlots, CookDays (with Batches), MealEvents, and FunFoodItems.
 * - A Batch references a Recipe by slug and contains ScaledIngredients.
 * - A MealSlot references either a Batch (meal-prep) or a MealEvent (restaurant).
 * - The ShoppingList is derived from the WeeklyPlan — not stored separately.
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
 *   Steps reference ingredients by name only, never by amount — amounts come from YAML
 *   and are rendered dynamically at display time (supports scaling).
 *
 * Recipes store per-serving amounts. Servings are determined at planning time, not stored
 * on the recipe. The system scales ingredient amounts when generating shopping lists or
 * displaying for a specific plan.
 */
export interface Recipe {
  name: string;
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
  /** Free-form recipe text: description, steps, notes, tips. No amounts — those come from ingredients. */
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

// ─── Weekly Plan (Supabase) ──────────────────────────────────────────────────

/**
 * The central data structure for a week of meals.
 * Created during the planning session, persisted in Supabase.
 */
export interface WeeklyPlan {
  id: string;
  /** ISO date string, user chooses start day */
  weekStart: string;
  status: 'planning' | 'active' | 'completed';

  targets: Macros;

  /**
   * The flex budget replaces the old fun food item model. Instead of placing
   * specific treats on specific days, the system allocates a calorie pool:
   * - Flex slots: planned meals with a calorie bonus (eat something fun)
   * - Treat budget: unplanned remainder, spent freely on snacks/desserts
   */
  flexBudget: {
    /** Total fun food pool — 20% of weekly calories */
    totalPool: number;
    /** Calories consumed by flex slot bonuses */
    flexSlotCalories: number;
    /** Remaining for ad-hoc treats: totalPool - flexSlotCalories */
    treatBudget: number;
    /** The flex slots themselves */
    flexSlots: FlexSlot[];
  };

  breakfast: {
    /** true = same recipe every day (v0.0.1 default) */
    locked: boolean;
    recipeSlug: string;
    caloriesPerDay: number;
    proteinPerDay: number;
  };

  events: MealEvent[];
  cookDays: CookDay[];
  mealSlots: MealSlot[];

  /** User-added non-food items for the shopping list */
  customShoppingItems: string[];

  createdAt: string;
  updatedAt: string;
}

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

export interface CookDay {
  /** ISO date */
  day: string;
  batches: Batch[];
}

/**
 * A batch of meal prep — multiple servings of one recipe cooked at once.
 * The solver sets calorie/protein targets per serving. The recipe generator
 * fills in fat/carbs to produce balanced meals internally.
 */
export interface Batch {
  id: string;
  recipeSlug: string;
  mealType: 'lunch' | 'dinner';
  servings: number;
  targetPerServing: Macros;
  actualPerServing: MacrosWithFatCarbs;
  scaledIngredients: ScaledIngredient[];
}

export interface ScaledIngredient {
  name: string;
  amount: number;
  unit: string;
  /** amount × servings — for the shopping list */
  totalForBatch: number;
}

export interface MealSlot {
  id: string;
  /** ISO date */
  day: string;
  mealTime: 'breakfast' | 'lunch' | 'dinner';
  source: 'fresh' | 'meal-prep' | 'restaurant' | 'flex' | 'skipped';
  /** Set when source is 'meal-prep' */
  batchId?: string;
  /** Set when source is 'restaurant' */
  eventId?: string;
  /** If this is a flex slot, the bonus calories from the fun food pool */
  flexBonus?: number;
  plannedCalories: number;
  plannedProtein: number;
}

// ─── Shopping List (derived, not stored) ─────────────────────────────────────

export interface ShoppingList {
  categories: ShoppingCategory[];
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
}
