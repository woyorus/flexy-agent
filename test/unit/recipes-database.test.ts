/**
 * Unit tests for `RecipeDatabase` (`src/recipes/database.ts`).
 *
 * `RecipeDatabase` is the CRUD layer over the markdown files in `recipes/`.
 * It's the only production path that touches recipe files on disk, so a
 * regression here means lost recipes, missed edits, or a boot that crashes
 * on a single malformed file. These tests exercise the disk-backed path
 * end-to-end against a temp directory — no mocks, real `fs` calls.
 *
 * Coverage:
 *   - Empty state: `load()` on a non-existent directory is not an error
 *     (first-run case).
 *   - Save → load round-trip: a saved recipe is readable by a fresh
 *     `RecipeDatabase` instance pointed at the same directory (verifies
 *     disk persistence, not just the in-memory cache).
 *   - Save overwrite: re-saving the same slug updates in place.
 *   - Remove: deletes the file and returns the right boolean.
 *   - Malformed-file resilience: a single bad file in the directory must
 *     NOT crash `load()` — good recipes should still load. This is the
 *     exact scenario where a silent crash on boot would wipe the user's
 *     Monday-morning library view.
 *   - Query helpers: `getByMealType` filters correctly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecipeDatabase } from '../../src/recipes/database.js';
import type { Recipe } from '../../src/models/types.js';

/**
 * Create a fresh temp directory for a single test and register cleanup.
 * Using `t.after` ties lifetime to the test — no cross-test pollution
 * even if an assertion throws mid-test.
 */
async function makeTempDir(t: { after(fn: () => void | Promise<void>): void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'flexy-recipes-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Build a minimal valid `Recipe` object for tests that need to save one.
 * Overrides let individual tests vary the fields they care about without
 * rebuilding the whole shape.
 */
function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    name: 'Test Chicken Bowl',
    slug: 'test-chicken-bowl',
    mealTypes: ['lunch'],
    cuisine: 'Test',
    tags: ['test', 'meal-prep'],
    prepTimeMinutes: 20,
    structure: [{ type: 'main', name: 'chicken bowl' }],
    perServing: { calories: 600, protein: 50, fat: 20, carbs: 55 },
    ingredients: [
      {
        name: 'chicken breast',
        amount: 180,
        unit: 'g',
        role: 'protein',
        component: 'chicken bowl',
      },
      {
        name: 'basmati rice, dry',
        amount: 50,
        unit: 'g',
        role: 'base',
        component: 'chicken bowl',
      },
    ],
    storage: { fridgeDays: 3, freezable: false, reheat: 'Microwave 2 minutes.' },
    body: 'A short test recipe body.',
    ...overrides,
  };
}

// ─── Empty / non-existent state ──────────────────────────────────────────────

test('RecipeDatabase.load() on a non-existent directory yields an empty db (no throw)', async (t) => {
  // First-run case: the user hasn't created any recipes yet. `load()` must
  // treat "directory missing" as "no recipes", not as an error — otherwise
  // the bot can't start on a clean install.
  const dir = join(await makeTempDir(t), 'does-not-exist');
  const db = new RecipeDatabase(dir);
  await db.load();
  assert.equal(db.size, 0);
  assert.deepStrictEqual(db.getAll(), []);
});

test('RecipeDatabase.load() on an empty directory yields an empty db', async (t) => {
  const dir = await makeTempDir(t);
  const db = new RecipeDatabase(dir);
  await db.load();
  assert.equal(db.size, 0);
});

// ─── Save → load round-trip (the data-loss guardrail) ───────────────────────

test('save() writes a file that a fresh RecipeDatabase can load back identically', async (t) => {
  // This is the core data-loss test: save through one db instance, load
  // through a *second* instance pointed at the same directory. If the
  // serializer emits anything the parser can't read back, or if the file
  // path or encoding drift, this fails. It's stronger than asserting
  // against `this.recipes.get(slug)` because that hits the in-memory
  // cache without ever touching disk on the read side.
  const dir = await makeTempDir(t);
  const recipe = makeRecipe();

  const writer = new RecipeDatabase(dir);
  await writer.load();
  await writer.save(recipe);

  const reader = new RecipeDatabase(dir);
  await reader.load();
  const loaded = reader.getBySlug(recipe.slug);

  assert.ok(loaded, 'saved recipe should be loadable by a fresh db');
  assert.deepStrictEqual(loaded, recipe);
});

test('save() produces a file on disk at <dir>/<slug>.md', async (t) => {
  const dir = await makeTempDir(t);
  const db = new RecipeDatabase(dir);
  await db.load();
  const recipe = makeRecipe({ slug: 'save-path-test' });
  await db.save(recipe);

  const onDisk = await readFile(join(dir, 'save-path-test.md'), 'utf-8');
  assert.ok(onDisk.startsWith('---'), 'saved file must begin with YAML frontmatter delimiter');
  assert.ok(
    onDisk.includes('slug: save-path-test'),
    'saved file must contain the slug in frontmatter',
  );
});

