/**
 * Solver-specific input/output types.
 *
 * The budget solver is deterministic code — no LLM involved. It takes structured
 * inputs describing the week's shape and produces a budget allocation that the
 * recipe engine fills.
 *
 * Source of truth: docs/SPEC.md Section 6.
 *
 * Relationship to core types:
 * - SolverInput is assembled by the orchestrator from user choices during planning.
 * - SolverOutput feeds into recipe generation (batch targets) and the weekly plan.
 */

import type { FunFoodItem, Macros, MealEvent } from '../models/types.js';

/**
 * Everything the solver needs to allocate a weekly budget.
 * Assembled progressively during the planning flow (Steps 0–2).
 */
export interface SolverInput {
  weeklyTargets: Macros;
  events: MealEvent[];
  funFoods: FunFoodItem[];
  mealPrepPreferences: {
    recipes: RecipeRequest[];
  };
  breakfast: {
    locked: boolean;
    recipeSlug?: string;
    caloriesPerDay: number;
    proteinPerDay: number;
  };
}

/**
 * A request for a specific batch of meal prep.
 * The user chooses recipes in Step 3; the solver assigns calorie targets.
 */
export interface RecipeRequest {
  /** From database, or undefined for "generate new" */
  recipeSlug?: string;
  mealType: 'lunch' | 'dinner';
  /** ISO dates this batch covers */
  days: string[];
  /** 2 or 3 servings per batch */
  servings: number;
  cuisineHint?: string;
}

/**
 * The solver's complete output — a budget allocation for the week.
 */
export interface SolverOutput {
  isValid: boolean;
  weeklyTotals: {
    calories: number;
    protein: number;
    funFoodCalories: number;
    funFoodPercent: number;
  };
  dailyBreakdown: DailyBreakdown[];
  batchTargets: BatchTarget[];
  cookingSchedule: CookingScheduleDay[];
  warnings: string[];
}

export interface DailyBreakdown {
  /** ISO date */
  day: string;
  totalCalories: number;
  totalProtein: number;
  breakfast: Macros;
  lunch: { calories: number; protein: number; batchId?: string };
  dinner: { calories: number; protein: number; batchId?: string };
  funFoods: FunFoodItem[];
  events: MealEvent[];
}

/**
 * A batch target tells the recipe engine: produce N servings at these macros.
 * Calories and protein are hard constraints. Fat/carbs are for the recipe
 * generator to balance internally.
 */
export interface BatchTarget {
  id: string;
  recipeSlug?: string;
  mealType: 'lunch' | 'dinner';
  days: string[];
  servings: number;
  targetPerServing: Macros;
}

export interface CookingScheduleDay {
  /** ISO date */
  day: string;
  batchIds: string[];
}
