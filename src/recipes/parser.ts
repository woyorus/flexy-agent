/**
 * Recipe markdown parser.
 *
 * Parses recipe files from the `recipes/` directory. Each file has YAML frontmatter
 * (name, macros, ingredients, storage) and a markdown body (steps, notes).
 *
 * This module is the boundary between the filesystem representation (markdown files)
 * and the in-memory representation (Recipe interface). All other code works with
 * the Recipe interface — only this module knows about the file format.
 *
 * Format reference: docs/SPEC.md Section 5.1 and docs/RECIPE-EXAMPLE.md.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Recipe, RecipeIngredient, IngredientRole } from '../models/types.js';

/**
 * Parse a recipe markdown string into a Recipe object.
 *
 * Expects the format:
 * ```
 * ---
 * (YAML frontmatter)
 * ---
 * ## Steps
 * (markdown)
 * ## Notes
 * (markdown, optional)
 * ```
 *
 * @param content - Raw markdown file content
 * @returns Parsed Recipe object
 * @throws Error if frontmatter is missing or malformed
 */
export function parseRecipe(content: string): Recipe {
  const { frontmatter, body } = splitFrontmatter(content);
  const meta = parseYaml(frontmatter);

  const steps = extractSection(body, 'Steps');
  const notes = extractSection(body, 'Notes');

  return {
    name: meta.name,
    slug: meta.slug,
    mealTypes: meta.meal_types,
    cuisine: meta.cuisine,
    tags: meta.tags ?? [],
    prepTimeMinutes: meta.prep_time_minutes,
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
    steps: steps?.trim() ?? '',
    notes: notes?.trim() || undefined,
  };
}

/**
 * Serialize a Recipe object back to markdown format for writing to disk.
 *
 * @param recipe - The Recipe to serialize
 * @returns Markdown string with YAML frontmatter
 */
export function serializeRecipe(recipe: Recipe): string {
  const frontmatter = {
    name: recipe.name,
    slug: recipe.slug,
    meal_types: recipe.mealTypes,
    cuisine: recipe.cuisine,
    tags: recipe.tags,
    prep_time_minutes: recipe.prepTimeMinutes,
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
    })),
    storage: {
      fridge_days: recipe.storage.fridgeDays,
      freezable: recipe.storage.freezable,
      reheat: recipe.storage.reheat,
    },
  };

  const yamlStr = stringifyYaml(frontmatter);

  let md = `---\n${yamlStr}---\n\n## Steps\n\n${recipe.steps}\n`;
  if (recipe.notes) {
    md += `\n## Notes\n\n${recipe.notes}\n`;
  }
  return md;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

interface RawIngredient {
  name: string;
  amount: number;
  unit: string;
  role: string;
}

function mapIngredient(raw: RawIngredient): RecipeIngredient {
  const validRoles: IngredientRole[] = ['protein', 'carb', 'fat', 'vegetable', 'base', 'seasoning'];
  const role = validRoles.includes(raw.role as IngredientRole)
    ? (raw.role as IngredientRole)
    : 'base';
  return { name: raw.name, amount: raw.amount, unit: raw.unit, role };
}

/**
 * Split a markdown file into YAML frontmatter and body.
 * Frontmatter is delimited by `---` on its own line at the start of the file.
 */
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

/**
 * Extract a markdown section by heading name.
 * Returns the content between `## Name` and the next `##` heading (or end of string).
 */
function extractSection(body: string, heading: string): string | null {
  const regex = new RegExp(`^## ${heading}\\s*$`, 'm');
  const match = regex.exec(body);
  if (!match) return null;

  const start = match.index + match[0].length;
  const nextHeading = body.indexOf('\n## ', start);
  return nextHeading === -1 ? body.slice(start) : body.slice(start, nextHeading);
}

