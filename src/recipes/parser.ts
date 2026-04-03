/**
 * Recipe markdown parser.
 *
 * Parses recipe files from the `recipes/` directory. Each file has:
 * - YAML frontmatter: structured data (macros, ingredients with roles/amounts/components, structure, storage)
 * - Markdown body: free-form recipe text (description, steps, notes — no amounts)
 *
 * Amounts live only in YAML. Steps reference ingredients by name, not amount.
 * This supports dynamic scaling — when the solver adjusts a recipe, YAML amounts
 * change but the body text stays the same.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Recipe, RecipeIngredient, RecipeComponent, IngredientRole } from '../models/types.js';

/**
 * Parse a recipe markdown string into a Recipe object.
 *
 * @param content - Raw markdown file content
 * @returns Parsed Recipe object
 * @throws Error if frontmatter is missing or malformed
 */
export function parseRecipe(content: string): Recipe {
  const { frontmatter, body } = splitFrontmatter(content);
  const meta = parseYaml(frontmatter);

  return {
    name: meta.name,
    slug: meta.slug,
    mealTypes: meta.meal_types,
    cuisine: meta.cuisine,
    tags: meta.tags ?? [],
    prepTimeMinutes: meta.prep_time_minutes,
    structure: (meta.structure ?? []).map((s: Record<string, string>) => ({
      type: s.type ?? s.component ?? 'main',
      name: s.name,
    })),
    perServing: {
      calories: meta.per_serving.calories,
      protein: meta.per_serving.protein,
      fat: meta.per_serving.fat,
      carbs: meta.per_serving.carbs,
    },
    ingredients: (meta.ingredients as RawIngredient[]).map(mapIngredient),
    storage: {
      fridgeDays: meta.storage.fridge_days,
      freezable: meta.storage.freezable,
      reheat: meta.storage.reheat,
    },
    body: body.trim(),
  };
}

/**
 * Serialize a Recipe object back to markdown format for writing to disk.
 */
export function serializeRecipe(recipe: Recipe): string {
  const frontmatter = {
    name: recipe.name,
    slug: recipe.slug,
    meal_types: recipe.mealTypes,
    cuisine: recipe.cuisine,
    tags: recipe.tags,
    prep_time_minutes: recipe.prepTimeMinutes,
    structure: recipe.structure.map((s) => ({
      type: s.type,
      name: s.name,
    })),
    per_serving: {
      calories: recipe.perServing.calories,
      protein: recipe.perServing.protein,
      fat: recipe.perServing.fat,
      carbs: recipe.perServing.carbs,
    },
    ingredients: recipe.ingredients.map((ing) => ({
      name: ing.name,
      amount: ing.amount,
      unit: ing.unit,
      role: ing.role,
      component: ing.component,
    })),
    storage: {
      fridge_days: recipe.storage.fridgeDays,
      freezable: recipe.storage.freezable,
      reheat: recipe.storage.reheat,
    },
  };

  const yamlStr = stringifyYaml(frontmatter);
  return `---\n${yamlStr}---\n\n${recipe.body}\n`;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

interface RawIngredient {
  name: string;
  amount: number;
  unit: string;
  role: string;
  component?: string;
}

function mapIngredient(raw: RawIngredient): RecipeIngredient {
  const validRoles: IngredientRole[] = ['protein', 'carb', 'fat', 'vegetable', 'base', 'seasoning'];
  const role = validRoles.includes(raw.role as IngredientRole)
    ? (raw.role as IngredientRole)
    : 'base';
  return {
    name: raw.name,
    amount: raw.amount,
    unit: raw.unit,
    role,
    component: raw.component ?? 'main',
  };
}

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const trimmed = content.trim();
  if (!trimmed.startsWith('---')) {
    throw new Error('Recipe file missing YAML frontmatter (must start with ---)');
  }
  const endIndex = trimmed.indexOf('---', 3);
  if (endIndex === -1) {
    throw new Error('Recipe file has unclosed frontmatter (missing closing ---)');
  }
  return {
    frontmatter: trimmed.slice(3, endIndex).trim(),
    body: trimmed.slice(endIndex + 3).trim(),
  };
}
