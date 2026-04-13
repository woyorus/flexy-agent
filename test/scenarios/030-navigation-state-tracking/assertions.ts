/**
 * Scenario-local assertions for 030-navigation-state-tracking.
 *
 * Plan 032 Wave E — the canonical Plan 027 navigation walk: every render
 * surface visited; per-step `lastRenderedView` snapshot asserted via
 * captureStepState.
 */

import { assertSessionAtVariants } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Walking every render surface (plan, cooking, recipes, shopping, ' +
  'progress) sets the corresponding lastRenderedView variant at each step; ' +
  'sessionAt[i] reflects the screen rendered after event i. Locks the ' +
  'Plan 027 navigation-state contract end-to-end.';

const EXPECTED_VARIANTS = [
  { surface: 'plan', view: 'next_action' },
  { surface: 'plan', view: 'week_overview' },
  { surface: 'plan', view: 'day_detail', day: '2026-04-09' },
  {
    surface: 'cooking',
    view: 'cook_view',
    batchId: 'batch-030-lunch2-0000-0000-000000000003',
    recipeSlug: 'ground-beef-rigatoni-bolognese',
  },
  { surface: 'recipes', view: 'library' },
  { surface: 'recipes', view: 'recipe_detail', slug: 'chicken-black-bean-avocado-rice-bowl' },
  { surface: 'recipes', view: 'library' },
  { surface: 'shopping', view: 'next_cook' },
  { surface: 'shopping', view: 'day', day: '2026-04-09' },
  { surface: 'progress', view: 'weekly_report' },
  { surface: 'progress', view: 'weekly_report' },
];

export function assertBehavior(ctx: AssertionsContext): void {
  assertSessionAtVariants(ctx, EXPECTED_VARIANTS);
}
