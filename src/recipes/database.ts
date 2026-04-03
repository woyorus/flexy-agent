/**
 * Recipe database — CRUD operations on markdown recipe files.
 *
 * Recipes live as markdown files in the `recipes/` directory at the project root.
 * This module provides an in-memory cache that loads from disk on startup and
 * writes back on mutation. All other modules access recipes through this interface.
 *
 * Not responsible for: recipe generation (that's the recipe-generator sub-agent),
 * recipe scaling (that's the recipe-scaler sub-agent), or recipe validation
 * (that's the QA gate).
 */

import { readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Recipe } from '../models/types.js';
import { parseRecipe, serializeRecipe } from './parser.js';
import { log } from '../debug/logger.js';

/**
 * In-memory recipe database backed by markdown files on disk.
 * Call `load()` once at startup, then use `getAll`, `getBySlug`, `save`, `remove`.
 */
export class RecipeDatabase {
  private recipes: Map<string, Recipe> = new Map();
  private readonly dir: string;

  /**
   * @param recipesDir - Path to the recipes directory (absolute or relative to cwd)
   */
  constructor(recipesDir: string) {
    this.dir = resolve(recipesDir);
  }

  /**
   * Load all recipe markdown files from disk into memory.
   * Call once at startup. Subsequent calls reload from disk (useful after external edits).
   */
  async load(): Promise<void> {
    this.recipes.clear();
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      // Directory doesn't exist yet — empty database
      return;
    }

    const mdFiles = files.filter((f) => f.endsWith('.md'));
    for (const file of mdFiles) {
      const content = await readFile(join(this.dir, file), 'utf-8');
      try {
        const recipe = parseRecipe(content);
        this.recipes.set(recipe.slug, recipe);
      } catch (err) {
        log.warn('DB', `Skipping malformed recipe file ${file}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /** Get all recipes. */
  getAll(): Recipe[] {
    return Array.from(this.recipes.values());
  }

  /** Get a recipe by slug. Returns undefined if not found. */
  getBySlug(slug: string): Recipe | undefined {
    return this.recipes.get(slug);
  }

  /**
   * Get recipes that can serve a specific meal type.
   * @param mealType - 'breakfast', 'lunch', or 'dinner'
   */
  getByMealType(mealType: 'breakfast' | 'lunch' | 'dinner'): Recipe[] {
    return this.getAll().filter((r) => r.mealTypes.includes(mealType));
  }

  /**
   * Save a recipe to disk and update the in-memory cache.
   * Creates a new file or overwrites an existing one.
   *
   * @param recipe - The recipe to save
   */
  async save(recipe: Recipe): Promise<void> {
    const content = serializeRecipe(recipe);
    await writeFile(join(this.dir, `${recipe.slug}.md`), content, 'utf-8');
    this.recipes.set(recipe.slug, recipe);
  }

  /**
   * Remove a recipe from disk and the in-memory cache.
   *
   * @param slug - The recipe slug to remove
   * @returns true if the recipe existed and was removed, false if not found
   */
  async remove(slug: string): Promise<boolean> {
    if (!this.recipes.has(slug)) return false;
    try {
      await unlink(join(this.dir, `${slug}.md`));
    } catch {
      // File already gone — that's fine
    }
    this.recipes.delete(slug);
    return true;
  }

  /** Number of recipes in the database. */
  get size(): number {
    return this.recipes.size;
  }
}
