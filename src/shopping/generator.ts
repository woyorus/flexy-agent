/**
 * Shopping list generator — three-tier ingredient intelligence.
 *
 * Derives a grouped shopping list scoped to a single cook day from
 * the plan's batches plus prorated breakfast ingredients.
 *
 * Three tiers:
 * - Tier 1: universal basics (salt, black pepper, water) — excluded entirely
 * - Tier 2: long-lasting pantry items + seasonings — "check you have" section
 * - Tier 3: everything else — main buy list, grouped by category
 *
 * Categories: PRODUCE, FISH, MEAT, DAIRY & EGGS, PANTRY, OILS & FATS
 * Category assignment: keyword classification first, role fallback second.
 */

import type {
  Batch,
  ShoppingList,
  ShoppingCategory,
  ShoppingItem,
  Recipe,
  IngredientRole,
} from '../models/types.js';
import { log } from '../debug/logger.js';

// ─── Tier definitions ──────────────────────────────────────────────────────

/** Tier 1: never show (universal basics) */
const TIER_1_EXCLUSIONS = new Set([
  'water', 'salt', 'black pepper', 'pepper',
]);

/** Tier 2: "check you have" (long-lasting pantry items) */
const TIER_2_PANTRY = new Set([
  'olive oil', 'vegetable oil', 'cooking oil', 'sesame oil',
  'soy sauce', 'fish sauce', 'vinegar', 'rice vinegar',
  'balsamic vinegar', 'honey', 'maple syrup',
]);

// ─── Category assignment ───────────────────────────────────────────────────

const CATEGORY_ORDER = [
  'PRODUCE', 'FISH', 'MEAT', 'DAIRY & EGGS', 'PANTRY', 'OILS & FATS',
];

/** Keyword-based category classification (overrides role). */
function classifyByKeyword(name: string): string | null {
  const lower = name.toLowerCase();

  // DAIRY & EGGS — word-boundary match for "egg(s)" to avoid "eggplant"
  if (/\beggs?\b/.test(lower) || /yogurt|milk|ricotta|mozzarella|feta|halloumi|quark/.test(lower)) {
    return 'DAIRY & EGGS';
  }
  if (/butter|cream|crème fraîche|creme fraiche|ghee/.test(lower)) {
    return 'DAIRY & EGGS';
  }

  // FISH
  if (/salmon|tuna|shrimp|cod|sea bass|anchovy|prawn|crab|lobster/.test(lower)) {
    return 'FISH';
  }

  // Cheese fallback (only if no other keyword matched above)
  if (/cheese/.test(lower)) {
    return 'DAIRY & EGGS';
  }

  return null;
}

/** Role-based category fallback. */
function categoryFromRole(role: IngredientRole): string {
  switch (role) {
    case 'protein': return 'MEAT';
    case 'carb': return 'PANTRY';
    case 'fat': return 'OILS & FATS';
    case 'vegetable': return 'PRODUCE';
    case 'base': return 'PANTRY';
    case 'seasoning': return 'PANTRY';
  }
}

/**
 * Determine which tier and category an ingredient belongs to.
 *
 * Returns null for tier 1 (excluded).
 */
function classifyIngredient(
  name: string,
  role: IngredientRole,
): { tier: 2 | 3; category: string } | null {
  const lower = name.toLowerCase();

  // Tier 1: exclude
  if (TIER_1_EXCLUSIONS.has(lower)) return null;

  // Tier 2: seasonings or known pantry oils/sauces
  if (role === 'seasoning' || TIER_2_PANTRY.has(lower)) {
    return { tier: 2, category: 'PANTRY' };
  }

  // Tier 3: keyword classification first, role fallback
  const keywordCat = classifyByKeyword(name);
  const category = keywordCat ?? categoryFromRole(role);
  return { tier: 3, category };
}

// ─── Scope type ────────────────────────────────────────────────────────────

/**
 * Shopping scope tag — used by Plan 030's dispatcher-driven shopping list
 * renders. The existing `sl_next` and `sl_<date>` callbacks do NOT use
 * this type; they continue to call `generateShoppingList` directly.
 */
