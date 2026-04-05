/**
 * Unit tests for the recipe markdown parser (`src/recipes/parser.ts`).
 *
 * Recipes are Flexie's main local datastore — markdown files with YAML
 * frontmatter living in `recipes/`. If the parser silently drops fields or
 * the serializer emits something the parser can't read back, the user's
 * entire recipe library is at risk. These tests are the data-loss safety net.
 *
 * Coverage:
 *   - Round-trip: every shipped fixture recipe survives parse → serialize →
 *     parse with no field drift. This catches format regressions the instant
 *     someone touches the YAML shape on either side.
 *   - Error surfaces: malformed files raise clear errors the caller can
 *     report. `RecipeDatabase.load()` relies on these being real `Error`
 *     instances so it can skip bad files instead of crashing the boot.
 *   - Defaults: optional YAML fields (`tags`, ingredient `component`) and
 *     soft-validated fields (ingredient `role`) degrade to sensible values
 *     rather than throwing or producing `undefined`.
 *   - Legacy structure alias: `structure[].component` is accepted as a
 *     historical synonym for `structure[].type`. Removing this alias would
 *     silently break older recipe files, so it's locked in by test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseRecipe, serializeRecipe } from '../../src/recipes/parser.js';
import type { Recipe } from '../../src/models/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'recipes', 'six-balanced');

// ─── Round-trip (real fixtures) ──────────────────────────────────────────────

test('parseRecipe + serializeRecipe round-trip every shipped fixture recipe', async () => {
  // The seven six-balanced fixtures span breakfast + lunch/dinner, single
  // and multi-component structures, every ingredient role, and every
  // storage flag shape. If any field drifts through parse → serialize →
  // parse, at least one of these will fail — which is the point. Looping
  // over real fixtures is stronger than hand-crafting a synthetic recipe
  // because the fixtures evolve alongside the production format.
  const files = (await readdir(FIXTURE_DIR)).filter((f) => f.endsWith('.md'));
  assert.ok(files.length >= 5, 'expected at least 5 fixture recipes to round-trip');

  for (const file of files) {
    const original = await readFile(join(FIXTURE_DIR, file), 'utf-8');
    const parsed = parseRecipe(original);
    const reserialized = serializeRecipe(parsed);
    const reparsed = parseRecipe(reserialized);
    assert.deepStrictEqual(
      reparsed,
      parsed,
      `round-trip drift in ${file}: parse → serialize → parse must be idempotent`,
    );
  }
});

test('parseRecipe preserves all top-level fields from a real fixture', async () => {
  // Spot-check one fixture end-to-end so a round-trip test that accidentally
  // compares `undefined === undefined` can't silently pass. This asserts
  // concrete values against the file on disk.
  const content = await readFile(
    join(FIXTURE_DIR, 'chicken-black-bean-avocado-rice-bowl.md'),
    'utf-8',
  );
  const recipe = parseRecipe(content);

  assert.equal(recipe.slug, 'chicken-black-bean-avocado-rice-bowl');
  assert.equal(recipe.cuisine, 'Mexican-inspired');
  assert.deepStrictEqual(recipe.mealTypes, ['lunch']);
  assert.equal(recipe.prepTimeMinutes, 40);
  assert.equal(recipe.perServing.calories, 893);
  assert.equal(recipe.perServing.protein, 56);
  assert.ok(recipe.tags.includes('meal-prep'));
  assert.ok(recipe.structure.length >= 1);
  assert.ok(recipe.ingredients.length > 0);
  assert.equal(recipe.storage.fridgeDays, 3);
  assert.equal(recipe.storage.freezable, false);
  assert.ok(recipe.body.length > 0, 'body should contain recipe prose');
  assert.ok(
    !recipe.body.startsWith('---'),
    'body should not include the closing frontmatter delimiter',
  );
});

// ─── Error surfaces (guard RecipeDatabase.load) ──────────────────────────────

test('parseRecipe throws a clear error when frontmatter is missing entirely', () => {
  assert.throws(
    () => parseRecipe('# Just a markdown file\n\nNo frontmatter here.\n'),
    /missing YAML frontmatter/i,
    'a file without leading --- must throw a descriptive error, not silently parse',
  );
});

test('parseRecipe throws a clear error when frontmatter is unclosed', () => {
  assert.throws(
    () => parseRecipe('---\nname: Orphan\nslug: orphan\n\nNo closing delimiter'),
    /unclosed frontmatter/i,
    'a file with a starting --- but no closing --- must throw',
  );
});

test('parseRecipe throws when frontmatter YAML is malformed', () => {
  const badYaml = [
    '---',
    'name: Bad YAML',
    'slug: bad',
    '  this line has no key and bad indentation: [unclosed',
    '---',
    '',
    'Body text.',
    '',
  ].join('\n');
  assert.throws(() => parseRecipe(badYaml), 'malformed YAML should surface as an error');
});

// ─── Defaults and soft validation ────────────────────────────────────────────

test('parseRecipe defaults missing `tags` to an empty array', () => {
  // `tags` is optional in the format (older recipes may not have it). The
  // parser must default to [] rather than leaving the field undefined,
  // because downstream code calls `.includes()` on it.
  const recipe = parseRecipe(minimalRecipeYaml({ omitTags: true }));
  assert.deepStrictEqual(recipe.tags, []);
});

test('parseRecipe defaults missing ingredient `component` to "main"', () => {
  // `component` is required in current recipes but was added after v0.0.2,
  // so historical files may omit it. The default ensures scaling logic
  // (which groups ingredients by component) still works on legacy data.
  const recipe = parseRecipe(minimalRecipeYaml({ omitIngredientComponent: true }));
  assert.equal(recipe.ingredients[0]?.component, 'main');
});

test('parseRecipe coerces an invalid ingredient `role` to "base"', () => {
  // Scaling uses `role` to decide which ingredients to adjust. An unknown
  // role must not crash the parser — but the fallback should be the
  // safest choice (`base` = keep stable), never `protein` or `carb` which
  // would cause the scaler to adjust something it shouldn't.
  const recipe = parseRecipe(minimalRecipeYaml({ ingredientRole: 'not-a-real-role' }));
  assert.equal(recipe.ingredients[0]?.role, 'base');
});

test('parseRecipe accepts legacy `component` alias in structure entries', () => {
  // Older recipes wrote structure entries as `{component: "main", name: "..."}`
  // before the field was renamed to `type`. The parser still accepts the
  // legacy key — this test locks that in so nobody removes the alias and
  // silently breaks the old recipe library.
  const withLegacyStructure = minimalRecipeYaml({
    structureOverride: [
      { legacyKey: 'component', typeValue: 'main', name: 'main dish' },
    ],
  });
  const recipe = parseRecipe(withLegacyStructure);
  assert.equal(recipe.structure[0]?.type, 'main');
  assert.equal(recipe.structure[0]?.name, 'main dish');
});

// ─── Test helpers ────────────────────────────────────────────────────────────

interface MinimalOverrides {
  omitTags?: boolean;
  omitIngredientComponent?: boolean;
  ingredientRole?: string;
  structureOverride?: Array<{ legacyKey: 'type' | 'component'; typeValue: string; name: string }>;
}

/**
 * Build a minimal but valid recipe YAML string with surgical overrides.
 * Used by default-and-coercion tests so each one is self-documenting and
 * doesn't depend on fixture files.
 */
