/**
 * Shopping list validator.
 *
 * Validates that a generated shopping list matches the expected three-tier
 * structure after the Phase 5 overhaul:
 * - Tier 1 ingredients (salt, black pepper, water) should NOT appear
 * - Tier 2 ingredients (seasonings, pantry oils) should be in checkYouHave
 * - Tier 3 ingredients (everything else) should be in categories
 *
 * Shopping lists are deterministically derived, so these should rarely fail.
 * If they do, it signals a bug in the generator, not bad LLM output.
 */

import type { ShoppingList, Batch } from '../../models/types.js';

export interface ShoppingListValidationResult {
  valid: boolean;
  errors: string[];
}

/** Tier 1 exclusions — must NOT appear in the list at all. */
const TIER_1_EXCLUSIONS = new Set([
  'water', 'salt', 'black pepper', 'pepper',
]);

/**
 * Validate a shopping list against the batches it was generated from.
 *
 * @param list - The generated shopping list
 * @param batches - All batches in the weekly plan
 * @returns Validation result
 */
export function validateShoppingList(
  list: ShoppingList,
  batches: Batch[],
): ShoppingListValidationResult {
  const errors: string[] = [];

  // Flatten all category items
  const listItems = new Map<string, { amount: number; unit: string }>();
  for (const cat of list.categories) {
    for (const item of cat.items) {
      listItems.set(item.name.toLowerCase(), { amount: item.amount, unit: item.unit });
    }
  }

  // Flatten checkYouHave items (lowercase)
  const checkYouHaveSet = new Set(list.checkYouHave.map(s => s.toLowerCase()));

  // Check that tier 1 ingredients are NOT in categories
  for (const excluded of TIER_1_EXCLUSIONS) {
    if (listItems.has(excluded)) {
      errors.push(`Tier 1 ingredient "${excluded}" should not appear in categories.`);
    }
    if (checkYouHaveSet.has(excluded)) {
      errors.push(`Tier 1 ingredient "${excluded}" should not appear in checkYouHave.`);
    }
  }

  // Check category items have valid amounts
  for (const cat of list.categories) {
    for (const item of cat.items) {
      if (item.amount <= 0) {
        errors.push(`Invalid amount for "${item.name}" in ${cat.name}: ${item.amount}.`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
