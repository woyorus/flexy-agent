/**
 * Scenario 029 — standalone recipe flow happy path.
 *
 * The user opens the recipe library from the main menu, adds a new recipe,
 * picks the meal type, types a short description, and saves the result.
 * This exercises the recipe-flow agent end-to-end — distinct from the
 * re-proposer handshake in scenario 028, which only tests recipe generation
 * as a subroutine of plan mutation.
 *
 * ## What the captured transcript locks in
 *
 * - Tapping "📖 My Recipes" with a populated library shows the paginated
 *   list with an [Add new recipe] button.
 * - [Add new recipe] transitions to the meal-type picker.
 * - Choosing "Lunch" prompts for preferences.
 * - Free-text preferences drive `generateRecipe` (and the macro-correction
 *   loop if the first attempt is off) and produce a review card with
 *   Save / Refine / New / Discard buttons.
 * - Tapping Save persists the recipe to the sandboxed RecipeDatabase and
 *   clears the flow state, returning the user to the main menu.
 *
 * ## State isolation
 *
 * `recipeSet: 'minimal'` gives the DB 3 seeded recipes so the "My Recipes"
 * button hits the populated-list branch. The harness copies the fixture
 * directory to an OS temp dir (`copyRecipeSetToTmp`) so saving a newly
 * generated recipe does not pollute the shared fixture set.
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '029-recipe-flow-happy-path',
  description:
    'Standalone recipe generation from main menu — list → add → meal type → ' +
    'preferences → save. Separate from the Plan 025 re-proposer handshake.',
  clock: '2026-04-05T10:00:00Z',
  recipeSet: 'minimal',
  initialState: { session: null },
  events: [
    command('start'),
    text('📖 My Recipes'),              // → paginated list + [Add new recipe]
    click('add_recipe'),                // → meal type keyboard
    click('meal_type_lunch'),           // → awaiting_preferences prompt
    text('something light with chicken and vegetables'),
    // Generator + (possibly) macro-correction loop fires here.
    // Review card appears with Save / Refine / New / Discard.
    click('save_recipe'),               // → persists to sandboxed DB, clears flow
  ],
});
