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
 * Recipes are the building blocks of meal prep batches.
 * They are human-readable (markdown) and machine-readable (YAML frontmatter).
 */
export interface Recipe {
  name: string;
  slug: string;
  mealTypes: Array<'breakfast' | 'lunch' | 'dinner'>;
  cuisine: string;
  tags: string[];
  prepTimeMinutes: number;
  perServing: MacrosWithFatCarbs;
  ingredients: RecipeIngredient[];
  storage: RecipeStorage;
  /** Markdown steps (raw string) */
  steps: string;
  /** Markdown notes (raw string, optional) */
  notes?: string;
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

  funFoodBudget: {
    /** Total calories allocated to fun food */
    total: number;
    items: FunFoodItem[];
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
  source: 'fresh' | 'meal-prep' | 'restaurant' | 'skipped';
  /** Set when source is 'meal-prep' */
  batchId?: string;
  /** Set when source is 'restaurant' */
  eventId?: string;
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
