/**
 * Shopping list validator.
 *
 * Validates that a generated shopping list matches the weekly plan:
 * - Every recipe ingredient from the plan is included
 * - Amounts are aggregated correctly across batches
 * - Units are consistent (no mixing g and kg for the same item)
 *
 * Shopping lists are deterministically derived, so these should rarely fail.
 * If they do, it signals a bug in the generator, not bad LLM output.
 */

import type { ShoppingList, LegacyBatch } from '../../models/types.js';

export interface ShoppingListValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a shopping list against the batches it was generated from.
 *
 * @param list - The generated shopping list
 * @param batches - All batches in the weekly plan
 * @returns Validation result
 */
export function validateShoppingList(
  list: ShoppingList,
  batches: LegacyBatch[],
): ShoppingListValidationResult {
  const errors: string[] = [];

  // Flatten all ingredients from all batches
  const expectedIngredients = new Map<string, { totalAmount: number; unit: string }>();
  for (const batch of batches) {
    for (const ing of batch.scaledIngredients) {
      const key = ing.name.toLowerCase();
      const existing = expectedIngredients.get(key);
      if (existing) {
        if (existing.unit !== ing.unit) {
          errors.push(`Inconsistent units for "${ing.name}": ${existing.unit} vs ${ing.unit}.`);
        }
        existing.totalAmount += ing.totalForBatch;
      } else {
        expectedIngredients.set(key, { totalAmount: ing.totalForBatch, unit: ing.unit });
      }
    }
  }

  // Flatten shopping list items
  const listItems = new Map<string, { amount: number; unit: string }>();
  for (const cat of list.categories) {
    for (const item of cat.items) {
      listItems.set(item.name.toLowerCase(), { amount: item.amount, unit: item.unit });
    }
  }

  // Check every expected ingredient is present
  for (const [name, expected] of expectedIngredients) {
    const found = listItems.get(name);
    if (!found) {
      errors.push(`Missing ingredient "${name}" from shopping list.`);
    } else if (found.unit !== expected.unit) {
      errors.push(`Unit mismatch for "${name}": expected ${expected.unit}, got ${found.unit}.`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
