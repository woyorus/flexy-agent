/**
 * Scenario 028 — recipe generation handshake via re-proposer.
 *
 * The user asks for a recipe not in the DB ("I want a Thai green curry
 * instead of the tagine"). The re-proposer returns a clarification with
 * recipe_needed set. The user confirms ("yes"). The orchestration generates
 * the recipe via generateRecipe(), persists it, then re-runs the re-proposer
 * with the updated DB. The re-proposer places the new recipe and shows the
 * updated plan. The user approves.
 *
 * Tests: pendingRecipeGeneration state, affirmative detection, recipe
 * generation + validation + persist, re-proposer re-run with updated DB.
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '028-reproposer-recipe-generation',
  description:
    'User asks for recipe not in DB — re-proposer asks to generate, user confirms, recipe created and placed.',
  clock: '2026-04-05T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: { session: null },
  events: [
    command('start'),
    text('📋 Plan Week'),
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    // Ask for a recipe that doesn't exist in the six-balanced set.
    text('I want a Thai green curry instead of the tagine'),
    // Re-proposer should return clarification with recipe_needed.
    // User confirms generation.
    text('yes'),
    click('plan_approve'),
  ],
});