export type ShoppingScope =
  | { kind: 'next_cook'; targetDate: string; remainingDays: number }
  | { kind: 'full_week'; horizonStart: string; horizonEnd: string }
  | { kind: 'recipe'; recipeSlug: string }
  | { kind: 'day'; day: string; remainingDays: number };

// ─── Generator ─────────────────────────────────────────────────────────────

/**
 * Generate a shopping list scoped to a single cook day. Existing signature,
 * unchanged — `sl_next` / `sl_<date>` callbacks continue to call this.
 *
 * @param batches - All planned batches (filtered to target cook date internally)
 * @param breakfastRecipe - The locked breakfast recipe (prorated to remainingDays)
 * @param options - Target cook date and remaining plan days for breakfast proration
 */
export function generateShoppingList(
  batches: Batch[],
  breakfastRecipe: Recipe | undefined,
  options: { targetDate: string; remainingDays: number },
): ShoppingList {
  const { targetDate, remainingDays } = options;
  const aggregated = newAggregationMap();
  const cookBatches = batches.filter((b) => b.eatingDays[0] === targetDate);

  for (const batch of cookBatches) {
    for (const ing of batch.scaledIngredients) {
      addIngredient(aggregated, ing.name, ing.totalForBatch, ing.unit, ing.role);
    }
  }
  if (breakfastRecipe) {
    for (const ing of breakfastRecipe.ingredients) {
      const proratedAmount = ing.amount * remainingDays;
      const note = `(breakfast, ${remainingDays} days)`;
      addIngredient(aggregated, ing.name, proratedAmount, ing.unit, ing.role, note);
    }
  }

  return buildShoppingListFromAggregated(aggregated);
}

// ─── Plan 030 scope functions ──────────────────────────────────────────────

/**
 * Generate a shopping list covering every batch in a horizon.
 *
 * Aggregates ingredients across ALL batches whose first eating day falls
 * inside `[horizonStart, horizonEnd]`. Breakfast is prorated to the full
 * horizon length in days (inclusive).
 *
 * Used by Plan 030's `show_shopping_list({ scope: 'full_week' })` handler.
 */
export function generateShoppingListForWeek(
  batches: Batch[],
  breakfastRecipe: Recipe | undefined,
  options: { horizonStart: string; horizonEnd: string },
): ShoppingList {
  const { horizonStart, horizonEnd } = options;
  const aggregated = newAggregationMap();

  const weekBatches = batches.filter((b) => {
    const cookDay = b.eatingDays[0];
    if (!cookDay) return false;
    return cookDay >= horizonStart && cookDay <= horizonEnd;
  });

  for (const batch of weekBatches) {
    for (const ing of batch.scaledIngredients) {
      addIngredient(aggregated, ing.name, ing.totalForBatch, ing.unit, ing.role);
    }
  }

  if (breakfastRecipe) {
    const days = horizonDayCount(horizonStart, horizonEnd);
    for (const ing of breakfastRecipe.ingredients) {
      const proratedAmount = ing.amount * days;
      const note = `(breakfast, ${days} days)`;
      addIngredient(aggregated, ing.name, proratedAmount, ing.unit, ing.role, note);
    }
  }

  return buildShoppingListFromAggregated(aggregated);
}

/**
 * Generate a shopping list for a single recipe across all active batches.
 *
 * Filters batches by `recipeSlug` and aggregates their ingredients.
 * NO breakfast proration — recipe-scoped shopping is about a single dish.
 *
 * Used by Plan 030's `show_shopping_list({ scope: 'recipe', recipe_slug })` handler.
 */
export function generateShoppingListForRecipe(
  batches: Batch[],
  options: { recipeSlug: string },
): ShoppingList {
  const { recipeSlug } = options;
  const aggregated = newAggregationMap();

  const matching = batches.filter((b) => b.recipeSlug === recipeSlug);
  for (const batch of matching) {
    for (const ing of batch.scaledIngredients) {
      addIngredient(aggregated, ing.name, ing.totalForBatch, ing.unit, ing.role);
    }
  }

  return buildShoppingListFromAggregated(aggregated);
}