test('save() overwrites an existing recipe with the same slug', async (t) => {
  const dir = await makeTempDir(t);
  const db = new RecipeDatabase(dir);
  await db.load();

  await db.save(makeRecipe({ name: 'First Version' }));
  await db.save(makeRecipe({ name: 'Second Version' }));

  assert.equal(db.size, 1, 'overwrite must not create a duplicate entry');
  assert.equal(db.getBySlug('test-chicken-bowl')?.name, 'Second Version');

  // Persisted-on-disk check — the in-memory cache could be right while the
  // file still holds stale content.
  const fresh = new RecipeDatabase(dir);
  await fresh.load();
  assert.equal(fresh.getBySlug('test-chicken-bowl')?.name, 'Second Version');
});

// ─── Remove ──────────────────────────────────────────────────────────────────

test('remove() deletes the file and evicts the cache entry', async (t) => {
  const dir = await makeTempDir(t);
  const db = new RecipeDatabase(dir);
  await db.load();
  await db.save(makeRecipe());

  const removed = await db.remove('test-chicken-bowl');
  assert.equal(removed, true);
  assert.equal(db.size, 0);
  assert.equal(db.getBySlug('test-chicken-bowl'), undefined);

  // A reload must confirm the file is actually gone from disk, not just
  // the in-memory map.
  const fresh = new RecipeDatabase(dir);
  await fresh.load();
  assert.equal(fresh.size, 0);
});

test('remove() returns false when the slug is unknown', async (t) => {
  const dir = await makeTempDir(t);
  const db = new RecipeDatabase(dir);
  await db.load();
  const removed = await db.remove('nope-not-here');
  assert.equal(removed, false);
});

// ─── Malformed-file resilience ───────────────────────────────────────────────

test('load() skips malformed files and still loads the good ones', async (t) => {
  // The scenario that motivated this test: a single corrupt recipe file
  // in `recipes/` must not take down the whole library. Production code
  // logs a warning via `log.warn` and continues — this test locks that
  // contract in so a future refactor can't replace the warn with a throw.
  const dir = await makeTempDir(t);

  // Write one good recipe via the normal save path...
  const db = new RecipeDatabase(dir);
  await db.load();
  await db.save(makeRecipe({ slug: 'good-recipe', name: 'Good Recipe' }));

  // ...and one garbage file directly to disk, bypassing the serializer.
  await writeFile(
    join(dir, 'broken.md'),
    'this is not a recipe file and has no frontmatter\n',
    'utf-8',
  );

  // A fresh db must load the good recipe and silently skip the bad one.
  const fresh = new RecipeDatabase(dir);
  await fresh.load();
  assert.equal(fresh.size, 1, 'broken file should be skipped, good recipe still loaded');
  assert.ok(fresh.getBySlug('good-recipe'), 'good recipe must survive a malformed sibling');
});

test('load() ignores non-markdown files in the recipes directory', async (t) => {
  // Users might drop a README, a backup, or OS metadata files into the
  // recipes directory. The loader filters by `.md` extension so these
  // don't get parsed as recipes.
  const dir = await makeTempDir(t);
  await writeFile(join(dir, 'README.txt'), 'Not a recipe.\n', 'utf-8');
  await writeFile(join(dir, '.DS_Store'), 'binary-ish\n', 'utf-8');

  const db = new RecipeDatabase(dir);
  await db.save(makeRecipe());
  assert.equal(db.size, 1);

  const fresh = new RecipeDatabase(dir);
  await fresh.load();
  assert.equal(fresh.size, 1, 'non-markdown files must not be parsed');
});

// ─── Query helpers ───────────────────────────────────────────────────────────

test('getByMealType returns only recipes matching the requested meal type', async (t) => {
  const dir = await makeTempDir(t);
  const db = new RecipeDatabase(dir);
  await db.load();

  await db.save(makeRecipe({ slug: 'lunch-only', mealTypes: ['lunch'] }));
  await db.save(makeRecipe({ slug: 'dinner-only', mealTypes: ['dinner'] }));
  await db.save(makeRecipe({ slug: 'both', mealTypes: ['lunch', 'dinner'] }));
  await db.save(makeRecipe({ slug: 'breakfast-only', mealTypes: ['breakfast'] }));

  const lunches = db.getByMealType('lunch').map((r) => r.slug).sort();
  assert.deepStrictEqual(lunches, ['both', 'lunch-only']);

  const breakfasts = db.getByMealType('breakfast').map((r) => r.slug);
  assert.deepStrictEqual(breakfasts, ['breakfast-only']);
});
