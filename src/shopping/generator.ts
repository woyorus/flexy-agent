/**
 * Shopping list generator.
 *
 * Derives a grouped shopping list from a confirmed weekly plan by aggregating
 * scaled ingredients across all batches plus breakfast ingredients (×7 if locked).
 *
 * The shopping list is NOT stored separately — it's generated on demand from
 * the plan. This ensures it's always in sync.
 *
 * Grouping uses the ingredient role to determine category:
 * - protein role → PROTEIN category
 * - carb role → CARBS & GRAINS
 * - fat role → OILS & FATS
 * - vegetable role → VEGETABLES
 * - base role → PANTRY
 * - seasoning role → SEASONING
 *
 * Custom items (user-added non-food items) are passed through unchanged.
 */

import type {
  WeeklyPlan,
  ShoppingList,
  ShoppingCategory,
  ShoppingItem,
  Recipe,
} from '../models/types.js';

/** Map ingredient roles to shopping list categories. */
const ROLE_TO_CATEGORY: Record<string, string> = {
  protein: 'PROTEIN',
  carb: 'CARBS & GRAINS',
  fat: 'OILS & FATS',
  vegetable: 'VEGETABLES',
  base: 'PANTRY',
  seasoning: 'SEASONING',
};

/**
 * Generate a shopping list from a weekly plan.
 *
 * @param plan - The confirmed weekly plan with populated batches
 * @param breakfastRecipe - The locked breakfast recipe (if applicable).
 *                          Ingredients are multiplied by 7 for the week.
 * @returns A categorized shopping list
 */
export function generateShoppingList(
  plan: WeeklyPlan,
  breakfastRecipe?: Recipe,
): ShoppingList {
  // Aggregate all ingredients
  const aggregated = new Map<string, { amount: number; unit: string; category: string }>();

  // Batch ingredients
  for (const cookDay of plan.cookDays) {
    for (const batch of cookDay.batches) {
      for (const ing of batch.scaledIngredients) {
        addIngredient(aggregated, ing.name, ing.totalForBatch, ing.unit, 'PANTRY');
      }
    }
  }

  // Breakfast ingredients (×7 if locked)
  if (plan.breakfast.locked && breakfastRecipe) {
    for (const ing of breakfastRecipe.ingredients) {
      const weeklyAmount = ing.amount * 7;
      const category = ROLE_TO_CATEGORY[ing.role] ?? 'PANTRY';
      addIngredient(aggregated, ing.name, weeklyAmount, ing.unit, category);
    }
  }

  // Group by category
  const categoryMap = new Map<string, ShoppingItem[]>();
  for (const [name, data] of aggregated) {
    const items = categoryMap.get(data.category) ?? [];
    items.push({ name, amount: roundAmount(data.amount), unit: data.unit });
    categoryMap.set(data.category, items);
  }

  // Order categories consistently
  const categoryOrder = ['PROTEIN', 'CARBS & GRAINS', 'VEGETABLES', 'OILS & FATS', 'PANTRY', 'SEASONING'];
  const categories: ShoppingCategory[] = categoryOrder
    .filter((cat) => categoryMap.has(cat))
    .map((cat) => ({
      name: cat,
      items: categoryMap.get(cat)!.sort((a, b) => a.name.localeCompare(b.name)),
    }));

  // Add any categories not in the predefined order
  for (const [cat, items] of categoryMap) {
    if (!categoryOrder.includes(cat)) {
      categories.push({ name: cat, items: items.sort((a, b) => a.name.localeCompare(b.name)) });
    }
  }

  return {
    categories,
    customItems: plan.customShoppingItems ?? [],
  };
}

/**
 * Add an ingredient to the aggregation map, merging amounts for duplicate names.
 */
function addIngredient(
  map: Map<string, { amount: number; unit: string; category: string }>,
  name: string,
  amount: number,
  unit: string,
  category: string,
): void {
  const key = name.toLowerCase();
  const existing = map.get(key);
  if (existing) {
    existing.amount += amount;
    // Keep the more specific category (batch ingredients may not have role info)
    if (category !== 'PANTRY') {
      existing.category = category;
    }
  } else {
    map.set(key, { amount, unit, category });
  }
}

/** Round amounts to user-friendly values. */
function roundAmount(amount: number): number {
  if (amount >= 100) return Math.round(amount / 10) * 10; // round to nearest 10 for large amounts
  if (amount >= 10) return Math.round(amount);              // whole numbers
  return Math.round(amount * 10) / 10;                      // one decimal for small amounts
}