/**
 * Generate a shopping list for a single day.
 *
 * "Day" means the COOK day — any batch whose `eatingDays[0]` equals the
 * target day contributes its full ingredient load. Breakfast is prorated
 * to `remainingDays` (same semantics as `generateShoppingList`).
 *
 * Used by Plan 030's `show_shopping_list({ scope: 'day', day })` handler.
 */
export function generateShoppingListForDay(
  batches: Batch[],
  breakfastRecipe: Recipe | undefined,
  options: { day: string; remainingDays: number },
): ShoppingList {
  return generateShoppingList(batches, breakfastRecipe, {
    targetDate: options.day,
    remainingDays: options.remainingDays,
  });
}

// ─── Shared finisher ───────────────────────────────────────────────────────

/**
 * Internal: the classification + tier split + ShoppingList construction step.
 * Shared by `generateShoppingList` and all Plan 030 scope functions.
 */
function buildShoppingListFromAggregated(
  aggregated: AggregationMap,
): ShoppingList {
  const tier2Items: string[] = [];
  const tier3ByCategory = new Map<string, ShoppingItem[]>();

  for (const [, data] of aggregated) {
    const classification = classifyIngredient(data.displayName, data.role);
    if (!classification) continue;

    if (classification.tier === 2) {
      tier2Items.push(data.displayName);
      continue;
    }

    const items = tier3ByCategory.get(classification.category) ?? [];
    items.push({
      name: data.displayName,
      amount: roundAmount(data.amount),
      unit: data.unit,
      ...(data.note && { note: data.note }),
    });
    tier3ByCategory.set(classification.category, items);
  }

  const categories: ShoppingCategory[] = CATEGORY_ORDER
    .filter((cat) => tier3ByCategory.has(cat))
    .map((cat) => ({
      name: cat,
      items: tier3ByCategory.get(cat)!.sort((a, b) => a.name.localeCompare(b.name)),
    }));

  for (const [cat, items] of tier3ByCategory) {
    if (!CATEGORY_ORDER.includes(cat)) {
      categories.push({ name: cat, items: items.sort((a, b) => a.name.localeCompare(b.name)) });
    }
  }

  return {
    categories,
    checkYouHave: tier2Items.sort(),
    customItems: [],
  };
}

interface AggregatedEntry {
  displayName: string;
  amount: number;
  unit: string;
  role: IngredientRole;
  note?: string;
}

type AggregationMap = Map<string, AggregatedEntry>;

function newAggregationMap(): AggregationMap {
  return new Map();
}

function horizonDayCount(start: string, end: string): number {
  const s = new Date(start + 'T00:00:00Z').getTime();
  const e = new Date(end + 'T00:00:00Z').getTime();
  return Math.round((e - s) / 86_400_000) + 1;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Add an ingredient to the aggregation map, merging amounts for duplicate names.
 *
 * Preserves original-case display name from first occurrence.
 * Logs a warning and keeps separate entries for unit mismatches.
 */
function addIngredient(
  map: Map<string, { displayName: string; amount: number; unit: string; role: IngredientRole; note?: string }>,
  name: string,
  amount: number,
  unit: string,
  role: IngredientRole,
  note?: string,
): void {
  const key = name.toLowerCase();
  const existing = map.get(key);
  if (existing) {
    if (existing.unit !== unit) {
      // Unit mismatch — keep separate by appending unit to key
      log.warn('SHOPPING', `unit mismatch for "${name}": ${existing.unit} vs ${unit}, keeping separate`);
      const altKey = `${key}__${unit}`;
      const existingAlt = map.get(altKey);
      if (existingAlt) {
        existingAlt.amount += amount;
      } else {
        map.set(altKey, { displayName: name, amount, unit, role, note });
      }
      return;
    }
    existing.amount += amount;
    // Keep more specific role (non-base, non-seasoning)
    if (role !== 'base' && role !== 'seasoning') {
      existing.role = role;
    }
    // Append note if this is the breakfast contribution
    if (note && !existing.note) {
      existing.note = note;
    }
  } else {
    map.set(key, { displayName: name, amount, unit, role, note });
  }
}

/** Round amounts to user-friendly values. */
function roundAmount(amount: number): number {
  if (amount >= 100) return Math.round(amount / 10) * 10;
  if (amount >= 10) return Math.round(amount);
  return Math.round(amount * 10) / 10;
}