function minimalRecipeYaml(overrides: MinimalOverrides = {}): string {
  const lines: string[] = ['---'];
  lines.push('name: Minimal Recipe');
  lines.push('slug: minimal-recipe');
  lines.push('meal_types:');
  lines.push('  - lunch');
  lines.push('cuisine: Test');
  if (!overrides.omitTags) {
    lines.push('tags:');
    lines.push('  - test');
  }
  lines.push('prep_time_minutes: 15');
  lines.push('structure:');
  const structure = overrides.structureOverride ?? [
    { legacyKey: 'type', typeValue: 'main', name: 'main dish' },
  ];
  for (const s of structure) {
    lines.push(`  - ${s.legacyKey}: ${s.typeValue}`);
    lines.push(`    name: ${s.name}`);
  }
  lines.push('per_serving:');
  lines.push('  calories: 500');
  lines.push('  protein: 40');
  lines.push('  fat: 15');
  lines.push('  carbs: 50');
  lines.push('ingredients:');
  lines.push('  - name: chicken breast');
  lines.push('    amount: 150');
  lines.push('    unit: g');
  lines.push(`    role: ${overrides.ingredientRole ?? 'protein'}`);
  if (!overrides.omitIngredientComponent) {
    lines.push('    component: main dish');
  }
  lines.push('storage:');
  lines.push('  fridge_days: 3');
  lines.push('  freezable: false');
  lines.push('  reheat: Microwave 2 minutes.');
  lines.push('---');
  lines.push('');
  lines.push('A short test body.');
  lines.push('');
  return lines.join('\n');
}
