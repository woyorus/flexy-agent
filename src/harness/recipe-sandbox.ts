/**
 * Recipe set sandbox — copies a fixture recipe directory to a temp location.
 *
 * Scenarios that generate recipes (via `recipes.save()`) write to the
 * RecipeDatabase's directory. Without sandboxing, this pollutes the shared
 * fixture set and breaks other scenarios. This module copies the fixture
 * dir to an OS temp directory so writes are isolated and discarded.
 */

import { mkdtemp, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Copy a recipe fixture directory to a temp location and return the path.
 * The temp directory is cleaned up by the OS (or on next boot).
 */
export async function copyRecipeSetToTmp(fixtureDir: string): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), 'flexie-recipes-'));
  await cp(fixtureDir, tmp, { recursive: true });
  return tmp;
}
